import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import { ethers } from "ethers";
import { UnresolvedActionConflictError } from "../../services/institutional-action-journal.mjs";
import {
  InstitutionalDemoRuntime,
  closeRuntimeResources,
  createRelayRuntime,
  positiveMilliseconds,
  recoveryBackoffMilliseconds,
  startAttestorCluster,
  transactionOutcomeIsUncertain,
} from "../../services/institutional-demo-runtime.mjs";

const ADDRESS_A = "0x00000000000000000000000000000000000000A1";
const ADDRESS_B = "0x00000000000000000000000000000000000000B1";

function manifest() {
  return {
    securityProfile: { finalityDepth: 2 },
    chains: {
      A: {
        chainId: 31_337,
        rpc: "http://127.0.0.1:8545",
        deploymentBlock: 10,
        contracts: {
          gateway: { address: ADDRESS_A },
          checkpointClient: { address: ADDRESS_B },
        },
      },
      B: {
        chainId: 31_338,
        rpc: "http://127.0.0.1:9545",
        deploymentBlock: 20,
        contracts: {
          gateway: { address: ADDRESS_B },
          checkpointClient: { address: ADDRESS_A },
        },
      },
    },
  };
}

function fakeServer(port) {
  return {
    listening: false,
    closeCalls: 0,
    address: () => ({ port }),
    close(callback) {
      this.closeCalls += 1;
      this.listening = false;
      callback();
    },
  };
}

function fakeJournal() {
  return {
    closeCalls: 0,
    async close() { this.closeCalls += 1; },
  };
}

function attestorSecrets(count) {
  return {
    attestors: Array.from({ length: count }, () => {
      const wallet = ethers.Wallet.createRandom();
      return { address: wallet.address, privateKey: wallet.privateKey };
    }),
  };
}

test("runtime timer configuration rejects zero, non-integer and non-finite intervals", () => {
  assert.equal(positiveMilliseconds("2000", "TEST_INTERVAL_MS"), 2_000);
  for (const value of ["0", "-1", "1.5", "not-a-number", "Infinity", "2147483648"]) {
    assert.throws(
      () => positiveMilliseconds(value, "TEST_INTERVAL_MS"),
      /TEST_INTERVAL_MS must be an integer between 1 and 2147483647 milliseconds/,
    );
  }
});

test("automatic action recovery backs off exponentially to a bounded interval", () => {
  assert.equal(recoveryBackoffMilliseconds(0), 2_000);
  assert.equal(recoveryBackoffMilliseconds(1), 2_000);
  assert.equal(recoveryBackoffMilliseconds(2), 4_000);
  assert.equal(recoveryBackoffMilliseconds(6), 60_000);
  assert.equal(recoveryBackoffMilliseconds(30), 60_000);
  assert.throws(() => recoveryBackoffMilliseconds(-1), /non-negative safe integer/);
});

test("attestor startup failure closes every partially opened server and journal", async () => {
  const journals = [];
  const servers = [];
  let listenCalls = 0;
  await assert.rejects(
    startAttestorCluster({
      manifest: manifest(),
      secrets: attestorSecrets(3),
      providers: { A: {}, B: {} },
      runtimeDirectory: tmpdir(),
      logger: { error() {} },
      dependencies: {
        openJournal: async () => {
          const journal = fakeJournal();
          journals.push(journal);
          return journal;
        },
        createAttestor: ({ wallet }) => ({ signerAddress: wallet.address }),
        createServer: () => {
          const server = fakeServer(41_000 + servers.length);
          servers.push(server);
          return server;
        },
        listenServer: async (server) => {
          listenCalls += 1;
          if (listenCalls === 2) throw new Error("simulated listen failure");
          server.listening = true;
        },
      },
    }),
    /simulated listen failure/,
  );

  assert.equal(journals.length, 2);
  assert.deepEqual(journals.map((journal) => journal.closeCalls), [1, 1]);
  assert.equal(servers[0].closeCalls, 1);
  assert.equal(servers[0].listening, false);
  assert.equal(servers[1].listening, false);
});

