import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ethers } from "ethers";

export const CHAIN_A_RPC = process.env.CHAIN_A_RPC || "http://127.0.0.1:8545";
export const CHAIN_B_RPC = process.env.CHAIN_B_RPC || "http://127.0.0.1:9545";

function runtimeDefaults() {
  return { mode: "besu", proofPolicy: "storage-required" };
}

export function normalizeRuntime(config = {}) {
  const defaults = runtimeDefaults();
  const runtime = config.runtime || {};
  const mode = process.env.RUNTIME_MODE || runtime.mode || defaults.mode;
  const proofPolicy = process.env.PROOF_POLICY || runtime.proofPolicy || defaults.proofPolicy;
  return {
    mode,
    proofPolicy,
    besuFirst: mode === "besu",
    allowMerkleFallback: proofPolicy !== "storage-required",
  };
}

export function defaultBesuRuntimeEnv() {
  process.env.USE_BESU_KEYS ||= "true";
  process.env.RUNTIME_MODE ||= "besu";
  process.env.PROOF_POLICY ||= "storage-required";
}

function useBesuKeys() {
  return process.env.USE_BESU_KEYS === "true";
}

function parseIndices(raw, fallback) {
  const text = raw ?? fallback;
  return text
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value >= 0);
}

function chainFolder(chainKey) {
  if (chainKey === "A" || chainKey === "chainA") return "chainA";
  if (chainKey === "B" || chainKey === "chainB") return "chainB";
  return chainKey;
}

function operatorLabel(index) {
  if (index === 0) return "deployer";
  if (index === 1) return "user";
  if (index === 2) return "relayer";
  throw new Error(`No Besu operator mapping exists for signer index ${index}. Use index 0, 1, or 2.`);
}

async function loadBesuJson(chainKey, file) {
  const path = resolve(process.cwd(), "networks", "besu", chainFolder(chainKey), file);
  return JSON.parse(await readFile(path, "utf8"));
}

async function networkTransactionCount(signer, address) {
  const [latest, pending, rpcLatest, rpcPending] = await Promise.all([
    signer.provider.getTransactionCount(address, "latest"),
    signer.provider.getTransactionCount(address, "pending"),
    signer.provider.send("eth_getTransactionCount", [address, "latest"]),
    signer.provider.send("eth_getTransactionCount", [address, "pending"]),
  ]);
  return Math.max(latest, pending, Number(BigInt(rpcLatest)), Number(BigInt(rpcPending)));
}

function isNonceExpired(error) {
  const text = [
    error?.code,
    error?.shortMessage,
    error?.message,
    error?.info?.error?.message,
    error?.error?.message,
  ]
    .filter(Boolean)
    .join(" ");
  return /NONCE_EXPIRED|nonce has already been used|nonce too low/i.test(text);
}

function transientSendErrorSummary(error) {
  return [
    error?.code,
    error?.shortMessage,
    error?.info?.error?.message,
    error?.error?.message,
    error?.message,
  ]
    .filter(Boolean)
    .join(" | ");
}

function isTransientBesuSendError(error) {
  return /BAD_DATA|null.*hash|fetch failed|ECONNRESET|ETIMEDOUT|timeout/i.test(transientSendErrorSummary(error));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withManagedNonce(signer, label) {
  if (!signer.provider || signer.__besuManagedNonce) return signer;

  let nextNonce = null;
  const originalSendTransaction = signer.sendTransaction.bind(signer);
  const sendRetries = Math.max(0, Number(process.env.BESU_TX_SEND_RETRIES || process.env.TX_SEND_RETRIES || 2));

  Object.defineProperty(signer, "__besuManagedNonce", {
    configurable: false,
    enumerable: false,
    value: true,
  });

  async function sendWithNonce(transaction, nonce) {
    const txRequest =
      transaction.gasPrice == null &&
      transaction.maxFeePerGas == null &&
      transaction.maxPriorityFeePerGas == null
        ? { type: 0, gasPrice: 0n, ...transaction, nonce }
        : { ...transaction, nonce };

    if (typeof signer.signTransaction !== "function") {
      return originalSendTransaction(txRequest);
    }

    const populated = await signer.populateTransaction(txRequest);
    const signed = await signer.signTransaction(populated);
    return signer.provider.broadcastTransaction(signed);
  }

  async function sendWithRetries(transaction, nonce) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await sendWithNonce(transaction, nonce);
      } catch (error) {
        if (attempt >= sendRetries || !isTransientBesuSendError(error)) throw error;
        const delayMs = 1000 * (attempt + 1);
        if (process.env.DEBUG_BESU_TX_RETRY === "true") {
          console.log(
            `[tx-retry] ${label} nonce ${nonce} retry ${attempt + 1}/${sendRetries}: ${transientSendErrorSummary(error)}`
          );
        }
        await sleep(delayMs);
      }
    }
  }

  signer.sendTransaction = async (transaction) => {
    const address = await signer.getAddress();
    const currentNonce = await networkTransactionCount(signer, address);
    if (nextNonce === null || nextNonce < currentNonce) {
      nextNonce = currentNonce;
      if (process.env.LOG_NONCES === "true") {
        console.log(`[nonce] ${label} ${address} starting at ${nextNonce}`);
      }
    }

    const nonce = nextNonce;
    nextNonce += 1;

    try {
      return await sendWithRetries(transaction, nonce);
    } catch (error) {
      if (!isNonceExpired(error)) throw error;

      const refreshedNonce = await networkTransactionCount(signer, address);
      if (refreshedNonce <= nonce) throw error;
      nextNonce = refreshedNonce + 1;
      if (process.env.LOG_NONCES === "true") {
        console.log(`[nonce] ${label} ${address} refreshed from ${nonce} to ${refreshedNonce}`);
      }
      return sendWithRetries(transaction, refreshedNonce);
    }
  };

  return signer;
}

