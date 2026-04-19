// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title BesuLightClientTypes
/// @notice v2 types for a native Besu/QBFT light-client lane.
library BesuLightClientTypes {
    enum ClientStatus {
        Uninitialized,
        Active,
        Frozen,
        Recovering
    }

    /// @notice Raw finalized-header update material. The v2 lane is intentionally built around real
    ///         Besu header artifacts instead of bespoke checkpoint hashes.
    struct HeaderUpdate {
        uint256 sourceChainId;
        uint256 height;
        /// @notice Besu/QBFT seal header RLP. This is the canonical block-hash preimage in Besu QBFT:
        ///         it is identical to the block header except commit seals are empty in extraData.
        bytes rawHeaderRlp;
        /// @notice Besu QBFT block hash, i.e. keccak256(rawHeaderRlp). Child headers reference this.
        bytes32 headerHash;
        bytes32 parentHash;
        bytes32 stateRoot;
        /// @notice Full QBFT extraData from the block, including commit seals.
        bytes extraData;
    }

    /// @notice Parsed QBFT extra-data components.
    /// @dev The genesis/header encoding shape is intentionally explicit so that the implementation cannot
    ///      quietly fall back to the legacy "custom attested digest" model.
    struct ParsedExtraData {
        bytes32 vanity;
        address[] validators;
        bytes vote;
        uint256 round;
        bytes[] commitSeals;
    }

    struct ValidatorSet {
        uint256 epoch;
        uint256 activationHeight;
        address[] validators;
    }

    struct TrustedHeader {
        uint256 sourceChainId;
        uint256 height;
        bytes32 headerHash;
        bytes32 parentHash;
        bytes32 stateRoot;
        uint256 timestamp;
        bytes32 validatorsHash;
        bool exists;
    }

    struct MisbehaviourEvidence {
        uint256 sourceChainId;
        uint256 height;
        bytes32 trustedHeaderHash;
        bytes32 conflictingHeaderHash;
        bytes32 evidenceHash;
        uint256 detectedAt;
    }
}
