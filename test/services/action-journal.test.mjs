import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ethers } from "ethers";
import {
  ACTION_JOURNAL_VERSION,
  InstitutionalActionJournal,
  UnresolvedActionConflictError,
} from "../../services/institutional-action-journal.mjs";

const REQUEST_ID = "request-2026-0001";
const TX_HASH = `0x${"ab".repeat(32)}`;
const WRITABLE_TEMP_ROOT = process.platform === "win32" ? tmpdir() : "/tmp";

async function fixture() {
  const directory = await mkdtemp(join(WRITABLE_TEMP_ROOT, "institutional-actions-"));
  const path = join(directory, "journal.json");
  let now = 1_800_000_000_000;
  const clock = () => now;
  const context = {
    directory,
    path,
    clock,
    journal: await InstitutionalActionJournal.open(path, { clock }),
    advance: () => { now += 1_000; },
    async reopen() {
      await this.journal.close();
      this.journal = await InstitutionalActionJournal.open(path, { clock });
      return this.journal;
    },
    async cleanup() {
      await this.journal?.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    },
  };
  return context;
}

function operation(overrides = {}) {
  return {
    requestId: REQUEST_ID,
    action: "bridge",
    label: "Transfer collateral to Bank B",
    lane: "A-to-B",
    amount: "1000.0",
    ...overrides,
  };
}

async function signedRawTransaction({
  wallet,
  nonce = 7,
  data = "0x12345678",
  chainId = 31337n,
  value = 0n,
} = {}) {
  const signer = wallet || ethers.Wallet.createRandom();
  return signer.signTransaction({
    type: 0,
    chainId,
    nonce,
    gasLimit: 100_000n,
    gasPrice: 0n,
    to: "0x00000000000000000000000000000000000000A1",
    data,
    value,
  });
}

test("action journal deduplicates concurrent preparations", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());

  const [first, second] = await Promise.all([
    context.journal.prepare(operation()),
    context.journal.prepare(operation()),
  ]);
  assert.equal([first.created, second.created].filter(Boolean).length, 1);
  assert.equal(Object.keys(context.journal.snapshot().operations).length, 1);
});

test("action journal persists transaction and terminal result across restart", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.journal.prepare(operation());
  const rawTransaction = await signedRawTransaction();
  const transactionHash = ethers.Transaction.from(rawTransaction).hash;
  await context.journal.stageSignedTransaction(REQUEST_ID, { rawTransaction });
  context.advance();
  await context.journal.submitted(REQUEST_ID, transactionHash);
  context.advance();
  await assert.rejects(
    context.journal.complete(REQUEST_ID, { sourceTransaction: TX_HASH, sourceBlock: 12 }),
    /Completed action result hash does not match its transaction outbox/,
  );
  await context.journal.complete(REQUEST_ID, { sourceTransaction: transactionHash, sourceBlock: 12 });

  const reopened = await context.reopen();
  assert.equal(reopened.get(REQUEST_ID).status, "completed");
  assert.equal(reopened.get(REQUEST_ID).result.sourceTransaction, transactionHash);
  assert.deepEqual(reopened.get(REQUEST_ID).history.map((entry) => entry.status), [
    "prepared",
    "signed",
    "submitted",
    "completed",
  ]);
});

test("action journal rejects reuse of a key for a different financial intent", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.journal.prepare(operation());
  const relabeled = await context.journal.prepare(operation({ label: "Legacy presentation label" }));
  assert.equal(relabeled.created, false);
  assert.equal(relabeled.operation.label, operation().label);
  await assert.rejects(context.journal.prepare(operation({ amount: "2000.0" })), /different action intent/);
  await assert.rejects(context.journal.prepare(operation({ lane: "B-to-A" })), /different action intent/);
  await assert.rejects(
    context.journal.prepare(operation({ requestId: "__proto__" })),
    /reserved idempotency key/,
  );
  assert.equal(context.journal.get("__proto__"), null);
});

test("object-prototype names remain valid idempotency keys without inherited-property confusion", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  const requestId = "hasOwnProperty";

  const prepared = await context.journal.prepare(operation({ requestId }));
  assert.equal(prepared.created, true);
  assert.equal(context.journal.get(requestId).requestId, requestId);
});

