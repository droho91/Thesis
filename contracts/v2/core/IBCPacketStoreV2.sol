// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCPacketLibV2} from "./IBCPacketLibV2.sol";

/// @title IBCPacketStoreV2
/// @notice Minimal source-side packet commitment store for the rebuild lane.
contract IBCPacketStoreV2 {
    uint256 public immutable localChainId;
    uint256 public packetSequence;

    mapping(uint256 => bytes32) public packetLeafAt;
    mapping(uint256 => bytes32) public packetPathAt;
    mapping(uint256 => bytes32) public packetIdAt;
    mapping(uint256 => bytes32) public packetAccumulatorAt;
    mapping(bytes32 => bool) public committedPacket;

    event PacketCommitted(
        bytes32 indexed packetId,
        uint256 indexed sequence,
        uint256 indexed destinationChainId,
        bytes32 leaf,
        bytes32 path,
        bytes32 accumulator
    );

    constructor(uint256 _localChainId) {
        require(_localChainId != 0, "CHAIN_ID_ZERO");
        localChainId = _localChainId;
    }

    function nextSequence() external view returns (uint256) {
        return packetSequence + 1;
    }

    function commitPacket(IBCPacketLibV2.Packet calldata packet) external returns (bytes32 packetId) {
        require(packet.source.chainId == localChainId, "WRONG_SOURCE_CHAIN");
        require(packet.destination.chainId != 0 && packet.destination.chainId != localChainId, "BAD_DESTINATION");
        require(packet.sequence == packetSequence + 1, "WRONG_PACKET_SEQUENCE");
        require(packet.source.port != address(0), "SOURCE_PORT_ZERO");
        require(packet.destination.port != address(0), "DESTINATION_PORT_ZERO");
        require(packet.source.channel != bytes32(0), "SOURCE_CHANNEL_ZERO");
        require(packet.destination.channel != bytes32(0), "DESTINATION_CHANNEL_ZERO");
        require(packet.data.length != 0, "PACKET_DATA_EMPTY");
        IBCPacketLibV2.TransferData memory transferData = IBCPacketLibV2.decodeTransferData(packet.data);
        require(transferData.sender != address(0), "SENDER_ZERO");
        require(transferData.recipient != address(0), "RECIPIENT_ZERO");
        require(transferData.asset != address(0), "ASSET_ZERO");
        require(transferData.amount > 0, "AMOUNT_ZERO");
        require(
            transferData.action == IBCPacketLibV2.ACTION_LOCK_MINT
                || transferData.action == IBCPacketLibV2.ACTION_BURN_UNLOCK,
            "BAD_ACTION"
        );

        packetId = IBCPacketLibV2.packetIdCalldata(packet);
        require(!committedPacket[packetId], "PACKET_EXISTS");

        bytes32 leaf = IBCPacketLibV2.leafHashCalldata(packet);
        bytes32 path = IBCPacketLibV2.commitmentPathCalldata(packet);
        bytes32 previousAccumulator = packetAccumulatorAt[packetSequence];
        packetSequence = packet.sequence;
        bytes32 accumulator = keccak256(abi.encodePacked(previousAccumulator, packet.sequence, leaf));

        packetLeafAt[packet.sequence] = leaf;
        packetPathAt[packet.sequence] = path;
        packetIdAt[packet.sequence] = packetId;
        packetAccumulatorAt[packet.sequence] = accumulator;
        committedPacket[packetId] = true;

        emit PacketCommitted(packetId, packet.sequence, packet.destination.chainId, leaf, path, accumulator);
    }
}
