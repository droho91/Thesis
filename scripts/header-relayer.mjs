import { ethers } from "ethers";
import {
  ABI,
  POLL_MS,
  blockHeaderForEvent,
  devHeaderProof,
  getMarketEntries,
  loadConfig,
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

async function submitHeaderForEvent(cfg, leg, signers, ev) {
  const sourceChain = cfg.chains[leg.sourceChainKey];
  const sourceProvider = providerFor(cfg, leg.sourceChainKey);
  const destinationSigner = signerForDestination(signers, leg.destinationChainKey);

  const { update, executionHeader } = await blockHeaderForEvent(sourceProvider, sourceChain.chainId, ev);
  const lightClient = new ethers.Contract(leg.destinationLightClient, ABI.lightClient, destinationSigner);
  const headerStore = new ethers.Contract(leg.destinationExecutionHeaderStore, ABI.executionHeaderStore, destinationSigner);

  let finalized = false;
  try {
    const tx = await lightClient.submitFinalizedHeader(update, devHeaderProof(update));
    await tx.wait();
    finalized = true;
    console.log(
      `[header] ${leg.kind} finalized source block ${update.blockNumber} ${prettyHash(update.blockHash)} -> ${leg.destinationChainKey} tx=${prettyHash(tx.hash)}`
    );
  } catch (err) {
    const msg = err?.shortMessage || err?.message || String(err);
    if (!msg.includes("HEADER_EXISTS")) {
      console.log(`[header] ${leg.kind} finalized header skipped: ${msg}`);
    }
  }

  try {
    const tx = await headerStore.submitExecutionHeader(executionHeader);
    await tx.wait();
    console.log(
      `[header] ${leg.kind} execution header stored ${prettyHash(executionHeader.blockHash)} -> ${leg.destinationChainKey} tx=${prettyHash(tx.hash)}`
    );
    return 1;
  } catch (err) {
    const msg = err?.shortMessage || err?.message || String(err);
    if (!msg.includes("EXEC_HEADER_EXISTS")) {
      console.log(`[header] ${leg.kind} execution header skipped: ${msg}${finalized ? " (finality accepted)" : ""}`);
    }
  }

  return 0;
}

async function processLeg(cfg, leg, signers) {
  const sourceProvider = providerFor(cfg, leg.sourceChainKey);
  const { events } = await queryMessages(sourceProvider, leg.sourceMessageBus, leg.routeId);
  let count = 0;

  for (const ev of events) {
    count += await submitHeaderForEvent(cfg, leg, signers, ev);
  }

  return count;
}

async function main() {
  const cfg = await loadConfig();
  const signers = {
    A: await signerFor(cfg, "A", RELAYER_INDEX_A),
    B: await signerFor(cfg, "B", RELAYER_INDEX_B),
  };

  console.log("header-relayer started");
  console.log(`- relayer A ${await signers.A.getAddress()} | ${cfg.chains.A.rpc}`);
  console.log(`- relayer B ${await signers.B.getAddress()} | ${cfg.chains.B.rpc}`);
  console.log("- relayers submit data; light-client verifier and header store enforce correctness");

  while (true) {
    try {
      let stored = 0;
      for (const market of getMarketEntries(cfg)) {
        for (const leg of routeLegsForMarket(cfg, market)) {
          stored += await processLeg(cfg, leg, signers);
        }
      }
      if (stored > 0) {
        console.log(`cycle complete | executionHeadersStored=${stored}`);
      }
    } catch (err) {
      console.log(`header cycle error: ${err?.shortMessage || err?.message || err}`);
    }

    await sleep(POLL_MS);
  }
}

main().catch((err) => {
  console.error("header-relayer failed:");
  console.error(err);
  process.exit(1);
});
