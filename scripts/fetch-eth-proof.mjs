import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const ADDRESS = process.env.ADDRESS;
const BLOCK_TAG = process.env.BLOCK_TAG || "latest";
const STORAGE_KEYS = (process.env.STORAGE_KEYS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const OUT_FILE = resolve(process.cwd(), process.env.OUT_FILE || "proofs/eth/latest-proof.json");

if (!ADDRESS) {
  console.error("Missing ADDRESS. Example: ADDRESS=0xabc... STORAGE_KEYS=0x0,0x1 npm run proof:eth");
  process.exit(1);
}

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
  const result = await rpc("eth_getProof", [ADDRESS, STORAGE_KEYS, BLOCK_TAG]);
  const output = {
    generatedAt: new Date().toISOString(),
    rpcUrl: RPC_URL,
    address: ADDRESS,
    blockTag: BLOCK_TAG,
    storageKeys: STORAGE_KEYS,
    proof: result,
  };

  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(output, null, 2)}\n`);

  console.log(`Saved eth_getProof output to ${OUT_FILE}`);
  console.log(`accountProof nodes=${result.accountProof?.length || 0}`);
  console.log(`storageProof entries=${result.storageProof?.length || 0}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
