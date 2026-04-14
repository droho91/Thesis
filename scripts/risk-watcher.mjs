import { ethers } from "ethers";
import {
  ABI,
  POLL_MS,
  getMarketEntries,
  loadConfig,
  prettyHash,
  providerFor,
  routeLegsForMarket,
  signerFor,
  sleep,
} from "./relayer-common.mjs";

const WATCHER_INDEX_A = Number(process.env.RISK_WATCHER_INDEX_A || 0);
const WATCHER_INDEX_B = Number(process.env.RISK_WATCHER_INDEX_B || 0);
const CURSE_ROUTE_ID = process.env.CURSE_ROUTE_ID || "";
const PAUSE_ROUTE_ID = process.env.PAUSE_ROUTE_ID || "";

function chainRiskManager(cfg, chainKey, signerOrProvider) {
  return new ethers.Contract(cfg.chains[chainKey].riskManager, ABI.riskManager, signerOrProvider);
}

function chainRouteRegistry(cfg, chainKey, provider) {
  return new ethers.Contract(cfg.chains[chainKey].routeRegistry, ABI.routeRegistry, provider);
}

async function maybeTriggerEmergency(cfg, signers) {
  if (!CURSE_ROUTE_ID && !PAUSE_ROUTE_ID) return;

  for (const chainKey of Object.keys(cfg.chains)) {
    const signer = chainKey === "A" ? signers.A : signers.B;
    const risk = chainRiskManager(cfg, chainKey, signer);

    if (CURSE_ROUTE_ID) {
      try {
        const tx = await risk.setRouteCursed(CURSE_ROUTE_ID, true);
        await tx.wait();
        console.log(`[risk] cursed route ${prettyHash(CURSE_ROUTE_ID)} on ${chainKey} tx=${prettyHash(tx.hash)}`);
      } catch (err) {
        console.log(`[risk] curse skipped on ${chainKey}: ${err?.shortMessage || err?.message || err}`);
      }
    }

    if (PAUSE_ROUTE_ID) {
      try {
        const tx = await risk.setRoutePaused(PAUSE_ROUTE_ID, true);
        await tx.wait();
        console.log(`[risk] paused route ${prettyHash(PAUSE_ROUTE_ID)} on ${chainKey} tx=${prettyHash(tx.hash)}`);
      } catch (err) {
        console.log(`[risk] pause skipped on ${chainKey}: ${err?.shortMessage || err?.message || err}`);
      }
    }
  }
}

async function reportRoute(cfg, leg) {
  const provider = providerFor(cfg, leg.destinationChainKey);
  const risk = chainRiskManager(cfg, leg.destinationChainKey, provider);
  const registry = chainRouteRegistry(cfg, leg.destinationChainKey, provider);
  const [paused, cursed, route] = await Promise.all([
    risk.routePaused(leg.routeId),
    risk.routeCursed(leg.routeId),
    registry.getRoute(leg.routeId),
  ]);

  const status = cursed ? "cursed" : paused ? "paused" : route.enabled ? "active" : "disabled";
  console.log(
    `[risk] ${leg.kind} ${prettyHash(leg.routeId)} ${leg.sourceChainKey}->${leg.destinationChainKey} ${status} cap=${route.transferCap} window=${route.rateLimitAmount}/${route.rateLimitWindow}s high=${route.highValueThreshold}`
  );
}

async function main() {
  const cfg = await loadConfig();
  const signers = {
    A: await signerFor(cfg, "A", WATCHER_INDEX_A),
    B: await signerFor(cfg, "B", WATCHER_INDEX_B),
  };

  console.log("risk-watcher started");
  console.log("- watcher observes route policy and can call pause/curse only when explicitly configured");
  console.log(`- owner A signer ${await signers.A.getAddress()} | owner B signer ${await signers.B.getAddress()}`);

  while (true) {
    try {
      await maybeTriggerEmergency(cfg, signers);
      for (const market of getMarketEntries(cfg)) {
        for (const leg of routeLegsForMarket(cfg, market)) {
          await reportRoute(cfg, leg);
        }
      }
    } catch (err) {
      console.log(`risk cycle error: ${err?.shortMessage || err?.message || err}`);
    }

    await sleep(POLL_MS * 4);
  }
}

main().catch((err) => {
  console.error("risk-watcher failed:");
  console.error(err);
  process.exit(1);
});
