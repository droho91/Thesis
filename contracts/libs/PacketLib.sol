// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title PacketLib
/// @notice Deterministic packet encoding for the IBC-lite packet commitment path.
library PacketLib {
    uint8 internal constant ACTION_LOCK_MINT = 1;
    uint8 internal constant ACTION_BURN_UNLOCK = 2;

    bytes32 internal constant PACKET_TYPEHASH = keccak256("IBCLite.Packet.v1");
    bytes32 internal constant PACKET_LEAF_TYPEHASH = keccak256("IBCLite.PacketLeaf.v1");

    struct Packet {
        uint256 sequence;
        uint256 sourceChainId;
        uint256 destinationChainId;
        address sourcePort;
        address destinationPort;
        address sender;
        address recipient;
        address asset;
        uint256 amount;
        uint8 action;
        bytes32 memo;
    }

    function packetId(Packet memory packet) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                PACKET_TYPEHASH,
                packet.sequence,
                packet.sourceChainId,
                packet.destinationChainId,
                packet.sourcePort,
                packet.destinationPort,
                packet.sender,
                packet.recipient,
                packet.asset,
                packet.amount,
                packet.action,
                packet.memo
            )
        );
    }

    function packetIdCalldata(Packet calldata packet) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                PACKET_TYPEHASH,
                packet.sequence,
                packet.sourceChainId,
                packet.destinationChainId,
                packet.sourcePort,
                packet.destinationPort,
                packet.sender,
                packet.recipient,
                packet.asset,
                packet.amount,
                packet.action,
                packet.memo
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
}
