import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ethers } from "ethers";
import { buildBesuHeaderUpdate } from "./besu-header-update.mjs";

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const BLOCK_TAG = process.env.BLOCK_TAG || "latest";
const SOURCE_CHAIN_ID = BigInt(process.env.SOURCE_CHAIN_ID || "41001");
const VALIDATOR_EPOCH = BigInt(process.env.VALIDATOR_EPOCH || "1");
const OUT_FILE = resolve(process.cwd(), process.env.OUT_FILE || "proofs/besu/latest-header-update.json");

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const output = await buildBesuHeaderUpdate({
    provider,
    blockTag: BLOCK_TAG,
    sourceChainId: SOURCE_CHAIN_ID,
    validatorEpoch: VALIDATOR_EPOCH,
  });

  const serializable = {
    generatedAt: new Date().toISOString(),
    rpcUrl: RPC_URL,
    blockTag: BLOCK_TAG,
    headerUpdate: {
      ...output.headerUpdate,
      sourceChainId: output.headerUpdate.sourceChainId.toString(),
      height: output.headerUpdate.height.toString(),
    },
    validatorSet: {
      epoch: output.validatorSet.epoch.toString(),
      activationHeight: output.validatorSet.activationHeight.toString(),
      validators: output.validatorSet.validators,
    },
    parsedExtraData: {
      ...output.parsedExtraData,
      round: output.parsedExtraData.round.toString(),
    },
    derived: output.derived,
  };

  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(serializable, null, 2)}\n`);
  console.log(`Saved Besu header update to ${OUT_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
