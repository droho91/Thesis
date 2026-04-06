// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {ISwapRouter} from "./interfaces/ISwapRouter.sol";

/// @title MockSwapRouter
/// @notice Simple same-chain router using oracle prices and pre-funded inventory.
/// @dev This is a demo router, not an AMM. Owner must seed tokenOut liquidity.
contract MockSwapRouter is ISwapRouter {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;

    address public owner;
    IPriceOracle public priceOracle;
    uint256 public feeBps;

    event OracleUpdated(address indexed oldOracle, address indexed newOracle);
    event FeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);
    event SwapExecuted(
        address indexed sender,
        address indexed recipient,
        address indexed tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "ONLY_OWNER");
        _;
    }

    constructor(address _oracle, uint256 _feeBps) {
        require(_oracle != address(0), "ORACLE_ZERO");
        require(_feeBps <= BPS, "BAD_FEE");

        owner = msg.sender;
        priceOracle = IPriceOracle(_oracle);
        feeBps = _feeBps;
    }

    function setOracle(address newOracle) external onlyOwner {
        require(newOracle != address(0), "ORACLE_ZERO");
        address oldOracle = address(priceOracle);
        priceOracle = IPriceOracle(newOracle);
        emit OracleUpdated(oldOracle, newOracle);
    }

    function setFeeBps(uint256 newFeeBps) external onlyOwner {
        require(newFeeBps <= BPS, "BAD_FEE");
        uint256 oldFeeBps = feeBps;
        feeBps = newFeeBps;
        emit FeeUpdated(oldFeeBps, newFeeBps);
    }

    function previewSwap(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256 amountOut) {
        require(tokenIn != address(0) && tokenOut != address(0), "TOKEN_ZERO");
        require(tokenIn != tokenOut, "SAME_TOKEN");
        require(amountIn > 0, "AMOUNT_ZERO");

        uint256 priceIn = priceOracle.getPrice(tokenIn);
        uint256 priceOut = priceOracle.getPrice(tokenOut);
        amountOut = (amountIn * priceIn * (BPS - feeBps)) / (priceOut * BPS);
    }

    function swapExactIn(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        address recipient
    ) external returns (uint256 amountOut) {
        require(recipient != address(0), "RECIPIENT_ZERO");

        amountOut = previewSwap(tokenIn, tokenOut, amountIn);
        require(amountOut > 0, "OUTPUT_ZERO");

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).safeTransfer(recipient, amountOut);

        emit SwapExecuted(msg.sender, recipient, tokenIn, tokenOut, amountIn, amountOut);
    }

    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        require(token != address(0), "TOKEN_ZERO");
        require(to != address(0), "TO_ZERO");
        IERC20(token).safeTransfer(to, amount);
    }
}
