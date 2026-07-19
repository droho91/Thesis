import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const REPORT_PATH = resolve(
  process.cwd(),
  process.env.INSTITUTIONAL_SECURITY_REPORT_PATH || ".runtime/evidence/security-scenarios.json",
);

const SCENARIOS = Object.freeze([
  {
    id: "SEC-01",
    title: "Insufficient checkpoint quorum",
    test: "testRejectsInsufficientQuorum",
    control: "A checkpoint with fewer than three of four configured attestors is rejected.",
    source: "test/gateway/InstitutionalCheckpointClient.t.sol",
  },
  {
    id: "SEC-02",
    title: "Replay or forged commitment",
    test: "testReceiveRejectsReplayAndForgedCommitment",
    control: "The gateway rejects both duplicate receipt execution and a commitment that differs from proven storage.",
    source: "test/gateway/InstitutionalCrossChainGateway.t.sol",
  },
  {
    id: "SEC-03",
    title: "Suspended institutional identity",
    test: "testSuspendedIdentityBlocksOriginAndDestinationExecution",
    control: "Suspended customers cannot originate or receive institutional collateral messages.",
    source: "test/apps/InstitutionalCollateralApp.t.sol",
  },
  {
    id: "SEC-04",
    title: "Borrow cap violation",
    test: "testBorrowRespectsAccountAndAssetCaps",
    control: "Per-account and debt-asset policy caps reject excessive credit issuance.",
    source: "test/apps/BankPolicy.t.sol",
  },
  {
    id: "SEC-05",
    title: "Direct governance bypass",
    test: "testDirectAdministratorBypassIsRejected",
    control: "Sensitive administration cannot bypass the timelock after governance handoff.",
    source: "test/governance/InstitutionalGovernanceTimelock.t.sol",
  },
  {
    id: "SEC-06",
    title: "Duplicate business request",
    test: "testClientReferencePreventsDuplicateOriginSubmission",
    control: "A sender cannot reuse a client reference to lock or burn collateral twice.",
    source: "test/apps/InstitutionalCollateralApp.t.sol",
  },
  {
    id: "SEC-07",
    title: "Debt conservation under full repayment",
    test: "testFuzzRepayAllCollectsEveryClearedDebtUnit",
    control: "Fuzzed full repayments clear debt only when pool cash increases by the same amount.",
    source: "test/apps/LendingValuation.t.sol",
  },
  {
    id: "SEC-08",
    title: "Emergency pause with in-flight timeout",
    test: "testPauseStillAllowsProofCheckedTimeout",
    control: "Pause blocks new risk but still permits a proof-checked terminal timeout.",
    source: "test/gateway/InstitutionalCrossChainGateway.t.sol",
  },
  {
    id: "SEC-09",
    title: "Compliance hold during compensation",
    test: "testComplianceSuspensionKeepsRefundPendingUntilResolution",
    control: "A suspended sender's refund remains atomically pending and succeeds only after compliance resolution.",
    source: "test/apps/InstitutionalCollateralApp.t.sol",
  },
  {
    id: "SEC-10",
    title: "Unauthorized voucher transfer",
    test: "testVoucherCannotBeTransferredOutsideApprovedInstitutionalOperator",
    control: "Collateral receipts cannot move wallet-to-wallet outside an approved institutional operator.",
    source: "test/apps/BankPolicy.t.sol",
  },
  {
    id: "SEC-11",
    title: "Revoked credential reactivation",
    test: "testRevokedCredentialCannotBeReactivatedOrRenewed",
    control: "Revocation is terminal and cannot be converted back to an active credential.",
    source: "test/identity/InstitutionalIdentityRegistry.t.sol",
  },
]);

async function main() {
  const startedAt = new Date().toISOString();
  const grep = SCENARIOS.map((scenario) => scenario.test).join("|");
  const execution = await run(npmCommand(), ["run", "test:contracts", "--", "--grep", grep]);
  const finishedAt = new Date().toISOString();
  const scenarios = await Promise.all(SCENARIOS.map(async (scenario) => ({
    ...scenario,
    status: execution.output.includes(scenario.test) ? "passed" : "missing",
    sourceSha256: await sha256(resolve(process.cwd(), scenario.source)),
  })));
  if (execution.code !== 0 || scenarios.some((scenario) => scenario.status !== "passed")) {
    throw new Error(`Security scenario execution failed with code ${execution.code}`);
  }

  const report = {
    version: "institutional-security-scenarios-v1",
    status: "passed",
    startedAt,
    finishedAt,
    runtime: { node: process.version, platform: `${process.platform}/${process.arch}` },
    command: `npm run test:contracts -- --grep ${grep}`,
    outputSha256: createHash("sha256").update(execution.output).digest("hex"),
    scenarios,
  };
  await writeJsonAtomic(REPORT_PATH, report);
  console.log(`[security:scenarios] PASS ${scenarios.length}/${scenarios.length} report=${REPORT_PATH}`);
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: process.cwd(), env: process.env, shell: false });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => resolveRun({ code: code ?? 1, signal, output }));
  });
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
