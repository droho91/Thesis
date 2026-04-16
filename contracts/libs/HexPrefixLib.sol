// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title HexPrefixLib
/// @notice Compact-encoding helpers for Merkle Patricia Trie paths.
library HexPrefixLib {
    function toNibbles(bytes memory data) internal pure returns (bytes memory nibbles) {
        nibbles = new bytes(data.length * 2);
        for (uint256 i = 0; i < data.length; i++) {
            uint8 value = uint8(data[i]);
            nibbles[2 * i] = bytes1(value >> 4);
            nibbles[2 * i + 1] = bytes1(value & 0x0f);
        }
    }

    function decodeCompact(bytes memory compact) internal pure returns (bytes memory nibbles, bool isLeaf) {
        require(compact.length > 0, "HEX_PREFIX_EMPTY");

        uint8 first = uint8(compact[0]);
        uint8 flag = first >> 4;
        bool isOdd = (flag & 1) == 1;
        isLeaf = (flag & 2) == 2;

        uint256 nibbleLength = isOdd ? (compact.length * 2) - 1 : (compact.length - 1) * 2;
        nibbles = new bytes(nibbleLength);

        uint256 offset;
        if (isOdd) {
            nibbles[0] = bytes1(first & 0x0f);
            offset = 1;
        }

        for (uint256 i = 1; i < compact.length; i++) {
            uint8 value = uint8(compact[i]);
            nibbles[offset] = bytes1(value >> 4);
            nibbles[offset + 1] = bytes1(value & 0x0f);
            offset += 2;
        }
    }

    function startsWith(bytes memory path, uint256 pathOffset, bytes memory prefix) internal pure returns (bool) {
        if (pathOffset + prefix.length > path.length) return false;
        for (uint256 i = 0; i < prefix.length; i++) {
            if (path[pathOffset + i] != prefix[i]) return false;
        }
        return true;
    }
}
