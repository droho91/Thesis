import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ethers } from "ethers";
import { InstitutionalActionJournal } from "../../services/institutional-action-journal.mjs";
import {
  ActiveExecutionTracker,
  executeDurableTransaction,
  recoverUnresolvedActionJournal,
  transactionOutcomeIsUncertain,
} from "../../services/institutional-demo-runtime.mjs";
import {
  ActiveExecutionTracker as DirectActiveExecutionTracker,
  executeDurableTransaction as directExecuteDurableTransaction,
  recoverUnresolvedActionJournal as directRecoverUnresolvedActionJournal,
  transactionOutcomeIsUncertain as directTransactionOutcomeIsUncertain,
} from "../../services/institutional-durable-action-runtime.mjs";

const REQUEST_ID = "request-runtime-0001";
const DESTINATION = "0x00000000000000000000000000000000000000B1";
const WRITABLE_TEMP_ROOT = process.platform === "win32" ? tmpdir() : "/tmp";

class FakeProvider {
  constructor({ nonce = 7, receiptStatus = 1 } = {}) {
    this.nonce = nonce;
    this.receiptStatus = receiptStatus;
    this.mineOnBroadcast = true;
    this.broadcasts = [];
    this.pending = new Map();
    this.receipts = new Map();
    this.waitCalls = [];
    this.responseWaitCalls = 0;
  }

  async getNetwork() {
    return { chainId: 31_337n };
  }

  async getTransactionCount(_address, _blockTag) {
    return this.nonce;
  }

  async send(method) {
    assert.equal(method, "eth_getTransactionCount");
    return ethers.toQuantity(this.nonce);
  }

  async getTransactionReceipt(hash) {
    return this.receipts.get(hash) || null;
  }

  async getTransaction(hash) {
    return this.pending.get(hash) || null;
  }

  async broadcastTransaction(rawTransaction) {
    const decoded = ethers.Transaction.from(rawTransaction);
    this.broadcasts.push(rawTransaction);
    const response = {
      hash: decoded.hash,
      wait: async () => {
        this.responseWaitCalls += 1;
        throw new Error("TransactionResponse.wait() must not be used by the bounded outbox waiter");
      },
    };
    this.pending.set(decoded.hash, response);
    if (this.mineOnBroadcast) this.mine(decoded.hash, this.receiptStatus);
    return response;
  }

  async waitForTransaction(hash, confirmations, timeoutMs) {
    this.waitCalls.push({ hash, confirmations, timeoutMs });
    return this.receipts.get(hash) || null;
  }

  mine(hash, status = 1) {
    const receipt = { hash, status, blockNumber: 42, logs: [] };
    this.receipts.set(hash, receipt);
    this.pending.delete(hash);
    return receipt;
  }
}

class FakeSigner {
  constructor(wallet, provider) {
    this.wallet = wallet;
    this.provider = provider;
    this.signingEnabled = true;
    this.populateCalls = 0;
    this.signCalls = 0;
  }

  getAddress() {
    return Promise.resolve(this.wallet.address);
  }

  async populateTransaction(request) {
    this.populateCalls += 1;
    if (!this.signingEnabled) throw new Error("Restart reconciliation must not populate a replacement transaction");
    assert.equal(ethers.getAddress(request.from), this.wallet.address);
    const { from: _from, ...transaction } = request;
    return transaction;
  }

  async signTransaction(transaction) {
    this.signCalls += 1;
    if (!this.signingEnabled) throw new Error("Restart reconciliation must not sign a replacement transaction");
    return this.wallet.signTransaction(transaction);
  }
}

async function fixture() {
  const directory = await mkdtemp(join(WRITABLE_TEMP_ROOT, "institutional-outbox-runtime-"));
  const path = join(directory, "action-journal.json");
  const context = {
    directory,
    path,
    journal: await InstitutionalActionJournal.open(path),
    async reopen() {
      await this.journal.close();
      this.journal = await InstitutionalActionJournal.open(path);
      return this.journal;
    },
    async cleanup() {
      await this.journal?.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    },
  };
  await context.journal.prepare({
    requestId: REQUEST_ID,
    action: "deposit",
    label: "Activate voucher collateral",
    lane: "Bank B",
    amount: "25.0",
  });
  return context;
}

function transactionRequest() {
  return {
    to: DESTINATION,
    data: "0x12345678",
    gasLimit: 100_000n,
  };
}

function execute(context, signer, overrides = {}) {
  return executeDurableTransaction({
    actionJournal: context.journal,
    requestId: REQUEST_ID,
    signer,
    transactionRequest: transactionRequest(),
    label: "deposit transaction",
    timeoutMs: 100,
    ...overrides,
  });
}

test("demo runtime facade preserves the durable action module exports", () => {
  assert.equal(ActiveExecutionTracker, DirectActiveExecutionTracker);
  assert.equal(executeDurableTransaction, directExecuteDurableTransaction);
  assert.equal(recoverUnresolvedActionJournal, directRecoverUnresolvedActionJournal);
  assert.equal(transactionOutcomeIsUncertain, directTransactionOutcomeIsUncertain);
});

