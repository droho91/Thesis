import assert from "node:assert/strict";
import test from "node:test";
import { InstitutionalRelayEngine } from "../../services/institutional-relay/relay-engine.mjs";
import { normalizeRetryOptions, retryDelayMs } from "../../services/institutional-relay/retry.mjs";

const journal = {
  cursor() { return 0; },
  runnable() { return []; },
  snapshot() { return { jobs: {} }; },
};
const lanes = [{
  id: "A-to-B",
  startBlock: 1,
  workflow: {
    async scan() { return { events: [], scannedTo: 0 }; },
    async step() { return { state: "completed" }; },
  },
}];

test("retry options are normalized once with bounded deterministic values", () => {
  const options = normalizeRetryOptions({ baseMs: 250, maxMs: 2_000, jitterRatio: 0, random: () => 0.5 });
  assert.equal(Object.isFrozen(options), true);
  assert.equal(retryDelayMs(1, options), 250);
  assert.equal(retryDelayMs(4, options), 2_000);
  assert.equal(retryDelayMs(20, options), 2_000);
});

test("legacy retry option names fail fast instead of silently using defaults", () => {
  for (const retry of [
    { initialMs: 250 },
    { maximumMs: 2_000 },
    { baseMs: 250, maximumMs: 2_000 },
  ]) {
    assert.throws(
      () => new InstitutionalRelayEngine({ journal, lanes, retry }),
      /Unknown relay retry option/,
    );
  }
});

test("invalid retry ranges and random sources fail closed", () => {
  for (const options of [
    { baseMs: 0 },
    { baseMs: 100, maxMs: 99 },
    { maxMs: 2_147_483_648 },
    { jitterRatio: -0.01 },
    { jitterRatio: 1.01 },
    { random: 1 },
    new Date(),
  ]) {
    assert.throws(() => normalizeRetryOptions(options), /Relay retry/);
  }
  assert.throws(
    () => retryDelayMs(1, { random: () => 1 }),
    /must return a number in \[0, 1\)/,
  );
  assert.throws(() => retryDelayMs(0), /positive safe integer/);
});
