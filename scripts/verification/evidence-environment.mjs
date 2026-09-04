import { createHash } from "node:crypto";
import { ethers } from "ethers";
import {
  matchesPinnedBesuClientVersion,
  validateLiveClientProofEvidence,
} from "./live-client-proof-evidence.mjs";

export const EVIDENCE_SECURITY_PROFILE_SCHEMA = "institutional-evidence-security-profile-v1";

const POLICY_ID = "institutional-evidence-environment-policy-v1";
const POLICY_SOURCE = "scripts/verification/evidence-environment.mjs";
const PINNED_BESU_IMAGE =
  "hyperledger/besu:26.8.1@sha256:6f3f21ce533383fcc8db3bce02252b59d5a9e776b72b5a1c8ecd2db011600042";
const EXPECTED_CHAIN_IDS = Object.freeze({ A: 41001, B: 41002 });
const REQUIRED_INTEGRATION_SCENARIOS = Object.freeze([
  "lockMint",
  "lending",
  "burnUnlock",
  "quorumOutage",
  "engineReloadRecovery",
]);
const REQUIRED_DEPLOYED_CONTRACTS = Object.freeze({
  A: Object.freeze([
    "checkpointClient",
    "gateway",
    "identityRegistry",
    "policyEngine",
    "canonicalToken",
    "escrowVault",
    "restitutionVault",
    "collateralApp",
    "governance",
  ]),
  B: Object.freeze([
    "checkpointClient",
    "gateway",
    "identityRegistry",
    "policyEngine",
    "voucherToken",
    "debtToken",
    "oracle",
    "lendingPool",
    "restitutionVault",
    "collateralApp",
    "governance",
  ]),
});

const HOST_ENVIRONMENT_ALLOWLIST = Object.freeze([
  "APPDATA",
  "COMSPEC",
  "ComSpec",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  // Docker Desktop discovers its Windows CLI plugins (including Compose)
  // beneath Program Files. Preserve only these location variables instead of
  // inheriting the broader host environment into evidence child processes.
  "ProgramFiles",
  "ProgramW6432",
  "SystemRoot",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERPROFILE",
  "WINDIR",
]);

const FIXED_MANAGED_ENVIRONMENT = Object.freeze({
  UNSAFE_LOCAL_DEMO: "false",
  BESU_ENABLE_ADMIN_DEBUG: "false",
  BESU_DOCKER_IMAGE: PINNED_BESU_IMAGE,
  BESU_NETWORK_ROOT: ".runtime/besu-qbft-evidence",
  BESU_COMPOSE_FILE: ".runtime/besu-qbft-evidence/docker-compose.yml",
  BESU_COMPOSE_PROJECT_NAME: "thesis-qbft-evidence",
  BESU_CONTAINER_PREFIX: "thesis-evidence",
  BESU_VALIDATOR_COUNT: "4",
  BESU_CHAIN_A_RPC_PORT: "18545",
  BESU_CHAIN_B_RPC_PORT: "19545",
  BESU_SUBNET_SECOND_OCTET: "31",
  BESU_QBFT_BLOCK_PERIOD_SECONDS: "2",
  BESU_QBFT_REQUEST_TIMEOUT_SECONDS: "10",
  BESU_BONSAI_HISTORICAL_BLOCK_LIMIT: "100000",
  BESU_BONSAI_TRIE_LOGS_PRUNING_WINDOW_SIZE: "120000",
  BESU_JAVA_OPTS: "-Xms128m -Xmx512m -XX:ActiveProcessorCount=2",
  BESU_HEALTH_PROGRESS_BLOCKS: "1",
  BESU_START_AUTO_RECOVER: "true",
  BESU_START_PROGRESS_TIMEOUT_MS: "60000",
  BESU_START_PROGRESS_BLOCKS: "1",
  RPC_WAIT_TIMEOUT_MS: "300000",
  CHAIN_A_RPC: "http://127.0.0.1:18545",
  CHAIN_B_RPC: "http://127.0.0.1:19545",
  USE_BESU_KEYS: "true",
  RUNTIME_MODE: "besu",
  PROOF_POLICY: "storage-required",
  INSTITUTIONAL_DEPLOYMENT_PATH: ".runtime/evidence/institutional-deployment.json",
  INSTITUTIONAL_ATTESTOR_SECRETS_PATH:
    ".runtime/besu-qbft-evidence/private/institutional-attestor-secrets.json",
  INSTITUTIONAL_INTEGRATION_REPORT_PATH: ".runtime/evidence/institutional-integration-report.json",
  INSTITUTIONAL_SECURITY_REPORT_PATH: ".runtime/evidence/security-scenarios.json",
  BESU_QBFT_FAULT_REPORT_PATH: ".runtime/evidence/besu-qbft-fault-report.json",
  INSTITUTIONAL_ENFORCE_BENCHMARK: "true",
  INSTITUTIONAL_FINALITY_DEPTH: "2",
  INSTITUTIONAL_MAX_CHECKPOINT_SUBMISSION_AGE_SECONDS: "604800",
  INSTITUTIONAL_MAX_CLOCK_DRIFT_SECONDS: "30",
  INSTITUTIONAL_GOVERNANCE_DELAY_SECONDS: "60",
  INSTITUTIONAL_DEPLOY_GAS_LIMIT: "10000000",
  INSTITUTIONAL_TX_GAS_LIMIT: "5000000",
  INSTITUTIONAL_TX_TIMEOUT_MS: "90000",
  INSTITUTIONAL_FLOW_TIMEOUT_MS: "180000",
});

