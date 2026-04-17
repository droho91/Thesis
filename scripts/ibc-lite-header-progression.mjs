import { ethers } from "ethers";
import {
  finalizedHeaderObject,
  headerProducerAddress,
  hydrateExecutionStateRoot,
  normalizeRuntime,
  pretty,
  providerFor,
  signaturesFor,
  signerFor,
} from "./ibc-lite-common.mjs";

function log(prefix, message) {
  console.log(prefix ? `[${prefix}] ${message}` : message);
}

function contractsForHeaderRead(cfg, artifacts, chainKey) {
  const provider = providerFor(cfg, chainKey);
  return {
    chain: cfg.chains[chainKey],
    provider,
    headerProducer: new ethers.Contract(
      headerProducerAddress(cfg.chains[chainKey]),
      artifacts.checkpointRegistry.abi,
      provider
    ),
  };
}

export async function finalizedHeaderByHeight({ cfg, artifacts, chainKey, height }) {
  const { headerProducer } = contractsForHeaderRead(cfg, artifacts, chainKey);
  return finalizedHeaderObject(await headerProducer.headersByHeight(height));
}

export async function latestFinalizedHeader({ cfg, artifacts, chainKey }) {
  const { headerProducer } = contractsForHeaderRead(cfg, artifacts, chainKey);
  const height = await headerProducer.headerHeight();
  if (height === 0n) throw new Error(`[${chainKey}] No finalized header exists yet.`);
  return finalizedHeaderByHeight({ cfg, artifacts, chainKey, height });
}

export async function finalizePendingHeader({ cfg, artifacts, chainKey, logPrefix = "" }) {
  const signer = await signerFor(cfg, chainKey, 0);
  const chain = cfg.chains[chainKey];
  const packetStore = new ethers.Contract(chain.packetStore, artifacts.packetStore.abi, signer);
  const headerProducer = new ethers.Contract(headerProducerAddress(chain), artifacts.checkpointRegistry.abi, signer);
  const packetSequence = await packetStore.packetSequence();
  const committed = await headerProducer.lastCommittedPacketSequence();

  if (packetSequence <= committed) return null;

  const tx = await headerProducer.finalizeHeader(packetSequence);
  const receipt = await tx.wait();
  log(
    logPrefix,
    `${chainKey} finalized header for packets ${committed + 1n}-${packetSequence} tx=${pretty(receipt.hash)}`
  );
  return {
    txHash: receipt.hash,
    fromSequence: committed + 1n,
    toSequence: packetSequence,
    header: await latestFinalizedHeader({ cfg, artifacts, chainKey }),
  };
}

export async function ensureFinalizedHeader({ cfg, artifacts, chainKey, logPrefix = "" }) {
  const signer = await signerFor(cfg, chainKey, 0);
  const chain = cfg.chains[chainKey];
  const packetStore = new ethers.Contract(chain.packetStore, artifacts.packetStore.abi, signer);
  const packetSequence = await packetStore.packetSequence();
  if (packetSequence === 0n) throw new Error(`[${chainKey}] No packet has been written yet.`);

  const finalized = await finalizePendingHeader({ cfg, artifacts, chainKey, logPrefix });
  if (finalized?.header) return finalized.header;
  return latestFinalizedHeader({ cfg, artifacts, chainKey });
}

export async function relayTrustedHeaderUpdate({
  cfg,
  artifacts,
  sourceKey,
  destinationKey,
  header,
  runtime = null,
  logPrefix = "",
}) {
  const activeRuntime = runtime || cfg.runtime || normalizeRuntime(cfg);
  const sourceProvider = providerFor(cfg, sourceKey);
  const destinationSigner = await signerFor(cfg, destinationKey, 0);
  const client = new ethers.Contract(cfg.chains[destinationKey].client, artifacts.client.abi, destinationSigner);

  const hydratedHeader = await hydrateExecutionStateRoot(cfg, sourceKey, header, {
    strict: activeRuntime.proofPolicy === "storage-required",
  });
  hydratedHeader.blockHash = await client.hashHeader(hydratedHeader);
  const consensusHash = await client.hashConsensusState(hydratedHeader);
  const commitDigest = await client.hashCommitment(hydratedHeader);
  const existingHash = await client.consensusStateHashBySequence(cfg.chains[sourceKey].chainId, hydratedHeader.height);

  if (existingHash === ethers.ZeroHash) {
    const signatures = await signaturesFor(sourceKey, sourceProvider, commitDigest);
    await (await client.updateState([hydratedHeader], signatures)).wait();
    log(logPrefix, `${sourceKey}->${destinationKey} trusted ${pretty(consensusHash)} height=${hydratedHeader.height}`);
  } else {
    log(logPrefix, `${sourceKey}->${destinationKey} already trusted height ${hydratedHeader.height}`);
  }

  return {
    header: hydratedHeader,
    consensusHash,
    existingHash,
    alreadyTrusted: existingHash !== ethers.ZeroHash,
  };
}

export async function relayLatestTrustedHeader({
  cfg,
  artifacts,
  sourceKey,
  destinationKey,
  runtime = null,
  logPrefix = "",
}) {
  const header = await latestFinalizedHeader({ cfg, artifacts, chainKey: sourceKey });
  return relayTrustedHeaderUpdate({
    cfg,
    artifacts,
    sourceKey,
    destinationKey,
    header,
    runtime,
    logPrefix,
  });
}
