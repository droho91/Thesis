import {
  loadArtifact,
  loadConfig,
  normalizeRuntime,
  peerKey,
} from "./ibc-lite-common.mjs";
import { submitConflictingHeaderUpdate } from "./ibc-lite-safety.mjs";

async function submitConflict(sourceKey, config, artifacts) {
  const destinationKey = peerKey(sourceKey);
  const height = BigInt(process.env.CONFLICT_HEIGHT || process.env.CONFLICT_SEQUENCE || "1");
  await submitConflictingHeaderUpdate({
    cfg: config,
    artifacts,
    sourceKey,
    destinationKey,
    height,
    logPrefix: "misbehaviour",
  });
}

export async function runMisbehaviourRelayer() {
  const activeRuntime = normalizeRuntime();
  if (!activeRuntime.besuFirst) {
    throw new Error("misbehaviour-relayer.mjs is a canonical Besu-first entrypoint.");
  }

  const config = await loadConfig();
  const artifacts = {
    checkpointRegistry: await loadArtifact("source/SourceCheckpointRegistry.sol", "SourceCheckpointRegistry"),
    client: await loadArtifact("clients/BankChainClient.sol", "BankChainClient"),
  };
  await submitConflict(process.env.SOURCE_CHAIN || "A", config, artifacts);
}

runMisbehaviourRelayer().catch((error) => {
  console.error(error);
  process.exit(1);
});
