import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateEvidenceValidatorRuntime,
  repositoryStateForEvidence,
  summarizeFormalEvidence,
} from "../../scripts/ui/evidence.mjs";

import { createEvidenceExecutionContext } from "../../scripts/verification/evidence-environment.mjs";
import {
  SECURITY_COMPILATION_MODE,
  SECURITY_COMPILATION_TASK,
  SECURITY_EXECUTOR_KIND,
  SECURITY_EXECUTOR_SELECTION,
  SECURITY_EXECUTOR_TASK,
  SECURITY_REPORT_VERSION,
  SECURITY_RESULT_SCHEMA,
  exactTestPattern,
  sha256Json,
} from "../../scripts/verification/security-scenario-results.mjs";
import { SCENARIOS as EXPECTED_SECURITY_SCENARIOS } from "../../scripts/verification/security-scenarios.mjs";
import { classifyDefenseEvidence, readinessVerdict } from "../../scripts/ops/demo/readiness.mjs";
import { createPassingEvidenceReports } from "../fixtures/evidence-reports.mjs";

test("evidence validator runtime detects a commit loaded before the current source", () => {
  const runtime = evaluateEvidenceValidatorRuntime({
    loadedRepository: { commit: "1".repeat(40), dirty: false },
    currentRepository: { commit: "2".repeat(40), dirty: false },
    loadedAt: "2026-09-04T10:00:00.000Z",
  });
  assert.equal(runtime.sourceMatchesCurrent, false);
  assert.equal(runtime.reason, "commit-mismatch");
  assert.equal(runtime.loadedCommitShort, "11111111");
  assert.equal(runtime.currentCommitShort, "22222222");
});

test("evidence validator runtime passes only a clean, unchanged source revision", () => {
  const commit = "a".repeat(40);
  assert.equal(evaluateEvidenceValidatorRuntime({
    loadedRepository: { commit, dirty: false },
    currentRepository: { commit, dirty: false },
  }).sourceMatchesCurrent, true);
  assert.equal(evaluateEvidenceValidatorRuntime({
    loadedRepository: { commit, dirty: true },
    currentRepository: { commit, dirty: false },
  }).reason, "validator-loaded-from-dirty-source");
  assert.equal(evaluateEvidenceValidatorRuntime({
    loadedRepository: { commit, dirty: false },
    currentRepository: { commit, dirty: true },
  }).reason, "current-source-dirty");
});

test("evidence repository lookup strips benign Git presentation variables without losing provenance", async () => {
  const calls = [];
  const outputs = new Map([
    ["git rev-parse HEAD", "1".repeat(40)],
    ["git status --porcelain=v1 --untracked-files=all", " M README.md"],
    ["git ls-files -v", "H README.md"],
    ["git diff --no-ext-diff --name-only HEAD --", "README.md"],
  ]);
  const result = await repositoryStateForEvidence(
    { PATH: "/usr/bin", GIT_PAGER: "cat" },
    {
      runCommand: async (command, args, environment) => {
        calls.push(environment);
        return outputs.get([command, ...args].join(" ")) ?? null;
      },
    },
  );
  assert.equal(result.commit, "1".repeat(40));
  assert.equal(result.dirty, true);
  assert.equal(result.provenanceEnvironmentSafe, true);
  assert.equal(calls.every((environment) => environment.GIT_PAGER === undefined), true);
});

test("evidence repository lookup rejects provenance-altering Git variables before subprocesses", async () => {
  let called = false;
  const result = await repositoryStateForEvidence(
    { GIT_DIR: "/tmp/untrusted" },
    { runCommand: async () => { called = true; return null; } },
  );
  assert.equal(called, false);
  assert.deepEqual(result, {
    commit: null,
    dirty: null,
    changedFileCount: null,
    provenanceEnvironmentSafe: false,
    gitIndexSafe: null,
  });
});

test("evidence repository lookup forwards only approved environment fields", async () => {
  const sanitizedGitCalls = [];
  const sanitizedGitState = await repositoryStateForEvidence(
    { PATH: "/trusted/bin", HOME: "/trusted/home", UNRELATED_SECRET: "do-not-forward" },
    {
      runCommand: async (_command, args, environment) => {
        sanitizedGitCalls.push({ args, environment });
        return args[0] === "rev-parse" ? "1".repeat(40) : "";
      },
    },
  );
  assert.equal(sanitizedGitState.commit, "1".repeat(40));
  assert.equal(sanitizedGitState.dirty, false);
  assert.equal(sanitizedGitState.gitIndexSafe, true);
  assert.equal(sanitizedGitCalls.every(({ environment }) => environment.UNRELATED_SECRET === undefined), true);
});

