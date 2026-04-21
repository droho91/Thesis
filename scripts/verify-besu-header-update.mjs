import { ethers } from "ethers";
import { buildBesuHeaderUpdate } from "./besu-header-update.mjs";

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const BLOCK_TAG = process.env.BLOCK_TAG || "latest";
const SOURCE_CHAIN_ID = BigInt(process.env.SOURCE_CHAIN_ID || "41001");
const VALIDATOR_EPOCH = BigInt(process.env.VALIDATOR_EPOCH || "1");

function minimumCommitSeals(validatorCount) {
  return Math.floor((validatorCount * 2) / 3) + 1;
}

function unique(values) {
  return [...new Set(values.map((value) => value.toLowerCase()))];
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const result = await buildBesuHeaderUpdate({
    provider,
    blockTag: BLOCK_TAG,
    sourceChainId: SOURCE_CHAIN_ID,
    validatorEpoch: VALIDATOR_EPOCH,
  });

  const { headerUpdate, parsedExtraData, validatorSet, derived } = result;
  const recovered = parsedExtraData.commitSeals.map((seal) => ethers.recoverAddress(headerUpdate.headerHash, seal));
  const uniqueRecovered = unique(recovered);
  const expected = validatorSet.validators.map((value) => value.toLowerCase());
  const missing = uniqueRecovered.filter((value) => !expected.includes(value));

  console.log(`block height        ${headerUpdate.height}`);
  console.log(`block hash          ${headerUpdate.headerHash}`);
  console.log(`derived hash        ${derived.rawHeaderHash}`);
  console.log(`validators hash     ${derived.validatorsHash}`);
  console.log(`validators          ${validatorSet.validators.length}`);
  console.log(`minimum seals       ${minimumCommitSeals(validatorSet.validators.length)}`);
  console.log(`commit seals        ${parsedExtraData.commitSeals.length}`);
  console.log(`unique signers      ${uniqueRecovered.length}`);
  console.log(`signers             ${uniqueRecovered.join(", ")}`);

  if (missing.length > 0) {
    console.log(`unexpected signers  ${missing.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  if (headerUpdate.headerHash.toLowerCase() !== derived.rawHeaderHash.toLowerCase()) {
    console.log("header hash mismatch between RPC block hash and Besu seal header hash");
    process.exitCode = 1;
    return;
  }

  if (uniqueRecovered.length < minimumCommitSeals(validatorSet.validators.length)) {
    console.log("commit seal quorum not met");
    process.exitCode = 1;
    return;
  }

  console.log("Besu commit-seal verification passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
