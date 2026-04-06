// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title StableToken
/// @notice Simple ERC20 stable token for demo and tests.
/// @dev Owner can mint to provide lending liquidity.
contract StableToken is ERC20 {
    address public owner;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        owner = msg.sender;
    }

    /// @notice Mint tokens to an address. Only owner can call.
    /// @param to Recipient address.
    /// @param amount Amount to mint.
    function mint(address to, uint256 amount) external {
        require(msg.sender == owner, "ONLY_OWNER");
        require(to != address(0), "TO_ZERO");
        require(amount > 0, "AMOUNT_ZERO");

        _mint(to, amount);
    }
}
