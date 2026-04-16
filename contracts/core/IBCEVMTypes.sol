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
        return abi.encodePacked(bytes1(uint8(0x80 + 32)), word);
    }
}
