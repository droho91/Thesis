import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeJsonAtomic } from "../../services/shared/json-file.mjs";
import { withProcessLock } from "./process-lock.mjs";
import { resolveSafeEvidencePaths } from "./safe-evidence-paths.mjs";
import {
  SECURITY_EXECUTOR_KIND,
  SECURITY_EXECUTOR_SELECTION,
  SECURITY_EXECUTOR_TASK,
  SECURITY_MAX_INFRASTRUCTURE_RETRIES,
  SECURITY_COMPILATION_MODE,
  SECURITY_COMPILATION_TASK,
  SECURITY_REPORT_VERSION,
  SECURITY_RESULT_SCHEMA,
  exactTestPattern,
  normalizeHardhatTaskResult,
  sha256Json,
  validateScenarioExecutions,
  validateScenarioManifest,
  validateSecurityScenarioReport,
} from "./security-scenario-results.mjs";

const REPORT_PATH = resolve(process.cwd(), ".runtime/evidence/security-scenarios.json");
if (
  process.env.INSTITUTIONAL_SECURITY_REPORT_PATH != null
  && resolve(process.cwd(), process.env.INSTITUTIONAL_SECURITY_REPORT_PATH) !== REPORT_PATH
) {
  throw new Error("INSTITUTIONAL_SECURITY_REPORT_PATH cannot redirect the managed security report");
}
export const SECURITY_LOCK_PATH = resolve(process.cwd(), ".runtime/locks/security-scenarios.lock");
const HARDHAT_RUNTIME_SCAN_MAX_RETRIES = SECURITY_MAX_INFRASTRUCTURE_RETRIES;
const HARDHAT_RUNTIME_SCAN_RETRY_DELAYS_MS = Object.freeze([50, 125, 300, 650]);

export const SCENARIOS = Object.freeze([
  {
    id: "SEC-01",
    title: "Insufficient checkpoint quorum",
    test: "testRejectsInsufficientQuorum",
    signature: "testRejectsInsufficientQuorum()",
    control: "A checkpoint with fewer than three of four configured attestors is rejected.",
    source: "test/gateway/InstitutionalCheckpointClient.t.sol",
  },
  {
    id: "SEC-02",
    title: "Replay or forged commitment",
    test: "testReceiveRejectsReplayAndForgedCommitment",
    signature: "testReceiveRejectsReplayAndForgedCommitment()",
    control: "The gateway rejects both duplicate receipt execution and a commitment that differs from proven storage.",
    source: "test/gateway/InstitutionalCrossChainGateway.t.sol",
  },
  {
    id: "SEC-03",
    title: "Suspended institutional identity",
    test: "testSuspendedIdentityBlocksOriginAndDestinationExecution",
    signature: "testSuspendedIdentityBlocksOriginAndDestinationExecution()",
    control: "Suspended customers cannot originate or receive institutional collateral messages.",
    source: "test/apps/InstitutionalCollateralApp.t.sol",
  },
  {
    id: "SEC-04",
    title: "Origination-principal cap violation",
    test: "testAccountOriginationPrincipalCapAggregatesAcrossDebtAssets",
    signature: "testAccountOriginationPrincipalCapAggregatesAcrossDebtAssets()",
    control: "One aggregate account origination-principal cap rejects excessive new principal across debt assets.",
    source: "test/apps/BankPolicy.t.sol",
  },
  {
    id: "SEC-05",
    title: "Direct governance bypass",
    test: "testDirectAdministratorBypassIsRejected",
    signature: "testDirectAdministratorBypassIsRejected()",
    control: "Sensitive administration cannot bypass the timelock after governance handoff.",
    source: "test/governance/InstitutionalGovernanceTimelock.t.sol",
  },
  {
    id: "SEC-06",
    title: "Duplicate business request",
    test: "testClientReferencePreventsDuplicateOriginSubmission",
    signature: "testClientReferencePreventsDuplicateOriginSubmission()",
    control: "A sender cannot reuse a client reference to lock or burn collateral twice.",
    source: "test/apps/InstitutionalCollateralApp.t.sol",
  },
  {
    id: "SEC-07",
    title: "Debt conservation under full repayment",
    test: "testFuzzRepayAllCollectsEveryClearedDebtUnit",
    signature: "testFuzzRepayAllCollectsEveryClearedDebtUnit(uint96)",
    control: "Fuzzed full repayments clear debt only when pool cash increases by the same amount.",
    source: "test/apps/LendingValuation.t.sol",
  },
  {
    id: "SEC-08",
    title: "Emergency pause with in-flight timeout",
    test: "testPauseStillAllowsProofCheckedTimeout",
    signature: "testPauseStillAllowsProofCheckedTimeout()",
    control: "Pause blocks new risk but still permits a proof-checked terminal timeout.",
    source: "test/gateway/InstitutionalCrossChainGateway.t.sol",
  },
  {
    id: "SEC-09",
    title: "Compliance hold during compensation",
    test: "testComplianceSuspensionKeepsRefundPendingUntilResolution",
    signature: "testComplianceSuspensionKeepsRefundPendingUntilResolution()",
    control: "A suspended sender's refund remains atomically pending and succeeds only after compliance resolution.",
    source: "test/apps/InstitutionalCollateralApp.t.sol",
  },
  {
    id: "SEC-10",
    title: "Unauthorized voucher transfer",
    test: "testVoucherCannotBeTransferredOutsideApprovedInstitutionalOperator",
    signature: "testVoucherCannotBeTransferredOutsideApprovedInstitutionalOperator()",
    control: "Collateral receipts cannot move wallet-to-wallet outside an approved institutional operator.",
    source: "test/apps/BankPolicy.t.sol",
  },
  {
    id: "SEC-11",
    title: "Revoked credential reactivation",
    test: "testRevokedCredentialCannotBeReactivatedOrRenewed",
    signature: "testRevokedCredentialCannotBeReactivatedOrRenewed()",
    control: "Revocation is terminal and cannot be converted back to an active credential.",
    source: "test/identity/InstitutionalIdentityRegistry.t.sol",
  },
  {
    id: "SEC-12",
    title: "Checkpoint recovery authorization floor",
    test: "testRecoveryRejectsOldProofButAcceptsRecoveryProofAndPreservesAuditData",
    signature: "testRecoveryRejectsOldProofButAcceptsRecoveryProofAndPreservesAuditData()",
    control: "Recovery preserves historical root data but rejects proof authorization below the recovery floor.",
    source: "test/gateway/InstitutionalCheckpointClient.t.sol",
  },
  {
    id: "SEC-13",
    title: "Revoked lock-timeout restitution",
    test: "testTerminalRevocationRoutesLockTimeoutIntoGovernedRestitution",
    signature: "testTerminalRevocationRoutesLockTimeoutIntoGovernedRestitution()",
    control: "Canonical compensation for a terminally revoked sender enters accounted restricted custody.",
    source: "test/apps/InstitutionalCollateralApp.t.sol",
  },
  {
    id: "SEC-14",
    title: "Revoked burn-timeout restitution",
    test: "testTerminalRevocationRoutesBurnTimeoutIntoGovernedRestitution",
    signature: "testTerminalRevocationRoutesBurnTimeoutIntoGovernedRestitution()",
    control: "Voucher compensation for a terminally revoked sender enters accounted restricted custody.",
    source: "test/apps/InstitutionalCollateralApp.t.sol",
  },
]);

