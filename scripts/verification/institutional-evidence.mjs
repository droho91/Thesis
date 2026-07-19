import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { ethers } from "ethers";
import { collectRepositoryProvenance, sha256File } from "./provenance.mjs";

const NETWORK_ROOT = ".runtime/besu-qbft-evidence";
const EVIDENCE_ROOT = ".runtime/evidence";
const COMPOSE_PATH = resolve(process.cwd(), NETWORK_ROOT, "docker-compose.yml");
const SUMMARY_PATH = resolve(process.cwd(), EVIDENCE_ROOT, "runtime-evidence-summary.json");
const PROJECT_NAME = "thesis-qbft-evidence";
const KEEP_RUNNING = process.argv.includes("--keep-running");
const SUMMARIZE_EXISTING = process.argv.includes("--summarize-existing");
const ALLOW_DIRTY = process.argv.includes("--allow-dirty");
const baseEnvironment = {
  ...process.env,
  BESU_NETWORK_ROOT: NETWORK_ROOT,
  BESU_VALIDATOR_COUNT: "4",
  BESU_CHAIN_A_RPC_PORT: "18545",
  BESU_CHAIN_B_RPC_PORT: "19545",
  BESU_SUBNET_SECOND_OCTET: "31",
  BESU_CONTAINER_PREFIX: "thesis-evidence",
  BESU_COMPOSE_PROJECT_NAME: PROJECT_NAME,
  BESU_HEALTH_TIMEOUT_MS: process.env.BESU_HEALTH_TIMEOUT_MS || "180000",
  BESU_FAULT_STOP_TIMEOUT_MS: process.env.BESU_FAULT_STOP_TIMEOUT_MS || "90000",
  CHAIN_A_RPC: "http://127.0.0.1:18545",
  CHAIN_B_RPC: "http://127.0.0.1:19545",
  INSTITUTIONAL_DEPLOYMENT_PATH: `${EVIDENCE_ROOT}/institutional-deployment.json`,
  INSTITUTIONAL_ATTESTOR_SECRETS_PATH: `${EVIDENCE_ROOT}/institutional-attestor-secrets.json`,
  INSTITUTIONAL_INTEGRATION_REPORT_PATH: `${EVIDENCE_ROOT}/institutional-integration-report.json`,
  INSTITUTIONAL_SECURITY_REPORT_PATH: `${EVIDENCE_ROOT}/security-scenarios.json`,
  INSTITUTIONAL_BENCHMARK_MESSAGES: process.env.INSTITUTIONAL_BENCHMARK_MESSAGES || "100",
  INSTITUTIONAL_BENCHMARK_REQUIRED_SAMPLES: process.env.INSTITUTIONAL_BENCHMARK_REQUIRED_SAMPLES || "100",
  INSTITUTIONAL_BENCHMARK_TARGET_P95_MS: process.env.INSTITUTIONAL_BENCHMARK_TARGET_P95_MS || "45000",
  INSTITUTIONAL_ENFORCE_BENCHMARK: "true",
  BESU_QBFT_FAULT_REPORT_PATH: `${EVIDENCE_ROOT}/besu-qbft-fault-report.json`,
};

const summary = {
  version: "institutional-runtime-evidence-v2",
  status: "running",
  startedAt: new Date().toISOString(),
  topology: {
    chains: 2,
    validatorsPerChain: 4,
    toleratedFaultsPerChain: 1,
    rpc: { A: baseEnvironment.CHAIN_A_RPC, B: baseEnvironment.CHAIN_B_RPC },
  },
  steps: [],
};
let runtimeMayBeRunning = false;

