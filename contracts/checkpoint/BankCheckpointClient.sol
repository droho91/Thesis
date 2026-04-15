// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title BankCheckpointClient
/// @notice Remote light-client-style view of one or more permissioned bank EVM chains.
/// @dev The remote validator view advances only through source-originated validator epoch
///      artifacts certified by the currently trusted source epoch. Relayers only transport
///      source-certified epochs, checkpoints, and Merkle proofs.
contract BankCheckpointClient is AccessControl {
    bytes32 public constant CHECKPOINT_ADMIN_ROLE = keccak256("CHECKPOINT_ADMIN_ROLE");
    bytes32 public constant CHECKPOINT_TYPEHASH = keccak256("BankChain.FinalizedCheckpoint.v4");
    bytes32 public constant SOURCE_COMMITMENT_TYPEHASH = keccak256("BankChain.SourceCheckpointCommitment.v3");
    bytes32 public constant VALIDATOR_EPOCH_TYPEHASH = keccak256("BankChain.ValidatorEpoch.v1");

    enum ClientState {
        Uninitialized,
        Active,
        Frozen,
        Recovering
    }

    struct ValidatorEpoch {
        uint256 sourceChainId;
        address sourceValidatorSetRegistry;
        uint256 epochId;
        bytes32 parentEpochHash;
        address[] validators;
        uint256[] votingPowers;
        uint256 totalVotingPower;
        uint256 quorumNumerator;
        uint256 quorumDenominator;
        uint256 activationBlockNumber;
        bytes32 activationBlockHash;
        uint256 timestamp;
        bytes32 epochHash;
        bool active;
    }

    struct Checkpoint {
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
    }

    struct VerifiedCheckpoint {
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
        bool exists;
    }

    struct MessageProof {
        bytes32 checkpointHash;
        uint256 leafIndex;
        bytes32[] siblings;
    }

    mapping(uint256 => mapping(uint256 => ValidatorEpoch)) private validatorEpochs;
    mapping(uint256 => mapping(uint256 => mapping(address => uint256))) public validatorVotingPower;
    mapping(uint256 => mapping(bytes32 => VerifiedCheckpoint)) private verifiedCheckpoints;
    mapping(uint256 => mapping(uint256 => bytes32)) public checkpointHashBySequence;
    mapping(uint256 => mapping(uint256 => bytes32)) public conflictingCheckpointHashBySequence;
    mapping(uint256 => mapping(bytes32 => bool)) public knownValidatorEpochHash;
    mapping(uint256 => uint256) public activeValidatorEpochId;
    mapping(uint256 => uint256) public latestCheckpointSequence;
    mapping(uint256 => bytes32) public latestCheckpointHash;
    mapping(uint256 => uint256) public latestMessageSequence;
    mapping(uint256 => uint256) public latestSourceBlockNumber;
    mapping(uint256 => bytes32) public latestSourceBlockHash;
    mapping(uint256 => address) public sourceCheckpointRegistryForChain;
    mapping(uint256 => address) public sourceMessageBusForChain;
    mapping(uint256 => address) public sourceValidatorSetRegistryForChain;
    mapping(uint256 => ClientState) public clientState;

    event TrustedValidatorEpochBootstrapped(
        uint256 indexed sourceChainId,
        uint256 indexed epochId,
        bytes32 indexed epochHash,
        address sourceValidatorSetRegistry,
        uint256 activationBlockNumber,
        bytes32 activationBlockHash
    );
    event SourceValidatorEpochAccepted(
        uint256 indexed sourceChainId,
        uint256 indexed epochId,
        bytes32 indexed epochHash,
        bytes32 parentEpochHash,
        uint256 totalVotingPower,
        uint256 activationBlockNumber,
        bytes32 activationBlockHash,
        address relayer
    );
    event CheckpointAccepted(
        uint256 indexed sourceChainId,
        uint256 indexed sequence,
        bytes32 indexed checkpointHash,
        uint256 validatorEpochId,
        bytes32 validatorEpochHash,
        bytes32 messageRoot,
        uint256 firstMessageSequence,
        uint256 lastMessageSequence,
        bytes32 messageAccumulator,
        uint256 sourceBlockNumber,
        bytes32 sourceBlockHash,
        bytes32 sourceCommitmentHash,
        address relayer
    );
    event ClientStateChanged(
        uint256 indexed sourceChainId,
        ClientState indexed previousState,
        ClientState indexed newState,
        bytes32 evidenceHash,
        address actor
    );
    event SourceFrozen(
        uint256 indexed sourceChainId,
        uint256 indexed sequence,
        bytes32 indexed firstCheckpointHash,
        bytes32 conflictingCheckpointHash,
        address relayer
    );

    constructor(ValidatorEpoch memory initialTrustedEpoch) {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(CHECKPOINT_ADMIN_ROLE, msg.sender);
        _validateEpochShape(initialTrustedEpoch);
        require(initialTrustedEpoch.parentEpochHash == bytes32(0), "INITIAL_PARENT_NONZERO");
        require(initialTrustedEpoch.active, "INITIAL_EPOCH_INACTIVE");
        _storeValidatorEpoch(initialTrustedEpoch, true);
        clientState[initialTrustedEpoch.sourceChainId] = ClientState.Active;
        sourceValidatorSetRegistryForChain[initialTrustedEpoch.sourceChainId] =
            initialTrustedEpoch.sourceValidatorSetRegistry;

        emit TrustedValidatorEpochBootstrapped(
            initialTrustedEpoch.sourceChainId,
            initialTrustedEpoch.epochId,
            initialTrustedEpoch.epochHash,
            initialTrustedEpoch.sourceValidatorSetRegistry,
            initialTrustedEpoch.activationBlockNumber,
            initialTrustedEpoch.activationBlockHash
        );
        emit ClientStateChanged(
            initialTrustedEpoch.sourceChainId,
            ClientState.Uninitialized,
            ClientState.Active,
            initialTrustedEpoch.epochHash,
            msg.sender
        );
    }

    function submitValidatorEpoch(ValidatorEpoch calldata epoch, bytes[] calldata signatures)
        external
        returns (bytes32 epochHash)
    {
        _validateEpochShape(epoch);
        uint256 sourceChainId = epoch.sourceChainId;
        ClientState state = clientState[sourceChainId];
        require(state == ClientState.Active || state == ClientState.Recovering, "CLIENT_NOT_UPDATEABLE");
        require(sourceValidatorSetRegistryForChain[sourceChainId] == epoch.sourceValidatorSetRegistry, "VALIDATOR_REGISTRY_MISMATCH");

        ValidatorEpoch storage current = validatorEpochs[sourceChainId][activeValidatorEpochId[sourceChainId]];
        require(current.epochHash != bytes32(0), "CURRENT_EPOCH_UNKNOWN");
        require(epoch.epochId == current.epochId + 1, "WRONG_EPOCH");
        require(epoch.parentEpochHash == current.epochHash, "WRONG_PARENT_EPOCH");
        require(epoch.activationBlockNumber >= current.activationBlockNumber, "EPOCH_ANCHOR_REGRESSION");
        require(epoch.active, "EPOCH_INACTIVE");
        epochHash = computeValidatorEpochHash(epoch);
        require(epochHash == epoch.epochHash, "EPOCH_HASH_MISMATCH");
        require(!knownValidatorEpochHash[sourceChainId][epochHash], "EPOCH_EXISTS");

        _requireQuorum(
            sourceChainId,
            current.epochId,
            current.totalVotingPower,
            current.quorumNumerator,
            current.quorumDenominator,
            epochHash,
            signatures
        );

        _storeValidatorEpoch(epoch, true);
        if (state == ClientState.Recovering) {
            clientState[sourceChainId] = ClientState.Active;
            emit ClientStateChanged(sourceChainId, ClientState.Recovering, ClientState.Active, epochHash, msg.sender);
        }

        emit SourceValidatorEpochAccepted(
            sourceChainId,
            epoch.epochId,
            epochHash,
            epoch.parentEpochHash,
            epoch.totalVotingPower,
            epoch.activationBlockNumber,
            epoch.activationBlockHash,
            msg.sender
        );
    }

    function submitCheckpoint(Checkpoint calldata checkpoint, bytes[] calldata signatures)
        external
        returns (bytes32 checkpointHash)
    {
        _validateCheckpointShape(checkpoint);
        require(clientState[checkpoint.sourceChainId] == ClientState.Active, "CLIENT_NOT_ACTIVE");

        ValidatorEpoch storage epoch = validatorEpochs[checkpoint.sourceChainId][checkpoint.validatorEpochId];
        require(epoch.active, "VALIDATOR_EPOCH_INACTIVE");
        require(activeValidatorEpochId[checkpoint.sourceChainId] == checkpoint.validatorEpochId, "VALIDATOR_EPOCH_NOT_CURRENT");
        require(epoch.epochHash == checkpoint.validatorEpochHash, "VALIDATOR_EPOCH_HASH_MISMATCH");
        require(epoch.sourceValidatorSetRegistry == checkpoint.sourceValidatorSetRegistry, "VALIDATOR_REGISTRY_MISMATCH");

        checkpointHash = hashCheckpoint(checkpoint);
        require(hashSourceCommitment(checkpoint) == checkpoint.sourceCommitmentHash, "SOURCE_COMMITMENT_MISMATCH");
        _requireQuorum(
            checkpoint.sourceChainId,
            checkpoint.validatorEpochId,
            epoch.totalVotingPower,
            epoch.quorumNumerator,
            epoch.quorumDenominator,
            checkpointHash,
            signatures
        );

        bytes32 existingHash = checkpointHashBySequence[checkpoint.sourceChainId][checkpoint.sequence];
        if (existingHash != bytes32(0)) {
            if (existingHash == checkpointHash) revert("CHECKPOINT_EXISTS");
            ClientState previousState = clientState[checkpoint.sourceChainId];
            clientState[checkpoint.sourceChainId] = ClientState.Frozen;
            conflictingCheckpointHashBySequence[checkpoint.sourceChainId][checkpoint.sequence] = checkpointHash;
            emit SourceFrozen(checkpoint.sourceChainId, checkpoint.sequence, existingHash, checkpointHash, msg.sender);
            emit ClientStateChanged(checkpoint.sourceChainId, previousState, ClientState.Frozen, checkpointHash, msg.sender);
            return checkpointHash;
        }

        _validateProgression(checkpoint, epoch);
        _bindSourceEndpoints(checkpoint);

        verifiedCheckpoints[checkpoint.sourceChainId][checkpointHash] = VerifiedCheckpoint({
            sourceChainId: checkpoint.sourceChainId,
            sourceCheckpointRegistry: checkpoint.sourceCheckpointRegistry,
            sourceMessageBus: checkpoint.sourceMessageBus,
            sourceValidatorSetRegistry: checkpoint.sourceValidatorSetRegistry,
            validatorEpochId: checkpoint.validatorEpochId,
            validatorEpochHash: checkpoint.validatorEpochHash,
            sequence: checkpoint.sequence,
            parentCheckpointHash: checkpoint.parentCheckpointHash,
            messageRoot: checkpoint.messageRoot,
            firstMessageSequence: checkpoint.firstMessageSequence,
            lastMessageSequence: checkpoint.lastMessageSequence,
            messageCount: checkpoint.messageCount,
            messageAccumulator: checkpoint.messageAccumulator,
            sourceBlockNumber: checkpoint.sourceBlockNumber,
            sourceBlockHash: checkpoint.sourceBlockHash,
            timestamp: checkpoint.timestamp,
            sourceCommitmentHash: checkpoint.sourceCommitmentHash,
            checkpointHash: checkpointHash,
            exists: true
        });
        checkpointHashBySequence[checkpoint.sourceChainId][checkpoint.sequence] = checkpointHash;
        latestCheckpointSequence[checkpoint.sourceChainId] = checkpoint.sequence;
        latestCheckpointHash[checkpoint.sourceChainId] = checkpointHash;
        latestMessageSequence[checkpoint.sourceChainId] = checkpoint.lastMessageSequence;
        latestSourceBlockNumber[checkpoint.sourceChainId] = checkpoint.sourceBlockNumber;
        latestSourceBlockHash[checkpoint.sourceChainId] = checkpoint.sourceBlockHash;

        emit CheckpointAccepted(
            checkpoint.sourceChainId,
            checkpoint.sequence,
            checkpointHash,
            checkpoint.validatorEpochId,
            checkpoint.validatorEpochHash,
            checkpoint.messageRoot,
            checkpoint.firstMessageSequence,
            checkpoint.lastMessageSequence,
            checkpoint.messageAccumulator,
            checkpoint.sourceBlockNumber,
            checkpoint.sourceBlockHash,
            checkpoint.sourceCommitmentHash,
            msg.sender
        );
    }

    function beginRecovery(uint256 sourceChainId) external onlyRole(CHECKPOINT_ADMIN_ROLE) {
        require(clientState[sourceChainId] == ClientState.Frozen, "CLIENT_NOT_FROZEN");
        clientState[sourceChainId] = ClientState.Recovering;
        emit ClientStateChanged(sourceChainId, ClientState.Frozen, ClientState.Recovering, bytes32(0), msg.sender);
    }

    function sourceFrozen(uint256 sourceChainId) external view returns (bool) {
        ClientState state = clientState[sourceChainId];
        return state == ClientState.Frozen || state == ClientState.Recovering;
    }

    function computeValidatorEpochHash(ValidatorEpoch memory epoch) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                VALIDATOR_EPOCH_TYPEHASH,
                epoch.sourceChainId,
                epoch.sourceValidatorSetRegistry,
                epoch.epochId,
                epoch.parentEpochHash,
                epoch.validators,
                epoch.votingPowers,
                epoch.totalVotingPower,
                epoch.quorumNumerator,
                epoch.quorumDenominator,
                epoch.activationBlockNumber,
                epoch.activationBlockHash,
                epoch.timestamp
            )
        );
    }

    function hashSourceCommitment(Checkpoint memory checkpoint) public pure returns (bytes32) {
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

    function hashCheckpoint(Checkpoint memory checkpoint) public pure returns (bytes32) {
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

    function verifyMessageInclusion(
        uint256 sourceChainId,
        bytes32 checkpointHash,
        bytes32 leaf,
        uint256 leafIndex,
        bytes32[] calldata siblings
    ) external view returns (bool) {
        if (clientState[sourceChainId] != ClientState.Active) return false;
        VerifiedCheckpoint storage checkpoint = verifiedCheckpoints[sourceChainId][checkpointHash];
        if (!checkpoint.exists || leaf == bytes32(0) || leafIndex >= checkpoint.messageCount) return false;
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

    function validatorEpoch(uint256 sourceChainId, uint256 epochId)
        external
        view
        returns (ValidatorEpoch memory)
    {
        ValidatorEpoch memory epoch = validatorEpochs[sourceChainId][epochId];
        require(epoch.epochHash != bytes32(0), "EPOCH_UNKNOWN");
        return epoch;
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

    function _validateEpochShape(ValidatorEpoch memory epoch) internal pure {
        require(epoch.sourceChainId != 0, "CHAIN_ID_ZERO");
        require(epoch.sourceValidatorSetRegistry != address(0), "VALIDATOR_REGISTRY_ZERO");
        require(epoch.epochId != 0, "EPOCH_ZERO");
        require(epoch.validators.length == epoch.votingPowers.length, "VALIDATOR_LENGTH_MISMATCH");
        require(epoch.validators.length > 0, "VALIDATORS_EMPTY");
        require(epoch.totalVotingPower > 0, "VALIDATOR_EPOCH_EMPTY");
        require(epoch.quorumNumerator != 0, "QUORUM_ZERO");
        require(epoch.quorumDenominator != 0, "QUORUM_DENOMINATOR_ZERO");
        require(epoch.quorumNumerator * 2 > epoch.quorumDenominator, "QUORUM_NOT_SAFETY_MAJORITY");
        require(epoch.activationBlockHash != bytes32(0), "EPOCH_BLOCK_HASH_ZERO");
        require(epoch.timestamp != 0, "EPOCH_TIMESTAMP_ZERO");
        require(epoch.epochHash != bytes32(0), "EPOCH_HASH_ZERO");

        uint256 totalPower;
        for (uint256 i = 0; i < epoch.validators.length; i++) {
            address validator = epoch.validators[i];
            uint256 power = epoch.votingPowers[i];
            require(validator != address(0), "VALIDATOR_ZERO");
            require(power > 0, "VALIDATOR_POWER_ZERO");
            totalPower += power;
            for (uint256 j = 0; j < i; j++) {
                require(epoch.validators[j] != validator, "DUPLICATE_VALIDATOR");
            }
        }
        require(totalPower == epoch.totalVotingPower, "TOTAL_POWER_MISMATCH");
        require(computeValidatorEpochHash(epoch) == epoch.epochHash, "EPOCH_HASH_MISMATCH");
    }

    function _validateCheckpointShape(Checkpoint calldata checkpoint) internal pure {
        require(checkpoint.sourceChainId != 0, "CHAIN_ID_ZERO");
        require(checkpoint.sourceCheckpointRegistry != address(0), "SOURCE_REGISTRY_ZERO");
        require(checkpoint.sourceMessageBus != address(0), "SOURCE_BUS_ZERO");
        require(checkpoint.sourceValidatorSetRegistry != address(0), "VALIDATOR_REGISTRY_ZERO");
        require(checkpoint.validatorEpochId != 0, "VALIDATOR_EPOCH_ZERO");
        require(checkpoint.validatorEpochHash != bytes32(0), "VALIDATOR_EPOCH_HASH_ZERO");
        require(checkpoint.sequence != 0, "SEQUENCE_ZERO");
        require(checkpoint.messageRoot != bytes32(0), "MESSAGE_ROOT_ZERO");
        require(checkpoint.sourceCommitmentHash != bytes32(0), "SOURCE_COMMITMENT_ZERO");
        require(checkpoint.messageAccumulator != bytes32(0), "MESSAGE_ACCUMULATOR_ZERO");
        require(checkpoint.messageCount > 0, "MESSAGE_COUNT_ZERO");
        require(checkpoint.firstMessageSequence != 0, "FIRST_MESSAGE_ZERO");
        require(checkpoint.lastMessageSequence >= checkpoint.firstMessageSequence, "BAD_MESSAGE_RANGE");
        require(
            checkpoint.lastMessageSequence - checkpoint.firstMessageSequence + 1 == checkpoint.messageCount,
            "MESSAGE_COUNT_MISMATCH"
        );
        require(checkpoint.sourceBlockHash != bytes32(0), "SOURCE_BLOCK_HASH_ZERO");
        require(checkpoint.timestamp != 0, "TIMESTAMP_ZERO");
    }

    function _validateProgression(Checkpoint calldata checkpoint, ValidatorEpoch storage epoch) internal view {
        uint256 latestSequence = latestCheckpointSequence[checkpoint.sourceChainId];
        require(checkpoint.sequence == latestSequence + 1, "WRONG_SEQUENCE");
        require(checkpoint.sourceBlockNumber >= epoch.activationBlockNumber, "CHECKPOINT_BEFORE_EPOCH");

        if (latestSequence == 0) {
            require(checkpoint.parentCheckpointHash == bytes32(0), "WRONG_PARENT_CHECKPOINT");
            require(checkpoint.firstMessageSequence == 1, "WRONG_MESSAGE_RANGE");
        } else {
            require(checkpoint.parentCheckpointHash == latestCheckpointHash[checkpoint.sourceChainId], "WRONG_PARENT_CHECKPOINT");
            require(
                checkpoint.firstMessageSequence == latestMessageSequence[checkpoint.sourceChainId] + 1,
                "WRONG_MESSAGE_RANGE"
            );
            uint256 latestBlockNumber = latestSourceBlockNumber[checkpoint.sourceChainId];
            require(checkpoint.sourceBlockNumber >= latestBlockNumber, "SOURCE_BLOCK_REGRESSION");
            if (checkpoint.sourceBlockNumber == latestBlockNumber) {
                require(checkpoint.sourceBlockHash == latestSourceBlockHash[checkpoint.sourceChainId], "SOURCE_BLOCK_HASH_MISMATCH");
            }
        }
    }

    function _bindSourceEndpoints(Checkpoint calldata checkpoint) internal {
        address knownRegistry = sourceCheckpointRegistryForChain[checkpoint.sourceChainId];
        address knownBus = sourceMessageBusForChain[checkpoint.sourceChainId];
        if (knownRegistry == address(0)) {
            sourceCheckpointRegistryForChain[checkpoint.sourceChainId] = checkpoint.sourceCheckpointRegistry;
        } else {
            require(knownRegistry == checkpoint.sourceCheckpointRegistry, "SOURCE_REGISTRY_MISMATCH");
        }

        if (knownBus == address(0)) {
            sourceMessageBusForChain[checkpoint.sourceChainId] = checkpoint.sourceMessageBus;
        } else {
            require(knownBus == checkpoint.sourceMessageBus, "SOURCE_BUS_MISMATCH");
        }
    }

    function _storeValidatorEpoch(ValidatorEpoch memory epoch, bool makeActive) internal {
        ValidatorEpoch storage previous = validatorEpochs[epoch.sourceChainId][activeValidatorEpochId[epoch.sourceChainId]];
        if (makeActive && previous.epochHash != bytes32(0)) {
            previous.active = false;
        }

        ValidatorEpoch storage stored = validatorEpochs[epoch.sourceChainId][epoch.epochId];
        for (uint256 i = 0; i < stored.validators.length; i++) {
            validatorVotingPower[epoch.sourceChainId][epoch.epochId][stored.validators[i]] = 0;
        }
        delete stored.validators;
        delete stored.votingPowers;

        stored.sourceChainId = epoch.sourceChainId;
        stored.sourceValidatorSetRegistry = epoch.sourceValidatorSetRegistry;
        stored.epochId = epoch.epochId;
        stored.parentEpochHash = epoch.parentEpochHash;
        stored.totalVotingPower = epoch.totalVotingPower;
        stored.quorumNumerator = epoch.quorumNumerator;
        stored.quorumDenominator = epoch.quorumDenominator;
        stored.activationBlockNumber = epoch.activationBlockNumber;
        stored.activationBlockHash = epoch.activationBlockHash;
        stored.timestamp = epoch.timestamp;
        stored.epochHash = epoch.epochHash;
        stored.active = makeActive;
        for (uint256 i = 0; i < epoch.validators.length; i++) {
            stored.validators.push(epoch.validators[i]);
            stored.votingPowers.push(epoch.votingPowers[i]);
            validatorVotingPower[epoch.sourceChainId][epoch.epochId][epoch.validators[i]] = epoch.votingPowers[i];
        }

        if (makeActive) {
            activeValidatorEpochId[epoch.sourceChainId] = epoch.epochId;
        }
        knownValidatorEpochHash[epoch.sourceChainId][epoch.epochHash] = true;
    }

    function _requireQuorum(
        uint256 sourceChainId,
        uint256 validatorEpochId,
        uint256 totalVotingPower,
        uint256 quorumNumerator,
        uint256 quorumDenominator,
        bytes32 digest,
        bytes[] calldata signatures
    ) internal view {
        require(signatures.length > 0, "SIGNATURES_EMPTY");

        address[] memory seen = new address[](signatures.length);
        uint256 signedPower;
        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = ECDSA.recover(digest, signatures[i]);
            uint256 power = validatorVotingPower[sourceChainId][validatorEpochId][signer];
            if (power == 0) {
                signer = ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(digest), signatures[i]);
                power = validatorVotingPower[sourceChainId][validatorEpochId][signer];
            }
            require(power > 0, "SIGNER_NOT_VALIDATOR");

            for (uint256 j = 0; j < i; j++) {
                require(seen[j] != signer, "DUPLICATE_SIGNATURE");
            }

            seen[i] = signer;
            signedPower += power;
        }

        require(signedPower * quorumDenominator >= totalVotingPower * quorumNumerator, "INSUFFICIENT_QUORUM");
    }
}
