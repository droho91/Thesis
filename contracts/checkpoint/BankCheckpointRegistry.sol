// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {MessageBus} from "../bridge/MessageBus.sol";
import {BankValidatorSetRegistry} from "./BankValidatorSetRegistry.sol";

/// @title BankCheckpointRegistry
/// @notice Source-chain canonical checkpoint producer for a permissioned bank EVM chain.
/// @dev Relayers may trigger production, but the checkpoint content comes from source-chain
///      message commitments and the active source validator epoch.
contract BankCheckpointRegistry is AccessControl {
    bytes32 public constant CHECKPOINT_PRODUCER_ROLE = keccak256("CHECKPOINT_PRODUCER_ROLE");
    bytes32 public constant CHECKPOINT_TYPEHASH = keccak256("BankChain.FinalizedCheckpoint.v4");
    bytes32 public constant SOURCE_COMMITMENT_TYPEHASH = keccak256("BankChain.SourceCheckpointCommitment.v3");

    struct SourceCheckpoint {
        uint256 sourceChainId;
        address sourceCheckpointRegistry;
        address sourceMessageBus;
        address sourceValidatorSetRegistry;
        uint256 validatorEpochId;
        bytes32 validatorEpochHash;
        uint256 sequence;
        bytes32 parentCheckpointHash;
        bytes32 messageRoot;
        uint256 firstMessageSequence;
        uint256 lastMessageSequence;
        uint256 messageCount;
        bytes32 messageAccumulator;
        uint256 sourceBlockNumber;
        bytes32 sourceBlockHash;
        uint256 timestamp;
        bytes32 sourceCommitmentHash;
        bytes32 checkpointHash;
    }

    uint256 public immutable sourceChainId;
    MessageBus public immutable messageBus;
    BankValidatorSetRegistry public immutable validatorSetRegistry;

    uint256 public checkpointSequence;
    uint256 public lastCommittedMessageSequence;
    uint256 public latestSourceBlockNumber;
    bytes32 public latestCheckpointHash;

    mapping(uint256 => SourceCheckpoint) public checkpointsBySequence;
    mapping(uint256 => bytes32) public messageRootBySequence;
    mapping(uint256 => uint256) public sourceBlockNumberBySequence;
    mapping(uint256 => bytes32) public sourceBlockHashBySequence;
    mapping(bytes32 => bool) public canonicalCheckpointHash;

    event SourceCheckpointCommitted(
        uint256 indexed sequence,
        uint256 indexed validatorEpochId,
        bytes32 indexed checkpointHash,
        bytes32 parentCheckpointHash,
        bytes32 messageRoot,
        uint256 firstMessageSequence,
        uint256 lastMessageSequence,
        uint256 messageCount,
        bytes32 messageAccumulator,
        uint256 sourceBlockNumber,
        bytes32 sourceBlockHash,
        bytes32 validatorEpochHash,
        bytes32 sourceCommitmentHash
    );

    constructor(uint256 _sourceChainId, address _messageBus, address _validatorSetRegistry) {
        require(_sourceChainId != 0, "CHAIN_ID_ZERO");
        require(_messageBus != address(0), "MESSAGE_BUS_ZERO");
        require(_validatorSetRegistry != address(0), "VALIDATOR_REGISTRY_ZERO");
        require(MessageBus(_messageBus).localChainId() == _sourceChainId, "BUS_CHAIN_MISMATCH");
        require(
            BankValidatorSetRegistry(_validatorSetRegistry).sourceChainId() == _sourceChainId,
            "VALIDATOR_CHAIN_MISMATCH"
        );

        sourceChainId = _sourceChainId;
        messageBus = MessageBus(_messageBus);
        validatorSetRegistry = BankValidatorSetRegistry(_validatorSetRegistry);

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(CHECKPOINT_PRODUCER_ROLE, msg.sender);
    }

    function commitCheckpoint(uint256 uptoMessageSequence)
        external
        onlyRole(CHECKPOINT_PRODUCER_ROLE)
        returns (SourceCheckpoint memory checkpoint)
    {
        require(uptoMessageSequence <= messageBus.messageSequence(), "MESSAGE_NOT_DISPATCHED");
        uint256 firstMessageSequence = lastCommittedMessageSequence + 1;
        require(uptoMessageSequence >= firstMessageSequence, "NO_NEW_MESSAGES");

        uint256 messageCount = uptoMessageSequence - firstMessageSequence + 1;
        bytes32[] memory leaves = new bytes32[](messageCount);
        for (uint256 i = 0; i < messageCount; i++) {
            bytes32 leaf = messageBus.messageLeafAt(firstMessageSequence + i);
            require(leaf != bytes32(0), "MESSAGE_LEAF_MISSING");
            leaves[i] = leaf;
        }

        (
            uint256 validatorEpochId,
            uint256 totalVotingPower,
            bytes32 validatorEpochHash,
            uint256 quorumNumerator,
            uint256 quorumDenominator,

        ) = validatorSetRegistry.activeValidatorEpoch();
        require(validatorEpochId != 0, "VALIDATOR_EPOCH_ZERO");
        require(totalVotingPower > 0, "VALIDATOR_EPOCH_EMPTY");
        require(validatorEpochHash != bytes32(0), "VALIDATOR_EPOCH_HASH_ZERO");
        require(quorumNumerator == 2 && quorumDenominator == 3, "UNSUPPORTED_QUORUM");

        bytes32 messageRoot = merkleRoot(leaves);
        uint256 nextSequence = checkpointSequence + 1;
        bytes32 parentCheckpointHash = latestCheckpointHash;
        bytes32 messageAccumulator = messageBus.messageAccumulatorAt(uptoMessageSequence);
        uint256 sourceBlockNumber = block.number > 0 ? block.number - 1 : 0;
        bytes32 sourceBlockHash = blockhash(sourceBlockNumber);
        if (sourceBlockHash == bytes32(0)) {
            sourceBlockHash = keccak256(
                abi.encodePacked(
                    "LOCAL_SOURCE_CHECKPOINT_ANCHOR",
                    block.chainid,
                    address(this),
                    nextSequence,
                    parentCheckpointHash,
                    sourceBlockNumber
                )
            );
        }
        require(sourceBlockNumber >= latestSourceBlockNumber, "SOURCE_BLOCK_REGRESSION");
        uint256 timestamp = block.timestamp;

        checkpoint = SourceCheckpoint({
            sourceChainId: sourceChainId,
            sourceCheckpointRegistry: address(this),
            sourceMessageBus: address(messageBus),
            sourceValidatorSetRegistry: address(validatorSetRegistry),
            validatorEpochId: validatorEpochId,
            validatorEpochHash: validatorEpochHash,
            sequence: nextSequence,
            parentCheckpointHash: parentCheckpointHash,
            messageRoot: messageRoot,
            firstMessageSequence: firstMessageSequence,
            lastMessageSequence: uptoMessageSequence,
            messageCount: messageCount,
            messageAccumulator: messageAccumulator,
            sourceBlockNumber: sourceBlockNumber,
            sourceBlockHash: sourceBlockHash,
            timestamp: timestamp,
            sourceCommitmentHash: bytes32(0),
            checkpointHash: bytes32(0)
        });
        checkpoint.sourceCommitmentHash = hashSourceCommitment(checkpoint);
        checkpoint.checkpointHash = hashCheckpoint(checkpoint);

        checkpointSequence = nextSequence;
        lastCommittedMessageSequence = uptoMessageSequence;
        latestSourceBlockNumber = sourceBlockNumber;
        latestCheckpointHash = checkpoint.checkpointHash;
        checkpointsBySequence[nextSequence] = checkpoint;
        messageRootBySequence[nextSequence] = messageRoot;
        sourceBlockNumberBySequence[nextSequence] = sourceBlockNumber;
        sourceBlockHashBySequence[nextSequence] = sourceBlockHash;
        canonicalCheckpointHash[checkpoint.checkpointHash] = true;

        emit SourceCheckpointCommitted(
            nextSequence,
            validatorEpochId,
            checkpoint.checkpointHash,
            parentCheckpointHash,
            messageRoot,
            firstMessageSequence,
            uptoMessageSequence,
            messageCount,
            messageAccumulator,
            sourceBlockNumber,
            sourceBlockHash,
            validatorEpochHash,
            checkpoint.sourceCommitmentHash
        );
    }

    function hashSourceCommitment(SourceCheckpoint memory checkpoint) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                SOURCE_COMMITMENT_TYPEHASH,
                checkpoint.sourceChainId,
                checkpoint.sourceCheckpointRegistry,
                checkpoint.sourceMessageBus,
                checkpoint.sourceValidatorSetRegistry,
                checkpoint.validatorEpochId,
                checkpoint.validatorEpochHash,
                checkpoint.sequence,
                checkpoint.parentCheckpointHash,
                checkpoint.messageRoot,
                checkpoint.firstMessageSequence,
                checkpoint.lastMessageSequence,
                checkpoint.messageCount,
                checkpoint.messageAccumulator,
                checkpoint.sourceBlockNumber,
                checkpoint.sourceBlockHash,
                checkpoint.timestamp
            )
        );
    }

    function hashCheckpoint(SourceCheckpoint memory checkpoint) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CHECKPOINT_TYPEHASH,
                checkpoint.sourceChainId,
                checkpoint.sourceCheckpointRegistry,
                checkpoint.sourceMessageBus,
                checkpoint.sourceValidatorSetRegistry,
                checkpoint.validatorEpochId,
                checkpoint.validatorEpochHash,
                checkpoint.sequence,
                checkpoint.parentCheckpointHash,
                checkpoint.messageRoot,
                checkpoint.firstMessageSequence,
                checkpoint.lastMessageSequence,
                checkpoint.messageCount,
                checkpoint.messageAccumulator,
                checkpoint.sourceBlockNumber,
                checkpoint.sourceBlockHash,
                checkpoint.timestamp,
                checkpoint.sourceCommitmentHash
            )
        );
    }

    function merkleRoot(bytes32[] memory leaves) public pure returns (bytes32) {
        require(leaves.length > 0, "LEAVES_EMPTY");
        uint256 levelLength = leaves.length;
        while (levelLength > 1) {
            uint256 nextLength = (levelLength + 1) / 2;
            for (uint256 i = 0; i < nextLength; i++) {
                uint256 leftIndex = i * 2;
                bytes32 left = leaves[leftIndex];
                bytes32 right = leftIndex + 1 < levelLength ? leaves[leftIndex + 1] : left;
                leaves[i] = keccak256(abi.encodePacked(left, right));
            }
            levelLength = nextLength;
        }
        return leaves[0];
    }
}
