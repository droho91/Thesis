import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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

const SOURCE_CHAIN_ID = BigInt(process.env.SOURCE_CHAIN_ID || "41001");
const DESTINATION_CHAIN_ID = BigInt(process.env.DESTINATION_CHAIN_ID || "41002");
const SOURCE_CHAIN_KEY = process.env.SOURCE_CHAIN_KEY || "A";
const DESTINATION_CHAIN_KEY = process.env.DESTINATION_CHAIN_KEY || "B";
const OUT_FILE = resolve(process.cwd(), process.env.OUT_FILE || "proofs/besu/packet-timeout-height-verification.json");

const PACKET_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes("IBC.Packet"));
const PACKET_RECEIPTS_SLOT = 2n;
const ORDER_UNORDERED = 1;
const SOURCE_CONNECTION_ID = ethers.encodeBytes32String("connection-a");
const DESTINATION_CONNECTION_ID = ethers.encodeBytes32String("connection-b");
const SOURCE_CHANNEL_ID = ethers.encodeBytes32String("channel-a");
const DESTINATION_CHANNEL_ID = ethers.encodeBytes32String("channel-b");
const CHANNEL_VERSION = ethers.hexlify(ethers.toUtf8Bytes("ics-004"));
const CONNECTION_PREFIX = ethers.hexlify(ethers.toUtf8Bytes("ibc"));

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

function encodeTransferData({ sender, recipient, asset, amount, action, memo }) {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(address sender,address recipient,address asset,uint256 amount,uint8 action,bytes32 memo)"],
    [{ sender, recipient, asset, amount, action, memo }]
  );
}

function bytes32MappingSlot(key, slot) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [key, slot]));
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

