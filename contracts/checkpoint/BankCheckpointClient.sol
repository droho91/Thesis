// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title BankCheckpointClient
/// @notice Native-verification-inspired checkpoint client for permissioned bank EVM chains.
/// @dev Relayers are permissionless. Correctness comes from validator quorum signatures and
///      Merkle inclusion against verified checkpoint message roots.
contract BankCheckpointClient is AccessControl {
    bytes32 public constant CHECKPOINT_ADMIN_ROLE = keccak256("CHECKPOINT_ADMIN_ROLE");
    bytes32 public constant CHECKPOINT_TYPEHASH = keccak256("BankChain.FinalizedCheckpoint.v1");

    struct Checkpoint {
        uint256 sourceChainId;
        uint256 validatorSetId;
        uint256 sequence;
        bytes32 parentCheckpointHash;
        bytes32 messageRoot;
        uint256 timestamp;
    }

    struct VerifiedCheckpoint {
        uint256 validatorSetId;
        uint256 sequence;
        bytes32 parentCheckpointHash;
        bytes32 messageRoot;
        uint256 timestamp;
        bytes32 checkpointHash;
        bool exists;
    }

    struct MessageProof {
        bytes32 checkpointHash;
        uint256 leafIndex;
        bytes32[] siblings;
    }

    struct ValidatorSetInfo {
        uint256 totalVotingPower;
        bool active;
        address[] validators;
    }

    mapping(uint256 => mapping(uint256 => ValidatorSetInfo)) private validatorSets;
    mapping(uint256 => mapping(uint256 => mapping(address => uint256))) public validatorVotingPower;
    mapping(uint256 => mapping(bytes32 => VerifiedCheckpoint)) private verifiedCheckpoints;
    mapping(uint256 => mapping(uint256 => bytes32)) public checkpointHashBySequence;
    mapping(uint256 => uint256) public latestCheckpointSequence;
    mapping(uint256 => bytes32) public latestCheckpointHash;
    mapping(uint256 => bool) public sourceFrozen;

    event ValidatorSetUpdated(
        uint256 indexed sourceChainId,
        uint256 indexed validatorSetId,
        uint256 totalVotingPower,
        bool active
    );
    event CheckpointAccepted(
        uint256 indexed sourceChainId,
        uint256 indexed sequence,
        bytes32 indexed checkpointHash,
        uint256 validatorSetId,
        bytes32 messageRoot,
        address relayer
    );
    event SourceFrozen(
        uint256 indexed sourceChainId,
        uint256 indexed sequence,
        bytes32 indexed firstCheckpointHash,
        bytes32 conflictingCheckpointHash,
        address relayer
    );
    event SourceUnfrozen(uint256 indexed sourceChainId, address indexed admin);

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(CHECKPOINT_ADMIN_ROLE, msg.sender);
    }

    function setValidatorSet(
        uint256 sourceChainId,
        uint256 validatorSetId,
        address[] calldata validators,
        uint256[] calldata votingPowers,
        bool active
    ) external onlyRole(CHECKPOINT_ADMIN_ROLE) {
        require(sourceChainId != 0, "CHAIN_ID_ZERO");
        require(validatorSetId != 0, "VALIDATOR_SET_ZERO");
        require(validators.length == votingPowers.length, "VALIDATOR_LENGTH_MISMATCH");
        require(validators.length > 0, "VALIDATORS_EMPTY");

        ValidatorSetInfo storage set = validatorSets[sourceChainId][validatorSetId];
        for (uint256 i = 0; i < set.validators.length; i++) {
            validatorVotingPower[sourceChainId][validatorSetId][set.validators[i]] = 0;
        }
        delete set.validators;

        uint256 totalPower;
        for (uint256 i = 0; i < validators.length; i++) {
            address validator = validators[i];
            uint256 power = votingPowers[i];
            require(validator != address(0), "VALIDATOR_ZERO");
            require(power > 0, "VALIDATOR_POWER_ZERO");
            require(validatorVotingPower[sourceChainId][validatorSetId][validator] == 0, "DUPLICATE_VALIDATOR");

            validatorVotingPower[sourceChainId][validatorSetId][validator] = power;
            set.validators.push(validator);
            totalPower += power;
        }

        set.totalVotingPower = totalPower;
        set.active = active;
        emit ValidatorSetUpdated(sourceChainId, validatorSetId, totalPower, active);
    }

    function setValidatorSetActive(uint256 sourceChainId, uint256 validatorSetId, bool active)
        external
        onlyRole(CHECKPOINT_ADMIN_ROLE)
    {
        ValidatorSetInfo storage set = validatorSets[sourceChainId][validatorSetId];
        require(set.totalVotingPower > 0, "VALIDATOR_SET_UNKNOWN");
        set.active = active;
        emit ValidatorSetUpdated(sourceChainId, validatorSetId, set.totalVotingPower, active);
    }

    function submitCheckpoint(Checkpoint calldata checkpoint, bytes[] calldata signatures)
        external
        returns (bytes32 checkpointHash)
    {
        require(checkpoint.sourceChainId != 0, "CHAIN_ID_ZERO");
        require(checkpoint.validatorSetId != 0, "VALIDATOR_SET_ZERO");
        require(checkpoint.sequence != 0, "SEQUENCE_ZERO");
        require(checkpoint.messageRoot != bytes32(0), "MESSAGE_ROOT_ZERO");

        ValidatorSetInfo storage set = validatorSets[checkpoint.sourceChainId][checkpoint.validatorSetId];
        require(set.active, "VALIDATOR_SET_INACTIVE");

        checkpointHash = hashCheckpoint(checkpoint);
        _requireQuorum(checkpoint.sourceChainId, checkpoint.validatorSetId, set.totalVotingPower, checkpointHash, signatures);

        bytes32 existingHash = checkpointHashBySequence[checkpoint.sourceChainId][checkpoint.sequence];
        if (existingHash != bytes32(0)) {
            if (existingHash == checkpointHash) revert("CHECKPOINT_EXISTS");
            sourceFrozen[checkpoint.sourceChainId] = true;
            emit SourceFrozen(checkpoint.sourceChainId, checkpoint.sequence, existingHash, checkpointHash, msg.sender);
            return checkpointHash;
        }

        require(!sourceFrozen[checkpoint.sourceChainId], "SOURCE_FROZEN");
        uint256 latestSequence = latestCheckpointSequence[checkpoint.sourceChainId];
        require(checkpoint.sequence == latestSequence + 1, "WRONG_SEQUENCE");

        if (latestSequence == 0) {
            require(checkpoint.parentCheckpointHash == bytes32(0), "WRONG_PARENT_CHECKPOINT");
        } else {
            require(checkpoint.parentCheckpointHash == latestCheckpointHash[checkpoint.sourceChainId], "WRONG_PARENT_CHECKPOINT");
        }

        verifiedCheckpoints[checkpoint.sourceChainId][checkpointHash] = VerifiedCheckpoint({
            validatorSetId: checkpoint.validatorSetId,
            sequence: checkpoint.sequence,
            parentCheckpointHash: checkpoint.parentCheckpointHash,
            messageRoot: checkpoint.messageRoot,
            timestamp: checkpoint.timestamp,
            checkpointHash: checkpointHash,
            exists: true
        });
        checkpointHashBySequence[checkpoint.sourceChainId][checkpoint.sequence] = checkpointHash;
        latestCheckpointSequence[checkpoint.sourceChainId] = checkpoint.sequence;
        latestCheckpointHash[checkpoint.sourceChainId] = checkpointHash;

        emit CheckpointAccepted(
            checkpoint.sourceChainId,
            checkpoint.sequence,
            checkpointHash,
            checkpoint.validatorSetId,
            checkpoint.messageRoot,
            msg.sender
        );
    }

    function unfreezeSource(uint256 sourceChainId) external onlyRole(CHECKPOINT_ADMIN_ROLE) {
        require(sourceFrozen[sourceChainId], "SOURCE_NOT_FROZEN");
        sourceFrozen[sourceChainId] = false;
        emit SourceUnfrozen(sourceChainId, msg.sender);
    }

    function hashCheckpoint(Checkpoint memory checkpoint) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CHECKPOINT_TYPEHASH,
                checkpoint.sourceChainId,
                checkpoint.validatorSetId,
                checkpoint.sequence,
                checkpoint.parentCheckpointHash,
                checkpoint.messageRoot,
                checkpoint.timestamp
            )
        );
    }

    function verifyMessageInclusion(
        uint256 sourceChainId,
        bytes32 checkpointHash,
        bytes32 leaf,
        uint256 leafIndex,
        bytes32[] calldata siblings
    ) external view returns (bool) {
        if (sourceFrozen[sourceChainId]) return false;
        VerifiedCheckpoint storage checkpoint = verifiedCheckpoints[sourceChainId][checkpointHash];
        if (!checkpoint.exists || leaf == bytes32(0)) return false;
        return merkleRoot(leaf, leafIndex, siblings) == checkpoint.messageRoot;
    }

    function isCheckpointVerified(uint256 sourceChainId, bytes32 checkpointHash) external view returns (bool) {
        return verifiedCheckpoints[sourceChainId][checkpointHash].exists;
    }

    function verifiedCheckpoint(uint256 sourceChainId, bytes32 checkpointHash)
        external
        view
        returns (VerifiedCheckpoint memory)
    {
        VerifiedCheckpoint memory checkpoint = verifiedCheckpoints[sourceChainId][checkpointHash];
        require(checkpoint.exists, "CHECKPOINT_UNKNOWN");
        return checkpoint;
    }

    function validatorSet(uint256 sourceChainId, uint256 validatorSetId)
        external
        view
        returns (uint256 totalVotingPower, bool active, address[] memory validators)
    {
        ValidatorSetInfo storage set = validatorSets[sourceChainId][validatorSetId];
        return (set.totalVotingPower, set.active, set.validators);
    }

    function merkleRoot(bytes32 leaf, uint256 leafIndex, bytes32[] memory siblings) public pure returns (bytes32 root) {
        root = leaf;
        uint256 index = leafIndex;
        for (uint256 i = 0; i < siblings.length; i++) {
            bytes32 sibling = siblings[i];
            if (index & 1 == 0) {
                root = keccak256(abi.encodePacked(root, sibling));
            } else {
                root = keccak256(abi.encodePacked(sibling, root));
            }
            index >>= 1;
        }
    }

    function _requireQuorum(
        uint256 sourceChainId,
        uint256 validatorSetId,
        uint256 totalVotingPower,
        bytes32 checkpointHash,
        bytes[] calldata signatures
    ) internal view {
        require(signatures.length > 0, "SIGNATURES_EMPTY");

        address[] memory seen = new address[](signatures.length);
        uint256 signedPower;
        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = ECDSA.recover(checkpointHash, signatures[i]);
            uint256 power = validatorVotingPower[sourceChainId][validatorSetId][signer];
            if (power == 0) {
                signer = ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(checkpointHash), signatures[i]);
                power = validatorVotingPower[sourceChainId][validatorSetId][signer];
            }
            require(power > 0, "SIGNER_NOT_VALIDATOR");

            for (uint256 j = 0; j < i; j++) {
                require(seen[j] != signer, "DUPLICATE_SIGNATURE");
            }

            seen[i] = signer;
            signedPower += power;
        }

        require(signedPower * 3 >= totalVotingPower * 2, "INSUFFICIENT_QUORUM");
    }
}
