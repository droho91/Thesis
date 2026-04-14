import { ethers } from "ethers";
import {
  ABI,
  POLL_MS,
  buildSingleLeafProof,
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

async function processLeg(cfg, leg, signers) {
  const sourceProvider = providerFor(cfg, leg.sourceChainKey);
  const destinationProvider = providerFor(cfg, leg.destinationChainKey);
  const destinationSigner = signerForDestination(signers, leg.destinationChainKey);
  const sourceChain = cfg.chains[leg.sourceChainKey];
  const { events } = await queryMessages(sourceProvider, leg.sourceMessageBus, leg.routeId);
  const checkpointClient = new ethers.Contract(leg.destinationCheckpointClient, ABI.checkpointClient, destinationProvider);
  const inbox = new ethers.Contract(leg.destinationInbox, ABI.inbox, destinationProvider);
  const router = new ethers.Contract(leg.destinationBridgeRouter, ABI.router, destinationSigner);
  let delivered = 0;

  for (const ev of events) {
    const messageId = ev.args.messageId;
    if (await inbox.consumed(messageId)) continue;

    const checkpointHash = await checkpointClient.checkpointHashBySequence(
      sourceChain.chainId,
      BigInt(ev.args.messageSequence)
    );
    if (checkpointHash === ethers.ZeroHash) continue;

    const message = messageFromEvent(ev);
    const proof = buildSingleLeafProof(checkpointHash);

    try {
      const tx = await router.relayMessage(message, proof);
      await tx.wait();
      delivered += 1;
      console.log(
        `[message] ${leg.kind} proof verified ${prettyHash(messageId)} ${leg.sourceChainKey}->${leg.destinationChainKey} tx=${prettyHash(tx.hash)}`
      );
    } catch (err) {
      const msg = err?.shortMessage || err?.message || String(err);
      if (!msg.includes("MESSAGE_ALREADY_CONSUMED")) {
        console.log(`[message] ${leg.kind} delivery skipped ${prettyHash(messageId)}: ${msg}`);
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

  console.log("message-relayer started");
  console.log(`- relayer A ${await signers.A.getAddress()} | ${cfg.chains.A.rpc}`);
  console.log(`- relayer B ${await signers.B.getAddress()} | ${cfg.chains.B.rpc}`);
  console.log("- message delivery is permissionless; invalid inclusion proofs are rejected on-chain");

  while (true) {
    try {
      let delivered = 0;
      for (const market of getMarketEntries(cfg)) {
        for (const leg of routeLegsForMarket(cfg, market)) {
          delivered += await processLeg(cfg, leg, signers);
        }
      }
      if (delivered > 0) console.log(`cycle complete | messagesDelivered=${delivered}`);
    } catch (err) {
      console.log(`message cycle error: ${err?.shortMessage || err?.message || err}`);
    }

    await sleep(POLL_MS);
  }
}

main().catch((err) => {
  console.error("message-relayer failed:");
  console.error(err);
  process.exit(1);
});
