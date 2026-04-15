import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ethers } from "ethers";

export const CONFIG_PATH = resolve(process.cwd(), ".ibc-lite.local.json");
export const CHAIN_A_RPC = process.env.CHAIN_A_RPC || "http://127.0.0.1:8545";
export const CHAIN_B_RPC = process.env.CHAIN_B_RPC || "http://127.0.0.1:9545";
export const VALIDATOR_INDICES = (process.env.VALIDATOR_INDICES || "3,4,5")
  .split(",")
  .map((value) => Number(value.trim()));

export function artifactPath(sourcePath, contractName) {
  return resolve(process.cwd(), "artifacts", "contracts", sourcePath, `${contractName}.json`);
}

export async function loadArtifact(sourcePath, contractName) {
  return JSON.parse(await readFile(artifactPath(sourcePath, contractName), "utf8"));
}

export async function deploy(artifact, signer, args = []) {
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

export async function loadConfig() {
  return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
}

export async function saveConfig(config) {
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

export function providerFor(config, chainKey) {
  return new ethers.JsonRpcProvider(config.chains[chainKey].rpc);
}

export async function signerFor(config, chainKey, index = 0) {
  return providerFor(config, chainKey).getSigner(index);
}

export function peerKey(chainKey) {
  return chainKey === "A" ? "B" : "A";
}

export function pretty(hash) {
  return `${hash.slice(0, 10)}...${hash.slice(-6)}`;
}

export async function validatorAddresses(provider, indices = VALIDATOR_INDICES) {
  return Promise.all(indices.map(async (index) => (await provider.getSigner(index)).getAddress()));
}

export async function signaturesFor(provider, digest, indices = VALIDATOR_INDICES.slice(0, 2)) {
  return Promise.all(
    indices.map(async (index) => {
      const signer = await provider.getSigner(index);
      return signer.signMessage(ethers.getBytes(digest));
    })
  );
}

export function checkpointObject(result) {
  return {
    sourceChainId: result.sourceChainId,
    sourceCheckpointRegistry: result.sourceCheckpointRegistry,
    sourcePacketCommitment: result.sourcePacketCommitment,
    sourceValidatorSetRegistry: result.sourceValidatorSetRegistry,
    validatorEpochId: result.validatorEpochId,
    validatorEpochHash: result.validatorEpochHash,
    sequence: result.sequence,
    parentCheckpointHash: result.parentCheckpointHash,
    packetRoot: result.packetRoot,
    firstPacketSequence: result.firstPacketSequence,
    lastPacketSequence: result.lastPacketSequence,
    packetCount: result.packetCount,
    packetAccumulator: result.packetAccumulator,
    sourceBlockNumber: result.sourceBlockNumber,
    sourceBlockHash: result.sourceBlockHash,
    timestamp: result.timestamp,
    sourceCommitmentHash: result.sourceCommitmentHash,
  };
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
