import { ethers } from "ethers";
import {
  buildMerkleProof,
  ethGetProof,
  finalizedHeaderObject,
  headerProducerAddress,
  hydrateExecutionStateRoot,
  loadArtifact,
  loadConfig,
  merkleRoot,
  normalizeRuntime,
  packetLeafStorageSlot,
  packetPathStorageSlot,
  peerKey,
  pretty,
  providerFor,
  rlpEncodeWord,
  signerFor,
  stateLeaf,
} from "./ibc-lite-common.mjs";

function packetFromEvent(event) {
  const a = event.args;
  return {
    sequence: a.sequence,
    sourceChainId: 0n,
    destinationChainId: a.destinationChainId,
    sourcePort: a.sourcePort,
    destinationPort: a.destinationPort,
    sender: a.sender,
    recipient: a.recipient,
    asset: a.asset,
    amount: a.amount,
    action: a.action,
    memo: ethers.ZeroHash,
  };
}

async function relayPackets(sourceKey, config, artifacts) {
  const runtime = config.runtime || normalizeRuntime(config);
  const destinationKey = peerKey(sourceKey);
  const source = config.chains[sourceKey];
  const destination = config.chains[destinationKey];
  const sourceProvider = providerFor(config, sourceKey);
  const destinationSigner = await signerFor(config, destinationKey, 0);
  const packetStore = new ethers.Contract(source.packetStore, artifacts.packetStore.abi, sourceProvider);
  const headerProducer = new ethers.Contract(
    headerProducerAddress(source),
    artifacts.checkpointRegistry.abi,
    sourceProvider
  );
  const client = new ethers.Contract(destination.client, artifacts.client.abi, destinationSigner);
  const handler = new ethers.Contract(destination.packetHandler, artifacts.handler.abi, destinationSigner);
  const filter = packetStore.filters.PacketCommitted();
  const events = await packetStore.queryFilter(filter, 0, "latest");

  for (const event of events) {
    const packet = packetFromEvent(event);
    packet.sourceChainId = BigInt(source.chainId);
    const packetId = event.args.packetId;
    if (await handler.consumedPackets(packetId)) continue;

    const latest = await headerProducer.headerHeight();
    for (let height = 1n; height <= latest; height++) {
      const header = await hydrateExecutionStateRoot(
        config,
        sourceKey,
        finalizedHeaderObject(await headerProducer.headersByHeight(height)),
        { strict: runtime.proofPolicy === "storage-required" }
      );
      const messageSequence = event.args.sequence;
      if (messageSequence < header.firstPacketSequence || messageSequence > header.lastPacketSequence) continue;
      const consensusHash = await client.consensusStateHashBySequence(source.chainId, header.height);
      if (consensusHash === ethers.ZeroHash) continue;
      const trustedRoot = await client.trustedStateRoot(source.chainId, consensusHash);
      const packetLeaf = await packetStore.packetLeafAt(messageSequence);
      const packetPath = await packetStore.packetPathAt(messageSequence);

      if (header.executionStateRoot !== ethers.ZeroHash && trustedRoot === header.executionStateRoot) {
        try {
          const proof = await ethGetProof(
            sourceProvider,
            source.packetStore,
            [packetLeafStorageSlot(messageSequence), packetPathStorageSlot(messageSequence)],
            header.sourceBlockNumber
          );
          const leafWitness = proof.storageProof.find(
            (entry) => entry.key.toLowerCase() === packetLeafStorageSlot(messageSequence).toLowerCase()
          );
          const pathWitness = proof.storageProof.find(
            (entry) => entry.key.toLowerCase() === packetPathStorageSlot(messageSequence).toLowerCase()
          );
          if (!leafWitness || !pathWitness) throw new Error("missing storage proof witness");

          const leafProof = {
            sourceChainId: BigInt(source.chainId),
            consensusStateHash: consensusHash,
            stateRoot: trustedRoot,
            account: source.packetStore,
            storageKey: packetLeafStorageSlot(messageSequence),
            expectedValue: rlpEncodeWord(packetLeaf),
            accountProof: proof.accountProof,
            storageProof: leafWitness.proof,
          };
          const pathProof = {
            sourceChainId: BigInt(source.chainId),
            consensusStateHash: consensusHash,
            stateRoot: trustedRoot,
            account: source.packetStore,
            storageKey: packetPathStorageSlot(messageSequence),
            expectedValue: rlpEncodeWord(packetPath),
            accountProof: proof.accountProof,
            storageProof: pathWitness.proof,
          };
          const tx = await handler.recvPacketFromStorageProof(packet, leafProof, pathProof);
          await tx.wait();
          console.log(`[packet-proof] ${sourceKey}->${destinationKey} executed ${pretty(packetId)} via storage proof`);
          break;
        } catch (error) {
          if (!runtime.allowMerkleFallback) {
            throw new Error(
              `[packet-proof] storage proof required in ${runtime.mode} runtime, but execution failed for ${pretty(packetId)}: ${error.message}`
            );
          }
          console.warn(
            `[packet-proof] storage proof unavailable for ${sourceKey}->${destinationKey} ${pretty(packetId)}; falling back to packet-state Merkle proof`
          );
        }
      }

      if (!runtime.allowMerkleFallback) {
        throw new Error(
          `[packet-proof] storage proof required in ${runtime.mode} runtime, but no trusted execution state root was available for ${sourceKey}->${destinationKey} ${pretty(packetId)}`
        );
      }

      const leaves = [];
      for (let s = header.firstPacketSequence; s <= header.lastPacketSequence; s++) {
        const path = await packetStore.packetPathAt(s);
        const leaf = await packetStore.packetLeafAt(s);
        leaves.push(stateLeaf(path, leaf));
      }
      if (merkleRoot(leaves) !== header.stateRoot) continue;

      const leafIndex = Number(messageSequence - header.firstPacketSequence);
      const proof = [consensusHash, leafIndex, buildMerkleProof(leaves, leafIndex)];
      const tx = await handler.recvPacket(packet, proof);
      await tx.wait();
      console.log(`[packet-proof] ${sourceKey}->${destinationKey} executed ${pretty(packetId)}`);
      break;
    }
  }
}

async function main() {
  const config = await loadConfig();
  const artifacts = {
    packetStore: await loadArtifact("source/SourcePacketCommitment.sol", "SourcePacketCommitment"),
    checkpointRegistry: await loadArtifact("source/SourceCheckpointRegistry.sol", "SourceCheckpointRegistry"),
    client: await loadArtifact("clients/BankChainClient.sol", "BankChainClient"),
    handler: await loadArtifact("core/IBCPacketHandler.sol", "IBCPacketHandler"),
  };
  await relayPackets("A", config, artifacts);
  await relayPackets("B", config, artifacts);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
