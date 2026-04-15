import { ethers } from "ethers";
import {
  ABI,
  POLL_MS,
  getMarketEntries,
  loadConfig,
  prettyHash,
  providerFor,
  routeLegsForMarket,
  signCheckpoint,
  signerFor,
  sleep,
} from "./relayer-common.mjs";

const RELAYER_INDEX_A = Number(process.env.RELAYER_INDEX_A || 1);
const RELAYER_INDEX_B = Number(process.env.RELAYER_INDEX_B || 1);

function signerForDestination(signers, chainKey) {
  return chainKey === "A" ? signers.A : signers.B;
}

function signerForSourceOwner(signers, chainKey) {
  return chainKey === "A" ? signers.ownerA : signers.ownerB;
}

function checkpointFromRegistryTuple(tuple) {
  return {
    sourceChainId: tuple.sourceChainId,
    sourceCheckpointRegistry: tuple.sourceCheckpointRegistry,
    sourceMessageBus: tuple.sourceMessageBus,
    sourceValidatorSetRegistry: tuple.sourceValidatorSetRegistry,
    validatorEpochId: tuple.validatorEpochId,
    validatorEpochHash: tuple.validatorEpochHash,
    sequence: tuple.sequence,
    parentCheckpointHash: tuple.parentCheckpointHash,
    messageRoot: tuple.messageRoot,
    firstMessageSequence: tuple.firstMessageSequence,
    lastMessageSequence: tuple.lastMessageSequence,
    messageCount: tuple.messageCount,
    messageAccumulator: tuple.messageAccumulator,
    sourceBlockNumber: tuple.sourceBlockNumber,
    sourceBlockHash: tuple.sourceBlockHash,
    timestamp: tuple.timestamp,
    sourceCommitmentHash: tuple.sourceCommitmentHash,
  };
}

function epochFromRegistryTuple(tuple) {
  return {
    sourceChainId: tuple.sourceChainId,
    sourceValidatorSetRegistry: tuple.sourceValidatorSetRegistry,
    epochId: tuple.epochId,
    parentEpochHash: tuple.parentEpochHash,
    validators: tuple.validators,
    votingPowers: tuple.votingPowers,
    totalVotingPower: tuple.totalVotingPower,
    quorumNumerator: tuple.quorumNumerator,
    quorumDenominator: tuple.quorumDenominator,
    activationBlockNumber: tuple.activationBlockNumber,
    activationBlockHash: tuple.activationBlockHash,
    timestamp: tuple.timestamp,
    epochHash: tuple.epochHash,
    active: tuple.active,
  };
}

async function produceSourceCheckpointIfNeeded(cfg, leg, signers) {
  const sourceSigner = signerForSourceOwner(signers, leg.sourceChainKey);
  const sourceBus = new ethers.Contract(leg.sourceMessageBus, ABI.messageBus, sourceSigner);
  const registry = new ethers.Contract(leg.sourceCheckpointRegistry, ABI.checkpointRegistry, sourceSigner);
  const latestMessageSequence = await sourceBus.messageSequence();
  const lastCommitted = await registry.lastCommittedMessageSequence();

  if (latestMessageSequence <= lastCommitted) return 0;

  const tx = await registry.commitCheckpoint(latestMessageSequence);
  await tx.wait();
  console.log(
    `[source] ${leg.sourceChainKey} committed checkpoint over messages ${lastCommitted + 1n}-${latestMessageSequence} tx=${prettyHash(tx.hash)}`
  );
  return 1;
}

async function submitCheckpointFromSourceRegistry(cfg, leg, signers, sourceSequence) {
  const sourceChain = cfg.chains[leg.sourceChainKey];
  const sourceProvider = providerFor(cfg, leg.sourceChainKey);
  const destinationSigner = signerForDestination(signers, leg.destinationChainKey);
  const client = new ethers.Contract(leg.destinationCheckpointClient, ABI.checkpointClient, destinationSigner);
  const registry = new ethers.Contract(leg.sourceCheckpointRegistry, ABI.checkpointRegistry, sourceProvider);

  if (await client.sourceFrozen(sourceChain.chainId)) {
    console.log(`[checkpoint] ${leg.kind} source ${leg.sourceChainKey} is frozen on ${leg.destinationChainKey}`);
    return 0;
  }

  const latestSequence = await client.latestCheckpointSequence(sourceChain.chainId);
  const sequence = BigInt(sourceSequence);
  if (sequence !== latestSequence + 1n) return 0;
  const existing = await client.checkpointHashBySequence(sourceChain.chainId, sequence);
  if (existing !== ethers.ZeroHash) return 0;

  const checkpoint = checkpointFromRegistryTuple(await registry.checkpointsBySequence(sequence));
  const digest = await client.hashCheckpoint(checkpoint);
  const signatures = await signCheckpoint(cfg, leg.sourceChainKey, digest);

  try {
    const tx = await client.submitCheckpoint(checkpoint, signatures);
    await tx.wait();
    console.log(
      `[checkpoint] ${leg.kind} certified seq=${sequence} root=${prettyHash(checkpoint.messageRoot)} ${leg.sourceChainKey}->${leg.destinationChainKey} tx=${prettyHash(tx.hash)}`
    );
    return 1;
  } catch (err) {
    const msg = err?.shortMessage || err?.message || String(err);
    if (!msg.includes("CHECKPOINT_EXISTS")) {
      console.log(`[checkpoint] ${leg.kind} skipped seq=${sequence}: ${msg}`);
    }
    return 0;
  }
}

