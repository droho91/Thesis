import { ethers } from "ethers";
import {
  ABI,
  POLL_MS,
  checkpointHash,
  getMarketEntries,
  loadConfig,
  prettyHash,
  providerFor,
  queryMessages,
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

async function submitCheckpointForEvent(cfg, leg, signers, ev) {
  const sourceChain = cfg.chains[leg.sourceChainKey];
  const destinationSigner = signerForDestination(signers, leg.destinationChainKey);
  const client = new ethers.Contract(leg.destinationCheckpointClient, ABI.checkpointClient, destinationSigner);

  if (await client.sourceFrozen(sourceChain.chainId)) {
    console.log(`[checkpoint] ${leg.kind} source ${leg.sourceChainKey} is frozen on ${leg.destinationChainKey}`);
    return 0;
  }

  const latestSequence = await client.latestCheckpointSequence(sourceChain.chainId);
  const sequence = BigInt(ev.args.messageSequence);
  if (sequence !== latestSequence + 1n) return 0;
  const existing = await client.checkpointHashBySequence(sourceChain.chainId, sequence);
  if (existing !== ethers.ZeroHash) return 0;

  const parentCheckpointHash =
    latestSequence === 0n ? ethers.ZeroHash : await client.latestCheckpointHash(sourceChain.chainId);
  const timestamp = BigInt((await providerFor(cfg, leg.sourceChainKey).getBlock(ev.blockNumber)).timestamp);
  const checkpoint = {
    sourceChainId: BigInt(sourceChain.chainId),
    validatorSetId: BigInt(cfg.validatorSimulation?.validatorSetId || 1),
    sequence,
    parentCheckpointHash,
    messageRoot: ev.args.leaf,
    timestamp,
  };
  const digest = checkpointHash(checkpoint);
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
      console.log(`[checkpoint] ${leg.kind} skipped ${prettyHash(ev.args.messageId)}: ${msg}`);
    }
    return 0;
  }
}

async function processLeg(cfg, leg, signers) {
  const sourceProvider = providerFor(cfg, leg.sourceChainKey);
  const { events } = await queryMessages(sourceProvider, leg.sourceMessageBus, leg.routeId);
  let accepted = 0;

  for (const ev of events) {
    accepted += await submitCheckpointForEvent(cfg, leg, signers, ev);
  }

  return accepted;
}

async function main() {
  const cfg = await loadConfig();
  const signers = {
    A: await signerFor(cfg, "A", RELAYER_INDEX_A),
    B: await signerFor(cfg, "B", RELAYER_INDEX_B),
  };

  console.log("checkpoint-relayer started");
  console.log(`- relayer A ${await signers.A.getAddress()} | ${cfg.chains.A.rpc}`);
  console.log(`- relayer B ${await signers.B.getAddress()} | ${cfg.chains.B.rpc}`);
  console.log("- relayers only submit validator-certified checkpoints; destination contracts verify quorum");

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
