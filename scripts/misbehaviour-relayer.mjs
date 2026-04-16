import { ethers } from "ethers";
import {
  finalizedHeaderObject,
  headerProducerAddress,
  loadArtifact,
  loadConfig,
  peerKey,
  pretty,
  providerFor,
  signaturesFor,
  signerFor,
} from "./ibc-lite-common.mjs";

async function submitConflict(sourceKey, config, artifacts) {
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
  const height = BigInt(process.env.CONFLICT_HEIGHT || process.env.CONFLICT_SEQUENCE || "1");
  const header = finalizedHeaderObject(await headerProducer.headersByHeight(height));
  if (header.sourceCommitmentHash === ethers.ZeroHash) {
    throw new Error(`source ${sourceKey} finalized header ${height} is empty`);
  }
  header.packetRoot = ethers.keccak256(ethers.toUtf8Bytes(`conflict:${sourceKey}:${Date.now()}`));
  header.stateRoot = ethers.keccak256(ethers.toUtf8Bytes(`conflict-state:${sourceKey}:${Date.now()}`));
  header.blockHash = await client.hashHeader(header);
  const digest = await client.hashConsensusState(header);
  const commitDigest = await client.hashCommitment(header);
  const signatures = await signaturesFor(sourceKey, sourceProvider, commitDigest);
  const tx = await client.updateState([header], signatures);
  await tx.wait();
  console.log(`[misbehaviour] submitted conflicting finalized header ${sourceKey}->${destinationKey} ${pretty(digest)}`);
}

async function main() {
  const config = await loadConfig();
  const artifacts = {
    checkpointRegistry: await loadArtifact("source/SourceCheckpointRegistry.sol", "SourceCheckpointRegistry"),
    client: await loadArtifact("clients/BankChainClient.sol", "BankChainClient"),
  };
  await submitConflict(process.env.SOURCE_CHAIN || "A", config, artifacts);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