test("uncertain broadcast retains its hash and can complete after receipt reconciliation", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.journal.prepare(operation());
  const rawTransaction = await signedRawTransaction();
  const transactionHash = ethers.Transaction.from(rawTransaction).hash;
  await context.journal.stageSignedTransaction(REQUEST_ID, { rawTransaction });
  await context.journal.fail(REQUEST_ID, new Error("RPC response timed out"), {
    uncertain: true,
    sourceTransaction: transactionHash,
  });

  const reopened = await context.reopen();
  assert.equal(reopened.get(REQUEST_ID).status, "uncertain");
  assert.equal(reopened.get(REQUEST_ID).sourceTransaction, transactionHash);
  await reopened.submitted(REQUEST_ID, transactionHash, { stage: "reconciling-transaction" });
  await reopened.complete(REQUEST_ID, { sourceTransaction: transactionHash, reconciled: true });

  assert.equal(reopened.get(REQUEST_ID).status, "completed");
  assert.equal(reopened.get(REQUEST_ID).result.reconciled, true);
  assert.deepEqual(reopened.get(REQUEST_ID).history.map((entry) => entry.status), [
    "prepared",
    "signed",
    "uncertain",
    "submitted",
    "completed",
  ]);
});

test("fresh v3 operations cannot bypass the durable transaction outbox", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.journal.prepare(operation());

  await assert.rejects(
    context.journal.submitted(REQUEST_ID, TX_HASH),
    /must stage a durable transaction before submission/,
  );
  await assert.rejects(
    context.journal.complete(REQUEST_ID, { sourceTransaction: TX_HASH }),
    /cannot complete from status prepared/,
  );
  await assert.rejects(
    context.journal.fail(REQUEST_ID, new Error("ambiguous transport failure"), {
      uncertain: true,
      sourceTransaction: TX_HASH,
    }),
    /cannot become uncertain before a transaction is persisted/,
  );

  await context.journal.fail(REQUEST_ID, new Error("definite pre-broadcast validation failure"));
  assert.equal(context.journal.get(REQUEST_ID).status, "failed");
  assert.equal(context.journal.get(REQUEST_ID).transactionPersistence, "pending");
});

test("signed outbox durably binds request identity, nonce, raw transaction and hash before broadcast", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  const rawTransaction = await signedRawTransaction();
  const decoded = ethers.Transaction.from(rawTransaction);
  await context.journal.prepare(operation());
  const staged = await context.journal.stageSignedTransaction(REQUEST_ID, { rawTransaction }, {
    stage: "source-confirmation",
  });

  assert.equal(staged.created, true);
  assert.equal(staged.outbox.status, "signed");
  assert.equal(staged.outbox.requestId, REQUEST_ID);
  assert.equal(staged.outbox.action, "bridge");
  assert.equal(staged.outbox.amount, "1000.0");
  assert.equal(staged.outbox.nonce, "7");
  assert.equal(staged.outbox.rawTransaction, rawTransaction);
  assert.equal(staged.outbox.transactionHash, decoded.hash);
  assert.equal(staged.operation.sourceTransaction, decoded.hash);

  const reopened = await context.reopen();
  const recovered = reopened.get(REQUEST_ID);
  assert.equal(recovered.status, "signed");
  assert.equal(recovered.outbox.rawTransaction, rawTransaction);
  assert.equal(ethers.Transaction.from(recovered.outbox.rawTransaction).hash, recovered.outbox.transactionHash);
});

test("outbox staging is idempotent and a signed-unbroadcast request fences every new financial action", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  const wallet = ethers.Wallet.createRandom();
  const rawTransaction = await signedRawTransaction({ wallet });
  await context.journal.prepare(operation());
  await context.journal.stageSignedTransaction(REQUEST_ID, { rawTransaction });
  const replay = await context.journal.stageSignedTransaction(REQUEST_ID, { rawTransaction });
  assert.equal(replay.created, false);

  const otherRequestId = "request-2026-0002";
  await assert.rejects(
    context.journal.prepare(operation({
      requestId: otherRequestId,
      action: "deposit",
      label: "Deposit collateral",
      lane: "Bank B",
    })),
    (error) => {
      assert.ok(error instanceof UnresolvedActionConflictError);
      assert.equal(error.code, "INSTITUTIONAL_ACTION_IN_PROGRESS");
      assert.equal(error.blockingOperation.requestId, REQUEST_ID);
      assert.equal(error.blockingOperation.status, "signed");
      return true;
    },
  );
  assert.equal(context.journal.get(otherRequestId), null);
});

