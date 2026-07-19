import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InstitutionalRelayEngine } from "../../services/institutional-relay/relay-engine.mjs";
import { RelayJournal } from "../../services/institutional-relay/relay-journal.mjs";
import { PermanentRelayError } from "../../services/institutional-relay/retry.mjs";

const MESSAGE_ID = `0x${"12".repeat(32)}`;

function observedEvent() {
  return {
    messageId: MESSAGE_ID,
    sourceTxHash: `0x${"34".repeat(32)}`,
    sourceBlockNumber: 10,
    message: {
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
    },
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "institutional-relay-"));
  const path = join(directory, "journal.json");
  let now = 1_800_000_000_000;
  const clock = () => now;
  const journal = await RelayJournal.open(path, { clock });
  return {
    directory,
    path,
    clock,
    journal,
    advance(milliseconds) {
      now += milliseconds;
    },
  };
}

test("relay engine persists every state and completes idempotently", async (t) => {
  const context = await fixture();
  t.after(() => rm(context.directory, { recursive: true, force: true }));
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
  const context = await fixture();
  t.after(() => rm(context.directory, { recursive: true, force: true }));
  const event = observedEvent();

  assert.equal(await context.journal.observe("A-to-B", event), true);
  assert.equal(await context.journal.observe("A-to-B", event), false);
  await assert.rejects(
    context.journal.observe("A-to-B", { ...event, sourceTxHash: `0x${"56".repeat(32)}` }),
    /Conflicting observation/,
  );
  assert.equal(Object.keys(context.journal.snapshot().jobs).length, 1);
});

test("expired leases are recovered after process restart", async (t) => {
  const context = await fixture();
  t.after(() => rm(context.directory, { recursive: true, force: true }));
  await context.journal.observe("A-to-B", observedEvent());
  assert.ok(await context.journal.claim(MESSAGE_ID, "crashed-worker", 5_000));

  const reopened = await RelayJournal.open(context.path, { clock: context.clock });
  assert.equal(reopened.runnable().length, 0);
  context.advance(5_001);
  assert.equal(reopened.runnable().length, 1);
  assert.ok(await reopened.claim(MESSAGE_ID, "replacement-worker", 5_000));
});

test("transient failures back off and permanent failures terminate", async (t) => {
  const context = await fixture();
  t.after(() => rm(context.directory, { recursive: true, force: true }));
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
