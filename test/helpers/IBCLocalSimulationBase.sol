// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BankToken} from "../../contracts/apps/BankToken.sol";
import {EscrowVault} from "../../contracts/apps/EscrowVault.sol";
import {MinimalTransferApp} from "../../contracts/apps/MinimalTransferApp.sol";
import {VoucherToken} from "../../contracts/apps/VoucherToken.sol";
import {VoucherLendingPool} from "../../contracts/apps/VoucherLendingPool.sol";
import {BankChainClient} from "../../contracts/clients/BankChainClient.sol";
import {BankChainClientMessage} from "../../contracts/clients/BankChainClientMessage.sol";
import {BankChainClientState} from "../../contracts/clients/BankChainClientState.sol";
import {IBCClientTypes} from "../../contracts/core/IBCClientTypes.sol";
import {IBCPacketHandler} from "../../contracts/core/IBCPacketHandler.sol";
import {PacketLib} from "../../contracts/libs/PacketLib.sol";
import {SourceCheckpointRegistry} from "../../contracts/source/SourceCheckpointRegistry.sol";
import {SourcePacketCommitment} from "../../contracts/source/SourcePacketCommitment.sol";
import {SourceValidatorEpochRegistry} from "../../contracts/source/SourceValidatorEpochRegistry.sol";