test("restart rebroadcasts the exact staged raw transaction after a crash before broadcast", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  const provider = new FakeProvider({ nonce: 7 });
  const signer = new FakeSigner(ethers.Wallet.createRandom(), provider);

  await assert.rejects(
    execute(context, signer, {
      faults: { afterPersist: () => { throw new Error("simulated crash after durable stage"); } },
    }),
    /simulated crash after durable stage/,
  );
  const staged = context.journal.get(REQUEST_ID);
  assert.equal(staged.status, "signed");
  assert.equal(staged.outbox.nonce, "7");
  assert.equal(provider.broadcasts.length, 0);
  const expectedRaw = staged.outbox.rawTransaction;
  const expectedHash = staged.outbox.transactionHash;

  await context.reopen();
  signer.signingEnabled = false;
  const receipt = await execute(context, signer, { transactionRequest: null });

  assert.equal(receipt.hash, expectedHash);
  assert.deepEqual(provider.broadcasts, [expectedRaw]);
  assert.equal(signer.populateCalls, 1);
  assert.equal(signer.signCalls, 1);
  assert.equal(provider.responseWaitCalls, 0);
  assert.deepEqual(provider.waitCalls, [{ hash: expectedHash, confirmations: 1, timeoutMs: 100 }]);
  assert.equal(context.journal.get(REQUEST_ID).status, "submitted");
});

test("restart reconciles a mined receipt without rebroadcast after a crash before submitted persistence", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  const provider = new FakeProvider();
  const signer = new FakeSigner(ethers.Wallet.createRandom(), provider);

  await assert.rejects(
    execute(context, signer, {
      faults: { afterBroadcast: () => { throw new Error("simulated crash after broadcast"); } },
    }),
    /simulated crash after broadcast/,
  );
  const interrupted = context.journal.get(REQUEST_ID);
  assert.equal(interrupted.status, "broadcasting");
  assert.equal(interrupted.outbox.broadcastAttempts, 1);
  assert.equal(provider.broadcasts.length, 1);

  await context.reopen();
  signer.signingEnabled = false;
  const recoveryRequests = [];
  const recovery = await recoverUnresolvedActionJournal({
    actionJournal: context.journal,
    executeAction: async (request) => {
      recoveryRequests.push(request);
      const receipt = await execute(context, signer, { transactionRequest: null });
      await context.journal.complete(REQUEST_ID, {
        sourceTransaction: receipt.hash,
        reconciled: true,
      });
      return receipt;
    },
  });
  const receipt = recovery[0].result;

  assert.deepEqual(recoveryRequests, [{ requestId: REQUEST_ID, action: "deposit", amount: "25.0" }]);
  assert.equal(recovery[0].ok, true);
  assert.equal(receipt.hash, interrupted.outbox.transactionHash);
  assert.equal(provider.broadcasts.length, 1);
  assert.equal(context.journal.get(REQUEST_ID).status, "completed");
  assert.deepEqual(context.journal.unresolved(), []);
});

test("duplicate concurrent execution uses one signed raw transaction and one broadcast", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  const provider = new FakeProvider();
  const signer = new FakeSigner(ethers.Wallet.createRandom(), provider);

  const [first, duplicate] = await Promise.all([
    execute(context, signer),
    execute(context, signer),
  ]);

  assert.equal(first.hash, duplicate.hash);
  assert.equal(signer.signCalls, 1);
  assert.equal(provider.broadcasts.length, 1);
  assert.equal(ethers.Transaction.from(provider.broadcasts[0]).hash, first.hash);
});

test("a reverted durable receipt is a definite failure and is persisted as failed", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  const provider = new FakeProvider({ receiptStatus: 0 });
  const signer = new FakeSigner(ethers.Wallet.createRandom(), provider);
  let hookErrors = 0;
  const failingHook = () => { throw new Error("activity projection unavailable"); };

  await assert.rejects(
    execute(context, signer, {
      hooks: {
        afterPersist: failingHook,
        onBroadcasting: failingHook,
        afterBroadcast: failingHook,
        onSubmitted: failingHook,
      },
      onHookError: () => { hookErrors += 1; },
    }),
    (error) => {
      assert.equal(error.outcomeCertain, true);
      assert.equal(error.receipt.status, 0);
      assert.match(error.message, /reverted on-chain/);
      return true;
    },
  );
  const failed = context.journal.get(REQUEST_ID);
  assert.equal(failed.status, "failed");
  assert.equal(failed.outbox.status, "failed");
  assert.equal(failed.sourceTransaction, failed.outbox.transactionHash);
  assert.equal(provider.broadcasts.length, 1);
  assert.equal(hookErrors, 4);
  await assert.rejects(execute(context, signer), /Final action/);
  assert.equal(provider.broadcasts.length, 1);
});
