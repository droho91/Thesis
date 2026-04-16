import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const BLOCK_TAG = process.env.BLOCK_TAG || "latest";
const FULL_TX = process.env.FULL_TX === "true";
const OUT_FILE = resolve(process.cwd(), process.env.OUT_FILE || "proofs/besu/latest-header.json");

async function rpc(method, params) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    throw new Error(payload.error?.message || `RPC ${method} failed`);
  }
  return payload.result;
}

async function main() {
  const block = await rpc("eth_getBlockByNumber", [BLOCK_TAG, FULL_TX]);
  if (!block) throw new Error(`Block ${BLOCK_TAG} not found on ${RPC_URL}`);

  const output = {
    generatedAt: new Date().toISOString(),
    rpcUrl: RPC_URL,
    blockTag: BLOCK_TAG,
    header: {
      number: block.number,
      hash: block.hash,
      parentHash: block.parentHash,
      stateRoot: block.stateRoot,
      receiptsRoot: block.receiptsRoot,
      transactionsRoot: block.transactionsRoot,
      mixHash: block.mixHash,
      nonce: block.nonce,
      miner: block.miner,
      difficulty: block.difficulty,
      totalDifficulty: block.totalDifficulty ?? null,
      extraData: block.extraData,
      timestamp: block.timestamp,
      gasLimit: block.gasLimit,
      gasUsed: block.gasUsed,
      baseFeePerGas: block.baseFeePerGas ?? null,
    },
  };

  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(output, null, 2)}\n`);

  console.log(`Saved Besu/EVM header snapshot to ${OUT_FILE}`);
  console.log(`block=${block.number} hash=${block.hash}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
