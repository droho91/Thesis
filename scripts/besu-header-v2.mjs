import { ethers } from "ethers";

export function parseQbftExtraData(extraData) {
  const decoded = ethers.decodeRlp(extraData);
  if (!Array.isArray(decoded) || decoded.length !== 5) {
    throw new Error("QBFT extraData must decode to [vanity, validators, vote, round, seals].");
  }

  const [vanity, validatorsRaw, voteRaw, round, commitSeals] = decoded;
  if (!Array.isArray(validatorsRaw) || !Array.isArray(commitSeals)) {
    throw new Error("QBFT extraData validators and seals must decode as lists.");
  }

  return {
    vanity,
    validators: validatorsRaw.map((value) => ethers.getAddress(value)),
    vote: Array.isArray(voteRaw) ? ethers.encodeRlp(voteRaw) : voteRaw,
    round: round === "0x" ? 0n : BigInt(round),
    commitSeals,
  };
}

export function validatorsHash(validators) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address[]"], [validators.map((value) => ethers.getAddress(value))])
  );
}

function qtyBytes(value) {
  if (value == null) return null;
  if (typeof value === "bigint") return value === 0n ? "0x" : ethers.toBeHex(value);
  if (typeof value === "number") return value === 0 ? "0x" : ethers.toBeHex(BigInt(value));
  if (typeof value !== "string") throw new Error(`Unsupported header scalar: ${value}`);
  if (value === "0x0" || value === "0x00") return "0x";
  return value.startsWith("0x") && value.length % 2 === 1 ? `0x0${value.slice(2)}` : value;
}

export function headerFieldValues(block) {
  const values = [
    block.parentHash,
    block.sha3Uncles,
    block.miner,
    block.stateRoot,
    block.transactionsRoot,
    block.receiptsRoot,
    block.logsBloom,
    qtyBytes(block.difficulty),
    qtyBytes(block.number),
    qtyBytes(block.gasLimit),
    qtyBytes(block.gasUsed),
    qtyBytes(block.timestamp),
    block.extraData,
    block.mixHash,
    block.nonce,
  ];

  if (block.baseFeePerGas != null) values.push(qtyBytes(block.baseFeePerGas));
  if (block.withdrawalsRoot != null) values.push(block.withdrawalsRoot);
  if (block.blobGasUsed != null) values.push(qtyBytes(block.blobGasUsed));
  if (block.excessBlobGas != null) values.push(qtyBytes(block.excessBlobGas));
  if (block.parentBeaconBlockRoot != null) values.push(block.parentBeaconBlockRoot);

  return values;
}

export function encodeBlockHeaderRlp(block) {
  return ethers.encodeRlp(headerFieldValues(block));
}

export function blockForSealHash(block) {
  const parsed = parseQbftExtraData(block.extraData);
  return {
    ...block,
    extraData: ethers.encodeRlp([parsed.vanity, parsed.validators, [], qtyBytes(parsed.round), []]),
  };
}

export async function qbftValidatorsByBlock(provider, blockTag) {
  return provider.send("qbft_getValidatorsByBlockNumber", [blockTag]);
}

export async function buildBesuHeaderUpdate({
  provider,
  blockTag = "latest",
  sourceChainId,
  validatorEpoch = 1n,
}) {
  const block = await provider.send("eth_getBlockByNumber", [blockTag, false]);
  if (!block) throw new Error(`Block ${blockTag} not found.`);

  const sealBlock = blockForSealHash(block);
  const rawHeaderRlp = encodeBlockHeaderRlp(sealBlock);
  const parsedExtraData = parseQbftExtraData(block.extraData);
  const validatorSet = await qbftValidatorsByBlock(provider, blockTag);

  return {
    headerUpdate: {
      sourceChainId,
      height: BigInt(block.number),
      rawHeaderRlp,
      headerHash: block.hash,
      parentHash: block.parentHash,
      stateRoot: block.stateRoot,
      extraData: block.extraData,
    },
    validatorSet: {
      epoch: validatorEpoch,
      activationHeight: BigInt(block.number),
      validators: validatorSet.map((value) => ethers.getAddress(value)),
    },
    parsedExtraData,
    derived: {
      rawHeaderHash: ethers.keccak256(rawHeaderRlp),
      validatorsHash: validatorsHash(validatorSet),
    },
    block,
  };
}
