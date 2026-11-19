import assert from "node:assert/strict";
import test from "node:test";
import { seedInitialAccounts } from "../../scripts/ops/deployment/initial-funding.mjs";

function fixture(status = "deploying") {
  const manifest = { status, chains: { A: { contracts: { canonicalToken: {} } }, B: { contracts: { debtToken: {} } } } };
  const allocations = [
    { chain: "A", contract: "canonicalToken", account: "userA", amount: 100000n },
    { chain: "B", contract: "debtToken", account: "userB", amount: 100n },
    { chain: "B", contract: "debtToken", account: "ownerB", amount: 1000000n },
  ];
  const balances = new Map();
  const mints = [];
  let persisted = structuredClone(manifest);
  const state = {
    manifest, allocations, balances, mints,
    readBalance: async (_chain, _contract, account) => balances.get(account) || 0n,
    mint: async (_chain, _contract, account, amount) => {
      mints.push({ account, amount });
      balances.set(account, (balances.get(account) || 0n) + amount);
      return { hash: `mint-${account}` };
    },
    confirm: async () => {},
    persist: async () => { persisted = structuredClone(state.manifest); },
    restoredManifest: () => structuredClone(persisted),
  };
  return state;
}

test("initial funding happens once and does not refill spent or escrowed balances", async () => {
  const state = fixture();
  await seedInitialAccounts(state);
  assert.deepEqual(state.mints, state.allocations.map(({ account, amount }) => ({ account, amount })));
  state.balances.set("userA", 98000n);
  state.balances.set("userB", 99n);
  state.balances.set("ownerB", 900000n);
  state.manifest = state.restoredManifest();
  await seedInitialAccounts(state);
  assert.equal(state.mints.length, 3);
  assert.equal(state.balances.get("userA"), 98000n);
  assert.equal(state.balances.get("userB"), 99n);
});

test("legacy ready deployments are adopted without minting or changing balances", async () => {
  const state = fixture("ready");
  state.balances.set("userA", 98000n);
  await seedInitialAccounts(state);
  assert.equal(state.mints.length, 0);
  assert.equal(state.balances.get("userA"), 98000n);
  assert.equal(state.manifest.chains.B.contracts.debtToken.initialFunding.complete, true);
});

test("a newly redeployed token is funded even when the surrounding manifest was ready", async () => {
  const state = fixture("ready");
  state.manifest.chains.A.contracts.canonicalToken.initialFunding = { accounts: {} };
  await seedInitialAccounts(state);
  assert.deepEqual(state.mints, [{ account: "userA", amount: 100000n }]);
});

test("resuming initialization confirms the pending mint without issuing it again", async () => {
  const state = fixture();
  let calls = 0;
  await assert.rejects(seedInitialAccounts({ ...state, confirm: async () => {
    calls++;
    if (calls === 2) throw new Error("receipt response lost");
  } }), /response lost/);
  assert.equal(calls, 2);
  state.balances.set("userB", 0n);
  state.manifest = state.restoredManifest();
  await seedInitialAccounts(state);
  assert.equal(state.mints.length, 3);
  assert.equal(state.balances.get("userB"), 0n);
  state.manifest = state.restoredManifest();
  await seedInitialAccounts(state);
  assert.equal(state.mints.length, 3);
});
