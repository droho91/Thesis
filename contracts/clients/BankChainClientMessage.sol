// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CommitmentLib} from "../libs/CommitmentLib.sol";

/// @title BankChainClientMessage
/// @notice QBFT/IBFT-like finalized header messages accepted by the bank-chain client.
library BankChainClientMessage {
    struct Header {
        uint256 sourceChainId;
        address sourceHeaderProducer;
        address sourcePacketCommitment;
        address sourceValidatorSetRegistry;
        uint256 validatorEpochId;
        bytes32 validatorEpochHash;
        uint256 height;
        bytes32 parentHash;
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
        bytes32 blockHash;
    }

    struct ClientMessage {
        Header header;
    }

    function headerHash(Header memory header) internal pure returns (bytes32) {
        bytes32 endpointHash = keccak256(
            abi.encode(
                header.sourceChainId,
                header.sourceHeaderProducer,
                header.sourcePacketCommitment,
                header.sourceValidatorSetRegistry
            )
        );
        bytes32 validatorHash =
            keccak256(abi.encode(header.validatorEpochId, header.validatorEpochHash));
        bytes32 packetHash = keccak256(
            abi.encode(
                header.packetRoot,
                header.stateRoot,
                header.executionStateRoot,
                header.firstPacketSequence,
                header.lastPacketSequence,
                header.packetCount,
                header.packetAccumulator
            )
        );
        bytes32 anchorHash =
            keccak256(abi.encode(header.sourceBlockNumber, header.sourceBlockHash, header.round, header.timestamp));
        return keccak256(
            abi.encode(
                CommitmentLib.QBFT_HEADER_TYPEHASH,
                endpointHash,
                validatorHash,
                header.height,
                header.parentHash,
                packetHash,
                anchorHash
            )
        );
    }

    function headerHashCalldata(Header calldata header) internal pure returns (bytes32) {
        bytes32 endpointHash = keccak256(
            abi.encode(
                header.sourceChainId,
                header.sourceHeaderProducer,
                header.sourcePacketCommitment,
                header.sourceValidatorSetRegistry
            )
        );
        bytes32 validatorHash =
            keccak256(abi.encode(header.validatorEpochId, header.validatorEpochHash));
        bytes32 packetHash = keccak256(
            abi.encode(
                header.packetRoot,
                header.stateRoot,
                header.executionStateRoot,
                header.firstPacketSequence,
                header.lastPacketSequence,
                header.packetCount,
                header.packetAccumulator
            )
        );
        bytes32 anchorHash =
            keccak256(abi.encode(header.sourceBlockNumber, header.sourceBlockHash, header.round, header.timestamp));
        return keccak256(
            abi.encode(
                CommitmentLib.QBFT_HEADER_TYPEHASH,
                endpointHash,
                validatorHash,
                header.height,
                header.parentHash,
                packetHash,
                anchorHash
            )
        );
    }

    function commitDigest(Header memory header) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CommitmentLib.QBFT_COMMIT_TYPEHASH,
                header.sourceChainId,
                header.height,
                header.blockHash,
                header.round,
                header.validatorEpochId,
                header.validatorEpochHash
            )
        );
    }

    function commitDigestCalldata(Header calldata header) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CommitmentLib.QBFT_COMMIT_TYPEHASH,
                header.sourceChainId,
                header.height,
                header.blockHash,
                header.round,
                header.validatorEpochId,
                header.validatorEpochHash
            )
        );
    }
}
