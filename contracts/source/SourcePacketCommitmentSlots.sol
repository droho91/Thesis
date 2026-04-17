// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title SourcePacketCommitmentSlots
/// @notice Storage-slot helpers for `SourcePacketCommitment`.
/// @dev These constants intentionally mirror the current Solidity storage layout of
///      `SourcePacketCommitment`. Because the contract inherits `AccessControl`,
///      slot `0` is occupied by the inherited `_roles` mapping before the
///      packet commitment fields begin. If that contract reorders state variables
///      or changes inheritance, these slot derivations must be updated as well.
library SourcePacketCommitmentSlots {
    uint256 internal constant ACCESS_CONTROL_ROLES_SLOT = 0;
    uint256 internal constant PACKET_SEQUENCE_SLOT = 1;
    uint256 internal constant PACKET_LEAF_AT_SLOT = 2;
    uint256 internal constant PACKET_PATH_AT_SLOT = 3;
    uint256 internal constant PACKET_ID_AT_SLOT = 4;
    uint256 internal constant PACKET_ACCUMULATOR_AT_SLOT = 5;
    uint256 internal constant COMMITTED_PACKET_SLOT = 6;

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
