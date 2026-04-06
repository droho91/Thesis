// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IPriceOracle
/// @notice Returns token price in USD with 8 decimals.
interface IPriceOracle {
    function getPrice(address token) external view returns (uint256);
}
