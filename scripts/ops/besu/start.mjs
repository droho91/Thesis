import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectChain, loadScaffold, rpcByNetworkKey, waitForProgress } from "./health.mjs";

const NETWORK_ROOT = process.env.BESU_NETWORK_ROOT || "networks/besu";
const COMPOSE_FILE = resolve(
  process.cwd(),
  process.env.BESU_COMPOSE_FILE || `${NETWORK_ROOT}/docker-compose.yml`,
);
const COMPOSE_PROJECT_NAME = process.env.BESU_COMPOSE_PROJECT_NAME;
const STARTUP_TIMEOUT_MS = Number(process.env.RPC_WAIT_TIMEOUT_MS || 300_000);
const INITIAL_PROGRESS_TIMEOUT_MS = Number(process.env.BESU_START_PROGRESS_TIMEOUT_MS || 60_000);
const AUTO_RECOVER_STALLED_CONSENSUS = process.env.BESU_START_AUTO_RECOVER?.toLowerCase() !== "false";

async function run(command, args) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      // Docker Desktop's WSL proxy can lose an old cwd handle on /mnt/c while
      // consensus readiness is being polled. All Compose file arguments are
      // absolute, so use the native temporary directory as a stable cwd.
      cwd: tmpdir(),
      stdio: ["inherit", "pipe", "pipe"],
      shell: false,
    });
    let output = "";
    const record = (stream, chunk) => {
      stream.write(chunk);
      output = `${output}${chunk}`.slice(-8_192);
    };
    child.stdout?.on("data", (chunk) => record(process.stdout, chunk));
    child.stderr?.on("data", (chunk) => record(process.stderr, chunk));
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) return resolveRun();
      const error = new Error(`${command} exited with ${signal || `code ${code}`}`);
      error.output = output;
      rejectRun(error);
    });
  });
}

export function isTransientComposeWorkingDirectoryError(error) {
  return /getwd:\s*no such file or directory/i.test(error?.output || "");
}

export async function runComposeWithCwdRetry(args, { runCommand = run } = {}) {
  try {
    await runCommand("docker", ["compose", ...args]);
  } catch (error) {
    if (!isTransientComposeWorkingDirectoryError(error)) throw error;
    console.warn("[besu:start] Docker Desktop WSL cwd proxy was temporarily unavailable; retrying once.");
    await runCommand("docker", ["compose", ...args]);
  }
}

function composeServiceName(validator) {
  return validator.name.replaceAll("-", "_");
}

async function startNetwork(network) {
  const services = network.validators.map(composeServiceName);
  const projectArgs = COMPOSE_PROJECT_NAME ? ["-p", COMPOSE_PROJECT_NAME] : [];
  console.log(`[besu:start] Starting ${network.key} validators as one consensus group.`);
  await runComposeWithCwdRetry([
    ...projectArgs,
    "-f",
    COMPOSE_FILE,
    "up",
    "-d",
    ...services,
  ]);

  const rpc = rpcByNetworkKey(network.key);
  let snapshot;
  try {
    snapshot = await waitForProgress(network, rpc, {
      timeoutMs: INITIAL_PROGRESS_TIMEOUT_MS,
      readinessTimeoutMs: STARTUP_TIMEOUT_MS,
    });
  } catch (error) {
    if (!AUTO_RECOVER_STALLED_CONSENSUS) throw error;

    try {
      await inspectChain(network, rpc);
    } catch {
      // Restarting cannot repair an unavailable RPC, invalid validator set, or incomplete peer topology.
      throw error;
    }

    console.warn(
      `[besu:start] ${network.key} RPC topology is ready but consensus is not progressing; ` +
        "restarting this chain's validators once.",
    );
    await runComposeWithCwdRetry([
      ...projectArgs,
      "-f",
      COMPOSE_FILE,
      "restart",
      ...services,
    ]);
    snapshot = await waitForProgress(network, rpc, {
      timeoutMs: INITIAL_PROGRESS_TIMEOUT_MS,
      readinessTimeoutMs: STARTUP_TIMEOUT_MS,
    });
    console.log(`[besu:start] ${network.key} consensus recovered without deleting chain data.`);
  }
  console.log(
    `[besu:start] ${network.key} ready: validators=${snapshot.validatorCount} ` +
      `peers=${snapshot.peerCount} blocks=${snapshot.startBlock}->${snapshot.blockNumber}`,
  );
}

async function main() {
  const scaffold = await loadScaffold();

  // Starting one four-validator chain at a time avoids eight JVMs competing during genesis initialization.
  for (const network of scaffold.networks) await startNetwork(network);

  const snapshots = await Promise.all(
    scaffold.networks.map((network) => inspectChain(network, rpcByNetworkKey(network.key))),
  );
  for (const snapshot of snapshots) {
    console.log(
      `[qbft:health] ${snapshot.key} chainId=${snapshot.chainId} validators=${snapshot.validatorCount} ` +
        `peers=${snapshot.peerCount} block=${snapshot.blockNumber}`,
    );
  }
  console.log("[besu:start] both QBFT bank chains are ready.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[besu:start] ${error?.message || error}`);
    process.exitCode = 1;
  });
}
