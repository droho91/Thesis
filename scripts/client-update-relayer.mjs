import { ethers } from "ethers";
import {
  finalizedHeaderObject,
  headerProducerAddress,
  hydrateExecutionStateRoot,
  loadArtifact,
  loadConfig,
  normalizeRuntime,
  peerKey,
  pretty,
  providerFor,
  signaturesFor,
  signerFor,
} from "./ibc-lite-common.mjs";

async function relayLatest(sourceKey, config, artifacts) {
  const runtime = config.runtime || normalizeRuntime(config);
  const destinationKey = peerKey(sourceKey);
  const source = config.chains[sourceKey];
  const destination = config.chains[destinationKey];
  const sourceProvider = providerFor(config, sourceKey);
  const destinationSigner = await signerFor(config, destinationKey, 0);
  const headerProducer = new ethers.Contract(
    headerProducerAddress(source),
    artifacts.checkpointRegistry.abi,
    sourceProvider
  );
  const client = new ethers.Contract(destination.client, artifacts.client.abi, destinationSigner);
  const latestHeight = await headerProducer.headerHeight();
  if (latestHeight === 0n) {
    console.log(`[client-update] ${sourceKey}->${destinationKey} no finalized source header`);
    return;
  }
  const header = await hydrateExecutionStateRoot(
    config,
    sourceKey,
    finalizedHeaderObject(await headerProducer.headersByHeight(latestHeight)),
    { strict: runtime.proofPolicy === "storage-required" }
  );
  header.blockHash = await client.hashHeader(header);
  const already = await client.consensusStateHashBySequence(source.chainId, header.height);
  if (already !== ethers.ZeroHash) {
    console.log(`[client-update] ${sourceKey}->${destinationKey} already trusted height ${header.height}`);
    return;
  }
  const digest = await client.hashConsensusState(header);
  const commitDigest = await client.hashCommitment(header);
  const signatures = await signaturesFor(sourceKey, sourceProvider, commitDigest);
  const tx = await client.updateState([header], signatures);
  await tx.wait();
  console.log(`[client-update] ${sourceKey}->${destinationKey} trusted ${pretty(digest)} height=${header.height}`);
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
