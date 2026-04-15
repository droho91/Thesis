import { ethers } from "ethers";
import {
  checkpointObject,
  loadArtifact,
  loadConfig,
  peerKey,
  pretty,
  providerFor,
  signaturesFor,
  signerFor,
} from "./ibc-lite-common.mjs";

async function relayLatest(sourceKey, config, artifacts) {
  const destinationKey = peerKey(sourceKey);
  const source = config.chains[sourceKey];
  const destination = config.chains[destinationKey];
  const sourceProvider = providerFor(config, sourceKey);
  const destinationSigner = await signerFor(config, destinationKey, 0);
  const checkpointRegistry = new ethers.Contract(source.checkpointRegistry, artifacts.checkpointRegistry.abi, sourceProvider);
  const client = new ethers.Contract(destination.client, artifacts.client.abi, destinationSigner);
  const latestSequence = await checkpointRegistry.checkpointSequence();
  if (latestSequence === 0n) {
    console.log(`[client-update] ${sourceKey}->${destinationKey} no source checkpoint`);
    return;
  }
  const checkpoint = checkpointObject(await checkpointRegistry.checkpointsBySequence(latestSequence));
  const already = await client.consensusStateHashBySequence(source.chainId, checkpoint.sequence);
  if (already !== ethers.ZeroHash) {
    console.log(`[client-update] ${sourceKey}->${destinationKey} already trusted sequence ${checkpoint.sequence}`);
    return;
  }
  const digest = await client.hashConsensusState(checkpoint);
  const signatures = await signaturesFor(sourceProvider, digest);
  const tx = await client.updateState([checkpoint], signatures);
  await tx.wait();
  console.log(`[client-update] ${sourceKey}->${destinationKey} trusted ${pretty(digest)} sequence=${checkpoint.sequence}`);
}

async function main() {
  const config = await loadConfig();
  const artifacts = {
    checkpointRegistry: await loadArtifact("source/SourceCheckpointRegistry.sol", "SourceCheckpointRegistry"),
    client: await loadArtifact("clients/BankChainClient.sol", "BankChainClient"),
  };
  await relayLatest("A", config, artifacts);
  await relayLatest("B", config, artifacts);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
