// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BankToken} from "../../contracts/apps/BankToken.sol";
import {CrossChainLendingPool} from "../../contracts/apps/CrossChainLendingPool.sol";
import {EscrowVault} from "../../contracts/apps/EscrowVault.sol";
import {MinimalTransferApp} from "../../contracts/apps/MinimalTransferApp.sol";
import {VoucherToken} from "../../contracts/apps/VoucherToken.sol";
import {BankChainClient} from "../../contracts/clients/BankChainClient.sol";
import {BankChainClientMessage} from "../../contracts/clients/BankChainClientMessage.sol";
import {BankChainClientState} from "../../contracts/clients/BankChainClientState.sol";
import {IBCEVMTypes} from "../../contracts/core/IBCEVMTypes.sol";
import {IBCClientTypes} from "../../contracts/core/IBCClientTypes.sol";
import {IBCPacketHandler} from "../../contracts/core/IBCPacketHandler.sol";
import {IBCPathLib} from "../../contracts/core/IBCPathLib.sol";
import {PacketLib} from "../../contracts/libs/PacketLib.sol";
import {SourceCheckpointRegistry} from "../../contracts/source/SourceCheckpointRegistry.sol";
import {SourcePacketCommitment} from "../../contracts/source/SourcePacketCommitment.sol";
import {SourcePacketCommitmentSlots} from "../../contracts/source/SourcePacketCommitmentSlots.sol";
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
    EscrowVault internal escrowA;
    VoucherToken internal voucherB;
    BankToken internal bankLiquidityB;
    CrossChainLendingPool internal lendingPoolB;
    MinimalTransferApp internal appA;
    MinimalTransferApp internal appB;

    struct FinalizedPacket {
        bytes32 consensusStateHash;
        IBCClientTypes.MembershipProof proof;
        SourceCheckpointRegistry.SourceCheckpoint sourceCheckpoint;
    }

    struct StorageFinalizedPacket {
        bytes32 consensusStateHash;
        IBCEVMTypes.StorageProof leafProof;
        IBCEVMTypes.StorageProof pathProof;
        SourceCheckpointRegistry.SourceCheckpoint sourceCheckpoint;
    }

    struct BuiltPacketStorageProof {
        bytes32 stateRoot;
        bytes32 leafSlot;
        bytes32 pathSlot;
        bytes[] accountProof;
        bytes[] leafStorageProof;
        bytes[] pathStorageProof;
        bytes expectedLeafTrieValue;
        bytes expectedPathTrieValue;
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
        escrowA = new EscrowVault(address(canonicalA));
        voucherB = new VoucherToken("Voucher for Bank A Deposit", "vA");
        bankLiquidityB = new BankToken("Bank B Credit Token", "bCASH");
        lendingPoolB = new CrossChainLendingPool(address(voucherB), address(bankLiquidityB), 5_000);
        appA = new MinimalTransferApp(CHAIN_A, address(packetsA), address(handlerA), address(escrowA), address(0));
        appB = new MinimalTransferApp(CHAIN_B, address(packetsB), address(handlerB), address(0), address(voucherB));

        packetsA.grantRole(packetsA.PACKET_COMMITTER_ROLE(), address(appA));
        packetsB.grantRole(packetsB.PACKET_COMMITTER_ROLE(), address(appB));
        escrowA.grantApp(address(appA));
        voucherB.grantApp(address(appB));
        appA.configureRemoteApp(CHAIN_B, address(appB));
        appB.configureRemoteApp(CHAIN_A, address(appA));

        canonicalA.mint(user, 1_000 ether);
        bankLiquidityB.mint(address(lendingPoolB), 10_000 ether);
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

    function _finalizeAtoBForStorageProof(uint256 packetSequence, uint256[] storage signerKeys, uint256 signerCount)
        internal
        returns (StorageFinalizedPacket memory finalized)
    {
        return _finalizeForStorageProof(checkpointsA, packetsA, clientB, CHAIN_A, packetSequence, signerKeys, signerCount);
    }

    function _finalizeBtoAForStorageProof(uint256 packetSequence, uint256[] storage signerKeys, uint256 signerCount)
        internal
        returns (StorageFinalizedPacket memory finalized)
    {
        return _finalizeForStorageProof(checkpointsB, packetsB, clientA, CHAIN_B, packetSequence, signerKeys, signerCount);
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
        BankChainClientMessage.Header memory header = _clientHeader(sourceCheckpoint);
        header.blockHash = client.hashHeader(header);
        bytes32 consensusStateHash = client.hashConsensusState(header);
        bytes32 commitDigest = client.hashCommitment(header);
        BankChainClientMessage.ClientMessage memory clientMessage =
            BankChainClientMessage.ClientMessage({header: header});

        vm.prank(relayer);
        client.updateState(clientMessage, _signatures(signerKeys, commitDigest, signerCount));

        finalized = FinalizedPacket({
            consensusStateHash: consensusStateHash,
            proof: _proofFor(packetStore, sourceCheckpoint, packetSequence, consensusStateHash),
            sourceCheckpoint: sourceCheckpoint
        });
        assertEq(sourceCheckpoint.sourceChainId, sourceChainId);
    }

    function _finalizeForStorageProof(
        SourceCheckpointRegistry registry,
        SourcePacketCommitment packetStore,
        BankChainClient client,
        uint256 sourceChainId,
        uint256 packetSequence,
        uint256[] storage signerKeys,
        uint256 signerCount
    ) internal returns (StorageFinalizedPacket memory finalized) {
        SourceCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint =
            registry.commitCheckpoint(packetStore.packetSequence());
        BuiltPacketStorageProof memory built = _buildPacketStorageProof(packetStore, packetSequence);
        BankChainClientMessage.Header memory header = _clientHeader(sourceCheckpoint);
        header.executionStateRoot = built.stateRoot;
        header.blockHash = client.hashHeader(header);
        bytes32 consensusStateHash = client.hashConsensusState(header);
        bytes32 commitDigest = client.hashCommitment(header);
        BankChainClientMessage.ClientMessage memory clientMessage =
            BankChainClientMessage.ClientMessage({header: header});

        vm.prank(relayer);
        client.updateState(clientMessage, _signatures(signerKeys, commitDigest, signerCount));

        finalized = StorageFinalizedPacket({
            consensusStateHash: consensusStateHash,
            leafProof: IBCEVMTypes.StorageProof({
                sourceChainId: sourceChainId,
                consensusStateHash: consensusStateHash,
                stateRoot: built.stateRoot,
                account: address(packetStore),
                storageKey: built.leafSlot,
                expectedValue: built.expectedLeafTrieValue,
                accountProof: built.accountProof,
                storageProof: built.leafStorageProof
            }),
            pathProof: IBCEVMTypes.StorageProof({
                sourceChainId: sourceChainId,
                consensusStateHash: consensusStateHash,
                stateRoot: built.stateRoot,
                account: address(packetStore),
                storageKey: built.pathSlot,
                expectedValue: built.expectedPathTrieValue,
                accountProof: built.accountProof,
                storageProof: built.pathStorageProof
            }),
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
        bytes32[] memory leaves = _stateLeavesFor(packetStore, sourceCheckpoint);
        bytes32[] memory siblings = _buildMerkleProof(leaves, leafIndex);
        return IBCClientTypes.MembershipProof({
            consensusStateHash: consensusStateHash,
            leafIndex: leafIndex,
            siblings: siblings
        });
    }

    function _stateLeavesFor(
        SourcePacketCommitment packetStore,
        SourceCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint
    ) internal view returns (bytes32[] memory leaves) {
        leaves = new bytes32[](sourceCheckpoint.packetCount);
        for (uint256 i = 0; i < sourceCheckpoint.packetCount; i++) {
            uint256 sequence = sourceCheckpoint.firstPacketSequence + i;
            leaves[i] = IBCPathLib.stateLeaf(packetStore.packetPathAt(sequence), packetStore.packetLeafAt(sequence));
        }
    }

    function _buildPacketStorageProof(SourcePacketCommitment packetStore, uint256 packetSequence)
        private
        view
        returns (BuiltPacketStorageProof memory built)
    {
        built.leafSlot = SourcePacketCommitmentSlots.packetLeafAt(packetSequence);
        built.pathSlot = SourcePacketCommitmentSlots.packetPathAt(packetSequence);

        bytes32 packetLeaf = packetStore.packetLeafAt(packetSequence);
        bytes32 packetPath = packetStore.packetPathAt(packetSequence);
        bytes32 storageRoot;
        (
            storageRoot,
            built.leafStorageProof,
            built.pathStorageProof,
            built.expectedLeafTrieValue,
            built.expectedPathTrieValue
        ) = _buildDualStorageTrie(built.leafSlot, packetLeaf, built.pathSlot, packetPath);

        bytes memory accountValue = _mptAccountValue(storageRoot);
        bytes memory accountLeaf = _mptRlpEncodeList(
            _mptPair(
                _mptCompactPath(_mptNibbles(abi.encodePacked(keccak256(abi.encodePacked(address(packetStore))))), true),
                accountValue
            )
        );

        built.stateRoot = keccak256(accountLeaf);
        built.accountProof = new bytes[](1);
        built.accountProof[0] = accountLeaf;
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

    function _buildDualStorageTrie(bytes32 keyA, bytes32 wordA, bytes32 keyB, bytes32 wordB)
        private
        pure
        returns (
            bytes32 root,
            bytes[] memory proofA,
            bytes[] memory proofB,
            bytes memory valueA,
            bytes memory valueB
        )
    {
        bytes memory pathA = _mptNibbles(abi.encodePacked(keccak256(abi.encodePacked(keyA))));
        bytes memory pathB = _mptNibbles(abi.encodePacked(keccak256(abi.encodePacked(keyB))));
        uint256 commonPrefix = _mptCommonPrefixLength(pathA, pathB);
        require(commonPrefix < pathA.length, "IDENTICAL_STORAGE_PATHS");

        valueA = _mptRlpEncodeBytes(abi.encodePacked(wordA));
        valueB = _mptRlpEncodeBytes(abi.encodePacked(wordB));

        bytes memory leafA = _mptRlpEncodeList(
            _mptPair(_mptCompactPath(_mptSlice(pathA, commonPrefix + 1, pathA.length - commonPrefix - 1), true), valueA)
        );
        bytes memory leafB = _mptRlpEncodeList(
            _mptPair(_mptCompactPath(_mptSlice(pathB, commonPrefix + 1, pathB.length - commonPrefix - 1), true), valueB)
        );

        bytes[] memory branchItems = new bytes[](17);
        for (uint256 i = 0; i < 17; i++) {
            branchItems[i] = _mptRlpEncodeBytes("");
        }
        branchItems[uint8(pathA[commonPrefix])] = _mptRlpEncodeBytes(_mptChildReference(leafA));
        branchItems[uint8(pathB[commonPrefix])] = _mptRlpEncodeBytes(_mptChildReference(leafB));
        bytes memory branchNode = _mptRlpEncodeList(branchItems);

        if (commonPrefix == 0) {
            root = keccak256(branchNode);
            proofA = new bytes[](2);
            proofA[0] = branchNode;
            proofA[1] = leafA;
            proofB = new bytes[](2);
            proofB[0] = branchNode;
            proofB[1] = leafB;
            return (root, proofA, proofB, valueA, valueB);
        }

        bytes memory extensionNode = _mptRlpEncodeList(
            _mptPair(_mptCompactPath(_mptSlice(pathA, 0, commonPrefix), false), _mptChildReference(branchNode))
        );
        root = keccak256(extensionNode);
        proofA = new bytes[](3);
        proofA[0] = extensionNode;
        proofA[1] = branchNode;
        proofA[2] = leafA;
        proofB = new bytes[](3);
        proofB[0] = extensionNode;
        proofB[1] = branchNode;
        proofB[2] = leafB;
    }

    function _mptAccountValue(bytes32 storageRoot) private pure returns (bytes memory) {
        bytes[] memory items = new bytes[](4);
        items[0] = _mptRlpEncodeBytes(hex"01");
        items[1] = _mptRlpEncodeBytes("");
        items[2] = _mptRlpEncodeBytes(abi.encodePacked(storageRoot));
        items[3] = _mptRlpEncodeBytes(abi.encodePacked(keccak256("")));
        return _mptRlpEncodeList(items);
    }

    function _mptPair(bytes memory a, bytes memory b) private pure returns (bytes[] memory items) {
        items = new bytes[](2);
        items[0] = _mptRlpEncodeBytes(a);
        items[1] = _mptRlpEncodeBytes(b);
    }

    function _mptChildReference(bytes memory node) private pure returns (bytes memory) {
        return node.length < 32 ? node : abi.encodePacked(keccak256(node));
    }

    function _mptCommonPrefixLength(bytes memory a, bytes memory b) private pure returns (uint256 prefix) {
        uint256 max = a.length < b.length ? a.length : b.length;
        while (prefix < max && a[prefix] == b[prefix]) {
            prefix++;
        }
    }

    function _mptSlice(bytes memory input, uint256 start, uint256 length) private pure returns (bytes memory out) {
        out = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            out[i] = input[start + i];
        }
    }

    function _mptCompactPath(bytes memory nibbles_, bool isLeaf) private pure returns (bytes memory compact) {
        uint8 flags = isLeaf ? 2 : 0;
        bool oddLength = nibbles_.length % 2 == 1;
        uint256 compactLength = oddLength ? (nibbles_.length + 1) / 2 : (nibbles_.length / 2) + 1;
        compact = new bytes(compactLength);

        uint256 nibbleOffset;
        uint256 compactIndex = 1;
        if (oddLength) {
            compact[0] = bytes1((flags + 1) << 4 | uint8(nibbles_[0]));
            nibbleOffset = 1;
        } else {
            compact[0] = bytes1(flags << 4);
        }

        for (uint256 i = nibbleOffset; i < nibbles_.length; i += 2) {
            compact[compactIndex] = bytes1((uint8(nibbles_[i]) << 4) | uint8(nibbles_[i + 1]));
            compactIndex++;
        }
    }

    function _mptNibbles(bytes memory raw) private pure returns (bytes memory out) {
        out = new bytes(raw.length * 2);
        for (uint256 i = 0; i < raw.length; i++) {
            uint8 value = uint8(raw[i]);
            out[2 * i] = bytes1(value >> 4);
            out[2 * i + 1] = bytes1(value & 0x0f);
        }
    }

    function _mptRlpEncodeBytes(bytes memory raw) private pure returns (bytes memory out) {
        if (raw.length == 1 && uint8(raw[0]) < 0x80) {
            return raw;
        }

        if (raw.length <= 55) {
            out = new bytes(1 + raw.length);
            out[0] = bytes1(uint8(0x80 + raw.length));
            for (uint256 i = 0; i < raw.length; i++) {
                out[i + 1] = raw[i];
            }
            return out;
        }

        bytes memory lengthBytes = _mptEncodeLength(raw.length);
        out = new bytes(1 + lengthBytes.length + raw.length);
        out[0] = bytes1(uint8(0xb7 + lengthBytes.length));
        for (uint256 i = 0; i < lengthBytes.length; i++) {
            out[i + 1] = lengthBytes[i];
        }
        for (uint256 i = 0; i < raw.length; i++) {
            out[1 + lengthBytes.length + i] = raw[i];
        }
    }

    function _mptRlpEncodeList(bytes[] memory items) private pure returns (bytes memory out) {
        bytes memory payload;
        for (uint256 i = 0; i < items.length; i++) {
            payload = bytes.concat(payload, items[i]);
        }

        if (payload.length <= 55) {
            out = new bytes(1 + payload.length);
            out[0] = bytes1(uint8(0xc0 + payload.length));
            for (uint256 i = 0; i < payload.length; i++) {
                out[i + 1] = payload[i];
            }
            return out;
        }

        bytes memory lengthBytes = _mptEncodeLength(payload.length);
        out = new bytes(1 + lengthBytes.length + payload.length);
        out[0] = bytes1(uint8(0xf7 + lengthBytes.length));
        for (uint256 i = 0; i < lengthBytes.length; i++) {
            out[i + 1] = lengthBytes[i];
        }
        for (uint256 i = 0; i < payload.length; i++) {
            out[1 + lengthBytes.length + i] = payload[i];
        }
    }

    function _mptEncodeLength(uint256 value) private pure returns (bytes memory out) {
        uint256 temp = value;
        uint256 length;
        while (temp != 0) {
            length++;
            temp >>= 8;
        }
        out = new bytes(length);
        for (uint256 i = length; i > 0; i--) {
            out[i - 1] = bytes1(uint8(value));
            value >>= 8;
        }
    }

    function _clientHeader(SourceCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint)
        internal
        pure
        returns (BankChainClientMessage.Header memory)
    {
        return BankChainClientMessage.Header({
            sourceChainId: sourceCheckpoint.sourceChainId,
            sourceHeaderProducer: sourceCheckpoint.sourceCheckpointRegistry,
            sourcePacketCommitment: sourceCheckpoint.sourcePacketCommitment,
            sourceValidatorSetRegistry: sourceCheckpoint.sourceValidatorSetRegistry,
            validatorEpochId: sourceCheckpoint.validatorEpochId,
            validatorEpochHash: sourceCheckpoint.validatorEpochHash,
            height: sourceCheckpoint.sequence,
            parentHash: sourceCheckpoint.parentCheckpointHash,
            packetRoot: sourceCheckpoint.packetRoot,
            stateRoot: sourceCheckpoint.stateRoot,
            executionStateRoot: bytes32(0),
            firstPacketSequence: sourceCheckpoint.firstPacketSequence,
            lastPacketSequence: sourceCheckpoint.lastPacketSequence,
            packetCount: sourceCheckpoint.packetCount,
            packetAccumulator: sourceCheckpoint.packetAccumulator,
            sourceBlockNumber: sourceCheckpoint.sourceBlockNumber,
            sourceBlockHash: sourceCheckpoint.sourceBlockHash,
            round: 0,
            timestamp: sourceCheckpoint.timestamp,
            blockHash: bytes32(0)
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
