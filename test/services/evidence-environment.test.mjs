import assert from "node:assert/strict";
import test from "node:test";
import { collectRepositoryProvenance } from "../../scripts/verification/provenance.mjs";
import { createPassingEvidenceReports } from "../fixtures/evidence-reports.mjs";
import {
  assertEnvironmentMatchesEvidenceSecurityProfile,
  assertEvidenceCliArguments,
  createEvidenceExecutionContext,
  validateCollectedEvidenceSecurityProfile,
  validateEvidenceSecurityProfile,
} from "../../scripts/verification/evidence-environment.mjs";

test("builds a fail-closed allowlisted child environment and a verifiable profile", () => {
  const first = createEvidenceExecutionContext({
    PATH: "/usr/bin",
    HOME: "/safe-home",
    ProgramFiles: "C:\\Program Files",
    ProgramW6432: "C:\\Program Files",
    SECRET_SHOULD_NOT_LEAK: "secret",
  });
  const second = createEvidenceExecutionContext({ PATH: "/different/bin", UNRELATED: "value" });

  assert.equal(first.environment.PATH, "/usr/bin");
  assert.equal(first.environment.HOME, "/safe-home");
  assert.equal(first.environment.ProgramFiles, "C:\\Program Files");
  assert.equal(first.environment.ProgramW6432, "C:\\Program Files");
  assert.equal(first.environment.SECRET_SHOULD_NOT_LEAK, undefined);
  assert.equal(first.environment.UNSAFE_LOCAL_DEMO, "false");
  assert.equal(first.environment.BESU_ENABLE_ADMIN_DEBUG, "false");
  assert.equal(first.environment.RUNTIME_MODE, "besu");
  assert.equal(first.environment.PROOF_POLICY, "storage-required");
  assert.match(first.environment.BESU_DOCKER_IMAGE, /@sha256:[a-f0-9]{64}$/);
  assert.match(first.environment.INSTITUTIONAL_ATTESTOR_SECRETS_PATH, /\/private\//);
  assert.doesNotMatch(first.environment.INSTITUTIONAL_ATTESTOR_SECRETS_PATH, /^\.runtime\/evidence\//);
  const [secretArtifact] = first.securityProfile.effective.artifacts.privateRuntimeArtifacts;
  assert.equal(secretArtifact.classification, "secret");
  assert.equal(secretArtifact.includedInEvidenceBundle, false);
  assert.equal(
    first.securityProfile.effective.artifacts.publicEvidencePaths.includes(secretArtifact.path),
    false,
  );
  assert.equal(first.securityProfile.provenance.checksum, second.securityProfile.provenance.checksum);
  assert.equal(first.securityProfile.provenance.checksum.length, 64);
  assert.equal(Object.isFrozen(first.environment), true);
  assert.equal(Object.isFrozen(first.securityProfile.effective), true);
  assert.doesNotThrow(() => validateEvidenceSecurityProfile(first.securityProfile));
  assert.doesNotThrow(() =>
    assertEnvironmentMatchesEvidenceSecurityProfile(first.environment, first.securityProfile),
  );
});

test("rejects process injection and provenance-altering parent environments", () => {
  for (const [key, value] of [
    ["NODE_OPTIONS", "--import=/tmp/untrusted.mjs"],
    ["NODE_PATH", "/tmp/untrusted-modules"],
    ["LD_PRELOAD", "/tmp/untrusted.so"],
    ["GIT_DIR", "/tmp/other-repository/.git"],
    ["GIT_CONFIG_COUNT", "1"],
    ["DOCKER_HOST", "tcp://remote.example:2375"],
  ]) {
    assert.throws(
      () => createEvidenceExecutionContext({ [key]: value }),
      new RegExp(`provenance-altering environment key\\(s\\): ${key}`),
    );
  }
});

test("passes the same allowlisted environment to every provenance subprocess", async () => {
  const environment = createEvidenceExecutionContext({ PATH: process.env.PATH }).environment;
  const calls = [];
  const outputs = new Map([
    ["git rev-parse HEAD", "0123456789abcdef0123456789abcdef01234567"],
    ["git status --porcelain=v1 --untracked-files=all", ""],
    ["git ls-files -v", "H README.md"],
    ["git diff --no-ext-diff --name-only HEAD --", ""],
    ["npm --version", "10.0.0"],
    ["npm.cmd --version", "10.0.0"],
    ["docker --version", "Docker version 27.0.0"],
  ]);
  const provenance = await collectRepositoryProvenance(environment, {
    runCommand: async (command, args, receivedEnvironment) => {
      calls.push({ command, args, receivedEnvironment });
      return outputs.get([command, ...args].join(" ")) ?? "";
    },
  });

  assert.equal(calls.length, 6);
  assert.equal(calls.every((call) => call.receivedEnvironment === environment), true);
  assert.equal(calls.some((call) => call.receivedEnvironment === process.env), false);
  assert.equal(provenance.git.commit, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(provenance.git.dirty, false);
});

test("rejects unsafe Besu switches instead of silently overriding them", () => {
  for (const [key, value] of [
    ["UNSAFE_LOCAL_DEMO", "true"],
    ["UNSAFE_LOCAL_DEMO", "1"],
    ["BESU_ENABLE_ADMIN_DEBUG", "yes"],
    ["BESU_ENABLE_ADMIN_DEBUG", "on"],
  ]) {
    assert.throws(() => createEvidenceExecutionContext({ [key]: value }), new RegExp(key));
  }

  const accepted = createEvidenceExecutionContext({
    UNSAFE_LOCAL_DEMO: "OFF",
    BESU_ENABLE_ADMIN_DEBUG: "0",
  });
  assert.equal(accepted.environment.UNSAFE_LOCAL_DEMO, "false");
  assert.equal(accepted.environment.BESU_ENABLE_ADMIN_DEBUG, "false");
});

test("rejects attempts to replace a managed evidence profile", () => {
  for (const [key, value] of [
    ["BESU_VALIDATOR_COUNT", "3"],
    ["BESU_DOCKER_IMAGE", "hyperledger/besu:latest"],
    ["BESU_NETWORK_ROOT", ".runtime/other"],
    ["CHAIN_A_RPC", "http://0.0.0.0:8545"],
    ["RUNTIME_MODE", "mock"],
    ["PROOF_POLICY", "fallback-allowed"],
    ["INSTITUTIONAL_ENFORCE_BENCHMARK", "false"],
    ["INSTITUTIONAL_GOVERNANCE_DELAY_SECONDS", "0"],
    ["DEMO_BESU_VALIDATOR_COUNT", "4"],
  ]) {
    assert.throws(() => createEvidenceExecutionContext({ [key]: value }), new RegExp(key));
  }
});

test("allows only bounded benchmark and timeout tuning", () => {
  const { environment, securityProfile } = createEvidenceExecutionContext({
    BESU_HEALTH_TIMEOUT_MS: "240000",
    BESU_FAULT_STOP_TIMEOUT_MS: "120000",
    INSTITUTIONAL_BENCHMARK_MESSAGES: "150",
    INSTITUTIONAL_BENCHMARK_REQUIRED_SAMPLES: "120",
    INSTITUTIONAL_BENCHMARK_TARGET_P95_MS: "40000",
  });
  assert.equal(environment.INSTITUTIONAL_BENCHMARK_MESSAGES, "150");
  assert.deepEqual(securityProfile.effective.benchmark, {
    enforced: true,
    messages: 150,
    requiredSamples: 120,
    targetP95Ms: 40000,
  });

  for (const unsafeEnvironment of [
    { INSTITUTIONAL_BENCHMARK_MESSAGES: "99" },
    { INSTITUTIONAL_BENCHMARK_REQUIRED_SAMPLES: "99" },
    { INSTITUTIONAL_BENCHMARK_TARGET_P95_MS: "45001" },
    { INSTITUTIONAL_BENCHMARK_MESSAGES: "100", INSTITUTIONAL_BENCHMARK_REQUIRED_SAMPLES: "101" },
    { BESU_HEALTH_TIMEOUT_MS: "Infinity" },
  ]) {
    assert.throws(() => createEvidenceExecutionContext(unsafeEnvironment));
  }
});

test("rejects unknown CLI flags before an evidence run can start", () => {
  assert.doesNotThrow(() =>
    assertEvidenceCliArguments(["--allow-dirty", "--keep-running"]),
  );
  assert.throws(
    () => assertEvidenceCliArguments(["--unsafe-local-demo"]),
    /Unsupported institutional evidence flag/,
  );
  assert.throws(() => assertEvidenceCliArguments(["--force"]), /Unsupported institutional evidence flag/);
  assert.throws(
    () => assertEvidenceCliArguments(["--summarize-existing"]),
    /Unsupported institutional evidence flag/,
  );
});

test("detects profile, provenance and effective-environment tampering", () => {
  const { environment, securityProfile } = createEvidenceExecutionContext({});

  const changedProfile = structuredClone(securityProfile);
  changedProfile.effective.besu.unsafeLocalDemo = true;
  assert.throws(() => validateEvidenceSecurityProfile(changedProfile), /checksum mismatch/);

  const changedProvenance = structuredClone(securityProfile);
  changedProvenance.provenance.source = "untrusted-runner.mjs";
  assert.throws(() => validateEvidenceSecurityProfile(changedProvenance), /provenance/);

  const contaminatedEnvironment = { ...environment, NODE_OPTIONS: "--import=/tmp/untrusted.mjs" };
  assert.throws(
    () => assertEnvironmentMatchesEvidenceSecurityProfile(contaminatedEnvironment, securityProfile),
    /non-allowlisted key/,
  );

  const weakenedEnvironment = { ...environment, UNSAFE_LOCAL_DEMO: "true" };
  assert.throws(
    () => assertEnvironmentMatchesEvidenceSecurityProfile(weakenedEnvironment, securityProfile),
    /UNSAFE_LOCAL_DEMO/,
  );
});

test("collected reports must match the effective profile instead of status strings alone", () => {
  const profile = createEvidenceExecutionContext({}).securityProfile;
  const reports = createPassingEvidenceReports(profile);
  assert.doesNotThrow(() => validateCollectedEvidenceSecurityProfile(reports, profile));

  const legacyIntegrationSchema = structuredClone(reports);
  legacyIntegrationSchema.integration.version = "institutional-integration-report-v2";
  assert.throws(
    () => validateCollectedEvidenceSecurityProfile(legacyIntegrationSchema, profile),
    /integration report version/,
  );

  const missingLiveProofEvidence = structuredClone(reports);
  delete missingLiveProofEvidence.integration.liveClientProofValidation;
  assert.throws(
    () => validateCollectedEvidenceSecurityProfile(missingLiveProofEvidence, profile),
    /Live client proof evidence/,
  );

  const wrongLiveClient = structuredClone(reports);
  wrongLiveClient.integration.liveClientProofValidation.clients[0].clientVersion = "geth/v1.15.0";
  assert.throws(
    () => validateCollectedEvidenceSecurityProfile(wrongLiveClient, profile),
    /Live Besu client version/,
  );

  const tamperedLiveProof = structuredClone(reports);
  tamperedLiveProof.integration.liveClientProofValidation.proofObservations[0].storageProof[0] = "0xc199";
  assert.throws(
    () => validateCollectedEvidenceSecurityProfile(tamperedLiveProof, profile),
    /digest mismatch/,
  );

  const unboundLiveProofAccount = structuredClone(reports);
  unboundLiveProofAccount.deployment.chains.A.contracts.gateway.address = `0x${"f".repeat(40)}`;
  assert.throws(
    () => validateCollectedEvidenceSecurityProfile(unboundLiveProofAccount, profile),
    /not bound to the deployed gateway/,
  );

  const legacyAvailabilitySchema = structuredClone(reports);
  legacyAvailabilitySchema.fault.version = "besu-qbft-fault-report-v1";
  assert.throws(
    () => validateCollectedEvidenceSecurityProfile(legacyAvailabilitySchema, profile),
    /validator availability report version/,
  );

  const weakTopology = structuredClone(reports);
  weakTopology.fault.validatorCount = 3;
  assert.throws(
    () => validateCollectedEvidenceSecurityProfile(weakTopology, profile),
    /availability-test validator count/,
  );

  const looseBenchmark = structuredClone(reports);
  looseBenchmark.integration.benchmark.targetP95Ms = 90_000;
  assert.throws(
    () => validateCollectedEvidenceSecurityProfile(looseBenchmark, profile),
    /benchmark p95 target/,
  );

  const missingSamples = structuredClone(reports);
  missingSamples.integration.benchmark.samples.pop();
  assert.throws(
    () => validateCollectedEvidenceSecurityProfile(missingSamples, profile),
    /sample payload/,
  );

  const missingScenario = structuredClone(reports);
  delete missingScenario.integration.tests.engineReloadRecovery;
  assert.throws(
    () => validateCollectedEvidenceSecurityProfile(missingScenario, profile),
    /integration scenario set/,
  );

  const incompleteFaultEvidence = structuredClone(reports);
  incompleteFaultEvidence.fault.afterRecovery.pop();
  assert.throws(
    () => validateCollectedEvidenceSecurityProfile(incompleteFaultEvidence, profile),
    /afterRecovery evidence for both chains/,
  );

  const duplicateAttestors = structuredClone(reports);
  duplicateAttestors.deployment.securityProfile.attestors[3] =
    duplicateAttestors.deployment.securityProfile.attestors[0];
  assert.throws(
    () => validateCollectedEvidenceSecurityProfile(duplicateAttestors, profile),
    /deployment attestors contains duplicate identities/,
  );

  const duplicateValidators = structuredClone(reports);
  duplicateValidators.fault.duringUnavailability[0].validators[3] =
    duplicateValidators.fault.duringUnavailability[0].validators[0];
  assert.throws(
    () => validateCollectedEvidenceSecurityProfile(duplicateValidators, profile),
    /validator set contains duplicate identities/,
  );

  const emptySamples = structuredClone(reports);
  emptySamples.integration.benchmark.samples = Array.from(
    { length: profile.effective.benchmark.messages },
    () => ({}),
  );
  assert.throws(
    () => validateCollectedEvidenceSecurityProfile(emptySamples, profile),
    /direction|malformed/,
  );

  const duplicateMessages = structuredClone(reports);
  duplicateMessages.integration.benchmark.samples[1].messageId =
    duplicateMessages.integration.benchmark.samples[0].messageId;
  assert.throws(
    () => validateCollectedEvidenceSecurityProfile(duplicateMessages, profile),
    /repeats a message id/,
  );

  const duplicateRelayTransactions = structuredClone(reports);
  duplicateRelayTransactions.integration.benchmark.samples[1].relayTransactions.receive =
    duplicateRelayTransactions.integration.benchmark.samples[0].relayTransactions.receive;
  assert.throws(
    () => validateCollectedEvidenceSecurityProfile(duplicateRelayTransactions, profile),
    /repeats a receive transaction/,
  );

  const unboundLockMint = structuredClone(reports);
  unboundLockMint.integration.tests.lockMint.messageId = "0x" + "f".repeat(64);
  assert.throws(
    () => validateCollectedEvidenceSecurityProfile(unboundLockMint, profile),
    /lock-and-mint benchmark message binding/,
  );

  const missingQuorumRecovery = structuredClone(reports);
  delete missingQuorumRecovery.integration.tests.quorumOutage.destinationDeltaAfterRecovery;
  assert.throws(
    () => validateCollectedEvidenceSecurityProfile(missingQuorumRecovery, profile),
    /quorum-outage recovery delta/,
  );

  const missingFinalEnvironment = structuredClone(reports);
  delete missingFinalEnvironment.integration.environment.chainAAfter;
  assert.throws(
    () => validateCollectedEvidenceSecurityProfile(missingFinalEnvironment, profile),
    /chainAAfter chain id/,
  );

  const negativeP95 = structuredClone(reports);
  negativeP95.integration.benchmark.postSourceInclusionToCompletion.p95Ms = -999;
  assert.throws(
    () => validateCollectedEvidenceSecurityProfile(negativeP95, profile),
    /benchmark post-source-inclusion to completion p95Ms/,
  );

  const missingDeployment = structuredClone(reports);
  delete missingDeployment.deployment.chains.B.contracts.gateway;
  assert.throws(
    () => validateCollectedEvidenceSecurityProfile(missingDeployment, profile),
    /Bank B contract set/,
  );

  for (const unavailableAttestors of [undefined, "2", 1, 5]) {
    const invalidQuorumOutage = structuredClone(reports);
    invalidQuorumOutage.integration.tests.quorumOutage.unavailableAttestors = unavailableAttestors;
    assert.throws(
      () => validateCollectedEvidenceSecurityProfile(invalidQuorumOutage, profile),
      /quorum-outage unavailable attestors must be an integer between 2 and 4/,
    );
  }

  const nullChainDeploymentBlock = structuredClone(reports);
  nullChainDeploymentBlock.deployment.chains.A.deploymentBlock = null;
  assert.throws(
    () => validateCollectedEvidenceSecurityProfile(nullChainDeploymentBlock, profile),
    /Bank A deployment block/,
  );

  const coercedChainDeploymentBlock = structuredClone(reports);
  coercedChainDeploymentBlock.deployment.chains.A.deploymentBlock = "10";
  assert.throws(
    () => validateCollectedEvidenceSecurityProfile(coercedChainDeploymentBlock, profile),
    /Bank A deployment block must be a non-negative safe integer/,
  );

  const nullContractDeploymentBlock = structuredClone(reports);
  nullContractDeploymentBlock.deployment.chains.B.contracts.gateway.deploymentBlock = null;
  assert.throws(
    () => validateCollectedEvidenceSecurityProfile(nullContractDeploymentBlock, profile),
    /Bank B gateway deployment block/,
  );

  const coercedContractDeploymentBlock = structuredClone(reports);
  coercedContractDeploymentBlock.deployment.chains.B.contracts.gateway.deploymentBlock = "10";
  assert.throws(
    () => validateCollectedEvidenceSecurityProfile(coercedContractDeploymentBlock, profile),
    /Bank B gateway deployment block must be a non-negative safe integer/,
  );

  const inflatedDuringFaultPeers = structuredClone(reports);
  inflatedDuringFaultPeers.fault.duringUnavailability[0].peerCount = 3;
  assert.throws(
    () => validateCollectedEvidenceSecurityProfile(inflatedDuringFaultPeers, profile),
    /duringUnavailability must report exactly 2 peer\(s\)/,
  );

  const incompleteRecoveryPeers = structuredClone(reports);
  incompleteRecoveryPeers.fault.afterRecovery[0].peerCount = 2;
  assert.throws(
    () => validateCollectedEvidenceSecurityProfile(incompleteRecoveryPeers, profile),
    /afterRecovery must report exactly 3 peer\(s\)/,
  );

  const discontinuousRecovery = structuredClone(reports);
  discontinuousRecovery.fault.afterRecovery[0].startBlock += 1;
  discontinuousRecovery.fault.afterRecovery[0].blockNumber += 1;
  assert.throws(
    () => validateCollectedEvidenceSecurityProfile(discontinuousRecovery, profile),
    /recovery does not continue from the unavailability phase/,
  );
});
