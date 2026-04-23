// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCPacketLib} from "./IBCPacketLib.sol";

/// @title IBCPacketStore
/// @notice Minimal source-side packet commitment store for the rebuild lane.
contract IBCPacketStore {
    uint256 public immutable localChainId;
    uint256 public packetSequence;

    mapping(uint256 => bytes32) public packetLeafAt;
    mapping(uint256 => bytes32) public packetPathAt;
    mapping(uint256 => bytes32) public packetIdAt;
    mapping(uint256 => bytes32) public packetAccumulatorAt;
    mapping(bytes32 => bool) public committedPacket;
    address public packetStoreAdmin;
    mapping(address => bool) public authorizedPacketWriter;

    event PacketWriterAuthorizationUpdated(address indexed writer, bool authorized);
    event PacketStoreAdminTransferred(address indexed oldAdmin, address indexed newAdmin);

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
        packetStoreAdmin = msg.sender;
    }

    modifier onlyPacketStoreAdmin() {
        require(msg.sender == packetStoreAdmin, "ONLY_PACKET_STORE_ADMIN");
        _;
    }

    function transferPacketStoreAdmin(address newAdmin) external onlyPacketStoreAdmin {
        require(newAdmin != address(0), "ADMIN_ZERO");
        address oldAdmin = packetStoreAdmin;
        packetStoreAdmin = newAdmin;
        emit PacketStoreAdminTransferred(oldAdmin, newAdmin);
    }

    function setPacketWriter(address writer, bool authorized) external onlyPacketStoreAdmin {
        require(writer != address(0), "WRITER_ZERO");
        authorizedPacketWriter[writer] = authorized;
        emit PacketWriterAuthorizationUpdated(writer, authorized);
    }

    function nextSequence() external view returns (uint256) {
        return packetSequence + 1;
    }

    function commitPacket(IBCPacketLib.Packet calldata packet) external returns (bytes32 packetId) {
        require(authorizedPacketWriter[msg.sender], "PACKET_WRITER_NOT_AUTHORIZED");
        require(packet.source.chainId == localChainId, "WRONG_SOURCE_CHAIN");
        require(packet.source.port == msg.sender, "SOURCE_PORT_MISMATCH");
        require(packet.destination.chainId != 0 && packet.destination.chainId != localChainId, "BAD_DESTINATION");
        require(packet.sequence == packetSequence + 1, "WRONG_PACKET_SEQUENCE");
        require(packet.source.port != address(0), "SOURCE_PORT_ZERO");
        require(packet.destination.port != address(0), "DESTINATION_PORT_ZERO");
        require(packet.source.channel != bytes32(0), "SOURCE_CHANNEL_ZERO");
        require(packet.destination.channel != bytes32(0), "DESTINATION_CHANNEL_ZERO");
        require(packet.data.length != 0, "PACKET_DATA_EMPTY");
        IBCPacketLib.TransferData memory transferData = IBCPacketLib.decodeTransferData(packet.data);
        require(transferData.sender != address(0), "SENDER_ZERO");
        require(transferData.recipient != address(0), "RECIPIENT_ZERO");
        require(transferData.asset != address(0), "ASSET_ZERO");
        require(transferData.amount > 0, "AMOUNT_ZERO");
        require(
            transferData.action == IBCPacketLib.ACTION_LOCK_MINT
                || transferData.action == IBCPacketLib.ACTION_BURN_UNLOCK,
            "BAD_ACTION"
        );

        packetId = IBCPacketLib.packetIdCalldata(packet);
        require(!committedPacket[packetId], "PACKET_EXISTS");

        bytes32 leaf = IBCPacketLib.leafHashCalldata(packet);
        bytes32 path = IBCPacketLib.commitmentPathCalldata(packet);
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
