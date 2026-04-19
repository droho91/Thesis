// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IAssetOracleV2
/// @notice Minimal normalized pricing surface for the v2 banking lane.
interface IAssetOracleV2 {
    /// @dev Returns the normalized asset price with 18 decimals of precision.
    function priceOf(address asset) external view returns (uint256 priceE18);
}
