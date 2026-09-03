import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ethers } from "ethers";
import {
  deriveInstitutionalWorkflow,
  observeChainProgress,
  parseActionAmount,
  summarizeRelayJournal,
} from "../ui/read-model.mjs";
import { repositoryStateForEvidence, summarizeFormalEvidence } from "../ui/evidence.mjs";
import { createEvidenceExecutionContext } from "./evidence-environment.mjs";
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
} from "./security-scenario-results.mjs";
import { SCENARIOS as EXPECTED_SECURITY_SCENARIOS } from "./security-scenarios.mjs";
import { classifyDefenseEvidence, readinessVerdict } from "../ops/demo/readiness.mjs";
import { createPassingEvidenceReports } from "../../test/fixtures/evidence-reports.mjs";

const root = process.cwd();
const [
  packageJson,
  html,
  app,
  actionRequest,
  tokenAmount,
  lendingDomain,
  uiPresentation,
  workflowPresentation,
  styles,
  service,
  api,
  runtime,
  readModel,
  doctor,
] = await Promise.all([
  readFile(resolve(root, "package.json"), "utf8"),
  readFile(resolve(root, "demo/index.html"), "utf8"),
  readFile(resolve(root, "demo/app.js"), "utf8"),
  readFile(resolve(root, "demo/action-request.js"), "utf8"),
  readFile(resolve(root, "demo/token-amount.js"), "utf8"),
  readFile(resolve(root, "demo/lending-domain.js"), "utf8"),
  readFile(resolve(root, "demo/ui-presentation.js"), "utf8"),
  readFile(resolve(root, "demo/workflow-presentation.js"), "utf8"),
  readFile(resolve(root, "demo/styles.css"), "utf8"),
  readFile(resolve(root, "scripts/ui/service.mjs"), "utf8"),
  readFile(resolve(root, "scripts/ui/api.mjs"), "utf8"),
  readFile(resolve(root, "services/institutional-demo-runtime.mjs"), "utf8"),
  readFile(resolve(root, "scripts/ui/read-model.mjs"), "utf8"),
  readFile(resolve(root, "scripts/ops/demo/doctor.mjs"), "utf8"),
]);
const modularUiSource = [app, lendingDomain, uiPresentation, workflowPresentation].join("\n");

assert.equal(parseActionAmount("12.5"), ethers.parseEther("12.5"));
assert.throws(() => parseActionAmount("0"), /greater than zero/);
assert.throws(() => parseActionAmount("2", { maximum: ethers.parseEther("1") }), /exceeds/);

const relay = summarizeRelayJournal({
  jobs: {
    one: { messageId: "one", state: "completed", updatedAt: "2026-01-01T00:00:00.000Z" },
    two: { messageId: "two", state: "received", updatedAt: "2026-01-02T00:00:00.000Z" },
  },
}, {
  activeAttestors: 4,
  attestorThreshold: 3,
  relayHealth: { lastHealthyAt: "2026-01-02T00:00:00.000Z", lastError: null },
  now: Date.parse("2026-01-02T00:00:01.000Z"),
});
assert.equal(relay.attestorQuorumReady, true);
assert.equal(relay.relayerHealthy, true);
assert.equal(relay.completedMessages, 1);
assert.equal(relay.pendingMessages, 1);
assert.equal(relay.latestJob.messageId, "two");

const baseStatus = {
  ready: true,
  laneReady: true,
  controller: { activeOperation: null },
  balances: {
    canonicalAvailable: "100",
    voucherAvailable: "0",
    activeCollateral: "0",
    outstandingDebt: "0",
  },
  risk: { availableBorrowRaw: "0" },
  activity: { latest: null },
};
assert.deepEqual(deriveInstitutionalWorkflow(baseStatus), { stage: "transfer", nextAction: "bridge" });
assert.deepEqual(
  deriveInstitutionalWorkflow({
    ...baseStatus,
    balances: { ...baseStatus.balances, voucherAvailable: "25" },
  }),
  { stage: "lend", nextAction: "deposit" },
);
const firstHeads = observeChainProgress({}, { A: 10, B: 20 }, { now: 1_000 });
assert.equal(firstHeads.chainsProgressing, false);
assert.equal(
  observeChainProgress(firstHeads.chains, { A: 11, B: 21 }, { now: 2_000 }).chainsProgressing,
  true,
);

