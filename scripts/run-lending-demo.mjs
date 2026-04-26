import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ethers } from "ethers";
import {
  openProofCheckedChannel,
  openProofCheckedConnection,
  trustRemoteHeaderAt,
} from "./ibc-handshake.mjs";
import { buildBesuHeaderUpdate, buildConflictingBesuHeaderUpdate } from "./besu-header-update.mjs";
import {
  defaultBesuRuntimeEnv,
  loadArtifact,
  normalizeRuntime,
  waitForBesuRuntimeReady,
} from "./besu-runtime.mjs";
import {
  loadRuntimeConfig,
  providerForChain,
  saveRuntimeConfig,
  signerForChain,
  RUNTIME_CONFIG_PATH,
} from "./interchain-config.mjs";

defaultBesuRuntimeEnv();

const OUT_JSON_PATH = resolve(process.cwd(), process.env.DEMO_TRACE_JSON || "demo/latest-run.json");
const OUT_JS_PATH = resolve(process.cwd(), process.env.DEMO_TRACE_JS || "demo/latest-run.js");

const PACKET_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes("IBC.Packet"));
const PACKET_LEAF_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes("IBC.PacketLeaf"));
const PACKET_COMMITMENT_PATH_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes("IBC.PacketCommitmentPath"));
const ACKNOWLEDGEMENT_HASHES_SLOT = 3n;
const PACKET_RECEIPTS_SLOT = 2n;
const CONNECTION_STATE = Object.freeze({
  Uninitialized: 0,
  Init: 1,
  TryOpen: 2,
  Open: 3,
});
const CHANNEL_STATE = Object.freeze({
  Uninitialized: 0,
  Init: 1,
  TryOpen: 2,
  Open: 3,
  Closed: 4,
});

const FORWARD_AMOUNT = ethers.parseUnits(process.env.DEMO_FORWARD_AMOUNT || "100", 18);
const DENIED_AMOUNT = ethers.parseUnits(process.env.DEMO_DENIED_AMOUNT || "40", 18);
const BORROW_AMOUNT_CONFIGURED = process.env.DEMO_BORROW_AMOUNT != null;
const BORROW_AMOUNT = ethers.parseUnits(process.env.DEMO_BORROW_AMOUNT || "120", 18);
const REPAY_AMOUNT = process.env.DEMO_REPAY_AMOUNT ? ethers.parseUnits(process.env.DEMO_REPAY_AMOUNT, 18) : null;
const WITHDRAW_AMOUNT = process.env.DEMO_WITHDRAW_AMOUNT ? ethers.parseUnits(process.env.DEMO_WITHDRAW_AMOUNT, 18) : null;
const LIQUIDATION_REPAY_CONFIGURED = process.env.DEMO_LIQUIDATION_REPAY != null;
const LIQUIDATION_REPAY = ethers.parseUnits(process.env.DEMO_LIQUIDATION_REPAY || "40", 18);
const SHOCKED_VOUCHER_PRICE_E18 = ethers.parseUnits(process.env.DEMO_SHOCKED_VOUCHER_PRICE || "0.5", 18);
const DEMO_TX_GAS_LIMIT = BigInt(process.env.DEMO_TX_GAS_LIMIT || "8000000");
const DEMO_TX_WAIT_TIMEOUT_MS = Number(process.env.DEMO_TX_WAIT_TIMEOUT_MS || process.env.TX_WAIT_TIMEOUT_MS || 120000);

let CURRENT_PHASE = "bootstrap";

function setPhase(phase) {
  CURRENT_PHASE = phase;
  if (process.env.DEBUG_DEMO_FLOW === "true") {
    console.log(`[phase] ${phase}`);
  }
}

function chainId(config, chainKey) {
  return BigInt(config.chains[chainKey].chainId);
}

function chainClientId(chainIdValue) {
  return ethers.zeroPadValue(ethers.toBeHex(chainIdValue), 32);
}

function asBigInt(value) {
  return typeof value === "bigint" ? value : BigInt(value);
}

function stateName(states, value) {
  const numberValue = Number(value);
  return Object.entries(states).find(([, enumValue]) => enumValue === numberValue)?.[0] ?? `Unknown(${numberValue})`;
}

function units(value) {
  return ethers.formatUnits(value, 18);
}

function previewField(preview, key, index, fallback = 0n) {
  const value = preview?.[key] ?? preview?.[index];
  if (value == null) return fallback;
  return typeof value === "bigint" ? value : BigInt(value);
}

function compact(value) {
  if (!value) return "-";
  return value.length > 22 ? `${value.slice(0, 12)}...${value.slice(-8)}` : value;
}

function trustedAnchorFromHeader(result) {
  return {
    sourceChainId: result.headerUpdate.sourceChainId,
    height: result.headerUpdate.height,
    headerHash: result.headerUpdate.headerHash,
    parentHash: result.headerUpdate.parentHash,
    stateRoot: result.headerUpdate.stateRoot,
    timestamp: BigInt(result.block.timestamp),
    validatorsHash: result.derived.validatorsHash,
    exists: true,
  };
}

function packetId(packet) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      [
        "bytes32",
        "uint256",
        "uint256",
        "uint256",
        "address",
        "address",
        "bytes32",
        "bytes32",
        "bytes32",
        "uint64",
        "uint64",
      ],
      [
        PACKET_TYPEHASH,
        packet.sequence,
        packet.source.chainId,
        packet.destination.chainId,
        packet.source.port,
        packet.destination.port,
        packet.source.channel,
        packet.destination.channel,
        ethers.keccak256(packet.data),
        packet.timeout.height,
        packet.timeout.timestamp,
      ]
    )
  );
}

function packetLeaf(packet) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32"], [PACKET_LEAF_TYPEHASH, packetId(packet)])
  );
}

function packetPath(packet) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "address", "bytes32", "uint256"],
      [PACKET_COMMITMENT_PATH_TYPEHASH, packet.source.chainId, packet.source.port, packet.source.channel, packet.sequence]
    )
  );
}

function encodeTransferData({ sender, recipient, asset, amount, action, memo }) {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(address sender,address recipient,address asset,uint256 amount,uint8 action,bytes32 memo)"],
    [{ sender, recipient, asset, amount, action, memo }]
  );
}

function mappingSlot(sequence, slot) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [sequence, slot]));
}

function bytes32MappingSlot(key, slot) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [key, slot]));
}

function rlpWord(word) {
  const bytes = ethers.getBytes(word);
  let firstNonZero = 0;
  while (firstNonZero < bytes.length && bytes[firstNonZero] === 0) firstNonZero++;
  const trimmed = bytes.slice(firstNonZero);
  if (trimmed.length === 0) return "0x80";
  if (trimmed.length === 1 && trimmed[0] < 0x80) return ethers.hexlify(trimmed);
  return ethers.hexlify(ethers.concat([new Uint8Array([0x80 + trimmed.length]), trimmed]));
}

function shortError(error) {
  return error?.shortMessage || error?.info?.error?.message || error?.reason || error?.message || String(error);
}

function txOptions() {
  return { gasLimit: DEMO_TX_GAS_LIMIT };
}

async function waitForTx(tx, label) {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`[demo] ${label} timed out waiting for ${tx.hash}`));
    }, DEMO_TX_WAIT_TIMEOUT_MS);
  });
  const receipt = await Promise.race([tx.wait(), timeout]);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`[demo] ${label} failed in transaction ${tx.hash}`);
  }
  return receipt;
}

async function txStep(label, send) {
  console.log(`[demo] ${label}`);
  const tx = await send();
  console.log(`[demo] ${label} tx=${tx.hash}`);
  return waitForTx(tx, label);
}

async function writeTrace(trace) {
  await mkdir(dirname(OUT_JSON_PATH), { recursive: true });
  await mkdir(dirname(OUT_JS_PATH), { recursive: true });
  await writeFile(OUT_JSON_PATH, `${JSON.stringify(trace, null, 2)}\n`);
  await writeFile(OUT_JS_PATH, `window.InterchainLendingLatestRun = ${JSON.stringify(trace, null, 2)};\n`);
}

async function buildPacketProofs({ provider, packetStoreAddress, packet, sourceChainId, trustedHeight, stateRoot }) {
  const leafSlot = mappingSlot(packet.sequence, 1n);
  const pathSlot = mappingSlot(packet.sequence, 2n);
  const proof = await provider.send("eth_getProof", [packetStoreAddress, [leafSlot, pathSlot], ethers.toQuantity(trustedHeight)]);
  if (!proof?.storageProof || proof.storageProof.length !== 2) {
    throw new Error("eth_getProof did not return both packet storage proofs.");
  }

  const leafEntry = proof.storageProof.find((entry) => entry.key.toLowerCase() === leafSlot.toLowerCase());
  const pathEntry = proof.storageProof.find((entry) => entry.key.toLowerCase() === pathSlot.toLowerCase());
  if (!leafEntry || !pathEntry) {
    throw new Error("Could not match eth_getProof entries to packet leaf/path slots.");
  }

  return {
    leafSlot,
    pathSlot,
    leafProof: {
      sourceChainId,
      trustedHeight,
      stateRoot,
      account: packetStoreAddress,
      storageKey: leafSlot,
      expectedValue: rlpWord(packetLeaf(packet)),
      accountProof: proof.accountProof,
      storageProof: leafEntry.proof,
    },
    pathProof: {
      sourceChainId,
      trustedHeight,
      stateRoot,
      account: packetStoreAddress,
      storageKey: pathSlot,
      expectedValue: rlpWord(packetPath(packet)),
      accountProof: proof.accountProof,
      storageProof: pathEntry.proof,
    },
  };
}

async function buildAcknowledgementProof({
  provider,
  packetHandlerAddress,
  packetIdValue,
  acknowledgementHash,
  sourceChainId,
  trustedHeight,
  stateRoot,
}) {
  const acknowledgementSlot = bytes32MappingSlot(packetIdValue, ACKNOWLEDGEMENT_HASHES_SLOT);
  const proof = await provider.send("eth_getProof", [
    packetHandlerAddress,
    [acknowledgementSlot],
    ethers.toQuantity(trustedHeight),
  ]);
  if (!proof?.storageProof?.length) {
    throw new Error("eth_getProof did not return an acknowledgement storage proof.");
  }

  const acknowledgementEntry = proof.storageProof.find(
    (entry) => entry.key.toLowerCase() === acknowledgementSlot.toLowerCase()
  );
  if (!acknowledgementEntry) {
    throw new Error("Could not match eth_getProof entry to acknowledgement slot.");
  }

  return {
    acknowledgementSlot,
    proof: {
      sourceChainId,
      trustedHeight,
      stateRoot,
      account: packetHandlerAddress,
      storageKey: acknowledgementSlot,
      expectedValue: rlpWord(acknowledgementHash),
      accountProof: proof.accountProof,
      storageProof: acknowledgementEntry.proof,
    },
  };
}

async function buildReceiptAbsenceProof({
  provider,
  packetHandlerAddress,
  packetIdValue,
  sourceChainId,
  trustedHeight,
  stateRoot,
}) {
  const receiptSlot = bytes32MappingSlot(packetIdValue, PACKET_RECEIPTS_SLOT);
  const proof = await provider.send("eth_getProof", [
    packetHandlerAddress,
    [receiptSlot],
    ethers.toQuantity(trustedHeight),
  ]);
  if (!proof?.storageProof?.length) {
    throw new Error("eth_getProof did not return a receipt absence storage proof.");
  }

  const receiptEntry =
    proof.storageProof.find((entry) => entry.key.toLowerCase() === receiptSlot.toLowerCase()) ?? proof.storageProof[0];
  if (!receiptEntry) {
    throw new Error("Could not match eth_getProof entry to receipt slot.");
  }
  if (BigInt(receiptEntry.value) !== 0n) {
    throw new Error(`Expected absent receipt slot, got value ${receiptEntry.value}.`);
  }

  return {
    receiptSlot,
    proof: {
      sourceChainId,
      trustedHeight,
      stateRoot,
      account: packetHandlerAddress,
      storageKey: receiptSlot,
      expectedValue: "0x",
      accountProof: proof.accountProof,
      storageProof: receiptEntry.proof,
    },
  };
}

async function buildWordStorageProof({
  provider,
  account,
  storageKey,
  expectedWord,
  sourceChainId,
  trustedHeight,
  stateRoot,
}) {
  const proof = await provider.send("eth_getProof", [account, [storageKey], ethers.toQuantity(trustedHeight)]);
  if (!proof?.storageProof?.length) {
    throw new Error("eth_getProof did not return a storage proof.");
  }

  const storageEntry =
    proof.storageProof.find((entry) => entry.key.toLowerCase() === storageKey.toLowerCase()) ?? proof.storageProof[0];
  if (!storageEntry) {
    throw new Error("Could not match eth_getProof entry to the requested storage slot.");
  }
  if (BigInt(storageEntry.value) !== BigInt(expectedWord)) {
    throw new Error(`Storage proof value mismatch: expected ${expectedWord}, got ${storageEntry.value}.`);
  }

  return {
    sourceChainId,
    trustedHeight,
    stateRoot,
    account,
    storageKey,
    expectedValue: rlpWord(expectedWord),
    accountProof: proof.accountProof,
    storageProof: storageEntry.proof,
  };
}

async function buildConnectionCommitmentProof({
  provider,
  keeper,
  keeperAddress,
  connectionId,
  sourceChainId,
  trustedHeight,
  stateRoot,
}) {
  return buildWordStorageProof({
    provider,
    account: keeperAddress,
    storageKey: await keeper.connectionCommitmentStorageSlot(connectionId),
    expectedWord: await keeper.connectionCommitments(connectionId),
    sourceChainId,
    trustedHeight,
    stateRoot,
  });
}

async function buildChannelCommitmentProof({
  provider,
  keeper,
  keeperAddress,
  channelId,
  sourceChainId,
  trustedHeight,
  stateRoot,
}) {
  return buildWordStorageProof({
    provider,
    account: keeperAddress,
    storageKey: await keeper.channelCommitmentStorageSlot(channelId),
    expectedWord: await keeper.channelCommitments(channelId),
    sourceChainId,
    trustedHeight,
    stateRoot,
  });
}

