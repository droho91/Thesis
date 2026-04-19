import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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

function chainFolder(chainKey) {
  if (chainKey === "A" || chainKey === "chainA") return "chainA";
  if (chainKey === "B" || chainKey === "chainB") return "chainB";
  return chainKey;
}

async function loadBesuValidators(chainKey) {
  const path = resolve(process.cwd(), "networks", "besu", chainFolder(chainKey), "validators.json");
  return JSON.parse(await readFile(path, "utf8"));
}

async function qbftCommitSealsForHeaderHash({ chainKey, validators, headerHash }) {
  const validatorEntries = await loadBesuValidators(chainKey);
  const validatorsByAddress = new Map(
    validatorEntries.map((entry) => [ethers.getAddress(entry.address), entry])
  );

  return validators.map((validator) => {
    const address = ethers.getAddress(validator);
    const entry = validatorsByAddress.get(address);
    if (!entry?.privateKey) {
      throw new Error(`No Besu validator private key found for ${address} on chain ${chainKey}.`);
    }
    return new ethers.SigningKey(entry.privateKey).sign(headerHash).serialized;
  });
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

export async function buildConflictingBesuHeaderUpdate({
  provider,
  chainKey,
  blockTag,
  sourceChainId,
  validatorEpoch = 1n,
  conflictStateRoot,
}) {
  const base = await buildBesuHeaderUpdate({
    provider,
    blockTag,
    sourceChainId,
    validatorEpoch,
  });

  const decodedExtraData = ethers.decodeRlp(base.block.extraData);
  if (!Array.isArray(decodedExtraData) || decodedExtraData.length !== 5) {
    throw new Error("QBFT extraData must decode to [vanity, validators, vote, round, seals].");
  }

  const [vanity, validatorsRaw, voteRaw, roundRaw] = decodedExtraData;
  const syntheticStateRoot =
    conflictStateRoot ||
    ethers.keccak256(
      ethers.toUtf8Bytes(`v2-conflict:${chainKey}:${sourceChainId.toString()}:${base.headerUpdate.height.toString()}`)
    );

  const sealHeader = {
    ...base.block,
    stateRoot: syntheticStateRoot,
    extraData: ethers.encodeRlp([vanity, validatorsRaw, voteRaw, roundRaw, []]),
  };
  const rawHeaderRlp = encodeBlockHeaderRlp(sealHeader);
  const headerHash = ethers.keccak256(rawHeaderRlp);
  const commitSeals = await qbftCommitSealsForHeaderHash({
    chainKey,
    validators: base.validatorSet.validators,
    headerHash,
  });
  const fullExtraData = ethers.encodeRlp([vanity, validatorsRaw, voteRaw, roundRaw, commitSeals]);

  return {
    headerUpdate: {
      sourceChainId,
      height: base.headerUpdate.height,
      rawHeaderRlp,
      headerHash,
      parentHash: base.headerUpdate.parentHash,
      stateRoot: syntheticStateRoot,
      extraData: fullExtraData,
    },
    validatorSet: base.validatorSet,
    parsedExtraData: parseQbftExtraData(fullExtraData),
    derived: {
      rawHeaderHash: headerHash,
      validatorsHash: base.derived.validatorsHash,
    },
    block: {
      ...base.block,
      stateRoot: syntheticStateRoot,
      extraData: fullExtraData,
      hash: headerHash,
    },
  };
}
