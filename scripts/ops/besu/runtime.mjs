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
  const root = process.env.BESU_NETWORK_ROOT || "networks/besu";
  const path = resolve(process.cwd(), root, chainFolder(chainKey), file);
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

function rpcErrorSummary(error) {
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
  return /BAD_DATA|null.*hash|fetch failed|ECONNRESET|ETIMEDOUT|timeout/i.test(rpcErrorSummary(error));
}

function isTransientBesuReadError(error) {
  const summary = rpcErrorSummary(error);
  const missingRevertData = error?.code === "CALL_EXCEPTION"
    && error?.data == null
    && error?.reason == null
    && /missing revert data/i.test(summary);
  return missingRevertData
    || /BAD_DATA|fetch failed|ECONNRESET|ETIMEDOUT|timeout|missing block header|block not found|world state|archive rolling/i.test(summary);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function withManagedNonce(signer, label, {
  sendRetries = Number(process.env.BESU_TX_SEND_RETRIES || process.env.TX_SEND_RETRIES || 2),
} = {}) {
  if (!signer.provider || signer.__besuManagedNonce) return signer;
  if (!Number.isSafeInteger(sendRetries) || sendRetries < 0 || sendRetries > 20) {
    throw new RangeError("Besu transaction sendRetries must be an integer between 0 and 20");
  }

  let nextNonce = null;
  let sendQueue = Promise.resolve();
  const originalSendTransaction = signer.sendTransaction.bind(signer);

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
            `[tx-retry] ${label} nonce ${nonce} retry ${attempt + 1}/${sendRetries}: ${rpcErrorSummary(error)}`
          );
        }
        await sleep(delayMs);
      }
    }
  }

  async function sendManagedTransaction(transaction) {
    const address = await signer.getAddress();
    const currentNonce = await networkTransactionCount(signer, address);
    if (nextNonce === null || nextNonce < currentNonce) {
      nextNonce = currentNonce;
      if (process.env.LOG_NONCES === "true") {
        console.log(`[nonce] ${label} ${address} starting at ${nextNonce}`);
      }
    }

    const nonce = nextNonce;

    try {
      const response = await sendWithRetries(transaction, nonce);
      nextNonce = nonce + 1;
      return response;
    } catch (error) {
      // A nonce-expired response is ambiguous: an earlier attempt may have
      // reached the node even when its RPC response was lost. Moving the same
      // business call to a refreshed nonce could therefore execute it twice.
      // Reset local state and require the caller to reconcile on-chain state;
      // never manufacture a replacement transaction at a new nonce here.
      nextNonce = null;
      if (isNonceExpired(error)) {
        error.outcomeUncertain = true;
      }
      throw error;
    }
  }

  signer.sendTransaction = (transaction) => {
    const operation = sendQueue.then(() => sendManagedTransaction(transaction));
    sendQueue = operation.then(() => undefined, () => undefined);
    return operation;
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

export function rpcFetchRequest(
  rpc,
  { timeoutMs = Number(process.env.RPC_REQUEST_TIMEOUT_MS || 5_000) } = {},
) {
  requireRpcTimeout(timeoutMs);
  const request = new ethers.FetchRequest(rpc);
  request.timeout = timeoutMs;
  return request;
}

export function providerForRpc(rpc, options = {}) {
  return new ethers.JsonRpcProvider(rpcFetchRequest(rpc, options));
}

export async function readWithTransientRpcRetry(
  operation,
  {
    label = "contract state",
    retries = Number(process.env.BESU_READ_RETRIES || 8),
    intervalMs = Number(process.env.BESU_READ_RETRY_MS || 500),
  } = {},
) {
  if (typeof operation !== "function") throw new TypeError("RPC read operation must be a function");
  if (typeof label !== "string" || label.trim().length === 0) {
    throw new TypeError("RPC read label must be a non-empty string");
  }
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 20) {
    throw new RangeError("RPC read retries must be an integer between 0 and 20");
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 60_000) {
    throw new RangeError("RPC read intervalMs must be an integer between 0 and 60000");
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientBesuReadError(error)) throw error;
      if (attempt >= retries) {
        throw new Error(
          `[rpc] failed to read ${label} after ${retries + 1} attempts: `
            + `${error?.shortMessage || error?.message || error}`,
          { cause: error },
        );
      }
      // Besu can briefly expose a new QBFT head before its path-based world
      // state has finished rolling to that header. Read-only calls are safe to
      // repeat; state-changing transactions deliberately never use this path.
      if (intervalMs > 0) await sleep(intervalMs);
    }
  }
}

