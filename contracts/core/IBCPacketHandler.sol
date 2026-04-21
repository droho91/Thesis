// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IBCChannelKeeper} from "./IBCChannelKeeper.sol";
import {IBCEVMTypes} from "./IBCEVMTypes.sol";
import {IBCPacketHandlerSlots} from "./IBCPacketHandlerSlots.sol";
import {IBCPacketStore} from "./IBCPacketStore.sol";
import {IBCPacketLib} from "./IBCPacketLib.sol";
import {IBCProofVerifier} from "./IBCProofVerifier.sol";
import {
    IBCPacketAcknowledgementReceiver,
    IBCPacketReceiver,
    IBCPacketTimeoutReceiver
} from "./IBCPacketReceiver.sol";

/// @title IBCPacketHandler
/// @notice Minimal IBC packet handler with receipts and acknowledgements, anchored on BesuLightClient.
contract IBCPacketHandler is AccessControl, IBCProofVerifier {
    bytes32 public constant CLIENT_ADMIN_ROLE = keccak256("CLIENT_ADMIN_ROLE");

    uint256 public immutable localChainId;
    IBCChannelKeeper public immutable channelKeeper;
    mapping(uint256 => address) public trustedPacketStoreBySourceChain;
    mapping(bytes32 => bool) public packetReceipts;
    mapping(bytes32 => bytes32) public acknowledgementHashes;
    mapping(bytes32 => bool) public packetAcknowledgements;
    mapping(bytes32 => bool) public packetTimeouts;
    mapping(address => address) public portApplications;

    event TrustedPacketStoreSet(uint256 indexed sourceChainId, address indexed packetStore);
    event PortApplicationSet(address indexed port, address indexed application);
    event PacketReceiptWritten(bytes32 indexed packetId, uint256 indexed sourceChainId, uint256 indexed trustedHeight);
    event PacketAcknowledgementStored(bytes32 indexed packetId, bytes32 acknowledgementHash);
    event PacketAcknowledgementVerified(
        bytes32 indexed packetId,
        uint256 indexed destinationChainId,
        uint256 indexed trustedHeight,
        bytes32 acknowledgementHash
    );
    event PacketTimeoutVerified(bytes32 indexed packetId, uint256 indexed destinationChainId, uint256 indexed trustedHeight);

    constructor(uint256 _localChainId, address besuLightClient_, address channelKeeper_, address admin)
        IBCProofVerifier(besuLightClient_)
    {
        require(_localChainId != 0, "CHAIN_ID_ZERO");
        require(channelKeeper_ != address(0), "CHANNEL_KEEPER_ZERO");
        require(admin != address(0), "ADMIN_ZERO");
        localChainId = _localChainId;
        channelKeeper = IBCChannelKeeper(channelKeeper_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CLIENT_ADMIN_ROLE, admin);
    }

    function setTrustedPacketStore(uint256 sourceChainId, address packetStore) external onlyRole(CLIENT_ADMIN_ROLE) {
        require(sourceChainId != 0, "SOURCE_CHAIN_ZERO");
        require(packetStore != address(0), "PACKET_STORE_ZERO");
        trustedPacketStoreBySourceChain[sourceChainId] = packetStore;
        emit TrustedPacketStoreSet(sourceChainId, packetStore);
    }

    function setPortApplication(address port, address application) external onlyRole(CLIENT_ADMIN_ROLE) {
        require(port != address(0), "PORT_ZERO");
        require(application != address(0), "APPLICATION_ZERO");
        portApplications[port] = application;
        emit PortApplicationSet(port, application);
    }

    function recvPacketFromStorageProof(
        IBCPacketLib.Packet calldata packet,
        IBCEVMTypes.StorageProof calldata leafProof,
        IBCEVMTypes.StorageProof calldata pathProof
    ) external returns (bytes32 packetId, bytes32 acknowledgementHash) {
        require(packet.destination.chainId == localChainId, "WRONG_DESTINATION_CHAIN");
        require(packet.destination.port != address(0), "DESTINATION_PORT_ZERO");
        require(
            channelKeeper.isPacketRouteOpenForChannel(
                packet.source.chainId,
                packet.source.port,
                packet.destination.port,
                packet.destination.channel,
                packet.source.channel
            ),
            "CHANNEL_NOT_OPEN"
        );

        address trustedPacketStore = trustedPacketStoreBySourceChain[packet.source.chainId];
        require(
            _verifyPacketStorageMembership(packet, trustedPacketStore, leafProof, pathProof),
            "INVALID_PACKET_STORAGE_PROOF"
        );

        packetId = IBCPacketLib.packetIdCalldata(packet);
        require(!packetReceipts[packetId], "PACKET_ALREADY_RECEIVED");
        packetReceipts[packetId] = true;
        emit PacketReceiptWritten(packetId, packet.source.chainId, leafProof.trustedHeight);

        bytes memory acknowledgement = IBCPacketReceiver(packet.destination.port).onRecvPacket(packet, packetId);
        acknowledgementHash = keccak256(acknowledgement);
        acknowledgementHashes[packetId] = acknowledgementHash;
        emit PacketAcknowledgementStored(packetId, acknowledgementHash);
    }

    function acknowledgePacketFromStorageProof(
        IBCPacketLib.Packet calldata packet,
        bytes calldata acknowledgement,
        address remotePacketHandler,
        IBCEVMTypes.StorageProof calldata acknowledgementProof
    ) external returns (bytes32 packetId, bytes32 acknowledgementHash) {
        require(packet.source.chainId == localChainId, "WRONG_SOURCE_CHAIN");
        require(packet.destination.chainId == acknowledgementProof.sourceChainId, "ACK_SOURCE_CHAIN_MISMATCH");
        require(remotePacketHandler != address(0), "REMOTE_HANDLER_ZERO");
        require(
            channelKeeper.isPacketRouteOpenForChannel(
                packet.destination.chainId,
                packet.destination.port,
                packet.source.port,
                packet.source.channel,
                packet.destination.channel
            ),
            "CHANNEL_NOT_OPEN"
        );

        packetId = IBCPacketLib.packetIdCalldata(packet);
        _requireLocalPacketCommitment(packetId);
        require(!packetAcknowledgements[packetId], "PACKET_ALREADY_ACKNOWLEDGED");
        require(!packetTimeouts[packetId], "PACKET_ALREADY_TIMED_OUT");

        acknowledgementHash = keccak256(acknowledgement);
        require(acknowledgementProof.account == remotePacketHandler, "ACK_ACCOUNT_MISMATCH");
        require(
            acknowledgementProof.storageKey == IBCPacketHandlerSlots.acknowledgementHash(packetId),
            "ACK_STORAGE_KEY_MISMATCH"
        );
        require(
            keccak256(acknowledgementProof.expectedValue) ==
                keccak256(IBCEVMTypes.rlpEncodeWord(acknowledgementHash)),
            "ACK_EXPECTED_VALUE_MISMATCH"
        );
        require(_verifyTrustedEVMStorageProof(acknowledgementProof), "INVALID_ACK_STORAGE_PROOF");

        packetAcknowledgements[packetId] = true;
        acknowledgementHashes[packetId] = acknowledgementHash;
        address application = portApplications[packet.source.port];
        if (application != address(0)) {
            IBCPacketAcknowledgementReceiver(application).onAcknowledgementPacket(
                packet, packetId, acknowledgement
            );
        }
        emit PacketAcknowledgementVerified(
            packetId,
            packet.destination.chainId,
            acknowledgementProof.trustedHeight,
            acknowledgementHash
        );
    }

    function timeoutPacketFromStorageProof(
        IBCPacketLib.Packet calldata packet,
        address remotePacketHandler,
        IBCEVMTypes.StorageProof calldata receiptAbsenceProof
    ) external returns (bytes32 packetId) {
        require(packet.source.chainId == localChainId, "WRONG_SOURCE_CHAIN");
        require(packet.destination.chainId == receiptAbsenceProof.sourceChainId, "TIMEOUT_SOURCE_CHAIN_MISMATCH");
        require(remotePacketHandler != address(0), "REMOTE_HANDLER_ZERO");
        require(
            channelKeeper.isPacketRouteOpenForChannel(
                packet.destination.chainId,
                packet.destination.port,
                packet.source.port,
                packet.source.channel,
                packet.destination.channel
            ),
            "CHANNEL_NOT_OPEN"
        );

        packetId = IBCPacketLib.packetIdCalldata(packet);
        _requireLocalPacketCommitment(packetId);
        require(!packetAcknowledgements[packetId], "PACKET_ALREADY_ACKNOWLEDGED");
        require(!packetTimeouts[packetId], "PACKET_ALREADY_TIMED_OUT");
        require(_packetTimedOut(packet, receiptAbsenceProof.trustedHeight), "PACKET_NOT_TIMED_OUT");

        require(receiptAbsenceProof.account == remotePacketHandler, "RECEIPT_ACCOUNT_MISMATCH");
        require(
            receiptAbsenceProof.storageKey == IBCPacketHandlerSlots.packetReceipt(packetId),
            "RECEIPT_STORAGE_KEY_MISMATCH"
        );
        require(_verifyTrustedEVMStorageAbsenceProof(receiptAbsenceProof), "INVALID_RECEIPT_ABSENCE_PROOF");

        packetTimeouts[packetId] = true;
        address application = portApplications[packet.source.port];
        if (application != address(0)) {
            IBCPacketTimeoutReceiver(application).onTimeoutPacket(packet, packetId);
        }
        emit PacketTimeoutVerified(packetId, packet.destination.chainId, receiptAbsenceProof.trustedHeight);
    }

    function _requireLocalPacketCommitment(bytes32 packetId) internal view {
        address localPacketStore = trustedPacketStoreBySourceChain[localChainId];
        require(localPacketStore != address(0), "LOCAL_PACKET_STORE_ZERO");
        require(IBCPacketStore(localPacketStore).committedPacket(packetId), "PACKET_NOT_COMMITTED");
    }

    function _packetTimedOut(IBCPacketLib.Packet calldata packet, uint256 trustedHeight)
        internal
        view
        returns (bool)
    {
        bool heightTimedOut = packet.timeout.height != 0 && trustedHeight >= packet.timeout.height;
        if (heightTimedOut) return true;
        if (packet.timeout.timestamp == 0) return false;

        uint256 remoteTimestamp = besuLightClient.trustedTimestamp(packet.destination.chainId, trustedHeight);
        return remoteTimestamp != 0 && remoteTimestamp >= packet.timeout.timestamp;
    }
}
