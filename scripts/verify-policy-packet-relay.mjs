import { resolve } from "node:path";
import { ethers } from "ethers";
import {
  openProofCheckedChannel,
  openProofCheckedConnection,
  trustRemoteHeaderAt,
} from "./ibc-handshake.mjs";
import {
  CHAIN_A_RPC,
  CHAIN_B_RPC,
  deploy,
  loadArtifact,
  signerForRpc,
  waitForBesuRuntimeReady,
} from "./besu-runtime.mjs";
import { writeVerificationFailureReport, writeVerificationReport } from "./verification-report.mjs";

const SOURCE_CHAIN_ID = BigInt(process.env.SOURCE_CHAIN_ID || "41001");
const DESTINATION_CHAIN_ID = BigInt(process.env.DESTINATION_CHAIN_ID || "41002");
const SOURCE_CHAIN_KEY = process.env.SOURCE_CHAIN_KEY || "A";
const DESTINATION_CHAIN_KEY = process.env.DESTINATION_CHAIN_KEY || "B";
const OUT_FILE = resolve(process.cwd(), process.env.OUT_FILE || "proofs/besu/policy-packet-relay-verification.json");

const PACKET_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes("IBC.Packet"));
const PACKET_LEAF_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes("IBC.PacketLeaf"));
const PACKET_COMMITMENT_PATH_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes("IBC.PacketCommitmentPath"));
const ACKNOWLEDGEMENT_HASHES_SLOT = 3n;
const PACKET_RECEIPTS_SLOT = 2n;
const ORDER_UNORDERED = 1;
const SOURCE_CONNECTION_ID = ethers.encodeBytes32String("connection-a");
const DESTINATION_CONNECTION_ID = ethers.encodeBytes32String("connection-b");
const SOURCE_CHANNEL_ID = ethers.encodeBytes32String("channel-a");
const DESTINATION_CHANNEL_ID = ethers.encodeBytes32String("channel-b");
const CHANNEL_VERSION = ethers.hexlify(ethers.toUtf8Bytes("ics-004"));
const CONNECTION_PREFIX = ethers.hexlify(ethers.toUtf8Bytes("ibc"));
const VIEW_RETRY_ATTEMPTS = Math.max(1, Number(process.env.BESU_VIEW_RETRY_ATTEMPTS || "6"));
const VIEW_RETRY_DELAY_MS = Math.max(0, Number(process.env.BESU_VIEW_RETRY_DELAY_MS || "750"));
let CURRENT_PHASE = "bootstrap";

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

async function buildPacketProofs(provider, packetStoreAddress, packet, trustedHeight, stateRoot) {
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
    leafProof: {
      sourceChainId: SOURCE_CHAIN_ID,
      trustedHeight,
      stateRoot,
      account: packetStoreAddress,
      storageKey: leafSlot,
      expectedValue: rlpWord(packetLeaf(packet)),
      accountProof: proof.accountProof,
      storageProof: leafEntry.proof,
    },
    pathProof: {
      sourceChainId: SOURCE_CHAIN_ID,
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

async function buildAcknowledgementProof(provider, packetHandlerAddress, packetIdValue, acknowledgementHash, trustedHeight, stateRoot) {
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
    sourceChainId: DESTINATION_CHAIN_ID,
    trustedHeight,
    stateRoot,
    account: packetHandlerAddress,
    storageKey: acknowledgementSlot,
    expectedValue: rlpWord(acknowledgementHash),
    accountProof: proof.accountProof,
    storageProof: acknowledgementEntry.proof,
  };
}

async function buildReceiptAbsenceProof(provider, packetHandlerAddress, packetIdValue, trustedHeight, stateRoot) {
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
    sourceChainId: DESTINATION_CHAIN_ID,
    trustedHeight,
    stateRoot,
    account: packetHandlerAddress,
    storageKey: receiptSlot,
    expectedValue: "0x",
    accountProof: proof.accountProof,
    storageProof: receiptEntry.proof,
  };
}