async function main() {
  await waitForBesuRuntimeReady();

  const sourceProvider = new ethers.JsonRpcProvider(CHAIN_A_RPC);
  const destinationProvider = new ethers.JsonRpcProvider(CHAIN_B_RPC);
  const sourceSigner = await signerForRpc(CHAIN_A_RPC, SOURCE_CHAIN_KEY, 0);
  const destinationSigner = await signerForRpc(CHAIN_B_RPC, DESTINATION_CHAIN_KEY, 0);
  const sourceSender = await sourceSigner.getAddress();
  const destinationUser = await destinationSigner.getAddress();

  const lightClientArtifact = await loadArtifact("clients/BesuLightClient.sol", "BesuLightClient");
  const connectionKeeperArtifact = await loadArtifact(
    "core/IBCConnectionKeeper.sol",
    "IBCConnectionKeeper"
  );
  const channelKeeperArtifact = await loadArtifact("core/IBCChannelKeeper.sol", "IBCChannelKeeper");
  const packetStoreArtifact = await loadArtifact("core/IBCPacketStore.sol", "IBCPacketStore");
  const packetHandlerArtifact = await loadArtifact("core/IBCPacketHandler.sol", "IBCPacketHandler");
  const receiverArtifact = await loadArtifact("test/MockPacketReceiver.sol", "MockPacketReceiver");
  const lifecycleAppArtifact = await loadArtifact(
    "test/MockPacketLifecycleApp.sol",
    "MockPacketLifecycleApp"
  );

  const receiver = await deploy(receiverArtifact, destinationSigner, []);
  const receiverAddress = await receiver.getAddress();

  const destinationLightClient = await deploy(lightClientArtifact, destinationSigner, [destinationUser]);
  const destinationLightClientAddress = await destinationLightClient.getAddress();
  const destinationConnectionKeeper = await deploy(connectionKeeperArtifact, destinationSigner, [
    DESTINATION_CHAIN_ID,
    destinationLightClientAddress,
    destinationUser,
  ]);
  const destinationConnectionKeeperAddress = await destinationConnectionKeeper.getAddress();
  const destinationChannelKeeper = await deploy(channelKeeperArtifact, destinationSigner, [
    DESTINATION_CHAIN_ID,
    destinationConnectionKeeperAddress,
    destinationUser,
  ]);
  const destinationChannelKeeperAddress = await destinationChannelKeeper.getAddress();
  const destinationPacketHandler = await deploy(packetHandlerArtifact, destinationSigner, [
    DESTINATION_CHAIN_ID,
    destinationLightClientAddress,
    destinationChannelKeeperAddress,
    destinationUser,
  ]);
  const destinationPacketHandlerAddress = await destinationPacketHandler.getAddress();

  const sourceLightClient = await deploy(lightClientArtifact, sourceSigner, [sourceSender]);
  const sourceLightClientAddress = await sourceLightClient.getAddress();
  const sourceConnectionKeeper = await deploy(connectionKeeperArtifact, sourceSigner, [
    SOURCE_CHAIN_ID,
    sourceLightClientAddress,
    sourceSender,
  ]);
  const sourceConnectionKeeperAddress = await sourceConnectionKeeper.getAddress();
  const sourceChannelKeeper = await deploy(channelKeeperArtifact, sourceSigner, [
    SOURCE_CHAIN_ID,
    sourceConnectionKeeperAddress,
    sourceSender,
  ]);
  const sourceChannelKeeperAddress = await sourceChannelKeeper.getAddress();
  const sourcePacketHandler = await deploy(packetHandlerArtifact, sourceSigner, [
    SOURCE_CHAIN_ID,
    sourceLightClientAddress,
    sourceChannelKeeperAddress,
    sourceSender,
  ]);
  const sourcePacketHandlerAddress = await sourcePacketHandler.getAddress();
  const sourceApp = await deploy(lifecycleAppArtifact, sourceSigner, [sourcePacketHandlerAddress]);
  const sourceAppAddress = await sourceApp.getAddress();
  await (await sourcePacketHandler.setPortApplication(sourceAppAddress, sourceAppAddress)).wait();

  const packetStore = await deploy(packetStoreArtifact, sourceSigner, [SOURCE_CHAIN_ID]);
  const packetStoreAddress = await packetStore.getAddress();
  await (await packetStore.setPacketWriter(sourceAppAddress, true)).wait();
  await (await sourcePacketHandler.setTrustedPacketStore(SOURCE_CHAIN_ID, packetStoreAddress)).wait();
  await (await destinationPacketHandler.setTrustedPacketStore(SOURCE_CHAIN_ID, packetStoreAddress)).wait();

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
    sourcePort: sourceAppAddress,
    destinationPort: receiverAddress,
    ordering: ORDER_UNORDERED,
    version: CHANNEL_VERSION,
  });

  const timeoutHeight = BigInt(await destinationProvider.getBlockNumber());
  const packet = {
    sequence: 1n,
    source: { chainId: SOURCE_CHAIN_ID, port: sourceAppAddress, channel: SOURCE_CHANNEL_ID },
    destination: { chainId: DESTINATION_CHAIN_ID, port: receiverAddress, channel: DESTINATION_CHANNEL_ID },
    data: encodeTransferData({
      sender: sourceSender,
      recipient: destinationUser,
      asset: packetStoreAddress,
      amount: 100n,
      action: 1,
      memo: ethers.ZeroHash,
    }),
    timeout: { height: timeoutHeight, timestamp: 0n },
  };

  await (await sourceApp.commitPacket(packetStoreAddress, packet)).wait();
  const packetIdValue = packetId(packet);

  const destinationHeight = BigInt(await destinationProvider.getBlockNumber());
  if (destinationHeight === 0n) {
    throw new Error("Need at least one parent block before the timeout proof block.");
  }
  const destinationHeader = await trustRemoteHeaderAt({
    lightClient: sourceLightClient,
    provider: destinationProvider,
    sourceChainId: DESTINATION_CHAIN_ID,
    targetHeight: destinationHeight,
    validatorEpoch: 1n,
  });
  const timeoutProofHeight = destinationHeader.headerUpdate.height;

  const receiptAbsenceProof = await buildReceiptAbsenceProof(
    destinationProvider,
    destinationPacketHandlerAddress,
    packetIdValue,
    timeoutProofHeight,
    destinationHeader.headerUpdate.stateRoot
  );

  const timeoutTx = await sourcePacketHandler.timeoutPacketFromStorageProof(
    packet,
    destinationPacketHandlerAddress,
    receiptAbsenceProof
  );
  const timeoutReceipt = await timeoutTx.wait();

  const timedOut = await sourcePacketHandler.packetTimeouts(packetIdValue);
  const timeoutCount = await sourceApp.timeoutCount();
  const lastTimedOutPacketId = await sourceApp.lastTimedOutPacketId();
  if (!timedOut || timeoutCount !== 1n || lastTimedOutPacketId !== packetIdValue) {
    throw new Error("Timeout state or source app timeout callback was not observed.");
  }

  const output = {
    generatedAt: new Date().toISOString(),
    sourceLightClientAddress,
    destinationLightClientAddress,
    sourceConnectionKeeperAddress,
    destinationConnectionKeeperAddress,
    sourceChannelKeeperAddress,
    destinationChannelKeeperAddress,
    sourcePacketHandlerAddress,
    destinationPacketHandlerAddress,
    packetStoreAddress,
    receiverAddress,
    sourceAppAddress,
    sourceChainId: SOURCE_CHAIN_ID.toString(),
    destinationChainId: DESTINATION_CHAIN_ID.toString(),
    connectionHandshake,
    channelHandshake,
    timeoutProofHeight: timeoutProofHeight.toString(),
    timeoutProofHeaderHash: destinationHeader.headerUpdate.headerHash,
    packetId: packetIdValue,
    receiptStorageKey: receiptAbsenceProof.storageKey,
    timedOut,
    timeoutCount: timeoutCount.toString(),
    timeoutTxHash: timeoutReceipt.hash,
  };

  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(output, null, 2)}\n`);

  console.log(
    `Opened proof-checked connection ${ethers.decodeBytes32String(SOURCE_CONNECTION_ID)} <-> ${ethers.decodeBytes32String(DESTINATION_CONNECTION_ID)}`
  );
  console.log(`Opened proof-checked channel ${ethers.decodeBytes32String(SOURCE_CHANNEL_ID)} <-> ${ethers.decodeBytes32String(DESTINATION_CHANNEL_ID)}`);
  console.log(`Committed packet ${packetIdValue} on chain A without receiving it on chain B`);
  console.log(`Verified absent receipt on chain B at height ${timeoutProofHeight}`);
  console.log(`Timed out packet on chain A with callback count ${timeoutCount}`);
  console.log(`Saved timeout verification report to ${OUT_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