const SAFE_TUNABLES = Object.freeze({
  BESU_HEALTH_TIMEOUT_MS: { fallback: 180_000, minimum: 10_000, maximum: 900_000 },
  BESU_FAULT_STOP_TIMEOUT_MS: { fallback: 90_000, minimum: 10_000, maximum: 900_000 },
  INSTITUTIONAL_BENCHMARK_MESSAGES: { fallback: 100, minimum: 100, maximum: 10_000 },
  INSTITUTIONAL_BENCHMARK_REQUIRED_SAMPLES: { fallback: 100, minimum: 100, maximum: 10_000 },
  INSTITUTIONAL_BENCHMARK_TARGET_P95_MS: { fallback: 45_000, minimum: 1, maximum: 45_000 },
});

const EXPLICIT_FALSE_KEYS = new Set(["UNSAFE_LOCAL_DEMO", "BESU_ENABLE_ADMIN_DEBUG"]);
const ALLOWED_CLI_FLAGS = new Set(["--allow-dirty", "--keep-running"]);
const PROCESS_INJECTION_ENVIRONMENT_KEYS = new Set([
  "BASH_ENV",
  "DYLD_INSERT_LIBRARIES",
  "ENV",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "NODE_PATH",
]);
const PROVENANCE_ALTERING_GIT_ENVIRONMENT_KEYS = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
]);
const PROVENANCE_ALTERING_DOCKER_ENVIRONMENT_KEYS = new Set([
  "DOCKER_API_VERSION",
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
]);

export function assertEvidenceCliArguments(argv) {
  const unknown = argv.filter((argument) => !ALLOWED_CLI_FLAGS.has(argument));
  if (unknown.length > 0) {
    throw new Error(`Unsupported institutional evidence flag(s): ${unknown.join(", ")}`);
  }
}

export function createEvidenceExecutionContext(sourceEnvironment = {}) {
  assertNoProcessInjectionEnvironment(sourceEnvironment);
  assertNoManagedProfileOverride(sourceEnvironment);

  const environment = {};
  for (const key of HOST_ENVIRONMENT_ALLOWLIST) {
    if (sourceEnvironment[key] != null) environment[key] = String(sourceEnvironment[key]);
  }
  Object.assign(environment, FIXED_MANAGED_ENVIRONMENT);

  for (const [key, constraints] of Object.entries(SAFE_TUNABLES)) {
    environment[key] = String(readBoundedInteger(sourceEnvironment[key], key, constraints));
  }

  const benchmarkMessages = Number(environment.INSTITUTIONAL_BENCHMARK_MESSAGES);
  const requiredSamples = Number(environment.INSTITUTIONAL_BENCHMARK_REQUIRED_SAMPLES);
  if (requiredSamples > benchmarkMessages) {
    throw new Error(
      "INSTITUTIONAL_BENCHMARK_REQUIRED_SAMPLES cannot exceed INSTITUTIONAL_BENCHMARK_MESSAGES",
    );
  }

  const effective = effectiveProfileFromEnvironment(environment);
  const securityProfile = createSecurityProfile(effective);
  assertEnvironmentMatchesEvidenceSecurityProfile(environment, securityProfile);
  return { environment: Object.freeze(environment), securityProfile: deepFreeze(securityProfile) };
}

export function validateEvidenceSecurityProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("Evidence security profile is missing or malformed");
  }
  if (profile.schema !== EVIDENCE_SECURITY_PROFILE_SCHEMA) {
    throw new Error(`Unsupported evidence security profile schema: ${profile.schema || "missing"}`);
  }
  if (
    profile.provenance?.policyId !== POLICY_ID ||
    profile.provenance?.source !== POLICY_SOURCE ||
    profile.provenance?.checksumAlgorithm !== "sha256"
  ) {
    throw new Error("Evidence security profile provenance is missing or untrusted");
  }
  if (!profile.effective || typeof profile.effective !== "object" || Array.isArray(profile.effective)) {
    throw new Error("Evidence security profile has no effective configuration");
  }

  const expectedChecksum = profileChecksum(profile.effective);
  if (profile.provenance.checksum !== expectedChecksum) {
    throw new Error("Evidence security profile checksum mismatch");
  }

  const effective = profile.effective;
  assertEqual(effective.environmentPolicy, "explicit-allowlist-v1", "environment policy");
  assertStringArrayEqual(
    effective.inheritedHostEnvironmentAllowlist,
    HOST_ENVIRONMENT_ALLOWLIST,
    "host environment allowlist",
  );
  assertEqual(effective.besu?.unsafeLocalDemo, false, "UNSAFE_LOCAL_DEMO");
  assertEqual(effective.besu?.adminDebugRpc, false, "BESU_ENABLE_ADMIN_DEBUG");
  assertEqual(effective.besu?.dockerImage, PINNED_BESU_IMAGE, "pinned Besu image");
  assertEqual(effective.besu?.networkRoot, FIXED_MANAGED_ENVIRONMENT.BESU_NETWORK_ROOT, "Besu network root");
  assertEqual(effective.besu?.validatorsPerChain, 4, "validator count");
  assertEqual(effective.besu?.consensus, "QBFT", "consensus profile");
  assertEqual(effective.besu?.toleratedFaultsPerChain, 1, "fault tolerance profile");
  assertEqual(effective.besu?.chainIds?.A, EXPECTED_CHAIN_IDS.A, "Bank A chain id");
  assertEqual(effective.besu?.chainIds?.B, EXPECTED_CHAIN_IDS.B, "Bank B chain id");
  assertEqual(effective.besu?.rpcExposure, "loopback-only", "RPC exposure");
  assertEqual(effective.besu?.rpc?.A, FIXED_MANAGED_ENVIRONMENT.CHAIN_A_RPC, "Bank A RPC");
  assertEqual(effective.besu?.rpc?.B, FIXED_MANAGED_ENVIRONMENT.CHAIN_B_RPC, "Bank B RPC");
  assertEqual(effective.runtime?.mode, "besu", "runtime mode");
  assertEqual(effective.runtime?.proofPolicy, "storage-required", "proof policy");
  assertEqual(effective.runtime?.useGeneratedBesuKeys, true, "Besu key policy");
  assertEqual(effective.protocol?.finalityDepth, 2, "finality depth");
  assertEqual(
    effective.protocol?.maxCheckpointSubmissionAgeSeconds,
    604_800,
    "maximum checkpoint submission age",
  );
  assertEqual(effective.protocol?.maxClockDriftSeconds, 30, "maximum clock drift");
  assertEqual(effective.protocol?.governanceDelaySeconds, 60, "governance delay");
  assertEqual(effective.benchmark?.enforced, true, "benchmark enforcement");
  assertBoundedInteger(effective.benchmark?.messages, "benchmark messages", 100, 10_000);
  assertBoundedInteger(effective.benchmark?.requiredSamples, "benchmark required samples", 100, 10_000);
  assertBoundedInteger(effective.benchmark?.targetP95Ms, "benchmark p95 target", 1, 45_000);
  assertBoundedInteger(effective.operationalTimeoutsMs?.health, "health timeout", 10_000, 900_000);
  assertBoundedInteger(
    effective.operationalTimeoutsMs?.validatorUnavailable,
    "validator unavailability timeout",
    10_000,
    900_000,
  );
  if (effective.benchmark.requiredSamples > effective.benchmark.messages) {
    throw new Error("Evidence security profile requires more benchmark samples than messages");
  }
  assertArtifactClassification(effective.artifacts);
  return profile;
}

