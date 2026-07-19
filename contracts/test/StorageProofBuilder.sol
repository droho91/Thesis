// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title StorageProofBuilder
/// @notice Test-only helper that constructs a synthetic single-leaf EVM storage trie.
contract StorageProofBuilder {
    struct BuiltSingleStorageProof {
        bytes32 stateRoot;
        bytes[] accountProof;
        bytes[] storageProof;
        bytes expectedTrieValue;
    }

    function buildSingleStorageProof(address account, bytes32 storageKey, bytes32 storageWord)
        external
        pure
        returns (BuiltSingleStorageProof memory built)
    {
        bytes memory expectedTrieValue = _rlpEncodeStorageWord(storageWord);
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

    function _accountValue(bytes32 storageRoot) internal pure returns (bytes memory) {
        bytes[] memory items = new bytes[](4);
        items[0] = _rlpEncodeBytes(hex"01");
        items[1] = _rlpEncodeBytes("");
        items[2] = _rlpEncodeBytes(abi.encodePacked(storageRoot));
        items[3] = _rlpEncodeBytes(abi.encodePacked(keccak256("")));
        return _rlpEncodeList(items);
    }

    function _rlpEncodeStorageWord(bytes32 word) internal pure returns (bytes memory) {
        uint256 value = uint256(word);
        if (value == 0) {
            return _rlpEncodeBytes("");
        }

        uint256 length;
        uint256 cursor = value;
        while (cursor != 0) {
            length++;
            cursor >>= 8;
        }

        bytes memory trimmed = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            trimmed[length - 1 - i] = bytes1(uint8(value >> (i * 8)));
        }
        return _rlpEncodeBytes(trimmed);
    }

    function _pair(bytes memory a, bytes memory b) internal pure returns (bytes[] memory items) {
        items = new bytes[](2);
        items[0] = _rlpEncodeBytes(a);
        items[1] = _rlpEncodeBytes(b);
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
