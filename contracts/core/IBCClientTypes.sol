// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IBCClientTypes
/// @notice Shared client and proof types for the IBC-lite core.
library IBCClientTypes {
    enum Status {
        Uninitialized,
        Active,
        Frozen,
        Recovering
    }

    struct MembershipProof {
        bytes32 consensusStateHash;
        uint256 leafIndex;
        bytes32[] siblings;
    }

    struct NonMembershipProof {
        uint256 sequence;
        uint256 leafIndex;
        bytes32 witnessedValue;
        bytes32[] siblings;
    }
}
