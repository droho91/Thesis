// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCLocalSimulationBase} from "../helpers/IBCLocalSimulationBase.sol";
import {BankChainClientMessage} from "../../contracts/clients/BankChainClientMessage.sol";
import {BankChainClientState} from "../../contracts/clients/BankChainClientState.sol";
import {IBCClientTypes} from "../../contracts/core/IBCClientTypes.sol";
import {IBCPathLib} from "../../contracts/core/IBCPathLib.sol";
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

        vm.expectRevert(bytes("VALIDATOR_EPOCH_UNKNOWN"));
        vm.prank(relayer);
        clientB.updateState(clientMessage, _signatures(rotatedValidatorKeysA, consensusStateHash, 2));

        vm.prank(anyRelayer);
        clientB.updateValidatorEpoch(rotatedEpoch, _signatures(validatorKeysA, rotatedEpoch.epochHash, 2));

        vm.prank(relayer);
        clientB.updateState(clientMessage, _signatures(rotatedValidatorKeysA, consensusStateHash, 2));
        assertTrue(clientB.isConsensusStateVerified(CHAIN_A, consensusStateHash));
    }

    function testDelayedCheckpointSignedByHistoricalEpochStillUpdatesAfterRotation() public {
        (, uint256 sequence) = _sendLock(20 ether);
        SourceCheckpointRegistry.SourceCheckpoint memory delayedSourceCheckpoint =
            checkpointsA.commitCheckpoint(sequence);
        BankChainClientMessage.Checkpoint memory delayedCheckpoint = _clientCheckpoint(delayedSourceCheckpoint);
        bytes32 delayedConsensusStateHash = clientB.hashConsensusState(delayedCheckpoint);
        BankChainClientMessage.ClientMessage memory delayedMessage =
            BankChainClientMessage.ClientMessage({checkpoint: delayedCheckpoint});

        vm.roll(block.number + 10);
        validatorRegistryA.commitValidatorEpoch(
            VALIDATOR_EPOCH_2,
            _validatorAddresses(rotatedValidatorKeysA),
            _equalPowers(rotatedValidatorKeysA.length)
        );
        BankChainClientState.ValidatorEpoch memory rotatedEpoch =
            _clientEpoch(validatorRegistryA.validatorEpoch(VALIDATOR_EPOCH_2));

        vm.prank(anyRelayer);
        clientB.updateValidatorEpoch(rotatedEpoch, _signatures(validatorKeysA, rotatedEpoch.epochHash, 2));

        vm.prank(relayer);
        clientB.updateState(delayedMessage, _signatures(validatorKeysA, delayedConsensusStateHash, 2));

        assertTrue(clientB.isConsensusStateVerified(CHAIN_A, delayedConsensusStateHash));
        assertEq(clientB.activeValidatorEpochId(CHAIN_A), VALIDATOR_EPOCH_2);
    }

    function testSupersededEpochCannotSignPostRotationCheckpoint() public {
        vm.roll(block.number + 10);
        validatorRegistryA.commitValidatorEpoch(
            VALIDATOR_EPOCH_2,
            _validatorAddresses(rotatedValidatorKeysA),
            _equalPowers(rotatedValidatorKeysA.length)
        );
        BankChainClientState.ValidatorEpoch memory rotatedEpoch =
            _clientEpoch(validatorRegistryA.validatorEpoch(VALIDATOR_EPOCH_2));

        vm.prank(anyRelayer);
        clientB.updateValidatorEpoch(rotatedEpoch, _signatures(validatorKeysA, rotatedEpoch.epochHash, 2));

        vm.roll(block.number + 10);
        (, uint256 sequence) = _sendLock(20 ether);
        SourceCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint =
            checkpointsA.commitCheckpoint(sequence);
        BankChainClientMessage.Checkpoint memory forgedOldEpochCheckpoint = _clientCheckpoint(sourceCheckpoint);
        BankChainClientState.ValidatorEpoch memory oldEpoch =
            clientB.validatorEpoch(CHAIN_A, VALIDATOR_EPOCH_1);
        forgedOldEpochCheckpoint.validatorEpochId = oldEpoch.epochId;
        forgedOldEpochCheckpoint.validatorEpochHash = oldEpoch.epochHash;
        forgedOldEpochCheckpoint.sourceCommitmentHash = clientB.hashSourceCommitment(forgedOldEpochCheckpoint);
        bytes32 forgedHash = clientB.hashConsensusState(forgedOldEpochCheckpoint);
        BankChainClientMessage.ClientMessage memory forgedMessage =
            BankChainClientMessage.ClientMessage({checkpoint: forgedOldEpochCheckpoint});

        vm.expectRevert(bytes("CHECKPOINT_AFTER_EPOCH_SUPERSEDED"));
        vm.prank(relayer);
        clientB.updateState(forgedMessage, _signatures(validatorKeysA, forgedHash, 2));
    }

    function testVerifyNonMembershipSucceedsForFuturePacketSequence() public {
        (PacketLib.Packet memory packet, uint256 sequence) = _sendLock(10 ether);
        FinalizedPacket memory finalized = _finalizeAtoB(sequence, validatorKeysA, 2);
        packet.sequence = sequence + 1;
        bytes32 absentLeaf = PacketLib.leafHash(packet);
        bytes32 path = IBCPathLib.packetAbsencePath(CHAIN_A, address(appA), packet.sequence, absentLeaf);
        bytes32[] memory emptySiblings = new bytes32[](0);
        IBCClientTypes.NonMembershipProof memory absence = IBCClientTypes.NonMembershipProof({
            sequence: packet.sequence,
            sourcePort: address(appA),
            absentLeaf: absentLeaf,
            witnessedLeaf: bytes32(0),
            siblings: emptySiblings
        });

        assertTrue(clientB.verifyNonMembership(CHAIN_A, finalized.consensusStateHash, path, abi.encode(absence)));
    }

    function testVerifyNonMembershipSucceedsWhenDifferentLeafOccupiesSequence() public {
        (PacketLib.Packet memory packet, uint256 sequence) = _sendLock(10 ether);
        (, uint256 secondSequence) = _sendLock(12 ether);
        FinalizedPacket memory finalized = _finalizeAtoB(secondSequence, validatorKeysA, 2);
        PacketLib.Packet memory absentPacket = packet;
        absentPacket.amount = 99 ether;
        bytes32 absentLeaf = PacketLib.leafHash(absentPacket);
        bytes32 witnessedLeaf = packetsA.packetLeafAt(sequence);
        IBCClientTypes.MembershipProof memory witnessedProof =
            _proofFor(packetsA, finalized.sourceCheckpoint, sequence, finalized.consensusStateHash);
        bytes32 path = IBCPathLib.packetAbsencePath(CHAIN_A, address(appA), sequence, absentLeaf);
        IBCClientTypes.NonMembershipProof memory absence = IBCClientTypes.NonMembershipProof({
            sequence: sequence,
            sourcePort: address(appA),
            absentLeaf: absentLeaf,
            witnessedLeaf: witnessedLeaf,
            siblings: witnessedProof.siblings
        });

        assertTrue(clientB.verifyNonMembership(CHAIN_A, finalized.consensusStateHash, path, abi.encode(absence)));
    }

    function testInvalidNonMembershipProofFailsForExistingPacket() public {
        (, uint256 sequence) = _sendLock(10 ether);
        FinalizedPacket memory finalized = _finalizeAtoB(sequence, validatorKeysA, 2);
        bytes32 packetLeaf = packetsA.packetLeafAt(sequence);
        bytes32 path = IBCPathLib.packetAbsencePath(CHAIN_A, address(appA), sequence, packetLeaf);
        IBCClientTypes.NonMembershipProof memory absence = IBCClientTypes.NonMembershipProof({
            sequence: sequence,
            sourcePort: address(appA),
            absentLeaf: packetLeaf,
            witnessedLeaf: packetLeaf,
            siblings: finalized.proof.siblings
        });

        assertFalse(clientB.verifyNonMembership(CHAIN_A, finalized.consensusStateHash, path, abi.encode(absence)));
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
