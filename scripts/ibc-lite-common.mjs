import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ethers } from "ethers";

export const CONFIG_PATH = resolve(process.cwd(), ".ibc-lite.local.json");
export const CHAIN_A_RPC = process.env.CHAIN_A_RPC || "http://127.0.0.1:8545";
export const CHAIN_B_RPC = process.env.CHAIN_B_RPC || "http://127.0.0.1:9545";
export const LOCAL_CHAIN_MNEMONIC =
  process.env.LOCAL_CHAIN_MNEMONIC || "test test test test test test test test test test test junk";
export const VALIDATOR_INDICES = (process.env.VALIDATOR_INDICES || "3,4,5")
  .split(",")
  .map((value) => Number(value.trim()));
export const STATE_LEAF_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes("IBCLite.StateLeaf.v1"));
export const PACKET_COMMITMENT_PATH_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes("IBCLite.PacketCommitmentPath.v1")
);

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

export async function validatorAddresses(_provider, indices = VALIDATOR_INDICES) {
  return indices.map((index) => localWallet(index).address);
}

export async function signaturesFor(_provider, digest, indices = VALIDATOR_INDICES.slice(0, 2)) {
  return indices.map((index) => localValidatorSignature(index, digest));
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
    stateRoot: result.stateRoot,
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