const evidenceSecurityProfile = createEvidenceExecutionContext({}).securityProfile;
const passingComponentReports = createPassingEvidenceReports(evidenceSecurityProfile);
const passingCommit = "1".repeat(40);
const passingProvenance = {
  capturedAt: "2026-01-01T00:00:00.000Z",
  git: {
    commit: passingCommit,
    dirty: false,
    changedFileCount: 0,
    statusSha256: "2".repeat(64),
    indexFlagsSha256: "7".repeat(64),
  },
  sourceTreeSha256: "3".repeat(64),
  sourceFileCount: 100,
  packageLockSha256: "4".repeat(64),
  tools: {
    node: process.version,
    npm: "10.0.0",
    docker: "Docker version 27.0.0",
    platform: `${process.platform}/${process.arch}`,
  },
  formalEvidenceEligible: true,
};
const securityExecutions = EXPECTED_SECURITY_SCENARIOS.map((scenario) => ({
  id: scenario.id,
  source: scenario.source,
  test: scenario.test,
  signature: scenario.signature,
  selector: {
    testFiles: [scenario.source],
    grep: exactTestPattern(scenario.signature),
  },
  result: { passed: 1, failed: 0, skipped: 0, todo: 0 },
}));
const passingSecurityReport = {
  version: SECURITY_REPORT_VERSION,
  status: "passed",
  executor: {
    kind: SECURITY_EXECUTOR_KIND,
    task: SECURITY_EXECUTOR_TASK,
    selection: SECURITY_EXECUTOR_SELECTION,
    toolVersion: "3.1.8",
    resultSchema: SECURITY_RESULT_SCHEMA,
    compilation: {
      task: SECURITY_COMPILATION_TASK,
      mode: SECURITY_COMPILATION_MODE,
      force: true,
    },
    summary: {
      expected: EXPECTED_SECURITY_SCENARIOS.length,
      executed: EXPECTED_SECURITY_SCENARIOS.length,
      passed: EXPECTED_SECURITY_SCENARIOS.length,
    },
    structuredResultsSha256: sha256Json(securityExecutions),
  },
  scenarios: EXPECTED_SECURITY_SCENARIOS.map((scenario, index) => ({
    ...scenario,
    status: "passed",
    sourceSha256: "a".repeat(64),
    execution: securityExecutions[index],
  })),
};
const passingEvidenceInput = {
  summary: {
    version: "institutional-runtime-evidence-v4",
    status: "passed",
    formalEvidenceEligible: true,
    securityProfile: evidenceSecurityProfile,
    finishedAt: "2026-01-01T00:00:00.000Z",
    provenance: passingProvenance,
    completionProvenance: {
      ...structuredClone(passingProvenance),
      capturedAt: "2026-01-01T00:10:00.000Z",
    },
    topology: { chains: 2, validatorsPerChain: 4, toleratedFaultsPerChain: 1 },
    evidence: {
      effectiveSecurityProfileChecksum: evidenceSecurityProfile.provenance.checksum,
      governanceMode: "timelock-enforced",
      reportChecksums: { deployment: "d", fault: "f", integration: "i", security: "s" },
      benchmark: passingComponentReports.integration.benchmark,
      integrationTests: passingComponentReports.integration.tests,
      liveClientProofValidation: passingComponentReports.integration.liveClientProofValidation,
      securityScenarios: passingSecurityReport.scenarios,
      deployedBytecode: createPassingBytecodeEvidence(passingComponentReports.deployment),
    },
  },
  security: passingSecurityReport,
  integration: passingComponentReports.integration,
  fault: passingComponentReports.fault,
  deployment: passingComponentReports.deployment,
  repository: { commit: passingCommit, dirty: false },
  validatorRuntime: {
    sourceMatchesCurrent: true,
    reason: "matched",
    loadedCommit: passingCommit,
    currentCommit: passingCommit,
  },
  reportDigests: { deployment: "d", fault: "f", integration: "i", security: "s" },
  securityValidationContext: {
    hardhatVersion: "3.1.8",
    sourceSha256ByPath: new Map(EXPECTED_SECURITY_SCENARIOS.map((scenario) => [scenario.source, "a".repeat(64)])),
  },
};

