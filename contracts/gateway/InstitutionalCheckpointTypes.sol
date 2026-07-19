// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title InstitutionalCheckpointTypes
/// @notice Shared types for quorum-attested source-chain checkpoints.
library InstitutionalCheckpointTypes {
    enum ClientStatus {
        Uninitialized,
        Active,
        Frozen
    }

    struct Checkpoint {
        uint256 sourceChainId;
        uint256 blockNumber;
        bytes32 blockHash;
        bytes32 stateRoot;
        uint256 timestamp;
        uint64 attestorEpoch;
    }

    struct TrustedCheckpoint {
        bytes32 blockHash;
        bytes32 stateRoot;
        uint256 timestamp;
        uint64 attestorEpoch;
        bool exists;
    }

    struct ConflictEvidence {
        uint256 blockNumber;
        bytes32 trustedDigest;
        bytes32 conflictingDigest;
        uint256 detectedAt;
    }
}