export function assertEnvironmentMatchesEvidenceSecurityProfile(environment, profile) {
  validateEvidenceSecurityProfile(profile);
  const expectedManaged = managedEnvironmentFromEffectiveProfile(profile.effective);
  const allowedKeys = new Set([...HOST_ENVIRONMENT_ALLOWLIST, ...Object.keys(expectedManaged)]);
  const unexpectedKeys = Object.keys(environment).filter((key) => !allowedKeys.has(key));
  if (unexpectedKeys.length > 0) {
    throw new Error(`Evidence child environment contains non-allowlisted key(s): ${unexpectedKeys.join(", ")}`);
  }
  for (const [key, expected] of Object.entries(expectedManaged)) {
    if (environment[key] !== expected) {
      throw new Error(`Evidence child environment does not match its security profile for ${key}`);
    }
  }
  return true;
}

export function validateCollectedEvidenceSecurityProfile({ deployment, fault, integration }, profile) {
  validateEvidenceSecurityProfile(profile);
  const effective = profile.effective;
  assertEqual(deployment?.version, "institutional-deployment-v2", "deployment report version");
  assertEqual(deployment?.status, "ready", "deployment report status");
  const deploymentProfile = deployment?.securityProfile;
  if (!deploymentProfile) throw new Error("Evidence deployment has no security profile");
  assertEqual(deploymentProfile.governanceMode, "timelock-enforced", "deployed governance mode");
  assertEqual(Number(deploymentProfile.finalityDepth), effective.protocol.finalityDepth, "deployed finality depth");
  assertEqual(
    Number(deploymentProfile.maxCheckpointSubmissionAgeSeconds),
    effective.protocol.maxCheckpointSubmissionAgeSeconds,
    "deployed maximum checkpoint submission age",
  );
  assertEqual(
    Number(deploymentProfile.maxClockDriftSeconds),
    effective.protocol.maxClockDriftSeconds,
    "deployed maximum clock drift",
  );
  assertEqual(
    Number(deploymentProfile.governanceDelaySeconds),
    effective.protocol.governanceDelaySeconds,
    "deployed governance delay",
  );
  assertEqual(Number(deploymentProfile.attestorThreshold), 3, "attestor threshold");
  if (!Array.isArray(deploymentProfile.attestors) || deploymentProfile.attestors.length !== 4) {
    throw new Error("Evidence deployment must use exactly four attestors");
  }
  assertUniqueAddresses(deploymentProfile.attestors, 4, "deployment attestors");
  assertCompleteDeploymentChains(deployment, effective);

  assertEqual(
    fault?.version,
    "besu-qbft-validator-availability-report-v2",
    "validator availability report version",
  );
  assertEqual(fault?.status, "passed", "validator availability report status");
  assertEqual(
    fault?.testModel,
    "single-validator crash/unavailability; no Byzantine behavior is injected",
    "validator availability test model",
  );
  assertEqual(Number(fault?.validatorCount), effective.besu.validatorsPerChain, "availability-test validator count");
  assertEqual(Number(fault?.toleratedFaults), 1, "fault tolerance");
  assertCompleteValidatorAvailabilityEvidence(fault, effective.besu.validatorsPerChain);

  const benchmark = integration?.benchmark;
  assertEqual(integration?.version, "institutional-integration-report-v3", "integration report version");
  assertEqual(integration?.status, "passed", "integration report status");
  assertCompleteIntegrationEvidence(integration?.tests);
  assertIntegrationEnvironment(integration?.environment, effective);
  const liveClientProofValidation = validateLiveClientProofEvidence(integration?.liveClientProofValidation, {
    expectedChainIds: Object.values(effective.besu.chainIds).map(String),
    expectedBesuVersion: "26.8.1",
  });
  for (const observation of liveClientProofValidation.proofObservations) {
    const chainKey = String(observation.sourceChainId) === String(effective.besu.chainIds.A) ? "A" : "B";
    const expectedGateway = normalizeAddress(
      deployment.chains[chainKey].contracts.gateway.address,
      `Bank ${chainKey} gateway`,
    );
    const observedAccount = normalizeAddress(observation.account, `Bank ${chainKey} observed proof account`);
    if (observedAccount !== expectedGateway) {
      throw new Error(`Live proof observation for Bank ${chainKey} is not bound to the deployed gateway`);
    }
  }
  assertEqual(benchmark?.status, "passed", "benchmark status");
  assertEqual(benchmark?.requiredSamples, effective.benchmark.requiredSamples, "benchmark required samples");
  assertEqual(benchmark?.targetP95Ms, effective.benchmark.targetP95Ms, "benchmark p95 target");
  assertEqual(benchmark?.sampleCount, effective.benchmark.messages, "collected benchmark sample count");
  assertCompleteBenchmarkEvidence(benchmark, effective, integration.tests);
  return true;
}

