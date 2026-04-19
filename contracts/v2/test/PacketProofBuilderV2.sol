// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCPacketStoreSlotsV2} from "../core/IBCPacketStoreSlotsV2.sol";
import {IBCPacketLibV2} from "../core/IBCPacketLibV2.sol";

/// @title PacketProofBuilderV2
/// @notice Test-only helper that constructs small synthetic EVM storage tries for v2 packet tests.
contract PacketProofBuilderV2 {
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

    struct BuiltSingleStorageProof {
        bytes32 stateRoot;
        bytes[] accountProof;
        bytes[] storageProof;
        bytes expectedTrieValue;
    }

    function buildPacketStorageProof(address packetStore, IBCPacketLibV2.Packet calldata packet)
        external
        pure
        returns (BuiltPacketStorageProof memory built)
    {
        built.leafSlot = IBCPacketStoreSlotsV2.packetLeafAt(packet.sequence);
        built.pathSlot = IBCPacketStoreSlotsV2.packetPathAt(packet.sequence);

        bytes32 leaf = IBCPacketLibV2.leafHash(packet);
        bytes32 path = IBCPacketLibV2.commitmentPath(packet);

        bytes32 storageRoot;
        (
            storageRoot,
            built.leafStorageProof,
            built.pathStorageProof,
            built.expectedLeafTrieValue,
            built.expectedPathTrieValue
        ) = _buildDualStorageTrie(built.leafSlot, leaf, built.pathSlot, path);

        bytes memory accountValue = _accountValue(storageRoot);
        bytes memory accountLeaf = _rlpEncodeList(
            _pair(_compactPath(_nibbles(abi.encodePacked(keccak256(abi.encodePacked(packetStore)))), true), accountValue)
        );

        built.stateRoot = keccak256(accountLeaf);
        built.accountProof = new bytes[](1);
        built.accountProof[0] = accountLeaf;
    }

    function buildSingleStorageProof(address account, bytes32 storageKey, bytes32 storageWord)
        external
        pure
        returns (BuiltSingleStorageProof memory built)
    {
        bytes memory expectedTrieValue = _rlpEncodeBytes(abi.encodePacked(storageWord));
        bytes memory storageLeaf = _rlpEncodeList(
            _pair(
                _compactPath(_nibbles(abi.encodePacked(keccak256(abi.encodePacked(storageKey)))), true),
                expectedTrieValue
            )
        );
        bytes32 storageRoot = keccak256(storageLeaf);

        bytes memory accountValue = _accountValue(storageRoot);
        bytes memory accountLeaf = _rlpEncodeList(
            _pair(_compactPath(_nibbles(abi.encodePacked(keccak256(abi.encodePacked(account)))), true), accountValue)
        );

        built.stateRoot = keccak256(accountLeaf);
        built.accountProof = new bytes[](1);
        built.accountProof[0] = accountLeaf;
        built.storageProof = new bytes[](1);
        built.storageProof[0] = storageLeaf;
        built.expectedTrieValue = expectedTrieValue;
    }

    function _buildDualStorageTrie(bytes32 keyA, bytes32 wordA, bytes32 keyB, bytes32 wordB)
        internal
        pure
        returns (
            bytes32 root,
            bytes[] memory proofA,
            bytes[] memory proofB,
            bytes memory valueA,
            bytes memory valueB
        )
    {
        bytes memory pathA = _nibbles(abi.encodePacked(keccak256(abi.encodePacked(keyA))));
        bytes memory pathB = _nibbles(abi.encodePacked(keccak256(abi.encodePacked(keyB))));
        uint256 commonPrefix = _commonPrefixLength(pathA, pathB);
        require(commonPrefix < pathA.length, "IDENTICAL_STORAGE_PATHS");

        valueA = _rlpEncodeBytes(abi.encodePacked(wordA));
        valueB = _rlpEncodeBytes(abi.encodePacked(wordB));

        bytes memory leafA = _rlpEncodeList(
            _pair(_compactPath(_slice(pathA, commonPrefix + 1, pathA.length - commonPrefix - 1), true), valueA)
        );
        bytes memory leafB = _rlpEncodeList(
            _pair(_compactPath(_slice(pathB, commonPrefix + 1, pathB.length - commonPrefix - 1), true), valueB)
        );

        bytes[] memory branchItems = new bytes[](17);
        for (uint256 i = 0; i < 17; i++) {
            branchItems[i] = _rlpEncodeBytes("");
        }
        branchItems[uint8(pathA[commonPrefix])] = _rlpEncodeBytes(_childReference(leafA));
        branchItems[uint8(pathB[commonPrefix])] = _rlpEncodeBytes(_childReference(leafB));
        bytes memory branchNode = _rlpEncodeList(branchItems);

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

        bytes memory extensionNode =
            _rlpEncodeList(_pair(_compactPath(_slice(pathA, 0, commonPrefix), false), _childReference(branchNode)));
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

    function _accountValue(bytes32 storageRoot) internal pure returns (bytes memory) {
        bytes[] memory items = new bytes[](4);
        items[0] = _rlpEncodeBytes(hex"01");
        items[1] = _rlpEncodeBytes("");
        items[2] = _rlpEncodeBytes(abi.encodePacked(storageRoot));
        items[3] = _rlpEncodeBytes(abi.encodePacked(keccak256("")));
        return _rlpEncodeList(items);
    }

    function _pair(bytes memory a, bytes memory b) internal pure returns (bytes[] memory items) {
        items = new bytes[](2);
        items[0] = _rlpEncodeBytes(a);
        items[1] = _rlpEncodeBytes(b);
    }

    function _childReference(bytes memory node) internal pure returns (bytes memory) {
        return node.length < 32 ? node : abi.encodePacked(keccak256(node));
    }

    function _commonPrefixLength(bytes memory a, bytes memory b) internal pure returns (uint256 prefix) {
        uint256 max = a.length < b.length ? a.length : b.length;
        while (prefix < max && a[prefix] == b[prefix]) {
            prefix++;
        }
    }

    function _slice(bytes memory input, uint256 start, uint256 length) internal pure returns (bytes memory out) {
        out = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            out[i] = input[start + i];
        }
    }

    function _compactPath(bytes memory nibbles_, bool isLeaf) internal pure returns (bytes memory compact) {
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

    function _nibbles(bytes memory raw) internal pure returns (bytes memory out) {
        out = new bytes(raw.length * 2);
        for (uint256 i = 0; i < raw.length; i++) {
            uint8 value = uint8(raw[i]);
            out[2 * i] = bytes1(value >> 4);
            out[2 * i + 1] = bytes1(value & 0x0f);
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
