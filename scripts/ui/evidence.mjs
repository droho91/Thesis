import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  validateCollectedEvidenceSecurityProfile,
  validateEvidenceSecurityProfile,
} from "../verification/evidence-environment.mjs";
import {
  assertRepositoryProvenanceStable,
  unsafeGitIndexEntries,
} from "../verification/provenance.mjs";
import { resolveSafeEvidencePaths } from "../verification/safe-evidence-paths.mjs";
import { validateSecurityScenarioReport } from "../verification/security-scenario-results.mjs";
import { SCENARIOS as EXPECTED_SECURITY_SCENARIOS } from "../verification/security-scenarios.mjs";

const PUBLIC_EVIDENCE_FILES = Object.freeze({
  summary: "runtime-evidence-summary.json",
  security: "security-scenarios.json",
  integration: "institutional-integration-report.json",
  fault: "besu-qbft-fault-report.json",
  deployment: "institutional-deployment.json",
});
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const EVIDENCE_VALIDATOR_RUNTIME_SCHEMA = "institutional-evidence-validator-runtime-v1";
const REPOSITORY_ENVIRONMENT_ALLOWLIST = Object.freeze([
  "APPDATA", "COMSPEC", "ComSpec", "HOME", "LANG", "LC_ALL", "LOCALAPPDATA", "PATH",
  "PATHEXT", "SystemRoot", "SYSTEMROOT", "TEMP", "TERM", "TMP", "TMPDIR", "TZ",
  "USERPROFILE", "WINDIR",
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

const INTEGRATION_LABELS = Object.freeze({
  lockMint: "Lock and mint",
  lending: "Policy-controlled lending",
  burnUnlock: "Burn and unlock",
  quorumOutage: "Attestor quorum outage",
  engineReloadRecovery: "Relay engine reload recovery",
});

export async function formalEvidencePayload({
  validatorRepositoryAtLoad,
  validatorLoadedAt,
} = {}) {
  const repository = await repositoryStateForEvidence();
  // Only the long-lived UI service supplies an at-load snapshot. Short-lived
  // verifier/doctor processes already execute the current modules and should
  // report source applicability, not an unrelated UI restart instruction.
  const loadedRepository = validatorRepositoryAtLoad === undefined
    ? null
    : await Promise.resolve(validatorRepositoryAtLoad);
  const validatorRuntime = loadedRepository === null
    ? null
    : evaluateEvidenceValidatorRuntime({
      loadedRepository: loadedRepository || {},
      currentRepository: repository,
      loadedAt: validatorLoadedAt,
    });
  let managedPaths;
  try {
    managedPaths = await resolveSafeEvidencePaths();
  } catch (error) {
    return rejectedEvidencePayload(
      `Unsafe evidence path configuration: ${error?.message || String(error)}`,
      repository,
      validatorRuntime,
    );
  }

  if (await evidenceLocksPresent(managedPaths)) {
    return rejectedEvidencePayload("An evidence writer lock is active or orphaned.", repository, validatorRuntime);
  }

  const [
    summaryReport,
    securityReport,
    integrationReport,
    faultReport,
    deploymentReport,
    securityValidationContext,
    publicEvidenceBundleClean,
  ] = await Promise.all([
    readEvidenceReport(resolve(managedPaths.evidenceRoot, PUBLIC_EVIDENCE_FILES.summary)),
    readEvidenceReport(resolve(managedPaths.evidenceRoot, PUBLIC_EVIDENCE_FILES.security)),
    readEvidenceReport(resolve(managedPaths.evidenceRoot, PUBLIC_EVIDENCE_FILES.integration)),
    readEvidenceReport(resolve(managedPaths.evidenceRoot, PUBLIC_EVIDENCE_FILES.fault)),
    readEvidenceReport(resolve(managedPaths.evidenceRoot, PUBLIC_EVIDENCE_FILES.deployment)),
    currentSecurityValidationContext(),
    hasExactPublicEvidenceFiles(managedPaths.evidenceRoot),
  ]);
  const evidenceRunLockPresent = await evidenceLocksPresent(managedPaths);
  if (!summaryReport) {
    return {
      available: false,
      status: "missing",
      reportStatus: "missing",
      applicableToCurrentSource: false,
      applicabilityReason: "report-missing",
      message: "No validation evidence report is available. Run npm run institutional:evidence.",
      repository,
      validatorRuntime,
    };
  }
  return summarizeFormalEvidence({
    summary: summaryReport.data,
    security: securityReport?.data,
    integration: integrationReport?.data,
    fault: faultReport?.data,
    deployment: deploymentReport?.data,
    repository,
    validatorRuntime,
    securityValidationContext,
    evidenceRunLockPresent,
    publicEvidenceBundleClean,
    reportDigests: {
      security: securityReport?.sha256,
      integration: integrationReport?.sha256,
      fault: faultReport?.sha256,
      deployment: deploymentReport?.sha256,
    },
  });
}

export function summarizeFormalEvidence({
  summary,
  security,
  integration,
  fault,
  deployment,
  repository = {},
  validatorRuntime = null,
  reportDigests = {},
  securityValidationContext = null,
  evidenceRunLockPresent = false,
  publicEvidenceBundleClean = true,
}) {
  const recordedCommit = summary.provenance?.git?.commit || null;
  const securityScenarios = security?.scenarios || summary.evidence?.securityScenarios || [];
  const integrationTests = integration?.tests || summary.evidence?.integrationTests || {};
  const benchmark = integration?.benchmark || summary.evidence?.benchmark || {};
  const liveClientProofValidation = integration?.liveClientProofValidation
    || summary.evidence?.liveClientProofValidation
    || {};
  const securityPassed = securityScenarios.filter((scenario) => scenario.status === "passed").length;
  const integrationEntries = Object.entries(integrationTests).map(([id, test]) => ({
    id,
    title: INTEGRATION_LABELS[id] || humanize(id),
    status: test?.status || "unknown",
  }));
  const integrationPassed = integrationEntries.filter((test) => test.status === "passed").length;
  const expectedDigests = summary.evidence?.reportChecksums || {};
  const checksumKeys = ["deployment", "fault", "integration", "security"];
  const reportChecksumsMatch = checksumKeys.every((key) => (
    typeof expectedDigests[key] === "string"
      && expectedDigests[key] === reportDigests[key]
  ));
  const verifiedReportKeys = checksumKeys.filter((key) => (
    typeof expectedDigests[key] === "string"
      && expectedDigests[key] === reportDigests[key]
  ));
  const securityProfileValid = hasValidEvidenceSecurityProfile(summary);
  const securityReportValid = hasValidSecurityScenarioReport(security, securityValidationContext);
  const componentReportsValid = hasValidCollectedEvidenceReports({
    deployment,
    fault,
    integration,
  }, summary.securityProfile);
  const deployedBytecodeValid = hasValidDeployedBytecodeEvidence(
    summary.evidence?.deployedBytecode,
    deployment,
  );
  const provenanceStable = hasStableRunProvenance(summary);
  const exclusiveRunComplete = evidenceRunLockPresent === false;
  const publicEvidenceBundleValid = publicEvidenceBundleClean === true;
  const recordedDirty = summary.provenance?.git?.dirty;
  const sourceApplicability = evaluateSourceApplicability({
    recordedCommit,
    recordedDirty,
    currentCommit: repository.commit,
    currentDirty: repository.dirty,
  });
  // Keep named gates in the public payload so the UI can distinguish a failed
  // report from an out-of-date validator process and explain the exact cause.
  const reportGates = [
    ["summary-schema", summary.version === "institutional-runtime-evidence-v4"],
    ["summary-status", summary.status === "passed"],
    ["formal-evidence-eligible", summary.formalEvidenceEligible === true],
    ["recorded-source-clean", recordedDirty === false],
    ["security-profile", securityProfileValid],
    ["security-report", securityReportValid],
    ["component-reports", componentReportsValid],
    ["deployed-bytecode", deployedBytecodeValid],
    ["stable-provenance", provenanceStable],
    ["exclusive-run-complete", exclusiveRunComplete],
    ["public-evidence-bundle", publicEvidenceBundleValid],
    ["timelock-governance", summary.evidence?.governanceMode === "timelock-enforced"],
    ["benchmark-status", benchmark.status === "passed"],
    ["benchmark-sample-requirement", benchmark.requiredSamples > 0
      && benchmark.sampleCount >= benchmark.requiredSamples],
    ["benchmark-latency", benchmark.postSourceInclusionToCompletion?.p95Ms <= benchmark.targetP95Ms],
    ["security-controls", securityScenarios.length > 0 && securityPassed === securityScenarios.length],
    ["integration-tests", integrationEntries.length > 0 && integrationPassed === integrationEntries.length],
    ["validator-availability", fault?.status === "passed"],
    ["report-checksums", reportChecksumsMatch],
  ];
  const failedGates = reportGates.filter(([, passed]) => !passed).map(([id]) => id);
  const reportsPassed = failedGates.length === 0;
  const reportStatus = reportsPassed ? "passed" : "failed";
  const applicableToCurrentSource = sourceApplicability.applicable;
  const validatorSourceCurrent = validatorRuntime?.sourceMatchesCurrent !== false;
  let status = "stale";
  if (!validatorSourceCurrent) status = "validator-stale";
  else if (reportStatus !== "passed") status = "failed";
  else if (applicableToCurrentSource) status = "passed";

  return {
    available: true,
    // `status` remains the fail-closed compatibility field consumed by older clients.
    // A recorded pass is current only when its provenance still matches a clean source tree.
    status,
    reportStatus,
    applicableToCurrentSource,
    applicabilityReason: sourceApplicability.reason,
    validatorRuntime,
    validation: {
      failedGates,
      totalGates: reportGates.length,
    },
    formalEvidenceEligible: summary.formalEvidenceEligible === true,
    generatedAt: summary.finishedAt || summary.startedAt || null,
    runtimeStopped: summary.runtimeStopped === true,
    integrity: {
      reportChecksumsMatch,
      securityProfileValid,
      securityReportValid,
      componentReportsValid,
      deployedBytecodeValid,
      provenanceStable,
      exclusiveRunComplete,
      publicEvidenceBundleClean: publicEvidenceBundleValid,
      verifiedReports: verifiedReportKeys.length,
      expectedReports: checksumKeys.length,
    },
    provenance: {
      recordedCommit,
      recordedCommitShort: shortCommit(recordedCommit),
      recordedDirty: recordedDirty ?? null,
      sourceTreeSha256: summary.provenance?.sourceTreeSha256 || null,
      currentCommit: repository.commit || null,
      currentCommitShort: shortCommit(repository.commit),
      currentDirty: repository.dirty ?? null,
      sourceMatches: applicableToCurrentSource,
    },
    topology: {
      chains: summary.topology?.chains || 0,
      validatorsPerChain: summary.topology?.validatorsPerChain || fault?.validatorCount || 0,
      toleratedFaultsPerChain: summary.topology?.toleratedFaultsPerChain ?? fault?.toleratedFaults ?? 0,
      validatorAvailabilityStatus: fault?.status || "unknown",
    },
    governance: {
      mode: summary.evidence?.governanceMode || "unknown",
    },
    benchmark: {
      status: benchmark.status || "unknown",
      sampleCount: benchmark.sampleCount || 0,
      requiredSamples: benchmark.requiredSamples || 0,
      targetP95Ms: benchmark.targetP95Ms || 0,
      sourceInclusionP95Ms: benchmark.sourceInclusion?.p95Ms || 0,
      postSourceInclusionToCompletionP95Ms: benchmark.postSourceInclusionToCompletion?.p95Ms || 0,
      endToEndP95Ms: benchmark.endToEnd?.p95Ms || 0,
    },
    liveClients: {
      status: liveClientProofValidation.status || "unknown",
      validated: Array.isArray(liveClientProofValidation.validatedLiveClients)
        ? [...liveClientProofValidation.validatedLiveClients]
        : [],
      rpcMethod: liveClientProofValidation.rpcMethod || "unknown",
      acceptedProofObservations: Array.isArray(liveClientProofValidation.proofObservations)
        ? liveClientProofValidation.proofObservations.length
        : 0,
      clients: Array.isArray(liveClientProofValidation.clients)
        ? liveClientProofValidation.clients.map((client) => ({
          chainId: client.chainId,
          clientFamily: client.clientFamily,
          clientVersion: client.clientVersion,
        }))
        : [],
    },
    integration: {
      status: integration?.status
        || (integrationEntries.length > 0 && integrationPassed === integrationEntries.length ? "passed" : "unknown"),
      passed: integrationPassed,
      total: integrationEntries.length,
      tests: integrationEntries,
    },
    security: {
      status: security?.status
        || (securityScenarios.length > 0 && securityPassed === securityScenarios.length ? "passed" : "unknown"),
      passed: securityPassed,
      total: securityScenarios.length,
      scenarios: securityScenarios.map((scenario) => ({
        id: scenario.id,
        title: scenario.title,
        control: scenario.control,
        source: scenario.source,
        status: scenario.status,
      })),
    },
  };
}

export function evaluateEvidenceValidatorRuntime({
  loadedRepository = {},
  currentRepository = {},
  loadedAt = null,
} = {}) {
  const loadedCommit = loadedRepository.commit || null;
  const currentCommit = currentRepository.commit || null;
  let reason = "matched";
  if (!loadedCommit || !currentCommit || loadedRepository.dirty == null || currentRepository.dirty == null) {
    reason = "source-state-unknown";
  } else if (loadedRepository.dirty !== false) {
    reason = "validator-loaded-from-dirty-source";
  } else if (currentRepository.dirty !== false) {
    reason = "current-source-dirty";
  } else if (loadedCommit !== currentCommit) {
    reason = "commit-mismatch";
  }
  return Object.freeze({
    schema: EVIDENCE_VALIDATOR_RUNTIME_SCHEMA,
    loadedAt: loadedAt || null,
    loadedCommit,
    loadedCommitShort: shortCommit(loadedCommit),
    currentCommit,
    currentCommitShort: shortCommit(currentCommit),
    sourceMatchesCurrent: reason === "matched",
    reason,
  });
}

function hasValidEvidenceSecurityProfile(summary) {
  try {
    const profile = validateEvidenceSecurityProfile(summary.securityProfile);
    return summary.evidence?.effectiveSecurityProfileChecksum === profile.provenance.checksum;
  } catch {
    return false;
  }
}

function hasStableRunProvenance(summary) {
  try {
    assertRepositoryProvenanceStable(summary.provenance, summary.completionProvenance);
    return true;
  } catch {
    return false;
  }
}

function hasValidSecurityScenarioReport(report, validationContext) {
  try {
    if (!validationContext) return false;
    validateSecurityScenarioReport(report, EXPECTED_SECURITY_SCENARIOS, validationContext);
    return true;
  } catch {
    return false;
  }
}

function hasValidCollectedEvidenceReports(reports, profile) {
  try {
    validateCollectedEvidenceSecurityProfile(reports, profile);
    return true;
  } catch {
    return false;
  }
}

function hasValidDeployedBytecodeEvidence(evidence, deployment) {
  if (!isPlainObject(evidence) || !isPlainObject(deployment?.chains)) return false;
  if (!hasExactKeys(evidence, ["A", "B"])) return false;

  for (const chainKey of ["A", "B"]) {
    const deployedContracts = deployment.chains[chainKey]?.contracts;
    const observedContracts = evidence[chainKey];
    if (!isPlainObject(deployedContracts) || !isPlainObject(observedContracts)) return false;
    const expectedNames = Object.keys(deployedContracts).sort();
    if (!hasExactKeys(observedContracts, expectedNames)) return false;

    for (const name of expectedNames) {
      const expectedAddress = deployedContracts[name]?.address;
      const observed = observedContracts[name];
      if (
        !isPlainObject(observed)
        || typeof expectedAddress !== "string"
        || typeof observed.address !== "string"
        || observed.address.toLowerCase() !== expectedAddress.toLowerCase()
        || !/^0x[0-9a-fA-F]{64}$/.test(observed.bytecodeHash || "")
        || !Number.isSafeInteger(observed.bytecodeBytes)
        || observed.bytecodeBytes <= 0
      ) {
        return false;
      }
    }
  }
  return true;
}

function hasExactKeys(value, expectedKeys) {
  const actual = Object.keys(value).sort();
  return actual.length === expectedKeys.length
    && actual.every((key, index) => key === expectedKeys[index]);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function currentSecurityValidationContext() {
  try {
    const paths = [...new Set(EXPECTED_SECURITY_SCENARIOS.map((scenario) => scenario.source))];
    const [hardhatPackage, sourceEntries] = await Promise.all([
      readFile(resolve(process.cwd(), "node_modules/hardhat/package.json"), "utf8").then(JSON.parse),
      Promise.all(paths.map(async (path) => [
        path,
        createHash("sha256").update(await readFile(resolve(process.cwd(), path))).digest("hex"),
      ])),
    ]);
    return {
      hardhatVersion: hardhatPackage.version,
      sourceSha256ByPath: new Map(sourceEntries),
    };
  } catch {
    return null;
  }
}

function evaluateSourceApplicability({ recordedCommit, recordedDirty, currentCommit, currentDirty }) {
  if (!recordedCommit || !currentCommit) return { applicable: false, reason: "source-state-unknown" };
  if (recordedDirty === true) return { applicable: false, reason: "recorded-source-dirty" };
  if (currentDirty === true) return { applicable: false, reason: "current-source-dirty" };
  if (recordedDirty !== false || currentDirty !== false) {
    return { applicable: false, reason: "source-state-unknown" };
  }
  if (recordedCommit !== currentCommit) return { applicable: false, reason: "commit-mismatch" };
  return { applicable: true, reason: "matched" };
}

async function readEvidenceReport(path) {
  try {
    const content = await readFile(path);
    return {
      data: JSON.parse(content.toString("utf8")),
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function pathExistsFailClosed(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return error?.code !== "ENOENT";
  }
}

async function evidenceLocksPresent(paths) {
  return (await Promise.all([
    pathExistsFailClosed(paths.institutionalLockPath),
    pathExistsFailClosed(paths.securityLockPath),
  ])).some(Boolean);
}

async function hasExactPublicEvidenceFiles(evidenceRoot) {
  try {
    const entries = await readdir(evidenceRoot, { withFileTypes: true });
    const expected = Object.values(PUBLIC_EVIDENCE_FILES).sort();
    const actual = entries.map((entry) => entry.name).sort();
    return actual.length === expected.length
      && actual.every((name, index) => name === expected[index])
      && entries.every((entry) => entry.isFile());
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return false;
  }
}

export async function repositoryStateForEvidence(
  environment = process.env,
  { runCommand = commandOutput } = {},
) {
  if (Object.keys(environment).some((key) => (
    PROVENANCE_ALTERING_GIT_ENVIRONMENT_KEYS.has(key.toUpperCase())
    || key.toUpperCase().startsWith("GIT_CONFIG_")
  ))) {
    return {
      commit: null,
      dirty: null,
      changedFileCount: null,
      provenanceEnvironmentSafe: false,
      gitIndexSafe: null,
    };
  }
  const childEnvironment = Object.fromEntries(
    REPOSITORY_ENVIRONMENT_ALLOWLIST
      .filter((key) => environment[key] != null)
      .map((key) => [key, String(environment[key])]),
  );
  const [commit, status, indexFlags, headDiff] = await Promise.all([
    Promise.resolve().then(
      () => runCommand("git", ["rev-parse", "HEAD"], childEnvironment),
    ).catch(() => null),
    Promise.resolve().then(
      () => runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"], childEnvironment),
    ).catch(() => null),
    Promise.resolve().then(
      () => runCommand("git", ["ls-files", "-v"], childEnvironment),
    ).catch(() => null),
    Promise.resolve().then(
      () => runCommand("git", ["diff", "--no-ext-diff", "--name-only", "HEAD", "--"], childEnvironment),
    ).catch(() => null),
  ]);
  const normalizedCommit = typeof commit === "string" && GIT_COMMIT_PATTERN.test(commit.trim())
    ? commit.trim()
    : null;
  const normalizedStatus = typeof status === "string" ? status.trim() : null;
  const normalizedHeadDiff = typeof headDiff === "string" ? headDiff.trim() : null;
  const gitIndexSafe = typeof indexFlags === "string"
    && unsafeGitIndexEntries(indexFlags).length === 0;
  const gitStateReliable = gitIndexSafe
    && normalizedHeadDiff !== null
    && !(normalizedHeadDiff && !normalizedStatus);
  return {
    commit: gitStateReliable ? normalizedCommit : null,
    dirty: gitStateReliable && normalizedStatus != null ? Boolean(normalizedStatus) : null,
    changedFileCount: gitStateReliable && normalizedStatus != null
      ? normalizedStatus.split(/\r?\n/).filter(Boolean).length
      : null,
    provenanceEnvironmentSafe: true,
    gitIndexSafe,
  };
}

function commandOutput(command, args, environment) {
  return new Promise((resolveOutput) => {
    const child = spawn(command, args, { cwd: process.cwd(), env: environment, shell: false });
    let stdout = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.once("error", () => resolveOutput(null));
    child.once("exit", (code) => resolveOutput(code === 0 ? stdout.trim() : null));
  });
}

function rejectedEvidencePayload(message, repository, validatorRuntime) {
  return {
    available: false,
    status: "failed",
    reportStatus: "failed",
    applicableToCurrentSource: false,
    applicabilityReason: "evidence-snapshot-unavailable",
    message,
    repository,
    validatorRuntime,
  };
}

function shortCommit(commit) {
  return commit ? commit.slice(0, 8) : null;
}

function humanize(value) {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (character) => character.toUpperCase());
}
