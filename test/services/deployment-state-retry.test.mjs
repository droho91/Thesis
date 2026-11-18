import assert from "node:assert/strict";
import test from "node:test";
import { ensureValue, ensureBoolean, ensureBigInt } from "../../scripts/ops/deployment/deploy-stack.mjs";

function unavailableState() {
  return Object.assign(new Error("missing revert data"), { code: "CALL_EXCEPTION", data: null, reason: null });
}

test("deployment checks reread transient Besu state before deciding to configure", async () => {
  for (const [ensure, expected] of [
    [ensureValue, "0x0000000000000000000000000000000000000001"],
    [ensureBoolean, true],
    [ensureBigInt, 100n],
  ]) {
    let reads = 0;
    await ensure(async () => {
      if (++reads === 1) throw unavailableState();
      return expected;
    }, expected, "deployment state", () => assert.fail("Already configured state must not send a transaction"));
    assert.equal(reads, 2);
  }
});

test("deployment never retries a configuration transaction after an ambiguous send failure", async () => {
  let sends = 0;
  const error = unavailableState();
  await assert.rejects(ensureBoolean(async () => false, true, "deployment state", async () => {
    sends++;
    throw error;
  }), (actual) => actual === error);
  assert.equal(sends, 1);
});

test("deployment propagates a contract rejection without retrying or configuring", async () => {
  let reads = 0;
  const error = Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION", data: "0x1234", reason: "Denied" });
  await assert.rejects(ensureBoolean(async () => {
    reads++;
    throw error;
  }, true, "deployment state", () => assert.fail("Rejected reads must not configure")), (actual) => actual === error);
  assert.equal(reads, 1);
});
