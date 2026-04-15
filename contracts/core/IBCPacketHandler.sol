// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCClientTypes} from "./IBCClientTypes.sol";
import {IBCProofVerifier} from "./IBCProofVerifier.sol";
import {PacketLib} from "../libs/PacketLib.sol";

interface IBCPacketReceiver {
    function onRecvPacket(PacketLib.Packet calldata packet, bytes32 packetId) external;
}

/// @title IBCPacketHandler
/// @notice Verifies remote packet membership and enforces one-time packet execution.
contract IBCPacketHandler is IBCProofVerifier {
    uint256 public immutable localChainId;
    mapping(bytes32 => bool) public consumedPackets;

    event PacketMembershipVerified(
        bytes32 indexed packetId,
        uint256 indexed sourceChainId,
        bytes32 indexed consensusStateHash,
        address relayer
    );
    event PacketExecuted(bytes32 indexed packetId, address indexed destinationPort);

    constructor(uint256 _localChainId, address _ibcClient) IBCProofVerifier(_ibcClient) {
        require(_localChainId != 0, "CHAIN_ID_ZERO");
        localChainId = _localChainId;
    }

    function recvPacket(PacketLib.Packet calldata packet, IBCClientTypes.MembershipProof calldata proof)
        external
        returns (bytes32 packetId)
    {
        require(packet.destinationChainId == localChainId, "WRONG_DESTINATION_CHAIN");
        require(packet.destinationPort != address(0), "DESTINATION_PORT_ZERO");
        require(_verifyPacketMembership(packet, proof), "INVALID_PACKET_PROOF");

        packetId = PacketLib.packetIdCalldata(packet);
        require(!consumedPackets[packetId], "PACKET_ALREADY_CONSUMED");
        consumedPackets[packetId] = true;

        emit PacketMembershipVerified(packetId, packet.sourceChainId, proof.consensusStateHash, msg.sender);
        IBCPacketReceiver(packet.destinationPort).onRecvPacket(packet, packetId);
        emit PacketExecuted(packetId, packet.destinationPort);
    }
}
