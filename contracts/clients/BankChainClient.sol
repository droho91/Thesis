// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IBCClient} from "../core/IBCClient.sol";
import {IBCClientStore} from "../core/IBCClientStore.sol";
import {IBCClientTypes} from "../core/IBCClientTypes.sol";
import {IBCMisbehaviour} from "../core/IBCMisbehaviour.sol";
import {IBCPathLib} from "../core/IBCPathLib.sol";
import {BankChainClientMessage} from "./BankChainClientMessage.sol";
import {BankChainClientState} from "./BankChainClientState.sol";
import {BankChainClientVerifier} from "./BankChainClientVerifier.sol";
import {BankChainConsensusState} from "./BankChainConsensusState.sol";
import {MerkleLib} from "../libs/MerkleLib.sol";

/// @title BankChainClient
/// @notice IBC/light-client-like trust anchor for a remote permissioned EVM bank chain.
contract BankChainClient is AccessControl, IBCClient, IBCClientStore {
    bytes32 public constant CLIENT_ADMIN_ROLE = keccak256("CLIENT_ADMIN_ROLE");

    mapping(uint256 => mapping(uint256 => BankChainClientState.ValidatorEpoch)) private validatorEpochs;
    mapping(uint256 => mapping(uint256 => mapping(address => uint256))) public validatorVotingPower;
    mapping(uint256 => mapping(bytes32 => BankChainConsensusState.ConsensusState)) private consensusStates;
    mapping(uint256 => mapping(uint256 => bytes32)) public consensusStateHashBySequence;
    mapping(uint256 => mapping(uint256 => bytes32)) public conflictingConsensusStateHashBySequence;
    mapping(uint256 => mapping(bytes32 => bool)) public knownValidatorEpochHash;
    mapping(uint256 => uint256) public activeValidatorEpochId;
    mapping(uint256 => uint256) public latestConsensusStateSequence;
    mapping(uint256 => bytes32) public latestConsensusStateHash;
    mapping(uint256 => uint256) public latestPacketSequence;
    mapping(uint256 => uint256) public latestSourceBlockNumber;
    mapping(uint256 => bytes32) public latestSourceBlockHash;
    mapping(uint256 => address) public sourceHeaderProducerForChain;
    mapping(uint256 => address) public sourcePacketCommitmentForChain;
    mapping(uint256 => address) public sourceValidatorSetRegistryForChain;
    mapping(uint256 => IBCMisbehaviour.Evidence) public frozenEvidence;

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
    event ClientUpdated(
        uint256 indexed sourceChainId,
        uint256 indexed height,
        bytes32 indexed consensusStateHash,
        uint256 validatorEpochId,
        bytes32 validatorEpochHash,
        bytes32 blockHash,
        bytes32 packetRoot,
        bytes32 stateRoot,
        bytes32 executionStateRoot,
        uint256 firstPacketSequence,
        uint256 lastPacketSequence,
        bytes32 packetAccumulator,
        uint256 sourceBlockNumber,
        bytes32 sourceBlockHash,
        address relayer
    );
    event MisbehaviourDetected(
        uint256 indexed sourceChainId,
        uint256 indexed sequence,
        bytes32 indexed evidenceHash,
        bytes32 trustedConsensusStateHash,
        bytes32 conflictingConsensusStateHash,
        address relayer
    );

    constructor(BankChainClientState.ValidatorEpoch memory initialTrustedEpoch) {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(CLIENT_ADMIN_ROLE, msg.sender);
        _validateEpochShape(initialTrustedEpoch);
        require(initialTrustedEpoch.parentEpochHash == bytes32(0), "INITIAL_PARENT_NONZERO");
        require(initialTrustedEpoch.active, "INITIAL_EPOCH_INACTIVE");
        _storeValidatorEpoch(initialTrustedEpoch, true);
        sourceValidatorSetRegistryForChain[initialTrustedEpoch.sourceChainId] =
            initialTrustedEpoch.sourceValidatorSetRegistry;
        _setStatus(initialTrustedEpoch.sourceChainId, IBCClientTypes.Status.Active, initialTrustedEpoch.epochHash);

        emit TrustedValidatorEpochBootstrapped(
            initialTrustedEpoch.sourceChainId,
            initialTrustedEpoch.epochId,
            initialTrustedEpoch.epochHash,
            initialTrustedEpoch.sourceValidatorSetRegistry,
            initialTrustedEpoch.activationBlockNumber,
            initialTrustedEpoch.activationBlockHash
        );
    }

    function status(uint256 sourceChainId)
        public
        view
        override(IBCClient, IBCClientStore)
        returns (IBCClientTypes.Status)
    {
        return IBCClientStore.status(sourceChainId);
    }

    function updateValidatorEpoch(
        BankChainClientState.ValidatorEpoch calldata epoch,
        bytes[] calldata signatures
    ) external returns (bytes32 epochHash) {
        _validateEpochShapeCalldata(epoch);
        uint256 sourceChainId = epoch.sourceChainId;
        IBCClientTypes.Status clientStatus = clientStatuses[sourceChainId];
        require(
            clientStatus == IBCClientTypes.Status.Active || clientStatus == IBCClientTypes.Status.Recovering,
            "CLIENT_NOT_UPDATEABLE"
        );
        require(
            sourceValidatorSetRegistryForChain[sourceChainId] == epoch.sourceValidatorSetRegistry,
            "VALIDATOR_REGISTRY_MISMATCH"
        );

        BankChainClientState.ValidatorEpoch storage current =
            validatorEpochs[sourceChainId][activeValidatorEpochId[sourceChainId]];
        require(current.epochHash != bytes32(0), "CURRENT_EPOCH_UNKNOWN");
        require(epoch.epochId == current.epochId + 1, "WRONG_EPOCH");
        require(epoch.parentEpochHash == current.epochHash, "WRONG_PARENT_EPOCH");
        require(epoch.activationBlockNumber >= current.activationBlockNumber, "EPOCH_ANCHOR_REGRESSION");
        require(epoch.active, "EPOCH_INACTIVE");
        epochHash = BankChainClientState.hashCalldata(epoch);
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

        _storeValidatorEpochCalldata(epoch, true);
        if (clientStatus == IBCClientTypes.Status.Recovering) {
            delete frozenEvidence[sourceChainId];
            _setStatus(sourceChainId, IBCClientTypes.Status.Active, epochHash);
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

    function updateState(BankChainClientMessage.ClientMessage calldata clientMessage, bytes[] calldata signatures)
        external
        returns (bytes32 consensusStateHash)
    {
        BankChainClientMessage.Header calldata header = clientMessage.header;
        _validateHeaderShape(header);
        require(clientStatuses[header.sourceChainId] == IBCClientTypes.Status.Active, "CLIENT_NOT_ACTIVE");

        BankChainClientState.ValidatorEpoch storage epoch =
            validatorEpochs[header.sourceChainId][header.validatorEpochId];
        require(epoch.epochHash != bytes32(0), "VALIDATOR_EPOCH_UNKNOWN");
        require(epoch.epochHash == header.validatorEpochHash, "VALIDATOR_EPOCH_HASH_MISMATCH");
        require(epoch.sourceValidatorSetRegistry == header.sourceValidatorSetRegistry, "VALIDATOR_REGISTRY_MISMATCH");

        consensusStateHash = BankChainClientMessage.headerHashCalldata(header);
        require(consensusStateHash == header.blockHash, "HEADER_HASH_MISMATCH");
        bytes32 commitDigest = BankChainClientMessage.commitDigestCalldata(header);
        _requireQuorum(
            header.sourceChainId,
            header.validatorEpochId,
            epoch.totalVotingPower,
            epoch.quorumNumerator,
            epoch.quorumDenominator,
            commitDigest,
            signatures
        );

        bytes32 existingHash = consensusStateHashBySequence[header.sourceChainId][header.height];
        if (existingHash != bytes32(0)) {
            if (existingHash == consensusStateHash) revert("CONSENSUS_STATE_EXISTS");
            _freezeForMisbehaviour(header.sourceChainId, header.height, existingHash, consensusStateHash);
            return consensusStateHash;
        }

        _validateProgression(header, epoch);
        _bindSourceEndpoints(header);

        consensusStates[header.sourceChainId][consensusStateHash] = BankChainConsensusState.ConsensusState({
            sourceChainId: header.sourceChainId,
            sourceHeaderProducer: header.sourceHeaderProducer,
            sourcePacketCommitment: header.sourcePacketCommitment,
            sourceValidatorSetRegistry: header.sourceValidatorSetRegistry,
            validatorEpochId: header.validatorEpochId,
            validatorEpochHash: header.validatorEpochHash,
            height: header.height,
            parentHash: header.parentHash,
            blockHash: header.blockHash,
            packetRoot: header.packetRoot,
            stateRoot: header.stateRoot,
            executionStateRoot: header.executionStateRoot,
            firstPacketSequence: header.firstPacketSequence,
            lastPacketSequence: header.lastPacketSequence,
            packetCount: header.packetCount,
            packetAccumulator: header.packetAccumulator,
            sourceBlockNumber: header.sourceBlockNumber,
            sourceBlockHash: header.sourceBlockHash,
            round: header.round,
            timestamp: header.timestamp,
            consensusStateHash: consensusStateHash,
            exists: true
        });
        consensusStateHashBySequence[header.sourceChainId][header.height] = consensusStateHash;
        latestConsensusStateSequence[header.sourceChainId] = header.height;
        latestConsensusStateHash[header.sourceChainId] = consensusStateHash;
        latestPacketSequence[header.sourceChainId] = header.lastPacketSequence;
        latestSourceBlockNumber[header.sourceChainId] = header.sourceBlockNumber;
        latestSourceBlockHash[header.sourceChainId] = header.sourceBlockHash;

        emit ClientUpdated(
            header.sourceChainId,
            header.height,
            consensusStateHash,
            header.validatorEpochId,
            header.validatorEpochHash,
            header.blockHash,
            header.packetRoot,
            header.stateRoot,
            header.executionStateRoot,
            header.firstPacketSequence,
            header.lastPacketSequence,
            header.packetAccumulator,
            header.sourceBlockNumber,
            header.sourceBlockHash,
            msg.sender
        );
    }

    function beginRecovery(uint256 sourceChainId) external onlyRole(CLIENT_ADMIN_ROLE) {
        require(clientStatuses[sourceChainId] == IBCClientTypes.Status.Frozen, "CLIENT_NOT_FROZEN");
        _setStatus(sourceChainId, IBCClientTypes.Status.Recovering, frozenEvidence[sourceChainId].evidenceHash);
    }

    function sourceFrozen(uint256 sourceChainId) external view returns (bool) {
        IBCClientTypes.Status clientStatus = clientStatuses[sourceChainId];
        return clientStatus == IBCClientTypes.Status.Frozen || clientStatus == IBCClientTypes.Status.Recovering;
    }

    function verifyMembership(
        uint256 sourceChainId,
        bytes32 consensusStateHash,
        bytes32 path,
        bytes32 value,
        uint256 sequence,
        uint256 leafIndex,
        bytes32[] calldata siblings
    ) external view override returns (bool) {
        if (clientStatuses[sourceChainId] != IBCClientTypes.Status.Active) return false;
        BankChainConsensusState.ConsensusState storage consensus =
            consensusStates[sourceChainId][consensusStateHash];
        if (!consensus.exists || path == bytes32(0) || value == bytes32(0)) return false;
        if (sequence < consensus.firstPacketSequence || sequence > consensus.lastPacketSequence) return false;
        if (leafIndex != sequence - consensus.firstPacketSequence) return false;
        bytes32 stateLeaf = IBCPathLib.stateLeaf(path, value);
        return MerkleLib.verify(consensus.stateRoot, stateLeaf, leafIndex, siblings);
    }

    function trustedStateRoot(uint256 sourceChainId, bytes32 consensusStateHash)
        external
        view
        override
        returns (bytes32)
    {
        BankChainConsensusState.ConsensusState storage consensus =
            consensusStates[sourceChainId][consensusStateHash];
        if (!consensus.exists) return bytes32(0);
        return consensus.executionStateRoot != bytes32(0) ? consensus.executionStateRoot : consensus.stateRoot;
    }

    function trustedPacketCommitment(uint256 sourceChainId, bytes32 consensusStateHash)
        external
        view
        override
        returns (address)
    {
        BankChainConsensusState.ConsensusState storage consensus =
            consensusStates[sourceChainId][consensusStateHash];
        return consensus.exists ? consensus.sourcePacketCommitment : address(0);
    }

    function verifyNonMembership(
        uint256 sourceChainId,
        bytes32 consensusStateHash,
        bytes32 path,
        bytes32 value,
        bytes calldata proof
    ) external view override returns (bool) {
        if (clientStatuses[sourceChainId] != IBCClientTypes.Status.Active) return false;
        BankChainConsensusState.ConsensusState storage consensus =
            consensusStates[sourceChainId][consensusStateHash];
        if (!consensus.exists) return false;

        IBCClientTypes.NonMembershipProof memory absence =
            abi.decode(proof, (IBCClientTypes.NonMembershipProof));
        if (path == bytes32(0) || value == bytes32(0) || absence.sequence == 0) {
            return false;
        }

        if (absence.sequence > consensus.lastPacketSequence) {
            return absence.witnessedValue == bytes32(0) && absence.siblings.length == 0;
        }
        if (absence.sequence < consensus.firstPacketSequence) return false;

        uint256 expectedLeafIndex = absence.sequence - consensus.firstPacketSequence;
        if (absence.leafIndex != expectedLeafIndex) return false;
        if (absence.witnessedValue == bytes32(0) || absence.witnessedValue == value) {
            return false;
        }
        return MerkleLib.verify(
            consensus.stateRoot,
            IBCPathLib.stateLeaf(path, absence.witnessedValue),
            absence.leafIndex,
            absence.siblings
        );
    }

    function isConsensusStateVerified(uint256 sourceChainId, bytes32 consensusStateHash)
        external
        view
        returns (bool)
    {
        return consensusStates[sourceChainId][consensusStateHash].exists;
    }

    function consensusState(uint256 sourceChainId, bytes32 consensusStateHash)
        external
        view
        returns (BankChainConsensusState.ConsensusState memory)
    {
        BankChainConsensusState.ConsensusState memory stored = consensusStates[sourceChainId][consensusStateHash];
        require(stored.exists, "CONSENSUS_STATE_UNKNOWN");
        return stored;
    }

    function validatorEpoch(uint256 sourceChainId, uint256 epochId)
        external
        view
        returns (BankChainClientState.ValidatorEpoch memory)
    {
        BankChainClientState.ValidatorEpoch memory epoch = validatorEpochs[sourceChainId][epochId];
        require(epoch.epochHash != bytes32(0), "EPOCH_UNKNOWN");
        return epoch;
    }

    function hashValidatorEpoch(BankChainClientState.ValidatorEpoch memory epoch) public pure returns (bytes32) {
        return BankChainClientState.hash(epoch);
    }

    function hashHeader(BankChainClientMessage.Header memory header)
        public
        pure
        returns (bytes32)
    {
        return BankChainClientMessage.headerHash(header);
    }

    function hashCommitment(BankChainClientMessage.Header memory header)
        public
        pure
        returns (bytes32)
    {
        return BankChainClientMessage.commitDigest(header);
    }

    function hashConsensusState(BankChainClientMessage.Header memory header) public pure returns (bytes32) {
        return BankChainClientMessage.headerHash(header);
    }

    function _freezeForMisbehaviour(
        uint256 sourceChainId,
        uint256 sequence,
        bytes32 trustedConsensusStateHash,
        bytes32 conflictingConsensusStateHash
    ) internal {
        bytes32 evidenceHash = IBCMisbehaviour.hashEvidence(
            sourceChainId,
            sequence,
            trustedConsensusStateHash,
            conflictingConsensusStateHash
        );
        conflictingConsensusStateHashBySequence[sourceChainId][sequence] = conflictingConsensusStateHash;
        frozenEvidence[sourceChainId] = IBCMisbehaviour.Evidence({
            sourceChainId: sourceChainId,
            sequence: sequence,
            trustedConsensusStateHash: trustedConsensusStateHash,
            conflictingConsensusStateHash: conflictingConsensusStateHash,
            evidenceHash: evidenceHash,
            detectedAt: block.timestamp,
            exists: true
        });
        _setStatus(sourceChainId, IBCClientTypes.Status.Frozen, evidenceHash);
        emit MisbehaviourDetected(
            sourceChainId,
            sequence,
            evidenceHash,
            trustedConsensusStateHash,
            conflictingConsensusStateHash,
            msg.sender
        );
    }

    function _validateEpochShape(BankChainClientState.ValidatorEpoch memory epoch) internal pure {
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
        require(BankChainClientState.hash(epoch) == epoch.epochHash, "EPOCH_HASH_MISMATCH");
    }

    function _validateEpochShapeCalldata(BankChainClientState.ValidatorEpoch calldata epoch) internal pure {
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
        require(BankChainClientState.hashCalldata(epoch) == epoch.epochHash, "EPOCH_HASH_MISMATCH");
    }

    function _validateHeaderShape(BankChainClientMessage.Header calldata header) internal pure {
        require(header.sourceChainId != 0, "CHAIN_ID_ZERO");
        require(header.sourceHeaderProducer != address(0), "SOURCE_HEADER_PRODUCER_ZERO");
        require(header.sourcePacketCommitment != address(0), "SOURCE_PACKET_STORE_ZERO");
        require(header.sourceValidatorSetRegistry != address(0), "VALIDATOR_REGISTRY_ZERO");
        require(header.validatorEpochId != 0, "VALIDATOR_EPOCH_ZERO");
        require(header.validatorEpochHash != bytes32(0), "VALIDATOR_EPOCH_HASH_ZERO");
        require(header.height != 0, "HEIGHT_ZERO");
        require(header.blockHash != bytes32(0), "BLOCK_HASH_ZERO");
        require(header.packetRoot != bytes32(0), "PACKET_ROOT_ZERO");
        require(header.stateRoot != bytes32(0), "STATE_ROOT_ZERO");
        require(header.packetAccumulator != bytes32(0), "PACKET_ACCUMULATOR_ZERO");
        require(header.packetCount > 0, "PACKET_COUNT_ZERO");
        require(header.firstPacketSequence != 0, "FIRST_PACKET_ZERO");
        require(header.lastPacketSequence >= header.firstPacketSequence, "BAD_PACKET_RANGE");
        require(
            header.lastPacketSequence - header.firstPacketSequence + 1 == header.packetCount,
            "PACKET_COUNT_MISMATCH"
        );
        require(header.sourceBlockHash != bytes32(0), "SOURCE_BLOCK_HASH_ZERO");
        require(header.timestamp != 0, "TIMESTAMP_ZERO");
    }

    function _validateProgression(
        BankChainClientMessage.Header calldata header,
        BankChainClientState.ValidatorEpoch storage epoch
    ) internal view {
        uint256 latestSequence = latestConsensusStateSequence[header.sourceChainId];
        require(header.height == latestSequence + 1, "WRONG_HEIGHT");
        require(header.sourceBlockNumber >= epoch.activationBlockNumber, "HEADER_BEFORE_EPOCH");

        if (latestSequence == 0) {
            require(header.parentHash == bytes32(0), "WRONG_PARENT_HEADER");
            require(header.firstPacketSequence == 1, "WRONG_PACKET_RANGE");
        } else {
            require(
                header.parentHash == latestConsensusStateHash[header.sourceChainId],
                "WRONG_PARENT_HEADER"
            );
            require(
                header.firstPacketSequence == latestPacketSequence[header.sourceChainId] + 1,
                "WRONG_PACKET_RANGE"
            );
            uint256 latestBlockNumber = latestSourceBlockNumber[header.sourceChainId];
            require(header.sourceBlockNumber >= latestBlockNumber, "SOURCE_BLOCK_REGRESSION");
            if (header.sourceBlockNumber == latestBlockNumber) {
                require(
                    header.sourceBlockHash == latestSourceBlockHash[header.sourceChainId],
                    "SOURCE_BLOCK_HASH_MISMATCH"
                );
            }

            BankChainConsensusState.ConsensusState storage previousConsensus =
                consensusStates[header.sourceChainId][latestConsensusStateHash[header.sourceChainId]];
            require(header.timestamp >= previousConsensus.timestamp, "TIMESTAMP_REGRESSION");
        }

        BankChainClientState.ValidatorEpoch storage successor =
            validatorEpochs[header.sourceChainId][epoch.epochId + 1];
        if (successor.epochHash != bytes32(0)) {
            require(header.sourceBlockNumber < successor.activationBlockNumber, "HEADER_AFTER_EPOCH_SUPERSEDED");
        }
    }

    function _bindSourceEndpoints(BankChainClientMessage.Header calldata header) internal {
        address knownHeaderProducer = sourceHeaderProducerForChain[header.sourceChainId];
        address knownPacketStore = sourcePacketCommitmentForChain[header.sourceChainId];
        if (knownHeaderProducer == address(0)) {
            sourceHeaderProducerForChain[header.sourceChainId] = header.sourceHeaderProducer;
        } else {
            require(knownHeaderProducer == header.sourceHeaderProducer, "SOURCE_HEADER_PRODUCER_MISMATCH");
        }

        if (knownPacketStore == address(0)) {
            sourcePacketCommitmentForChain[header.sourceChainId] = header.sourcePacketCommitment;
        } else {
            require(knownPacketStore == header.sourcePacketCommitment, "SOURCE_PACKET_STORE_MISMATCH");
        }
    }

    function _storeValidatorEpoch(BankChainClientState.ValidatorEpoch memory epoch, bool makeActive) internal {
        BankChainClientState.ValidatorEpoch storage previous =
            validatorEpochs[epoch.sourceChainId][activeValidatorEpochId[epoch.sourceChainId]];
        if (makeActive && previous.epochHash != bytes32(0)) {
            previous.active = false;
        }

        BankChainClientState.ValidatorEpoch storage stored = validatorEpochs[epoch.sourceChainId][epoch.epochId];
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

    function _storeValidatorEpochCalldata(BankChainClientState.ValidatorEpoch calldata epoch, bool makeActive)
        internal
    {
        BankChainClientState.ValidatorEpoch storage previous =
            validatorEpochs[epoch.sourceChainId][activeValidatorEpochId[epoch.sourceChainId]];
        if (makeActive && previous.epochHash != bytes32(0)) {
            previous.active = false;
        }

        BankChainClientState.ValidatorEpoch storage stored = validatorEpochs[epoch.sourceChainId][epoch.epochId];
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
            address signer = BankChainClientVerifier.recoverDirect(digest, signatures[i]);
            uint256 power = validatorVotingPower[sourceChainId][validatorEpochId][signer];
            if (power == 0) {
                signer = BankChainClientVerifier.recoverEthSigned(digest, signatures[i]);
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
