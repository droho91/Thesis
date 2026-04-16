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
        BankChainClientMessage.Header memory header = _clientHeader(sourceCheckpoint);
        header.sourceBlockHash = bytes32(0);
        header.blockHash = clientB.hashHeader(header);
        bytes32 commitDigest = clientB.hashCommitment(header);
        BankChainClientMessage.ClientMessage memory clientMessage =
            BankChainClientMessage.ClientMessage({header: header});

        vm.expectRevert(bytes("SOURCE_BLOCK_HASH_ZERO"));
        vm.prank(relayer);
        clientB.updateState(clientMessage, _signatures(validatorKeysA, commitDigest, 2));
    }

    function testDuplicateUpdateIsSafelyRejected() public {
        (, uint256 sequence) = _sendLock(12 ether);
        SourceCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint =
            checkpointsA.commitCheckpoint(sequence);
        BankChainClientMessage.Header memory header = _clientHeader(sourceCheckpoint);
        header.blockHash = clientB.hashHeader(header);
        bytes32 commitDigest = clientB.hashCommitment(header);
        BankChainClientMessage.ClientMessage memory clientMessage =
            BankChainClientMessage.ClientMessage({header: header});

        vm.prank(relayer);
        clientB.updateState(clientMessage, _signatures(validatorKeysA, commitDigest, 2));

        vm.expectRevert(bytes("CONSENSUS_STATE_EXISTS"));
        vm.prank(anyRelayer);
        clientB.updateState(clientMessage, _signatures(validatorKeysA, commitDigest, 2));
        assertEq(uint256(clientB.status(CHAIN_A)), uint256(IBCClientTypes.Status.Active));
    }

    function testMisbehaviourFreezesClientAndRecoveryRequiresSuccessorEpoch() public {
        (, uint256 sequence) = _sendLock(15 ether);
        SourceCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint =
            checkpointsA.commitCheckpoint(sequence);
        BankChainClientMessage.Header memory header = _clientHeader(sourceCheckpoint);
        header.blockHash = clientB.hashHeader(header);
        bytes32 commitDigest = clientB.hashCommitment(header);
        BankChainClientMessage.ClientMessage memory clientMessage =
            BankChainClientMessage.ClientMessage({header: header});

        vm.prank(relayer);
        clientB.updateState(clientMessage, _signatures(validatorKeysA, commitDigest, 2));

        BankChainClientMessage.Header memory conflict = header;
        conflict.packetRoot = keccak256("conflicting-root");
        conflict.blockHash = clientB.hashHeader(conflict);
        bytes32 conflictHash = clientB.hashConsensusState(conflict);
        bytes32 conflictDigest = clientB.hashCommitment(conflict);
        BankChainClientMessage.ClientMessage memory conflictMessage =
            BankChainClientMessage.ClientMessage({header: conflict});

        vm.prank(anyRelayer);
        clientB.updateState(conflictMessage, _signatures(validatorKeysA, conflictDigest, 2));

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
        BankChainClientMessage.Header memory header = _clientHeader(sourceCheckpoint);
        header.blockHash = clientB.hashHeader(header);
        bytes32 consensusStateHash = clientB.hashConsensusState(header);
        bytes32 commitDigest = clientB.hashCommitment(header);
        BankChainClientMessage.ClientMessage memory clientMessage =
            BankChainClientMessage.ClientMessage({header: header});

        vm.expectRevert(bytes("VALIDATOR_EPOCH_UNKNOWN"));
        vm.prank(relayer);
        clientB.updateState(clientMessage, _signatures(rotatedValidatorKeysA, commitDigest, 2));

        vm.prank(anyRelayer);
        clientB.updateValidatorEpoch(rotatedEpoch, _signatures(validatorKeysA, rotatedEpoch.epochHash, 2));

        vm.prank(relayer);
        clientB.updateState(clientMessage, _signatures(rotatedValidatorKeysA, commitDigest, 2));
        assertTrue(clientB.isConsensusStateVerified(CHAIN_A, consensusStateHash));
    }

    function testDelayedCheckpointSignedByHistoricalEpochStillUpdatesAfterRotation() public {
        (, uint256 sequence) = _sendLock(20 ether);
        SourceCheckpointRegistry.SourceCheckpoint memory delayedSourceCheckpoint =
            checkpointsA.commitCheckpoint(sequence);
        BankChainClientMessage.Header memory delayedHeader = _clientHeader(delayedSourceCheckpoint);
        delayedHeader.blockHash = clientB.hashHeader(delayedHeader);
        bytes32 delayedConsensusStateHash = clientB.hashConsensusState(delayedHeader);
        bytes32 delayedCommitDigest = clientB.hashCommitment(delayedHeader);
        BankChainClientMessage.ClientMessage memory delayedMessage =
            BankChainClientMessage.ClientMessage({header: delayedHeader});

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
        clientB.updateState(delayedMessage, _signatures(validatorKeysA, delayedCommitDigest, 2));

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
        BankChainClientMessage.Header memory forgedOldEpochHeader = _clientHeader(sourceCheckpoint);
        BankChainClientState.ValidatorEpoch memory oldEpoch =
            clientB.validatorEpoch(CHAIN_A, VALIDATOR_EPOCH_1);
        forgedOldEpochHeader.validatorEpochId = oldEpoch.epochId;
        forgedOldEpochHeader.validatorEpochHash = oldEpoch.epochHash;
        forgedOldEpochHeader.blockHash = clientB.hashHeader(forgedOldEpochHeader);
        bytes32 forgedDigest = clientB.hashCommitment(forgedOldEpochHeader);
        BankChainClientMessage.ClientMessage memory forgedMessage =
            BankChainClientMessage.ClientMessage({header: forgedOldEpochHeader});

        vm.expectRevert(bytes("HEADER_AFTER_EPOCH_SUPERSEDED"));
        vm.prank(relayer);
        clientB.updateState(forgedMessage, _signatures(validatorKeysA, forgedDigest, 2));
    }

    function testVerifyNonMembershipSucceedsForFuturePacketSequence() public {
        (PacketLib.Packet memory packet, uint256 sequence) = _sendLock(10 ether);
        FinalizedPacket memory finalized = _finalizeAtoB(sequence, validatorKeysA, 2);
        packet.sequence = sequence + 1;
        bytes32 absentLeaf = PacketLib.leafHash(packet);
        bytes32 path = IBCPathLib.packetCommitmentPath(CHAIN_A, address(appA), packet.sequence);
        bytes32[] memory emptySiblings = new bytes32[](0);
        IBCClientTypes.NonMembershipProof memory absence = IBCClientTypes.NonMembershipProof({
            sequence: packet.sequence,
            leafIndex: 0,
            witnessedValue: bytes32(0),
            siblings: emptySiblings
        });

        assertTrue(clientB.verifyNonMembership(CHAIN_A, finalized.consensusStateHash, path, absentLeaf, abi.encode(absence)));
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
        bytes32 path = IBCPathLib.packetCommitmentPath(CHAIN_A, address(appA), sequence);
        IBCClientTypes.NonMembershipProof memory absence = IBCClientTypes.NonMembershipProof({
            sequence: sequence,
            leafIndex: witnessedProof.leafIndex,
            witnessedValue: witnessedLeaf,
            siblings: witnessedProof.siblings
        });

        assertTrue(clientB.verifyNonMembership(CHAIN_A, finalized.consensusStateHash, path, absentLeaf, abi.encode(absence)));
    }

    function testInvalidNonMembershipProofFailsForExistingPacket() public {
        (, uint256 sequence) = _sendLock(10 ether);
        FinalizedPacket memory finalized = _finalizeAtoB(sequence, validatorKeysA, 2);
        bytes32 packetLeaf = packetsA.packetLeafAt(sequence);
        bytes32 path = IBCPathLib.packetCommitmentPath(CHAIN_A, address(appA), sequence);
        IBCClientTypes.NonMembershipProof memory absence = IBCClientTypes.NonMembershipProof({
            sequence: sequence,
            leafIndex: finalized.proof.leafIndex,
            witnessedValue: packetLeaf,
            siblings: finalized.proof.siblings
        });

        assertFalse(clientB.verifyNonMembership(CHAIN_A, finalized.consensusStateHash, path, packetLeaf, abi.encode(absence)));
    }

    function testRelayerDefinedTruthCannotAdvanceClient() public {
        (, uint256 sequence) = _sendLock(5 ether);
        SourceCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint =
            checkpointsA.commitCheckpoint(sequence);
        BankChainClientMessage.Header memory header = _clientHeader(sourceCheckpoint);
        header.blockHash = bytes32(0);
        BankChainClientMessage.ClientMessage memory clientMessage =
            BankChainClientMessage.ClientMessage({header: header});

        vm.expectRevert(bytes("BLOCK_HASH_ZERO"));
        vm.prank(relayer);
        clientB.updateState(clientMessage, _signatures(validatorKeysA, bytes32(0), 2));
    }
}
