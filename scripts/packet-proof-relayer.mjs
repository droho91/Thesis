import { ethers } from "ethers";
import {
  finalizedHeaderObject,
  headerProducerAddress,
  hydrateExecutionStateRoot,
  loadArtifact,
  loadConfig,
  normalizeRuntime,
  peerKey,
  providerFor,
  signerFor,
} from "./ibc-lite-common.mjs";
import { relayPacketForCanonicalRuntime } from "./ibc-lite-relay-paths.mjs";

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

async function relayPackets(sourceKey, config, artifacts, runtime) {
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
      await relayPacketForCanonicalRuntime({
        cfg: config,
        artifacts,
        sourceKey,
        destinationKey,
        packet,
        header,
        consensusHash,
        logPrefix: "packet-proof",
      });
      break;
    }
  }
}

export async function runPacketProofRelayer() {
  const activeRuntime = normalizeRuntime();
  if (!activeRuntime.besuFirst) {
    throw new Error("packet-proof-relayer.mjs is a canonical Besu-first entrypoint.");
  }

  const config = await loadConfig();
  const artifacts = {
    packetStore: await loadArtifact("source/SourcePacketCommitment.sol", "SourcePacketCommitment"),
    checkpointRegistry: await loadArtifact("source/SourceCheckpointRegistry.sol", "SourceCheckpointRegistry"),
    client: await loadArtifact("clients/BankChainClient.sol", "BankChainClient"),
    handler: await loadArtifact("core/IBCPacketHandler.sol", "IBCPacketHandler"),
  };
  await relayPackets("A", config, artifacts, activeRuntime);
  await relayPackets("B", config, artifacts, activeRuntime);
}

runPacketProofRelayer().catch((error) => {
  console.error(error);
  process.exit(1);
});
