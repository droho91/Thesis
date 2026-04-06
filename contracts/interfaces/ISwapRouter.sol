// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ISwapRouter
/// @notice Minimal same-chain swap router interface for thesis demo.
interface ISwapRouter {
    function previewSwap(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256 amountOut);

    function swapExactIn(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        address recipient
    ) external returns (uint256 amountOut);
}