test("normal attestor cluster close is idempotent and releases servers before journals", async () => {
  const events = [];
  const journals = [];
  const servers = [];
  const cluster = await startAttestorCluster({
    manifest: manifest(),
    secrets: attestorSecrets(2),
    providers: { A: {}, B: {} },
    runtimeDirectory: tmpdir(),
    logger: { error() {} },
    dependencies: {
      openJournal: async () => {
        const journal = {
          closeCalls: 0,
          async close() { this.closeCalls += 1; events.push("journal"); },
        };
        journals.push(journal);
        return journal;
      },
      createAttestor: ({ wallet }) => ({ signerAddress: wallet.address }),
      createServer: () => {
        const server = fakeServer(42_000 + servers.length);
        server.close = function closeServer(callback) {
          this.closeCalls += 1;
          this.listening = false;
          events.push("server");
          callback();
        };
        servers.push(server);
        return server;
      },
      listenServer: async (server) => { server.listening = true; },
    },
  });

  await Promise.all([cluster.close(), cluster.close()]);
  assert.deepEqual(servers.map((server) => server.closeCalls), [1, 1]);
  assert.deepEqual(journals.map((journal) => journal.closeCalls), [1, 1]);
  assert.deepEqual(events.slice(0, 2), ["server", "server"]);
  assert.deepEqual(events.slice(2), ["journal", "journal"]);
});

test("relay startup failure releases its acquired journal lock", async () => {
  const journal = fakeJournal();
  let workflowCalls = 0;
  await assert.rejects(
    createRelayRuntime({
      manifest: manifest(),
      relayers: { A: {}, B: {} },
      endpoints: [],
      runtimeDirectory: tmpdir(),
      dependencies: {
        openJournal: async () => journal,
        createWorkflow: async () => {
          workflowCalls += 1;
          if (workflowCalls === 2) throw new Error("simulated lane startup failure");
          return {};
        },
      },
    }),
    /simulated lane startup failure/,
  );
  assert.equal(journal.closeCalls, 1);
});

test("embedded relay uses the normalized retry option names", async () => {
  const journal = fakeJournal();
  let engineOptions;
  const runtime = await createRelayRuntime({
    manifest: manifest(),
    relayers: { A: {}, B: {} },
    endpoints: [],
    runtimeDirectory: tmpdir(),
    dependencies: {
      openJournal: async () => journal,
      createWorkflow: async () => ({}),
      createEngine: (options) => {
        engineOptions = options;
        return { tick() {} };
      },
    },
  });

  assert.deepEqual(engineOptions.retry, { baseMs: 250, maxMs: 2_000, jitterRatio: 0 });
  assert.equal(runtime.journal, journal);
});

test("runtime cleanup attempts every journal and provider even when one close fails", async () => {
  const calls = [];
  const context = {
    attestorCluster: {
      async close() { calls.push("attestors"); throw new Error("attestor close failed"); },
    },
    relay: { journal: { async close() { calls.push("relay-journal"); } } },
    actionJournal: { async close() { calls.push("action-journal"); } },
    providers: { A: { destroy() { calls.push("provider-A"); } } },
    users: { A: { provider: { destroy() { calls.push("user-provider"); } } } },
    owners: {},
    relayers: {},
  };

  const errors = await closeRuntimeResources(context);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /attestor close failed/);
  for (const expected of ["attestors", "relay-journal", "action-journal", "provider-A", "user-provider"]) {
    assert.ok(calls.includes(expected), `missing cleanup call ${expected}`);
  }
});

test("runtime close still waits for the primary action after a concurrent busy request rejects", async () => {
  const runtime = new InstitutionalDemoRuntime({ logger: { error() {} } });
  let finishPrimary;
  const primary = runtime.executionTracker.track(new Promise((resolve) => { finishPrimary = resolve; }));
  const busy = runtime.executionTracker.track(Promise.reject(new Error("another action is already running")));
  await assert.rejects(busy, /already running/);
  assert.equal(runtime.executionTracker.size, 1);

  let actionJournalClosed = false;
  runtime.context = {
    actionJournal: { async close() { actionJournalClosed = true; } },
    providers: {},
    users: {},
    owners: {},
    relayers: {},
  };
  const closing = runtime.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(actionJournalClosed, false);

  finishPrimary();
  await primary;
  await closing;
  assert.equal(actionJournalClosed, true);
  assert.equal(runtime.executionTracker.size, 0);
});