function assertNoManagedProfileOverride(sourceEnvironment) {
  for (const [key, expected] of Object.entries(FIXED_MANAGED_ENVIRONMENT)) {
    if (sourceEnvironment[key] == null) continue;
    const actual = String(sourceEnvironment[key]);
    if (EXPLICIT_FALSE_KEYS.has(key)) {
      if (!isExplicitFalse(actual)) {
        throw new Error(`${key} must be absent or explicitly false for institutional evidence`);
      }
      continue;
    }
    if (actual !== expected) {
      throw new Error(`${key} is managed by the institutional evidence security profile and cannot be overridden`);
    }
  }

  if (sourceEnvironment.DEMO_BESU_VALIDATOR_COUNT != null) {
    throw new Error("DEMO_BESU_VALIDATOR_COUNT is not permitted for institutional evidence");
  }
}

function assertNoProcessInjectionEnvironment(sourceEnvironment) {
  const rejected = Object.keys(sourceEnvironment).filter(
    (key) =>
      PROCESS_INJECTION_ENVIRONMENT_KEYS.has(key) ||
      PROVENANCE_ALTERING_GIT_ENVIRONMENT_KEYS.has(key) ||
      key.startsWith("GIT_CONFIG_") ||
      PROVENANCE_ALTERING_DOCKER_ENVIRONMENT_KEYS.has(key),
  );
  if (rejected.length > 0) {
    throw new Error(
      `Institutional evidence rejects process-injection or provenance-altering environment key(s): ${rejected
        .sort()
        .join(", ")}`,
    );
  }
}

function createSecurityProfile(effective) {
  return {
    schema: EVIDENCE_SECURITY_PROFILE_SCHEMA,
    effective,
    provenance: {
      policyId: POLICY_ID,
      source: POLICY_SOURCE,
      checksumAlgorithm: "sha256",
      checksum: profileChecksum(effective),
    },
  };
}

function effectiveProfileFromEnvironment(environment) {
  return {
    environmentPolicy: "explicit-allowlist-v1",
    inheritedHostEnvironmentAllowlist: [...HOST_ENVIRONMENT_ALLOWLIST],
    besu: {
      unsafeLocalDemo: false,
      adminDebugRpc: false,
      dockerImage: environment.BESU_DOCKER_IMAGE,
      networkRoot: environment.BESU_NETWORK_ROOT,
      validatorsPerChain: Number(environment.BESU_VALIDATOR_COUNT),
      consensus: "QBFT",
      toleratedFaultsPerChain: 1,
      chainIds: { ...EXPECTED_CHAIN_IDS },
      rpcExposure: "loopback-only",
      rpc: { A: environment.CHAIN_A_RPC, B: environment.CHAIN_B_RPC },
    },
    runtime: {
      mode: environment.RUNTIME_MODE,
      proofPolicy: environment.PROOF_POLICY,
      useGeneratedBesuKeys: environment.USE_BESU_KEYS === "true",
    },
    protocol: {
      finalityDepth: Number(environment.INSTITUTIONAL_FINALITY_DEPTH),
      maxCheckpointSubmissionAgeSeconds: Number(
        environment.INSTITUTIONAL_MAX_CHECKPOINT_SUBMISSION_AGE_SECONDS,
      ),
      maxClockDriftSeconds: Number(environment.INSTITUTIONAL_MAX_CLOCK_DRIFT_SECONDS),
      governanceDelaySeconds: Number(environment.INSTITUTIONAL_GOVERNANCE_DELAY_SECONDS),
    },
    benchmark: {
      enforced: environment.INSTITUTIONAL_ENFORCE_BENCHMARK === "true",
      messages: Number(environment.INSTITUTIONAL_BENCHMARK_MESSAGES),
      requiredSamples: Number(environment.INSTITUTIONAL_BENCHMARK_REQUIRED_SAMPLES),
      targetP95Ms: Number(environment.INSTITUTIONAL_BENCHMARK_TARGET_P95_MS),
    },
    operationalTimeoutsMs: {
      health: Number(environment.BESU_HEALTH_TIMEOUT_MS),
      validatorUnavailable: Number(environment.BESU_FAULT_STOP_TIMEOUT_MS),
    },
    artifacts: {
      publicEvidenceRoot: ".runtime/evidence",
      publicEvidencePaths: [
        ".runtime/evidence/runtime-evidence-summary.json",
        environment.INSTITUTIONAL_DEPLOYMENT_PATH,
        environment.BESU_QBFT_FAULT_REPORT_PATH,
        environment.INSTITUTIONAL_INTEGRATION_REPORT_PATH,
        environment.INSTITUTIONAL_SECURITY_REPORT_PATH,
      ],
      privateRuntimeArtifacts: [
        {
          name: "institutional-attestor-secrets",
          path: environment.INSTITUTIONAL_ATTESTOR_SECRETS_PATH,
          classification: "secret",
          includedInEvidenceBundle: false,
        },
      ],
    },
  };
}

