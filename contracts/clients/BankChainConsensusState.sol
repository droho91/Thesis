// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title BankChainConsensusState
/// @notice Stored consensus state derived from a source-certified packet checkpoint.
library BankChainConsensusState {
    struct ConsensusState {
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
        bytes32 consensusStateHash;
        bool exists;
    }
}