export async function readContractCode(
  provider,
  address,
  {
    label = address,
    retries = Number(process.env.BESU_CODE_READ_RETRIES || 8),
    intervalMs = Number(process.env.BESU_CODE_READ_RETRY_MS || 500),
  } = {},
) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const code = await provider.getCode(address);
      if (typeof code !== "string" || !ethers.isHexString(code)) {
        throw new Error(`eth_getCode returned ${code === null ? "null" : typeof code}`);
      }
      return code;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(intervalMs);
    }
  }
  throw new Error(
    `[rpc] failed to read ${label} bytecode after ${retries + 1} attempts: ${lastError?.shortMessage || lastError?.message || lastError}`,
  );
}

export async function readLatestBlock(
  provider,
  {
    label = "latest block",
    retries = Number(process.env.BESU_BLOCK_READ_RETRIES || 8),
    intervalMs = Number(process.env.BESU_BLOCK_READ_RETRY_MS || 500),
  } = {},
) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const block = await provider.getBlock("latest");
      if (!block || block.timestamp == null) {
        throw new Error(`eth_getBlockByNumber returned ${block === null ? "null" : "an incomplete block"}`);
      }
      return block;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(intervalMs);
    }
  }
  throw new Error(
    `[rpc] failed to read ${label} after ${retries + 1} attempts: ` +
      `${lastError?.shortMessage || lastError?.message || lastError}`,
  );
}

export async function rpcCall(
  rpc,
  method,
  params = [],
  {
    timeoutMs = Number(process.env.RPC_REQUEST_TIMEOUT_MS || 5_000),
    fetchImpl = fetch,
  } = {},
) {
  requireRpcTimeout(timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`RPC ${method} timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  try {
    const response = await fetchImpl(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`RPC ${rpc} returned HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (payload.error) {
      throw new Error(payload.error.message || `${method} failed`);
    }
    return payload.result;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`RPC ${method} timed out after ${timeoutMs}ms`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function requireRpcTimeout(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error("RPC request timeout must be a positive safe integer no greater than 2147483647ms");
  }
}

async function rpcReady(rpc) {
  const chainId = await rpcCall(rpc, "eth_chainId");
  if (!chainId) throw new Error(`RPC ${rpc} did not return a chain id`);
  const code = await rpcCall(rpc, "eth_getCode", [ethers.ZeroAddress, "latest"]);
  if (typeof code !== "string") {
    throw new Error(
      `RPC ${rpc} returned ${code === null ? "null" : typeof code} for eth_getCode. Besu world state is not available; restart with npm run besu:down && npm run besu:up.`
    );
  }
  return chainId;
}

export async function waitForRpcReady(
  rpc,
  { label = rpc, timeoutMs = Number(process.env.RPC_WAIT_TIMEOUT_MS || 300000), intervalMs = 2000 } = {}
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
  timeoutMs = Number(process.env.RPC_WAIT_TIMEOUT_MS || 300000),
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
    timeoutMs = Number(process.env.BLOCK_WAIT_TIMEOUT_MS || process.env.RPC_WAIT_TIMEOUT_MS || 300000),
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

export async function signerForRpc(
  rpc,
  chainKey,
  index = 0,
  {
    createProvider = providerForRpc,
    localOperatorKeys = useBesuKeys(),
    createLocalSigner = besuOperatorWallet,
  } = {},
) {
  const provider = createProvider(rpc);
  try {
    if (localOperatorKeys) return await createLocalSigner(chainKey, provider, index);
    return await provider.getSigner(index);
  } catch (signerError) {
    try {
      await Promise.resolve().then(() => provider.destroy?.());
    } catch (cleanupError) {
      throw new AggregateError(
        [signerError, cleanupError],
        `Signer initialization failed for chain ${chainKey} and its RPC provider could not be released`,
      );
    }
    throw signerError;
  }
}

export async function rpcBlockHeader(provider, blockNumber) {
  const blockTag = ethers.toQuantity(BigInt(blockNumber));
  const block = await provider.send("eth_getBlockByNumber", [blockTag, false]);
  if (!block) throw new Error(`RPC block ${blockTag} not found`);
  return block;
}