async function main() {
  summary.provenance = await collectRepositoryProvenance();
  summary.formalEvidenceEligible = summary.provenance.formalEvidenceEligible;
  if (!summary.formalEvidenceEligible && !ALLOW_DIRTY) {
    throw new Error(
      `Formal evidence requires a clean Git worktree; found ${summary.provenance.git.changedFileCount} changed file(s). `
      + "Commit the reviewed implementation, or use --allow-dirty only for non-formal calibration.",
    );
  }
  if (ALLOW_DIRTY) summary.nonFormalCalibration = true;
  if (SUMMARIZE_EXISTING) {
    const previous = await readJson(SUMMARY_PATH);
    if (!previous.provenance?.sourceTreeSha256) {
      throw new Error("Existing evidence has no source provenance and cannot be reused");
    }
    if (previous.provenance.sourceTreeSha256 !== summary.provenance.sourceTreeSha256) {
      throw new Error("Existing evidence was produced from a different source tree and cannot be reused");
    }
    await collectEvidence();
    summary.status = ALLOW_DIRTY ? "calibration-passed" : "passed";
    summary.reusedExistingEvidence = true;
    summary.finishedAt = new Date().toISOString();
    await writeJsonAtomic(SUMMARY_PATH, summary);
    console.log(`[institutional:evidence] existing evidence is consistent: ${SUMMARY_PATH}`);
    return;
  }
  await step("docker-ready", process.execPath, ["scripts/ops/besu/ensure-docker.mjs"]);
  await step("compile", npmCommand(), ["run", "compile"]);
  if (await exists(COMPOSE_PATH)) await composeDown("previous-evidence-runtime");
  await rm(resolve(process.cwd(), NETWORK_ROOT), { recursive: true, force: true });
  await rm(resolve(process.cwd(), EVIDENCE_ROOT), { recursive: true, force: true });
  await step("security-scenarios", process.execPath, ["scripts/verification/security-scenarios.mjs"]);
  await step("generate-qbft", process.execPath, ["scripts/ops/besu/generate.mjs"]);
  await step("validate-config", process.execPath, ["scripts/ops/besu/validate-config.mjs"]);
  runtimeMayBeRunning = true;
  await step("start-qbft", process.execPath, ["scripts/ops/besu/start.mjs"]);
  await step("qbft-health", process.execPath, ["scripts/ops/besu/health.mjs", "--startup"]);
  await step("qbft-fault-recovery", process.execPath, ["scripts/verification/qbft-fault-tolerance.mjs"]);
  await step("deploy-institutional", process.execPath, ["scripts/ops/deployment/deploy-stack.mjs"]);
  await step("governance-handoff", process.execPath, ["scripts/ops/deployment/finalize-governance.mjs"]);
  await step("integration-chaos", process.execPath, ["scripts/verification/institutional-integration.mjs"]);

  await collectEvidence();
  summary.status = ALLOW_DIRTY ? "calibration-passed" : "passed";
  summary.finishedAt = new Date().toISOString();
  await writeJsonAtomic(SUMMARY_PATH, summary);

  if (!KEEP_RUNNING) {
    await composeDown("stop-evidence-runtime");
    runtimeMayBeRunning = false;
    summary.runtimeStopped = true;
    await writeJsonAtomic(SUMMARY_PATH, summary);
  } else {
    summary.runtimeStopped = false;
    await writeJsonAtomic(SUMMARY_PATH, summary);
  }
  console.log(`[institutional:evidence] ${ALLOW_DIRTY ? "CALIBRATION PASS" : "PASS"} summary=${SUMMARY_PATH}`);
}

async function collectEvidence() {
  const deployment = await readJson(resolve(process.cwd(), baseEnvironment.INSTITUTIONAL_DEPLOYMENT_PATH));
  const fault = await readJson(resolve(process.cwd(), baseEnvironment.BESU_QBFT_FAULT_REPORT_PATH));
  const integration = await readJson(resolve(process.cwd(), baseEnvironment.INSTITUTIONAL_INTEGRATION_REPORT_PATH));
  const security = await readJson(resolve(process.cwd(), baseEnvironment.INSTITUTIONAL_SECURITY_REPORT_PATH));
  if (deployment.securityProfile?.governanceMode !== "timelock-enforced") {
    throw new Error("Evidence deployment did not complete governance handoff");
  }
  if (fault.status !== "passed" || integration.status !== "passed" || security.status !== "passed") {
    throw new Error("Runtime, validator-fault and security reports are not all passing");
  }
  if (integration.benchmark?.status !== "passed") throw new Error("Formal benchmark acceptance did not pass");
  const reportPaths = {
    deployment: baseEnvironment.INSTITUTIONAL_DEPLOYMENT_PATH,
    fault: baseEnvironment.BESU_QBFT_FAULT_REPORT_PATH,
    integration: baseEnvironment.INSTITUTIONAL_INTEGRATION_REPORT_PATH,
    security: baseEnvironment.INSTITUTIONAL_SECURITY_REPORT_PATH,
  };
  summary.evidence = {
    governanceMode: deployment.securityProfile.governanceMode,
    faultReport: baseEnvironment.BESU_QBFT_FAULT_REPORT_PATH,
    integrationReport: baseEnvironment.INSTITUTIONAL_INTEGRATION_REPORT_PATH,
    integrationTests: integration.tests,
    benchmark: integration.benchmark,
    securityScenarios: security.scenarios,
    deployedBytecode: await deployedBytecodeEvidence(deployment),
    reportChecksums: Object.fromEntries(
      await Promise.all(Object.entries(reportPaths).map(async ([name, path]) => [
        name,
        await sha256File(resolve(process.cwd(), path)),
      ])),
    ),
  };
}

async function deployedBytecodeEvidence(deployment) {
  const result = {};
  for (const key of ["A", "B"]) {
    const provider = new ethers.JsonRpcProvider(deployment.chains[key].rpc);
    try {
      result[key] = {};
      for (const [name, contract] of Object.entries(deployment.chains[key].contracts || {})) {
        if (!ethers.isAddress(contract?.address)) continue;
        const code = await provider.getCode(contract.address);
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
  await run("docker", ["compose", "-p", PROJECT_NAME, "-f", COMPOSE_PATH, "down"]);
  summary.steps.push({ name, status: "passed", durationMs: Date.now() - startedAt });
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

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function exists(path) {
  return access(path).then(() => true).catch(() => false);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

main().catch(async (error) => {
  summary.status = "failed";
  summary.finishedAt = new Date().toISOString();
  summary.error = { message: error?.message || String(error), stack: error?.stack };
  if (!SUMMARIZE_EXISTING) await writeJsonAtomic(SUMMARY_PATH, summary).catch(() => {});
  console.error(error?.stack || error);
  if (runtimeMayBeRunning) {
    console.error("[institutional:evidence] runtime left running for diagnostics; use Docker Compose down after inspection");
  } else {
    console.error("[institutional:evidence] stopped before the isolated runtime was started");
  }
  process.exitCode = 1;
});
