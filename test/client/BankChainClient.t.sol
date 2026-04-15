// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCLocalSimulationBase} from "../helpers/IBCLocalSimulationBase.sol";
import {BankChainClientMessage} from "../../contracts/clients/BankChainClientMessage.sol";
import {BankChainClientState} from "../../contracts/clients/BankChainClientState.sol";
import {IBCClientTypes} from "../../contracts/core/IBCClientTypes.sol";
import {PacketLib} from "../../contracts/libs/PacketLib.sol";
import {SourceCheckpointRegistry} from "../../contracts/source/SourceCheckpointRegistry.sol";

contract BankChainClientTest is IBCLocalSimulationBase {
    function testClientInitializesCorrectly() public {
        assertEq(uint256(clientB.status(CHAIN_A)), uint256(IBCClientTypes.Status.Active));
        assertEq(clientB.activeValidatorEpochId(CHAIN_A), VALIDATOR_EPOCH_1);
        assertEq(
            clientB.sourceValidatorSetRegistryForChain(CHAIN_A),
            address(validatorRegistryA)
        );

        BankChainClientState.ValidatorEpoch memory epoch =
            clientB.validatorEpoch(CHAIN_A, VALIDATOR_EPOCH_1);
        assertEq(epoch.epochHash, validatorRegistryA.validatorEpoch(VALIDATOR_EPOCH_1).epochHash);
        assertTrue(clientB.knownValidatorEpochHash(CHAIN_A, epoch.epochHash));
    }

    function testValidClientUpdateSucceeds() public {
        (, uint256 sequence) = _sendLock(10 ether);
        FinalizedPacket memory finalized = _finalizeAtoB(sequence, validatorKeysA, 2);

        assertTrue(clientB.isConsensusStateVerified(CHAIN_A, finalized.consensusStateHash));
        assertEq(clientB.latestConsensusStateSequence(CHAIN_A), 1);
        assertEq(clientB.latestPacketSequence(CHAIN_A), sequence);
    }

    function testInvalidClientUpdateFails() public {
        (, uint256 sequence) = _sendLock(10 ether);
        SourceCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint =
            checkpointsA.commitCheckpoint(sequence);
        BankChainClientMessage.Checkpoint memory checkpoint = _clientCheckpoint(sourceCheckpoint);
        checkpoint.sourceBlockHash = bytes32(0);
        checkpoint.sourceCommitmentHash = clientB.hashSourceCommitment(checkpoint);
        bytes32 consensusStateHash = clientB.hashConsensusState(checkpoint);
        BankChainClientMessage.ClientMessage memory clientMessage =
            BankChainClientMessage.ClientMessage({checkpoint: checkpoint});

        vm.expectRevert(bytes("SOURCE_BLOCK_HASH_ZERO"));
        vm.prank(relayer);
        clientB.updateState(clientMessage, _signatures(validatorKeysA, consensusStateHash, 2));
    }

    function testDuplicateUpdateIsSafelyRejected() public {
        (, uint256 sequence) = _sendLock(12 ether);
        SourceCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint =
            checkpointsA.commitCheckpoint(sequence);
        BankChainClientMessage.Checkpoint memory checkpoint = _clientCheckpoint(sourceCheckpoint);
        bytes32 consensusStateHash = clientB.hashConsensusState(checkpoint);
        BankChainClientMessage.ClientMessage memory clientMessage =
            BankChainClientMessage.ClientMessage({checkpoint: checkpoint});

        vm.prank(relayer);
        clientB.updateState(clientMessage, _signatures(validatorKeysA, consensusStateHash, 2));

        vm.expectRevert(bytes("CONSENSUS_STATE_EXISTS"));
        vm.prank(anyRelayer);
        clientB.updateState(clientMessage, _signatures(validatorKeysA, consensusStateHash, 2));
        assertEq(uint256(clientB.status(CHAIN_A)), uint256(IBCClientTypes.Status.Active));
    }

    function testMisbehaviourFreezesClientAndRecoveryRequiresSuccessorEpoch() public {
        (, uint256 sequence) = _sendLock(15 ether);
        SourceCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint =
            checkpointsA.commitCheckpoint(sequence);
        BankChainClientMessage.Checkpoint memory checkpoint = _clientCheckpoint(sourceCheckpoint);
        bytes32 consensusStateHash = clientB.hashConsensusState(checkpoint);
        BankChainClientMessage.ClientMessage memory clientMessage =
            BankChainClientMessage.ClientMessage({checkpoint: checkpoint});

        vm.prank(relayer);
        clientB.updateState(clientMessage, _signatures(validatorKeysA, consensusStateHash, 2));

        BankChainClientMessage.Checkpoint memory conflict = checkpoint;
        conflict.packetRoot = keccak256("conflicting-root");
        conflict.sourceCommitmentHash = clientB.hashSourceCommitment(conflict);
        bytes32 conflictHash = clientB.hashConsensusState(conflict);
        BankChainClientMessage.ClientMessage memory conflictMessage =
            BankChainClientMessage.ClientMessage({checkpoint: conflict});

        vm.prank(anyRelayer);
        clientB.updateState(conflictMessage, _signatures(validatorKeysA, conflictHash, 2));

        assertEq(uint256(clientB.status(CHAIN_A)), uint256(IBCClientTypes.Status.Frozen));
        assertEq(clientB.conflictingConsensusStateHashBySequence(CHAIN_A, 1), conflictHash);
        (,,,,,, bool evidenceExists) = clientB.frozenEvidence(CHAIN_A);
        assertTrue(evidenceExists);

        clientB.beginRecovery(CHAIN_A);
        assertEq(uint256(clientB.status(CHAIN_A)), uint256(IBCClientTypes.Status.Recovering));

        validatorRegistryA.commitValidatorEpoch(
            VALIDATOR_EPOCH_2,
            _validatorAddresses(rotatedValidatorKeysA),
            _equalPowers(rotatedValidatorKeysA.length)
        );
        BankChainClientState.ValidatorEpoch memory recoveryEpoch =
            _clientEpoch(validatorRegistryA.validatorEpoch(VALIDATOR_EPOCH_2));

        vm.prank(anyRelayer);
        clientB.updateValidatorEpoch(recoveryEpoch, _signatures(validatorKeysA, recoveryEpoch.epochHash, 2));
        assertEq(uint256(clientB.status(CHAIN_A)), uint256(IBCClientTypes.Status.Active));
        assertEq(clientB.activeValidatorEpochId(CHAIN_A), VALIDATOR_EPOCH_2);
    }

    function testValidatorRotationRequiresSourceCertifiedEpochBeforeUpdate() public {
        validatorRegistryA.commitValidatorEpoch(
            VALIDATOR_EPOCH_2,
            _validatorAddresses(rotatedValidatorKeysA),
            _equalPowers(rotatedValidatorKeysA.length)
        );
        BankChainClientState.ValidatorEpoch memory rotatedEpoch =
            _clientEpoch(validatorRegistryA.validatorEpoch(VALIDATOR_EPOCH_2));

        (, uint256 sequence) = _sendLock(20 ether);
        SourceCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint =
            checkpointsA.commitCheckpoint(sequence);
        BankChainClientMessage.Checkpoint memory checkpoint = _clientCheckpoint(sourceCheckpoint);
        bytes32 consensusStateHash = clientB.hashConsensusState(checkpoint);
        BankChainClientMessage.ClientMessage memory clientMessage =
            BankChainClientMessage.ClientMessage({checkpoint: checkpoint});

        vm.expectRevert(bytes("VALIDATOR_EPOCH_INACTIVE"));
        vm.prank(relayer);
        clientB.updateState(clientMessage, _signatures(rotatedValidatorKeysA, consensusStateHash, 2));

        vm.prank(anyRelayer);
        clientB.updateValidatorEpoch(rotatedEpoch, _signatures(validatorKeysA, rotatedEpoch.epochHash, 2));

        vm.prank(relayer);
        clientB.updateState(clientMessage, _signatures(rotatedValidatorKeysA, consensusStateHash, 2));
        assertTrue(clientB.isConsensusStateVerified(CHAIN_A, consensusStateHash));
    }

    function testRelayerDefinedTruthCannotAdvanceClient() public {
        (, uint256 sequence) = _sendLock(5 ether);
        SourceCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint =
            checkpointsA.commitCheckpoint(sequence);
        BankChainClientMessage.Checkpoint memory checkpoint = _clientCheckpoint(sourceCheckpoint);
        checkpoint.sourceCommitmentHash = bytes32(0);
        bytes32 consensusStateHash = clientB.hashConsensusState(checkpoint);
        BankChainClientMessage.ClientMessage memory clientMessage =
            BankChainClientMessage.ClientMessage({checkpoint: checkpoint});

        vm.expectRevert(bytes("SOURCE_COMMITMENT_ZERO"));
        vm.prank(relayer);
        clientB.updateState(clientMessage, _signatures(validatorKeysA, consensusStateHash, 2));
    }
}
