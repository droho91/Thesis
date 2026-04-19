import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ethers } from "ethers";

export const CONFIG_PATH = resolve(process.cwd(), ".ibc-lite.local.json");
export const CHAIN_A_RPC = process.env.CHAIN_A_RPC || "http://127.0.0.1:8545";
export const CHAIN_B_RPC = process.env.CHAIN_B_RPC || "http://127.0.0.1:9545";
export const LOCAL_CHAIN_MNEMONIC =
  process.env.LOCAL_CHAIN_MNEMONIC || "test test test test test test test test test test test junk";
export const STATE_LEAF_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes("IBCLite.StateLeaf.v1"));
export const PACKET_COMMITMENT_PATH_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes("IBCLite.PacketCommitmentPath.v1")
);
const PACKET_LEAF_AT_SLOT = 2n;
const PACKET_PATH_AT_SLOT = 3n;

function runtimeDefaults() {
  const mode = process.env.RUNTIME_MODE || (useBesuKeys() ? "besu" : "legacy");
  const proofPolicy = process.env.PROOF_POLICY || (mode === "besu" ? "storage-required" : "hybrid");
  return { mode, proofPolicy };
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

function validatorIndices() {
  return process.env.VALIDATOR_INDICES
    ? parseIndices(process.env.VALIDATOR_INDICES)
    : useBesuKeys()
      ? [0, 1, 2]
      : [3, 4, 5];
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

function withManagedNonce(signer, label) {
  if (!signer.provider || signer.__ibcLiteManagedNonce) return signer;

  let nextNonce = null;
  const originalSendTransaction = signer.sendTransaction.bind(signer);

  Object.defineProperty(signer, "__ibcLiteManagedNonce", {
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
      return await sendWithNonce(transaction, nonce);
    } catch (error) {
      if (!isNonceExpired(error)) throw error;

      const refreshedNonce = await networkTransactionCount(signer, address);
      if (refreshedNonce <= nonce) throw error;
      nextNonce = refreshedNonce + 1;
      if (process.env.LOG_NONCES === "true") {
        console.log(`[nonce] ${label} ${address} refreshed from ${nonce} to ${refreshedNonce}`);
      }
      return sendWithNonce(transaction, refreshedNonce);
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

async function besuValidators(chainKey) {
  return loadBesuJson(chainKey, "validators.json");
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

function normalizeConfig(config) {
  if (!config?.chains) return { ...config, runtime: normalizeRuntime(config) };

  const chains = Object.fromEntries(
    Object.entries(config.chains).map(([chainKey, chainConfig]) => {
      const headerProducer = chainConfig?.headerProducer || chainConfig?.checkpointRegistry;
      return [
        chainKey,
        headerProducer
          ? {
              ...chainConfig,
              headerProducer,
              checkpointRegistry: chainConfig?.checkpointRegistry || headerProducer,
            }
          : chainConfig,
      ];
    })
  );

  return { ...config, chains, runtime: normalizeRuntime(config) };
}

export async function loadConfig() {
  return normalizeConfig(JSON.parse(await readFile(CONFIG_PATH, "utf8")));
}

export async function saveConfig(config) {
  await writeFile(CONFIG_PATH, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`);
}

export function providerFor(config, chainKey) {
  return new ethers.JsonRpcProvider(config.chains[chainKey].rpc);
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

export function headerProducerAddress(chainConfig) {
  return chainConfig?.headerProducer || chainConfig?.checkpointRegistry;
}

export async function signerFor(config, chainKey, index = 0) {
  const provider = providerFor(config, chainKey);
  if (useBesuKeys()) return besuOperatorWallet(chainKey, provider, index);
  return provider.getSigner(index);
}

export async function signerForRpc(rpc, chainKey, index = 0) {
  const provider = providerForRpc(rpc);
  if (useBesuKeys()) return besuOperatorWallet(chainKey, provider, index);
  return provider.getSigner(index);
}

export function peerKey(chainKey) {
  return chainKey === "A" ? "B" : "A";
}

export function pretty(hash) {
  return `${hash.slice(0, 10)}...${hash.slice(-6)}`;
}

export function localWallet(index, provider = null) {
  const path = `m/44'/60'/0'/0/${index}`;
  const wallet = ethers.HDNodeWallet.fromPhrase(LOCAL_CHAIN_MNEMONIC, undefined, path);
  return provider ? wallet.connect(provider) : wallet;
}

export function localValidatorSignature(index, digest) {
  const digestBytes = ethers.getBytes(digest);
  const messageDigest = ethers.hashMessage(digestBytes);
  return localWallet(index).signingKey.sign(messageDigest).serialized;
}

export async function validatorAddresses(chainKey, _provider = null, indices = validatorIndices()) {
  if (useBesuKeys()) {
    const validators = await besuValidators(chainKey);
    return indices.map((index) => {
      const entry = validators[index];
      if (!entry) throw new Error(`Could not find Besu validator index ${index} for chain ${chainKey}.`);
      return entry.address;
    });
  }
  return indices.map((index) => localWallet(index).address);
}

export async function signaturesFor(chainKey, _provider, digest, indices = validatorIndices().slice(0, 2)) {
  if (useBesuKeys()) {
    const validators = await besuValidators(chainKey);
    const digestBytes = ethers.getBytes(digest);
    const messageDigest = ethers.hashMessage(digestBytes);
    return indices.map((index) => {
      const entry = validators[index];
      if (!entry) throw new Error(`Could not find Besu validator index ${index} for chain ${chainKey}.`);
      return new ethers.SigningKey(entry.privateKey).sign(messageDigest).serialized;
    });
  }
  return indices.map((index) => localValidatorSignature(index, digest));
}

export function finalizedHeaderObject(result) {
  const sequence = result.sequence;
  const parentHash = result.parentHash || result.parentCheckpointHash;
  const sourceHeaderProducer = result.sourceHeaderProducer || result.sourceCheckpointRegistry;
  return {
    sourceChainId: result.sourceChainId,
    sourceCheckpointRegistry: sourceHeaderProducer,
    sourceHeaderProducer,
    sourcePacketCommitment: result.sourcePacketCommitment,
    sourceValidatorSetRegistry: result.sourceValidatorSetRegistry,
    validatorEpochId: result.validatorEpochId,
    validatorEpochHash: result.validatorEpochHash,
    sequence,
    height: sequence,
    parentCheckpointHash: parentHash,
    parentHash,
    packetRoot: result.packetRoot,
    stateRoot: result.stateRoot,
    executionStateRoot: result.executionStateRoot || ethers.ZeroHash,
    firstPacketSequence: result.firstPacketSequence,
    lastPacketSequence: result.lastPacketSequence,
    packetCount: result.packetCount,
    packetAccumulator: result.packetAccumulator,
    sourceBlockNumber: result.sourceBlockNumber,
    sourceBlockHash: result.sourceBlockHash,
    round: 0n,
    timestamp: result.timestamp,
    sourceCommitmentHash: result.sourceCommitmentHash,
    blockHash: ethers.ZeroHash,
  };
}

export const checkpointObject = finalizedHeaderObject;

export function mappingUintSlot(key, slot) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [BigInt(key), BigInt(slot)])
  );
}

export function packetLeafStorageSlot(sequence) {
  return mappingUintSlot(sequence, PACKET_LEAF_AT_SLOT);
}

export function packetPathStorageSlot(sequence) {
  return mappingUintSlot(sequence, PACKET_PATH_AT_SLOT);
}

export function rlpEncodeWord(word) {
  return ethers.hexlify(ethers.concat([Uint8Array.from([0xa0]), ethers.getBytes(word)]));
}

export async function rpcBlockHeader(provider, blockNumber) {
  const blockTag = ethers.toQuantity(BigInt(blockNumber));
  const block = await provider.send("eth_getBlockByNumber", [blockTag, false]);
  if (!block) throw new Error(`RPC block ${blockTag} not found`);
  return block;
}

export async function hydrateExecutionStateRoot(config, chainKey, header, { strict = false } = {}) {
  const provider = providerFor(config, chainKey);
  try {
    const block = await rpcBlockHeader(provider, header.sourceBlockNumber);
    if (!block.hash || block.hash.toLowerCase() !== String(header.sourceBlockHash).toLowerCase()) {
      throw new Error(
        `[${chainKey}] source block anchor mismatch: expected ${header.sourceBlockHash}, got ${block.hash || "none"}`
      );
    }
    if (!block.stateRoot) throw new Error(`[${chainKey}] RPC block ${block.number} returned no stateRoot`);
    return { ...header, executionStateRoot: block.stateRoot };
  } catch (error) {
    if (strict) throw error;
    return { ...header, executionStateRoot: header.executionStateRoot || ethers.ZeroHash };
  }
}

export async function ethGetProof(provider, account, storageKeys, blockNumber) {
  return provider.send("eth_getProof", [account, storageKeys, ethers.toQuantity(BigInt(blockNumber))]);
}

export function packetCommitmentPath(sourceChainId, sourcePort, sequence) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "address", "uint256"],
      [PACKET_COMMITMENT_PATH_TYPEHASH, sourceChainId, sourcePort, sequence]
    )
  );
}

export function stateLeaf(path, value) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32", "bytes32"], [STATE_LEAF_TYPEHASH, path, value])
  );
}

export function merkleRoot(leaves) {
  if (leaves.length === 0) throw new Error("no leaves");
  let level = [...leaves];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      next.push(ethers.keccak256(ethers.concat([left, right])));
    }
    level = next;
  }
  return level[0];
}

export function buildMerkleProof(leaves, leafIndex) {
  const siblings = [];
  let index = leafIndex;
  let level = [...leaves];
  while (level.length > 1) {
    const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
    siblings.push(siblingIndex < level.length ? level[siblingIndex] : level[index]);
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      next.push(ethers.keccak256(ethers.concat([left, right])));
    }
    index = Math.floor(index / 2);
    level = next;
  }
  return siblings;
}