test("formal evidence accepts a complete, verified report bundle", async () => {
  const formalEvidence = summarizeFormalEvidence(passingEvidenceInput);
  assert.equal(formalEvidence.status, "passed");
  assert.equal(formalEvidence.reportStatus, "passed");
  assert.equal(formalEvidence.applicableToCurrentSource, true);
  assert.equal(formalEvidence.applicabilityReason, "matched");
  assert.equal(formalEvidence.provenance.sourceMatches, true);
  assert.equal(
    formalEvidence.benchmark.postSourceInclusionToCompletionP95Ms,
    passingComponentReports.integration.benchmark.postSourceInclusionToCompletion.p95Ms,
  );
  assert.equal(formalEvidence.security.passed, EXPECTED_SECURITY_SCENARIOS.length);
  assert.deepEqual(formalEvidence.liveClients.validated, ["Besu"]);
  assert.equal(formalEvidence.liveClients.acceptedProofObservations, 4);
  assert.equal(formalEvidence.integrity.reportChecksumsMatch, true);
  assert.equal(formalEvidence.integrity.securityProfileValid, true);
  assert.equal(formalEvidence.integrity.securityReportValid, true);
  assert.equal(formalEvidence.integrity.componentReportsValid, true);
  assert.equal(formalEvidence.integrity.deployedBytecodeValid, true);
  assert.equal(formalEvidence.integrity.provenanceStable, true);
  assert.equal(formalEvidence.integrity.exclusiveRunComplete, true);
  assert.equal(formalEvidence.integrity.publicEvidenceBundleClean, true);
  assert.deepEqual(formalEvidence.validation.failedGates, []);
});

test("formal evidence rejects stale validators, tampered reports and incomplete runs", async () => {
  const staleValidatorEvidence = summarizeFormalEvidence({
    ...passingEvidenceInput,
    validatorRuntime: {
      sourceMatchesCurrent: false,
      reason: "commit-mismatch",
      loadedCommit: "6".repeat(40),
      currentCommit: passingCommit,
    },
  });
  assert.equal(staleValidatorEvidence.reportStatus, "passed");
  assert.equal(staleValidatorEvidence.status, "validator-stale");

  const missingBytecodeInput = structuredClone(passingEvidenceInput);
  delete missingBytecodeInput.summary.evidence.deployedBytecode.B.gateway;
  const missingBytecodeEvidence = summarizeFormalEvidence(missingBytecodeInput);
  assert.equal(missingBytecodeEvidence.reportStatus, "failed");
  assert.equal(missingBytecodeEvidence.integrity.deployedBytecodeValid, false);
  assert.deepEqual(missingBytecodeEvidence.validation.failedGates, ["deployed-bytecode"]);

  const changedDuringRunInput = structuredClone(passingEvidenceInput);
  changedDuringRunInput.summary.completionProvenance.sourceTreeSha256 = "5".repeat(64);
  const changedDuringRunEvidence = summarizeFormalEvidence(changedDuringRunInput);
  assert.equal(changedDuringRunEvidence.reportStatus, "failed");
  assert.equal(changedDuringRunEvidence.integrity.provenanceStable, false);

  const activeRunEvidence = summarizeFormalEvidence({
    ...passingEvidenceInput,
    evidenceRunLockPresent: true,
  });
  assert.equal(activeRunEvidence.reportStatus, "failed");
  assert.equal(activeRunEvidence.integrity.exclusiveRunComplete, false);

  const secretContaminatedEvidence = summarizeFormalEvidence({
    ...passingEvidenceInput,
    publicEvidenceBundleClean: false,
  });
  assert.equal(secretContaminatedEvidence.reportStatus, "failed");
  assert.equal(secretContaminatedEvidence.integrity.publicEvidenceBundleClean, false);

  const tamperedSecurityProfileInput = structuredClone(passingEvidenceInput);
  tamperedSecurityProfileInput.summary.securityProfile.effective.besu.adminDebugRpc = true;
  const tamperedSecurityProfileEvidence = summarizeFormalEvidence(tamperedSecurityProfileInput);
  assert.equal(tamperedSecurityProfileEvidence.reportStatus, "failed");
  assert.equal(tamperedSecurityProfileEvidence.status, "failed");
  assert.equal(tamperedSecurityProfileEvidence.integrity.securityProfileValid, false);

  const tamperedStructuredReportInput = structuredClone(passingEvidenceInput);
  tamperedStructuredReportInput.security.executor.structuredResultsSha256 = "0".repeat(64);
  const tamperedStructuredReportEvidence = summarizeFormalEvidence(tamperedStructuredReportInput);
  assert.equal(tamperedStructuredReportEvidence.reportStatus, "failed");
  assert.equal(tamperedStructuredReportEvidence.integrity.securityReportValid, false);
});

