// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IBCMisbehaviour
/// @notice Evidence types for freezing a remote client on conflicting certified updates.
library IBCMisbehaviour {
    bytes32 internal constant CONFLICTING_CONSENSUS_TYPEHASH =
        keccak256("IBCLite.ConflictingConsensus.v1");

    struct Evidence {
        uint256 sourceChainId;
        uint256 sequence;
        bytes32 trustedConsensusStateHash;
        bytes32 conflictingConsensusStateHash;
        bytes32 evidenceHash;
        uint256 detectedAt;
        bool exists;
    }

    function hashEvidence(
        uint256 sourceChainId,
        uint256 sequence,
        bytes32 trustedConsensusStateHash,
        bytes32 conflictingConsensusStateHash
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CONFLICTING_CONSENSUS_TYPEHASH,
                sourceChainId,
                sequence,
                trustedConsensusStateHash,
                conflictingConsensusStateHash
            )
        );
    }
}