async function submitSourceEpochsIfNeeded(cfg, leg, signers) {
  const sourceChain = cfg.chains[leg.sourceChainKey];
  const sourceProvider = providerFor(cfg, leg.sourceChainKey);
  const destinationSigner = signerForDestination(signers, leg.destinationChainKey);
  const client = new ethers.Contract(leg.destinationCheckpointClient, ABI.checkpointClient, destinationSigner);
  const validatorRegistry = new ethers.Contract(leg.sourceValidatorSetRegistry, ABI.validatorRegistry, sourceProvider);

  const sourceActiveEpochId = await validatorRegistry.activeValidatorEpochId();
  let remoteActiveEpochId = await client.activeValidatorEpochId(sourceChain.chainId);
  let accepted = 0;

  while (remoteActiveEpochId < sourceActiveEpochId) {
    const nextEpochId = remoteActiveEpochId + 1n;
    const epoch = epochFromRegistryTuple(await validatorRegistry.validatorEpoch(nextEpochId));
    const signatures = await signCheckpoint(cfg, leg.sourceChainKey, epoch.epochHash);
    const tx = await client.submitValidatorEpoch(epoch, signatures);
    await tx.wait();
    accepted += 1;
    remoteActiveEpochId = nextEpochId;
    console.log(
      `[epoch] ${leg.sourceChainKey}->${leg.destinationChainKey} accepted epoch=${nextEpochId} hash=${prettyHash(epoch.epochHash)} tx=${prettyHash(tx.hash)}`
    );
  }

  return accepted;
}

async function processLeg(cfg, leg, signers) {
  await submitSourceEpochsIfNeeded(cfg, leg, signers);
  await produceSourceCheckpointIfNeeded(cfg, leg, signers);
  const sourceProvider = providerFor(cfg, leg.sourceChainKey);
  const registry = new ethers.Contract(leg.sourceCheckpointRegistry, ABI.checkpointRegistry, sourceProvider);
  const latestSourceCheckpoint = await registry.checkpointSequence();
  let accepted = 0;

  for (let sequence = 1n; sequence <= latestSourceCheckpoint; sequence++) {
    accepted += await submitCheckpointFromSourceRegistry(cfg, leg, signers, sequence);
  }

  return accepted;
}

async function main() {
  const cfg = await loadConfig();
  const signers = {
    A: await signerFor(cfg, "A", RELAYER_INDEX_A),
    B: await signerFor(cfg, "B", RELAYER_INDEX_B),
    ownerA: await signerFor(cfg, "A", 0),
    ownerB: await signerFor(cfg, "B", 0),
  };

  console.log("checkpoint-relayer started");
  console.log(`- relayer A ${await signers.A.getAddress()} | ${cfg.chains.A.rpc}`);
  console.log(`- relayer B ${await signers.B.getAddress()} | ${cfg.chains.B.rpc}`);
  console.log("- source registries commit message ranges; relayers submit only validator-certified checkpoint objects");

  while (true) {
    try {
      let accepted = 0;
      for (const market of getMarketEntries(cfg)) {
        for (const leg of routeLegsForMarket(cfg, market)) {
          accepted += await processLeg(cfg, leg, signers);
        }
      }
      if (accepted > 0) console.log(`cycle complete | checkpointsAccepted=${accepted}`);
    } catch (err) {
      console.log(`checkpoint cycle error: ${err?.shortMessage || err?.message || err}`);
    }

    await sleep(POLL_MS);
  }
}

main().catch((err) => {
  console.error("checkpoint-relayer failed:");
  console.error(err);
  process.exit(1);
});
