import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ethers } from "ethers";
import {
  openProofCheckedChannel,
  openProofCheckedConnection,
  trustRemoteHeaderAt,
} from "./ibc-v2-handshake.mjs";
import {
  CHAIN_A_RPC,
  CHAIN_B_RPC,
  deploy,
  loadArtifact,
  signerForRpc,
  waitForBesuRuntimeReady,
} from "./ibc-lite-common.mjs";

const SOURCE_CHAIN_ID = BigInt(process.env.SOURCE_CHAIN_ID || "41001");
const DESTINATION_CHAIN_ID = BigInt(process.env.DESTINATION_CHAIN_ID || "41002");
const SOURCE_CHAIN_KEY = process.env.SOURCE_CHAIN_KEY || "A";
const DESTINATION_CHAIN_KEY = process.env.DESTINATION_CHAIN_KEY || "B";
const OUT_FILE = resolve(process.cwd(), process.env.OUT_FILE || "proofs/besu/packet-v2-smoke.json");

const PACKET_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes("IBCLite.Packet.v2"));
const PACKET_LEAF_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes("IBCLite.PacketLeaf.v2"));
const PACKET_COMMITMENT_PATH_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes("IBCLite.PacketCommitmentPath.v2"));
const ACKNOWLEDGEMENT_HASHES_SLOT = 3n;
const ORDER_UNORDERED = 1;
const SOURCE_CONNECTION_ID = ethers.encodeBytes32String("connection-a");
const DESTINATION_CONNECTION_ID = ethers.encodeBytes32String("connection-b");
const SOURCE_CHANNEL_ID = ethers.encodeBytes32String("channel-a");
const DESTINATION_CHANNEL_ID = ethers.encodeBytes32String("channel-b");
const CHANNEL_VERSION = ethers.hexlify(ethers.toUtf8Bytes("ics-v2"));
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
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [sequence, slot])
  );
}

function bytes32MappingSlot(key, slot) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [key, slot])
  );
}

function rlpWord(word) {
  return ethers.hexlify(ethers.concat([new Uint8Array([0xa0]), ethers.getBytes(word)]));
}

async function buildPacketProofs(provider, packetStoreAddress, packet, trustedHeight, stateRoot) {
  const leafSlot = mappingSlot(packet.sequence, 1n);
  const pathSlot = mappingSlot(packet.sequence, 2n);
  const proof = await provider.send("eth_getProof", [packetStoreAddress, [leafSlot, pathSlot], ethers.toQuantity(trustedHeight)]);
  if (!proof?.storageProof || proof.storageProof.length !== 2) {
    throw new Error("eth_getProof did not return both packet storage proofs.");
  }

  const leaf = packetLeaf(packet);
  const path = packetPath(packet);
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
      expectedValue: rlpWord(leaf),
      accountProof: proof.accountProof,
      storageProof: leafEntry.proof,
    },
    pathProof: {
      sourceChainId: SOURCE_CHAIN_ID,
      trustedHeight,
      stateRoot,
      account: packetStoreAddress,
      storageKey: pathSlot,
      expectedValue: rlpWord(path),
      accountProof: proof.accountProof,
      storageProof: pathEntry.proof,
    },
    leaf,
    path,
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

