import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { ethers } from "ethers";
import { readJson, writeJsonAtomic } from "../../services/shared/json-file.mjs";
import { providerForRpc, readContractCode } from "../ops/besu/runtime.mjs";
import { resolveSafeBesuNetworkRoot } from "../ops/besu/safe-network-root.mjs";
import {
  assertEnvironmentMatchesEvidenceSecurityProfile,
  assertEvidenceCliArguments,
  createEvidenceExecutionContext,
  validateCollectedEvidenceSecurityProfile,
} from "./evidence-environment.mjs";
import {
  assertRepositoryProvenanceStable,
  collectRepositoryProvenance,
  sha256File,
} from "./provenance.mjs";
import { withProcessLock } from "./process-lock.mjs";
import { resolveSafeEvidencePaths } from "./safe-evidence-paths.mjs";
import { validateSecurityScenarioReport } from "./security-scenario-results.mjs";
import { SCENARIOS as EXPECTED_SECURITY_SCENARIOS } from "./security-scenarios.mjs";

const SUMMARY_VERSION = "institutional-runtime-evidence-v4";
const EXPECTED_COMPONENT_REPORT_FILES = Object.freeze([
  "besu-qbft-fault-report.json",
  "institutional-deployment.json",
  "institutional-integration-report.json",
  "security-scenarios.json",
]);
const EXPECTED_EVIDENCE_CONTAINERS = Object.freeze([
  ...Array.from({ length: 4 }, (_, index) => `thesis-evidence-bank-a-validator-${index + 1}`),
  ...Array.from({ length: 4 }, (_, index) => `thesis-evidence-bank-b-validator-${index + 1}`),
]);
const HARDHAT_CLI_PATH = resolve(process.cwd(), "node_modules/hardhat/dist/src/cli.js");
assertEvidenceCliArguments(process.argv.slice(2));
const KEEP_RUNNING = process.argv.includes("--keep-running");
const ALLOW_DIRTY = process.argv.includes("--allow-dirty");
const { environment: baseEnvironment, securityProfile } = createEvidenceExecutionContext(process.env);
const PROJECT_NAME = baseEnvironment.BESU_COMPOSE_PROJECT_NAME;

const summary = {
  version: SUMMARY_VERSION,
  status: "running",
  startedAt: new Date().toISOString(),
  securityProfile,
  topology: {
    chains: 2,
    validatorsPerChain: 4,
    toleratedFaultsPerChain: 1,
    rpc: { A: baseEnvironment.CHAIN_A_RPC, B: baseEnvironment.CHAIN_B_RPC },
  },
  steps: [],
};
let runtimeMayBeRunning = false;
let managedPaths;

async function main() {
  summary.provenance = await collectRepositoryProvenance(baseEnvironment);
  summary.formalEvidenceEligible = summary.provenance.formalEvidenceEligible;
  if (!summary.formalEvidenceEligible && !ALLOW_DIRTY) {
    throw new Error(
      `Defense evidence requires a clean Git worktree; found ${summary.provenance.git.changedFileCount} changed file(s). `
      + "Commit the reviewed implementation, or use --allow-dirty only for non-eligible calibration.",
    );
  }
  if (ALLOW_DIRTY) summary.nonFormalCalibration = true;
  await step("docker-ready", process.execPath, ["scripts/ops/besu/ensure-docker.mjs"]);
  await step("compile", process.execPath, [HARDHAT_CLI_PATH, "compile", "--force"]);
  await withProcessLock(
    managedPaths.securityLockPath,
    async () => {
      await stopPreviousEvidenceRuntime();
      await rm(managedPaths.networkRoot, { recursive: true, force: true });
      await rm(managedPaths.evidenceRoot, { recursive: true, force: true });
    },
    {
      label: "institutional-evidence-bundle-reset",
      // A local restart may recover only a well-formed lock whose recorded PID
      // the OS confirms is gone; foreign or unverifiable owners still fail closed.
      reclaimOrphaned: true,
    },
  );
  await step("security-scenarios", process.execPath, ["scripts/verification/security-scenarios.mjs"]);
  await step("generate-qbft", process.execPath, ["scripts/ops/besu/generate.mjs"]);
  await step("validate-config", process.execPath, ["scripts/ops/besu/validate-config.mjs"]);
  runtimeMayBeRunning = true;
  await step("start-qbft", process.execPath, ["scripts/ops/besu/start.mjs"]);
  await step("qbft-health", process.execPath, ["scripts/ops/besu/health.mjs", "--startup"]);
  await step("qbft-validator-availability", process.execPath, ["scripts/verification/qbft-fault-tolerance.mjs"]);
  await step("deploy-institutional", process.execPath, ["scripts/ops/deployment/deploy-stack.mjs"]);
  await step("governance-handoff", process.execPath, ["scripts/ops/deployment/finalize-governance.mjs"]);
  await step("integration-chaos", process.execPath, ["scripts/verification/institutional-integration.mjs"]);

  await collectEvidence();
  summary.completionProvenance = await collectRepositoryProvenance(baseEnvironment);
  assertRepositoryProvenanceStable(summary.provenance, summary.completionProvenance);
  summary.status = ALLOW_DIRTY ? "calibration-passed" : "passed";
  summary.finishedAt = new Date().toISOString();
  await writeJsonAtomic(managedPaths.summaryPath, summary);

  if (!KEEP_RUNNING) {
    await composeDown("stop-evidence-runtime");
    runtimeMayBeRunning = false;
    summary.runtimeStopped = true;
    await writeJsonAtomic(managedPaths.summaryPath, summary);
  } else {
    summary.runtimeStopped = false;
    await writeJsonAtomic(managedPaths.summaryPath, summary);
  }
  console.log(
    `[institutional:evidence] ${ALLOW_DIRTY ? "CALIBRATION PASS" : "PASS"} summary=${managedPaths.summaryPath}`,
  );
}

