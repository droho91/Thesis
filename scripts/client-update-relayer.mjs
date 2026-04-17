import {
  loadArtifact,
  loadConfig,
  normalizeRuntime,
  peerKey,
} from "./ibc-lite-common.mjs";
import { relayLatestTrustedHeader } from "./ibc-lite-header-progression.mjs";

async function relayLatest(sourceKey, config, artifacts) {
  const runtime = config.runtime || normalizeRuntime(config);
  const destinationKey = peerKey(sourceKey);
  try {
    await relayLatestTrustedHeader({
      cfg: config,
      artifacts,
      sourceKey,
      destinationKey,
      runtime,
      logPrefix: "client-update",
    });
  } catch (error) {
    if (error.message === `[${sourceKey}] No finalized header exists yet.`) {
      console.log(`[client-update] ${sourceKey}->${destinationKey} no finalized source header`);
      return;
    }
    throw error;
  }
}

export async function runClientUpdateRelayer() {
  const activeRuntime = normalizeRuntime();
  if (!activeRuntime.besuFirst) {
    throw new Error("client-update-relayer.mjs is a canonical Besu-first entrypoint.");
  }

  const config = await loadConfig();
  const artifacts = {
    checkpointRegistry: await loadArtifact("source/SourceCheckpointRegistry.sol", "SourceCheckpointRegistry"),
    client: await loadArtifact("clients/BankChainClient.sol", "BankChainClient"),
  };
  await relayLatest("A", config, artifacts);
  await relayLatest("B", config, artifacts);
}

runClientUpdateRelayer().catch((error) => {
  console.error(error);
  process.exit(1);
});
