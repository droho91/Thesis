// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {HexPrefixLib} from "../libs/HexPrefixLib.sol";
import {MerklePatriciaProofLib} from "../libs/MerklePatriciaProofLib.sol";
import {RLPDecodeLib} from "../libs/RLPDecodeLib.sol";

/// @notice Thin test-only facade for exercising the production proof libraries.
contract MPTProofHarness {
    function extract(bytes32 root, bytes calldata key, bytes[] calldata proof) external pure returns (bytes memory) {
        return MerklePatriciaProofLib.extractProofValue(root, key, proof);
    }

    function verify(bytes32 root, bytes calldata key, bytes[] calldata proof, bytes calldata expectedValue)
        external
        pure
        returns (bool)
    {
        return MerklePatriciaProofLib.verify(root, key, proof, expectedValue);
    }

    function verifyAbsence(bytes32 root, bytes calldata key, bytes[] calldata proof) external pure returns (bool) {
        return MerklePatriciaProofLib.verifyAbsence(root, key, proof);
    }

    function readList(bytes calldata encoded) external pure returns (bytes[] memory) {
        return RLPDecodeLib.readList(encoded);
    }

    function decodeCompact(bytes calldata compact) external pure returns (bytes memory, bool) {
        return HexPrefixLib.decodeCompact(compact);
    }
}