async function loadRuntimeArtifacts() {
  return {
    lightClient: await loadArtifact("clients/BesuLightClient.sol", "BesuLightClient"),
    connectionKeeper: await loadArtifact("core/IBCConnectionKeeper.sol", "IBCConnectionKeeper"),
    channelKeeper: await loadArtifact("core/IBCChannelKeeper.sol", "IBCChannelKeeper"),
    packetHandler: await loadArtifact("core/IBCPacketHandler.sol", "IBCPacketHandler"),
    packetStore: await loadArtifact("core/IBCPacketStore.sol", "IBCPacketStore"),
    bankToken: await loadArtifact("apps/BankToken.sol", "BankToken"),
    policy: await loadArtifact("apps/BankPolicyEngine.sol", "BankPolicyEngine"),
    oracle: await loadArtifact("apps/ManualAssetOracle.sol", "ManualAssetOracle"),
    voucher: await loadArtifact("apps/PolicyControlledVoucherToken.sol", "PolicyControlledVoucherToken"),
    escrow: await loadArtifact("apps/PolicyControlledEscrowVault.sol", "PolicyControlledEscrowVault"),
    lendingPool: await loadArtifact("apps/PolicyControlledLendingPool.sol", "PolicyControlledLendingPool"),
    transferApp: await loadArtifact("apps/PolicyControlledTransferApp.sol", "PolicyControlledTransferApp"),
  };
}

function contract(address, artifact, signerOrProvider) {
  return new ethers.Contract(address, artifact.abi, signerOrProvider);
}

async function loadContext(config) {
  const artifacts = await loadRuntimeArtifacts();
  const providerA = providerForChain(config, "A");
  const providerB = providerForChain(config, "B");
  const adminA = await signerForChain(config, "A", 0);
  const adminB = await signerForChain(config, "B", 0);
  const sourceUser = await signerForChain(config, "A", Number(config.participants?.sourceUserIndex ?? 1));
  const destinationUser = await signerForChain(config, "B", Number(config.participants?.destinationUserIndex ?? 1));
  const liquidator = await signerForChain(config, "B", Number(config.participants?.liquidatorIndex ?? 2));

  return {
    artifacts,
    providerA,
    providerB,
    adminA,
    adminB,
    sourceUser,
    destinationUser,
    liquidator,
    sourceUserAddress: await sourceUser.getAddress(),
    destinationUserAddress: await destinationUser.getAddress(),
    liquidatorAddress: await liquidator.getAddress(),
    A: {
      lightClient: contract(config.chains.A.lightClient, artifacts.lightClient, adminA),
      connectionKeeper: contract(config.chains.A.connectionKeeper, artifacts.connectionKeeper, adminA),
      channelKeeper: contract(config.chains.A.channelKeeper, artifacts.channelKeeper, adminA),
      packetHandler: contract(config.chains.A.packetHandler, artifacts.packetHandler, adminA),
      packetStore: contract(config.chains.A.packetStore, artifacts.packetStore, adminA),
      policy: contract(config.chains.A.policyEngine, artifacts.policy, adminA),
      canonicalTokenAdmin: contract(config.chains.A.canonicalToken, artifacts.bankToken, adminA),
      canonicalTokenUser: contract(config.chains.A.canonicalToken, artifacts.bankToken, sourceUser),
      escrow: contract(config.chains.A.escrowVault, artifacts.escrow, adminA),
      transferAppUser: contract(config.chains.A.transferApp, artifacts.transferApp, sourceUser),
    },
    B: {
      lightClient: contract(config.chains.B.lightClient, artifacts.lightClient, adminB),
      connectionKeeper: contract(config.chains.B.connectionKeeper, artifacts.connectionKeeper, adminB),
      channelKeeper: contract(config.chains.B.channelKeeper, artifacts.channelKeeper, adminB),
      packetHandler: contract(config.chains.B.packetHandler, artifacts.packetHandler, adminB),
      packetStore: contract(config.chains.B.packetStore, artifacts.packetStore, adminB),
      policy: contract(config.chains.B.policyEngine, artifacts.policy, adminB),
      voucherUser: contract(config.chains.B.voucherToken, artifacts.voucher, destinationUser),
      voucherAdmin: contract(config.chains.B.voucherToken, artifacts.voucher, adminB),
      debtLiquidator: contract(config.chains.B.debtToken, artifacts.bankToken, liquidator),
      debtAdmin: contract(config.chains.B.debtToken, artifacts.bankToken, adminB),
      oracle: contract(config.chains.B.oracle, artifacts.oracle, adminB),
      lendingPoolUser: contract(config.chains.B.lendingPool, artifacts.lendingPool, destinationUser),
      lendingPoolAdmin: contract(config.chains.B.lendingPool, artifacts.lendingPool, adminB),
      lendingPoolLiquidator: contract(config.chains.B.lendingPool, artifacts.lendingPool, liquidator),
      transferAppAdmin: contract(config.chains.B.transferApp, artifacts.transferApp, adminB),
    },
  };
}

async function ensureSeededConfig(config) {
  if (!config.status?.deployed) {
    throw new Error(`No interchain lending deployment in ${RUNTIME_CONFIG_PATH}. Run npm run deploy first.`);
  }
  if (!config.status?.seeded || !config.participants) {
    throw new Error(`The interchain lending stack is not seeded yet. Run npm run seed before npm run demo.`);
  }
}

async function ensureDeploymentCode(config) {
  const requiredContracts = [
    ["A", "lightClient"],
    ["A", "connectionKeeper"],
    ["A", "channelKeeper"],
    ["A", "packetHandler"],
    ["A", "packetStore"],
    ["A", "policyEngine"],
    ["A", "canonicalToken"],
    ["A", "escrowVault"],
    ["A", "transferApp"],
    ["B", "lightClient"],
    ["B", "connectionKeeper"],
    ["B", "channelKeeper"],
    ["B", "packetHandler"],
    ["B", "packetStore"],
    ["B", "policyEngine"],
    ["B", "voucherToken"],
    ["B", "debtToken"],
    ["B", "oracle"],
    ["B", "lendingPool"],
    ["B", "transferApp"],
  ];
  const providerByChain = {
    A: providerForChain(config, "A"),
    B: providerForChain(config, "B"),
  };
  const missingCode = [];
  for (const [chainKey, field] of requiredContracts) {
    const address = config.chains?.[chainKey]?.[field];
    if (!address || !ethers.isAddress(address)) {
      missingCode.push(`${chainKey}.${field}=missing`);
      continue;
    }
    const code = await providerByChain[chainKey].getCode(address);
    if (code === "0x") missingCode.push(`${chainKey}.${field}=${address}`);
  }
  if (missingCode.length > 0) {
    throw new Error(
      `Stale interchain lending deployment in ${RUNTIME_CONFIG_PATH}; configured contracts have no code on the current Besu chains: ` +
        `${missingCode.join(", ")}. Run npm run deploy && npm run seed before npm run demo.`
    );
  }
}

async function txIfNeeded(label, isReady, send) {
  if (await isReady()) return;
  await txStep(label, send);
}

async function ensureRiskSeeded(config, ctx) {
  const sourceChainId = chainId(config, "A");
  const initialVoucherPrice = BigInt(config.seed.initialVoucherPriceE18);
  const debtPrice = BigInt(config.seed.debtPriceE18);
  const maxOracleStaleness = BigInt(config.seed.maxOracleStaleness || "604800");
  const voucherExposureCap = BigInt(config.seed.voucherExposureCap);
  const collateralCap = BigInt(config.seed.collateralCap);
  const debtAssetBorrowCap = BigInt(config.seed.debtAssetBorrowCap);
  const accountBorrowCap = BigInt(config.seed.accountBorrowCap);
  const collateralFactorBps = BigInt(config.seed.collateralFactorBps);
  const liquidationThresholdBps = BigInt(config.seed.liquidationThresholdBps || "8000");
  const collateralHaircutBps = BigInt(config.seed.collateralHaircutBps);
  const liquidationCloseFactorBps = BigInt(config.seed.liquidationCloseFactorBps);
  const liquidationBonusBps = BigInt(config.seed.liquidationBonusBps);
  const poolLiquidity = BigInt(config.seed.poolLiquidity);
  const liquidatorDebtBalance = BigInt(config.seed.liquidatorDebtBalance);
  const latestBlock = await ctx.providerB.getBlock("latest");
  const now = BigInt(latestBlock?.timestamp ?? 0);
  const priceIsFresh = async (asset, expectedPrice) => {
    const [price, updatedAt] = await Promise.all([
      ctx.B.oracle.assetPriceE18(asset),
      ctx.B.oracle.assetPriceUpdatedAt(asset),
    ]);
    return price === expectedPrice && now >= updatedAt && now - updatedAt <= maxOracleStaleness;
  };

  await txIfNeeded(
    "allow destination user",
    () => ctx.B.policy.accountAllowed(ctx.destinationUserAddress),
    () => ctx.B.policy.setAccountAllowed(ctx.destinationUserAddress, true, txOptions())
  );
  await txIfNeeded(
    "allow Bank A source chain on Bank B",
    () => ctx.B.policy.sourceChainAllowed(sourceChainId),
    () => ctx.B.policy.setSourceChainAllowed(sourceChainId, true, txOptions())
  );
  await txIfNeeded(
    "allow canonical mint asset on Bank B",
    () => ctx.B.policy.mintAssetAllowed(config.chains.A.canonicalToken),
    () => ctx.B.policy.setMintAssetAllowed(config.chains.A.canonicalToken, true, txOptions())
  );
  await txIfNeeded(
    "allow voucher collateral asset",
    () => ctx.B.policy.collateralAssetAllowed(config.chains.B.voucherToken),
    () => ctx.B.policy.setCollateralAssetAllowed(config.chains.B.voucherToken, true, txOptions())
  );
  await txIfNeeded(
    "allow debt asset",
    () => ctx.B.policy.debtAssetAllowed(config.chains.B.debtToken),
    () => ctx.B.policy.setDebtAssetAllowed(config.chains.B.debtToken, true, txOptions())
  );
  await txIfNeeded(
    "set voucher exposure cap",
    async () => (await ctx.B.policy.voucherExposureCap(config.chains.A.canonicalToken)) === voucherExposureCap,
    () => ctx.B.policy.setVoucherExposureCap(config.chains.A.canonicalToken, voucherExposureCap, txOptions())
  );
  await txIfNeeded(
    "set collateral cap",
    async () => (await ctx.B.policy.collateralCap(config.chains.B.voucherToken)) === collateralCap,
    () => ctx.B.policy.setCollateralCap(config.chains.B.voucherToken, collateralCap, txOptions())
  );
  await txIfNeeded(
    "set debt asset borrow cap",
    async () => (await ctx.B.policy.debtAssetBorrowCap(config.chains.B.debtToken)) === debtAssetBorrowCap,
    () => ctx.B.policy.setDebtAssetBorrowCap(config.chains.B.debtToken, debtAssetBorrowCap, txOptions())
  );
  await txIfNeeded(
    "set destination user borrow cap",
    async () => (await ctx.B.policy.accountBorrowCap(ctx.destinationUserAddress)) === accountBorrowCap,
    () => ctx.B.policy.setAccountBorrowCap(ctx.destinationUserAddress, accountBorrowCap, txOptions())
  );

  await txIfNeeded(
    "configure oracle staleness",
    async () => (await ctx.B.oracle.maxStaleness()) === maxOracleStaleness,
    () => ctx.B.oracle.setMaxStaleness(maxOracleStaleness, txOptions())
  );
  await txIfNeeded(
    "reset voucher price",
    () => priceIsFresh(config.chains.B.voucherToken, initialVoucherPrice),
    () => ctx.B.oracle.setPrice(config.chains.B.voucherToken, initialVoucherPrice, txOptions())
  );
  await txIfNeeded(
    "reset debt price",
    () => priceIsFresh(config.chains.B.debtToken, debtPrice),
    () => ctx.B.oracle.setPrice(config.chains.B.debtToken, debtPrice, txOptions())
  );
  await txIfNeeded(
    "configure lending oracle",
    async () => (await ctx.B.lendingPoolAdmin.valuationOracle()).toLowerCase() === config.chains.B.oracle.toLowerCase(),
    () => ctx.B.lendingPoolAdmin.setValuationOracle(config.chains.B.oracle, txOptions())
  );
  await txIfNeeded(
    "configure collateral factor",
    async () => (await ctx.B.lendingPoolAdmin.collateralFactorBps()) === collateralFactorBps,
    () => ctx.B.lendingPoolAdmin.setCollateralFactor(collateralFactorBps, txOptions())
  );
  await txIfNeeded(
    "configure liquidation threshold",
    async () => (await ctx.B.lendingPoolAdmin.liquidationThresholdBps()) === liquidationThresholdBps,
    () => ctx.B.lendingPoolAdmin.setLiquidationThresholdBps(liquidationThresholdBps, txOptions())
  );
  await txIfNeeded(
    "configure collateral haircut",
    async () => (await ctx.B.lendingPoolAdmin.collateralHaircutBps()) === collateralHaircutBps,
    () => ctx.B.lendingPoolAdmin.setCollateralHaircut(collateralHaircutBps, txOptions())
  );
  await txIfNeeded(
    "configure liquidation",
    async () =>
      (await ctx.B.lendingPoolAdmin.liquidationCloseFactorBps()) === liquidationCloseFactorBps &&
      (await ctx.B.lendingPoolAdmin.liquidationBonusBps()) === liquidationBonusBps,
    () => ctx.B.lendingPoolAdmin.setLiquidationConfig(liquidationCloseFactorBps, liquidationBonusBps, txOptions())
  );
  await txIfNeeded(
    "grant liquidator role",
    async () => ctx.B.lendingPoolAdmin.hasRole(await ctx.B.lendingPoolAdmin.LIQUIDATOR_ROLE(), ctx.liquidatorAddress),
    async () => ctx.B.lendingPoolAdmin.grantRole(await ctx.B.lendingPoolAdmin.LIQUIDATOR_ROLE(), ctx.liquidatorAddress, txOptions())
  );
  const suppliedLiquidity = await ctx.B.lendingPoolAdmin.liquidityBalanceOf(config.chains.B.admin);
  if (suppliedLiquidity < poolLiquidity) {
    const depositAmount = poolLiquidity - suppliedLiquidity;
    const supplierBalance = await ctx.B.debtAdmin.balanceOf(config.chains.B.admin);
    if (supplierBalance < depositAmount) {
      await txStep("fund liquidity supplier", () =>
        ctx.B.debtAdmin.mint(config.chains.B.admin, depositAmount - supplierBalance, txOptions())
      );
    }
    await txStep("approve supplier liquidity", () =>
      ctx.B.debtAdmin.approve(config.chains.B.lendingPool, depositAmount, txOptions())
    );
    await txStep("deposit supplier liquidity", () =>
      ctx.B.lendingPoolAdmin.depositLiquidity(depositAmount, txOptions())
    );
  }
  await txIfNeeded(
    "fund liquidator",
    async () => (await ctx.B.debtAdmin.balanceOf(ctx.liquidatorAddress)) >= liquidatorDebtBalance,
    async () =>
      ctx.B.debtAdmin.mint(
        ctx.liquidatorAddress,
        liquidatorDebtBalance - (await ctx.B.debtAdmin.balanceOf(ctx.liquidatorAddress)),
        txOptions()
      )
  );
}

