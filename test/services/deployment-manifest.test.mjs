import assert from "node:assert/strict";
import test from "node:test";
import { manifestAccountsMatchRuntime } from "../../scripts/ops/deployment/deploy-stack.mjs";

const runtimeAccounts = {
  A: {
    owner: "0x0000000000000000000000000000000000000001",
    user: "0x0000000000000000000000000000000000000002",
    relayer: "0x0000000000000000000000000000000000000003",
  },
  B: {
    owner: "0x0000000000000000000000000000000000000004",
    user: "0x0000000000000000000000000000000000000005",
    relayer: "0x0000000000000000000000000000000000000006",
  },
};

test("deployment manifest is reusable only with the current Besu operator accounts", () => {
  assert.equal(manifestAccountsMatchRuntime(structuredClone(runtimeAccounts), runtimeAccounts), true);

  const stale = structuredClone(runtimeAccounts);
  stale.B.owner = "0x0000000000000000000000000000000000000007";
  assert.equal(manifestAccountsMatchRuntime(stale, runtimeAccounts), false);

  const incomplete = structuredClone(runtimeAccounts);
  delete incomplete.A.relayer;
  assert.equal(manifestAccountsMatchRuntime(incomplete, runtimeAccounts), false);
});
