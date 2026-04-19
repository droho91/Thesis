// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IBCEVMTypesV2
/// @notice Shared EVM proof types for the Besu light-client v2 lane.
library IBCEVMTypesV2 {
    struct StorageProof {
        uint256 sourceChainId;
        uint256 trustedHeight;
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
