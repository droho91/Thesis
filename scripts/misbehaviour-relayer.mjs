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

async function submitConflict(sourceKey, config, artifacts) {
  const destinationKey = peerKey(sourceKey);
  const source = config.chains[sourceKey];
  const destination = config.chains[destinationKey];
  const sourceProvider = providerFor(config, sourceKey);
  const destinationSigner = await signerFor(config, destinationKey, 0);
  const checkpointRegistry = new ethers.Contract(source.checkpointRegistry, artifacts.checkpointRegistry.abi, sourceProvider);
  const client = new ethers.Contract(destination.client, artifacts.client.abi, destinationSigner);
  const sequence = BigInt(process.env.CONFLICT_SEQUENCE || "1");
  const checkpoint = checkpointObject(await checkpointRegistry.checkpointsBySequence(sequence));
  if (checkpoint.sourceCommitmentHash === ethers.ZeroHash) {
    throw new Error(`source ${sourceKey} checkpoint ${sequence} is empty`);
  }
  checkpoint.packetRoot = ethers.keccak256(ethers.toUtf8Bytes(`conflict:${sourceKey}:${Date.now()}`));
  checkpoint.sourceCommitmentHash = await client.hashSourceCommitment(checkpoint);
  const digest = await client.hashConsensusState(checkpoint);
  const signatures = await signaturesFor(sourceProvider, digest);
  const tx = await client.updateState([checkpoint], signatures);
  await tx.wait();
  console.log(`[misbehaviour] submitted conflicting update ${sourceKey}->${destinationKey} ${pretty(digest)}`);
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
