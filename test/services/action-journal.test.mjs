import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InstitutionalActionJournal } from "../../services/institutional-action-journal.mjs";

const REQUEST_ID = "request-2026-0001";
const TX_HASH = `0x${"ab".repeat(32)}`;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "institutional-actions-"));
  const path = join(directory, "journal.json");
  let now = 1_800_000_000_000;
  const clock = () => now;
  const journal = await InstitutionalActionJournal.open(path, { clock });
  return { directory, path, journal, clock, advance: () => { now += 1_000; } };
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

test("action journal deduplicates concurrent preparations", async (t) => {
  const context = await fixture();
  t.after(() => rm(context.directory, { recursive: true, force: true }));

  const [first, second] = await Promise.all([
    context.journal.prepare(operation()),
    context.journal.prepare(operation()),
  ]);
  assert.equal([first.created, second.created].filter(Boolean).length, 1);
  assert.equal(Object.keys(context.journal.snapshot().operations).length, 1);
});

test("action journal persists transaction and terminal result across restart", async (t) => {
  const context = await fixture();
  t.after(() => rm(context.directory, { recursive: true, force: true }));
  await context.journal.prepare(operation());
  context.advance();
  await context.journal.submitted(REQUEST_ID, TX_HASH);
  context.advance();
  await context.journal.complete(REQUEST_ID, { sourceTransaction: TX_HASH, sourceBlock: 12 });

  const reopened = await InstitutionalActionJournal.open(context.path, { clock: context.clock });
  assert.equal(reopened.get(REQUEST_ID).status, "completed");
  assert.equal(reopened.get(REQUEST_ID).result.sourceTransaction, TX_HASH);
  assert.deepEqual(reopened.get(REQUEST_ID).history.map((entry) => entry.status), [
    "prepared",
    "submitted",
    "completed",
  ]);
});

test("action journal rejects reuse of a key for different intent", async (t) => {
  const context = await fixture();
  t.after(() => rm(context.directory, { recursive: true, force: true }));
  await context.journal.prepare(operation());
  await assert.rejects(context.journal.prepare(operation({ amount: "2000.0" })), /different action/);
});

test("uncertain broadcast retains its hash and can complete after receipt reconciliation", async (t) => {
  const context = await fixture();
  t.after(() => rm(context.directory, { recursive: true, force: true }));
  await context.journal.prepare(operation());
  await context.journal.fail(REQUEST_ID, new Error("RPC response timed out"), {
    uncertain: true,
    sourceTransaction: TX_HASH,
  });

  const reopened = await InstitutionalActionJournal.open(context.path, { clock: context.clock });
  assert.equal(reopened.get(REQUEST_ID).status, "uncertain");
  assert.equal(reopened.get(REQUEST_ID).sourceTransaction, TX_HASH);
  await reopened.submitted(REQUEST_ID, TX_HASH, { stage: "reconciling-transaction" });
  await reopened.complete(REQUEST_ID, { sourceTransaction: TX_HASH, reconciled: true });

  assert.equal(reopened.get(REQUEST_ID).status, "completed");
  assert.equal(reopened.get(REQUEST_ID).result.reconciled, true);
  assert.deepEqual(reopened.get(REQUEST_ID).history.map((entry) => entry.status), [
    "prepared",
    "uncertain",
    "submitted",
    "completed",
  ]);
});
