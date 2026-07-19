import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { inspectChain, loadScaffold, rpcByNetworkKey, waitForProgress } from "./health.mjs";

const NETWORK_ROOT = process.env.BESU_NETWORK_ROOT || "networks/besu";
const COMPOSE_FILE = resolve(
  process.cwd(),
  process.env.BESU_COMPOSE_FILE || `${NETWORK_ROOT}/docker-compose.yml`,
);
const COMPOSE_PROJECT_NAME = process.env.BESU_COMPOSE_PROJECT_NAME;
const STARTUP_TIMEOUT_MS = Number(process.env.RPC_WAIT_TIMEOUT_MS || 300_000);

async function run(command, args) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) return resolveRun();
      rejectRun(new Error(`${command} exited with ${signal || `code ${code}`}`));
    });
  });
}

function composeServiceName(validator) {
  return validator.name.replaceAll("-", "_");
}

async function startNetwork(network) {
  const services = network.validators.map(composeServiceName);
  const projectArgs = COMPOSE_PROJECT_NAME ? ["-p", COMPOSE_PROJECT_NAME] : [];
  console.log(`[besu:start] Starting ${network.key} validators as one consensus group.`);
  await run("docker", ["compose", ...projectArgs, "-f", COMPOSE_FILE, "up", "-d", ...services]);

  const snapshot = await waitForProgress(network, rpcByNetworkKey(network.key), {
    timeoutMs: STARTUP_TIMEOUT_MS,
  });
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

main().catch((error) => {
  console.error(`[besu:start] ${error?.message || error}`);
  process.exitCode = 1;
});
