import { CHAIN_A_RPC, CHAIN_B_RPC } from "./ibc-lite-common.mjs";

const TIMEOUT_MS = Number(process.env.BESU_PREFLIGHT_TIMEOUT_MS || 1200);

async function probeRpc(rpc) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: controller.signal,
    });
    const payload = await response.json();
    if (!payload.result) throw new Error(payload.error?.message || "eth_chainId returned no result");
    return { ok: true, chainId: BigInt(payload.result).toString() };
  } catch (error) {
    return { ok: false, error: error.name === "AbortError" ? "timeout" : error.message };
  } finally {
    clearTimeout(timer);
  }
}

const [bankA, bankB] = await Promise.all([probeRpc(CHAIN_A_RPC), probeRpc(CHAIN_B_RPC)]);

if (bankA.ok && bankB.ok) {
  console.log(`[preflight] Bank A RPC ready at ${CHAIN_A_RPC} (chainId=${bankA.chainId})`);
  console.log(`[preflight] Bank B RPC ready at ${CHAIN_B_RPC} (chainId=${bankB.chainId})`);
  process.exit(0);
}

console.error("[preflight] Besu bank-chain RPCs are not reachable.");
console.error(`  Bank A ${CHAIN_A_RPC}: ${bankA.ok ? `ready chainId=${bankA.chainId}` : bankA.error}`);
console.error(`  Bank B ${CHAIN_B_RPC}: ${bankB.ok ? `ready chainId=${bankB.chainId}` : bankB.error}`);
console.error("");
console.error("Start Docker Desktop first, then run:");
console.error("  npm run besu:up");
console.error("");
console.error("After both RPCs are ready, continue with:");
console.error("  npm run deploy:v2");
console.error("  npm run seed:v2");
console.error("  npm run demo:v2");
process.exit(1);
