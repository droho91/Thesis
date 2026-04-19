// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title StorageProofFixture
/// @notice Minimal source-chain fixture with a single known storage slot for v2 proof-boundary smokes.
contract StorageProofFixture {
    uint256 public storedValue;

    constructor(uint256 initialValue) {
        storedValue = initialValue;
    }

    function setStoredValue(uint256 nextValue) external {
        storedValue = nextValue;
    }
}