async function readConnectionStates(ctx, sourceConnectionId, destinationConnectionId) {
  const [source, destination] = await Promise.all([
    ctx.A.connectionKeeper.connection(sourceConnectionId),
    ctx.B.connectionKeeper.connection(destinationConnectionId),
  ]);
  return {
    source,
    destination,
    sourceState: Number(source.state),
    destinationState: Number(destination.state),
    sourceStateName: stateName(CONNECTION_STATE, source.state),
    destinationStateName: stateName(CONNECTION_STATE, destination.state),
  };
}

async function readChannelStates(ctx, sourceChannelId, destinationChannelId) {
  const [source, destination] = await Promise.all([
    ctx.A.channelKeeper.channel(sourceChannelId),
    ctx.B.channelKeeper.channel(destinationChannelId),
  ]);
  return {
    source,
    destination,
    sourceState: Number(source.state),
    destinationState: Number(destination.state),
    sourceStateName: stateName(CHANNEL_STATE, source.state),
    destinationStateName: stateName(CHANNEL_STATE, destination.state),
  };
}

async function currentConnectionProof({
  provider,
  lightClient,
  keeper,
  keeperAddress,
  connectionId,
  sourceChainId,
}) {
  const proofAnchor = await trustCurrentHeaderForProof({ lightClient, provider, sourceChainId });
  return {
    height: proofAnchor.height,
    proof: await buildConnectionCommitmentProof({
      provider,
      keeper,
      keeperAddress,
      connectionId,
      sourceChainId,
      trustedHeight: proofAnchor.height,
      stateRoot: proofAnchor.header.headerUpdate.stateRoot,
    }),
  };
}

async function currentChannelProof({
  provider,
  lightClient,
  keeper,
  keeperAddress,
  channelId,
  sourceChainId,
}) {
  const proofAnchor = await trustCurrentHeaderForProof({ lightClient, provider, sourceChainId });
  return {
    height: proofAnchor.height,
    proof: await buildChannelCommitmentProof({
      provider,
      keeper,
      keeperAddress,
      channelId,
      sourceChainId,
      trustedHeight: proofAnchor.height,
      stateRoot: proofAnchor.header.headerUpdate.stateRoot,
    }),
  };
}

function cannotRepairHandshake(kind, states) {
  throw new Error(
    `Interchain ${kind} handshake is partially open in an unsupported state: ` +
      `source=${states.sourceStateName}, destination=${states.destinationStateName}. ` +
      "Use Fresh Reset if this deployment was interrupted across incompatible steps."
  );
}

async function openOrRepairConnectionHandshake(config, ctx, params) {
  const {
    sourceChainId,
    destinationChainId,
    sourceConnectionId,
    destinationConnectionId,
    prefix,
  } = params;

  let states = await readConnectionStates(ctx, sourceConnectionId, destinationConnectionId);
  if (states.sourceState === CONNECTION_STATE.Open && states.destinationState === CONNECTION_STATE.Open) {
    return { reused: true };
  }

  if (
    states.sourceState === CONNECTION_STATE.Uninitialized &&
    states.destinationState === CONNECTION_STATE.Uninitialized
  ) {
    return {
      reused: false,
      ...(await openProofCheckedConnection({
        sourceProvider: ctx.providerA,
        destinationProvider: ctx.providerB,
        sourceLightClient: ctx.A.lightClient,
        destinationLightClient: ctx.B.lightClient,
        sourceConnectionKeeper: ctx.A.connectionKeeper,
        destinationConnectionKeeper: ctx.B.connectionKeeper,
        sourceConnectionKeeperAddress: config.chains.A.connectionKeeper,
        destinationConnectionKeeperAddress: config.chains.B.connectionKeeper,
        sourceChainId,
        destinationChainId,
        sourceConnectionId,
        destinationConnectionId,
        prefix,
      })),
    };
  }

  console.log(
    `[demo] repairing connection handshake source=${states.sourceStateName} destination=${states.destinationStateName}`
  );
  const result = {
    reused: false,
    repaired: true,
    sourceStartState: states.sourceStateName,
    destinationStartState: states.destinationStateName,
    repairSteps: [],
  };

  if (states.sourceState === CONNECTION_STATE.Init && states.destinationState === CONNECTION_STATE.Uninitialized) {
    const sourceInit = await currentConnectionProof({
      provider: ctx.providerA,
      lightClient: ctx.B.lightClient,
      keeper: ctx.A.connectionKeeper,
      keeperAddress: config.chains.A.connectionKeeper,
      connectionId: sourceConnectionId,
      sourceChainId,
    });
    const receipt = await txStep("repair connection open try on destination", () =>
      ctx.B.connectionKeeper.connectionOpenTry(
        destinationConnectionId,
        chainClientId(sourceChainId),
        chainClientId(destinationChainId),
        sourceConnectionId,
        0,
        prefix,
        config.chains.A.connectionKeeper,
        sourceInit.proof,
        txOptions()
      )
    );
    result.repairSteps.push({
      step: "destination-try",
      txHash: receipt.hash,
      proofHeight: sourceInit.height.toString(),
      blockNumber: BigInt(receipt.blockNumber).toString(),
    });
    states = await readConnectionStates(ctx, sourceConnectionId, destinationConnectionId);
  }

  if (states.sourceState === CONNECTION_STATE.Init && states.destinationState === CONNECTION_STATE.TryOpen) {
    const destinationTry = await currentConnectionProof({
      provider: ctx.providerB,
      lightClient: ctx.A.lightClient,
      keeper: ctx.B.connectionKeeper,
      keeperAddress: config.chains.B.connectionKeeper,
      connectionId: destinationConnectionId,
      sourceChainId: destinationChainId,
    });
    const receipt = await txStep("repair connection open ack on source", () =>
      ctx.A.connectionKeeper.connectionOpenAck(
        sourceConnectionId,
        destinationConnectionId,
        config.chains.B.connectionKeeper,
        destinationTry.proof,
        txOptions()
      )
    );
    result.repairSteps.push({
      step: "source-ack",
      txHash: receipt.hash,
      proofHeight: destinationTry.height.toString(),
      blockNumber: BigInt(receipt.blockNumber).toString(),
    });
    states = await readConnectionStates(ctx, sourceConnectionId, destinationConnectionId);
  }

  if (states.sourceState === CONNECTION_STATE.Open && states.destinationState === CONNECTION_STATE.TryOpen) {
    const sourceOpen = await currentConnectionProof({
      provider: ctx.providerA,
      lightClient: ctx.B.lightClient,
      keeper: ctx.A.connectionKeeper,
      keeperAddress: config.chains.A.connectionKeeper,
      connectionId: sourceConnectionId,
      sourceChainId,
    });
    const receipt = await txStep("repair connection open confirm on destination", () =>
      ctx.B.connectionKeeper.connectionOpenConfirm(
        destinationConnectionId,
        config.chains.A.connectionKeeper,
        sourceOpen.proof,
        txOptions()
      )
    );
    result.repairSteps.push({
      step: "destination-confirm",
      txHash: receipt.hash,
      proofHeight: sourceOpen.height.toString(),
      blockNumber: BigInt(receipt.blockNumber).toString(),
    });
    states = await readConnectionStates(ctx, sourceConnectionId, destinationConnectionId);
  }

  if (states.sourceState !== CONNECTION_STATE.Open || states.destinationState !== CONNECTION_STATE.Open) {
    cannotRepairHandshake("connection", states);
  }

  result.sourceEndState = states.sourceStateName;
  result.destinationEndState = states.destinationStateName;
  return result;
}

async function openOrRepairChannelHandshake(config, ctx, params) {
  const {
    sourceChainId,
    destinationChainId,
    sourceConnectionId,
    destinationConnectionId,
    sourceChannelId,
    destinationChannelId,
    ordering,
    version,
  } = params;

  const [sourceChannelOpen, destinationChannelOpen] = await Promise.all([
    ctx.A.channelKeeper.isPacketRouteOpenForChannel(
      destinationChainId,
      config.chains.B.transferApp,
      config.chains.A.transferApp,
      sourceChannelId,
      destinationChannelId
    ),
    ctx.B.channelKeeper.isPacketRouteOpenForChannel(
      sourceChainId,
      config.chains.A.transferApp,
      config.chains.B.transferApp,
      destinationChannelId,
      sourceChannelId
    ),
  ]);

  let states = await readChannelStates(ctx, sourceChannelId, destinationChannelId);
  if (sourceChannelOpen && destinationChannelOpen) {
    return { reused: true };
  }

  if (
    states.sourceState === CHANNEL_STATE.Uninitialized &&
    states.destinationState === CHANNEL_STATE.Uninitialized
  ) {
    return {
      reused: false,
      ...(await openProofCheckedChannel({
        sourceProvider: ctx.providerA,
        destinationProvider: ctx.providerB,
        sourceLightClient: ctx.A.lightClient,
        destinationLightClient: ctx.B.lightClient,
        sourceChannelKeeper: ctx.A.channelKeeper,
        destinationChannelKeeper: ctx.B.channelKeeper,
        sourceChannelKeeperAddress: config.chains.A.channelKeeper,
        destinationChannelKeeperAddress: config.chains.B.channelKeeper,
        sourceChainId,
        destinationChainId,
        sourceConnectionId,
        destinationConnectionId,
        sourceChannelId,
        destinationChannelId,
        sourcePort: config.chains.A.transferApp,
        destinationPort: config.chains.B.transferApp,
        ordering,
        version,
      })),
    };
  }

  console.log(
    `[demo] repairing channel handshake source=${states.sourceStateName} destination=${states.destinationStateName}`
  );
  const result = {
    reused: false,
    repaired: true,
    sourceStartState: states.sourceStateName,
    destinationStartState: states.destinationStateName,
    repairSteps: [],
  };

  if (states.sourceState === CHANNEL_STATE.Init && states.destinationState === CHANNEL_STATE.Uninitialized) {
    const sourceInit = await currentChannelProof({
      provider: ctx.providerA,
      lightClient: ctx.B.lightClient,
      keeper: ctx.A.channelKeeper,
      keeperAddress: config.chains.A.channelKeeper,
      channelId: sourceChannelId,
      sourceChainId,
    });
    const receipt = await txStep("repair channel open try on destination", () =>
      ctx.B.channelKeeper.channelOpenTry(
        destinationChannelId,
        destinationConnectionId,
        sourceChainId,
        config.chains.A.transferApp,
        config.chains.B.transferApp,
        sourceChannelId,
        ordering,
        version,
        config.chains.A.channelKeeper,
        sourceInit.proof,
        txOptions()
      )
    );
    result.repairSteps.push({
      step: "destination-try",
      txHash: receipt.hash,
      proofHeight: sourceInit.height.toString(),
      blockNumber: BigInt(receipt.blockNumber).toString(),
    });
    states = await readChannelStates(ctx, sourceChannelId, destinationChannelId);
  }

  if (states.sourceState === CHANNEL_STATE.Init && states.destinationState === CHANNEL_STATE.TryOpen) {
    const destinationTry = await currentChannelProof({
      provider: ctx.providerB,
      lightClient: ctx.A.lightClient,
      keeper: ctx.B.channelKeeper,
      keeperAddress: config.chains.B.channelKeeper,
      channelId: destinationChannelId,
      sourceChainId: destinationChainId,
    });
    const receipt = await txStep("repair channel open ack on source", () =>
      ctx.A.channelKeeper.channelOpenAck(
        sourceChannelId,
        destinationChannelId,
        config.chains.B.channelKeeper,
        destinationTry.proof,
        txOptions()
      )
    );
    result.repairSteps.push({
      step: "source-ack",
      txHash: receipt.hash,
      proofHeight: destinationTry.height.toString(),
      blockNumber: BigInt(receipt.blockNumber).toString(),
    });
    states = await readChannelStates(ctx, sourceChannelId, destinationChannelId);
  }

  if (states.sourceState === CHANNEL_STATE.Open && states.destinationState === CHANNEL_STATE.TryOpen) {
    const sourceOpen = await currentChannelProof({
      provider: ctx.providerA,
      lightClient: ctx.B.lightClient,
      keeper: ctx.A.channelKeeper,
      keeperAddress: config.chains.A.channelKeeper,
      channelId: sourceChannelId,
      sourceChainId,
    });
    const receipt = await txStep("repair channel open confirm on destination", () =>
      ctx.B.channelKeeper.channelOpenConfirm(
        destinationChannelId,
        config.chains.A.channelKeeper,
        sourceOpen.proof,
        txOptions()
      )
    );
    result.repairSteps.push({
      step: "destination-confirm",
      txHash: receipt.hash,
      proofHeight: sourceOpen.height.toString(),
      blockNumber: BigInt(receipt.blockNumber).toString(),
    });
    states = await readChannelStates(ctx, sourceChannelId, destinationChannelId);
  }

  const [sourceRouteOpenAfter, destinationRouteOpenAfter] = await Promise.all([
    ctx.A.channelKeeper.isPacketRouteOpenForChannel(
      destinationChainId,
      config.chains.B.transferApp,
      config.chains.A.transferApp,
      sourceChannelId,
      destinationChannelId
    ),
    ctx.B.channelKeeper.isPacketRouteOpenForChannel(
      sourceChainId,
      config.chains.A.transferApp,
      config.chains.B.transferApp,
      destinationChannelId,
      sourceChannelId
    ),
  ]);
  if (!sourceRouteOpenAfter || !destinationRouteOpenAfter) {
    cannotRepairHandshake("channel", states);
  }

  result.sourceEndState = states.sourceStateName;
  result.destinationEndState = states.destinationStateName;
  return result;
}

