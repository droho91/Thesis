// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BesuLightClient} from "../../contracts/clients/BesuLightClient.sol";
import {BesuLightClientTypes} from "../../contracts/clients/BesuLightClientTypes.sol";
import {BesuQBFTExtraDataLib} from "../../contracts/clients/BesuQBFTExtraDataLib.sol";

contract BesuLightClientTest is Test {
    uint256 internal constant SOURCE_CHAIN_ID = 41001;
    uint256 internal constant EPOCH = 1;

    uint256 internal validatorKey0 = 101;
    uint256 internal validatorKey1 = 102;
    uint256 internal validatorKey2 = 103;
    uint256 internal validatorKey3 = 104;
    uint256 internal attackerKey0 = 201;
    uint256 internal attackerKey1 = 202;
    uint256 internal attackerKey2 = 203;
    uint256 internal attackerKey3 = 204;
    uint256 internal unknownKey = 999;

    BesuLightClient internal client;
    address[] internal validators;

    function setUp() public {
        client = new BesuLightClient(address(this));
        validators.push(vm.addr(validatorKey0));
        validators.push(vm.addr(validatorKey1));
        validators.push(vm.addr(validatorKey2));
        validators.push(vm.addr(validatorKey3));

        bytes32 anchorHash = keccak256("anchor-header");
        client.initializeTrustAnchor(
            SOURCE_CHAIN_ID,
            BesuLightClientTypes.TrustedHeader({
                sourceChainId: SOURCE_CHAIN_ID,
                height: 1,
                headerHash: anchorHash,
                parentHash: bytes32(0),
                stateRoot: keccak256("anchor-state-root"),
                timestamp: 1_700_000_001,
                validatorsHash: BesuQBFTExtraDataLib.validatorsHash(validators),
                exists: true
            }),
            _validatorSet(1)
        );
    }

    function testUpdateClientAcceptsValidCommitSeals() public {
        BesuLightClientTypes.HeaderUpdate memory update =
            _headerUpdate(2, keccak256("anchor-header"), keccak256("state-root-2"), validators, _signerKeys3());

        bytes32 trustedHeaderHash = client.updateClient(update, _validatorSet(2));

        assertEq(trustedHeaderHash, update.headerHash);
        assertEq(client.trustedStateRoot(SOURCE_CHAIN_ID, 2), update.stateRoot);
        assertEq(client.trustedTimestamp(SOURCE_CHAIN_ID, 2), 1_700_000_002);
        assertEq(client.latestTrustedHeight(SOURCE_CHAIN_ID), 2);
    }

    function testUpdateClientRejectsWrongParent() public {
        BesuLightClientTypes.HeaderUpdate memory update =
            _headerUpdate(2, keccak256("wrong-parent"), keccak256("state-root-2"), validators, _signerKeys3());

        vm.expectRevert(bytes("PARENT_HASH_MISMATCH"));
        client.updateClient(update, _validatorSet(2));
    }

    function testUpdateClientBatchAcceptsAdjacentHeaders() public {
        BesuLightClientTypes.HeaderUpdate memory update2 =
            _headerUpdate(2, keccak256("anchor-header"), keccak256("state-root-2"), validators, _signerKeys3());
        BesuLightClientTypes.HeaderUpdate memory update3 =
            _headerUpdate(3, update2.headerHash, keccak256("state-root-3"), validators, _signerKeys3());

        BesuLightClientTypes.HeaderUpdate[] memory updates = new BesuLightClientTypes.HeaderUpdate[](2);
        updates[0] = update2;
        updates[1] = update3;
        BesuLightClientTypes.ValidatorSet[] memory validatorSets_ = new BesuLightClientTypes.ValidatorSet[](2);
        validatorSets_[0] = _validatorSet(2);
        validatorSets_[1] = _validatorSet(3);

        bytes32 trustedHeaderHash = client.updateClientBatch(updates, validatorSets_);

        assertEq(trustedHeaderHash, update3.headerHash);
        assertEq(client.trustedStateRoot(SOURCE_CHAIN_ID, 2), update2.stateRoot);
        assertEq(client.trustedStateRoot(SOURCE_CHAIN_ID, 3), update3.stateRoot);
        assertEq(client.latestTrustedHeight(SOURCE_CHAIN_ID), 3);
    }

    function testUpdateClientBatchRejectsHeightGapAtomically() public {
        BesuLightClientTypes.HeaderUpdate memory update2 =
            _headerUpdate(2, keccak256("anchor-header"), keccak256("state-root-2"), validators, _signerKeys3());
        BesuLightClientTypes.HeaderUpdate memory update4 =
            _headerUpdate(4, update2.headerHash, keccak256("state-root-4"), validators, _signerKeys3());

        BesuLightClientTypes.HeaderUpdate[] memory updates = new BesuLightClientTypes.HeaderUpdate[](2);
        updates[0] = update2;
        updates[1] = update4;
        BesuLightClientTypes.ValidatorSet[] memory validatorSets_ = new BesuLightClientTypes.ValidatorSet[](2);
        validatorSets_[0] = _validatorSet(2);
        validatorSets_[1] = _validatorSet(4);

        vm.expectRevert(bytes("HEIGHT_NOT_ADJACENT"));
        client.updateClientBatch(updates, validatorSets_);

        assertEq(client.trustedStateRoot(SOURCE_CHAIN_ID, 2), bytes32(0));
        assertEq(client.latestTrustedHeight(SOURCE_CHAIN_ID), 1);
    }

    function testUpdateClientRejectsSkipWithValidCommitSeals() public {
        BesuLightClientTypes.HeaderUpdate memory update =
            _headerUpdate(10, keccak256("non-adjacent-parent"), keccak256("state-root-10"), validators, _signerKeys3());

        vm.expectRevert(bytes("HEIGHT_NOT_ADJACENT"));
        client.updateClient(update, _validatorSet(10));

        assertEq(client.trustedStateRoot(SOURCE_CHAIN_ID, 10), bytes32(0));
        assertEq(client.latestTrustedHeight(SOURCE_CHAIN_ID), 1);
    }

    function testUpdateClientFreezesOnConflictingTrustedHeight() public {
        BesuLightClientTypes.HeaderUpdate memory update =
            _headerUpdate(1, bytes32(0), keccak256("state-root-1"), validators, _signerKeys3());

        client.updateClient(update, _validatorSet(1));

        assertEq(uint256(client.status(SOURCE_CHAIN_ID)), uint256(BesuLightClientTypes.ClientStatus.Frozen));

        (
            uint256 evidenceChainId,
            uint256 evidenceHeight,
            bytes32 trustedHeaderHash,
            bytes32 conflictingHeaderHash,
            bytes32 evidenceHash,
            uint256 detectedAt
        ) = client.frozenEvidence(SOURCE_CHAIN_ID);

        assertEq(evidenceChainId, SOURCE_CHAIN_ID);
        assertEq(evidenceHeight, 1);
        assertEq(trustedHeaderHash, keccak256("anchor-header"));
        assertEq(conflictingHeaderHash, update.headerHash);
        assertEq(
            evidenceHash,
            keccak256(abi.encode(SOURCE_CHAIN_ID, uint256(1), keccak256("anchor-header"), update.headerHash))
        );
        assertGt(detectedAt, 0);
    }

    function testRecoveryRequiresFrozenClient() public {
        vm.expectRevert(bytes("CLIENT_NOT_FROZEN"));
        client.beginRecovery(SOURCE_CHAIN_ID);
    }

    function testRecoverClientRequiresRecoveringState() public {
        BesuLightClientTypes.TrustedHeader memory recoveryAnchor = BesuLightClientTypes.TrustedHeader({
            sourceChainId: SOURCE_CHAIN_ID,
            height: 2,
            headerHash: keccak256("recovery-header"),
            parentHash: keccak256("anchor-header"),
            stateRoot: keccak256("recovery-state-root"),
            timestamp: 1_700_000_002,
            validatorsHash: BesuQBFTExtraDataLib.validatorsHash(validators),
            exists: true
        });

        vm.expectRevert(bytes("CLIENT_NOT_RECOVERING"));
        client.recoverClient(SOURCE_CHAIN_ID, recoveryAnchor, _validatorSet(2));
    }

    function testRecoverClientRestoresActiveStatus() public {
        BesuLightClientTypes.HeaderUpdate memory conflict =
            _headerUpdate(1, bytes32(0), keccak256("state-root-1"), validators, _signerKeys3());
        client.updateClient(conflict, _validatorSet(1));

        client.beginRecovery(SOURCE_CHAIN_ID);
        assertEq(uint256(client.status(SOURCE_CHAIN_ID)), uint256(BesuLightClientTypes.ClientStatus.Recovering));

        BesuLightClientTypes.TrustedHeader memory recoveryAnchor = BesuLightClientTypes.TrustedHeader({
            sourceChainId: SOURCE_CHAIN_ID,
            height: 2,
            headerHash: keccak256("recovery-header"),
            parentHash: keccak256("anchor-header"),
            stateRoot: keccak256("recovery-state-root"),
            timestamp: 1_700_000_002,
            validatorsHash: BesuQBFTExtraDataLib.validatorsHash(validators),
            exists: true
        });

        client.recoverClient(SOURCE_CHAIN_ID, recoveryAnchor, _validatorSet(2));

        assertEq(uint256(client.status(SOURCE_CHAIN_ID)), uint256(BesuLightClientTypes.ClientStatus.Active));
        assertEq(client.latestTrustedHeight(SOURCE_CHAIN_ID), 2);
        assertEq(client.trustedStateRoot(SOURCE_CHAIN_ID, 2), recoveryAnchor.stateRoot);
        assertEq(client.trustedTimestamp(SOURCE_CHAIN_ID, 2), recoveryAnchor.timestamp);

        (
            uint256 evidenceChainId,
            uint256 evidenceHeight,
            bytes32 trustedHeaderHash,
            bytes32 conflictingHeaderHash,
            bytes32 evidenceHash,
            uint256 detectedAt
        ) = client.frozenEvidence(SOURCE_CHAIN_ID);

        assertEq(evidenceChainId, 0);
        assertEq(evidenceHeight, 0);
        assertEq(trustedHeaderHash, bytes32(0));
        assertEq(conflictingHeaderHash, bytes32(0));
        assertEq(evidenceHash, bytes32(0));
        assertEq(detectedAt, 0);
    }

    function testUpdateClientRejectsUntrustedStaleHeight() public {
        BesuLightClientTypes.HeaderUpdate memory update =
            _headerUpdate(2, keccak256("anchor-header"), keccak256("state-root-2"), validators, _signerKeys3());
        client.updateClient(update, _validatorSet(2));

        vm.expectRevert(bytes("HEIGHT_NOT_FORWARD"));
        client.updateClient(update, _validatorSet(2));
    }

    function testUpdateClientRejectsSelfCertifiedValidatorSet() public {
        address[] memory attackerValidators = _attackerValidators();
        BesuLightClientTypes.HeaderUpdate memory update = _headerUpdate(
            2,
            keccak256("anchor-header"),
            keccak256("self-certified-state-root"),
            attackerValidators,
            _attackerSignerKeys3()
        );

        vm.expectRevert(bytes("UNSUPPORTED_VALIDATOR_SET_ROTATION"));
        client.updateClient(update, _validatorSetFrom(2, 2, attackerValidators));
    }

    function testUpdateClientRejectsValidatorSetMismatchAtTrustedEpoch() public {
        address[] memory attackerValidators = _attackerValidators();
        BesuLightClientTypes.HeaderUpdate memory update = _headerUpdate(
            2,
            keccak256("anchor-header"),
            keccak256("same-epoch-attacker-root"),
            attackerValidators,
            _attackerSignerKeys3()
        );

        vm.expectRevert(bytes("CURRENT_VALIDATOR_SET_MISMATCH"));
        client.updateClient(update, _validatorSetFrom(EPOCH, 2, attackerValidators));
    }

    function testUpdateClientRejectsValidatorRotationWithoutTrustedTransition() public {
        address[] memory rotatedValidators = _attackerValidators();
        BesuLightClientTypes.HeaderUpdate memory update = _headerUpdate(
            2,
            keccak256("anchor-header"),
            keccak256("rotation-root"),
            rotatedValidators,
            _attackerSignerKeys3()
        );

        vm.expectRevert(bytes("UNSUPPORTED_VALIDATOR_SET_ROTATION"));
        client.updateClient(update, _validatorSetFrom(EPOCH + 1, 2, rotatedValidators));
    }

    function testMaliciousStateRootUnderSelfCertifiedValidatorSetIsNotTrusted() public {
        address[] memory attackerValidators = _attackerValidators();
        bytes32 maliciousRoot = keccak256("malicious-state-root");
        BesuLightClientTypes.HeaderUpdate memory update =
            _headerUpdate(2, keccak256("anchor-header"), maliciousRoot, attackerValidators, _attackerSignerKeys3());

        vm.expectRevert(bytes("UNSUPPORTED_VALIDATOR_SET_ROTATION"));
        client.updateClient(update, _validatorSetFrom(EPOCH + 1, 2, attackerValidators));

        assertEq(client.trustedStateRoot(SOURCE_CHAIN_ID, 2), bytes32(0));
        assertEq(client.latestTrustedHeight(SOURCE_CHAIN_ID), 1);
    }

    function testUpdateClientRejectsWrongStateRootField() public {
        BesuLightClientTypes.HeaderUpdate memory update =
            _headerUpdate(2, keccak256("anchor-header"), keccak256("state-root-2"), validators, _signerKeys3());
        update.stateRoot = keccak256("different-state-root");

        vm.expectRevert(bytes("HEADER_STATE_ROOT_MISMATCH"));
        client.updateClient(update, _validatorSet(2));
    }

    function testUpdateClientRejectsInsufficientCommitSeals() public {
        uint256[] memory signerKeys = new uint256[](2);
        signerKeys[0] = validatorKey0;
        signerKeys[1] = validatorKey1;
        BesuLightClientTypes.HeaderUpdate memory update =
            _headerUpdate(2, keccak256("anchor-header"), keccak256("state-root-2"), validators, signerKeys);

        vm.expectRevert(bytes("INSUFFICIENT_COMMIT_SEALS"));
        client.updateClient(update, _validatorSet(2));
    }

    function testUpdateClientRejectsUnknownCommitSealSigner() public {
        uint256[] memory signerKeys = new uint256[](3);
        signerKeys[0] = validatorKey0;
        signerKeys[1] = validatorKey1;
        signerKeys[2] = unknownKey;
        BesuLightClientTypes.HeaderUpdate memory update =
            _headerUpdate(2, keccak256("anchor-header"), keccak256("state-root-2"), validators, signerKeys);

        vm.expectRevert(bytes("COMMIT_SEAL_SIGNER_UNKNOWN"));
        client.updateClient(update, _validatorSet(2));
    }

    function testUpdateClientRejectsDuplicateCommitSealSigner() public {
        uint256[] memory signerKeys = new uint256[](3);
        signerKeys[0] = validatorKey0;
        signerKeys[1] = validatorKey1;
        signerKeys[2] = validatorKey1;
        BesuLightClientTypes.HeaderUpdate memory update =
            _headerUpdate(2, keccak256("anchor-header"), keccak256("state-root-2"), validators, signerKeys);

        vm.expectRevert(bytes("COMMIT_SEAL_DUPLICATE_SIGNER"));
        client.updateClient(update, _validatorSet(2));
    }

    function testUpdateClientRejectsMismatchedExtraDataValidatorSet() public {
        address[] memory extraValidators = new address[](4);
        extraValidators[0] = validators[0];
        extraValidators[1] = validators[1];
        extraValidators[2] = validators[2];
        extraValidators[3] = vm.addr(unknownKey);
        BesuLightClientTypes.HeaderUpdate memory update =
            _headerUpdate(2, keccak256("anchor-header"), keccak256("state-root-2"), extraValidators, _signerKeys3());

        vm.expectRevert(bytes("EXTRA_DATA_VALIDATOR_SET_MISMATCH"));
        client.updateClient(update, _validatorSet(2));
    }

    function _validatorSet(uint256 activationHeight)
        internal
        view
        returns (BesuLightClientTypes.ValidatorSet memory validatorSet_)
    {
        validatorSet_.epoch = EPOCH;
        validatorSet_.activationHeight = activationHeight;
        validatorSet_.validators = validators;
    }

    function _validatorSetFrom(uint256 epoch, uint256 activationHeight, address[] memory validatorAddresses)
        internal
        pure
        returns (BesuLightClientTypes.ValidatorSet memory validatorSet_)
    {
        validatorSet_.epoch = epoch;
        validatorSet_.activationHeight = activationHeight;
        validatorSet_.validators = validatorAddresses;
    }

    function _signerKeys3() internal view returns (uint256[] memory signerKeys) {
        signerKeys = new uint256[](3);
        signerKeys[0] = validatorKey0;
        signerKeys[1] = validatorKey1;
        signerKeys[2] = validatorKey2;
    }

    function _attackerValidators() internal view returns (address[] memory attackerValidators) {
        attackerValidators = new address[](4);
        attackerValidators[0] = vm.addr(attackerKey0);
        attackerValidators[1] = vm.addr(attackerKey1);
        attackerValidators[2] = vm.addr(attackerKey2);
        attackerValidators[3] = vm.addr(attackerKey3);
    }

    function _attackerSignerKeys3() internal view returns (uint256[] memory signerKeys) {
        signerKeys = new uint256[](3);
        signerKeys[0] = attackerKey0;
        signerKeys[1] = attackerKey1;
        signerKeys[2] = attackerKey2;
    }

    function _headerUpdate(
        uint256 height,
        bytes32 parentHash,
        bytes32 stateRoot,
        address[] memory extraValidators,
        uint256[] memory signerKeys
    ) internal returns (BesuLightClientTypes.HeaderUpdate memory update) {
        bytes memory emptySealExtraData = _qbftExtraData(extraValidators, new bytes[](0));
        bytes memory sealHeaderRlp = _rawHeader(parentHash, stateRoot, height, emptySealExtraData);
        bytes32 sealHash = keccak256(sealHeaderRlp);

        bytes[] memory commitSeals = new bytes[](signerKeys.length);
        for (uint256 i = 0; i < signerKeys.length; i++) {
            commitSeals[i] = _signature(signerKeys[i], sealHash);
        }

        bytes memory fullExtraData = _qbftExtraData(extraValidators, commitSeals);
        bytes memory blockHeaderRlp = sealHeaderRlp;
        bytes32 blockHash = keccak256(blockHeaderRlp);

        update = BesuLightClientTypes.HeaderUpdate({
            sourceChainId: SOURCE_CHAIN_ID,
            height: height,
            rawHeaderRlp: sealHeaderRlp,
            blockHeaderRlp: blockHeaderRlp,
            headerHash: blockHash,
            parentHash: parentHash,
            stateRoot: stateRoot,
            extraData: fullExtraData
        });
    }

    function _rawHeader(bytes32 parentHash, bytes32 stateRoot, uint256 number, bytes memory extraData)
        internal
        pure
        returns (bytes memory)
    {
        bytes[] memory fields = new bytes[](15);
        fields[0] = _rlpEncodeBytes(abi.encodePacked(parentHash));
        fields[1] = _rlpEncodeBytes(abi.encodePacked(keccak256("ommers")));
        fields[2] = _rlpEncodeBytes(abi.encodePacked(address(0xBEEF)));
        fields[3] = _rlpEncodeBytes(abi.encodePacked(stateRoot));
        fields[4] = _rlpEncodeBytes(abi.encodePacked(keccak256("tx-root")));
        fields[5] = _rlpEncodeBytes(abi.encodePacked(keccak256("receipt-root")));
        fields[6] = _rlpEncodeBytes(new bytes(256));
        fields[7] = _rlpEncodeBytes("");
        fields[8] = _rlpEncodeBytes(_uintBytes(number));
        fields[9] = _rlpEncodeBytes(_uintBytes(30_000_000));
        fields[10] = _rlpEncodeBytes("");
        fields[11] = _rlpEncodeBytes(_uintBytes(1_700_000_000 + number));
        fields[12] = _rlpEncodeBytes(extraData);
        fields[13] = _rlpEncodeBytes(abi.encodePacked(keccak256("mix-hash")));
        fields[14] = _rlpEncodeBytes(hex"0000000000000000");
        return _rlpEncodeList(fields);
    }

    function _qbftExtraData(address[] memory extraValidators, bytes[] memory commitSeals)
        internal
        pure
        returns (bytes memory)
    {
        bytes[] memory validatorItems = new bytes[](extraValidators.length);
        for (uint256 i = 0; i < extraValidators.length; i++) {
            validatorItems[i] = _rlpEncodeBytes(abi.encodePacked(extraValidators[i]));
        }

        bytes[] memory sealItems = new bytes[](commitSeals.length);
        for (uint256 i = 0; i < commitSeals.length; i++) {
            sealItems[i] = _rlpEncodeBytes(commitSeals[i]);
        }

        bytes[] memory items = new bytes[](5);
        items[0] = _rlpEncodeBytes(abi.encodePacked(bytes32("besu-test")));
        items[1] = _rlpEncodeList(validatorItems);
        items[2] = _rlpEncodeList(new bytes[](0));
        items[3] = _rlpEncodeBytes("");
        items[4] = _rlpEncodeList(sealItems);
        return _rlpEncodeList(items);
    }

    function _signature(uint256 privateKey, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return bytes.concat(abi.encodePacked(r), abi.encodePacked(s), bytes1(v));
    }

    function _uintBytes(uint256 value) internal pure returns (bytes memory out) {
        if (value == 0) return "";
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

    function _rlpEncodeBytes(bytes memory raw) internal pure returns (bytes memory out) {
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

        bytes memory lengthBytes = _encodeLength(raw.length);
        out = new bytes(1 + lengthBytes.length + raw.length);
        out[0] = bytes1(uint8(0xb7 + lengthBytes.length));
        for (uint256 i = 0; i < lengthBytes.length; i++) {
            out[i + 1] = lengthBytes[i];
        }
        for (uint256 i = 0; i < raw.length; i++) {
            out[1 + lengthBytes.length + i] = raw[i];
        }
    }

    function _rlpEncodeList(bytes[] memory items) internal pure returns (bytes memory out) {
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

        bytes memory lengthBytes = _encodeLength(payload.length);
        out = new bytes(1 + lengthBytes.length + payload.length);
        out[0] = bytes1(uint8(0xf7 + lengthBytes.length));
        for (uint256 i = 0; i < lengthBytes.length; i++) {
            out[i + 1] = lengthBytes[i];
        }
        for (uint256 i = 0; i < payload.length; i++) {
            out[1 + lengthBytes.length + i] = payload[i];
        }
    }

    function _encodeLength(uint256 value) internal pure returns (bytes memory out) {
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
}
