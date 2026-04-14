import { ethers } from "ethers";
import {
  ABI,
  POLL_MS,
  blockHeaderForEvent,
  devReceiptProofRoot,
  getEventLogIndex,
  getMarketEntries,
  loadConfig,
  messageFromEvent,
  prettyHash,
  providerFor,
  queryMessages,
  routeLegsForMarket,
  signerFor,
  sleep,
} from "./relayer-common.mjs";

const RELAYER_INDEX_A = Number(process.env.RELAYER_INDEX_A || 1);
const RELAYER_INDEX_B = Number(process.env.RELAYER_INDEX_B || 1);

function signerForDestination(signers, chainKey) {
  return chainKey === "A" ? signers.A : signers.B;
}

async function buildProof(cfg, leg, bus, ev, message) {
  const sourceChain = cfg.chains[leg.sourceChainKey];
  const sourceProvider = providerFor(cfg, leg.sourceChainKey);
  const { executionHeader } = await blockHeaderForEvent(sourceProvider, sourceChain.chainId, ev);
  const eventHash = await bus.computeEventHash(message);
  const logIndex = getEventLogIndex(ev);

  return {
    sourceChainId: BigInt(sourceChain.chainId),
    blockHash: executionHeader.blockHash,
    receiptsRoot: executionHeader.receiptsRoot,
    emitter: leg.sourceMessageBus,
    logIndex,
    proofRoot: devReceiptProofRoot({
      sourceChainId: sourceChain.chainId,
      blockHash: executionHeader.blockHash,
      receiptsRoot: executionHeader.receiptsRoot,
      emitter: leg.sourceMessageBus,
      logIndex,
      eventHash,
    }),
  };
}

async function processLeg(cfg, leg, signers) {
  const sourceProvider = providerFor(cfg, leg.sourceChainKey);
  const destinationProvider = providerFor(cfg, leg.destinationChainKey);
  const destinationSigner = signerForDestination(signers, leg.destinationChainKey);
  const { bus, events } = await queryMessages(sourceProvider, leg.sourceMessageBus, leg.routeId);
  const inbox = new ethers.Contract(leg.destinationInbox, ABI.inbox, destinationProvider);
  const router = new ethers.Contract(leg.destinationBridgeRouter, ABI.router, destinationSigner);
  let delivered = 0;

  for (const ev of events) {
    const messageId = ev.args.messageId;
    if (await inbox.consumed(messageId)) continue;

    const message = messageFromEvent(ev);
    const proof = await buildProof(cfg, leg, bus, ev, message);

    try {
      const tx = await router.relayMessage(message, proof);
      await tx.wait();
      delivered += 1;
      console.log(
        `[proof] ${leg.kind} verified ${prettyHash(messageId)} ${leg.sourceChainKey}->${leg.destinationChainKey} tx=${prettyHash(tx.hash)}`
      );
    } catch (err) {
      const msg = err?.shortMessage || err?.message || String(err);
      if (!msg.includes("MESSAGE_ALREADY_CONSUMED")) {
        console.log(`[proof] ${leg.kind} delivery skipped ${prettyHash(messageId)}: ${msg}`);
      }
    }
  }

  return delivered;
}

async function main() {
  const cfg = await loadConfig();
  const signers = {
    A: await signerFor(cfg, "A", RELAYER_INDEX_A),
    B: await signerFor(cfg, "B", RELAYER_INDEX_B),
  };

  console.log("proof-relayer started");
  console.log(`- relayer A ${await signers.A.getAddress()} | ${cfg.chains.A.rpc}`);
  console.log(`- relayer B ${await signers.B.getAddress()} | ${cfg.chains.B.rpc}`);
  console.log("- proof submissions are permissionless; invalid proofs are rejected on-chain");

  while (true) {
    try {
      let delivered = 0;
      for (const market of getMarketEntries(cfg)) {
        for (const leg of routeLegsForMarket(cfg, market)) {
          delivered += await processLeg(cfg, leg, signers);
        }
      }
      if (delivered > 0) {
        console.log(`cycle complete | messagesDelivered=${delivered}`);
      }
    } catch (err) {
      console.log(`proof cycle error: ${err?.shortMessage || err?.message || err}`);
    }

    await sleep(POLL_MS);
  }
}

main().catch((err) => {
  console.error("proof-relayer failed:");
  console.error(err);
  process.exit(1);
});
