import { ethers } from "ethers";
import { headerProducerAddress, loadArtifact, loadConfig, signerFor, pretty } from "./ibc-lite-common.mjs";

async function finalizePendingHeaders(chainKey, config, artifacts) {
  const signer = await signerFor(config, chainKey, 0);
  const chain = config.chains[chainKey];
  const packetStore = new ethers.Contract(chain.packetStore, artifacts.packetStore.abi, signer);
  const headerProducer = new ethers.Contract(headerProducerAddress(chain), artifacts.checkpointRegistry.abi, signer);
  const packetSequence = await packetStore.packetSequence();
  const committed = await headerProducer.lastCommittedPacketSequence();
  if (packetSequence <= committed) {
    console.log(`[source-commit] ${chainKey} no pending packets to finalize`);
    return;
  }
  const tx = await headerProducer.finalizeHeader(packetSequence);
  const receipt = await tx.wait();
  console.log(
    `[source-commit] ${chainKey} finalized header for packets ${committed + 1n}-${packetSequence} tx=${pretty(receipt.hash)}`
  );
}

async function main() {
  const config = await loadConfig();
  const artifacts = {
    packetStore: await loadArtifact("source/SourcePacketCommitment.sol", "SourcePacketCommitment"),
    checkpointRegistry: await loadArtifact("source/SourceCheckpointRegistry.sol", "SourceCheckpointRegistry"),
  };
  await finalizePendingHeaders("A", config, artifacts);
  await finalizePendingHeaders("B", config, artifacts);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
