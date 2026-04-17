import { loadArtifact, loadConfig, normalizeRuntime } from "./ibc-lite-common.mjs";
import { finalizePendingHeader } from "./ibc-lite-header-progression.mjs";

async function finalizePendingHeaders(chainKey, config, artifacts) {
  const finalized = await finalizePendingHeader({ cfg: config, artifacts, chainKey, logPrefix: "source-commit" });
  if (!finalized) {
    console.log(`[source-commit] ${chainKey} no pending packets to finalize`);
  }
}

export async function runSourceCommitWorker() {
  const activeRuntime = normalizeRuntime();
  if (!activeRuntime.besuFirst) {
    throw new Error("source-commit-worker.mjs is a canonical Besu-first entrypoint.");
  }

  const config = await loadConfig();
  const artifacts = {
    packetStore: await loadArtifact("source/SourcePacketCommitment.sol", "SourcePacketCommitment"),
    checkpointRegistry: await loadArtifact("source/SourceCheckpointRegistry.sol", "SourceCheckpointRegistry"),
  };
  await finalizePendingHeaders("A", config, artifacts);
  await finalizePendingHeaders("B", config, artifacts);
}

runSourceCommitWorker().catch((error) => {
  console.error(error);
  process.exit(1);
});
