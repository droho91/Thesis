// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {CommitmentLib} from "../libs/CommitmentLib.sol";
import {MerkleLib} from "../libs/MerkleLib.sol";
import {SourcePacketCommitment} from "./SourcePacketCommitment.sol";
import {SourceValidatorEpochRegistry} from "./SourceValidatorEpochRegistry.sol";

/// @title SourceCheckpointRegistry
/// @notice Source-chain producer of finalized packet commitment checkpoints.
contract SourceCheckpointRegistry is AccessControl {
    bytes32 public constant CHECKPOINT_PRODUCER_ROLE = keccak256("CHECKPOINT_PRODUCER_ROLE");

    struct SourceCheckpoint {
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
        bytes32 checkpointHash;
    }

    uint256 public immutable sourceChainId;
    SourcePacketCommitment public immutable packetCommitment;
    SourceValidatorEpochRegistry public immutable validatorSetRegistry;

    uint256 public checkpointSequence;
    uint256 public lastCommittedPacketSequence;
    uint256 public latestSourceBlockNumber;
    bytes32 public latestCheckpointHash;

    mapping(uint256 => SourceCheckpoint) public checkpointsBySequence;
    mapping(uint256 => bytes32) public packetRootBySequence;
    mapping(uint256 => uint256) public sourceBlockNumberBySequence;
    mapping(uint256 => bytes32) public sourceBlockHashBySequence;
    mapping(bytes32 => bool) public canonicalCheckpointHash;

    event SourceCheckpointCommitted(
        uint256 indexed sequence,
        uint256 indexed validatorEpochId,
        bytes32 indexed checkpointHash,
        bytes32 parentCheckpointHash,
        bytes32 packetRoot,
        uint256 firstPacketSequence,
        uint256 lastPacketSequence,
        uint256 packetCount,
        bytes32 packetAccumulator,
        uint256 sourceBlockNumber,
        bytes32 sourceBlockHash,
        bytes32 validatorEpochHash,
        bytes32 sourceCommitmentHash
    );

    constructor(uint256 _sourceChainId, address _packetCommitment, address _validatorSetRegistry) {
        require(_sourceChainId != 0, "CHAIN_ID_ZERO");
        require(_packetCommitment != address(0), "PACKET_COMMITMENT_ZERO");
        require(_validatorSetRegistry != address(0), "VALIDATOR_REGISTRY_ZERO");
        require(SourcePacketCommitment(_packetCommitment).localChainId() == _sourceChainId, "PACKET_CHAIN_MISMATCH");
        require(
            SourceValidatorEpochRegistry(_validatorSetRegistry).sourceChainId() == _sourceChainId,
            "VALIDATOR_CHAIN_MISMATCH"
        );

        sourceChainId = _sourceChainId;
        packetCommitment = SourcePacketCommitment(_packetCommitment);
        validatorSetRegistry = SourceValidatorEpochRegistry(_validatorSetRegistry);

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(CHECKPOINT_PRODUCER_ROLE, msg.sender);
    }

    function commitCheckpoint(uint256 uptoPacketSequence)
        external
        onlyRole(CHECKPOINT_PRODUCER_ROLE)
        returns (SourceCheckpoint memory checkpoint)
    {
        require(uptoPacketSequence <= packetCommitment.packetSequence(), "PACKET_NOT_COMMITTED");
        uint256 firstPacketSequence = lastCommittedPacketSequence + 1;
        require(uptoPacketSequence >= firstPacketSequence, "NO_NEW_PACKETS");

        uint256 packetCount = uptoPacketSequence - firstPacketSequence + 1;
        bytes32[] memory leaves = new bytes32[](packetCount);
        for (uint256 i = 0; i < packetCount; i++) {
            bytes32 leaf = packetCommitment.packetLeafAt(firstPacketSequence + i);
            require(leaf != bytes32(0), "PACKET_LEAF_MISSING");
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

        bytes32 packetRoot = MerkleLib.root(leaves);
        uint256 nextCheckpointSequence = checkpointSequence + 1;
        bytes32 parentCheckpointHash = latestCheckpointHash;
        bytes32 packetAccumulator = packetCommitment.packetAccumulatorAt(uptoPacketSequence);
        uint256 sourceBlockNumber = block.number > 0 ? block.number - 1 : 0;
        bytes32 sourceBlockHash = blockhash(sourceBlockNumber);
        if (sourceBlockHash == bytes32(0)) {
            sourceBlockHash = keccak256(
                abi.encodePacked(
                    "LOCAL_IBC_LITE_CHECKPOINT_ANCHOR",
                    block.chainid,
                    address(this),
                    nextCheckpointSequence,
                    parentCheckpointHash,
                    sourceBlockNumber
                )
            );
        }
        require(sourceBlockNumber >= latestSourceBlockNumber, "SOURCE_BLOCK_REGRESSION");

        checkpoint = SourceCheckpoint({
            sourceChainId: sourceChainId,
            sourceCheckpointRegistry: address(this),
            sourcePacketCommitment: address(packetCommitment),
            sourceValidatorSetRegistry: address(validatorSetRegistry),
            validatorEpochId: validatorEpochId,
            validatorEpochHash: validatorEpochHash,
            sequence: nextCheckpointSequence,
            parentCheckpointHash: parentCheckpointHash,
            packetRoot: packetRoot,
            firstPacketSequence: firstPacketSequence,
            lastPacketSequence: uptoPacketSequence,
            packetCount: packetCount,
            packetAccumulator: packetAccumulator,
            sourceBlockNumber: sourceBlockNumber,
            sourceBlockHash: sourceBlockHash,
            timestamp: block.timestamp,
            sourceCommitmentHash: bytes32(0),
            checkpointHash: bytes32(0)
        });
        checkpoint.sourceCommitmentHash = hashSourceCommitment(checkpoint);
        checkpoint.checkpointHash = hashCheckpoint(checkpoint);

        checkpointSequence = nextCheckpointSequence;
        lastCommittedPacketSequence = uptoPacketSequence;
        latestSourceBlockNumber = sourceBlockNumber;
        latestCheckpointHash = checkpoint.checkpointHash;
        checkpointsBySequence[nextCheckpointSequence] = checkpoint;
        packetRootBySequence[nextCheckpointSequence] = packetRoot;
        sourceBlockNumberBySequence[nextCheckpointSequence] = sourceBlockNumber;
        sourceBlockHashBySequence[nextCheckpointSequence] = sourceBlockHash;
        canonicalCheckpointHash[checkpoint.checkpointHash] = true;

        emit SourceCheckpointCommitted(
            nextCheckpointSequence,
            validatorEpochId,
            checkpoint.checkpointHash,
            parentCheckpointHash,
            packetRoot,
            firstPacketSequence,
            uptoPacketSequence,
            packetCount,
            packetAccumulator,
            sourceBlockNumber,
            sourceBlockHash,
            validatorEpochHash,
            checkpoint.sourceCommitmentHash
        );
    }

    function hashSourceCommitment(SourceCheckpoint memory checkpoint) public pure returns (bytes32) {
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

    function hashCheckpoint(SourceCheckpoint memory checkpoint) public pure returns (bytes32) {
        return keccak256(abi.encode(CommitmentLib.CHECKPOINT_TYPEHASH, checkpoint.sourceCommitmentHash));
    }
}