async function collectEvidence() {
  assertEnvironmentMatchesEvidenceSecurityProfile(baseEnvironment, summary.securityProfile);
  await assertExactComponentReportBundle();
  const reportPaths = {
    deployment: resolve(managedPaths.evidenceRoot, "institutional-deployment.json"),
    fault: resolve(managedPaths.evidenceRoot, "besu-qbft-fault-report.json"),
    integration: resolve(managedPaths.evidenceRoot, "institutional-integration-report.json"),
    security: managedPaths.securityReportPath,
  };
  const [deployment, fault, integration, security] = await Promise.all([
    readJson(reportPaths.deployment),
    readJson(reportPaths.fault),
    readJson(reportPaths.integration),
    readJson(reportPaths.security),
  ]);
  validateCollectedEvidenceSecurityProfile({ deployment, fault, integration }, summary.securityProfile);
  const [sourceSha256ByPath, hardhatPackage] = await Promise.all([
    hashSecurityScenarioSources(),
    readJson(resolve(process.cwd(), "node_modules/hardhat/package.json")),
  ]);
  validateSecurityScenarioReport(security, EXPECTED_SECURITY_SCENARIOS, {
    sourceSha256ByPath,
    hardhatVersion: hardhatPackage.version,
  });
  summary.evidence = {
    governanceMode: deployment.securityProfile.governanceMode,
    effectiveSecurityProfileChecksum: summary.securityProfile.provenance.checksum,
    faultReport: baseEnvironment.BESU_QBFT_FAULT_REPORT_PATH,
    integrationReport: baseEnvironment.INSTITUTIONAL_INTEGRATION_REPORT_PATH,
    integrationTests: integration.tests,
    benchmark: integration.benchmark,
    liveClientProofValidation: integration.liveClientProofValidation,
    securityScenarios: security.scenarios,
    deployedBytecode: await deployedBytecodeEvidence(deployment),
    reportChecksums: Object.fromEntries(
      await Promise.all(Object.entries(reportPaths).map(async ([name, path]) => [
        name,
        await sha256File(path),
      ])),
    ),
  };
}

async function hashSecurityScenarioSources() {
  const paths = [...new Set(EXPECTED_SECURITY_SCENARIOS.map((scenario) => scenario.source))];
  return new Map(await Promise.all(paths.map(async (path) => [
    path,
    await sha256File(resolve(process.cwd(), path)),
  ])));
}

async function deployedBytecodeEvidence(deployment) {
  const result = {};
  for (const key of ["A", "B"]) {
    const provider = providerForRpc(deployment.chains[key].rpc);
    try {
      result[key] = {};
      for (const [name, contract] of Object.entries(deployment.chains[key].contracts || {})) {
        if (!ethers.isAddress(contract?.address)) {
          throw new Error(`${key}.${name} has an invalid deployment address`);
        }
        const code = await readContractCode(provider, contract.address, { label: `${key}.${name}` });
        if (code === "0x") throw new Error(`${key}.${name} has no deployed bytecode`);
        result[key][name] = {
          address: ethers.getAddress(contract.address),
          bytecodeHash: ethers.keccak256(code),
          bytecodeBytes: (code.length - 2) / 2,
        };
      }
    } finally {
      provider.destroy();
    }
  }
  return result;
}

