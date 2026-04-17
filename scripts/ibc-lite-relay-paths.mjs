import { ethers } from "ethers";
import { ethGetProof, packetLeafStorageSlot, packetPathStorageSlot, providerFor, rlpEncodeWord, signerFor } from "./ibc-lite-common.mjs";

function compactHash(value) {
  if (!value || value.length <= 18) return value;
  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}

function defaultLog(prefix, message) {
  if (prefix) {
    console.log(`[${prefix}] ${message}`);
    return;
  }
  console.log(message);
}

async function contractsForPath({ cfg, artifacts, sourceKey, destinationKey }) {
  const source = cfg.chains[sourceKey];
  const destination = cfg.chains[destinationKey];
  const sourceProvider = providerFor(cfg, sourceKey);
  const destinationSigner = await signerFor(cfg, destinationKey, 0);

  return {
    source,
    sourceProvider,
    packetStore: new ethers.Contract(source.packetStore, artifacts.packetStore.abi, sourceProvider),
    client: new ethers.Contract(destination.client, artifacts.client.abi, destinationSigner),
    handler: new ethers.Contract(destination.packetHandler, artifacts.handler.abi, destinationSigner),
  };
}

async function relayPacketViaStorageProof({
  cfg,
  artifacts,
  sourceKey,
  destinationKey,
  packet,
  header,
  consensusHash,
  logPrefix = "",
}) {
  const { source, sourceProvider, packetStore, client, handler } = await contractsForPath({
    cfg,
    artifacts,
    sourceKey,
    destinationKey,
  });
  const packetId = await packetStore.packetIdAt(packet.sequence);
  const packetLeaf = await packetStore.packetLeafAt(packet.sequence);
  const packetPath = await packetStore.packetPathAt(packet.sequence);
  const trustedRoot = await client.trustedStateRoot(source.chainId, consensusHash);

  if (header.executionStateRoot === ethers.ZeroHash || trustedRoot !== header.executionStateRoot) {
    throw new Error(
      `Storage proof requires a trusted execution state root for ${sourceKey}->${destinationKey} header ${header.height}.`
    );
  }

  const proof = await ethGetProof(
    sourceProvider,
    source.packetStore,
    [packetLeafStorageSlot(packet.sequence), packetPathStorageSlot(packet.sequence)],
    header.sourceBlockNumber
  );
  const leafWitness = proof.storageProof.find(
    (entry) => entry.key.toLowerCase() === packetLeafStorageSlot(packet.sequence).toLowerCase()
  );
  const pathWitness = proof.storageProof.find(
    (entry) => entry.key.toLowerCase() === packetPathStorageSlot(packet.sequence).toLowerCase()
  );
  if (!leafWitness || !pathWitness) throw new Error("missing storage proof witness");

  const leafProof = {
    sourceChainId: BigInt(source.chainId),
    consensusStateHash: consensusHash,
    stateRoot: trustedRoot,
    account: source.packetStore,
    storageKey: packetLeafStorageSlot(packet.sequence),
    expectedValue: rlpEncodeWord(packetLeaf),
    accountProof: proof.accountProof,
    storageProof: leafWitness.proof,
  };
  const pathProof = {
    sourceChainId: BigInt(source.chainId),
    consensusStateHash: consensusHash,
    stateRoot: trustedRoot,
    account: source.packetStore,
    storageKey: packetPathStorageSlot(packet.sequence),
    expectedValue: rlpEncodeWord(packetPath),
    accountProof: proof.accountProof,
    storageProof: pathWitness.proof,
  };

  if (!(await handler.consumedPackets(packetId))) {
    await (await handler.recvPacketFromStorageProof(packet, leafProof, pathProof)).wait();
  }
  defaultLog(logPrefix, `${sourceKey}->${destinationKey} executed ${compactHash(packetId)} via storage proof`);

  return {
    packetId,
    packetRoot: header.packetRoot,
    stateRoot: header.stateRoot,
    executionStateRoot: trustedRoot,
    consensusHash,
    proofMode: "storage",
  };
}

export async function relayPacketForCanonicalRuntime({
  cfg,
  artifacts,
  sourceKey,
  destinationKey,
  packet,
  header,
  consensusHash,
  logPrefix = "",
}) {
  return relayPacketViaStorageProof({
    cfg,
    artifacts,
    sourceKey,
    destinationKey,
    packet,
    header,
    consensusHash,
    logPrefix,
  });
}