function shortError(error) {
  return (
    error?.shortMessage ||
    error?.info?.error?.message ||
    error?.reason ||
    error?.message ||
    String(error)
  );
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function isRetryableBesuViewError(error) {
  const text = [
    error?.code,
    error?.shortMessage,
    error?.message,
    error?.info?.error?.message,
    error?.error?.message,
  ]
    .filter(Boolean)
    .join(" ");
  return /CALL_EXCEPTION|UNKNOWN_ERROR|missing revert data|Internal error|World state unavailable|could not coalesce/i.test(
    text
  );
}

async function readView(label, read) {
  let lastError;
  for (let attempt = 1; attempt <= VIEW_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      if (attempt >= VIEW_RETRY_ATTEMPTS || !isRetryableBesuViewError(error)) break;
      console.warn(
        `[policy-packet] read ${label} failed (${shortError(error)}); retrying ${attempt}/${VIEW_RETRY_ATTEMPTS - 1}`
      );
      await sleep(VIEW_RETRY_DELAY_MS);
    }
  }

  const wrapped = new Error(`[policy-packet] read ${label} failed: ${shortError(lastError)}`);
  wrapped.shortMessage = wrapped.message;
  wrapped.cause = lastError;
  wrapped.info = lastError?.info;
  throw wrapped;
}

function logPhase(message) {
  console.log(`[policy-packet] ${message}`);
}

