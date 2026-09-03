import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InstitutionalRelayEngine } from "../../services/institutional-relay/relay-engine.mjs";
import {
  RelayJournal,
  RelayLeaseLostError,
  institutionalMessageId,
} from "../../services/institutional-relay/relay-journal.mjs";
import { PermanentRelayError } from "../../services/institutional-relay/retry.mjs";

const MESSAGE = Object.freeze({
  version: "1",
  nonce: "1",
  sourceChainId: "41001",
  sourceGateway: "0x00000000000000000000000000000000000000a1",
  sourceApplication: "0x00000000000000000000000000000000000000a2",
  destinationChainId: "41002",
  destinationGateway: "0x00000000000000000000000000000000000000b1",
  destinationApplication: "0x00000000000000000000000000000000000000b2",
  timeoutTimestamp: "1800003600",
  payload: "0x1234",
});
const MESSAGE_ID = institutionalMessageId(MESSAGE);

function observedEvent() {
  return {
    messageId: MESSAGE_ID,
    sourceTxHash: `0x${"34".repeat(32)}`,
    sourceBlockNumber: 10,
    message: { ...MESSAGE },
  };
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "institutional-relay-"));
  const path = join(directory, "journal.json");
  let now = 1_800_000_000_000;
  const clock = () => now;
  const journal = await RelayJournal.open(path, { clock });
  const journals = [journal];
  const context = {
    directory,
    path,
    clock,
    journal,
    track(journalInstance) {
      journals.push(journalInstance);
      return journalInstance;
    },
    advance(milliseconds) {
      now += milliseconds;
    },
  };
  t.after(async () => {
    for (const journalInstance of journals.reverse()) await journalInstance.close();
    await rm(directory, { recursive: true, force: true });
  });
  return context;
}

test("relay engine persists every state and completes idempotently", async (t) => {
  const context = await fixture(t);
  let scanned = false;
  const transitions = {
    observed: "source_checkpointed",
    source_checkpointed: "received",
    received: "destination_checkpointed",
    destination_checkpointed: "completed",
  };
  const workflow = {
    async scan(fromBlock) {
      if (scanned) return { events: [], scannedTo: Math.max(fromBlock - 1, 10) };
      scanned = true;
      return { events: [observedEvent()], scannedTo: 10 };
    },
    async step(job) {
      return { state: transitions[job.state], patch: { [`at_${job.state}`]: true } };
    },
  };
  const engine = new InstitutionalRelayEngine({
    journal: context.journal,
    lanes: [{ id: "A-to-B", startBlock: 1, workflow }],
    workerId: "worker-a",
    clock: context.clock,
    logger: { info() {}, error() {} },
  });

  for (let i = 0; i < 4; i++) await engine.tick();
  const job = context.journal.snapshot().jobs[MESSAGE_ID];
  assert.equal(job.state, "completed");
  assert.deepEqual(job.history.map((entry) => entry.state), [
    "observed",
    "source_checkpointed",
    "received",
    "destination_checkpointed",
    "completed",
  ]);

  await engine.tick();
  assert.equal(context.journal.snapshot().jobs[MESSAGE_ID].history.length, 5);
});

test("journal deduplicates observations and rejects conflicting source transactions", async (t) => {
  const context = await fixture(t);
  const event = observedEvent();

  assert.equal(await context.journal.observe("A-to-B", event), true);
  assert.equal(await context.journal.observe("A-to-B", event), false);
  await assert.rejects(
    context.journal.observe("A-to-B", { ...event, sourceTxHash: `0x${"56".repeat(32)}` }),
    /Conflicting observation/,
  );
  await assert.rejects(
    context.journal.observe("A-to-B", { ...event, message: { ...event.message, payload: "0xabcd" } }),
    /Conflicting observation/,
  );
  assert.equal(Object.keys(context.journal.snapshot().jobs).length, 1);
});

test("expired leases are recovered after process restart", async (t) => {
  const context = await fixture(t);
  await context.journal.observe("A-to-B", observedEvent());
  assert.ok(await context.journal.claim(MESSAGE_ID, "crashed-worker", 5_000));

  await context.journal.close();
  const reopened = context.track(await RelayJournal.open(context.path, { clock: context.clock }));
  assert.equal(reopened.runnable().length, 0);
  context.advance(5_001);
  assert.equal(reopened.runnable().length, 1);
  assert.ok(await reopened.claim(MESSAGE_ID, "replacement-worker", 5_000));
});

