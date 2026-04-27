import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ethers } from "ethers";
import {
  openProofCheckedChannel,
  openProofCheckedConnection,
  trustRemoteHeaderAt,
} from "../ibc-handshake.mjs";
import { buildBesuHeaderUpdate, buildConflictingBesuHeaderUpdate } from "../besu-header-update.mjs";
import {
  defaultBesuRuntimeEnv,
  loadArtifact,
  normalizeRuntime,
  waitForBesuRuntimeReady,
} from "../besu-runtime.mjs";
import {
  loadRuntimeConfig,
  providerForChain,
  saveRuntimeConfig,
  signerForChain,
  RUNTIME_CONFIG_PATH,
} from "../interchain-config.mjs";

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
const DEMO_REPAY_BUFFER_BPS = BigInt(process.env.DEMO_REPAY_BUFFER_BPS || "1");
const DEMO_REPAY_MIN_BUFFER = ethers.parseUnits(process.env.DEMO_REPAY_MIN_BUFFER || "0.01", 18);
const DEMO_MAX_TIMEOUT_HEADER_GAP = BigInt(process.env.DEMO_MAX_TIMEOUT_HEADER_GAP || "300");

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

function repayCloseBuffer(amount) {
  if (amount <= 0n) return 0n;
  const proportional = amount * DEMO_REPAY_BUFFER_BPS / 10_000n;
  return proportional > DEMO_REPAY_MIN_BUFFER ? proportional : DEMO_REPAY_MIN_BUFFER;
}

function repayCloseTarget(amount) {
  return amount + repayCloseBuffer(amount);
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
  const sourceLiquidator = await signerForChain(config, "A", Number(config.participants?.liquidatorIndex ?? 2));

  return {
    artifacts,
    providerA,
    providerB,
    adminA,
    adminB,
    sourceUser,
    sourceLiquidator,
    destinationUser,
    liquidator,
    sourceUserAddress: await sourceUser.getAddress(),
    sourceLiquidatorAddress: config.participants?.sourceLiquidator || await sourceLiquidator.getAddress(),
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
      transferAppLiquidator: contract(config.chains.B.transferApp, artifacts.transferApp, liquidator),
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
      missingCode.push(`${chainKey}.${field}=${address ?? "missing"}`);
      continue;
    }
    let code;
    try {
      code = await providerByChain[chainKey].getCode(ethers.getAddress(address), "latest");
    } catch (error) {
      missingCode.push(`${chainKey}.${field}=${address} (${error.shortMessage || error.message})`);
      continue;
    }
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
  const destinationChainId = chainId(config, "B");
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
    "allow origin liquidator recipient on Bank A",
    () => ctx.A.policy.accountAllowed(ctx.sourceLiquidatorAddress),
    () => ctx.A.policy.setAccountAllowed(ctx.sourceLiquidatorAddress, true, txOptions())
  );
  await txIfNeeded(
    "allow Bank B source chain on Bank A",
    () => ctx.A.policy.sourceChainAllowed(destinationChainId),
    () => ctx.A.policy.setSourceChainAllowed(destinationChainId, true, txOptions())
  );
  await txIfNeeded(
    "allow canonical unlock asset on Bank A",
    () => ctx.A.policy.unlockAssetAllowed(config.chains.A.canonicalToken),
    () => ctx.A.policy.setUnlockAssetAllowed(config.chains.A.canonicalToken, true, txOptions())
  );

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
  await txIfNeeded(
    "grant seized-voucher settlement role",
    async () => ctx.B.transferAppAdmin.hasRole(await ctx.B.transferAppAdmin.SETTLEMENT_OPERATOR_ROLE(), ctx.liquidatorAddress),
    async () =>
      ctx.B.transferAppAdmin.grantRole(await ctx.B.transferAppAdmin.SETTLEMENT_OPERATOR_ROLE(), ctx.liquidatorAddress, txOptions())
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
      sourceLiquidator: ctx.sourceLiquidatorAddress,
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
    const sender = trace.reverse.sender || ctx.destinationUserAddress;
    const recipient = trace.reverse.recipient || ctx.sourceUserAddress;
    return {
      trace,
      sequence: BigInt(trace.reverse.sequence),
      commitHeight: BigInt(trace.reverse.commitHeight),
      amount,
      packetId: trace.reverse.packetId,
      sender,
      recipient,
      packet: reversePacket({
        sequence: BigInt(trace.reverse.sequence),
        sourceChainId: destinationChainId,
        destinationChainId: sourceChainId,
        config,
        sender,
        recipient,
        amount,
      }),
    };
  }

  throw new Error("No reverse packet exists yet. Burn a voucher or settle seized voucher first.");
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

function getCurrentPhase() {
  return CURRENT_PHASE;
}

export {
  ACKNOWLEDGEMENT_HASHES_SLOT,
  BORROW_AMOUNT,
  BORROW_AMOUNT_CONFIGURED,
  CHANNEL_STATE,
  CONNECTION_STATE,
  DEMO_MAX_TIMEOUT_HEADER_GAP,
  DENIED_AMOUNT,
  FORWARD_AMOUNT,
  LIQUIDATION_REPAY,
  LIQUIDATION_REPAY_CONFIGURED,
  OUT_JS_PATH,
  OUT_JSON_PATH,
  PACKET_COMMITMENT_PATH_TYPEHASH,
  PACKET_LEAF_TYPEHASH,
  PACKET_RECEIPTS_SLOT,
  PACKET_TYPEHASH,
  REPAY_AMOUNT,
  RUNTIME_CONFIG_PATH,
  SHOCKED_VOUCHER_PRICE_E18,
  WITHDRAW_AMOUNT,
  amountFromTrace,
  asBigInt,
  baseTrace,
  buildAcknowledgementProof,
  buildBesuHeaderUpdate,
  buildChannelCommitmentProof,
  buildConflictingBesuHeaderUpdate,
  buildConnectionCommitmentProof,
  buildPacketProofs,
  buildReceiptAbsenceProof,
  buildWordStorageProof,
  bytes32MappingSlot,
  chainClientId,
  chainId,
  compact,
  contract,
  currentChannelProof,
  currentConnectionProof,
  currentRouteStatus,
  encodeTransferData,
  ensureDeploymentCode,
  ensureForwardPacket,
  ensureForwardPacketReceived,
  ensureReversePacket,
  ensureRiskSeeded,
  ensureSeededConfig,
  getCurrentPhase,
  handshakeTrace,
  isKnownReplay,
  loadContext,
  loadRuntimeConfig,
  mappingSlot,
  normalizeRuntime,
  openOrReuseHandshake,
  packetId,
  packetLeaf,
  packetPath,
  prepareStepContext,
  previewField,
  readExistingTrace,
  readForwardHeader,
  readReverseHeader,
  repayCloseBuffer,
  repayCloseTarget,
  requireDemoSafetyModeAllows,
  requireOpenHandshake,
  requireTrustedProofAnchor,
  reversePacket,
  rlpWord,
  saveRuntimeConfig,
  setPhase,
  shortError,
  stateName,
  transferPacket,
  trustCurrentHeaderForProof,
  trustForwardHeader,
  trustRemoteHeaderAt,
  trustReverseHeader,
  trustedAnchorFromHeader,
  txIfNeeded,
  txOptions,
  txStep,
  units,
  waitForBesuRuntimeReady,
  waitForTx,
  writeTrace,
  writeTracePatch,
};
