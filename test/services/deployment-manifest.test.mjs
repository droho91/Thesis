import assert from "node:assert/strict";
import test from "node:test";
import {
  INSTITUTIONAL_DEPLOYMENT_SCHEMA,
  artifactFingerprint,
  createDeploymentManifest,
  deploymentManifestMatchesRuntime,
  manifestAccountsMatchRuntime,
} from "../../scripts/ops/deployment/deployment-manifest.mjs";

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

test("deployment manifest construction and compatibility checks are deterministic", () => {
  const artifacts = {
    beta: { bytecode: "0x6001" },
    alpha: { deployedBytecode: "0x6002" },
  };
  const fingerprint = artifactFingerprint(artifacts);
  const chainIds = { A: 41_001n, B: 41_002n };
  const attestors = [
    "0x0000000000000000000000000000000000000011",
    "0x0000000000000000000000000000000000000012",
    "0x0000000000000000000000000000000000000013",
    "0x0000000000000000000000000000000000000014",
  ];
  const manifest = createDeploymentManifest({
    fingerprint,
    chainIds,
    chainRpcs: { A: "http://127.0.0.1:8545", B: "http://127.0.0.1:9545" },
    accounts: runtimeAccounts,
    attestors,
    threshold: 3,
    maxCheckpointSubmissionAge: 604_800n,
    maxClockDrift: 30n,
    finalityDepth: 2,
    governanceDelay: 60n,
    now: "2026-08-02T00:00:00.000Z",
  });

  assert.equal(manifest.version, INSTITUTIONAL_DEPLOYMENT_SCHEMA);
  assert.equal(manifest.securityProfile.checkpointModel, "3-of-4 institutional attestors");
  assert.equal(deploymentManifestMatchesRuntime({
    manifest,
    fingerprint,
    chainIds,
    attestors,
    accounts: runtimeAccounts,
  }), true);

  const malformed = structuredClone(manifest);
  malformed.chains.A.chainId = "not-a-chain-id";
  assert.equal(deploymentManifestMatchesRuntime({
    manifest: malformed,
    fingerprint,
    chainIds,
    attestors,
    accounts: runtimeAccounts,
  }), false);
});