test("broadcast attempt and exact raw transaction survive a crash-window restart", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  const rawTransaction = await signedRawTransaction();
  await context.journal.prepare(operation());
  await context.journal.stageSignedTransaction(REQUEST_ID, { rawTransaction });
  await context.journal.broadcasting(REQUEST_ID, { stage: "broadcasting-source-transaction" });

  const reopened = await context.reopen();
  const recovered = reopened.get(REQUEST_ID);
  assert.equal(recovered.status, "broadcasting");
  assert.equal(recovered.outbox.broadcastAttempts, 1);
  assert.equal(recovered.outbox.rawTransaction, rawTransaction);
  await reopened.submitted(REQUEST_ID, recovered.outbox.transactionHash);
  assert.equal(reopened.get(REQUEST_ID).outbox.status, "submitted");
});

test("journal rejects raw transaction metadata tampering on restart", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.journal.prepare(operation());
  await context.journal.stageSignedTransaction(REQUEST_ID, {
    rawTransaction: await signedRawTransaction(),
  });
  await context.journal.close();
  context.journal = null;

  const state = JSON.parse(await readFile(context.path, "utf8"));
  state.operations[REQUEST_ID].outbox.nonce = "999";
  await writeFile(context.path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await assert.rejects(
    InstitutionalActionJournal.open(context.path, { clock: context.clock }),
    /nonce does not match raw transaction/,
  );
});

test("journal rejects hidden operations and incoherent operation/outbox state on restart", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.journal.prepare(operation());
  await context.journal.stageSignedTransaction(REQUEST_ID, {
    rawTransaction: await signedRawTransaction(),
  });
  await context.journal.close();
  context.journal = null;

  const original = JSON.parse(await readFile(context.path, "utf8"));
  const hiddenRequestId = "request-2026-hidden";
  original.operations[hiddenRequestId] = {
    ...structuredClone(original.operations[REQUEST_ID]),
    requestId: hiddenRequestId,
    outbox: {
      ...structuredClone(original.operations[REQUEST_ID].outbox),
      requestId: hiddenRequestId,
    },
  };
  await writeFile(context.path, `${JSON.stringify(original, null, 2)}\n`, "utf8");
  await assert.rejects(
    InstitutionalActionJournal.open(context.path, { clock: context.clock }),
    /keys do not exactly match/,
  );

  delete original.operations[hiddenRequestId];
  original.operations[REQUEST_ID].status = "submitted";
  original.operations[REQUEST_ID].history.push({
    status: "submitted",
    at: "2027-01-15T08:00:00.000Z",
  });
  await writeFile(context.path, `${JSON.stringify(original, null, 2)}\n`, "utf8");
  await assert.rejects(
    InstitutionalActionJournal.open(context.path, { clock: context.clock }),
    /outbox status mismatch/i,
  );
});

test("journal rejects signed transactions outside the non-payable action domain", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.journal.prepare(operation());

  await assert.rejects(
    context.journal.stageSignedTransaction(REQUEST_ID, {
      rawTransaction: await signedRawTransaction({ chainId: 0n }),
    }),
    /chainId must be positive/,
  );
  await assert.rejects(
    context.journal.stageSignedTransaction(REQUEST_ID, {
      rawTransaction: await signedRawTransaction({ value: 1n }),
    }),
    /must not transfer native value/,
  );
});

test("completed idempotency keys are retained instead of becoming reusable after journal growth", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  const rawTransaction = await signedRawTransaction();
  const transactionHash = ethers.Transaction.from(rawTransaction).hash;
  for (let index = 0; index <= 200; index += 1) {
    const requestId = `request-retained-${String(index).padStart(4, "0")}`;
    await context.journal.prepare(operation({ requestId }));
    if (index === 0) {
      await context.journal.stageSignedTransaction(requestId, { rawTransaction });
      await context.journal.submitted(requestId, transactionHash);
      await context.journal.complete(requestId, { index, sourceTransaction: transactionHash });
    } else {
      await context.journal.fail(requestId, new Error("definite pre-broadcast test failure"));
    }
  }

  assert.equal(context.journal.get("request-retained-0000").status, "completed");
  await assert.rejects(
    context.journal.prepare(operation({ requestId: "request-retained-0000", amount: "2000.0" })),
    /different action intent/,
  );
});

