// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IAssetOracle
/// @notice Minimal normalized pricing surface for the current banking lane.
interface IAssetOracle {
    /// @dev Returns the normalized asset price with 18 decimals of precision.
    function priceOf(address asset) external view returns (uint256 priceE18);
}