async function main() {
  const managedPaths = await resolveSafeEvidencePaths();
  await withProcessLock(
    managedPaths.securityLockPath,
    () => runSecurityScenarios(managedPaths.securityReportPath),
    {
      label: "institutional-security-scenarios",
      metadata: { reportPath: managedPaths.securityReportPath },
      // Reclaim only a verified same-host dead process, never an old-looking or
      // foreign lock. This keeps crash recovery automatic and concurrency safe.
      reclaimOrphaned: true,
    },
  );
}

async function runSecurityScenarios(reportPath) {
  const startedAt = new Date().toISOString();
  const initialReport = {
    version: SECURITY_REPORT_VERSION,
    status: "running",
    startedAt,
    runtime: { node: process.version, platform: `${process.platform}/${process.arch}` },
  };
  await writeJsonAtomic(reportPath, initialReport);

  try {
    validateScenarioManifest(SCENARIOS);
    const sourceHashesBefore = await hashScenarioSources(SCENARIOS);
    const { default: hre } = await import("hardhat");
    const compilation = await runHardhatTaskWithRuntimeScanRetry(
      () => hre.tasks.getTask(["compile"]).run({ force: true, quiet: true }),
      { label: "forced Solidity compilation" },
    );
    const executions = [];
    for (const [index, scenario] of SCENARIOS.entries()) {
      const selector = {
        testFiles: [scenario.source],
        grep: exactTestPattern(scenario.signature),
      };
      const execution = await runHardhatTaskWithRuntimeScanRetry(
        () => hre.tasks.getTask(["test", "solidity"]).run({
          ...selector,
          chainType: "l1",
          noCompile: true,
          // A positive summary index makes Hardhat's Solidity reporter return
          // structured counters instead of only printing the direct-task summary.
          testSummaryIndex: 1,
        }),
        { label: `${scenario.id} exact Solidity test` },
      );
      executions.push({
        id: scenario.id,
        source: scenario.source,
        test: scenario.test,
        signature: scenario.signature,
        selector,
        infrastructureRetries: execution.retries,
        result: normalizeHardhatTaskResult(execution.result),
      });
    }
    const finishedAt = new Date().toISOString();
    const sourceHashesAfter = await hashScenarioSources(SCENARIOS);
    assertStableSourceHashes(sourceHashesBefore, sourceHashesAfter);
    const summary = validateScenarioExecutions(SCENARIOS, executions);
    const scenarios = SCENARIOS.map((scenario, index) => ({
      ...scenario,
      status: "passed",
      sourceSha256: sourceHashesAfter.get(scenario.source),
      execution: executions[index],
    }));
    const structuredResultsSha256 = sha256Json(executions);

    const report = {
      ...initialReport,
      status: "passed",
      finishedAt,
      executor: {
        kind: SECURITY_EXECUTOR_KIND,
        task: SECURITY_EXECUTOR_TASK,
        toolVersion: hre.versions.hardhat,
        resultSchema: SECURITY_RESULT_SCHEMA,
        selection: SECURITY_EXECUTOR_SELECTION,
        compilation: {
          task: SECURITY_COMPILATION_TASK,
          mode: SECURITY_COMPILATION_MODE,
          force: true,
          infrastructureRetries: compilation.retries,
        },
        summary,
        structuredResultsSha256,
      },
      scenarios,
    };
    validateSecurityScenarioReport(report, SCENARIOS, {
      sourceSha256ByPath: sourceHashesAfter,
      hardhatVersion: hre.versions.hardhat,
    });
    await writeJsonAtomic(reportPath, report);
    console.log(`[security:scenarios] PASS ${scenarios.length}/${scenarios.length} report=${reportPath}`);
  } catch (error) {
    await writeJsonAtomic(reportPath, {
      ...initialReport,
      status: "failed",
      finishedAt: new Date().toISOString(),
      failure: {
        name: error?.name || "Error",
        message: error?.message || String(error),
      },
    }).catch((reportError) => {
      console.error(`[security:scenarios] Could not write failed report: ${reportError?.message || reportError}`);
    });
    throw error;
  }
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function hashScenarioSources(scenarios) {
  const sources = [...new Set(scenarios.map((scenario) => scenario.source))];
  return new Map(await Promise.all(sources.map(async (source) => [
    source,
    await sha256(resolve(process.cwd(), source)),
  ])));
}

function assertStableSourceHashes(before, after) {
  for (const [source, beforeHash] of before) {
    if (after.get(source) !== beforeHash) {
      throw new Error(`Security scenario source '${source}' changed during test execution.`);
    }
  }
}

export async function runHardhatTaskWithRuntimeScanRetry(
  runTask,
  {
    label = "Hardhat task",
    maxRetries = HARDHAT_RUNTIME_SCAN_MAX_RETRIES,
    delay = defaultRetryDelay,
    onRetry = (message) => console.warn(message),
    classifyError = isTransientInstitutionalRuntimeScanRace,
  } = {},
) {
  if (typeof runTask !== "function") throw new TypeError("Hardhat task runner must be a function");
  if (
    !Number.isSafeInteger(maxRetries)
    || maxRetries < 0
    || maxRetries > HARDHAT_RUNTIME_SCAN_RETRY_DELAYS_MS.length
  ) {
    throw new RangeError(
      `Hardhat runtime-scan retries must be an integer between 0 and ${HARDHAT_RUNTIME_SCAN_RETRY_DELAYS_MS.length}`,
    );
  }
  if (typeof delay !== "function") throw new TypeError("Hardhat retry delay must be a function");
  if (typeof onRetry !== "function") throw new TypeError("Hardhat retry observer must be a function");
  if (typeof classifyError !== "function") throw new TypeError("Hardhat retry classifier must be a function");

  for (let attempt = 0; ; attempt += 1) {
    try {
      return { result: await runTask(), retries: attempt };
    } catch (error) {
      if (!await classifyError(error) || attempt >= maxRetries) throw error;
      const retryNumber = attempt + 1;
      onRetry(
        `[security:scenarios] ${label} encountered a transient local-runtime temp-file scan race; `
        + `retry ${retryNumber}/${maxRetries}`,
      );
      await delay(HARDHAT_RUNTIME_SCAN_RETRY_DELAYS_MS[attempt]);
    }
  }
}

export async function isTransientInstitutionalRuntimeScanRace(
  error,
  managedRuntimeRoot = resolve(process.cwd(), ".runtime"),
) {
  if (!(error instanceof Error) || error.name !== "FileNotFoundError") return false;
  const cause = error.cause;
  if (!(cause instanceof Error) || cause.code !== "ENOENT" || typeof cause.path !== "string") return false;

  const temporaryName = basename(cause.path);
  const activityTemporary = /^institutional-demo-state\.json\.\d+(?:\.[0-9a-f]{32})?\.tmp$/i;
  const journalName = "(?:action-journal|relay-journal|attestor-0x[0-9a-f]{40})\\.json";
  const currentTemporary = new RegExp(`^${journalName}\\.\\d+\\.[0-9a-f]{32}\\.tmp$`, "i");
  const legacyTemporary = new RegExp(
    `^${journalName}\\.\\d+\\.\\d{13}\\.[0-9a-f]{1,64}\\.tmp$`,
    "i",
  );
  if (
    !activityTemporary.test(temporaryName)
    && !currentTemporary.test(temporaryName)
    && !legacyTemporary.test(temporaryName)
  ) return false;

  try {
    const [canonicalManagedRoot, canonicalParent] = await Promise.all([
      realpath(managedRuntimeRoot),
      realpath(dirname(cause.path)),
    ]);
    const relativeParent = relative(canonicalManagedRoot, canonicalParent);
    if (activityTemporary.test(temporaryName)) return relativeParent === "";
    return /^institutional-demo[\\/][0-9a-f]{8}-[0-9a-f]{8}$/i.test(relativeParent);
  } catch {
    return false;
  }
}

function defaultRetryDelay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
