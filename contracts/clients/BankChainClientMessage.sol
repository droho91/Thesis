// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CommitmentLib} from "../libs/CommitmentLib.sol";

/// @title BankChainClientMessage
/// @notice Source-certified client update messages accepted by the bank-chain client.
library BankChainClientMessage {
    struct Checkpoint {
        uint256 sourceChainId;
        address sourceCheckpointRegistry;
        address sourcePacketCommitment;
        address sourceValidatorSetRegistry;
        uint256 validatorEpochId;
        bytes32 validatorEpochHash;
        uint256 sequence;
        bytes32 parentCheckpointHash;
        bytes32 packetRoot;
        uint256 firstPacketSequence;
        uint256 lastPacketSequence;
        uint256 packetCount;
        bytes32 packetAccumulator;
        uint256 sourceBlockNumber;
        bytes32 sourceBlockHash;
        uint256 timestamp;
        bytes32 sourceCommitmentHash;
    }

    struct ClientMessage {
        Checkpoint checkpoint;
    }

    function sourceCommitmentHash(Checkpoint memory checkpoint) internal pure returns (bytes32) {
        bytes32 endpointHash = keccak256(
            abi.encode(
                checkpoint.sourceChainId,
                checkpoint.sourceCheckpointRegistry,
                checkpoint.sourcePacketCommitment,
                checkpoint.sourceValidatorSetRegistry
            )
        );
        bytes32 packetRangeHash = keccak256(
            abi.encode(
                checkpoint.packetRoot,
                checkpoint.firstPacketSequence,
                checkpoint.lastPacketSequence,
                checkpoint.packetCount,
                checkpoint.packetAccumulator
            )
        );
        bytes32 sourceAnchorHash = keccak256(
            abi.encode(checkpoint.sourceBlockNumber, checkpoint.sourceBlockHash, checkpoint.timestamp)
        );
        return keccak256(
            abi.encode(
                CommitmentLib.SOURCE_COMMITMENT_TYPEHASH,
                endpointHash,
                checkpoint.validatorEpochId,
                checkpoint.validatorEpochHash,
                checkpoint.sequence,
                checkpoint.parentCheckpointHash,
                packetRangeHash,
                sourceAnchorHash
            )
        );
    }

    function sourceCommitmentHashCalldata(Checkpoint calldata checkpoint) internal pure returns (bytes32) {
        bytes32 endpointHash = keccak256(
            abi.encode(
                checkpoint.sourceChainId,
                checkpoint.sourceCheckpointRegistry,
                checkpoint.sourcePacketCommitment,
                checkpoint.sourceValidatorSetRegistry
            )
        );
        bytes32 packetRangeHash = keccak256(
            abi.encode(
                checkpoint.packetRoot,
                checkpoint.firstPacketSequence,
                checkpoint.lastPacketSequence,
                checkpoint.packetCount,
                checkpoint.packetAccumulator
            )
        );
        bytes32 sourceAnchorHash = keccak256(
            abi.encode(checkpoint.sourceBlockNumber, checkpoint.sourceBlockHash, checkpoint.timestamp)
        );
        return keccak256(
            abi.encode(
                CommitmentLib.SOURCE_COMMITMENT_TYPEHASH,
                endpointHash,
                checkpoint.validatorEpochId,
                checkpoint.validatorEpochHash,
                checkpoint.sequence,
                checkpoint.parentCheckpointHash,
                packetRangeHash,
                sourceAnchorHash
            )
        );
    }

    function checkpointHash(Checkpoint memory checkpoint) internal pure returns (bytes32) {
        return keccak256(abi.encode(CommitmentLib.CHECKPOINT_TYPEHASH, checkpoint.sourceCommitmentHash));
    }

    function checkpointHashCalldata(Checkpoint calldata checkpoint) internal pure returns (bytes32) {
        return keccak256(abi.encode(CommitmentLib.CHECKPOINT_TYPEHASH, checkpoint.sourceCommitmentHash));
    }
}
