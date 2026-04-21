// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IBCPacketLib
/// @notice Deterministic IBC packet envelope with explicit channel and timeout fields.
library IBCPacketLib {
    uint8 internal constant ACTION_LOCK_MINT = 1;
    uint8 internal constant ACTION_BURN_UNLOCK = 2;

    bytes32 internal constant PACKET_TYPEHASH = keccak256("IBC.Packet");
    bytes32 internal constant PACKET_LEAF_TYPEHASH = keccak256("IBC.PacketLeaf");
    bytes32 internal constant PACKET_COMMITMENT_PATH_TYPEHASH = keccak256("IBC.PacketCommitmentPath");

    struct Endpoint {
        uint256 chainId;
        address port;
        bytes32 channel;
    }

    struct Timeout {
        uint64 height;
        uint64 timestamp;
    }

    struct TransferData {
        address sender;
        address recipient;
        address asset;
        uint256 amount;
        uint8 action;
        bytes32 memo;
    }

    struct Packet {
        uint256 sequence;
        Endpoint source;
        Endpoint destination;
        bytes data;
        Timeout timeout;
    }

    function packetId(Packet memory packet) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                PACKET_TYPEHASH,
                packet.sequence,
                packet.source.chainId,
                packet.destination.chainId,
                packet.source.port,
                packet.destination.port,
                packet.source.channel,
                packet.destination.channel,
                keccak256(packet.data),
                packet.timeout.height,
                packet.timeout.timestamp
            )
        );
    }

    function packetIdCalldata(Packet calldata packet) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                PACKET_TYPEHASH,
                packet.sequence,
                packet.source.chainId,
                packet.destination.chainId,
                packet.source.port,
                packet.destination.port,
                packet.source.channel,
                packet.destination.channel,
                keccak256(packet.data),
                packet.timeout.height,
                packet.timeout.timestamp
            )
        );
    }

    function commitment(Packet memory packet) internal pure returns (bytes32) {
        return packetId(packet);
    }

    function commitmentCalldata(Packet calldata packet) internal pure returns (bytes32) {
        return packetIdCalldata(packet);
    }

    function leafHash(Packet memory packet) internal pure returns (bytes32) {
        return keccak256(abi.encode(PACKET_LEAF_TYPEHASH, commitment(packet)));
    }

    function leafHashCalldata(Packet calldata packet) internal pure returns (bytes32) {
        return keccak256(abi.encode(PACKET_LEAF_TYPEHASH, commitmentCalldata(packet)));
    }

    function commitmentPath(Packet memory packet) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(PACKET_COMMITMENT_PATH_TYPEHASH, packet.source.chainId, packet.source.port, packet.source.channel, packet.sequence)
        );
    }

    function commitmentPathCalldata(Packet calldata packet) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(PACKET_COMMITMENT_PATH_TYPEHASH, packet.source.chainId, packet.source.port, packet.source.channel, packet.sequence)
        );
    }

    function encodeTransferData(TransferData memory transferData) internal pure returns (bytes memory) {
        return abi.encode(transferData);
    }

    function decodeTransferData(bytes calldata data) internal pure returns (TransferData memory transferData) {
        transferData = abi.decode(data, (TransferData));
    }
}