async function main() {
  await waitForBesuRuntimeReady();

  const sourceProvider = new ethers.JsonRpcProvider(CHAIN_A_RPC);
  const destinationProvider = new ethers.JsonRpcProvider(CHAIN_B_RPC);
  const sourceSigner = await signerForRpc(CHAIN_A_RPC, SOURCE_CHAIN_KEY, 0);
  const destinationSigner = await signerForRpc(CHAIN_B_RPC, DESTINATION_CHAIN_KEY, 0);
  const sourceSender = await sourceSigner.getAddress();
  const destinationUser = await destinationSigner.getAddress();

  const lightClientArtifact = await loadArtifact("v2/clients/BesuLightClient.sol", "BesuLightClient");
  const connectionKeeperArtifact = await loadArtifact(
    "v2/core/IBCConnectionKeeperV2.sol",
    "IBCConnectionKeeperV2"
  );
  const channelKeeperArtifact = await loadArtifact("v2/core/IBCChannelKeeperV2.sol", "IBCChannelKeeperV2");
  const packetStoreArtifact = await loadArtifact("v2/core/IBCPacketStoreV2.sol", "IBCPacketStoreV2");
  const packetHandlerArtifact = await loadArtifact("v2/core/IBCPacketHandlerV2.sol", "IBCPacketHandlerV2");
  const receiverArtifact = await loadArtifact("v2/test/MockPacketReceiverV2.sol", "MockPacketReceiverV2");
  const lifecycleAppArtifact = await loadArtifact(
    "v2/test/MockPacketLifecycleAppV2.sol",
    "MockPacketLifecycleAppV2"
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
  await (await destinationPacketHandler.setTrustedPacketStore(SOURCE_CHAIN_ID, packetStoreAddress)).wait();
  await (await sourcePacketHandler.setTrustedPacketStore(SOURCE_CHAIN_ID, packetStoreAddress)).wait();
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
    timeout: { height: 0n, timestamp: 0n },
  };

  const commitTx = await packetStore.commitPacket(packet);
  const commitReceipt = await commitTx.wait();
  const trustedHeight = BigInt(commitReceipt.blockNumber);
  if (trustedHeight === 0n) {
    throw new Error("Need at least one parent block before the packet commit block.");
  }

  const latest = await trustRemoteHeaderAt({
    lightClient: destinationLightClient,
    provider: sourceProvider,
    sourceChainId: SOURCE_CHAIN_ID,
    targetHeight: trustedHeight,
    validatorEpoch: 1n,
  });

  const proofs = await buildPacketProofs(
    sourceProvider,
    packetStoreAddress,
    packet,
    trustedHeight,
    latest.headerUpdate.stateRoot
  );

  const recvTx = await destinationPacketHandler.recvPacketFromStorageProof(packet, proofs.leafProof, proofs.pathProof);
  const recvReceipt = await recvTx.wait();
  const acknowledgementHeight = BigInt(recvReceipt.blockNumber);
  const packetIdValue = packetId(packet);
  const receiptWritten = await destinationPacketHandler.packetReceipts(packetIdValue);
  const acknowledgementHash = await destinationPacketHandler.acknowledgementHashes(packetIdValue);
  const receiverAckHash = await receiver.lastAckHash();
  const receiverPacketId = await receiver.lastPacketId();

  const expectedAckHash = ethers.keccak256(ethers.solidityPacked(["string", "bytes32"], ["ok:", packetIdValue]));
  if (!receiptWritten) {
    throw new Error("Packet receipt was not written on the destination handler.");
  }
  if (acknowledgementHash !== expectedAckHash || receiverAckHash !== expectedAckHash) {
    throw new Error("Acknowledgement hash mismatch in v2 packet smoke.");
  }

  const acknowledgementHeader = await trustRemoteHeaderAt({
    lightClient: sourceLightClient,
    provider: destinationProvider,
    sourceChainId: DESTINATION_CHAIN_ID,
    targetHeight: acknowledgementHeight,
    validatorEpoch: 1n,
  });

  const acknowledgement = ethers.solidityPacked(["string", "bytes32"], ["ok:", packetIdValue]);
  const acknowledgementProof = await buildAcknowledgementProof(
    destinationProvider,
    destinationPacketHandlerAddress,
    packetIdValue,
    acknowledgementHash,
    acknowledgementHeight,
    acknowledgementHeader.headerUpdate.stateRoot
  );
  await (
    await sourcePacketHandler.acknowledgePacketFromStorageProof(
      packet,
      acknowledgement,
      destinationPacketHandlerAddress,
      acknowledgementProof
    )
  ).wait();

  const sourceAcknowledged = await sourcePacketHandler.packetAcknowledgements(packetIdValue);
  const sourceAcknowledgementHash = await sourcePacketHandler.acknowledgementHashes(packetIdValue);
  const sourceAppAcknowledgementCount = await sourceApp.acknowledgementCount();
  const sourceAppLastPacketId = await sourceApp.lastAcknowledgedPacketId();
  const sourceAppLastAcknowledgementHash = await sourceApp.lastAcknowledgementHash();
  if (!sourceAcknowledged || sourceAcknowledgementHash !== acknowledgementHash) {
    throw new Error("Source acknowledgement verification did not persist expected state.");
  }
  if (
    sourceAppAcknowledgementCount !== 1n ||
    sourceAppLastPacketId !== packetIdValue ||
    sourceAppLastAcknowledgementHash !== acknowledgementHash
  ) {
    throw new Error("Source app acknowledgement callback did not observe the verified acknowledgement.");
  }

  const output = {
    generatedAt: new Date().toISOString(),
    destinationLightClientAddress,
    sourceLightClientAddress,
    destinationConnectionKeeperAddress,
    sourceConnectionKeeperAddress,
    destinationChannelKeeperAddress,
    sourceChannelKeeperAddress,
    packetStoreAddress,
    destinationPacketHandlerAddress,
    sourcePacketHandlerAddress,
    receiverAddress,
    sourceAppAddress,
    sourceChainId: SOURCE_CHAIN_ID.toString(),
    destinationChainId: DESTINATION_CHAIN_ID.toString(),
    connectionHandshake,
    channelHandshake,
    trustedHeight: trustedHeight.toString(),
    headerHash: latest.headerUpdate.headerHash,
    acknowledgementHeight: acknowledgementHeight.toString(),
    acknowledgementHeaderHash: acknowledgementHeader.headerUpdate.headerHash,
    packetId: packetIdValue,
    packetLeaf: proofs.leaf,
    packetPath: proofs.path,
    acknowledgementHash,
    sourceAcknowledgementHash,
    sourceAppAcknowledgementCount: sourceAppAcknowledgementCount.toString(),
    sourceAppLastAcknowledgementHash,
    receiverPacketId,
    receiptWritten,
    sourceAcknowledged,
    executionTxHash: recvReceipt.hash,
  };

  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(output, null, 2)}\n`);

  console.log(`Deployed IBCPacketStoreV2 to ${packetStoreAddress} on chain A`);
  console.log(`Deployed BesuLightClient v2 to ${destinationLightClientAddress} on chain B`);
  console.log(
    `Opened proof-checked v2 connection ${ethers.decodeBytes32String(SOURCE_CONNECTION_ID)} <-> ${ethers.decodeBytes32String(DESTINATION_CONNECTION_ID)}`
  );
  console.log(`Opened proof-checked v2 channel ${ethers.decodeBytes32String(SOURCE_CHANNEL_ID)} <-> ${ethers.decodeBytes32String(DESTINATION_CHANNEL_ID)}`);
  console.log(`Deployed IBCPacketHandlerV2 to ${destinationPacketHandlerAddress} on chain B`);
  console.log(`Executed packet ${packetIdValue} on chain B with acknowledgement ${acknowledgementHash}`);
  console.log(`Verified acknowledgement on chain A at remote height ${acknowledgementHeight}`);
  console.log(`Saved packet smoke report to ${OUT_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