const evidenceSecurityProfile = createEvidenceExecutionContext({}).securityProfile;
let injectedGitCommandCalled = false;
const injectedGitState = await repositoryStateForEvidence(
  { PATH: "/trusted/bin", GIT_DIR: "/tmp/other-repository/.git" },
  { runCommand: async () => { injectedGitCommandCalled = true; return "unexpected"; } },
);
assert.equal(injectedGitCommandCalled, false);
assert.deepEqual(injectedGitState, {
  commit: null,
  dirty: null,
  changedFileCount: null,
  provenanceEnvironmentSafe: false,
  gitIndexSafe: null,
});

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
  reportDigests: { deployment: "d", fault: "f", integration: "i", security: "s" },
  securityValidationContext: {
    hardhatVersion: "3.1.8",
    sourceSha256ByPath: new Map(EXPECTED_SECURITY_SCENARIOS.map((scenario) => [scenario.source, "a".repeat(64)])),
  },
};
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

const missingBytecodeInput = structuredClone(passingEvidenceInput);
delete missingBytecodeInput.summary.evidence.deployedBytecode.B.gateway;
const missingBytecodeEvidence = summarizeFormalEvidence(missingBytecodeInput);
assert.equal(missingBytecodeEvidence.reportStatus, "failed");
assert.equal(missingBytecodeEvidence.integrity.deployedBytecodeValid, false);

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
assert.deepEqual(
  deriveInstitutionalWorkflow({
    ...baseStatus,
    balances: { ...baseStatus.balances, activeCollateral: "25", outstandingDebt: "10" },
  }),
  { stage: "manage", nextAction: "repay" },
);

const parsedPackage = JSON.parse(packageJson);
assert.match(parsedPackage.scripts["demo:prepare"], /institutional:deploy/);
assert.match(parsedPackage.scripts["demo:prepare"], /institutional:governance/);
assert.equal(parsedPackage.scripts["demo:ui"], "node scripts/ui/serve.mjs");
assert.equal(parsedPackage.scripts["demo:doctor"], "node scripts/ops/demo/doctor.mjs");
assert.equal(
  parsedPackage.scripts["institutional:evidence:verify"],
  "node scripts/verification/verify-evidence.mjs",
);
assert.equal(parsedPackage.scripts.deploy, undefined);
assert.equal(parsedPackage.scripts.seed, undefined);