async function openOrReuseHandshake(config, ctx) {
  const sourceChainId = chainId(config, "A");
  const destinationChainId = chainId(config, "B");
  const constants = config.constants;
  const sourceConnectionId = constants.sourceConnectionId;
  const destinationConnectionId = constants.destinationConnectionId;
  const sourceChannelId = constants.sourceChannelId;
  const destinationChannelId = constants.destinationChannelId;

  const connectionHandshake = await openOrRepairConnectionHandshake(config, ctx, {
    sourceChainId,
    destinationChainId,
    sourceConnectionId,
    destinationConnectionId,
    prefix: constants.connectionPrefix,
  });

  const channelHandshake = await openOrRepairChannelHandshake(config, ctx, {
    sourceChainId,
    destinationChainId,
    sourceConnectionId,
    destinationConnectionId,
    sourceChannelId,
    destinationChannelId,
    ordering: Number(constants.orderValue),
    version: constants.channelVersion,
  });

  config.status = {
    ...(config.status || {}),
    proofCheckedHandshakeOpened: true,
  };
  await saveRuntimeConfig(config);

  return { connectionHandshake, channelHandshake };
}

async function currentRouteStatus(config, ctx) {
  const sourceChainId = chainId(config, "A");
  const destinationChainId = chainId(config, "B");
  const constants = config.constants;

  const [connection, channel, sourceRouteOpen, destinationRouteOpen] = await Promise.all([
    readConnectionStates(ctx, constants.sourceConnectionId, constants.destinationConnectionId),
    readChannelStates(ctx, constants.sourceChannelId, constants.destinationChannelId),
    ctx.A.channelKeeper.isPacketRouteOpenForChannel(
      destinationChainId,
      config.chains.B.transferApp,
      config.chains.A.transferApp,
      constants.sourceChannelId,
      constants.destinationChannelId
    ),
    ctx.B.channelKeeper.isPacketRouteOpenForChannel(
      sourceChainId,
      config.chains.A.transferApp,
      config.chains.B.transferApp,
      constants.destinationChannelId,
      constants.sourceChannelId
    ),
  ]);

  const ready =
    connection.sourceState === CONNECTION_STATE.Open &&
    connection.destinationState === CONNECTION_STATE.Open &&
    sourceRouteOpen &&
    destinationRouteOpen;

  return {
    ready,
    connection,
    channel,
    sourceRouteOpen,
    destinationRouteOpen,
  };
}

async function requireOpenHandshake(config, ctx) {
  const status = await currentRouteStatus(config, ctx);
  if (status.ready) return status;

  const routeText = `${status.sourceRouteOpen ? "open" : "closed"} / ${status.destinationRouteOpen ? "open" : "closed"}`;
  throw new Error(
    "The IBC connection and channel are not ready yet. Run Open Channel first. " +
      `connection=${status.connection.sourceStateName}/${status.connection.destinationStateName}, ` +
      `channel=${status.channel.sourceStateName}/${status.channel.destinationStateName}, route=${routeText}.`
  );
}

function transferPacket({ sequence, sourceChainId, destinationChainId, config, sender, recipient, amount, timeoutHeight = 0n }) {
  return {
    sequence,
    source: {
      chainId: sourceChainId,
      port: config.chains.A.transferApp,
      channel: config.constants.sourceChannelId,
    },
    destination: {
      chainId: destinationChainId,
      port: config.chains.B.transferApp,
      channel: config.constants.destinationChannelId,
    },
    data: encodeTransferData({
      sender,
      recipient,
      asset: config.chains.A.canonicalToken,
      amount,
      action: 1,
      memo: ethers.ZeroHash,
    }),
    timeout: { height: timeoutHeight, timestamp: 0n },
  };
}

function reversePacket({ sequence, sourceChainId, destinationChainId, config, sender, recipient, amount, timeoutHeight = 0n }) {
  return {
    sequence,
    source: {
      chainId: sourceChainId,
      port: config.chains.B.transferApp,
      channel: config.constants.destinationChannelId,
    },
    destination: {
      chainId: destinationChainId,
      port: config.chains.A.transferApp,
      channel: config.constants.sourceChannelId,
    },
    data: encodeTransferData({
      sender,
      recipient,
      asset: config.chains.A.canonicalToken,
      amount,
      action: 2,
      memo: ethers.ZeroHash,
    }),
    timeout: { height: timeoutHeight, timestamp: 0n },
  };
}

async function readExistingTrace() {
  try {
    return JSON.parse(await readFile(OUT_JSON_PATH, "utf8"));
  } catch {
    return {};
  }
}

function baseTrace(config, ctx) {
  return {
    version: "interchain-lending",
    configPath: RUNTIME_CONFIG_PATH,
    runtime: config.runtime,
    architecture:
      "Besu light-client header imports, EVM storage-proof packet relay, and policy-controlled cross-chain lending.",
    chains: {
      A: {
        chainId: String(config.chains.A.chainId),
        lightClient: config.chains.A.lightClient,
        packetHandler: config.chains.A.packetHandler,
        packetStore: config.chains.A.packetStore,
        transferApp: config.chains.A.transferApp,
        canonicalToken: config.chains.A.canonicalToken,
        escrowVault: config.chains.A.escrowVault,
      },
      B: {
        chainId: String(config.chains.B.chainId),
        lightClient: config.chains.B.lightClient,
        packetHandler: config.chains.B.packetHandler,
        packetStore: config.chains.B.packetStore,
        transferApp: config.chains.B.transferApp,
        voucherToken: config.chains.B.voucherToken,
        debtToken: config.chains.B.debtToken,
        oracle: config.chains.B.oracle,
        lendingPool: config.chains.B.lendingPool,
      },
    },
    participants: {
      sourceUser: ctx.sourceUserAddress,
      destinationUser: ctx.destinationUserAddress,
      liquidator: ctx.liquidatorAddress,
    },
  };
}

async function writeTracePatch(config, ctx, patch, latestOperation) {
  const previous = await readExistingTrace();
  const trace = {
    ...previous,
    ...baseTrace(config, ctx),
    generatedAt: new Date().toISOString(),
  };
  for (const [key, value] of Object.entries(patch)) {
    if (
      trace[key] &&
      typeof trace[key] === "object" &&
      !Array.isArray(trace[key]) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      trace[key] = { ...trace[key], ...value };
    } else {
      trace[key] = value;
    }
  }
  trace.latestOperation = latestOperation;
  await writeTrace(trace);
  return trace;
}

function handshakeTrace(config, connectionHandshake, channelHandshake) {
  return {
    connection: connectionHandshake,
    channel: channelHandshake,
    sourceConnectionId: config.constants.sourceConnectionId,
    destinationConnectionId: config.constants.destinationConnectionId,
    sourceChannelId: config.constants.sourceChannelId,
    destinationChannelId: config.constants.destinationChannelId,
  };
}

function amountFromTrace(value, fallback) {
  if (!value) return fallback;
  return value.amountRaw ? BigInt(value.amountRaw) : ethers.parseUnits(value.amount || "0", 18);
}

async function prepareStepContext() {
  const runtime = normalizeRuntime();
  if (!runtime.besuFirst) {
    throw new Error("run-lending-demo.mjs is a Besu-first entrypoint.");
  }
  await waitForBesuRuntimeReady();
  const config = await loadRuntimeConfig();
  await ensureSeededConfig(config);
  await ensureDeploymentCode(config);
  const ctx = await loadContext(config);
  return { config, ctx, sourceChainId: chainId(config, "A"), destinationChainId: chainId(config, "B") };
}

async function ensureForwardPacket(config, ctx, sourceChainId, destinationChainId) {
  const trace = await readExistingTrace();
  if (trace.forward?.packetId && trace.forward?.sequence && trace.forward?.commitHeight) {
    const committed = await ctx.A.packetStore.committedPacket(trace.forward.packetId).catch(() => false);
    if (!committed) {
      throw new Error("Forward packet is missing from Bank A. Run Lock aBANK before the header or proof steps.");
    }

    const amount = amountFromTrace(trace.forward, FORWARD_AMOUNT);
    return {
      trace,
      sequence: BigInt(trace.forward.sequence),
      commitHeight: BigInt(trace.forward.commitHeight),
      amount,
      packetId: trace.forward.packetId,
      packet: transferPacket({
        sequence: BigInt(trace.forward.sequence),
        sourceChainId,
        destinationChainId,
        config,
        sender: ctx.sourceUserAddress,
        recipient: ctx.destinationUserAddress,
        amount,
      }),
    };
  }

  throw new Error("No forward packet exists yet. Run Lock aBANK before the header or proof steps.");
}

async function ensureForwardPacketReceived(config, ctx, sourceChainId, destinationChainId) {
  const forward = await ensureForwardPacket(config, ctx, sourceChainId, destinationChainId);
  const received = await ctx.B.packetHandler.packetReceipts(forward.packetId).catch(() => false);
  if (received) return forward;

  throw new Error("Forward packet is not received on Bank B yet. Run Verify Proof + Mint before Replay Forward.");
}

async function ensureReversePacket(config, ctx, sourceChainId, destinationChainId) {
  const trace = await readExistingTrace();
  if (trace.reverse?.packetId && trace.reverse?.sequence && trace.reverse?.commitHeight) {
    const amount = amountFromTrace(trace.reverse, FORWARD_AMOUNT);
    return {
      trace,
      sequence: BigInt(trace.reverse.sequence),
      commitHeight: BigInt(trace.reverse.commitHeight),
      amount,
      packetId: trace.reverse.packetId,
      packet: reversePacket({
        sequence: BigInt(trace.reverse.sequence),
        sourceChainId: destinationChainId,
        destinationChainId: sourceChainId,
        config,
        sender: ctx.destinationUserAddress,
        recipient: ctx.sourceUserAddress,
        amount,
      }),
    };
  }

  throw new Error("No reverse packet exists yet. Burn a free voucher first.");
}

async function trustForwardHeader(config, ctx, sourceChainId, commitHeight) {
  return trustRemoteHeaderAt({
    lightClient: ctx.B.lightClient,
    provider: ctx.providerA,
    sourceChainId,
    targetHeight: commitHeight,
    validatorEpoch: 1n,
  });
}

async function readForwardHeader(ctx, sourceChainId, commitHeight) {
  return buildBesuHeaderUpdate({
    provider: ctx.providerA,
    blockTag: ethers.toQuantity(commitHeight),
    sourceChainId,
    validatorEpoch: 1n,
  });
}

async function trustReverseHeader(config, ctx, destinationChainId, commitHeight) {
  return trustRemoteHeaderAt({
    lightClient: ctx.A.lightClient,
    provider: ctx.providerB,
    sourceChainId: destinationChainId,
    targetHeight: commitHeight,
    validatorEpoch: 1n,
  });
}

async function readReverseHeader(ctx, destinationChainId, commitHeight) {
  return buildBesuHeaderUpdate({
    provider: ctx.providerB,
    blockTag: ethers.toQuantity(commitHeight),
    sourceChainId: destinationChainId,
    validatorEpoch: 1n,
  });
}

async function requireTrustedProofAnchor({ lightClient, sourceChainId, minimumHeight, sourceLabel, destinationLabel }) {
  const requiredHeight = BigInt(minimumHeight);
  const trustedHeight = BigInt(await lightClient.latestTrustedHeight(sourceChainId));
  if (trustedHeight < requiredHeight) {
    throw new Error(
      `${destinationLabel} does not yet trust ${sourceLabel} at packet height ${requiredHeight.toString()}. ` +
        `Run the client update step before executing the storage proof.`
    );
  }

  const header = await lightClient.trustedHeader(sourceChainId, trustedHeight);
  if (!header.exists) {
    throw new Error(`${destinationLabel} trusted height ${trustedHeight.toString()} is missing from the light client.`);
  }
  return {
    height: trustedHeight,
    headerHash: header.headerHash,
    stateRoot: header.stateRoot,
  };
}

async function trustCurrentHeaderForProof({ lightClient, provider, sourceChainId, minimumHeight = 0n }) {
  const targetHeight = BigInt(await provider.getBlockNumber());
  if (targetHeight < minimumHeight) {
    throw new Error(
      `Current source-chain head ${targetHeight.toString()} is below required proof height ${minimumHeight.toString()}.`
    );
  }

  const header = await trustRemoteHeaderAt({
    lightClient,
    provider,
    sourceChainId,
    targetHeight,
    validatorEpoch: 1n,
  });

  const trustedHeight = BigInt(header.headerUpdate.height);
  if (trustedHeight < minimumHeight) {
    throw new Error(
      `Trusted source height ${trustedHeight.toString()} is below required proof height ${minimumHeight.toString()}.`
    );
  }
  return { height: trustedHeight, header };
}

function isKnownReplay(error) {
  const text = shortError(error);
  return text.includes("PACKET_ALREADY_RECEIVED") || text.includes("PACKET_ALREADY_ACKNOWLEDGED");
}

const SAFETY_MODE_ACTIONS = new Set([
  "freezeClient",
  "recoverClient",
  "topUpRepayCash",
  "simulatePriceShock",
  "executeLiquidation",
]);

async function requireDemoSafetyModeAllows(action, ctx, sourceChainId) {
  if (SAFETY_MODE_ACTIONS.has(action)) return;

  const status = Number(await ctx.B.lightClient.status(sourceChainId));
  if (status !== 2 && status !== 3) return;

  const label = status === 2 ? "Frozen" : "Recovering";
  throw new Error(
    `Bank B light client for Bank A is ${label}. Safety mode blocks interchain demo actions until ` +
      "Recover Light Client completes. Use Refresh State or Fresh Reset if you want to inspect/reset the demo."
  );
}

