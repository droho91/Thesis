import { execFile } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { loadScaffold, rpcByNetworkKey, rpcCall, waitForProgress } from "../ops/besu/health.mjs";

const execute = promisify(execFile);
const REPORT_PATH = resolve(
  process.cwd(),
  process.env.BESU_QBFT_FAULT_REPORT_PATH || ".runtime/besu-qbft-fault-report.json",
);
const STOP_TIMEOUT_MS = Number(process.env.BESU_FAULT_STOP_TIMEOUT_MS || 60_000);

async function main() {
  const scaffold = await loadScaffold();
  const faulted = scaffold.networks.map((network) => {
    const validator = network.validators.at(-1);
    return { network, validator, rpc: rpcByNetworkKey(network.key) };
  });
  const report = {
    version: "besu-qbft-fault-report-v1",
    status: "running",
    startedAt: new Date().toISOString(),
    validatorCount: scaffold.validatorCount,
    toleratedFaults: scaffold.byzantineFaultTolerance,
    faults: faulted.map(({ network, validator }) => ({
      network: network.key,
      container: validator.containerName,
      validator: validator.address,
    })),
  };

  let stopped = false;
  try {
    const starts = await Promise.all(
      faulted.map(async ({ rpc }) => BigInt(await rpcCall(rpc, "eth_blockNumber"))),
    );
    console.log(`[qbft:fault] stopping ${faulted.map(({ validator }) => validator.containerName).join(", ")}`);
    await Promise.all(
      faulted.map(({ validator }) => docker("stop", "--time", "20", validator.containerName)),
    );
    stopped = true;

    const duringFault = await Promise.all(
      faulted.map(({ network, rpc }, index) =>
        waitForProgress(network, rpc, {
          startHeight: starts[index],
          blocks: 3,
          timeoutMs: STOP_TIMEOUT_MS,
          minimumPeers: network.validators.length - 2,
        }),
      ),
    );
    report.duringFault = duringFault;
    console.log("[qbft:fault] both chains continued with one of four validators unavailable");

    await Promise.all(faulted.map(({ validator }) => docker("start", validator.containerName)));
    stopped = false;
    const afterRecovery = await Promise.all(
      faulted.map(({ network, rpc }, index) =>
        waitForPeerRecovery(network, rpc, BigInt(duringFault[index].blockNumber)),
      ),
    );
    report.afterRecovery = afterRecovery;
    report.status = "passed";
    report.finishedAt = new Date().toISOString();
    await writeJsonAtomic(REPORT_PATH, report);
    console.log(`[qbft:fault] PASS report=${REPORT_PATH}`);
  } catch (error) {
    report.status = "failed";
    report.finishedAt = new Date().toISOString();
    report.error = { message: error?.message || String(error), stack: error?.stack };
    await writeJsonAtomic(REPORT_PATH, report).catch(() => {});
    throw error;
  } finally {
    if (stopped) {
      await Promise.allSettled(faulted.map(({ validator }) => docker("start", validator.containerName)));
    }
  }
}

async function waitForPeerRecovery(network, rpc, startHeight) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < STOP_TIMEOUT_MS) {
    try {
      return await waitForProgress(network, rpc, {
        startHeight,
        blocks: 2,
        timeoutMs: 8_000,
        minimumPeers: network.validators.length - 1,
      });
    } catch (error) {
      lastError = error;
      await sleep(1_000);
    }
  }
  throw new Error(`${network.key} validator did not rejoin: ${lastError?.message || "timeout"}`);
}

async function docker(...args) {
  await execute("docker", args, { timeout: STOP_TIMEOUT_MS });
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
