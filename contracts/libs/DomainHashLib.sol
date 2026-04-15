// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title DomainHashLib
/// @notice Domain-separated hashing helpers used by the local IBC-lite simulation.
library DomainHashLib {
    function taggedHash(bytes32 tag, bytes memory data) internal pure returns (bytes32) {
        return keccak256(abi.encode(tag, data));
    }

    function pathHash(string memory prefix, uint256 chainId, address contractAddress, bytes32 suffix)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(prefix, chainId, contractAddress, suffix));
    }
}
