// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IBCPathLib
/// @notice Path helpers for packet commitment keys in the local simulation.
library IBCPathLib {
    bytes32 internal constant PACKET_COMMITMENT_PATH_TYPEHASH =
        keccak256("IBCLite.PacketCommitmentPath.v1");
    bytes32 internal constant PACKET_ABSENCE_PATH_TYPEHASH =
        keccak256("IBCLite.PacketCommitmentAbsencePath.v1");

    function packetCommitmentPath(uint256 sourceChainId, address sourcePort, uint256 sequence)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(PACKET_COMMITMENT_PATH_TYPEHASH, sourceChainId, sourcePort, sequence));
    }

    function packetAbsencePath(uint256 sourceChainId, address sourcePort, uint256 sequence, bytes32 absentLeaf)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(PACKET_ABSENCE_PATH_TYPEHASH, sourceChainId, sourcePort, sequence, absentLeaf)
        );
    }
}
