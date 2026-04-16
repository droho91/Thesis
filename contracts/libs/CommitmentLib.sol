// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title CommitmentLib
/// @notice Hashing constants for source-certified local header artifacts.
library CommitmentLib {
    // Legacy local header-producer constants kept for SourceCheckpointRegistry compatibility.
    bytes32 internal constant SOURCE_COMMITMENT_TYPEHASH =
        keccak256("IBCLite.SourceCheckpointCommitment.v1");
    bytes32 internal constant CHECKPOINT_TYPEHASH = keccak256("IBCLite.FinalizedCheckpoint.v1");
    bytes32 internal constant QBFT_HEADER_TYPEHASH = keccak256("IBCLite.QBFTFinalizedHeader.v2");
    bytes32 internal constant QBFT_COMMIT_TYPEHASH = keccak256("IBCLite.QBFTCommitSeal.v1");
    bytes32 internal constant VALIDATOR_EPOCH_TYPEHASH = keccak256("IBCLite.ValidatorEpoch.v1");
}