/// @notice Deterministic, hand-encoded MPT vectors. The builder deliberately
/// avoids the production decoder and proof walker.
contract MPTProofCorpus {
    struct ProofVector {
        bytes32 root;
        bytes key;
        bytes value;
        bytes[] proof;
    }

    function hashedBranch() external pure returns (ProofVector memory vector) {
        bytes memory firstLeaf = _leaf(_singleNibble(0), _word("branch-first"));
        bytes memory secondLeaf = _leaf(_singleNibble(0), _word("branch-second"));
        bytes memory rootNode = _branch(1, _encodeBytes(abi.encodePacked(keccak256(firstLeaf))), 2, _encodeBytes(abi.encodePacked(keccak256(secondLeaf))));

        vector.root = keccak256(rootNode);
        vector.key = hex"10";
        vector.value = _word("branch-first");
        vector.proof = new bytes[](2);
        vector.proof[0] = rootNode;
        vector.proof[1] = firstLeaf;
    }

    function extensionBranch() external pure returns (ProofVector memory vector) {
        return _extensionBranch();
    }

    function _extensionBranch() private pure returns (ProofVector memory vector) {
        bytes memory firstLeaf = _leaf(_singleNibble(4), _word("extension-first"));
        bytes memory secondLeaf = _leaf(_singleNibble(11), _word("extension-second"));
        bytes memory branchNode = _branch(
            3,
            _encodeBytes(abi.encodePacked(keccak256(firstLeaf))),
            10,
            _encodeBytes(abi.encodePacked(keccak256(secondLeaf)))
        );
        bytes memory extensionNode = _extension(_twoNibbles(1, 2), abi.encodePacked(keccak256(branchNode)));

        vector.root = keccak256(extensionNode);
        vector.key = hex"1234";
        vector.value = _word("extension-first");
        vector.proof = new bytes[](3);
        vector.proof[0] = extensionNode;
        vector.proof[1] = branchNode;
        vector.proof[2] = firstLeaf;
    }

    function inlineBranch() external pure returns (ProofVector memory vector) {
        return _inlineBranch();
    }

    function _inlineBranch() private pure returns (ProofVector memory vector) {
        bytes memory firstLeaf = _leaf(_singleNibble(0), hex"01");
        bytes memory secondLeaf = _leaf(_singleNibble(0), hex"02");
        require(firstLeaf.length < 32 && secondLeaf.length < 32, "CORPUS_CHILD_NOT_INLINE");
        bytes memory rootNode = _branch(1, firstLeaf, 2, secondLeaf);

        vector.root = keccak256(rootNode);
        vector.key = hex"10";
        vector.value = hex"01";
        vector.proof = new bytes[](2);
        vector.proof[0] = rootNode;
        vector.proof[1] = firstLeaf;
    }

    function branchMissingChild() external pure returns (ProofVector memory vector) {
        vector = _inlineBranch();
        vector.key = hex"30";
        vector.value = "";
        vector.proof = _head(vector.proof);
    }

    function divergentLeaf() external pure returns (ProofVector memory vector) {
        vector = _inlineBranch();
        vector.key = hex"11";
        vector.value = "";
    }

    function divergentExtension() external pure returns (ProofVector memory vector) {
        vector = _extensionBranch();
        vector.key = hex"1334";
        vector.value = "";
        vector.proof = _head(vector.proof);
    }

    function _head(bytes[] memory values) private pure returns (bytes[] memory result) {
        result = new bytes[](1);
        result[0] = values[0];
    }

    function _branch(uint8 firstIndex, bytes memory firstReference, uint8 secondIndex, bytes memory secondReference)
        private
        pure
        returns (bytes memory)
    {
        bytes[] memory items = new bytes[](17);
        for (uint256 i = 0; i < items.length; i++) {
            items[i] = _encodeBytes("");
        }
        items[firstIndex] = firstReference;
        items[secondIndex] = secondReference;
        return _encodeList(items);
    }

    function _leaf(bytes memory path, bytes memory value) private pure returns (bytes memory) {
        bytes[] memory items = new bytes[](2);
        items[0] = _encodeBytes(_compact(path, true));
        items[1] = _encodeBytes(value);
        return _encodeList(items);
    }

    function _extension(bytes memory path, bytes memory childReference) private pure returns (bytes memory) {
        bytes[] memory items = new bytes[](2);
        items[0] = _encodeBytes(_compact(path, false));
        items[1] = _encodeBytes(childReference);
        return _encodeList(items);
    }

    function _singleNibble(uint8 first) private pure returns (bytes memory nibbles) {
        nibbles = new bytes(1);
        nibbles[0] = bytes1(first);
    }

    function _twoNibbles(uint8 first, uint8 second) private pure returns (bytes memory nibbles) {
        nibbles = new bytes(2);
        nibbles[0] = bytes1(first);
        nibbles[1] = bytes1(second);
    }

    function _compact(bytes memory nibbles, bool isLeaf) private pure returns (bytes memory compact) {
        uint8 flags = isLeaf ? 2 : 0;
        bool odd = nibbles.length % 2 == 1;
        compact = new bytes(odd ? (nibbles.length + 1) / 2 : nibbles.length / 2 + 1);
        uint256 nibbleOffset;
        uint256 compactOffset = 1;
        if (odd) {
            compact[0] = bytes1((flags + 1) << 4 | uint8(nibbles[0]));
            nibbleOffset = 1;
        } else {
            compact[0] = bytes1(flags << 4);
        }
        for (uint256 i = nibbleOffset; i < nibbles.length; i += 2) {
            compact[compactOffset++] = bytes1(uint8(nibbles[i]) << 4 | uint8(nibbles[i + 1]));
        }
    }

    function _word(string memory label) private pure returns (bytes memory) {
        return abi.encodePacked(keccak256(bytes(label)));
    }

    function _encodeBytes(bytes memory raw) private pure returns (bytes memory out) {
        if (raw.length == 1 && uint8(raw[0]) < 0x80) return raw;
        if (raw.length <= 55) {
            out = new bytes(raw.length + 1);
            out[0] = bytes1(uint8(0x80 + raw.length));
            _copy(raw, 0, out, 1, raw.length);
            return out;
        }
        bytes memory lengthBytes = _encodeLength(raw.length);
        out = new bytes(1 + lengthBytes.length + raw.length);
        out[0] = bytes1(uint8(0xb7 + lengthBytes.length));
        _copy(lengthBytes, 0, out, 1, lengthBytes.length);
        _copy(raw, 0, out, 1 + lengthBytes.length, raw.length);
    }

    function _encodeList(bytes[] memory encodedItems) private pure returns (bytes memory out) {
        bytes memory payload;
        for (uint256 i = 0; i < encodedItems.length; i++) {
            payload = bytes.concat(payload, encodedItems[i]);
        }
        if (payload.length <= 55) {
            out = new bytes(payload.length + 1);
            out[0] = bytes1(uint8(0xc0 + payload.length));
            _copy(payload, 0, out, 1, payload.length);
            return out;
        }
        bytes memory lengthBytes = _encodeLength(payload.length);
        out = new bytes(1 + lengthBytes.length + payload.length);
        out[0] = bytes1(uint8(0xf7 + lengthBytes.length));
        _copy(lengthBytes, 0, out, 1, lengthBytes.length);
        _copy(payload, 0, out, 1 + lengthBytes.length, payload.length);
    }

    function _encodeLength(uint256 value) private pure returns (bytes memory out) {
        uint256 cursor = value;
        uint256 length;
        while (cursor != 0) {
            length++;
            cursor >>= 8;
        }
        out = new bytes(length);
        while (length != 0) {
            out[--length] = bytes1(uint8(value));
            value >>= 8;
        }
    }

    function _copy(bytes memory source, uint256 sourceOffset, bytes memory destination, uint256 destinationOffset, uint256 length)
        private
        pure
    {
        for (uint256 i = 0; i < length; i++) {
            destination[destinationOffset + i] = source[sourceOffset + i];
        }
    }
}

