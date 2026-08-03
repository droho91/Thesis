import assert from "node:assert/strict";
import test from "node:test";
import {
  observeChainProgress,
  readInstitutionalStatus,
  summarizeRelayJournal,
} from "../../scripts/ui/read-model.mjs";

const ADDRESS = "0x00000000000000000000000000000000000000A1";

function manifest() {
  const contracts = Object.fromEntries([
    "gateway",
    "collateralApp",
    "canonicalToken",
    "voucherToken",
    "lendingPool",
  ].map((name) => [name, { address: ADDRESS }]));
  return {
    version: "institutional-deployment-v2",
    status: "ready",
    chains: {
      A: { rpc: "http://127.0.0.1:18545", contracts },
      B: { rpc: "http://127.0.0.1:19545", contracts },
    },
  };
}

test("fallback status providers are destroyed when the runtime is unreadable", async () => {
  const providers = [];
  const status = await readInstitutionalStatus({
    manifest: manifest(),
    activity: { version: "institutional-demo-state-v1", latest: null, history: [] },
    artifacts: {},
    contracts: {},
    providerFactory() {
      const provider = {
        destroyCalls: 0,
        async getCode() { return "0x"; },
        destroy() { this.destroyCalls += 1; },
      };
      providers.push(provider);
      return provider;
    },
  });

  assert.equal(status.ready, false);
  assert.equal(providers.length, 2);
  assert.deepEqual(providers.map((provider) => provider.destroyCalls), [1, 1]);
});

test("status reads do not destroy providers owned by a long-lived runtime", async () => {
  const providers = {
    A: { destroyCalls: 0, async getCode() { return "0x"; }, destroy() { this.destroyCalls += 1; } },
    B: { destroyCalls: 0, async getCode() { return "0x"; }, destroy() { this.destroyCalls += 1; } },
  };
  const status = await readInstitutionalStatus({
    manifest: manifest(),
    activity: { version: "institutional-demo-state-v1", latest: null, history: [] },
    providers,
    artifacts: {},
    contracts: {},
  });

  assert.equal(status.ready, false);
  assert.equal(providers.A.destroyCalls, 0);
  assert.equal(providers.B.destroyCalls, 0);
});

test("a partially constructed fallback provider set is released", async () => {
  let factoryCalls = 0;
  const first = {
    destroyCalls: 0,
    destroy() { this.destroyCalls += 1; },
  };
  const status = await readInstitutionalStatus({
    manifest: manifest(),
    activity: { version: "institutional-demo-state-v1", latest: null, history: [] },
    providerFactory() {
      factoryCalls += 1;
      if (factoryCalls === 1) return first;
      throw new Error("injected Bank B provider failure");
    },
  });

  assert.equal(status.ready, false);
  assert.match(status.error, /injected Bank B provider failure/);
  assert.equal(first.destroyCalls, 1);
});

test("chain liveness requires observed progress and expires when heads stop advancing", () => {
  const first = observeChainProgress({}, { A: 10, B: 20 }, { now: 1_000, staleAfterMs: 5_000 });
  assert.equal(first.chainsProgressing, false);
  const progressing = observeChainProgress(first.chains, { A: 11, B: 21 }, { now: 2_000, staleAfterMs: 5_000 });
  assert.equal(progressing.chainsProgressing, true);
  const recent = observeChainProgress(progressing.chains, { A: 11, B: 21 }, { now: 6_000, staleAfterMs: 5_000 });
  assert.equal(recent.chainsProgressing, true);
  const stale = observeChainProgress(recent.chains, { A: 11, B: 21 }, { now: 7_001, staleAfterMs: 5_000 });
  assert.equal(stale.chainsProgressing, false);
});

test("relay and quorum readiness are independent semantic signals", () => {
  const relay = summarizeRelayJournal({ jobs: {} }, {
    activeAttestors: 3,
    attestorThreshold: 3,
    relayHealth: {
      lastAttemptAt: "1970-01-01T00:00:02.000Z",
      lastHealthyAt: "1970-01-01T00:00:02.000Z",
      lastError: null,
    },
    now: 3_000,
    staleAfterMs: 5_000,
  });
  assert.equal(relay.attestorQuorumReady, true);
  assert.equal(relay.relayerHealthy, true);

  const noQuorum = summarizeRelayJournal({ jobs: {} }, {
    activeAttestors: 1,
    attestorThreshold: 3,
    relayHealth: { lastHealthyAt: "1970-01-01T00:00:02.000Z", lastError: null },
    now: 3_000,
    staleAfterMs: 5_000,
  });
  assert.equal(noQuorum.attestorQuorumReady, false);
  assert.equal(noQuorum.relayerHealthy, true);

  const staleRelay = summarizeRelayJournal({ jobs: {} }, {
    activeAttestors: 4,
    attestorThreshold: 3,
    relayHealth: { lastHealthyAt: "1970-01-01T00:00:02.000Z", lastError: null },
    now: 7_001,
    staleAfterMs: 5_000,
  });
  assert.equal(staleRelay.attestorQuorumReady, true);
  assert.equal(staleRelay.relayerHealthy, false);
});