function managedEnvironmentFromEffectiveProfile(effective) {
  return {
    ...FIXED_MANAGED_ENVIRONMENT,
    BESU_HEALTH_TIMEOUT_MS: String(effective.operationalTimeoutsMs?.health),
    BESU_FAULT_STOP_TIMEOUT_MS: String(effective.operationalTimeoutsMs?.validatorUnavailable),
    INSTITUTIONAL_BENCHMARK_MESSAGES: String(effective.benchmark?.messages),
    INSTITUTIONAL_BENCHMARK_REQUIRED_SAMPLES: String(effective.benchmark?.requiredSamples),
    INSTITUTIONAL_BENCHMARK_TARGET_P95_MS: String(effective.benchmark?.targetP95Ms),
  };
}

function profileChecksum(effective) {
  const payload = {
    schema: EVIDENCE_SECURITY_PROFILE_SCHEMA,
    policyId: POLICY_ID,
    source: POLICY_SOURCE,
    effective,
  };
  return createHash("sha256").update(stableSerialize(payload)).digest("hex");
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function readBoundedInteger(raw, name, { fallback, minimum, maximum }) {
  const value = raw == null || raw === "" ? fallback : parseStrictInteger(raw, name);
  assertBoundedInteger(value, name, minimum, maximum);
  return value;
}

function parseStrictInteger(raw, name) {
  const text = String(raw);
  if (!/^(0|[1-9]\d*)$/.test(text)) throw new Error(`${name} must be a base-10 integer`);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} exceeds the safe integer range`);
  return value;
}

function assertBoundedInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}

function isExplicitFalse(value) {
  return ["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function assertEqual(actual, expected, name) {
  if (actual !== expected) throw new Error(`Evidence security profile mismatch for ${name}`);
}

function assertStringArrayEqual(actual, expected, name) {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(`Evidence security profile mismatch for ${name}`);
  }
}

function assertArtifactClassification(artifacts) {
  const expectedPublicPaths = [
    ".runtime/evidence/runtime-evidence-summary.json",
    FIXED_MANAGED_ENVIRONMENT.INSTITUTIONAL_DEPLOYMENT_PATH,
    FIXED_MANAGED_ENVIRONMENT.BESU_QBFT_FAULT_REPORT_PATH,
    FIXED_MANAGED_ENVIRONMENT.INSTITUTIONAL_INTEGRATION_REPORT_PATH,
    FIXED_MANAGED_ENVIRONMENT.INSTITUTIONAL_SECURITY_REPORT_PATH,
  ];
  assertEqual(artifacts?.publicEvidenceRoot, ".runtime/evidence", "public evidence root");
  assertStringArrayEqual(artifacts?.publicEvidencePaths, expectedPublicPaths, "public evidence path allowlist");
  if (!Array.isArray(artifacts?.privateRuntimeArtifacts) || artifacts.privateRuntimeArtifacts.length !== 1) {
    throw new Error("Evidence security profile mismatch for private runtime artifact classification");
  }
  const secret = artifacts.privateRuntimeArtifacts[0];
  assertEqual(secret?.name, "institutional-attestor-secrets", "private artifact name");
  assertEqual(
    secret?.path,
    FIXED_MANAGED_ENVIRONMENT.INSTITUTIONAL_ATTESTOR_SECRETS_PATH,
    "private artifact path",
  );
  assertEqual(secret?.classification, "secret", "private artifact classification");
  assertEqual(secret?.includedInEvidenceBundle, false, "private artifact evidence exclusion");
  if (artifacts.publicEvidencePaths.includes(secret.path) || secret.path.startsWith(`${artifacts.publicEvidenceRoot}/`)) {
    throw new Error("Secret runtime artifact must not be included in the public evidence root or allowlist");
  }
}

function assertCompleteDeploymentChains(deployment, effective) {
  if (typeof deployment.artifactFingerprint !== "string" || !ethers.isHexString(deployment.artifactFingerprint, 32)) {
    throw new Error("Evidence deployment has an invalid artifact fingerprint");
  }

  const accountAddresses = [];
  for (const chainKey of ["A", "B"]) {
    const chain = deployment.chains?.[chainKey];
    if (!chain || typeof chain !== "object") {
      throw new Error(`Evidence deployment is missing Bank ${chainKey}`);
    }
    assertEqual(Number(chain.chainId), effective.besu.chainIds[chainKey], `Bank ${chainKey} chain id`);
    assertEqual(chain.rpc, effective.besu.rpc[chainKey], `Bank ${chainKey} RPC`);
    if (chain.deploymentBlock == null) throw new Error(`Bank ${chainKey} deployment block is missing`);
    assertNonNegativeSafeInteger(chain.deploymentBlock, `Bank ${chainKey} deployment block`);

    const requiredContracts = REQUIRED_DEPLOYED_CONTRACTS[chainKey];
    const actualContracts = Object.keys(chain.contracts || {}).sort();
    assertStringArrayEqual(actualContracts, [...requiredContracts].sort(), `Bank ${chainKey} contract set`);
    const contractAddresses = [];
    for (const name of requiredContracts) {
      const entry = chain.contracts[name];
      contractAddresses.push(normalizeAddress(entry?.address, `Bank ${chainKey} ${name} address`));
      assertHex32(entry?.transactionHash, `Bank ${chainKey} ${name} deployment transaction`);
      if (entry?.deploymentBlock == null) {
        throw new Error(`Bank ${chainKey} ${name} deployment block is missing`);
      }
      assertNonNegativeSafeInteger(entry?.deploymentBlock, `Bank ${chainKey} ${name} deployment block`);
    }
    assertUniqueNormalizedValues(contractAddresses, `Bank ${chainKey} contract addresses`);

    const accounts = deployment.accounts?.[chainKey];
    for (const role of ["owner", "user", "relayer"]) {
      accountAddresses.push(normalizeAddress(accounts?.[role], `Bank ${chainKey} ${role} account`));
    }
  }
  assertUniqueNormalizedValues(accountAddresses, "deployment operator accounts");
}

function assertCompleteValidatorAvailabilityEvidence(fault, validatorCount) {
  const expectedNetworks = ["chainA", "chainB"];
  const validatorSets = new Map();
  const unavailablePhaseByNetwork = new Map();
  for (const [field, expectedPeers] of [["duringUnavailability", validatorCount - 2], ["afterRecovery", validatorCount - 1]]) {
    const snapshots = fault?.[field];
    if (!Array.isArray(snapshots) || snapshots.length !== expectedNetworks.length) {
      throw new Error(`Validator availability report must contain ${field} evidence for both chains`);
    }
    const networks = snapshots.map((snapshot) => snapshot?.key).sort();
    assertStringArrayEqual(networks, expectedNetworks, `${field} network coverage`);
    for (const snapshot of snapshots) {
      assertEqual(Number(snapshot.validatorCount), validatorCount, `${field} validator count`);
      if (!Array.isArray(snapshot.validators) || snapshot.validators.length !== validatorCount) {
        throw new Error(`Validator availability report ${field} has an incomplete validator set`);
      }
      const normalizedValidators = snapshot.validators.map((address, index) =>
        normalizeAddress(address, `${field} ${snapshot.key} validator ${index}`));
      assertUniqueNormalizedValues(normalizedValidators, `${field} ${snapshot.key} validator set`);
      const previousSet = validatorSets.get(snapshot.key);
      const canonicalSet = [...normalizedValidators].sort().join(",");
      if (previousSet !== undefined && previousSet !== canonicalSet) {
        throw new Error(`Validator availability report changes the ${snapshot.key} validator set across phases`);
      }
      validatorSets.set(snapshot.key, canonicalSet);
      assertEqual(Number(snapshot.chainId), EXPECTED_CHAIN_IDS[snapshot.key === "chainA" ? "A" : "B"], `${field} chain id`);
      if (!Number.isSafeInteger(snapshot.peerCount) || snapshot.peerCount !== expectedPeers) {
        throw new Error(
          `Validator availability report ${field} must report exactly ${expectedPeers} peer(s) per validator`,
        );
      }
      if (!Number.isInteger(snapshot.blocksProduced) || snapshot.blocksProduced < 1) {
        throw new Error(`Validator availability report ${field} does not prove block production`);
      }
      assertNonNegativeSafeInteger(snapshot.startBlock, `${field} start block`);
      assertNonNegativeSafeInteger(snapshot.blockNumber, `${field} block number`);
      if (snapshot.blockNumber < snapshot.startBlock + snapshot.blocksProduced) {
        throw new Error(`Validator availability report ${field} block delta is inconsistent`);
      }
      if (field === "duringUnavailability") {
        unavailablePhaseByNetwork.set(snapshot.key, snapshot);
      } else if (snapshot.startBlock !== unavailablePhaseByNetwork.get(snapshot.key)?.blockNumber) {
        throw new Error(`Validator availability report ${snapshot.key} recovery does not continue from the unavailability phase`);
      }
    }
  }

  if (!Array.isArray(fault?.validatorUnavailable) || fault.validatorUnavailable.length !== expectedNetworks.length) {
    throw new Error("Validator availability report must identify one unavailable validator per chain");
  }
  assertStringArrayEqual(
    fault.validatorUnavailable.map((entry) => entry?.network).sort(),
    expectedNetworks,
    "unavailable-validator network coverage",
  );
  const unavailableValidators = fault.validatorUnavailable.map((entry) => {
    const validator = normalizeAddress(entry?.validator, `${entry?.network} unavailable validator`);
    const expectedSet = validatorSets.get(entry?.network)?.split(",") || [];
    if (!expectedSet.includes(validator)) {
      throw new Error(`Unavailable validator for ${entry?.network} is not in the reported validator set`);
    }
    if (typeof entry?.container !== "string" || entry.container.length === 0) {
      throw new Error(`Unavailable validator for ${entry?.network} has no container identity`);
    }
    return validator;
  });
  assertUniqueNormalizedValues(unavailableValidators, "unavailable validator identities");
  assertUniqueNormalizedValues(
    fault.validatorUnavailable.map((entry) => entry.container),
    "unavailable validator containers",
  );
}

function assertCompleteIntegrationEvidence(tests) {
  const names = Object.keys(tests || {}).sort();
  assertStringArrayEqual(names, [...REQUIRED_INTEGRATION_SCENARIOS].sort(), "integration scenario set");
  for (const name of REQUIRED_INTEGRATION_SCENARIOS) {
    if (tests?.[name]?.status !== "passed") {
      throw new Error(`Integration evidence is missing required passed scenario: ${name}`);
    }
  }

  assertHex32(tests.lockMint.messageId, "lock-and-mint message id");
  assertHex32(tests.lockMint.sourceTransaction, "lock-and-mint source transaction");
  assertPositiveDecimalString(tests.lockMint.voucherDelta, "lock-and-mint voucher delta");
  assertHex32(tests.lending.depositTransaction, "lending deposit transaction");
  assertHex32(tests.lending.borrowTransaction, "lending borrow transaction");
  assertPositiveDecimalString(tests.lending.collateralAmount, "lending collateral amount");
  assertPositiveDecimalString(tests.lending.borrowedAmount, "lending borrowed amount");
  assertPositiveDecimalString(tests.lending.healthFactorE18, "lending health factor");
  if (BigInt(tests.lending.healthFactorE18) <= 10n ** 18n) {
    throw new Error("Lending scenario does not prove a healthy post-borrow position");
  }
  assertHex32(tests.burnUnlock.messageId, "burn-and-unlock message id");
  assertHex32(tests.burnUnlock.sourceTransaction, "burn-and-unlock source transaction");
  assertPositiveDecimalString(tests.burnUnlock.canonicalBalanceDelta, "burn-and-unlock canonical delta");
  assertNonNegativeSafeInteger(tests.burnUnlock.endToEndMs, "burn-and-unlock duration");
  assertHex32(tests.quorumOutage.messageId, "quorum-outage message id");
  assertEqual(Number(tests.quorumOutage.threshold), 3, "quorum-outage threshold");
  assertBoundedInteger(
    tests.quorumOutage.unavailableAttestors,
    "quorum-outage unavailable attestors",
    2,
    4,
  );
  assertEqual(String(tests.quorumOutage.destinationDeltaWithoutQuorum), "0", "quorum-outage blocked delta");
  assertPositiveDecimalString(
    tests.quorumOutage.destinationDeltaAfterRecovery,
    "quorum-outage recovery delta",
  );
  assertHex32(tests.engineReloadRecovery.messageId, "relay engine reload message id");
  assertEqual(
    tests.engineReloadRecovery.reloadState,
    "source_checkpointed",
    "relay engine reload persisted state",
  );
  assertPositiveDecimalString(tests.engineReloadRecovery.destinationDelta, "relay engine reload destination delta");
  assertEqual(
    String(tests.engineReloadRecovery.duplicateDeltaAfterRepeatedTicks),
    "0",
    "relay engine reload duplicate delta",
  );

  assertUniqueNormalizedValues(
    [
      tests.lockMint.messageId,
      tests.burnUnlock.messageId,
      tests.quorumOutage.messageId,
      tests.engineReloadRecovery.messageId,
    ].map((value) => value.toLowerCase()),
    "integration scenario message ids",
  );
}

function assertIntegrationEnvironment(environment, effective) {
  if (!environment || typeof environment !== "object") {
    throw new Error("Integration report has no environment evidence");
  }
  for (const [chainKey, field] of [["A", "chainA"], ["B", "chainB"]]) {
    assertEqual(Number(environment[field]?.chainId), effective.besu.chainIds[chainKey], `${field} chain id`);
    assertEqual(environment[field]?.rpc, effective.besu.rpc[chainKey], `${field} RPC`);
    assertNonNegativeSafeInteger(environment[field]?.blockNumber, `${field} block number`);
    assertBesuClientVersion(environment[field]?.clientVersion, `${field} client version`);
    const afterField = `${field}After`;
    assertEqual(Number(environment[afterField]?.chainId), effective.besu.chainIds[chainKey], `${afterField} chain id`);
    assertEqual(environment[afterField]?.rpc, effective.besu.rpc[chainKey], `${afterField} RPC`);
    assertNonNegativeSafeInteger(environment[afterField]?.blockNumber, `${afterField} block number`);
    assertBesuClientVersion(environment[afterField]?.clientVersion, `${afterField} client version`);
    assertEqual(
      environment[afterField]?.clientVersion,
      environment[field]?.clientVersion,
      `${field} stable client version`,
    );
    if (environment[afterField].blockNumber < environment[field].blockNumber) {
      throw new Error(`${afterField} block number regressed during integration evidence`);
    }
  }
  assertEqual(
    Number(environment.validatorTopology?.validatorCountPerChain),
    effective.besu.validatorsPerChain,
    "integration validator count",
  );
  assertEqual(
    Number(environment.validatorTopology?.toleratedFaults),
    effective.besu.toleratedFaultsPerChain,
    "integration tolerated faults",
  );
  assertEqual(environment.validatorTopology?.dockerImage, effective.besu.dockerImage, "integration Besu image");
  assertEqual(
    environment.validatorAvailabilityTest?.status,
    "passed",
    "integration validator availability status",
  );
}

function assertBesuClientVersion(value, label) {
  if (typeof value !== "string" || !matchesPinnedBesuClientVersion(value)) {
    throw new Error(`Evidence security profile mismatch for ${label}`);
  }
}

function assertCompleteBenchmarkEvidence(benchmark, effective, integrationTests) {
  if (!Array.isArray(benchmark.samples) || benchmark.samples.length !== benchmark.sampleCount) {
    throw new Error("Collected benchmark sample payload does not match its declared sample count");
  }

  const messageIds = new Set();
  const sourceTransactions = new Set();
  const relayTransactions = new Set();
  const durations = {
    sourceInclusion: [],
    postSourceInclusionToCompletion: [],
    endToEnd: [],
  };
  for (const [index, sample] of benchmark.samples.entries()) {
    if (!sample || typeof sample !== "object" || Array.isArray(sample)) {
      throw new Error(`Benchmark sample ${index} is malformed`);
    }
    assertEqual(sample.direction, "A-to-B", `benchmark sample ${index} direction`);
    assertEqual(sample.label, `benchmark-${index + 1}`, `benchmark sample ${index} label`);
    const messageId = assertHex32(sample.messageId, `benchmark sample ${index} message id`);
    const sourceTransaction = assertHex32(
      sample.sourceTransaction,
      `benchmark sample ${index} source transaction`,
    );
    if (messageIds.has(messageId)) throw new Error(`Benchmark sample ${index} repeats a message id`);
    if (sourceTransactions.has(sourceTransaction)) {
      throw new Error(`Benchmark sample ${index} repeats a source transaction`);
    }
    messageIds.add(messageId);
    sourceTransactions.add(sourceTransaction);
    assertPositiveDecimalString(sample.amount, `benchmark sample ${index} amount`);
    assertEqual(String(sample.destinationBalanceDelta), String(sample.amount), `benchmark sample ${index} balance delta`);
    assertNonNegativeSafeInteger(sample.sourceBlock, `benchmark sample ${index} source block`);
    if (typeof sample.sourceIncludedAt !== "string" || !Number.isFinite(Date.parse(sample.sourceIncludedAt))) {
      throw new Error(`Benchmark sample ${index} sourceIncludedAt is not an ISO timestamp`);
    }
    for (const field of ["sourceInclusionMs", "postSourceInclusionToCompletionMs", "endToEndMs"]) {
      assertNonNegativeSafeInteger(sample[field], `benchmark sample ${index} ${field}`);
    }
    if (sample.endToEndMs !== sample.sourceInclusionMs + sample.postSourceInclusionToCompletionMs) {
      throw new Error(`Benchmark sample ${index} duration components are inconsistent`);
    }
    assertEqual(String(sample.destinationChainId), String(EXPECTED_CHAIN_IDS.B), `benchmark sample ${index} destination chain`);
    assertHex32(sample.relayTransactions?.source, `benchmark sample ${index} relay source transaction`);
    assertEqual(
      sample.relayTransactions.source,
      sample.sourceTransaction,
      `benchmark sample ${index} relay/source transaction binding`,
    );
    const receiveTransaction = assertHex32(
      sample.relayTransactions?.receive,
      `benchmark sample ${index} receive transaction`,
    );
    const acknowledgementTransaction = assertHex32(
      sample.relayTransactions?.acknowledge,
      `benchmark sample ${index} acknowledgement transaction`,
    );
    for (const [kind, transactionHash] of [
      ["receive", receiveTransaction],
      ["acknowledgement", acknowledgementTransaction],
    ]) {
      if (sourceTransactions.has(transactionHash) || relayTransactions.has(transactionHash)) {
        throw new Error(`Benchmark sample ${index} repeats a ${kind} transaction`);
      }
      relayTransactions.add(transactionHash);
    }
    durations.sourceInclusion.push(sample.sourceInclusionMs);
    durations.postSourceInclusionToCompletion.push(sample.postSourceInclusionToCompletionMs);
    durations.endToEnd.push(sample.endToEndMs);
  }

  for (const values of Object.values(durations)) values.sort((left, right) => left - right);
  assertDurationSummary(benchmark.sourceInclusion, durations.sourceInclusion, "source inclusion");
  assertDurationSummary(
    benchmark.postSourceInclusionToCompletion,
    durations.postSourceInclusionToCompletion,
    "post-source-inclusion to completion",
  );
  assertDurationSummary(benchmark.endToEnd, durations.endToEnd, "end-to-end");
  const firstSample = benchmark.samples[0];
  assertEqual(integrationTests.lockMint.messageId, firstSample.messageId, "lock-and-mint benchmark message binding");
  assertEqual(
    integrationTests.lockMint.sourceTransaction,
    firstSample.sourceTransaction,
    "lock-and-mint benchmark source transaction binding",
  );
  assertEqual(
    String(integrationTests.lockMint.voucherDelta),
    String(firstSample.destinationBalanceDelta),
    "lock-and-mint benchmark balance binding",
  );
  if (
    benchmark.postSourceInclusionToCompletion.p95Ms < 0
    || benchmark.postSourceInclusionToCompletion.p95Ms > effective.benchmark.targetP95Ms
  ) {
    throw new Error("Collected benchmark p95 does not satisfy the effective security profile");
  }
}

function assertDurationSummary(actual, sortedValues, label) {
  if (!actual || typeof actual !== "object" || sortedValues.length === 0) {
    throw new Error(`Benchmark ${label} summary is missing`);
  }
  const expected = {
    minMs: sortedValues[0],
    maxMs: sortedValues.at(-1),
    meanMs: Math.round(sortedValues.reduce((sum, value) => sum + value, 0) / sortedValues.length),
    p50Ms: percentile(sortedValues, 0.5),
    p95Ms: percentile(sortedValues, 0.95),
  };
  for (const [field, value] of Object.entries(expected)) {
    assertEqual(actual[field], value, `benchmark ${label} ${field}`);
  }
}

function percentile(sortedValues, quantile) {
  return sortedValues[Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * quantile) - 1)];
}

function assertUniqueAddresses(addresses, expectedCount, label) {
  if (!Array.isArray(addresses) || addresses.length !== expectedCount) {
    throw new Error(`${label} must contain exactly ${expectedCount} addresses`);
  }
  assertUniqueNormalizedValues(
    addresses.map((address, index) => normalizeAddress(address, `${label}[${index}]`)),
    label,
  );
}

function normalizeAddress(value, label) {
  try {
    return ethers.getAddress(value).toLowerCase();
  } catch {
    throw new Error(`${label} is not a valid address`);
  }
}

function assertUniqueNormalizedValues(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate identities`);
}

function assertHex32(value, label) {
  if (typeof value !== "string" || !ethers.isHexString(value, 32)) {
    throw new Error(`${label} must be a 32-byte hex value`);
  }
  return value.toLowerCase();
}

function assertPositiveDecimalString(value, label) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new Error(`${label} must be a positive decimal integer string`);
  }
}

function assertNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}