async function main() {
  CURRENT_PHASE = "wait-runtime";
  await waitForBesuRuntimeReady();

  CURRENT_PHASE = "connect-rpcs";
  logPhase("connecting signers and RPC providers");
  const sourceProvider = new ethers.JsonRpcProvider(CHAIN_A_RPC);
  const destinationProvider = new ethers.JsonRpcProvider(CHAIN_B_RPC);
  const sourceSigner = await signerForRpc(CHAIN_A_RPC, SOURCE_CHAIN_KEY, 0);
  const destinationSigner = await signerForRpc(CHAIN_B_RPC, DESTINATION_CHAIN_KEY, 0);
  const destinationLiquidatorSigner = await signerForRpc(CHAIN_B_RPC, DESTINATION_CHAIN_KEY, 1);
  const sourceSender = await sourceSigner.getAddress();
  const destinationUser = await destinationSigner.getAddress();
  const destinationLiquidator = await destinationLiquidatorSigner.getAddress();

  CURRENT_PHASE = "load-artifacts";
  const lightClientArtifact = await loadArtifact("clients/BesuLightClient.sol", "BesuLightClient");
  const connectionKeeperArtifact = await loadArtifact("core/IBCConnectionKeeper.sol", "IBCConnectionKeeper");
  const channelKeeperArtifact = await loadArtifact("core/IBCChannelKeeper.sol", "IBCChannelKeeper");
  const packetStoreArtifact = await loadArtifact("core/IBCPacketStore.sol", "IBCPacketStore");
  const packetHandlerArtifact = await loadArtifact("core/IBCPacketHandler.sol", "IBCPacketHandler");
  const bankTokenArtifact = await loadArtifact("apps/BankToken.sol", "BankToken");
  const policyArtifact = await loadArtifact("apps/BankPolicyEngine.sol", "BankPolicyEngine");
  const oracleArtifact = await loadArtifact("apps/ManualAssetOracle.sol", "ManualAssetOracle");
  const voucherArtifact = await loadArtifact("apps/PolicyControlledVoucherToken.sol", "PolicyControlledVoucherToken");
  const escrowArtifact = await loadArtifact("apps/PolicyControlledEscrowVault.sol", "PolicyControlledEscrowVault");
  const lendingArtifact = await loadArtifact("apps/PolicyControlledLendingPool.sol", "PolicyControlledLendingPool");
  const appArtifact = await loadArtifact("apps/PolicyControlledTransferApp.sol", "PolicyControlledTransferApp");

  CURRENT_PHASE = "deploy";
  logPhase("deploying policy packet stack");
  const sourceLightClient = await deploy(lightClientArtifact, sourceSigner, [sourceSender]);
  const sourceLightClientAddress = await sourceLightClient.getAddress();
  const destinationLightClient = await deploy(lightClientArtifact, destinationSigner, [destinationUser]);
  const destinationLightClientAddress = await destinationLightClient.getAddress();

  const sourceConnectionKeeper = await deploy(connectionKeeperArtifact, sourceSigner, [
    SOURCE_CHAIN_ID,
    sourceLightClientAddress,
    sourceSender,
  ]);
  const sourceConnectionKeeperAddress = await sourceConnectionKeeper.getAddress();
  const destinationConnectionKeeper = await deploy(connectionKeeperArtifact, destinationSigner, [
    DESTINATION_CHAIN_ID,
    destinationLightClientAddress,
    destinationUser,
  ]);
  const destinationConnectionKeeperAddress = await destinationConnectionKeeper.getAddress();

  const sourceChannelKeeper = await deploy(channelKeeperArtifact, sourceSigner, [
    SOURCE_CHAIN_ID,
    sourceConnectionKeeperAddress,
    sourceSender,
  ]);
  const sourceChannelKeeperAddress = await sourceChannelKeeper.getAddress();
  const destinationChannelKeeper = await deploy(channelKeeperArtifact, destinationSigner, [
    DESTINATION_CHAIN_ID,
    destinationConnectionKeeperAddress,
    destinationUser,
  ]);
  const destinationChannelKeeperAddress = await destinationChannelKeeper.getAddress();

  const sourcePacketHandler = await deploy(packetHandlerArtifact, sourceSigner, [
    SOURCE_CHAIN_ID,
    sourceLightClientAddress,
    sourceChannelKeeperAddress,
    sourceSender,
  ]);
  const sourcePacketHandlerAddress = await sourcePacketHandler.getAddress();
  const destinationPacketHandler = await deploy(packetHandlerArtifact, destinationSigner, [
    DESTINATION_CHAIN_ID,
    destinationLightClientAddress,
    destinationChannelKeeperAddress,
    destinationUser,
  ]);
  const destinationPacketHandlerAddress = await destinationPacketHandler.getAddress();

  const canonicalAsset = await deploy(bankTokenArtifact, sourceSigner, ["Canonical A", "aCAN"]);
  const canonicalAssetAddress = await canonicalAsset.getAddress();
  const policyA = await deploy(policyArtifact, sourceSigner, [sourceSender]);
  const policyAAddress = await policyA.getAddress();
  const policyB = await deploy(policyArtifact, destinationSigner, [destinationUser]);
  const policyBAddress = await policyB.getAddress();

  const escrowA = await deploy(escrowArtifact, sourceSigner, [sourceSender, canonicalAssetAddress, policyAAddress]);
  const escrowAAddress = await escrowA.getAddress();
  const voucherB = await deploy(voucherArtifact, destinationSigner, [destinationUser, policyBAddress, "Voucher A", "vA"]);
  const voucherBAddress = await voucherB.getAddress();
  const debtAssetB = await deploy(bankTokenArtifact, destinationSigner, ["Bank B Cash", "bCASH"]);
  const debtAssetBAddress = await debtAssetB.getAddress();
  const oracleB = await deploy(oracleArtifact, destinationSigner, [destinationUser]);
  const oracleBAddress = await oracleB.getAddress();
  const lendingPoolB = await deploy(lendingArtifact, destinationSigner, [
    destinationUser,
    voucherBAddress,
    debtAssetBAddress,
    policyBAddress,
    8_000,
  ]);
  const lendingPoolBAddress = await lendingPoolB.getAddress();

  const packetStoreA = await deploy(packetStoreArtifact, sourceSigner, [SOURCE_CHAIN_ID]);
  const packetStoreAAddress = await packetStoreA.getAddress();
  const packetStoreB = await deploy(packetStoreArtifact, destinationSigner, [DESTINATION_CHAIN_ID]);
  const packetStoreBAddress = await packetStoreB.getAddress();

  const appA = await deploy(appArtifact, sourceSigner, [
    SOURCE_CHAIN_ID,
    packetStoreAAddress,
    sourcePacketHandlerAddress,
    escrowAAddress,
    ethers.ZeroAddress,
    sourceSender,
  ]);
  const appAAddress = await appA.getAddress();
  const appB = await deploy(appArtifact, destinationSigner, [
    DESTINATION_CHAIN_ID,
    packetStoreBAddress,
    destinationPacketHandlerAddress,
    ethers.ZeroAddress,
    voucherBAddress,
    destinationUser,
  ]);
  const appBAddress = await appB.getAddress();

  CURRENT_PHASE = "configure-roles-and-routes";
  logPhase("configuring roles, policy allowlists, oracle prices, and packet routes");
  await (await escrowA.grantApp(appAAddress)).wait();
  await (await voucherB.grantApp(appBAddress)).wait();
  await (await voucherB.bindCanonicalAsset(canonicalAssetAddress)).wait();
  await (await packetStoreA.setPacketWriter(appAAddress, true)).wait();
  await (await packetStoreB.setPacketWriter(appBAddress, true)).wait();
  await (await policyA.grantRole(await policyA.POLICY_APP_ROLE(), escrowAAddress)).wait();
  await (await policyB.grantRole(await policyB.POLICY_APP_ROLE(), voucherBAddress)).wait();
  await (await policyB.grantRole(await policyB.POLICY_APP_ROLE(), lendingPoolBAddress)).wait();
  await (await lendingPoolB.grantRole(await lendingPoolB.LIQUIDATOR_ROLE(), destinationLiquidator)).wait();

  await (await appA.configureRemoteRoute(DESTINATION_CHAIN_ID, appBAddress, SOURCE_CHANNEL_ID, DESTINATION_CHANNEL_ID, canonicalAssetAddress)).wait();
  await (await appB.configureRemoteRoute(SOURCE_CHAIN_ID, appAAddress, DESTINATION_CHANNEL_ID, SOURCE_CHANNEL_ID, canonicalAssetAddress)).wait();

  await (await policyA.setAccountAllowed(sourceSender, true)).wait();
  await (await policyA.setSourceChainAllowed(DESTINATION_CHAIN_ID, true)).wait();
  await (await policyA.setUnlockAssetAllowed(canonicalAssetAddress, true)).wait();
  await (await policyB.setAccountAllowed(destinationUser, true)).wait();
  await (await policyB.setSourceChainAllowed(SOURCE_CHAIN_ID, true)).wait();
  await (await policyB.setMintAssetAllowed(canonicalAssetAddress, true)).wait();
  await (await policyB.setCollateralAssetAllowed(voucherBAddress, true)).wait();
  await (await policyB.setDebtAssetAllowed(debtAssetBAddress, true)).wait();
  await (await policyB.setAccountBorrowCap(destinationUser, 200n)).wait();
  await (await policyB.setDebtAssetBorrowCap(debtAssetBAddress, 500n)).wait();

  await (await oracleB.setMaxStaleness(604800n)).wait();
  await (await oracleB.setPrice(voucherBAddress, ethers.parseUnits("2", 18))).wait();
  await (await oracleB.setPrice(debtAssetBAddress, ethers.parseUnits("1", 18))).wait();
  await (await lendingPoolB.setValuationOracle(oracleBAddress)).wait();
  await (await lendingPoolB.setCollateralHaircut(9_000)).wait();

  await (await sourcePacketHandler.setPortApplication(appAAddress, appAAddress)).wait();
  await (await destinationPacketHandler.setPortApplication(appBAddress, appBAddress)).wait();
  await (await sourcePacketHandler.setTrustedPacketStore(SOURCE_CHAIN_ID, packetStoreAAddress)).wait();
  await (await destinationPacketHandler.setTrustedPacketStore(SOURCE_CHAIN_ID, packetStoreAAddress)).wait();

  CURRENT_PHASE = "connection-handshake";
  logPhase("opening proof-checked connection");
  const connectionHandshake = await openProofCheckedConnection({
    sourceProvider,
    destinationProvider,
    sourceLightClient,
    destinationLightClient,
    sourceConnectionKeeper,
    destinationConnectionKeeper,
    sourceConnectionKeeperAddress,
    destinationConnectionKeeperAddress,
    sourceChainId: SOURCE_CHAIN_ID,
    destinationChainId: DESTINATION_CHAIN_ID,
    sourceConnectionId: SOURCE_CONNECTION_ID,
    destinationConnectionId: DESTINATION_CONNECTION_ID,
    prefix: CONNECTION_PREFIX,
  });
  CURRENT_PHASE = "channel-handshake";
  logPhase("opening proof-checked channel");
  const channelHandshake = await openProofCheckedChannel({
    sourceProvider,
    destinationProvider,
    sourceLightClient,
    destinationLightClient,
    sourceChannelKeeper,
    destinationChannelKeeper,
    sourceChannelKeeperAddress,
    destinationChannelKeeperAddress,
    sourceChainId: SOURCE_CHAIN_ID,
    destinationChainId: DESTINATION_CHAIN_ID,
    sourceConnectionId: SOURCE_CONNECTION_ID,
    destinationConnectionId: DESTINATION_CONNECTION_ID,
    sourceChannelId: SOURCE_CHANNEL_ID,
    destinationChannelId: DESTINATION_CHANNEL_ID,
    sourcePort: appAAddress,
    destinationPort: appBAddress,
    ordering: ORDER_UNORDERED,
    version: CHANNEL_VERSION,
  });

  CURRENT_PHASE = "seed-canonical-balance";
  logPhase("minting source balance");
  await (await canonicalAsset.mint(sourceSender, 200n)).wait();
  await (await canonicalAsset.approve(escrowAAddress, 200n)).wait();

  CURRENT_PHASE = "approved-send";
  logPhase("sending approved cross-chain packet");
  const approvedSendReceipt = await (
    await appA.sendTransfer(DESTINATION_CHAIN_ID, destinationUser, 100n, 0, 0)
  ).wait();
  const approvedCommitHeight = BigInt(approvedSendReceipt.blockNumber);
  const approvedPacketId = await packetStoreA.packetIdAt(1n);
  const approvedPacket = {
    sequence: 1n,
    source: { chainId: SOURCE_CHAIN_ID, port: appAAddress, channel: SOURCE_CHANNEL_ID },
    destination: { chainId: DESTINATION_CHAIN_ID, port: appBAddress, channel: DESTINATION_CHANNEL_ID },
    data: encodeTransferData({
      sender: sourceSender,
      recipient: destinationUser,
      asset: canonicalAssetAddress,
      amount: 100n,
      action: 1,
      memo: ethers.ZeroHash,
    }),
    timeout: { height: 0n, timestamp: 0n },
  };

  CURRENT_PHASE = "approved-trust-and-proof";
  logPhase("building source packet proof");
  const approvedHeader = await trustRemoteHeaderAt({
    lightClient: destinationLightClient,
    provider: sourceProvider,
    sourceChainId: SOURCE_CHAIN_ID,
    targetHeight: approvedCommitHeight,
    validatorEpoch: 1n,
  });
  const approvedProofs = await buildPacketProofs(
    sourceProvider,
    packetStoreAAddress,
    approvedPacket,
    approvedHeader.headerUpdate.height,
    approvedHeader.headerUpdate.stateRoot
  );
  CURRENT_PHASE = "approved-receive";
  logPhase("receiving approved packet on Bank B");
  const approvedRecvReceipt = await (
    await destinationPacketHandler.recvPacketFromStorageProof(
      approvedPacket,
      approvedProofs.leafProof,
      approvedProofs.pathProof
    )
  ).wait();
  const approvedAckHash = await destinationPacketHandler.acknowledgementHashes(approvedPacketId);
  const voucherBalanceApproved = await voucherB.balanceOf(destinationUser);

  CURRENT_PHASE = "approved-acknowledgement";
  logPhase("acknowledging approved packet back on Bank A");
  const ackHeight = BigInt(approvedRecvReceipt.blockNumber);
  const ackHeader = await trustRemoteHeaderAt({
    lightClient: sourceLightClient,
    provider: destinationProvider,
    sourceChainId: DESTINATION_CHAIN_ID,
    targetHeight: ackHeight,
    validatorEpoch: 1n,
  });
  const approvedAcknowledgement = ethers.solidityPacked(["string", "bytes32"], ["ok:", approvedPacketId]);
  const ackProof = await buildAcknowledgementProof(
    destinationProvider,
    destinationPacketHandlerAddress,
    approvedPacketId,
    approvedAckHash,
    ackHeader.headerUpdate.height,
    ackHeader.headerUpdate.stateRoot
  );
  await (
    await sourcePacketHandler.acknowledgePacketFromStorageProof(
      approvedPacket,
      approvedAcknowledgement,
      destinationPacketHandlerAddress,
      ackProof
    )
  ).wait();
  const sourceAckHash = await appA.acknowledgementHashByPacket(approvedPacketId);

  CURRENT_PHASE = "risk-deposit-and-borrow";
  logPhase("depositing voucher collateral and borrowing bCASH");
  await (await debtAssetB.mint(destinationUser, 500n)).wait();
  await (await debtAssetB.approve(lendingPoolBAddress, 500n)).wait();
  await (await lendingPoolB.depositLiquidity(500n)).wait();
  await (await voucherB.approve(lendingPoolBAddress, 100n)).wait();
  await (await lendingPoolB.depositCollateral(100n)).wait();
  const maxBorrowBefore = await readView("maxBorrow", () => lendingPoolB.maxBorrow(destinationUser));
  const borrowAmount = 140n;
  await (await lendingPoolB.borrow(borrowAmount)).wait();
  const healthBeforeShock = await readView("healthFactorBps before shock", () =>
    lendingPoolB.healthFactorBps(destinationUser)
  );
  const debtAfterBorrow = await readView("debtBalance after borrow", () => lendingPoolB.debtBalance(destinationUser));
  const collateralAfterDeposit = await readView("collateralBalance after deposit", () =>
    lendingPoolB.collateralBalance(destinationUser)
  );

  CURRENT_PHASE = "risk-price-shock-and-liquidate";
  logPhase("shocking voucher price and liquidating unhealthy position");
  await (await oracleB.setPrice(voucherBAddress, ethers.parseUnits("0.5", 18))).wait();
  const healthAfterShock = await readView("healthFactorBps after shock", () =>
    lendingPoolB.healthFactorBps(destinationUser)
  );
  const liquidatableAfterShock = await readView("isLiquidatable after shock", () =>
    lendingPoolB.isLiquidatable(destinationUser)
  );
  const maxLiquidationRepay = await readView("maxLiquidationRepay", () =>
    lendingPoolB.maxLiquidationRepay(destinationUser)
  );
  const liquidationRepay = 40n;
  const seizedCollateralPreview = await readView("previewLiquidation", () =>
    lendingPoolB.previewLiquidation(destinationUser, liquidationRepay)
  );
  await (await debtAssetB.mint(destinationLiquidator, liquidationRepay)).wait();
  const lendingPoolForLiquidator = lendingPoolB.connect(destinationLiquidatorSigner);
  const debtForLiquidator = debtAssetB.connect(destinationLiquidatorSigner);
  await (await debtForLiquidator.approve(lendingPoolBAddress, liquidationRepay)).wait();
  await (await lendingPoolForLiquidator.liquidate(destinationUser, liquidationRepay)).wait();
  const debtAfterLiquidation = await readView("debtBalance after liquidation", () =>
    lendingPoolB.debtBalance(destinationUser)
  );
  const collateralAfterLiquidation = await readView("collateralBalance after liquidation", () =>
    lendingPoolB.collateralBalance(destinationUser)
  );
  const liquidatorVoucherBalance = await readView("liquidator voucher balance", () =>
    voucherB.balanceOf(destinationLiquidator)
  );
  const policyDebtOutstanding = await readView("policy account debt outstanding", () =>
    policyB.accountDebtOutstanding(destinationUser, debtAssetBAddress)
  );
  const policyCollateralOutstanding = await readView("policy collateral outstanding", () =>
    policyB.collateralOutstanding(voucherBAddress)
  );

  CURRENT_PHASE = "denied-send";
  logPhase("sending policy-denied packet");
  await (await policyB.setAccountAllowed(destinationUser, false)).wait();
  const deniedTimeoutHeight = BigInt(await destinationProvider.getBlockNumber());
  const deniedSendReceipt = await (
    await appA.sendTransfer(DESTINATION_CHAIN_ID, destinationUser, 40n, deniedTimeoutHeight, 0)
  ).wait();
  const deniedCommitHeight = BigInt(deniedSendReceipt.blockNumber);
  const deniedPacketId = await packetStoreA.packetIdAt(2n);
  const deniedPacket = {
    sequence: 2n,
    source: { chainId: SOURCE_CHAIN_ID, port: appAAddress, channel: SOURCE_CHANNEL_ID },
    destination: { chainId: DESTINATION_CHAIN_ID, port: appBAddress, channel: DESTINATION_CHANNEL_ID },
    data: encodeTransferData({
      sender: sourceSender,
      recipient: destinationUser,
      asset: canonicalAssetAddress,
      amount: 40n,
      action: 1,
      memo: ethers.ZeroHash,
    }),
    timeout: { height: deniedTimeoutHeight, timestamp: 0n },
  };

  CURRENT_PHASE = "denied-trust-and-proof";
  logPhase("building denied packet proof");
  const deniedHeader = await trustRemoteHeaderAt({
    lightClient: destinationLightClient,
    provider: sourceProvider,
    sourceChainId: SOURCE_CHAIN_ID,
    targetHeight: deniedCommitHeight,
    validatorEpoch: 1n,
  });
  const deniedProofs = await buildPacketProofs(
    sourceProvider,
    packetStoreAAddress,
    deniedPacket,
    deniedHeader.headerUpdate.height,
    deniedHeader.headerUpdate.stateRoot
  );

  CURRENT_PHASE = "denied-receive";
  logPhase("checking destination policy denial");
  let deniedReason = "unknown";
  try {
    await destinationPacketHandler.recvPacketFromStorageProof(
      deniedPacket,
      deniedProofs.leafProof,
      deniedProofs.pathProof
    );
    throw new Error("Denied packet unexpectedly succeeded.");
  } catch (error) {
    deniedReason = shortError(error);
  }

  CURRENT_PHASE = "timeout-proof";
  logPhase("building timeout absence proof");
  const timeoutHeader = await trustRemoteHeaderAt({
    lightClient: sourceLightClient,
    provider: destinationProvider,
    sourceChainId: DESTINATION_CHAIN_ID,
    targetHeight: deniedTimeoutHeight,
    validatorEpoch: 1n,
  });
  const deniedReceiptAbsenceProof = await buildReceiptAbsenceProof(
    destinationProvider,
    destinationPacketHandlerAddress,
    deniedPacketId,
    timeoutHeader.headerUpdate.height,
    timeoutHeader.headerUpdate.stateRoot
  );
  CURRENT_PHASE = "timeout-execute";
  logPhase("executing timeout refund");
  const timeoutReceipt = await (
    await sourcePacketHandler.timeoutPacketFromStorageProof(
      deniedPacket,
      destinationPacketHandlerAddress,
      deniedReceiptAbsenceProof
    )
  ).wait();

  const deniedTimedOut = await sourcePacketHandler.packetTimeouts(deniedPacketId);
  const deniedRefundFlag = await appA.timedOutPacket(deniedPacketId);
  const finalCanonicalBalance = await canonicalAsset.balanceOf(sourceSender);
  const finalEscrowed = await escrowA.totalEscrowed();

  CURRENT_PHASE = "write-report";
  logPhase("writing verification report");
  const output = {
    status: "ok",
    phase: "complete",
    generatedAt: new Date().toISOString(),
    sourceChainId: SOURCE_CHAIN_ID.toString(),
    destinationChainId: DESTINATION_CHAIN_ID.toString(),
    sourceLightClientAddress,
    destinationLightClientAddress,
    sourcePacketHandlerAddress,
    destinationPacketHandlerAddress,
    appAAddress,
    appBAddress,
    canonicalAssetAddress,
    voucherBAddress,
    debtAssetBAddress,
    escrowAAddress,
    oracleBAddress,
    lendingPoolBAddress,
    packetStoreAAddress,
    connectionHandshake,
    channelHandshake,
    approved: {
      packetId: approvedPacketId,
      commitHeight: approvedCommitHeight.toString(),
      receiveHeight: ackHeight.toString(),
      voucherBalance: voucherBalanceApproved.toString(),
      destinationAckHash: approvedAckHash,
      sourceAckHash,
    },
    risk: {
      borrower: destinationUser,
      liquidator: destinationLiquidator,
      collateralToken: voucherBAddress,
      debtToken: debtAssetBAddress,
      oracle: oracleBAddress,
      pool: lendingPoolBAddress,
      collateralDeposited: collateralAfterDeposit.toString(),
      maxBorrowBefore: maxBorrowBefore.toString(),
      borrowed: debtAfterBorrow.toString(),
      healthBeforeShockBps: healthBeforeShock.toString(),
      shockedVoucherPriceE18: ethers.parseUnits("0.5", 18).toString(),
      healthAfterShockBps: healthAfterShock.toString(),
      liquidatableAfterShock,
      maxLiquidationRepay: maxLiquidationRepay.toString(),
      liquidationRepaid: liquidationRepay.toString(),
      seizedCollateral: seizedCollateralPreview.toString(),
      debtAfterLiquidation: debtAfterLiquidation.toString(),
      collateralAfterLiquidation: collateralAfterLiquidation.toString(),
      liquidatorVoucherBalance: liquidatorVoucherBalance.toString(),
      policyDebtOutstanding: policyDebtOutstanding.toString(),
      policyCollateralOutstanding: policyCollateralOutstanding.toString(),
    },
    denied: {
      packetId: deniedPacketId,
      commitHeight: deniedCommitHeight.toString(),
      timeoutHeight: deniedTimeoutHeight.toString(),
      deniedReason,
      timedOut: deniedTimedOut,
      refundObserved: deniedRefundFlag,
      timeoutTxHash: timeoutReceipt.hash,
      finalCanonicalBalance: finalCanonicalBalance.toString(),
      finalEscrowed: finalEscrowed.toString(),
    },
  };

  await writeVerificationReport(OUT_FILE, output);

  console.log(`Opened proof-checked connection ${ethers.decodeBytes32String(SOURCE_CONNECTION_ID)} <-> ${ethers.decodeBytes32String(DESTINATION_CONNECTION_ID)}`);
  console.log(`Opened proof-checked channel ${ethers.decodeBytes32String(SOURCE_CHANNEL_ID)} <-> ${ethers.decodeBytes32String(DESTINATION_CHANNEL_ID)}`);
  console.log(`Approved packet ${approvedPacketId} minted ${voucherBalanceApproved} voucher units on chain B`);
  console.log(
    `Risk leg: deposited 100 voucher units, borrowed ${debtAfterBorrow} bCASH, shocked voucher price, liquidated ${liquidationRepay} debt for ${seizedCollateralPreview} voucher units`
  );
  console.log(`Denied packet ${deniedPacketId} reverted on chain B with: ${deniedReason}`);
  console.log(`Timed out denied packet on chain A and observed refund=${deniedRefundFlag}`);
  console.log(`Saved policy packet verification report to ${OUT_FILE}`);
}

main()
  .then(() => process.exit(0))
  .catch(async (error) => {
    try {
      await writeVerificationFailureReport(OUT_FILE, error, {
        phase: typeof CURRENT_PHASE === "string" && CURRENT_PHASE.length > 0 ? CURRENT_PHASE : "unknown",
      });
    } catch (writeError) {
      console.error("Failed to write failure report:", writeError);
    }

    error.phase =
      typeof error?.phase === "string" && error.phase.length > 0
        ? error.phase
        : typeof CURRENT_PHASE === "string" && CURRENT_PHASE.length > 0
          ? CURRENT_PHASE
          : "unknown";
    console.error(`Policy packet verification failed during phase: ${error.phase}`);
    console.error(error);
    process.exit(1);
  });