async function step(name, command, args) {
  const startedAt = Date.now();
  console.log(`[institutional:evidence] ${name}`);
  await run(command, args);
  summary.steps.push({ name, status: "passed", durationMs: Date.now() - startedAt });
}

async function composeDown(name) {
  const startedAt = Date.now();
  await run("docker", ["compose", "-p", PROJECT_NAME, "-f", managedPaths.composePath, "down"]);
  summary.steps.push({ name, status: "passed", durationMs: Date.now() - startedAt });
}

async function stopPreviousEvidenceRuntime() {
  const startedAt = Date.now();
  const projectLabel = `label=com.docker.compose.project=${PROJECT_NAME}`;
  const [containerOutput, networkOutput, volumeOutput] = await Promise.all([
    commandOutput("docker", ["container", "ls", "--all", "--filter", projectLabel, "--format", "{{.Names}}"]),
    commandOutput("docker", ["network", "ls", "--filter", projectLabel, "--format", "{{.Name}}"]),
    commandOutput("docker", ["volume", "ls", "--filter", projectLabel, "--format", "{{.Name}}"]),
  ]);
  const containers = outputLines(containerOutput);
  const networks = outputLines(networkOutput);
  const volumes = outputLines(volumeOutput);
  assertExpectedDockerResources(containers, EXPECTED_EVIDENCE_CONTAINERS, "container");
  assertExpectedDockerResources(networks, [`${PROJECT_NAME}_thesis_besu`], "network");
  if (volumes.length > 0) {
    throw new Error(`Evidence Docker project has unexpected named volume(s): ${volumes.join(", ")}`);
  }
  if (containers.length > 0) {
    await run("docker", ["container", "stop", "--time", "30", ...containers]);
    await run("docker", ["container", "rm", ...containers]);
  }
  if (networks.length > 0) await run("docker", ["network", "rm", ...networks]);
  summary.steps.push({
    name: "previous-evidence-runtime",
    status: "passed",
    durationMs: Date.now() - startedAt,
    resourcesRemoved: containers.length + networks.length,
  });
}

function assertExpectedDockerResources(actual, expected, kind) {
  const allowed = new Set(expected);
  const unexpected = actual.filter((name) => !allowed.has(name));
  if (unexpected.length > 0) {
    throw new Error(`Evidence Docker project has unexpected ${kind}(s): ${unexpected.join(", ")}`);
  }
}

function outputLines(value) {
  return value ? value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
}

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: baseEnvironment,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? signal}`));
    });
  });
}

function commandOutput(command, args) {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: baseEnvironment,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveOutput(stdout.trim());
      else reject(new Error(
        stderr.trim() || `${command} ${args.join(" ")} exited with ${code ?? signal}`,
      ));
    });
  });
}

async function assertExactComponentReportBundle() {
  const entries = await readdir(managedPaths.evidenceRoot, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (
    names.length !== EXPECTED_COMPONENT_REPORT_FILES.length
    || names.some((name, index) => name !== EXPECTED_COMPONENT_REPORT_FILES[index])
    || entries.some((entry) => !entry.isFile())
  ) {
    throw new Error("Public evidence bundle contains missing, unexpected or non-regular component artifacts");
  }
}

async function runExclusive() {
  const [evidencePaths, networkRoot] = await Promise.all([
    resolveSafeEvidencePaths(),
    resolveSafeBesuNetworkRoot(baseEnvironment.BESU_NETWORK_ROOT),
  ]);
  managedPaths = Object.freeze({
    ...evidencePaths,
    networkRoot,
    composePath: resolve(networkRoot, "docker-compose.yml"),
  });
  await withProcessLock(
    managedPaths.institutionalLockPath,
    async () => {
      try {
        await main();
      } catch (error) {
        summary.status = "failed";
        summary.finishedAt = new Date().toISOString();
        summary.error = { message: error?.message || String(error), stack: error?.stack };
        await writeJsonAtomic(managedPaths.summaryPath, summary).catch(() => {});
        throw error;
      }
    },
    {
      label: "institutional-runtime-evidence",
      metadata: { summaryPath: managedPaths.summaryPath },
      // Avoid a manual lock-file repair after an abrupt local evidence-runner
      // exit without weakening the live/foreign-owner exclusion boundary.
      reclaimOrphaned: true,
    },
  );
}

runExclusive().catch((error) => {
  console.error(error?.stack || error);
  if (runtimeMayBeRunning) {
    console.error("[institutional:evidence] runtime left running for diagnostics; use Docker Compose down after inspection");
  } else {
    console.error("[institutional:evidence] stopped before the isolated runtime was started");
  }
  process.exitCode = 1;
});