for (const action of ["bridge", "deposit", "borrow", "repay", "repayAll", "withdraw", "return"]) {
  assert.match(modularUiSource, new RegExp(`\\b${action}\\b`), `UI controller should expose ${action}`);
  assert.match(runtime, new RegExp(`\\b${action}\\b`), `runtime should execute ${action}`);
}
assert.match(html, /Institutional Cross-chain Operations/);
assert.match(html, /\/assets\/linky\/generated\/states\/linky-guide\.png/);
assert.doesNotMatch(html, /\/assets\/logo\.png/);
assert.doesNotMatch(html, /\/assets\/nexus-mark\.svg/);
assert.match(html, /Linky Nexus/);
assert.match(html, /data-panel="identity"/);
assert.match(html, /id="readinessVerdict"/);
assert.match(html, /class="technical-disclosure"/);
assert.doesNotMatch(html, /Proof-backed liquidity across bank networks|Governed lifecycle|class="linky-runtime"/);
assert.doesNotMatch(html, /class="linky-command-center"|id="linkyWhyButton"/);
for (const momentId of ["linkyIdentityImage", "linkyTransferImage", "linkyLendingImage", "linkySettlementImage", "linkyEvidenceImage"]) {
  assert.match(html, new RegExp(`id="${momentId}"[^>]+data-linky-image`));
}
assert.match(html, /id="linkyTransferProgress"[^>]+role="progressbar"/);
assert.match(app, /setTransferLinkyProgress/);
assert.match(styles, /\.linky-moment img[^{]*\{[^}]*object-fit:\s*contain/s);
for (const semanticValueId of ["overviewChainABlock", "overviewChainBBlock", "runtimeChainA", "runtimeChainB"]) {
  assert.match(html, new RegExp(`id="${semanticValueId}"`));
}
assert.match(styles, /\.ui-atomic\s*\{[^}]*white-space:\s*nowrap/s);
assert.match(styles, /\.overview-chain-heights\s*\{[^}]*flex-wrap:\s*wrap/s);
assert.doesNotMatch(html, /class="linky-rail"/);
assert.match(html, /id="transferPipeline"/);
assert.match(html, /id="runtimePopover"/);
assert.match(html, /data-status-toggle/);
assert.match(html, /data-panel="evidence"/);
assert.match(html, /id="securityEvidenceList"/);
assert.match(html, /id="benchmarkSamples"/);
assert.match(html, /3-of-4 attested/);
assert.doesNotMatch(html, /finalizeForwardHeader|updateForwardClient|proveForwardMint|openRoute/);
assert.doesNotMatch(app, /deploy-seed|reset-seeded|resume-session/);
assert.doesNotMatch(app, /settleDust/);
assert.doesNotMatch(runtime, /settleDust/);
assert.match(styles, /@media\s*\(min-width:\s*1080px\)\s*and\s*\(max-width:\s*1365px\)/i);
assert.doesNotMatch(styles, /@media\s*\([^)]*max-width:\s*(?:[0-9]{1,3}|10[0-7][0-9])px/i);
assert.match(styles, /@media\s*\(prefers-reduced-motion:\s*reduce\)/i);
assert.match(styles, /@keyframes\s+live-ring/);
assert.doesNotMatch(styles, /\.overview-metrics\s*>\s*\.metric-card:hover|\.metric-card:hover\s*>\s*svg/);
assert.match(styles, /\.journey-step:hover/);
assert.match(styles, /min-width:\s*1280px/);
assert.match(styles, /min-width:\s*1080px/);
assert.match(styles, /--canvas:\s*#f4f7fb/i);
assert.match(styles, /Solid Color desktop theme/);
assert.doesNotMatch(styles, /color-mix|linear-gradient|radial-gradient/i);
assert.match(app, /function renderIdentity/);
assert.match(app, /function renderOperationProgress/);
assert.match(service, /InstitutionalDemoRuntime/);
assert.match(service, /formalEvidencePayload/);
assert.match(api, /\/api\/evidence/);
assert.doesNotMatch(api, /institutional-attestor-secrets/);
assert.match(runtime, /InstitutionalRelayEngine/);
assert.match(runtime, /CheckpointAttestor/);
assert.match(runtime, /lockAndMint/);
assert.match(runtime, /burnAndUnlock/);
assert.match(runtime, /InstitutionalActionJournal/);
assert.match(runtime, /getTransactionReceipt/);
assert.match(runtime, /reconciling-relay/);
assert.match(runtime, /messageTimedOut/);
assert.match(app, /createActionRequestStore/);
assert.match(app, /sessionStorage/);
assert.match(actionRequest, /requestId[\s\S]*action[\s\S]*amount/);
assert.match(tokenAmount, /10n \*\* BigInt\(TOKEN_DECIMALS\)/);
assert.match(app, /from "\.\/lending-domain\.js"/);
assert.match(app, /from "\.\/ui-presentation\.js"/);
assert.match(app, /from "\.\/workflow-presentation\.js"/);
assert.match(lendingDomain, /SMALL_BALANCE_THRESHOLD = parseTokenUnits\("0\.01"\)/);
assert.match(lendingDomain, /Enter a decimal amount with at most 18 decimal places\./);
assert.doesNotMatch(modularUiSource, /\+\s*0\.0000001|maximumFractionDigits:\s*8/);
assert.match(app, /catch \(error\) \{\s*currentStatus = null;\s*renderRuntimeFailure/s);
assert.match(app, /const laneReady = Boolean\(currentStatus\?\.laneReady\);[\s\S]*if \(!laneReady\) \{[\s\S]*updateSubmit/);
assert.match(app, /applicableToCurrentSource/);
assert.match(readModel, /timelock-enforced|governanceMode/);
assert.match(doctor, /Deployed contract bytecode/);
assert.match(doctor, /classifyDefenseEvidence/);
assert.match(doctor, /readinessVerdict/);

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

console.log("Institutional UI/read-model checks passed.");
