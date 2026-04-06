// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title MockPriceOracle
/// @notice Local oracle for thesis demo. Prices use 8 decimals (1 USD = 1e8).
contract MockPriceOracle {
    address public owner;
    mapping(address => uint256) public prices;

    event PriceUpdated(address indexed token, uint256 oldPrice, uint256 newPrice);

    constructor() {
        owner = msg.sender;
    }

    function setPrice(address token, uint256 newPrice) external {
        require(msg.sender == owner, "ONLY_OWNER");
        require(token != address(0), "TOKEN_ZERO");
        require(newPrice > 0, "PRICE_ZERO");

        uint256 oldPrice = prices[token];
        prices[token] = newPrice;
        emit PriceUpdated(token, oldPrice, newPrice);
    }

    function getPrice(address token) external view returns (uint256) {
        uint256 price = prices[token];
        require(price > 0, "PRICE_NOT_SET");
        return price;
    }
}
