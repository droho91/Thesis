// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IBCPacketStoreSlots
/// @notice Storage-slot helpers for the IBC packet commitment store.
/// @dev `localChainId` is immutable and does not occupy a storage slot.
library IBCPacketStoreSlots {
    uint256 internal constant PACKET_SEQUENCE_SLOT = 0;
    uint256 internal constant PACKET_LEAF_AT_SLOT = 1;
    uint256 internal constant PACKET_PATH_AT_SLOT = 2;
    uint256 internal constant PACKET_ID_AT_SLOT = 3;
    uint256 internal constant PACKET_ACCUMULATOR_AT_SLOT = 4;
    uint256 internal constant COMMITTED_PACKET_SLOT = 5;

    function packetLeafAt(uint256 sequence) internal pure returns (bytes32) {
        return keccak256(abi.encode(sequence, PACKET_LEAF_AT_SLOT));
    }

    function packetPathAt(uint256 sequence) internal pure returns (bytes32) {
        return keccak256(abi.encode(sequence, PACKET_PATH_AT_SLOT));
    }

    function packetIdAt(uint256 sequence) internal pure returns (bytes32) {
        return keccak256(abi.encode(sequence, PACKET_ID_AT_SLOT));
    }

    function packetAccumulatorAt(uint256 sequence) internal pure returns (bytes32) {
        return keccak256(abi.encode(sequence, PACKET_ACCUMULATOR_AT_SLOT));
    }

    function committedPacket(bytes32 packetId) internal pure returns (bytes32) {
        return keccak256(abi.encode(packetId, COMMITTED_PACKET_SLOT));
    }
}