export async function runDemoStep(action, options = {}) {
  const prepared = options.prepared ?? await prepareStepContext();
  const { config, ctx, sourceChainId, destinationChainId } = prepared;
  await requireDemoSafetyModeAllows(action, ctx, sourceChainId);

  if (action === "fullFlow") {
    return main();
  }

  if (action === "openRoute") {
    setPhase("step-open-route");
    const { connectionHandshake, channelHandshake } = await openOrReuseHandshake(config, ctx);
    const routeStatus = await currentRouteStatus(config, ctx);
    return writeTracePatch(
      config,
      ctx,
      {
        handshake: {
          ...handshakeTrace(config, connectionHandshake, channelHandshake),
          ready: routeStatus.ready,
          sourceRouteOpen: routeStatus.sourceRouteOpen,
          destinationRouteOpen: routeStatus.destinationRouteOpen,
        },
      },
      {
        phase: "route-ready",
        label: "Opened IBC connection and channel",
        summary:
          `Connection ${routeStatus.connection.sourceStateName}/${routeStatus.connection.destinationStateName}, ` +
          `channel ${routeStatus.channel.sourceStateName}/${routeStatus.channel.destinationStateName}.`,
      }
    );
  }

  if (action === "lock") {
    setPhase("step-lock-check-route");
    await requireOpenHandshake(config, ctx);
    await ensureRiskSeeded(config, ctx);
    await txStep("step approve escrow", () =>
      ctx.A.canonicalTokenUser.approve(config.chains.A.escrowVault, FORWARD_AMOUNT + DENIED_AMOUNT, txOptions())
    );

    setPhase("step-lock-send");
    const sequence = asBigInt(await ctx.A.packetStore.nextSequence());
    const receipt = await txStep("step send forward transfer", () =>
      ctx.A.transferAppUser.sendTransfer(destinationChainId, ctx.destinationUserAddress, FORWARD_AMOUNT, 0, 0, txOptions())
    );
    const commitHeight = BigInt(receipt.blockNumber);
    const packet = transferPacket({
      sequence,
      sourceChainId,
      destinationChainId,
      config,
      sender: ctx.sourceUserAddress,
      recipient: ctx.destinationUserAddress,
      amount: FORWARD_AMOUNT,
    });
    const packetIdValue = await ctx.A.packetStore.packetIdAt(sequence);
    const trace = await writeTracePatch(
      config,
      ctx,
      {
        forward: {
          operation: "Bank A escrow lock -> Bank B voucher mint",
          sequence: sequence.toString(),
          amount: units(FORWARD_AMOUNT),
          amountRaw: FORWARD_AMOUNT.toString(),
          packetId: packetIdValue,
          packetLeaf: packetLeaf(packet),
          packetPath: packetPath(packet),
          sourceTxHash: receipt.hash,
          commitHeight: commitHeight.toString(),
        },
      },
      {
        phase: "forward-locked",
        label: "Locked aBANK and committed a IBC packet",
        summary: `Bank A escrowed ${units(FORWARD_AMOUNT)} aBANK and wrote packet ${compact(packetIdValue)}.`,
      }
    );
    console.log(`Locked ${units(FORWARD_AMOUNT)} aBANK and committed packet ${packetIdValue}`);
    return trace;
  }

  if (action === "finalizeForwardHeader") {
    setPhase("step-finalizeForwardHeader");
    const forward = await ensureForwardPacket(config, ctx, sourceChainId, destinationChainId);
    const header = await readForwardHeader(ctx, sourceChainId, forward.commitHeight);
    const trace = await writeTracePatch(
      config,
      ctx,
      {
        forward: {
          finalizedHeight: header.headerUpdate.height.toString(),
          finalizedHeaderHash: header.headerUpdate.headerHash,
          finalizedStateRoot: header.headerUpdate.stateRoot,
        },
      },
      {
        phase: "forward-header-read",
        label: "Read Bank A packet header",
        summary: `Read Bank A Besu header #${header.headerUpdate.height.toString()}; Bank B still needs a client update before proof execution.`,
      }
    );
    console.log(`Read Bank A header #${header.headerUpdate.height.toString()} for the forward packet`);
    return trace;
  }

  if (action === "updateForwardClient") {
    setPhase("step-updateForwardClient");
    const forward = await ensureForwardPacket(config, ctx, sourceChainId, destinationChainId);
    const header = await trustForwardHeader(config, ctx, sourceChainId, forward.commitHeight);
    const trace = await writeTracePatch(
      config,
      ctx,
      {
        forward: {
          trustedHeight: header.headerUpdate.height.toString(),
          trustedHeaderHash: header.headerUpdate.headerHash,
          trustedStateRoot: header.headerUpdate.stateRoot,
        },
      },
      {
        phase: "forward-header-trusted",
        label: "Updated Bank B Besu light client",
        summary: `Bank B now trusts Bank A Besu header #${header.headerUpdate.height.toString()}.`,
      }
    );
    console.log(`Trusted Bank A header #${header.headerUpdate.height.toString()} on Bank B`);
    return trace;
  }

  if (action === "proveForwardMint") {
    setPhase("step-prove-forward");
    await requireOpenHandshake(config, ctx);
    const forward = await ensureForwardPacket(config, ctx, sourceChainId, destinationChainId);
    const proofAnchor = await requireTrustedProofAnchor({
      lightClient: ctx.B.lightClient,
      sourceChainId,
      minimumHeight: forward.commitHeight,
      sourceLabel: "Bank A",
      destinationLabel: "Bank B",
    });
    const proofs = await buildPacketProofs({
      provider: ctx.providerA,
      packetStoreAddress: config.chains.A.packetStore,
      packet: forward.packet,
      sourceChainId,
      trustedHeight: proofAnchor.height,
      stateRoot: proofAnchor.stateRoot,
    });

    let recvReceipt = null;
    try {
      recvReceipt = await txStep("step receive forward packet", () =>
        ctx.B.packetHandler.recvPacketFromStorageProof(forward.packet, proofs.leafProof, proofs.pathProof, txOptions())
      );
    } catch (error) {
      if (!isKnownReplay(error)) throw error;
    }

    const receiveHeight = recvReceipt ? BigInt(recvReceipt.blockNumber) : BigInt(await ctx.providerB.getBlockNumber());
    const ackHash = await ctx.B.packetHandler.acknowledgementHashes(forward.packetId);
    if (ackHash !== ethers.ZeroHash) {
      const ackAnchor = await trustCurrentHeaderForProof({
        lightClient: ctx.A.lightClient,
        provider: ctx.providerB,
        sourceChainId: destinationChainId,
        minimumHeight: receiveHeight,
      });
      const acknowledgement = ethers.solidityPacked(["string", "bytes32"], ["ok:", forward.packetId]);
      const { acknowledgementSlot, proof: ackProof } = await buildAcknowledgementProof({
        provider: ctx.providerB,
        packetHandlerAddress: config.chains.B.packetHandler,
        packetIdValue: forward.packetId,
        acknowledgementHash: ackHash,
        sourceChainId: destinationChainId,
        trustedHeight: ackAnchor.height,
        stateRoot: ackAnchor.header.headerUpdate.stateRoot,
      });
      try {
        await txStep("step acknowledge forward packet", () =>
          ctx.A.packetHandler.acknowledgePacketFromStorageProof(
            forward.packet,
            acknowledgement,
            config.chains.B.packetHandler,
            ackProof,
            txOptions()
          )
        );
      } catch (error) {
        if (!isKnownReplay(error)) throw error;
      }
      const voucherBalance = await ctx.B.voucherAdmin.balanceOf(ctx.destinationUserAddress);
      const sourceAckHash = await ctx.A.transferAppUser.acknowledgementHashByPacket(forward.packetId);
      const trace = await writeTracePatch(
        config,
        ctx,
        {
          forward: {
            packetLeafSlot: proofs.leafSlot,
            packetPathSlot: proofs.pathSlot,
            receiveTxHash: recvReceipt?.hash,
            receiveHeight: receiveHeight.toString(),
            trustedHeight: proofAnchor.height.toString(),
            trustedHeaderHash: proofAnchor.headerHash,
            trustedStateRoot: proofAnchor.stateRoot,
            destinationAckHash: ackHash,
            sourceAckHash,
            acknowledgementSlot,
            acknowledgementTrustedHeight: ackAnchor.height.toString(),
            voucherBalanceAfterReceive: units(voucherBalance),
            proofMode: "storage",
          },
        },
        {
          phase: "forward-proven",
          label: "Executed IBC packet storage proof",
          summary: `Bank B verified packet ${compact(forward.packetId)}, minted voucher, and Bank A verified the acknowledgement.`,
        }
      );
      console.log(`Proved and received packet ${forward.packetId}`);
      return trace;
    }
    throw new Error("Destination packet handler did not store an acknowledgement hash.");
  }

  if (action === "depositCollateral") {
    setPhase("step-deposit-collateral");
    await ensureRiskSeeded(config, ctx);
    const trace = await readExistingTrace();
    const desiredCollateral = amountFromTrace(trace.forward, FORWARD_AMOUNT);
    const balance = await ctx.B.voucherAdmin.balanceOf(ctx.destinationUserAddress);
    if (balance < desiredCollateral) throw new Error("Bank B user needs a proven voucher before depositing collateral.");
    const currentCollateral = await ctx.B.lendingPoolAdmin.collateralBalance(ctx.destinationUserAddress);
    if (currentCollateral < desiredCollateral) {
      const depositAmount = desiredCollateral - currentCollateral;
      await txStep("step approve voucher collateral", () =>
        ctx.B.voucherUser.approve(config.chains.B.lendingPool, depositAmount, txOptions())
      );
      await txStep("step deposit collateral", () =>
        ctx.B.lendingPoolUser.depositCollateral(depositAmount, txOptions())
      );
    }
    const collateral = await ctx.B.lendingPoolAdmin.collateralBalance(ctx.destinationUserAddress);
    return writeTracePatch(
      config,
      ctx,
      { risk: { collateralDeposited: units(collateral) } },
      {
        phase: "collateral-deposited",
        label: "Deposited proven voucher collateral",
        summary: `Bank B lending pool now holds ${units(collateral)} vA as collateral.`,
      }
    );
  }

  if (action === "borrow") {
    setPhase("step-borrow");
    await ensureRiskSeeded(config, ctx);
    const debt = await ctx.B.lendingPoolAdmin.debtBalance(ctx.destinationUserAddress);
    const borrowDelta = BORROW_AMOUNT_CONFIGURED ? BORROW_AMOUNT : BORROW_AMOUNT > debt ? BORROW_AMOUNT - debt : 0n;
    if (borrowDelta > 0n) {
      const availableBeforeBorrow = await ctx.B.lendingPoolAdmin.availableToBorrow(ctx.destinationUserAddress);
      if (availableBeforeBorrow < borrowDelta) {
        const collateral = await ctx.B.lendingPoolAdmin.collateralBalance(ctx.destinationUserAddress);
        throw new Error(
          `BORROW_LIMIT: available ${units(availableBeforeBorrow)} bCASH, need ${units(borrowDelta)}; ` +
            `collateral=${units(collateral)} vA, existingDebt=${units(debt)} bCASH.`
        );
      }
      await txStep("step borrow debt asset", () => ctx.B.lendingPoolUser.borrow(borrowDelta, txOptions()));
    }
    const debtAfterBorrow = await ctx.B.lendingPoolAdmin.debtBalance(ctx.destinationUserAddress);
    const healthBeforeShock = await ctx.B.lendingPoolAdmin.healthFactorBps(ctx.destinationUserAddress);
    const maxBorrowBefore = await ctx.B.lendingPoolAdmin.maxBorrow(ctx.destinationUserAddress);
    return writeTracePatch(
      config,
      ctx,
      {
        risk: {
          borrowed: units(debtAfterBorrow),
          maxBorrowBefore: units(maxBorrowBefore),
          healthBeforeShockBps: healthBeforeShock.toString(),
        },
      },
      {
        phase: "borrowed",
        label: "Borrowed bCASH against proven collateral",
        summary: `Borrowed position is ${units(debtAfterBorrow)} bCASH.`,
      }
    );
  }

  if (action === "simulatePriceShock") {
    setPhase("step-price-shock");
    await ensureRiskSeeded(config, ctx);
    const healthBeforeShock = await ctx.B.lendingPoolAdmin.healthFactorBps(ctx.destinationUserAddress);
    await txStep("step shock voucher oracle price", () =>
      ctx.B.oracle.setPrice(config.chains.B.voucherToken, SHOCKED_VOUCHER_PRICE_E18, txOptions())
    );
    const [healthAfterShock, liquidatableAfterShock, maxLiquidationRepay, liquidationPreview] = await Promise.all([
      ctx.B.lendingPoolAdmin.healthFactorBps(ctx.destinationUserAddress),
      ctx.B.lendingPoolAdmin.isLiquidatable(ctx.destinationUserAddress),
      ctx.B.lendingPoolAdmin.maxLiquidationRepay(ctx.destinationUserAddress),
      (async () => {
        const repay = await ctx.B.lendingPoolAdmin.maxLiquidationRepay(ctx.destinationUserAddress);
        return ctx.B.lendingPoolAdmin.previewLiquidation(ctx.destinationUserAddress, repay);
      })(),
    ]);
    const previewSeized = previewField(liquidationPreview, "seizedCollateral", 2);
    return writeTracePatch(
      config,
      ctx,
      {
        risk: {
          shockedVoucherPriceE18: SHOCKED_VOUCHER_PRICE_E18.toString(),
          healthBeforeShockBps: healthBeforeShock.toString(),
          healthAfterShockBps: healthAfterShock.toString(),
          liquidatableAfterShock,
          maxLiquidationRepay: units(maxLiquidationRepay),
          seizedCollateralPreview: units(previewSeized),
        },
      },
      {
        phase: "price-shocked",
        label: "Simulated governed oracle price shock",
        summary:
          `Voucher collateral price is now ${units(SHOCKED_VOUCHER_PRICE_E18)} bCASH; ` +
          `position is ${liquidatableAfterShock ? "liquidatable" : "not liquidatable"}.`,
      }
    );
  }

  if (action === "executeLiquidation") {
    setPhase("step-liquidation");
    const liquidatable = await ctx.B.lendingPoolAdmin.isLiquidatable(ctx.destinationUserAddress);
    if (!liquidatable) {
      throw new Error("Position is not liquidatable at the current oracle price. Run Simulate Oracle Shock first.");
    }

    const [debtBefore, collateralBefore, maxLiquidationRepay, reservesBefore, badDebtBefore] = await Promise.all([
      ctx.B.lendingPoolAdmin.debtBalance(ctx.destinationUserAddress),
      ctx.B.lendingPoolAdmin.collateralBalance(ctx.destinationUserAddress),
      ctx.B.lendingPoolAdmin.maxLiquidationRepay(ctx.destinationUserAddress),
      ctx.B.lendingPoolAdmin.totalReserves(),
      ctx.B.lendingPoolAdmin.totalBadDebt(),
    ]);
    const requestedRepayAmount = LIQUIDATION_REPAY_CONFIGURED ? LIQUIDATION_REPAY : maxLiquidationRepay;
    const liquidationPreview = await ctx.B.lendingPoolAdmin.previewLiquidation(ctx.destinationUserAddress, requestedRepayAmount);
    const repayAmount = previewField(liquidationPreview, "actualRepayAmount", 1);
    if (repayAmount === 0n) throw new Error("No debt is available for liquidation.");
    const previewSeized = previewField(liquidationPreview, "seizedCollateral", 2);
    const liquidatorBalance = await ctx.B.debtAdmin.balanceOf(ctx.liquidatorAddress);
    if (liquidatorBalance < repayAmount) {
      await txStep("step fund liquidator repay balance", () =>
        ctx.B.debtAdmin.mint(ctx.liquidatorAddress, repayAmount - liquidatorBalance, txOptions())
      );
    }
    await txStep("step approve liquidation repay", () =>
      ctx.B.debtLiquidator.approve(config.chains.B.lendingPool, repayAmount, txOptions())
    );
    const liquidationReceipt = await txStep("step liquidate unhealthy position", () =>
      ctx.B.lendingPoolLiquidator.liquidate(ctx.destinationUserAddress, requestedRepayAmount, txOptions())
    );
    const [debtAfter, collateralAfter, reservesAfter, badDebtAfter, liquidatorVoucherBalance] = await Promise.all([
      ctx.B.lendingPoolAdmin.debtBalance(ctx.destinationUserAddress),
      ctx.B.lendingPoolAdmin.collateralBalance(ctx.destinationUserAddress),
      ctx.B.lendingPoolAdmin.totalReserves(),
      ctx.B.lendingPoolAdmin.totalBadDebt(),
      ctx.B.voucherAdmin.balanceOf(ctx.liquidatorAddress),
    ]);
    const badDebtWrittenOff = debtBefore > repayAmount + debtAfter ? debtBefore - repayAmount - debtAfter : 0n;
    const reservesUsed = reservesBefore > reservesAfter ? reservesBefore - reservesAfter : 0n;
    const supplierLoss = badDebtAfter > badDebtBefore ? badDebtAfter - badDebtBefore : 0n;

    return writeTracePatch(
      config,
      ctx,
      {
        risk: {
          liquidationRepaid: units(repayAmount),
          liquidationRequestedRepay: units(requestedRepayAmount),
          liquidationTxHash: liquidationReceipt.hash,
          seizedCollateral: units(previewSeized),
          collateralBeforeLiquidation: units(collateralBefore),
          debtBeforeLiquidation: units(debtBefore),
          debtAfterLiquidation: units(debtAfter),
          collateralAfterLiquidation: units(collateralAfter),
          reservesAfterLiquidation: units(reservesAfter),
          badDebtAfterLiquidation: units(badDebtAfter),
          badDebtWrittenOff: units(badDebtWrittenOff),
          reservesUsed: units(reservesUsed),
          supplierLoss: units(supplierLoss),
          liquidatorVoucherBalance: units(liquidatorVoucherBalance),
        },
      },
      {
        phase: "liquidated",
        label: "Executed authorized liquidation",
        summary:
          `Liquidator repaid ${units(repayAmount)} bCASH and seized ${units(previewSeized)} vA; ` +
          `remaining debt is ${units(debtAfter)} bCASH.`,
      }
    );
  }

  if (action === "repay") {
    setPhase("step-repay");
    const debt = await ctx.B.lendingPoolAdmin.debtBalance(ctx.destinationUserAddress);
    let repayAmount = 0n;
    let repayTxHash = null;
    if (debt > 0n) {
      repayAmount = REPAY_AMOUNT ?? debt;
      if (repayAmount > debt) {
        throw new Error(`REPAY_LIMIT: outstanding debt is ${units(debt)} bCASH, requested ${units(repayAmount)}.`);
      }
      const debtBalance = await ctx.B.debtAdmin.balanceOf(ctx.destinationUserAddress);
      if (debtBalance < repayAmount) throw new Error("Destination user does not have enough bCASH to repay the requested amount.");
      const debtUser = ctx.B.debtAdmin.connect(ctx.destinationUser);
      await txStep("step approve debt repayment", () => debtUser.approve(config.chains.B.lendingPool, repayAmount, txOptions()));
      const repayReceipt = await txStep("step repay debt", () => ctx.B.lendingPoolUser.repay(repayAmount, txOptions()));
      repayTxHash = repayReceipt.hash;
    }
    const remainingDebt = await ctx.B.lendingPoolAdmin.debtBalance(ctx.destinationUserAddress);
    return writeTracePatch(
      config,
      ctx,
      {
        risk: {
          repaid: REPAY_AMOUNT != null || remainingDebt === 0n,
          debtBeforeRepay: units(debt),
          repayAmount: units(repayAmount),
          debtAfterRepay: units(remainingDebt),
          repayTxHash,
        },
      },
      {
        phase: "repaid",
        label: "Repaid bCASH debt",
        summary: `Repaid bCASH debt; remaining debt is ${units(remainingDebt)} bCASH.`,
      }
    );
  }

  if (action === "topUpRepayCash") {
    setPhase("step-top-up-repay-cash");
    const debt = await ctx.B.lendingPoolAdmin.debtBalance(ctx.destinationUserAddress);
    if (debt === 0n) {
      throw new Error("There is no active debt to fund for repayment.");
    }
    const debtBalance = await ctx.B.debtAdmin.balanceOf(ctx.destinationUserAddress);
    if (debtBalance < debt) {
      await txStep("step mint demo repayment cash", () =>
        ctx.B.debtAdmin.mint(ctx.destinationUserAddress, debt - debtBalance, txOptions())
      );
    }
    const updatedBalance = await ctx.B.debtAdmin.balanceOf(ctx.destinationUserAddress);
    return writeTracePatch(
      config,
      ctx,
      {
        risk: {
          demoRepayCashFunded: units(updatedBalance),
          demoRepayCashShortfall: units(updatedBalance >= debt ? 0n : debt - updatedBalance),
        },
      },
      {
        phase: "repay-cash-funded",
        label: "Added demo bCASH for repayment",
        summary: `Demo account now has ${units(updatedBalance)} bCASH available for repayment.`,
      }
    );
  }

  if (action === "withdrawCollateral") {
    setPhase("step-withdraw-collateral");
    const collateral = await ctx.B.lendingPoolAdmin.collateralBalance(ctx.destinationUserAddress);
    let withdrawAmount = 0n;
    let withdrawTxHash = null;
    if (collateral > 0n) {
      withdrawAmount = WITHDRAW_AMOUNT ?? collateral;
      if (withdrawAmount > collateral) {
        throw new Error(`WITHDRAW_LIMIT: deposited collateral is ${units(collateral)} vA, requested ${units(withdrawAmount)}.`);
      }
      const withdrawReceipt = await txStep("step withdraw collateral", () =>
        ctx.B.lendingPoolUser.withdrawCollateral(withdrawAmount, txOptions())
      );
      withdrawTxHash = withdrawReceipt.hash;
    }
    const remainingCollateral = await ctx.B.lendingPoolAdmin.collateralBalance(ctx.destinationUserAddress);
    return writeTracePatch(
      config,
      ctx,
      {
        risk: {
          collateralWithdrawn: WITHDRAW_AMOUNT != null || remainingCollateral === 0n,
          completed: remainingCollateral === 0n,
          collateralBeforeWithdrawal: units(collateral),
          withdrawAmount: units(withdrawAmount),
          collateralAfterWithdrawal: units(remainingCollateral),
          withdrawTxHash,
        },
      },
      {
        phase: "collateral-withdrawn",
        label: "Withdrew voucher collateral",
        summary: `Withdrew voucher collateral; ${units(remainingCollateral)} vA remains deposited.`,
      }
    );
  }

  if (action === "burn") {
    setPhase("step-burn");
    await requireOpenHandshake(config, ctx);
    const trace = await readExistingTrace();
    const burnAmount = amountFromTrace(trace.forward, FORWARD_AMOUNT);
    const freeVoucher = await ctx.B.voucherAdmin.balanceOf(ctx.destinationUserAddress);
    if (freeVoucher < burnAmount) {
      throw new Error("Bank B user needs a free voucher balance before burn. Repay and withdraw collateral first.");
    }
    const sequence = asBigInt(await ctx.B.packetStore.nextSequence());
    const receipt = await txStep("step burn voucher and release", () =>
      ctx.B.transferAppAdmin.connect(ctx.destinationUser).burnAndRelease(
        sourceChainId,
        ctx.sourceUserAddress,
        burnAmount,
        0,
        0,
        txOptions()
      )
    );
    const commitHeight = BigInt(receipt.blockNumber);
    const packet = reversePacket({
      sequence,
      sourceChainId: destinationChainId,
      destinationChainId: sourceChainId,
      config,
      sender: ctx.destinationUserAddress,
      recipient: ctx.sourceUserAddress,
      amount: burnAmount,
    });
    const packetIdValue = await ctx.B.packetStore.packetIdAt(sequence);
    return writeTracePatch(
      config,
      ctx,
      {
        reverse: {
          operation: "Bank B voucher burn -> Bank A escrow unlock",
          sequence: sequence.toString(),
          amount: units(burnAmount),
          amountRaw: burnAmount.toString(),
          packetId: packetIdValue,
          packetLeaf: packetLeaf(packet),
          packetPath: packetPath(packet),
          sourceTxHash: receipt.hash,
          commitHeight: commitHeight.toString(),
        },
      },
      {
        phase: "reverse-burned",
        label: "Burned voucher and committed reverse packet",
        summary: `Bank B burned ${units(burnAmount)} vA and wrote packet ${compact(packetIdValue)}.`,
      }
    );
  }

  if (action === "finalizeReverseHeader") {
    setPhase("step-finalizeReverseHeader");
    const reverse = await ensureReversePacket(config, ctx, sourceChainId, destinationChainId);
    const header = await readReverseHeader(ctx, destinationChainId, reverse.commitHeight);
    return writeTracePatch(
      config,
      ctx,
      {
        reverse: {
          finalizedHeight: header.headerUpdate.height.toString(),
          finalizedHeaderHash: header.headerUpdate.headerHash,
          finalizedStateRoot: header.headerUpdate.stateRoot,
        },
      },
      {
        phase: "reverse-header-read",
        label: "Read Bank B packet header",
        summary: `Read Bank B Besu header #${header.headerUpdate.height.toString()}; Bank A still needs a client update before proof execution.`,
      }
    );
  }

  if (action === "updateReverseClient") {
    setPhase("step-updateReverseClient");
    const reverse = await ensureReversePacket(config, ctx, sourceChainId, destinationChainId);
    const header = await trustReverseHeader(config, ctx, destinationChainId, reverse.commitHeight);
    return writeTracePatch(
      config,
      ctx,
      {
        reverse: {
          trustedHeight: header.headerUpdate.height.toString(),
          trustedHeaderHash: header.headerUpdate.headerHash,
          trustedStateRoot: header.headerUpdate.stateRoot,
        },
      },
      {
        phase: "reverse-header-trusted",
        label: "Updated Bank A Besu light client",
        summary: `Bank A now trusts Bank B Besu header #${header.headerUpdate.height.toString()}.`,
      }
    );
  }

  if (action === "proveReverseUnlock") {
    setPhase("step-prove-reverse");
    await requireOpenHandshake(config, ctx);
    const reverse = await ensureReversePacket(config, ctx, sourceChainId, destinationChainId);
    const proofAnchor = await requireTrustedProofAnchor({
      lightClient: ctx.A.lightClient,
      sourceChainId: destinationChainId,
      minimumHeight: reverse.commitHeight,
      sourceLabel: "Bank B",
      destinationLabel: "Bank A",
    });
    const proofs = await buildPacketProofs({
      provider: ctx.providerB,
      packetStoreAddress: config.chains.B.packetStore,
      packet: reverse.packet,
      sourceChainId: destinationChainId,
      trustedHeight: proofAnchor.height,
      stateRoot: proofAnchor.stateRoot,
    });
    let recvReceipt = null;
    try {
      recvReceipt = await txStep("step receive reverse packet", () =>
        ctx.A.packetHandler.recvPacketFromStorageProof(reverse.packet, proofs.leafProof, proofs.pathProof, txOptions())
      );
    } catch (error) {
      if (!isKnownReplay(error)) throw error;
    }
    const finalSourceBalance = await ctx.A.canonicalTokenAdmin.balanceOf(ctx.sourceUserAddress);
    const finalEscrowed = await ctx.A.escrow.totalEscrowed();
    return writeTracePatch(
      config,
      ctx,
      {
        reverse: {
          packetLeafSlot: proofs.leafSlot,
          packetPathSlot: proofs.pathSlot,
          receiveTxHash: recvReceipt?.hash,
          trustedHeight: proofAnchor.height.toString(),
          trustedHeaderHash: proofAnchor.headerHash,
          trustedStateRoot: proofAnchor.stateRoot,
          finalSourceBalance: units(finalSourceBalance),
          finalEscrowed: units(finalEscrowed),
          proofMode: "storage",
        },
      },
      {
        phase: "reverse-proven",
        label: "Executed reverse packet storage proof",
        summary: `Bank A verified packet ${compact(reverse.packetId)} and unlocked escrow.`,
      }
    );
  }

  if (action === "replayForward") {
    setPhase("step-replay-forward");
    const forward = await ensureForwardPacketReceived(config, ctx, sourceChainId, destinationChainId);
    const proofAnchor = await trustCurrentHeaderForProof({
      lightClient: ctx.B.lightClient,
      provider: ctx.providerA,
      sourceChainId,
      minimumHeight: forward.commitHeight,
    });
    const proofs = await buildPacketProofs({
      provider: ctx.providerA,
      packetStoreAddress: config.chains.A.packetStore,
      packet: forward.packet,
      sourceChainId,
      trustedHeight: proofAnchor.height,
      stateRoot: proofAnchor.header.headerUpdate.stateRoot,
    });
    try {
      await ctx.B.packetHandler.recvPacketFromStorageProof.staticCall(forward.packet, proofs.leafProof, proofs.pathProof);
      throw new Error("Replay was unexpectedly accepted by the IBC packet handler.");
    } catch (error) {
      if (!isKnownReplay(error)) throw error;
    }
    return writeTracePatch(
      config,
      ctx,
      {
        security: {
          replayBlocked: true,
          replayCheckedAt: new Date().toISOString(),
          replayProofHeight: proofAnchor.height.toString(),
        },
      },
      {
        phase: "replay-blocked",
        label: "Replay rejected by IBC packet receipt",
        summary: "The destination packet receipt prevented the same proof from executing twice.",
      }
    );
  }

  if (action === "verifyTimeoutAbsence") {
    return writeTracePatch(
      config,
      ctx,
      {
        security: {
          timeoutAbsenceImplemented: true,
          timeoutAbsence: {
            kind: "receipt-absence-proof",
            status: "Visualization only",
            note: "This UI action marks the timeout absence model; the full on-chain timeout execution is exercised by npm run demo.",
          },
        },
      },
      {
        phase: "receipt-absence-ready",
        label: "Receipt absence model noted",
        summary: "This UI-only marker explains the timeout absence proof path; run the full script to execute timeout on-chain.",
      }
    );
  }

  if (action === "freezeClient") {
    setPhase("step-freeze-client");
    const existingStatus = Number(await ctx.B.lightClient.status(sourceChainId));
    if (existingStatus === 2) {
      const evidence = await ctx.B.lightClient.frozenEvidence(sourceChainId);
      return writeTracePatch(
        config,
        ctx,
        {
          misbehaviour: {
            frozen: true,
            recovered: false,
            sourceChainId: sourceChainId.toString(),
            destinationChainId: destinationChainId.toString(),
            height: evidence.height.toString(),
            trustedHeaderHash: evidence.trustedHeaderHash,
            conflictingHeaderHash: evidence.conflictingHeaderHash,
            evidenceHash: evidence.evidenceHash,
            detectedAt: evidence.detectedAt.toString(),
          },
          security: {
            frozen: true,
          },
        },
        {
          phase: "client-frozen",
          label: "Submitted conflicting native Besu header",
          summary: `Bank B already has Bank A frozen at height ${evidence.height.toString()}.`,
        }
      );
    }

    let trustedHeight = BigInt(await ctx.B.lightClient.latestTrustedHeight(sourceChainId));
    if (trustedHeight === 0n) {
      trustedHeight = BigInt(await ctx.providerA.getBlockNumber());
      if (trustedHeight === 0n) {
        throw new Error("Bank A has not produced any non-genesis blocks yet, so there is no header to trust or freeze.");
      }
      await trustForwardHeader(config, ctx, sourceChainId, trustedHeight);
    }

    const trustedHeader = await ctx.B.lightClient.trustedHeader(sourceChainId, trustedHeight);
    if (!trustedHeader.exists) {
      throw new Error(`Bank B does not yet trust a Bank A header at height ${trustedHeight.toString()}.`);
    }

    const conflict = await buildConflictingBesuHeaderUpdate({
      provider: ctx.providerA,
      chainKey: "A",
      blockTag: ethers.toQuantity(trustedHeight),
      sourceChainId,
      validatorEpoch: 1n,
      conflictStateRoot: ethers.keccak256(
        ethers.toUtf8Bytes(`demo-conflict:${trustedHeight.toString()}:${Date.now().toString()}`)
      ),
    });

    if (conflict.headerUpdate.headerHash === trustedHeader.headerHash) {
      throw new Error("Conflicting header generation produced the trusted hash; conflict evidence is invalid.");
    }

    try {
      await ctx.B.lightClient.updateClient.staticCall(conflict.headerUpdate, conflict.validatorSet, txOptions());
    } catch (error) {
      const text = shortError(error);
      if (text.includes("HEIGHT_NOT_FORWARD")) {
        throw new Error(
          "The deployed Besu light client predates the native misbehaviour-freeze patch. Redeploy so conflicting trusted heights freeze instead of failing as stale headers."
        );
      }
      throw error;
    }

    await txStep("step submit conflicting header update", () =>
      ctx.B.lightClient.updateClient(conflict.headerUpdate, conflict.validatorSet, txOptions())
    );

    const [frozenStatus, evidence] = await Promise.all([
      ctx.B.lightClient.status(sourceChainId),
      ctx.B.lightClient.frozenEvidence(sourceChainId),
    ]);

    if (Number(frozenStatus) !== 2) {
      throw new Error("Conflicting native header was submitted, but the Bank B light client did not freeze.");
    }

    return writeTracePatch(
      config,
      ctx,
      {
        misbehaviour: {
          frozen: true,
          recovered: false,
          sourceChainId: sourceChainId.toString(),
          destinationChainId: destinationChainId.toString(),
          height: evidence.height.toString(),
          trustedHeaderHash: evidence.trustedHeaderHash,
          conflictingHeaderHash: evidence.conflictingHeaderHash,
          evidenceHash: evidence.evidenceHash,
          detectedAt: evidence.detectedAt.toString(),
        },
        security: {
          frozen: true,
        },
      },
      {
        phase: "client-frozen",
        label: "Submitted conflicting native Besu header",
        summary: `Bank B froze its Bank A client at height ${evidence.height.toString()} after conflicting finalized-header evidence.`,
      }
    );
  }

  if (action === "recoverClient") {
    setPhase("step-recover-client");
    const existingStatus = Number(await ctx.B.lightClient.status(sourceChainId));
    if (existingStatus === 1) {
      return writeTracePatch(
        config,
        ctx,
        {
          misbehaviour: {
            frozen: false,
            recovered: true,
          },
          security: {
            frozen: false,
          },
        },
        {
          phase: "client-recovered",
          label: "Recovered native Besu light client",
          summary: "Bank B client for Bank A is already active.",
        }
      );
    }

    const evidence = await ctx.B.lightClient.frozenEvidence(sourceChainId);
    if (existingStatus !== 2 && existingStatus !== 3) {
      throw new Error("Bank B client for Bank A is not frozen, so there is no recovery action to run.");
    }
    if (evidence.evidenceHash === ethers.ZeroHash) {
      throw new Error("The Bank B client is not carrying frozen evidence, so recovery cannot derive its recovery point.");
    }

    if (existingStatus === 2) {
      await txStep("step begin client recovery", () => ctx.B.lightClient.beginRecovery(sourceChainId, txOptions()));
    }

    let recoveryHeight = BigInt(await ctx.providerA.getBlockNumber());
    if (recoveryHeight <= evidence.height) {
      await txStep("step advance Bank A recovery head", () =>
        ctx.A.policy.setAccountAllowed(ctx.sourceUserAddress, true, txOptions())
      );
      recoveryHeight = BigInt(await ctx.providerA.getBlockNumber());
    }
    if (recoveryHeight <= evidence.height) {
      throw new Error(
        `Bank A did not advance past frozen height ${evidence.height.toString()}, so a new recovery trust anchor could not be created.`
      );
    }

    const recoveryHeader = await buildBesuHeaderUpdate({
      provider: ctx.providerA,
      blockTag: ethers.toQuantity(recoveryHeight),
      sourceChainId,
      validatorEpoch: 1n,
    });

    await txStep("step recover native Besu client", () =>
      ctx.B.lightClient.recoverClient(
        sourceChainId,
        trustedAnchorFromHeader(recoveryHeader),
        recoveryHeader.validatorSet,
        txOptions()
      )
    );

    const [recoveredStatus, latestTrustedHeight, clearedEvidence] = await Promise.all([
      ctx.B.lightClient.status(sourceChainId),
      ctx.B.lightClient.latestTrustedHeight(sourceChainId),
      ctx.B.lightClient.frozenEvidence(sourceChainId),
    ]);

    if (Number(recoveredStatus) !== 1) {
      throw new Error("Bank B light client did not return to Active after recovery.");
    }
    if (latestTrustedHeight !== recoveryHeader.headerUpdate.height) {
      throw new Error("Recovered trusted height does not match the recovery trust anchor.");
    }
    if (clearedEvidence.evidenceHash !== ethers.ZeroHash) {
      throw new Error("Frozen evidence was not cleared after recovery.");
    }

    return writeTracePatch(
      config,
      ctx,
      {
        misbehaviour: {
          frozen: false,
          recovered: true,
          recoveredAtHeight: recoveryHeader.headerUpdate.height.toString(),
          recoveredHeaderHash: recoveryHeader.headerUpdate.headerHash,
          recoveredStateRoot: recoveryHeader.headerUpdate.stateRoot,
          previousEvidenceHeight: evidence.height.toString(),
          previousEvidenceHash: evidence.evidenceHash,
        },
        security: {
          frozen: false,
        },
      },
      {
        phase: "client-recovered",
        label: "Recovered native Besu light client",
        summary: `Bank B re-anchored its Bank A client at height ${recoveryHeader.headerUpdate.height.toString()} and returned it to Active.`,
      }
    );
  }

  throw new Error(`Unknown demo action: ${action}`);
}