/// @notice Test-only reference walker with an independent RLP parser. It does
/// not import the production decoder, compact-path helper, or MPT walker.
contract IndependentMPTReference {
    struct Item {
        uint256 start;
        uint256 payloadOffset;
        uint256 payloadLength;
        uint256 totalLength;
        bool isList;
    }

    function evaluate(bytes32 root, bytes calldata key, bytes[] calldata proof)
        external
        pure
        returns (bool proofValid, bool found, bytes memory value)
    {
        if (root == bytes32(0) || proof.length == 0) return (false, false, "");
        bytes memory path = _nibbles(key);
        bytes memory expectedReference = abi.encodePacked(root);
        uint256 pathOffset;

        for (uint256 proofIndex = 0; proofIndex < proof.length; proofIndex++) {
            bytes memory node = proof[proofIndex];
            if (!_matches(expectedReference, node, proofIndex == 0)) return (false, false, "");
            Item[] memory items = _listItems(node);

            if (items.length == 17) {
                if (pathOffset == path.length) {
                    bytes memory branchValue = _bytesItem(node, items[16]);
                    return (true, branchValue.length != 0, branchValue);
                }
                Item memory child = items[uint8(path[pathOffset++])];
                expectedReference = _referenceItem(node, child);
                if (expectedReference.length == 0) return (true, false, "");
                continue;
            }

            if (items.length == 2) {
                bytes memory compact = _bytesItem(node, items[0]);
                (bytes memory partialPath, bool isLeaf) = _decodeCompact(compact);
                if (!_startsWith(path, pathOffset, partialPath)) return (true, false, "");
                pathOffset += partialPath.length;
                if (isLeaf) {
                    bytes memory leafValue = _bytesItem(node, items[1]);
                    if (pathOffset != path.length) return (true, false, "");
                    return (true, leafValue.length != 0, leafValue);
                }
                expectedReference = _referenceItem(node, items[1]);
                if (expectedReference.length == 0) return (false, false, "");
                continue;
            }
            return (false, false, "");
        }
        return (false, false, "");
    }

    function _listItems(bytes memory encoded) private pure returns (Item[] memory items) {
        Item memory outer = _parse(encoded, 0);
        require(outer.isList, "REF_NOT_LIST");
        require(outer.totalLength == encoded.length, "REF_TRAILING_BYTES");
        uint256 cursor = outer.payloadOffset;
        uint256 end = outer.payloadOffset + outer.payloadLength;
        uint256 count;
        while (cursor < end) {
            Item memory child = _parse(encoded, cursor);
            cursor += child.totalLength;
            count++;
        }
        require(cursor == end, "REF_LIST_LENGTH");
        items = new Item[](count);
        cursor = outer.payloadOffset;
        for (uint256 i = 0; i < count; i++) {
            items[i] = _parse(encoded, cursor);
            cursor += items[i].totalLength;
        }
    }

    function _parse(bytes memory encoded, uint256 start) private pure returns (Item memory item) {
        require(start < encoded.length, "REF_START_OOB");
        uint8 prefix = uint8(encoded[start]);
        item.start = start;
        if (prefix <= 0x7f) {
            item.payloadOffset = start;
            item.payloadLength = 1;
            item.totalLength = 1;
            return item;
        }
        if (prefix <= 0xb7) {
            item.payloadOffset = start + 1;
            item.payloadLength = prefix - 0x80;
            item.totalLength = item.payloadLength + 1;
            require(start + item.totalLength <= encoded.length, "REF_SHORT_STRING_OOB");
            if (item.payloadLength == 1) require(uint8(encoded[item.payloadOffset]) >= 0x80, "REF_NON_CANONICAL_BYTE");
            return item;
        }
        if (prefix <= 0xbf) {
            uint256 stringLengthOfLength = prefix - 0xb7;
            item.payloadLength = _readLength(encoded, start + 1, stringLengthOfLength);
            require(item.payloadLength > 55, "REF_LONG_STRING_SHORT");
            item.payloadOffset = start + 1 + stringLengthOfLength;
            item.totalLength = 1 + stringLengthOfLength + item.payloadLength;
            require(start + item.totalLength <= encoded.length, "REF_LONG_STRING_OOB");
            return item;
        }
        item.isList = true;
        if (prefix <= 0xf7) {
            item.payloadOffset = start + 1;
            item.payloadLength = prefix - 0xc0;
            item.totalLength = item.payloadLength + 1;
            require(start + item.totalLength <= encoded.length, "REF_SHORT_LIST_OOB");
            return item;
        }
        uint256 lengthOfLength = prefix - 0xf7;
        item.payloadLength = _readLength(encoded, start + 1, lengthOfLength);
        require(item.payloadLength > 55, "REF_LONG_LIST_SHORT");
        item.payloadOffset = start + 1 + lengthOfLength;
        item.totalLength = 1 + lengthOfLength + item.payloadLength;
        require(start + item.totalLength <= encoded.length, "REF_LONG_LIST_OOB");
    }

    function _readLength(bytes memory encoded, uint256 start, uint256 length) private pure returns (uint256 result) {
        require(length != 0 && length <= 32 && start + length <= encoded.length, "REF_LENGTH_OOB");
        require(encoded[start] != bytes1(0), "REF_LENGTH_LEADING_ZERO");
        for (uint256 i = 0; i < length; i++) result = result << 8 | uint8(encoded[start + i]);
    }

    function _referenceItem(bytes memory encoded, Item memory item) private pure returns (bytes memory) {
        if (item.isList) return _slice(encoded, item.start, item.totalLength);
        return _slice(encoded, item.payloadOffset, item.payloadLength);
    }

    function _bytesItem(bytes memory encoded, Item memory item) private pure returns (bytes memory) {
        require(!item.isList, "REF_ITEM_NOT_BYTES");
        return _slice(encoded, item.payloadOffset, item.payloadLength);
    }

    function _matches(bytes memory expectedReference, bytes memory node, bool isRoot) private pure returns (bool) {
        if (expectedReference.length == 0) return false;
        if (isRoot || expectedReference.length == 32) return keccak256(node) == bytes32(expectedReference);
        if (expectedReference.length >= 32) return false;
        return keccak256(expectedReference) == keccak256(node);
    }

    function _decodeCompact(bytes memory compact) private pure returns (bytes memory nibbles, bool isLeaf) {
        require(compact.length != 0, "REF_COMPACT_EMPTY");
        uint8 first = uint8(compact[0]);
        uint8 flag = first >> 4;
        require(flag <= 3, "REF_COMPACT_FLAG");
        bool odd = flag & 1 == 1;
        isLeaf = flag & 2 == 2;
        if (!odd) require(first & 0x0f == 0, "REF_COMPACT_PADDING");
        nibbles = new bytes(odd ? compact.length * 2 - 1 : (compact.length - 1) * 2);
        uint256 offset;
        if (odd) {
            nibbles[0] = bytes1(first & 0x0f);
            offset = 1;
        }
        for (uint256 i = 1; i < compact.length; i++) {
            uint8 current = uint8(compact[i]);
            nibbles[offset++] = bytes1(current >> 4);
            nibbles[offset++] = bytes1(current & 0x0f);
        }
    }

    function _nibbles(bytes memory raw) private pure returns (bytes memory nibbles) {
        nibbles = new bytes(raw.length * 2);
        for (uint256 i = 0; i < raw.length; i++) {
            uint8 current = uint8(raw[i]);
            nibbles[i * 2] = bytes1(current >> 4);
            nibbles[i * 2 + 1] = bytes1(current & 0x0f);
        }
    }

    function _startsWith(bytes memory path, uint256 offset, bytes memory prefix) private pure returns (bool) {
        if (offset + prefix.length > path.length) return false;
        for (uint256 i = 0; i < prefix.length; i++) if (path[offset + i] != prefix[i]) return false;
        return true;
    }

    function _slice(bytes memory input, uint256 start, uint256 length) private pure returns (bytes memory out) {
        require(start + length <= input.length, "REF_SLICE_OOB");
        out = new bytes(length);
        for (uint256 i = 0; i < length; i++) out[i] = input[start + i];
    }
}
