import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { writeJsonAtomic } from "../../services/shared/json-file.mjs";
import { loadScaffold, rpcByNetworkKey, rpcCall, waitForProgress } from "../ops/besu/health.mjs";

const execute = promisify(execFile);
const REPORT_PATH = resolve(
  process.cwd(),
  process.env.BESU_QBFT_FAULT_REPORT_PATH || ".runtime/besu-qbft-fault-report.json",
);
const STOP_TIMEOUT_MS = Number(process.env.BESU_FAULT_STOP_TIMEOUT_MS || 60_000);

async function main() {
  const scaffold = await loadScaffold();
  const unavailable = scaffold.networks.map((network) => {
    const validator = network.validators.at(-1);
    return { network, validator, rpc: rpcByNetworkKey(network.key) };
  });
  const report = {
    version: "besu-qbft-validator-availability-report-v2",
    status: "running",
    startedAt: new Date().toISOString(),
    validatorCount: scaffold.validatorCount,
    toleratedFaults: scaffold.byzantineFaultTolerance,
    testModel: "single-validator crash/unavailability; no Byzantine behavior is injected",
    validatorUnavailable: unavailable.map(({ network, validator }) => ({
      network: network.key,
      container: validator.containerName,
      validator: validator.address,
    })),
  };

  let stopped = false;
  try {
    const starts = await Promise.all(
      unavailable.map(async ({ rpc }) => BigInt(await rpcCall(rpc, "eth_blockNumber"))),
    );
    console.log(`[qbft:availability] stopping ${unavailable.map(({ validator }) => validator.containerName).join(", ")}`);
    await Promise.all(
      unavailable.map(({ validator }) => docker("stop", "--time", "20", validator.containerName)),
    );
    stopped = true;

    const duringUnavailability = await Promise.all(
      unavailable.map(({ network, rpc }, index) =>
        waitForProgress(network, rpc, {
          startHeight: starts[index],
          blocks: 3,
          timeoutMs: STOP_TIMEOUT_MS,
          minimumPeers: network.validators.length - 2,
        }),
      ),
    );
    report.duringUnavailability = duringUnavailability;
    console.log("[qbft:availability] both chains continued with one of four validators unavailable");

    await Promise.all(unavailable.map(({ validator }) => docker("start", validator.containerName)));
    stopped = false;
    const afterRecovery = await Promise.all(
      unavailable.map(({ network, rpc }, index) =>
        waitForPeerRecovery(network, rpc, BigInt(duringUnavailability[index].blockNumber)),
      ),
    );
    report.afterRecovery = afterRecovery;
    report.status = "passed";
    report.finishedAt = new Date().toISOString();
    await writeJsonAtomic(REPORT_PATH, report);
    console.log(`[qbft:availability] PASS report=${REPORT_PATH}`);
  } catch (error) {
    report.status = "failed";
    report.finishedAt = new Date().toISOString();
    report.error = { message: error?.message || String(error), stack: error?.stack };
    await writeJsonAtomic(REPORT_PATH, report).catch(() => {});
    throw error;
  } finally {
    if (stopped) {
      await Promise.allSettled(unavailable.map(({ validator }) => docker("start", validator.containerName)));
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

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
