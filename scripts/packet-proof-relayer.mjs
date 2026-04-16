import { ethers } from "ethers";
import {
  buildMerkleProof,
  checkpointObject,
  loadArtifact,
  loadConfig,
  merkleRoot,
  peerKey,
  pretty,
  providerFor,
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
  const destinationKey = peerKey(sourceKey);
  const source = config.chains[sourceKey];
  const destination = config.chains[destinationKey];
  const sourceProvider = providerFor(config, sourceKey);
  const destinationSigner = await signerFor(config, destinationKey, 0);
  const packetStore = new ethers.Contract(source.packetStore, artifacts.packetStore.abi, sourceProvider);
  const checkpointRegistry = new ethers.Contract(source.checkpointRegistry, artifacts.checkpointRegistry.abi, sourceProvider);
  const client = new ethers.Contract(destination.client, artifacts.client.abi, destinationSigner);
  const handler = new ethers.Contract(destination.packetHandler, artifacts.handler.abi, destinationSigner);
  const filter = packetStore.filters.PacketCommitted();
  const events = await packetStore.queryFilter(filter, 0, "latest");

  for (const event of events) {
    const packet = packetFromEvent(event);
    packet.sourceChainId = BigInt(source.chainId);
    const packetId = event.args.packetId;
    if (await handler.consumedPackets(packetId)) continue;

    const latest = await checkpointRegistry.checkpointSequence();
    for (let sequence = 1n; sequence <= latest; sequence++) {
      const checkpoint = checkpointObject(await checkpointRegistry.checkpointsBySequence(sequence));
      const messageSequence = event.args.sequence;
      if (messageSequence < checkpoint.firstPacketSequence || messageSequence > checkpoint.lastPacketSequence) continue;
      const consensusHash = await client.consensusStateHashBySequence(source.chainId, checkpoint.sequence);
      if (consensusHash === ethers.ZeroHash) continue;

      const leaves = [];
      for (let s = checkpoint.firstPacketSequence; s <= checkpoint.lastPacketSequence; s++) {
        const path = await packetStore.packetPathAt(s);
        const leaf = await packetStore.packetLeafAt(s);
        leaves.push(stateLeaf(path, leaf));
      }
      if (merkleRoot(leaves) !== checkpoint.stateRoot) continue;

      const leafIndex = Number(messageSequence - checkpoint.firstPacketSequence);
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
