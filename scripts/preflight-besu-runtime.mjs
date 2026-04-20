import { CHAIN_A_RPC, CHAIN_B_RPC } from "./ibc-lite-common.mjs";

const TIMEOUT_MS = Number(process.env.BESU_PREFLIGHT_TIMEOUT_MS || 1200);

async function probeRpc(rpc) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const call = async (method) => {
      const response = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
        signal: controller.signal,
      });
      const payload = await response.json();
      if (!payload.result) throw new Error(payload.error?.message || `${method} returned no result`);
      return payload.result;
    };

    const chainId = await call("eth_chainId");
    const blockNumber = await call("eth_blockNumber");
    const height = BigInt(blockNumber);
    if (height < 1n) {
      throw new Error("RPC reachable, but block production has not started yet (latest block 0)");
    }
    return { ok: true, chainId: BigInt(chainId).toString(), blockNumber: height.toString() };
  } catch (error) {
    return { ok: false, error: error.name === "AbortError" ? "timeout" : error.message };
  } finally {
    clearTimeout(timer);
  }
}

const [bankA, bankB] = await Promise.all([probeRpc(CHAIN_A_RPC), probeRpc(CHAIN_B_RPC)]);

if (bankA.ok && bankB.ok) {
  console.log(`[preflight] Bank A RPC ready at ${CHAIN_A_RPC} (chainId=${bankA.chainId}, block=${bankA.blockNumber})`);
  console.log(`[preflight] Bank B RPC ready at ${CHAIN_B_RPC} (chainId=${bankB.chainId}, block=${bankB.blockNumber})`);
  process.exit(0);
}

console.error("[preflight] Besu bank-chain runtime is not ready.");
console.error(`  Bank A ${CHAIN_A_RPC}: ${bankA.ok ? `ready chainId=${bankA.chainId}, block=${bankA.blockNumber}` : bankA.error}`);
console.error(`  Bank B ${CHAIN_B_RPC}: ${bankB.ok ? `ready chainId=${bankB.chainId}, block=${bankB.blockNumber}` : bankB.error}`);
console.error("");
console.error("Start Docker Desktop first, then run:");
console.error("  npm run besu:up");
console.error("");
console.error("After both RPCs are ready, continue with:");
console.error("  npm run deploy:v2");
console.error("  npm run seed:v2");
console.error("  npm run demo:v2");
process.exit(1);
