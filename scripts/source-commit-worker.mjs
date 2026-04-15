import { ethers } from "ethers";
import { loadArtifact, loadConfig, signerFor, pretty } from "./ibc-lite-common.mjs";

async function commitPending(chainKey, config, artifacts) {
  const signer = await signerFor(config, chainKey, 0);
  const chain = config.chains[chainKey];
  const packetStore = new ethers.Contract(chain.packetStore, artifacts.packetStore.abi, signer);
  const checkpointRegistry = new ethers.Contract(chain.checkpointRegistry, artifacts.checkpointRegistry.abi, signer);
  const packetSequence = await packetStore.packetSequence();
  const committed = await checkpointRegistry.lastCommittedPacketSequence();
  if (packetSequence <= committed) {
    console.log(`[source-commit] ${chainKey} no pending packets`);
    return;
  }
  const tx = await checkpointRegistry.commitCheckpoint(packetSequence);
  const receipt = await tx.wait();
  console.log(`[source-commit] ${chainKey} committed packets ${committed + 1n}-${packetSequence} tx=${pretty(receipt.hash)}`);
}

async function main() {
  const config = await loadConfig();
  const artifacts = {
    packetStore: await loadArtifact("source/SourcePacketCommitment.sol", "SourcePacketCommitment"),
    checkpointRegistry: await loadArtifact("source/SourceCheckpointRegistry.sol", "SourceCheckpointRegistry"),
  };
  await commitPending("A", config, artifacts);
  await commitPending("B", config, artifacts);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
