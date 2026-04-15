// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title CommitmentLib
/// @notice Hashing constants for source-certified checkpoint artifacts.
library CommitmentLib {
    bytes32 internal constant SOURCE_COMMITMENT_TYPEHASH =
        keccak256("IBCLite.SourceCheckpointCommitment.v1");
    bytes32 internal constant CHECKPOINT_TYPEHASH = keccak256("IBCLite.FinalizedCheckpoint.v1");
    bytes32 internal constant VALIDATOR_EPOCH_TYPEHASH = keccak256("IBCLite.ValidatorEpoch.v1");
}