async function main() {
  const runtime = normalizeRuntime();
  if (!runtime.besuFirst) {
    throw new Error("run-lending-demo.mjs is a Besu-first entrypoint.");
  }

  setPhase("wait-runtime");
  await waitForBesuRuntimeReady();

  setPhase("load-config");
  const config = await loadRuntimeConfig();
  await ensureSeededConfig(config);
  await ensureDeploymentCode(config);
  const sourceChainId = chainId(config, "A");
  const destinationChainId = chainId(config, "B");

  setPhase("load-contracts");
  const ctx = await loadContext(config);

  setPhase("open-or-reuse-handshake");
  const { connectionHandshake, channelHandshake } = await openOrReuseHandshake(config, ctx);

  setPhase("prepare-forward-policy-and-allowance");
  await ensureRiskSeeded(config, ctx);
  await txStep("approve escrow spend", () =>
    ctx.A.canonicalTokenUser.approve(config.chains.A.escrowVault, FORWARD_AMOUNT + DENIED_AMOUNT, txOptions())
  );

  setPhase("send-forward-packet");
  const approvedSequence = asBigInt(await ctx.A.packetStore.nextSequence());
  const approvedSendReceipt = await txStep("send forward packet", () =>
    ctx.A.transferAppUser.sendTransfer(destinationChainId, ctx.destinationUserAddress, FORWARD_AMOUNT, 0, 0, txOptions())
  );
  const approvedCommitHeight = BigInt(approvedSendReceipt.blockNumber);
  const approvedPacket = transferPacket({
    sequence: approvedSequence,
    sourceChainId,
    destinationChainId,
    config,
    sender: ctx.sourceUserAddress,
    recipient: ctx.destinationUserAddress,
    amount: FORWARD_AMOUNT,
  });
  const approvedPacketId = await ctx.A.packetStore.packetIdAt(approvedSequence);

  setPhase("trust-source-header-and-receive");
  const approvedHeader = await trustRemoteHeaderAt({
    lightClient: ctx.B.lightClient,
    provider: ctx.providerA,
    sourceChainId,
    targetHeight: approvedCommitHeight,
    validatorEpoch: 1n,
  });
  const approvedProofHeight = approvedHeader.headerUpdate.height;
  const approvedProofs = await buildPacketProofs({
    provider: ctx.providerA,
    packetStoreAddress: config.chains.A.packetStore,
    packet: approvedPacket,
    sourceChainId,
    trustedHeight: approvedProofHeight,
    stateRoot: approvedHeader.headerUpdate.stateRoot,
  });
  const approvedRecvReceipt = await txStep("receive forward packet", () =>
    ctx.B.packetHandler.recvPacketFromStorageProof(
      approvedPacket,
      approvedProofs.leafProof,
      approvedProofs.pathProof,
      txOptions()
    )
  );
  const approvedAckHash = await ctx.B.packetHandler.acknowledgementHashes(approvedPacketId);
  const voucherBalanceAfterReceive = await ctx.B.voucherAdmin.balanceOf(ctx.destinationUserAddress);

  setPhase("acknowledge-forward-packet");
  const ackHeight = BigInt(approvedRecvReceipt.blockNumber);
  const ackHeader = await trustRemoteHeaderAt({
    lightClient: ctx.A.lightClient,
    provider: ctx.providerB,
    sourceChainId: destinationChainId,
    targetHeight: ackHeight,
    validatorEpoch: 1n,
  });
  const acknowledgementProofHeight = ackHeader.headerUpdate.height;
  const acknowledgement = ethers.solidityPacked(["string", "bytes32"], ["ok:", approvedPacketId]);
  const { acknowledgementSlot, proof: ackProof } = await buildAcknowledgementProof({
    provider: ctx.providerB,
    packetHandlerAddress: config.chains.B.packetHandler,
    packetIdValue: approvedPacketId,
    acknowledgementHash: approvedAckHash,
    sourceChainId: destinationChainId,
    trustedHeight: acknowledgementProofHeight,
    stateRoot: ackHeader.headerUpdate.stateRoot,
  });
  const ackReceipt = await txStep("acknowledge forward packet", () =>
    ctx.A.packetHandler.acknowledgePacketFromStorageProof(
      approvedPacket,
      acknowledgement,
      config.chains.B.packetHandler,
      ackProof,
      txOptions()
    )
  );
  const sourceAckHash = await ctx.A.transferAppUser.acknowledgementHashByPacket(approvedPacketId);

  setPhase("risk-deposit-and-borrow");
  await ensureRiskSeeded(config, ctx);
  const currentCollateral = await ctx.B.lendingPoolAdmin.collateralBalance(ctx.destinationUserAddress);
  const depositDelta = FORWARD_AMOUNT > currentCollateral ? FORWARD_AMOUNT - currentCollateral : 0n;
  if (depositDelta > 0n) {
    const voucherBalance = await ctx.B.voucherAdmin.balanceOf(ctx.destinationUserAddress);
    if (voucherBalance < depositDelta) {
      throw new Error(
        `Bank B user needs ${units(depositDelta)} free voucher collateral, but only has ${units(voucherBalance)}.`
      );
    }
    await txStep("approve voucher collateral", () =>
      ctx.B.voucherUser.approve(config.chains.B.lendingPool, depositDelta, txOptions())
    );
    await txStep("deposit voucher collateral", () => ctx.B.lendingPoolUser.depositCollateral(depositDelta, txOptions()));
  }
  const maxBorrowBefore = await ctx.B.lendingPoolAdmin.maxBorrow(ctx.destinationUserAddress);
  const availableBeforeBorrow = await ctx.B.lendingPoolAdmin.availableToBorrow(ctx.destinationUserAddress);
  const debtBeforeBorrow = await ctx.B.lendingPoolAdmin.debtBalance(ctx.destinationUserAddress);
  const borrowDelta = BORROW_AMOUNT > debtBeforeBorrow ? BORROW_AMOUNT - debtBeforeBorrow : 0n;
  if (borrowDelta > 0n) {
    if (availableBeforeBorrow < borrowDelta) {
      const collateral = await ctx.B.lendingPoolAdmin.collateralBalance(ctx.destinationUserAddress);
      throw new Error(
        `BORROW_LIMIT: available ${units(availableBeforeBorrow)} bCASH, need ${units(borrowDelta)}; ` +
          `maxBorrow=${units(maxBorrowBefore)}, collateral=${units(collateral)} vA, existingDebt=${units(debtBeforeBorrow)}.`
      );
    }
    await txStep("borrow debt asset", () => ctx.B.lendingPoolUser.borrow(borrowDelta, txOptions()));
  }
  const healthBeforeShock = await ctx.B.lendingPoolAdmin.healthFactorBps(ctx.destinationUserAddress);
  const debtAfterBorrow = await ctx.B.lendingPoolAdmin.debtBalance(ctx.destinationUserAddress);
  const collateralAfterDeposit = await ctx.B.lendingPoolAdmin.collateralBalance(ctx.destinationUserAddress);

  setPhase("risk-price-shock-and-liquidate");
  await txStep("shock voucher price", () =>
    ctx.B.oracle.setPrice(config.chains.B.voucherToken, SHOCKED_VOUCHER_PRICE_E18, txOptions())
  );
  const healthAfterShock = await ctx.B.lendingPoolAdmin.healthFactorBps(ctx.destinationUserAddress);
  const liquidatableAfterShock = await ctx.B.lendingPoolAdmin.isLiquidatable(ctx.destinationUserAddress);
  const maxLiquidationRepay = await ctx.B.lendingPoolAdmin.maxLiquidationRepay(ctx.destinationUserAddress);
  const liquidationPreview = await ctx.B.lendingPoolAdmin.previewLiquidation(
    ctx.destinationUserAddress,
    LIQUIDATION_REPAY
  );
  const actualLiquidationRepay = previewField(liquidationPreview, "actualRepayAmount", 1);
  const seizedCollateralPreview = previewField(liquidationPreview, "seizedCollateral", 2);
  const reservesBeforeLiquidation = await ctx.B.lendingPoolAdmin.totalReserves();
  const badDebtBeforeLiquidation = await ctx.B.lendingPoolAdmin.totalBadDebt();
  await txStep("approve liquidation repay", () =>
    ctx.B.debtLiquidator.approve(config.chains.B.lendingPool, actualLiquidationRepay, txOptions())
  );
  const liquidationReceipt = await txStep("liquidate unhealthy position", () =>
    ctx.B.lendingPoolLiquidator.liquidate(ctx.destinationUserAddress, LIQUIDATION_REPAY, txOptions())
  );
  const debtAfterLiquidation = await ctx.B.lendingPoolAdmin.debtBalance(ctx.destinationUserAddress);
  const collateralAfterLiquidation = await ctx.B.lendingPoolAdmin.collateralBalance(ctx.destinationUserAddress);
  const reservesAfterLiquidation = await ctx.B.lendingPoolAdmin.totalReserves();
  const badDebtAfterLiquidation = await ctx.B.lendingPoolAdmin.totalBadDebt();
  const liquidatorVoucherBalance = await ctx.B.voucherAdmin.balanceOf(ctx.liquidatorAddress);
  const badDebtWrittenOff =
    debtAfterBorrow > actualLiquidationRepay + debtAfterLiquidation ? debtAfterBorrow - actualLiquidationRepay - debtAfterLiquidation : 0n;
  const reservesUsed =
    reservesBeforeLiquidation > reservesAfterLiquidation ? reservesBeforeLiquidation - reservesAfterLiquidation : 0n;
  const supplierLoss =
    badDebtAfterLiquidation > badDebtBeforeLiquidation ? badDebtAfterLiquidation - badDebtBeforeLiquidation : 0n;

  setPhase("send-denied-packet");
  await txStep("block destination user", () =>
    ctx.B.policy.setAccountAllowed(ctx.destinationUserAddress, false, txOptions())
  );
  const deniedTimeoutHeight = BigInt(await ctx.providerB.getBlockNumber());
  const deniedSequence = asBigInt(await ctx.A.packetStore.nextSequence());
  const deniedSendReceipt = await txStep("send denied packet", () =>
    ctx.A.transferAppUser.sendTransfer(
      destinationChainId,
      ctx.destinationUserAddress,
      DENIED_AMOUNT,
      deniedTimeoutHeight,
      0,
      txOptions()
    )
  );
  const deniedCommitHeight = BigInt(deniedSendReceipt.blockNumber);
  const deniedPacket = transferPacket({
    sequence: deniedSequence,
    sourceChainId,
    destinationChainId,
    config,
    sender: ctx.sourceUserAddress,
    recipient: ctx.destinationUserAddress,
    amount: DENIED_AMOUNT,
    timeoutHeight: deniedTimeoutHeight,
  });
  const deniedPacketId = await ctx.A.packetStore.packetIdAt(deniedSequence);

  setPhase("prove-denied-packet");
  const deniedHeader = await trustRemoteHeaderAt({
    lightClient: ctx.B.lightClient,
    provider: ctx.providerA,
    sourceChainId,
    targetHeight: deniedCommitHeight,
    validatorEpoch: 1n,
  });
  const deniedProofHeight = deniedHeader.headerUpdate.height;
  const deniedProofs = await buildPacketProofs({
    provider: ctx.providerA,
    packetStoreAddress: config.chains.A.packetStore,
    packet: deniedPacket,
    sourceChainId,
    trustedHeight: deniedProofHeight,
    stateRoot: deniedHeader.headerUpdate.stateRoot,
  });

  setPhase("confirm-denied-receive");
  let deniedReason = "unknown";
  try {
    await ctx.B.packetHandler.recvPacketFromStorageProof.staticCall(
      deniedPacket,
      deniedProofs.leafProof,
      deniedProofs.pathProof
    );
    throw new Error("Denied packet unexpectedly succeeded.");
  } catch (error) {
    deniedReason = shortError(error);
  }

  setPhase("timeout-denied-packet");
  const timeoutHeader = await trustRemoteHeaderAt({
    lightClient: ctx.A.lightClient,
    provider: ctx.providerB,
    sourceChainId: destinationChainId,
    targetHeight: deniedTimeoutHeight,
    validatorEpoch: 1n,
  });
  const timeoutProofHeight = timeoutHeader.headerUpdate.height;
  const { receiptSlot, proof: deniedReceiptAbsenceProof } = await buildReceiptAbsenceProof({
    provider: ctx.providerB,
    packetHandlerAddress: config.chains.B.packetHandler,
    packetIdValue: deniedPacketId,
    sourceChainId: destinationChainId,
    trustedHeight: timeoutProofHeight,
    stateRoot: timeoutHeader.headerUpdate.stateRoot,
  });
  const timeoutReceipt = await txStep("timeout denied packet", () =>
    ctx.A.packetHandler.timeoutPacketFromStorageProof(
      deniedPacket,
      config.chains.B.packetHandler,
      deniedReceiptAbsenceProof,
      txOptions()
    )
  );
  await txStep("restore destination user", () =>
    ctx.B.policy.setAccountAllowed(ctx.destinationUserAddress, true, txOptions())
  );

  setPhase("read-final-state");
  const deniedTimedOut = await ctx.A.packetHandler.packetTimeouts(deniedPacketId);
  const deniedRefundFlag = await ctx.A.transferAppUser.timedOutPacket(deniedPacketId);
  const finalSourceBalance = await ctx.A.canonicalTokenAdmin.balanceOf(ctx.sourceUserAddress);
  const finalEscrowed = await ctx.A.escrow.totalEscrowed();
  const poolLiquidity = await ctx.B.debtAdmin.balanceOf(config.chains.B.lendingPool);
  const destinationDebtBalance = await ctx.B.debtAdmin.balanceOf(ctx.destinationUserAddress);

  const trace = {
    version: "interchain-lending",
    generatedAt: new Date().toISOString(),
    configPath: RUNTIME_CONFIG_PATH,
    runtime: config.runtime,
    architecture:
      "Besu light-client header imports, EVM storage-proof packet relay, and policy-controlled cross-chain lending.",
    chains: {
      A: {
        chainId: sourceChainId.toString(),
        lightClient: config.chains.A.lightClient,
        packetHandler: config.chains.A.packetHandler,
        packetStore: config.chains.A.packetStore,
        transferApp: config.chains.A.transferApp,
        canonicalToken: config.chains.A.canonicalToken,
        escrowVault: config.chains.A.escrowVault,
      },
      B: {
        chainId: destinationChainId.toString(),
        lightClient: config.chains.B.lightClient,
        packetHandler: config.chains.B.packetHandler,
        packetStore: config.chains.B.packetStore,
        transferApp: config.chains.B.transferApp,
        voucherToken: config.chains.B.voucherToken,
        debtToken: config.chains.B.debtToken,
        oracle: config.chains.B.oracle,
        lendingPool: config.chains.B.lendingPool,
      },
    },
    participants: {
      sourceUser: ctx.sourceUserAddress,
      destinationUser: ctx.destinationUserAddress,
      liquidator: ctx.liquidatorAddress,
    },
    handshake: {
      connection: connectionHandshake,
      channel: channelHandshake,
      sourceConnectionId: config.constants.sourceConnectionId,
      destinationConnectionId: config.constants.destinationConnectionId,
      sourceChannelId: config.constants.sourceChannelId,
      destinationChannelId: config.constants.destinationChannelId,
    },
    forward: {
      operation: "Bank A escrow lock -> Bank B voucher mint",
      sequence: approvedSequence.toString(),
      amount: units(FORWARD_AMOUNT),
      packetId: approvedPacketId,
      packetLeaf: packetLeaf(approvedPacket),
      packetPath: packetPath(approvedPacket),
      packetLeafSlot: approvedProofs.leafSlot,
      packetPathSlot: approvedProofs.pathSlot,
      sourceTxHash: approvedSendReceipt.hash,
      receiveTxHash: approvedRecvReceipt.hash,
      acknowledgementTxHash: ackReceipt.hash,
      commitHeight: approvedCommitHeight.toString(),
      receiveHeight: ackHeight.toString(),
      trustedHeight: approvedProofHeight.toString(),
      trustedHeaderHash: approvedHeader.headerUpdate.headerHash,
      trustedStateRoot: approvedHeader.headerUpdate.stateRoot,
      destinationAckHash: approvedAckHash,
      sourceAckHash,
      acknowledgementSlot,
      acknowledgementTrustedHeight: acknowledgementProofHeight.toString(),
      voucherBalanceAfterReceive: units(voucherBalanceAfterReceive),
    },
    risk: {
      operation: "Voucher collateral -> bCASH borrow -> oracle shock -> authorized liquidation",
      collateralDeposited: units(collateralAfterDeposit),
      maxBorrowBefore: units(maxBorrowBefore),
      borrowed: units(debtAfterBorrow),
      healthBeforeShockBps: healthBeforeShock.toString(),
      shockedVoucherPriceE18: SHOCKED_VOUCHER_PRICE_E18.toString(),
      healthAfterShockBps: healthAfterShock.toString(),
      liquidatableAfterShock,
      maxLiquidationRepay: units(maxLiquidationRepay),
      liquidationRepaid: units(actualLiquidationRepay),
      liquidationRequestedRepay: units(LIQUIDATION_REPAY),
      liquidationTxHash: liquidationReceipt.hash,
      seizedCollateral: units(seizedCollateralPreview),
      collateralBeforeLiquidation: units(collateralAfterDeposit),
      debtBeforeLiquidation: units(debtAfterBorrow),
      debtAfterLiquidation: units(debtAfterLiquidation),
      collateralAfterLiquidation: units(collateralAfterLiquidation),
      reservesAfterLiquidation: units(reservesAfterLiquidation),
      badDebtAfterLiquidation: units(badDebtAfterLiquidation),
      badDebtWrittenOff: units(badDebtWrittenOff),
      reservesUsed: units(reservesUsed),
      supplierLoss: units(supplierLoss),
      liquidatorVoucherBalance: units(liquidatorVoucherBalance),
      poolLiquidity: units(poolLiquidity),
      destinationDebtTokenBalance: units(destinationDebtBalance),
    },
    denied: {
      operation: "Policy denial on Bank B plus timeout refund on Bank A",
      sequence: deniedSequence.toString(),
      amount: units(DENIED_AMOUNT),
      packetId: deniedPacketId,
      packetLeaf: packetLeaf(deniedPacket),
      packetPath: packetPath(deniedPacket),
      packetLeafSlot: deniedProofs.leafSlot,
      packetPathSlot: deniedProofs.pathSlot,
      commitHeight: deniedCommitHeight.toString(),
      trustedHeight: deniedProofHeight.toString(),
      trustedHeaderHash: deniedHeader.headerUpdate.headerHash,
      trustedStateRoot: deniedHeader.headerUpdate.stateRoot,
      timeoutHeight: deniedTimeoutHeight.toString(),
      deniedReason,
      timedOut: deniedTimedOut,
      refundObserved: deniedRefundFlag,
      timeoutTxHash: timeoutReceipt.hash,
      finalSourceBalance: units(finalSourceBalance),
      finalEscrowed: units(finalEscrowed),
    },
    timeout: {
      trustedHeight: timeoutProofHeight.toString(),
      trustedHeaderHash: timeoutHeader.headerUpdate.headerHash,
      trustedStateRoot: timeoutHeader.headerUpdate.stateRoot,
      receiptStorageKey: receiptSlot,
    },
    latestOperation: {
      phase: "complete",
      label: "Completed storage-proof cross-chain lending flow",
      summary:
        "Opened/reused the IBC connection and channel, verified the packet with Besu storage proofs, ran lending valuation and liquidation, then verified timeout absence for a denied packet.",
    },
  };

  setPhase("write-trace");
  await writeTrace(trace);

  config.status = {
    ...(config.status || {}),
    proofCheckedHandshakeOpened: true,
    lastDemoRunAt: trace.generatedAt,
  };
  config.latestTrace = {
    json: OUT_JSON_PATH,
    js: OUT_JS_PATH,
  };
  await saveRuntimeConfig(config);

  console.log("=== Proof-checked banking flow ===");
  console.log(`Handshake: connection ${connectionHandshake.reused ? "reused" : "opened"}, channel ${channelHandshake.reused ? "reused" : "opened"}`);
  console.log(`[A->B] packet ${compact(approvedPacketId)} locked ${units(FORWARD_AMOUNT)} aBANK and minted voucher on Bank B`);
  console.log(`[risk] deposited ${units(collateralAfterDeposit)} vA, borrowed ${units(debtAfterBorrow)} bCASH, liquidated ${units(actualLiquidationRepay)} bCASH after price shock`);
  console.log(`[timeout] denied packet ${compact(deniedPacketId)} refunded=${deniedRefundFlag}`);
  console.log(`[ui] wrote demo trace to ${OUT_JSON_PATH}`);
}

const stepArgIndex = process.argv.indexOf("--step");
const stepArg = stepArgIndex >= 0 ? process.argv[stepArgIndex + 1] : null;
const entrypoint = stepArg ? () => runDemoStep(stepArg) : main;

entrypoint()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    error.phase = typeof error?.phase === "string" && error.phase.length > 0 ? error.phase : CURRENT_PHASE;
    console.error(`run-lending-demo failed during phase: ${error.phase}`);
    console.error(error);
    process.exit(1);
  });