abstract contract IBCLocalSimulationBase is Test {
    uint256 internal constant CHAIN_A = 100;
    uint256 internal constant CHAIN_B = 200;
    uint256 internal constant VALIDATOR_EPOCH_1 = 1;
    uint256 internal constant VALIDATOR_EPOCH_2 = 2;

    address internal user = address(0x1111);
    address internal relayer = address(0x2222);
    address internal anyRelayer = address(0x3333);

    uint256[] internal validatorKeysA;
    uint256[] internal validatorKeysB;
    uint256[] internal rotatedValidatorKeysA;

    SourcePacketCommitment internal packetsA;
    SourcePacketCommitment internal packetsB;
    SourceValidatorEpochRegistry internal validatorRegistryA;
    SourceValidatorEpochRegistry internal validatorRegistryB;
    SourceCheckpointRegistry internal checkpointsA;
    SourceCheckpointRegistry internal checkpointsB;
    BankChainClient internal clientA;
    BankChainClient internal clientB;
    IBCPacketHandler internal handlerA;
    IBCPacketHandler internal handlerB;
    BankToken internal canonicalA;
    BankToken internal stableB;
    EscrowVault internal escrowA;
    VoucherToken internal voucherB;
    VoucherLendingPool internal lendingB;
    MinimalTransferApp internal appA;
    MinimalTransferApp internal appB;

    struct FinalizedPacket {
        bytes32 consensusStateHash;
        IBCClientTypes.MembershipProof proof;
        SourceCheckpointRegistry.SourceCheckpoint sourceCheckpoint;
    }

    function setUp() public virtual {
        validatorKeysA.push(101);
        validatorKeysA.push(102);
        validatorKeysA.push(103);
        validatorKeysB.push(201);
        validatorKeysB.push(202);
        validatorKeysB.push(203);
        rotatedValidatorKeysA.push(301);
        rotatedValidatorKeysA.push(302);
        rotatedValidatorKeysA.push(303);

        packetsA = new SourcePacketCommitment(CHAIN_A);
        packetsB = new SourcePacketCommitment(CHAIN_B);
        validatorRegistryA = new SourceValidatorEpochRegistry(
            CHAIN_A,
            VALIDATOR_EPOCH_1,
            _validatorAddresses(validatorKeysA),
            _equalPowers(validatorKeysA.length)
        );
        validatorRegistryB = new SourceValidatorEpochRegistry(
            CHAIN_B,
            VALIDATOR_EPOCH_1,
            _validatorAddresses(validatorKeysB),
            _equalPowers(validatorKeysB.length)
        );
        checkpointsA = new SourceCheckpointRegistry(CHAIN_A, address(packetsA), address(validatorRegistryA));
        checkpointsB = new SourceCheckpointRegistry(CHAIN_B, address(packetsB), address(validatorRegistryB));

        clientA = new BankChainClient(_clientEpoch(validatorRegistryB.validatorEpoch(VALIDATOR_EPOCH_1)));
        clientB = new BankChainClient(_clientEpoch(validatorRegistryA.validatorEpoch(VALIDATOR_EPOCH_1)));
        handlerA = new IBCPacketHandler(CHAIN_A, address(clientA));
        handlerB = new IBCPacketHandler(CHAIN_B, address(clientB));

        canonicalA = new BankToken("Bank A Deposit Token", "aBANK");
        stableB = new BankToken("Bank B Stable Token", "sBANK");
        escrowA = new EscrowVault(address(canonicalA));
        voucherB = new VoucherToken("Voucher for Bank A Deposit", "vA");
        lendingB = new VoucherLendingPool(address(voucherB), address(stableB), 5_000);
        appA = new MinimalTransferApp(CHAIN_A, address(packetsA), address(handlerA), address(escrowA), address(0));
        appB = new MinimalTransferApp(CHAIN_B, address(packetsB), address(handlerB), address(0), address(voucherB));

        packetsA.grantRole(packetsA.PACKET_COMMITTER_ROLE(), address(appA));
        packetsB.grantRole(packetsB.PACKET_COMMITTER_ROLE(), address(appB));
        escrowA.grantApp(address(appA));
        voucherB.grantApp(address(appB));
        appA.configureRemoteApp(CHAIN_B, address(appB));
        appB.configureRemoteApp(CHAIN_A, address(appA));

        canonicalA.mint(user, 1_000 ether);
        stableB.mint(address(lendingB), 1_000 ether);
        vm.prank(user);
        canonicalA.approve(address(escrowA), type(uint256).max);
    }

    function _sendLock(uint256 amount) internal returns (PacketLib.Packet memory packet, uint256 sequence) {
        vm.prank(user);
        appA.sendTransfer(CHAIN_B, user, amount);
        sequence = packetsA.packetSequence();
        packet = PacketLib.Packet({
            sequence: sequence,
            sourceChainId: CHAIN_A,
            destinationChainId: CHAIN_B,
            sourcePort: address(appA),
            destinationPort: address(appB),
            sender: user,
            recipient: user,
            asset: address(canonicalA),
            amount: amount,
            action: PacketLib.ACTION_LOCK_MINT,
            memo: bytes32(0)
        });
    }

    function _sendBurn(uint256 amount) internal returns (PacketLib.Packet memory packet, uint256 sequence) {
        vm.prank(user);
        appB.burnAndRelease(CHAIN_A, user, amount);
        sequence = packetsB.packetSequence();
        packet = PacketLib.Packet({
            sequence: sequence,
            sourceChainId: CHAIN_B,
            destinationChainId: CHAIN_A,
            sourcePort: address(appB),
            destinationPort: address(appA),
            sender: user,
            recipient: user,
            asset: address(voucherB),
            amount: amount,
            action: PacketLib.ACTION_BURN_UNLOCK,
            memo: bytes32(0)
        });
    }

    function _finalizeAtoB(uint256 packetSequence, uint256[] storage signerKeys, uint256 signerCount)
        internal
        returns (FinalizedPacket memory finalized)
    {
        return _finalize(checkpointsA, packetsA, clientB, CHAIN_A, packetSequence, signerKeys, signerCount);
    }

    function _finalizeBtoA(uint256 packetSequence, uint256[] storage signerKeys, uint256 signerCount)
        internal
        returns (FinalizedPacket memory finalized)
    {
        return _finalize(checkpointsB, packetsB, clientA, CHAIN_B, packetSequence, signerKeys, signerCount);
    }

    function _finalize(
        SourceCheckpointRegistry registry,
        SourcePacketCommitment packetStore,
        BankChainClient client,
        uint256 sourceChainId,
        uint256 packetSequence,
        uint256[] storage signerKeys,
        uint256 signerCount
    ) internal returns (FinalizedPacket memory finalized) {
        SourceCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint =
            registry.commitCheckpoint(packetStore.packetSequence());
        BankChainClientMessage.Checkpoint memory checkpoint = _clientCheckpoint(sourceCheckpoint);
        bytes32 consensusStateHash = client.hashConsensusState(checkpoint);
        BankChainClientMessage.ClientMessage memory clientMessage =
            BankChainClientMessage.ClientMessage({checkpoint: checkpoint});

        vm.prank(relayer);
        client.updateState(clientMessage, _signatures(signerKeys, consensusStateHash, signerCount));

        finalized = FinalizedPacket({
            consensusStateHash: consensusStateHash,
            proof: _proofFor(packetStore, sourceCheckpoint, packetSequence, consensusStateHash),
            sourceCheckpoint: sourceCheckpoint
        });
        assertEq(sourceCheckpoint.sourceChainId, sourceChainId);
    }

    function _proofFor(
        SourcePacketCommitment packetStore,
        SourceCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint,
        uint256 packetSequence,
        bytes32 consensusStateHash
    ) internal view returns (IBCClientTypes.MembershipProof memory proof) {
        require(packetSequence >= sourceCheckpoint.firstPacketSequence, "PACKET_BEFORE_CHECKPOINT");
        require(packetSequence <= sourceCheckpoint.lastPacketSequence, "PACKET_AFTER_CHECKPOINT");
        uint256 leafIndex = packetSequence - sourceCheckpoint.firstPacketSequence;
        bytes32[] memory leaves = _leavesFor(packetStore, sourceCheckpoint);
        bytes32[] memory siblings = _buildMerkleProof(leaves, leafIndex);
        return IBCClientTypes.MembershipProof({
            consensusStateHash: consensusStateHash,
            leafIndex: leafIndex,
            siblings: siblings
        });
    }

    function _leavesFor(
        SourcePacketCommitment packetStore,
        SourceCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint
    ) internal view returns (bytes32[] memory leaves) {
        leaves = new bytes32[](sourceCheckpoint.packetCount);
        for (uint256 i = 0; i < sourceCheckpoint.packetCount; i++) {
            leaves[i] = packetStore.packetLeafAt(sourceCheckpoint.firstPacketSequence + i);
        }
    }

    function _buildMerkleProof(bytes32[] memory leaves, uint256 leafIndex)
        internal
        pure
        returns (bytes32[] memory siblings)
    {
        require(leafIndex < leaves.length, "LEAF_INDEX_OOB");
        uint256 proofLength;
        uint256 levelLength = leaves.length;
        while (levelLength > 1) {
            proofLength++;
            levelLength = (levelLength + 1) / 2;
        }

        siblings = new bytes32[](proofLength);
        bytes32[] memory level = leaves;
        uint256 index = leafIndex;
        uint256 siblingCount;
        while (level.length > 1) {
            uint256 siblingIndex = index % 2 == 0 ? index + 1 : index - 1;
            siblings[siblingCount] = siblingIndex < level.length ? level[siblingIndex] : level[index];
            siblingCount++;

            uint256 nextLength = (level.length + 1) / 2;
            bytes32[] memory next = new bytes32[](nextLength);
            for (uint256 i = 0; i < nextLength; i++) {
                uint256 leftIndex = i * 2;
                bytes32 left = level[leftIndex];
                bytes32 right = leftIndex + 1 < level.length ? level[leftIndex + 1] : left;
                next[i] = keccak256(abi.encodePacked(left, right));
            }
            index = index / 2;
            level = next;
        }
    }

    function _clientCheckpoint(SourceCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint)
        internal
        pure
        returns (BankChainClientMessage.Checkpoint memory)
    {
        return BankChainClientMessage.Checkpoint({
            sourceChainId: sourceCheckpoint.sourceChainId,
            sourceCheckpointRegistry: sourceCheckpoint.sourceCheckpointRegistry,
            sourcePacketCommitment: sourceCheckpoint.sourcePacketCommitment,
            sourceValidatorSetRegistry: sourceCheckpoint.sourceValidatorSetRegistry,
            validatorEpochId: sourceCheckpoint.validatorEpochId,
            validatorEpochHash: sourceCheckpoint.validatorEpochHash,
            sequence: sourceCheckpoint.sequence,
            parentCheckpointHash: sourceCheckpoint.parentCheckpointHash,
            packetRoot: sourceCheckpoint.packetRoot,
            firstPacketSequence: sourceCheckpoint.firstPacketSequence,
            lastPacketSequence: sourceCheckpoint.lastPacketSequence,
            packetCount: sourceCheckpoint.packetCount,
            packetAccumulator: sourceCheckpoint.packetAccumulator,
            sourceBlockNumber: sourceCheckpoint.sourceBlockNumber,
            sourceBlockHash: sourceCheckpoint.sourceBlockHash,
            timestamp: sourceCheckpoint.timestamp,
            sourceCommitmentHash: sourceCheckpoint.sourceCommitmentHash
        });
    }

    function _clientEpoch(SourceValidatorEpochRegistry.ValidatorEpoch memory sourceEpoch)
        internal
        pure
        returns (BankChainClientState.ValidatorEpoch memory)
    {
        return BankChainClientState.ValidatorEpoch({
            sourceChainId: sourceEpoch.sourceChainId,
            sourceValidatorSetRegistry: sourceEpoch.sourceValidatorSetRegistry,
            epochId: sourceEpoch.epochId,
            parentEpochHash: sourceEpoch.parentEpochHash,
            validators: sourceEpoch.validators,
            votingPowers: sourceEpoch.votingPowers,
            totalVotingPower: sourceEpoch.totalVotingPower,
            quorumNumerator: sourceEpoch.quorumNumerator,
            quorumDenominator: sourceEpoch.quorumDenominator,
            activationBlockNumber: sourceEpoch.activationBlockNumber,
            activationBlockHash: sourceEpoch.activationBlockHash,
            timestamp: sourceEpoch.timestamp,
            epochHash: sourceEpoch.epochHash,
            active: sourceEpoch.active
        });
    }

    function _validatorAddresses(uint256[] storage validatorKeys) internal view returns (address[] memory validators) {
        validators = new address[](validatorKeys.length);
        for (uint256 i = 0; i < validatorKeys.length; i++) {
            validators[i] = vm.addr(validatorKeys[i]);
        }
    }

    function _equalPowers(uint256 count) internal pure returns (uint256[] memory powers) {
        powers = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            powers[i] = 1;
        }
    }

    function _signatures(uint256[] storage signerKeys, bytes32 digest, uint256 count)
        internal
        returns (bytes[] memory signatures)
    {
        signatures = new bytes[](count);
        for (uint256 i = 0; i < count; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKeys[i], digest);
            signatures[i] = abi.encodePacked(r, s, v);
        }
    }
}