test("journal restart rejects corrupted durable relay fields", async (t) => {
  const context = await fixture(t);
  await context.journal.observe("A-to-B", observedEvent());
  await context.journal.close();
  const valid = JSON.parse(await readFile(context.path, "utf8"));
  const corruptions = [
    ["missing message", (state) => { delete state.jobs[MESSAGE_ID].message; }],
    ["message ID mismatch", (state) => { state.jobs[MESSAGE_ID].message.nonce = "2"; }],
    ["invalid source block", (state) => { state.jobs[MESSAGE_ID].sourceBlockNumber = -1; }],
    ["transaction mismatch", (state) => { state.jobs[MESSAGE_ID].transactions.source = `0x${"56".repeat(32)}`; }],
    ["history mismatch", (state) => { state.jobs[MESSAGE_ID].history.at(-1).state = "completed"; }],
  ];

  for (const [label, corrupt] of corruptions) {
    const state = structuredClone(valid);
    corrupt(state);
    await writeFile(context.path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await assert.rejects(
      RelayJournal.open(context.path, { clock: context.clock }),
      /Relay journal job/,
      label,
    );
  }
});

test("transient failures back off and permanent failures terminate", async (t) => {
  const context = await fixture(t);
  let attempts = 0;
  const workflow = {
    async scan(fromBlock) {
      return { events: fromBlock <= 10 ? [observedEvent()] : [], scannedTo: 10 };
    },
    async step() {
      attempts += 1;
      if (attempts === 1) throw new Error("RPC unavailable");
      throw new PermanentRelayError("Checkpoint root conflict");
    },
  };
  const engine = new InstitutionalRelayEngine({
    journal: context.journal,
    lanes: [{ id: "A-to-B", startBlock: 1, workflow }],
    workerId: "worker-a",
    clock: context.clock,
    retry: { baseMs: 1_000, jitterRatio: 0 },
    logger: { info() {}, error() {} },
  });

  await engine.tick();
  let job = context.journal.snapshot().jobs[MESSAGE_ID];
  assert.equal(job.state, "observed");
  assert.equal(job.attempts, 1);
  assert.equal(job.nextAttemptAt, context.clock() + 1_000);

  context.advance(1_000);
  await engine.tick();
  job = context.journal.snapshot().jobs[MESSAGE_ID];
  assert.equal(job.state, "failed_permanent");
  assert.match(job.lastError.message, /Checkpoint root conflict/);
});

test("heartbeat renews the real journal while a step exceeds its initial logical lease", { timeout: 30_000 }, async (t) => {
  const context = await fixture(t);
  await context.journal.observe("A-to-B", observedEvent());
  const initialTimestamp = context.clock();
  const observed = observeLeaseRenewals(context.journal, {
    beforeRenew() { context.advance(30); },
  });
  const workflow = {
    async scan(fromBlock) {
      return { events: [], scannedTo: fromBlock - 1 };
    },
    async step() {
      // Four one-third-lease heartbeat intervals cannot complete within the
      // original lease window. Advancing the journal clock on each renewal
      // makes the assertion deterministic even when filesystem fsync is slow.
      await observed.waitFor(4);
      return { state: "completed" };
    },
  };
  const engine = new InstitutionalRelayEngine({
    journal: observed.journal,
    lanes: [{ id: "A-to-B", startBlock: 1, workflow }],
    workerId: "worker-heartbeat",
    clock: context.clock,
    leaseMs: 90,
    logger: { info() {}, error() {}, warn() {} },
  });

  await engine.tick();
  const job = context.journal.snapshot().jobs[MESSAGE_ID];
  assert.equal(job.state, "completed");
  assert.equal(job.fencingToken, 1);
  assert.equal(job.lease, null);
  assert.ok(observed.count >= 4);
  assert.ok(context.clock() - initialTimestamp > 90);
});

test("a stale fencing token cannot commit after another worker takes an expired lease", async (t) => {
  const context = await fixture(t);
  await context.journal.observe("A-to-B", observedEvent());
  const stale = await context.journal.claim(MESSAGE_ID, "worker-stale", 100);
  context.advance(101);
  const current = await context.journal.claim(MESSAGE_ID, "worker-current", 100);

  assert.equal(stale.lease.fencingToken, 1);
  assert.equal(current.lease.fencingToken, 2);
  await assert.rejects(
    context.journal.transition(MESSAGE_ID, "worker-stale", stale.lease.fencingToken, "completed"),
    (error) => error instanceof RelayLeaseLostError && /stale|owned by/.test(error.message),
  );
  await context.journal.transition(MESSAGE_ID, "worker-current", current.lease.fencingToken, "completed");
  assert.equal(context.journal.snapshot().jobs[MESSAGE_ID].state, "completed");
});

test("transition rejects reserved, non-JSON patches and invalid delays without mutating the job", async (t) => {
  const context = await fixture(t);
  await context.journal.observe("A-to-B", observedEvent());
  const claimed = await context.journal.claim(MESSAGE_ID, "worker-guarded-patch", 1_000);
  const before = context.journal.snapshot().jobs[MESSAGE_ID];

  await assert.rejects(
    context.journal.transition(
      MESSAGE_ID,
      "worker-guarded-patch",
      claimed.lease.fencingToken,
      "completed",
      { fencingToken: 999 },
    ),
    /cannot overwrite reserved field.*fencingToken/,
  );
  await assert.rejects(
    context.journal.transition(
      MESSAGE_ID,
      "worker-guarded-patch",
      claimed.lease.fencingToken,
      "completed",
      { unsafeAmount: 1n },
    ),
    /non-JSON value/,
  );
  await assert.rejects(
    context.journal.transition(
      MESSAGE_ID,
      "worker-guarded-patch",
      claimed.lease.fencingToken,
      "completed",
      {},
      Number.NaN,
    ),
    /deferMs must be an integer/,
  );
  assert.deepEqual(context.journal.snapshot().jobs[MESSAGE_ID], before);
});

test("two relay workers race safely and the expired worker cannot commit its delayed result", { timeout: 10_000 }, async (t) => {
  const context = await fixture(t);
  await context.journal.observe("A-to-B", observedEvent());
  let releaseStaleStep;
  let markStaleStarted;
  const staleStarted = new Promise((resolveStarted) => { markStaleStarted = resolveStarted; });
  const staleGate = new Promise((resolveStep) => { releaseStaleStep = resolveStep; });
  const warnings = [];
  const baseScan = async (fromBlock) => ({ events: [], scannedTo: fromBlock - 1 });
  const staleEngine = new InstitutionalRelayEngine({
    journal: context.journal,
    lanes: [{
      id: "A-to-B",
      startBlock: 1,
      workflow: {
        scan: baseScan,
        async step() {
          markStaleStarted();
          await staleGate;
          return { state: "source_checkpointed", patch: { staleWorkerResult: true } };
        },
      },
    }],
    workerId: "worker-stale-engine",
    clock: context.clock,
    leaseMs: 300,
    logger: { info() {}, error() {}, warn(message) { warnings.push(message); } },
  });
  const currentEngine = new InstitutionalRelayEngine({
    journal: context.journal,
    lanes: [{
      id: "A-to-B",
      startBlock: 1,
      workflow: { scan: baseScan, async step() { return { state: "completed" }; } },
    }],
    workerId: "worker-current-engine",
    clock: context.clock,
    leaseMs: 300,
    logger: { info() {}, error() {}, warn() {} },
  });

  const staleTick = staleEngine.tick();
  await staleStarted;
  context.advance(301);
  await currentEngine.tick();
  releaseStaleStep();
  await staleTick;

  const job = context.journal.snapshot().jobs[MESSAGE_ID];
  assert.equal(job.state, "completed");
  assert.equal(job.fencingToken, 2);
  assert.equal(job.staleWorkerResult, undefined);
  assert.match(warnings.join("\n"), /lease lost; stale result abandoned/);
});

test("lease expiry in the failure path abandons the stale result without rejecting tick", async (t) => {
  const context = await fixture(t);
  const workflow = {
    async scan(fromBlock) {
      return { events: fromBlock <= 10 ? [observedEvent()] : [], scannedTo: 10 };
    },
    async step() {
      context.advance(101);
      throw new Error("RPC response arrived after the lease expired");
    },
  };
  const warnings = [];
  const engine = new InstitutionalRelayEngine({
    journal: context.journal,
    lanes: [{ id: "A-to-B", startBlock: 1, workflow }],
    workerId: "worker-expired",
    clock: context.clock,
    leaseMs: 100,
    retry: { baseMs: 10, maxMs: 10, jitterRatio: 0 },
    logger: { info() {}, error() {}, warn(message) { warnings.push(message); } },
  });

  await assert.doesNotReject(engine.tick());
  assert.equal(context.journal.snapshot().jobs[MESSAGE_ID].state, "observed");
  assert.match(warnings.join("\n"), /lease lost; stale result abandoned/);
});

test("run retries a transient scan failure with backoff and recovers", async (t) => {
  const context = await fixture(t);
  const controller = new AbortController();
  let scans = 0;
  const errors = [];
  const workflow = {
    async scan(fromBlock) {
      scans += 1;
      if (scans === 1) throw new TypeError("fetch failed");
      controller.abort();
      return { events: [], scannedTo: fromBlock - 1 };
    },
    async step() {
      throw new Error("No job should be processed");
    },
  };
  const engine = new InstitutionalRelayEngine({
    journal: context.journal,
    lanes: [{ id: "A-to-B", startBlock: 1, workflow }],
    workerId: "worker-scan-recovery",
    clock: context.clock,
    retry: { baseMs: 5, maxMs: 5, jitterRatio: 0 },
    logger: { info() {}, warn() {}, error(message) { errors.push(message); } },
  });

  await engine.run({ signal: controller.signal, pollIntervalMs: 5 });
  assert.equal(scans, 2);
  assert.match(errors.join("\n"), /fetch failed/);
});

function observeLeaseRenewals(journal, { beforeRenew = () => {} } = {}) {
  let count = 0;
  let waiters = [];
  const proxy = new Proxy(journal, {
    get(target, property) {
      if (property === "renewLease") {
        return async (...args) => {
          await beforeRenew();
          const result = await target.renewLease(...args);
          count += 1;
          const ready = waiters.filter((waiter) => waiter.count <= count);
          waiters = waiters.filter((waiter) => waiter.count > count);
          for (const waiter of ready) waiter.resolve();
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    journal: proxy,
    get count() { return count; },
    waitFor(expected) {
      if (count >= expected) return Promise.resolve();
      return new Promise((resolveWait) => waiters.push({ count: expected, resolve: resolveWait }));
    },
  };
}
