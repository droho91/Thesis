import { ethers } from "ethers";

export const CHECKPOINT_DOMAIN_NAME = "InstitutionalCheckpointClient";
export const CHECKPOINT_DOMAIN_VERSION = "1";
export const CHECKPOINT_TYPES = Object.freeze({
  InstitutionalCheckpoint: [
    { name: "sourceChainId", type: "uint256" },
    { name: "blockNumber", type: "uint256" },
    { name: "blockHash", type: "bytes32" },
    { name: "stateRoot", type: "bytes32" },
    { name: "timestamp", type: "uint256" },
    { name: "attestorEpoch", type: "uint64" },
  ],
});

export function normalizeCheckpoint(checkpoint) {
  const normalized = {
    sourceChainId: BigInt(checkpoint.sourceChainId),
    blockNumber: BigInt(checkpoint.blockNumber),
    blockHash: ethers.hexlify(checkpoint.blockHash),
    stateRoot: ethers.hexlify(checkpoint.stateRoot),
    timestamp: BigInt(checkpoint.timestamp),
    attestorEpoch: BigInt(checkpoint.attestorEpoch),
  };
  if (normalized.sourceChainId <= 0n) throw new Error("Checkpoint sourceChainId must be positive");
  if (normalized.blockNumber <= 0n) throw new Error("Checkpoint blockNumber must be positive");
  if (normalized.timestamp <= 0n) throw new Error("Checkpoint timestamp must be positive");
  if (normalized.attestorEpoch <= 0n) throw new Error("Checkpoint attestorEpoch must be positive");
  if (ethers.dataLength(normalized.blockHash) !== 32) throw new Error("Checkpoint blockHash must be bytes32");
  if (ethers.dataLength(normalized.stateRoot) !== 32) throw new Error("Checkpoint stateRoot must be bytes32");
  return normalized;
}

export function checkpointDomain({ destinationChainId, checkpointClient }) {
  return {
    name: CHECKPOINT_DOMAIN_NAME,
    version: CHECKPOINT_DOMAIN_VERSION,
    chainId: BigInt(destinationChainId),
    verifyingContract: ethers.getAddress(checkpointClient),
  };
}

export function checkpointDigest(checkpoint, domain) {
  return ethers.TypedDataEncoder.hash(domain, CHECKPOINT_TYPES, normalizeCheckpoint(checkpoint));
}

export function serializableCheckpoint(checkpoint) {
  const normalized = normalizeCheckpoint(checkpoint);
  return Object.fromEntries(Object.entries(normalized).map(([key, value]) => [
    key,
    typeof value === "bigint" ? value.toString() : value,
  ]));
}

export function canonicalSourceCheckpointHash(checkpoint) {
  const value = normalizeCheckpoint(checkpoint);
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256", "uint256", "bytes32", "bytes32", "uint256"],
    [value.sourceChainId, value.blockNumber, value.blockHash, value.stateRoot, value.timestamp],
  ));
}
