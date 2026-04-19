// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IBCEVMTypes
/// @notice Shared EVM proof boundary types for the Besu/QBFT transition path.
library IBCEVMTypes {
    struct StorageProof {
        uint256 sourceChainId;
        bytes32 consensusStateHash;
        bytes32 stateRoot;
        address account;
        bytes32 storageKey;
        bytes expectedValue;
        bytes[] accountProof;
        bytes[] storageProof;
    }

    function accountTrieKey(address account) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(account));
    }

    function storageTrieKey(bytes32 storageKey) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(storageKey));
    }

    function rlpEncodeWord(bytes32 word) internal pure returns (bytes memory) {
        uint256 value = uint256(word);
        if (value == 0) {
            return hex"80";
        }

        uint256 length;
        uint256 cursor = value;
        while (cursor != 0) {
            length++;
            cursor >>= 8;
        }

        if (length == 1 && uint8(value) < 0x80) {
            return abi.encodePacked(bytes1(uint8(value)));
        }

        bytes memory encoded = new bytes(length + 1);
        encoded[0] = bytes1(uint8(0x80 + length));
        for (uint256 i = 0; i < length; i++) {
            encoded[length - i] = bytes1(uint8(value >> (i * 8)));
        }
        return encoded;
    }
}