test("formal evidence separates report validity from current-source applicability", async () => {
  const commitMismatchEvidence = summarizeFormalEvidence({
    ...passingEvidenceInput,
    repository: { commit: "6".repeat(40), dirty: false },
  });
  assert.equal(commitMismatchEvidence.reportStatus, "passed");
  assert.equal(commitMismatchEvidence.status, "stale");
  assert.equal(commitMismatchEvidence.applicableToCurrentSource, false);
  assert.equal(commitMismatchEvidence.applicabilityReason, "commit-mismatch");
  assert.equal(commitMismatchEvidence.provenance.sourceMatches, false);
  const mismatchedEvidenceCheck = classifyDefenseEvidence(commitMismatchEvidence);
  assert.equal(mismatchedEvidenceCheck.status, "fail");
  assert.equal(readinessVerdict([mismatchedEvidenceCheck]).exitCode, 1);
  assert.match(readinessVerdict([mismatchedEvidenceCheck]).message, /NOT READY/);

  const dirtySourceEvidence = summarizeFormalEvidence({
    ...passingEvidenceInput,
    repository: { commit: passingCommit, dirty: true },
  });
  assert.equal(dirtySourceEvidence.reportStatus, "passed");
  assert.equal(dirtySourceEvidence.status, "stale");
  assert.equal(dirtySourceEvidence.applicableToCurrentSource, false);
  assert.equal(dirtySourceEvidence.applicabilityReason, "current-source-dirty");

  const unknownSourceEvidence = summarizeFormalEvidence({
    ...passingEvidenceInput,
    repository: { commit: passingCommit, dirty: null },
  });
  assert.equal(unknownSourceEvidence.reportStatus, "passed");
  assert.equal(unknownSourceEvidence.status, "stale");
  assert.equal(unknownSourceEvidence.applicableToCurrentSource, false);
  assert.equal(unknownSourceEvidence.applicabilityReason, "source-state-unknown");

  // `repositoryState()` returns null fields when either git lookup cannot be
  // completed. A historical pass must remain visible, but never as a current pass.
  const repositoryLookupFailureEvidence = summarizeFormalEvidence({
    ...passingEvidenceInput,
    repository: { commit: null, dirty: null },
  });
  assert.equal(repositoryLookupFailureEvidence.reportStatus, "passed");
  assert.equal(repositoryLookupFailureEvidence.status, "stale");
  assert.equal(repositoryLookupFailureEvidence.applicableToCurrentSource, false);
  assert.equal(repositoryLookupFailureEvidence.applicabilityReason, "source-state-unknown");

  const dirtyRecordedEvidence = summarizeFormalEvidence({
    ...passingEvidenceInput,
    summary: {
      ...passingEvidenceInput.summary,
      provenance: {
        ...passingEvidenceInput.summary.provenance,
        git: { ...passingEvidenceInput.summary.provenance.git, dirty: true },
      },
    },
  });
  assert.equal(dirtyRecordedEvidence.reportStatus, "failed");
  assert.equal(dirtyRecordedEvidence.status, "failed");
  assert.equal(dirtyRecordedEvidence.applicableToCurrentSource, false);
  assert.equal(dirtyRecordedEvidence.applicabilityReason, "recorded-source-dirty");

  const failedRecordedReport = summarizeFormalEvidence({
    ...passingEvidenceInput,
    summary: { ...passingEvidenceInput.summary, status: "failed" },
  });
  assert.equal(failedRecordedReport.reportStatus, "failed");
  assert.equal(failedRecordedReport.status, "failed");
  assert.equal(failedRecordedReport.applicableToCurrentSource, true);
});

function createPassingBytecodeEvidence(deployment) {
  let identity = 9_000;
  return Object.fromEntries(["A", "B"].map((chainKey) => [
    chainKey,
    Object.fromEntries(Object.entries(deployment.chains[chainKey].contracts).map(([name, contract]) => [
      name,
      {
        address: contract.address,
        bytecodeHash: `0x${BigInt(identity++).toString(16).padStart(64, "0")}`,
        bytecodeBytes: 256,
      },
    ])),
  ]));
}
