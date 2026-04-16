// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IBCPathLib} from "../core/IBCPathLib.sol";
import {PacketLib} from "../libs/PacketLib.sol";

/// @title SourcePacketCommitment
/// @notice Canonical source-chain packet commitment store.
contract SourcePacketCommitment is AccessControl {
    bytes32 public constant PACKET_COMMITTER_ROLE = keccak256("PACKET_COMMITTER_ROLE");

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
        address sourcePort,
        address destinationPort,
        address sender,
        address recipient,
        address asset,
        uint256 amount,
        uint8 action,
        bytes32 leaf,
        bytes32 accumulator
    );

    constructor(uint256 _localChainId) {
        require(_localChainId != 0, "CHAIN_ID_ZERO");
        localChainId = _localChainId;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PACKET_COMMITTER_ROLE, msg.sender);
    }

    function nextSequence() external view returns (uint256) {
        return packetSequence + 1;
    }

    function commitPacket(PacketLib.Packet calldata packet)
        external
        onlyRole(PACKET_COMMITTER_ROLE)
        returns (bytes32 packetId)
    {
        require(packet.sourceChainId == localChainId, "WRONG_SOURCE_CHAIN");
        require(packet.destinationChainId != 0 && packet.destinationChainId != localChainId, "BAD_DESTINATION");
        require(packet.sequence == packetSequence + 1, "WRONG_PACKET_SEQUENCE");
        require(packet.sourcePort != address(0), "SOURCE_PORT_ZERO");
        require(packet.destinationPort != address(0), "DESTINATION_PORT_ZERO");
        require(packet.sender != address(0), "SENDER_ZERO");
        require(packet.recipient != address(0), "RECIPIENT_ZERO");
        require(packet.asset != address(0), "ASSET_ZERO");
        require(packet.amount > 0, "AMOUNT_ZERO");
        require(
            packet.action == PacketLib.ACTION_LOCK_MINT || packet.action == PacketLib.ACTION_BURN_UNLOCK,
            "BAD_ACTION"
        );

        packetId = PacketLib.packetIdCalldata(packet);
        require(!committedPacket[packetId], "PACKET_EXISTS");

        bytes32 leaf = PacketLib.leafHashCalldata(packet);
        bytes32 path = IBCPathLib.packetCommitmentPath(packet.sourceChainId, packet.sourcePort, packet.sequence);
        bytes32 previousAccumulator = packetAccumulatorAt[packetSequence];
        packetSequence = packet.sequence;
        bytes32 accumulator = keccak256(abi.encodePacked(previousAccumulator, packet.sequence, leaf));

        packetLeafAt[packet.sequence] = leaf;
        packetPathAt[packet.sequence] = path;
        packetIdAt[packet.sequence] = packetId;
        packetAccumulatorAt[packet.sequence] = accumulator;
        committedPacket[packetId] = true;

        emit PacketCommitted(
            packetId,
            packet.sequence,
            packet.destinationChainId,
            packet.sourcePort,
            packet.destinationPort,
            packet.sender,
            packet.recipient,
            packet.asset,
            packet.amount,
            packet.action,
            leaf,
            accumulator
        );
    }
}
