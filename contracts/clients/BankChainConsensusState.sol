// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title BankChainConsensusState
/// @notice Stored consensus state derived from a finalized QBFT/IBFT-like source header.
library BankChainConsensusState {
    struct ConsensusState {
        uint256 sourceChainId;
        address sourceHeaderProducer;
        address sourcePacketCommitment;
        address sourceValidatorSetRegistry;
        uint256 validatorEpochId;
        bytes32 validatorEpochHash;
        uint256 height;
        bytes32 parentHash;
        bytes32 blockHash;
        bytes32 packetRoot;
        bytes32 stateRoot;
        bytes32 executionStateRoot;
        uint256 firstPacketSequence;
        uint256 lastPacketSequence;
        uint256 packetCount;
        bytes32 packetAccumulator;
        uint256 sourceBlockNumber;
        bytes32 sourceBlockHash;
        uint64 round;
        uint256 timestamp;
        bytes32 consensusStateHash;
        bool exists;
    }
}
