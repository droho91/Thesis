import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { CHAIN_A_RPC, CHAIN_B_RPC } from "./runtime.mjs";

const ROOT = resolve(process.cwd(), process.env.BESU_NETWORK_ROOT || "networks/besu");
const PROGRESS_TIMEOUT_MS = Number(process.env.BESU_HEALTH_TIMEOUT_MS || 45_000);
const PROGRESS_BLOCKS = healthProgressBlocks();
const QUICK_CHECK = process.argv.includes("--quick");
const STARTUP_CHECK = process.argv.includes("--startup");

export function healthProgressBlocks(raw = process.env.BESU_HEALTH_PROGRESS_BLOCKS) {
  const blocks = Number(raw || 1);
  if (!Number.isSafeInteger(blocks) || blocks < 1 || blocks > 100) {
    throw new RangeError("BESU_HEALTH_PROGRESS_BLOCKS must be an integer between 1 and 100");
  }
  return BigInt(blocks);
}

export async function loadScaffold() {
  let scaffold;
  try {
    scaffold = JSON.parse(await readFile(resolve(ROOT, "scaffold.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Besu scaffold is missing; run npm run besu:generate before checking runtime health");
    }
    throw error;
  }
  if (scaffold.version !== "besu-qbft-scaffold-v4") throw new Error("Unsupported Besu scaffold version");
  if (scaffold.validatorCount < 4 || scaffold.byzantineFaultTolerance < 1) {
    throw new Error("QBFT health evidence requires at least four validators per chain");
  }
  return scaffold;
}

export async function inspectChain(
  network,
  rpc,
  { minimumPeers = network.validators.length - 1, minimumHeight = 1 } = {},
) {
  const [chainIdHex, heightHex, code, validatorAddresses, peerCountHex] = await Promise.all([
    rpcCall(rpc, "eth_chainId"),
    rpcCall(rpc, "eth_blockNumber"),
    rpcCall(rpc, "eth_getCode", [ethers.ZeroAddress, "latest"]),
    rpcCall(rpc, "qbft_getValidatorsByBlockNumber", ["latest"]),
    rpcCall(rpc, "net_peerCount"),
  ]);
  const chainId = Number(BigInt(chainIdHex));
  if (chainId !== network.chainId) throw new Error(`${network.key} RPC chain ${chainId} does not match ${network.chainId}`);
  if (typeof code !== "string") throw new Error(`${network.key} world state is unavailable`);
  const blockNumber = Number(BigInt(heightHex));
  if (blockNumber < minimumHeight) {
    throw new Error(`${network.key} is at block ${blockNumber}; expected at least ${minimumHeight}`);
  }

  const expected = network.validators.map((validator) => ethers.getAddress(validator.address)).sort(compareAddresses);
  const actual = validatorAddresses.map((address) => ethers.getAddress(address)).sort(compareAddresses);
  if (!sameAddressList(expected, actual)) {
    throw new Error(`${network.key} validator set does not match generated genesis profile`);
  }
  const peerCount = Number(BigInt(peerCountHex));
  if (peerCount < minimumPeers) {
    throw new Error(`${network.key} has ${peerCount} peers; expected at least ${minimumPeers}`);
  }
  return {
    key: network.key,
    chainId,
    blockNumber,
    peerCount,
    validatorCount: actual.length,
    validators: actual,
  };
}

export async function waitForProgress(network, rpc, {
  startHeight,
  blocks = PROGRESS_BLOCKS,
  timeoutMs = PROGRESS_TIMEOUT_MS,
  readinessTimeoutMs = timeoutMs,
  minimumPeers = network.validators.length - 1,
  pollIntervalMs = 1_000,
} = {}) {
  const initial = startHeight == null
    ? await waitForInitialHeight(network, rpc, readinessTimeoutMs, pollIntervalMs)
    : BigInt(startHeight);
  const target = initial + BigInt(blocks);
  const startedAt = Date.now();
  let latest = initial;
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      latest = BigInt(await rpcCall(rpc, "eth_blockNumber"));
      if (latest >= target) {
        try {
          const snapshot = await inspectChain(network, rpc, { minimumPeers, minimumHeight: Number(target) });
          return {
            ...snapshot,
            startBlock: Number(initial),
            blocksProduced: snapshot.blockNumber - Number(initial),
          };
        } catch (error) {
          // Block production and peer discovery can converge a few seconds apart on Docker Desktop.
          lastError = error;
        }
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(pollIntervalMs);
  }
  const detail = lastError ? ` Last readiness error: ${lastError.message || lastError}` : "";
  throw new Error(`${network.key} did not become healthy from block ${initial} to ${target}; latest=${latest}.${detail}`);
}

async function waitForInitialHeight(network, rpc, timeoutMs, pollIntervalMs) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return BigInt(await rpcCall(rpc, "eth_blockNumber"));
    } catch (error) {
      lastError = error;
      await sleep(pollIntervalMs);
    }
  }
  throw new Error(
    `${network.key} RPC did not become ready within ${Math.ceil(timeoutMs / 1_000)}s: ` +
      `${lastError?.message || "timeout"}`,
  );
}

export async function rpcCall(rpc, method, params = []) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(body.error.message || `${method} failed`);
    if (body.result == null) throw new Error(`${method} returned null`);
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

export function rpcByNetworkKey(key) {
  if (key === "chainA") return CHAIN_A_RPC;
  if (key === "chainB") return CHAIN_B_RPC;
  throw new Error(`No RPC configured for ${key}`);
}

async function main() {
  const scaffold = await loadScaffold();
  const timeoutMs = STARTUP_CHECK
    ? Number(process.env.RPC_WAIT_TIMEOUT_MS || 300_000)
    : PROGRESS_TIMEOUT_MS;
  const snapshots = await Promise.all(scaffold.networks.map((network) => {
    const rpc = rpcByNetworkKey(network.key);
    return QUICK_CHECK ? inspectChain(network, rpc) : waitForProgress(network, rpc, { timeoutMs });
  }));
  for (const snapshot of snapshots) {
    const progress = snapshot.startBlock == null
      ? `block=${snapshot.blockNumber}`
      : `blocks=${snapshot.startBlock}->${snapshot.blockNumber}`;
    console.log(`[qbft:health] ${snapshot.key} chainId=${snapshot.chainId} validators=${snapshot.validatorCount} ` +
      `peers=${snapshot.peerCount} ${progress}`);
  }
  console.log(`[qbft:health] four-validator QBFT runtime is ${QUICK_CHECK ? "ready" : "healthy"}`);
}

function compareAddresses(left, right) {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function sameAddressList(left, right) {
  return left.length === right.length && left.every((address, index) => address === right[index]);
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[qbft:health] ${error?.message || error}`);
    process.exitCode = 1;
  });
}