test("runtime status automatically schedules unresolved journal recovery without client resubmission", async (t) => {
  const runtime = new InstitutionalDemoRuntime({ logger: { error() {} } });
  t.after(() => runtime.close());
  const operation = {
    requestId: "request-recovery-0001",
    action: "deposit",
    label: "Activate voucher collateral",
    lane: "Bank B",
    amount: "25.0",
    status: "signed",
    sourceTransaction: `0x${"ab".repeat(32)}`,
    outbox: { transactionHash: `0x${"ab".repeat(32)}`, broadcastAttempts: 0 },
    createdAt: "2027-01-15T08:00:00.000Z",
    updatedAt: "2027-01-15T08:00:00.000Z",
  };
  let unresolved = [operation];
  let resolveRecovery;
  const recoveryObserved = new Promise((resolve) => { resolveRecovery = resolve; });
  const closed = [];
  runtime.context = {
    manifest: { version: "test-fixture", status: "not-deployed" },
    actionJournal: {
      unresolved: () => structuredClone(unresolved),
      async close() { closed.push("action-journal"); },
    },
    relay: {
      journal: { async close() { closed.push("relay-journal"); } },
    },
    attestorCluster: {
      nodes: [],
      async close() { closed.push("attestors"); },
    },
    providers: {},
    users: {},
    owners: {},
    relayers: {},
  };
  const requests = [];
  runtime.execute = async (request) => {
    requests.push(request);
    unresolved = [];
    resolveRecovery();
    return { ok: true };
  };

  const status = await runtime.status();
  assert.equal(status.controller.recoverableOperations.length, 1);
  await Promise.race([
    recoveryObserved,
    new Promise((_, reject) => setTimeout(() => reject(new Error("automatic recovery did not run")), 1_000)),
  ]);
  assert.deepEqual(requests, [{
    requestId: operation.requestId,
    action: operation.action,
    amount: operation.amount,
  }]);

  await runtime.close();
  assert.deepEqual(new Set(closed), new Set(["attestors", "relay-journal", "action-journal"]));
});

test("idempotency conflicts with a known hash remain definite while ambiguous transport failures do not", () => {
  const hash = `0x${"ab".repeat(32)}`;
  const conflict = new Error("idempotency key belongs to another intent");
  conflict.outcomeCertain = true;
  assert.equal(transactionOutcomeIsUncertain(conflict, hash), false);
  assert.equal(transactionOutcomeIsUncertain(new Error("fetch failed"), hash), true);
  assert.equal(transactionOutcomeIsUncertain({ receipt: { status: 0 } }, hash), false);
  assert.equal(transactionOutcomeIsUncertain(new Error("fetch failed"), null), false);
});

test("runtime returns the stored recoverable operation for action and amount idempotency conflicts", async (t) => {
  const runtime = new InstitutionalDemoRuntime({ logger: { error() {} } });
  t.after(() => runtime.close());
  const requestId = "request-conflict-0001";
  const hash = `0x${"cd".repeat(32)}`;
  const existing = {
    requestId,
    action: "deposit",
    label: "Legacy deposit label",
    lane: "Bank B",
    amount: "25.0",
    status: "uncertain",
    sourceTransaction: hash,
    outbox: { transactionHash: hash },
  };
  let failCalls = 0;
  runtime.context = {
    actionJournal: {
      get: () => structuredClone(existing),
      async fail() { failCalls += 1; },
      async close() {},
    },
    providers: {},
    users: {},
    owners: {},
    relayers: {},
  };

  for (const request of [
    { requestId, action: "borrow", amount: "25.0" },
    { requestId, action: "deposit", amount: "26.0" },
    { requestId, action: "deposit", amount: "not-a-number" },
  ]) {
    await assert.rejects(
      runtime.execute(request),
      (error) => {
        assert.equal(error.statusCode, request.amount === "not-a-number" ? 400 : 409);
        assert.equal(error.outcomeCertain, true);
        assert.deepEqual(error.payload.operation, existing);
        return true;
      },
    );
  }
  assert.equal(failCalls, 0);
  assert.equal(runtime.activeOperation, null);
});

test("runtime unresolved-action fence rejects before an approval prerequisite can consume its nonce", async (t) => {
  const runtime = new InstitutionalDemoRuntime({ logger: { error() {} } });
  t.after(() => runtime.close());
  const blockingOperation = {
    requestId: "request-blocking-0001",
    action: "borrow",
    label: "Borrow bCASH from Bank B",
    lane: "Bank B",
    amount: "10.0",
    status: "signed",
    sourceTransaction: `0x${"ef".repeat(32)}`,
    outbox: { transactionHash: `0x${"ef".repeat(32)}` },
  };
  let approvalReads = 0;
  runtime.context = {
    actionJournal: {
      get: () => null,
      async prepare() { throw new UnresolvedActionConflictError(blockingOperation); },
      async close() {},
    },
    contracts: {
      voucherTokenB: { async allowance() { approvalReads += 1; return 0n; } },
    },
    providers: {},
    users: {},
    owners: {},
    relayers: {},
  };
  runtime.status = async () => ({
    ready: true,
    balances: { voucherAvailable: "100.0" },
    risk: {},
  });

  await assert.rejects(
    runtime.execute({ requestId: "request-new-0001", action: "deposit", amount: "5.0" }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.payload.code, "INSTITUTIONAL_ACTION_IN_PROGRESS");
      assert.deepEqual(error.payload.operation, blockingOperation);
      return true;
    },
  );
  assert.equal(approvalReads, 0);
});