test("legacy v1 journal migrates in place to v3 without losing operations", async (t) => {
  const directory = await mkdtemp(join(WRITABLE_TEMP_ROOT, "institutional-actions-v1-"));
  const path = join(directory, "journal.json");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacyOperation = {
    ...operation(),
    status: "prepared",
    sourceTransaction: null,
    result: null,
    error: null,
    createdAt: "2027-01-15T08:00:00.000Z",
    updatedAt: "2027-01-15T08:00:00.000Z",
    history: [{ status: "prepared", at: "2027-01-15T08:00:00.000Z" }],
  };
  await writeFile(path, `${JSON.stringify({
    version: "institutional-action-journal-v1",
    createdAt: legacyOperation.createdAt,
    updatedAt: legacyOperation.updatedAt,
    operations: { [REQUEST_ID]: legacyOperation },
    order: [REQUEST_ID],
  }, null, 2)}\n`, "utf8");

  const journal = await InstitutionalActionJournal.open(path);
  assert.equal(journal.snapshot().version, ACTION_JOURNAL_VERSION);
  assert.equal(journal.get(REQUEST_ID).status, "prepared");
  assert.equal(journal.get(REQUEST_ID).outbox, null);
  assert.equal(journal.get(REQUEST_ID).transactionPersistence, "legacy-hash-only");
  await journal.close();
});

test("pre-invariant v2 journal migrates in place with explicit transaction provenance", async (t) => {
  const directory = await mkdtemp(join(WRITABLE_TEMP_ROOT, "institutional-actions-v2-"));
  const path = join(directory, "journal.json");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const timestamp = "2027-01-15T08:00:00.000Z";
  const v2Operation = {
    ...operation(),
    status: "prepared",
    sourceTransaction: null,
    outbox: null,
    result: null,
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    history: [{ status: "prepared", at: timestamp }],
  };
  await writeFile(path, `${JSON.stringify({
    version: "institutional-action-journal-v2",
    createdAt: timestamp,
    updatedAt: timestamp,
    operations: { [REQUEST_ID]: v2Operation },
    order: [REQUEST_ID],
  }, null, 2)}\n`, "utf8");

  const journal = await InstitutionalActionJournal.open(path);
  assert.equal(journal.snapshot().version, ACTION_JOURNAL_VERSION);
  assert.equal(journal.get(REQUEST_ID).transactionPersistence, "pending");
  await journal.close();
});

test("legacy v1 submitted action normalizes an error left by uncertain reconciliation", async (t) => {
  const directory = await mkdtemp(join(WRITABLE_TEMP_ROOT, "institutional-actions-v1-stale-error-"));
  const path = join(directory, "journal.json");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const timestamp = "2027-01-15T08:00:00.000Z";
  const legacyOperation = {
    ...operation(),
    status: "submitted",
    sourceTransaction: TX_HASH,
    result: null,
    error: "RPC response timed out before receipt reconciliation",
    createdAt: timestamp,
    updatedAt: timestamp,
    history: [
      { status: "prepared", at: timestamp },
      { status: "uncertain", at: timestamp },
      { status: "submitted", at: timestamp },
    ],
  };
  await writeFile(path, `${JSON.stringify({
    version: "institutional-action-journal-v1",
    createdAt: timestamp,
    updatedAt: timestamp,
    operations: { [REQUEST_ID]: legacyOperation },
    order: [REQUEST_ID],
  }, null, 2)}\n`, "utf8");

  const journal = await InstitutionalActionJournal.open(path);
  const migrated = journal.get(REQUEST_ID);
  assert.equal(migrated.status, "submitted");
  assert.equal(migrated.sourceTransaction, TX_HASH);
  assert.equal(migrated.error, null);
  assert.equal(migrated.result, null);
  assert.equal(migrated.outbox, null);
  assert.equal(migrated.transactionPersistence, "legacy-hash-only");
  await journal.complete(REQUEST_ID, { sourceTransaction: TX_HASH, reconciled: true });
  assert.equal(journal.get(REQUEST_ID).status, "completed");
  await journal.close();
});
