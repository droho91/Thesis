// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {MessageBus} from "../bridge/MessageBus.sol";

/// @title BankCheckpointRegistry
/// @notice Source-chain checkpoint producer for a permissioned bank EVM chain.
/// @dev This contract turns source MessageBus progression into canonical checkpoint objects.
///      Validators sign checkpoints emitted here; relayers only transport them.
contract BankCheckpointRegistry is AccessControl {
    bytes32 public constant CHECKPOINT_PRODUCER_ROLE = keccak256("CHECKPOINT_PRODUCER_ROLE");
    bytes32 public constant VALIDATOR_SET_ADMIN_ROLE = keccak256("VALIDATOR_SET_ADMIN_ROLE");
    bytes32 public constant CHECKPOINT_TYPEHASH = keccak256("BankChain.FinalizedCheckpoint.v2");
    bytes32 public constant SOURCE_COMMITMENT_TYPEHASH = keccak256("BankChain.SourceCheckpointCommitment.v1");

    struct SourceCheckpoint {
        uint256 sourceChainId;
        uint256 validatorSetId;
        uint256 sequence;
        bytes32 parentCheckpointHash;
        bytes32 messageRoot;
        uint256 firstMessageSequence;
        uint256 lastMessageSequence;
        uint256 messageCount;
        bytes32 sourceCommitmentHash;
        uint256 timestamp;
        bytes32 checkpointHash;
    }

    uint256 public immutable sourceChainId;
    MessageBus public immutable messageBus;

    uint256 public activeValidatorSetId;
    uint256 public checkpointSequence;
    uint256 public lastCommittedMessageSequence;
    bytes32 public latestCheckpointHash;

    mapping(uint256 => SourceCheckpoint) public checkpointsBySequence;
    mapping(bytes32 => bool) public canonicalCheckpointHash;

    event SourceCheckpointCommitted(
        uint256 indexed sequence,
        uint256 indexed validatorSetId,
        bytes32 indexed checkpointHash,
        bytes32 parentCheckpointHash,
        bytes32 messageRoot,
        uint256 firstMessageSequence,
        uint256 lastMessageSequence,
        uint256 messageCount,
        bytes32 sourceCommitmentHash
    );
    event ActiveValidatorSetRotated(uint256 indexed oldValidatorSetId, uint256 indexed newValidatorSetId);

    constructor(uint256 _sourceChainId, address _messageBus, uint256 _initialValidatorSetId) {
        require(_sourceChainId != 0, "CHAIN_ID_ZERO");
        require(_messageBus != address(0), "MESSAGE_BUS_ZERO");
        require(_initialValidatorSetId != 0, "VALIDATOR_SET_ZERO");
        require(MessageBus(_messageBus).localChainId() == _sourceChainId, "BUS_CHAIN_MISMATCH");

        sourceChainId = _sourceChainId;
        messageBus = MessageBus(_messageBus);
        activeValidatorSetId = _initialValidatorSetId;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(CHECKPOINT_PRODUCER_ROLE, msg.sender);
        _grantRole(VALIDATOR_SET_ADMIN_ROLE, msg.sender);
    }

    function rotateValidatorSet(uint256 newValidatorSetId) external onlyRole(VALIDATOR_SET_ADMIN_ROLE) {
        require(newValidatorSetId != 0, "VALIDATOR_SET_ZERO");
        require(newValidatorSetId > activeValidatorSetId, "VALIDATOR_SET_NOT_FORWARD");
        uint256 oldValidatorSetId = activeValidatorSetId;
        activeValidatorSetId = newValidatorSetId;
        emit ActiveValidatorSetRotated(oldValidatorSetId, newValidatorSetId);
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

        bytes32 messageRoot = merkleRoot(leaves);
        uint256 nextSequence = checkpointSequence + 1;
        bytes32 parentCheckpointHash = latestCheckpointHash;
        uint256 timestamp = block.timestamp;
        bytes32 sourceCommitmentHash = keccak256(
            abi.encode(
                SOURCE_COMMITMENT_TYPEHASH,
                sourceChainId,
                address(this),
                address(messageBus),
                nextSequence,
                parentCheckpointHash,
                messageRoot,
                firstMessageSequence,
                uptoMessageSequence,
                messageCount,
                messageBus.messageAccumulatorAt(uptoMessageSequence),
                block.number,
                timestamp
            )
        );

        bytes32 checkpointHash = hashCheckpoint(
            sourceChainId,
            activeValidatorSetId,
            nextSequence,
            parentCheckpointHash,
            messageRoot,
            firstMessageSequence,
            uptoMessageSequence,
            messageCount,
            sourceCommitmentHash,
            timestamp
        );

        checkpoint = SourceCheckpoint({
            sourceChainId: sourceChainId,
            validatorSetId: activeValidatorSetId,
            sequence: nextSequence,
            parentCheckpointHash: parentCheckpointHash,
            messageRoot: messageRoot,
            firstMessageSequence: firstMessageSequence,
            lastMessageSequence: uptoMessageSequence,
            messageCount: messageCount,
            sourceCommitmentHash: sourceCommitmentHash,
            timestamp: timestamp,
            checkpointHash: checkpointHash
        });

        checkpointSequence = nextSequence;
        lastCommittedMessageSequence = uptoMessageSequence;
        latestCheckpointHash = checkpointHash;
        checkpointsBySequence[nextSequence] = checkpoint;
        canonicalCheckpointHash[checkpointHash] = true;

        emit SourceCheckpointCommitted(
            nextSequence,
            activeValidatorSetId,
            checkpointHash,
            parentCheckpointHash,
            messageRoot,
            firstMessageSequence,
            uptoMessageSequence,
            messageCount,
            sourceCommitmentHash
        );
    }

    function hashCheckpoint(
        uint256 _sourceChainId,
        uint256 validatorSetId,
        uint256 sequence,
        bytes32 parentCheckpointHash,
        bytes32 messageRoot,
        uint256 firstMessageSequence,
        uint256 lastMessageSequence,
        uint256 messageCount,
        bytes32 sourceCommitmentHash,
        uint256 timestamp
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CHECKPOINT_TYPEHASH,
                _sourceChainId,
                validatorSetId,
                sequence,
                parentCheckpointHash,
                messageRoot,
                firstMessageSequence,
                lastMessageSequence,
                messageCount,
                sourceCommitmentHash,
                timestamp
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