async function besuOperatorWallet(chainKey, provider, index) {
  const operators = await loadBesuJson(chainKey, "operators.json");
  const label = operatorLabel(index);
  const entry = operators.find((operator) => operator.label === label);
  if (!entry) throw new Error(`Could not find Besu operator '${label}' for chain ${chainKey}.`);
  const wallet = new ethers.Wallet(entry.privateKey, provider);
  if (entry.address && ethers.getAddress(entry.address) !== wallet.address) {
    throw new Error(`Besu operator '${label}' key/address mismatch for chain ${chainKey}.`);
  }
  return withManagedNonce(wallet, `${chainKey}:${label}`);
}

export function artifactPath(sourcePath, contractName) {
  return resolve(process.cwd(), "artifacts", "contracts", sourcePath, `${contractName}.json`);
}

export async function loadArtifact(sourcePath, contractName) {
  return JSON.parse(await readFile(artifactPath(sourcePath, contractName), "utf8"));
}

export async function deploy(artifact, signer, args = [], overrides = {}) {
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  const contract = await factory.deploy(...args, overrides);
  await contract.waitForDeployment();
  return contract;
}

export function providerForRpc(rpc) {
  return new ethers.JsonRpcProvider(rpc);
}

async function rpcReady(rpc) {
  const response = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_chainId",
      params: [],
    }),
  });
  if (!response.ok) {
    throw new Error(`RPC ${rpc} returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (payload.error || !payload.result) {
    throw new Error(payload.error?.message || `RPC ${rpc} did not return a chain id`);
  }
  return payload.result;
}

export async function waitForRpcReady(
  rpc,
  { label = rpc, timeoutMs = Number(process.env.RPC_WAIT_TIMEOUT_MS || 120000), intervalMs = 2000 } = {}
) {
  const start = Date.now();
  let lastError = "RPC not reachable yet";

  while (Date.now() - start < timeoutMs) {
    try {
      const chainId = await rpcReady(rpc);
      console.log(`[wait] ${label} ready at ${rpc} (chainId=${BigInt(chainId).toString()})`);
      return chainId;
    } catch (error) {
      lastError = error.message;
      await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
    }
  }

  throw new Error(`[wait] ${label} did not become ready within ${timeoutMs / 1000}s. Last error: ${lastError}`);
}

export async function waitForBesuRuntimeReady({
  timeoutMs = Number(process.env.RPC_WAIT_TIMEOUT_MS || 120000),
  intervalMs = 2000,
} = {}) {
  await waitForRpcReady(CHAIN_A_RPC, { label: "Bank A RPC", timeoutMs, intervalMs });
  await waitForRpcReady(CHAIN_B_RPC, { label: "Bank B RPC", timeoutMs, intervalMs });
}

export async function waitForProviderBlockHeight(
  provider,
  minHeight,
  {
    label = "RPC",
    timeoutMs = Number(process.env.BLOCK_WAIT_TIMEOUT_MS || process.env.RPC_WAIT_TIMEOUT_MS || 120000),
    intervalMs = 2000,
  } = {}
) {
  const targetHeight = BigInt(minHeight);
  const start = Date.now();
  let lastHeight = null;
  let lastError = "block height not available yet";

  while (Date.now() - start < timeoutMs) {
    try {
      const height = BigInt(await provider.getBlockNumber());
      lastHeight = height;
      if (height >= targetHeight) {
        console.log(`[wait] ${label} reached block ${height.toString()}`);
        return height;
      }
      lastError = `latest block ${height.toString()} below required ${targetHeight.toString()}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }

  const heightText = lastHeight == null ? "unknown" : lastHeight.toString();
  throw new Error(
    `[wait] ${label} did not reach block ${targetHeight.toString()} within ${timeoutMs / 1000}s. ` +
      `Last height: ${heightText}. Last error: ${lastError}`
  );
}

export async function signerForRpc(rpc, chainKey, index = 0) {
  const provider = providerForRpc(rpc);
  if (useBesuKeys()) return besuOperatorWallet(chainKey, provider, index);
  return provider.getSigner(index);
}

export async function rpcBlockHeader(provider, blockNumber) {
  const blockTag = ethers.toQuantity(BigInt(blockNumber));
  const block = await provider.send("eth_getBlockByNumber", [blockTag, false]);
  if (!block) throw new Error(`RPC block ${blockTag} not found`);
  return block;
}
