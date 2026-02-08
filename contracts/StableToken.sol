// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title StableToken
/// @notice Simple ERC20 stable token for testing.
/// @dev Owner can mint for demo and tests.
contract StableToken is ERC20 {
    address public owner;

    event OwnerUpdated(address indexed oldOwner, address indexed newOwner);

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        owner = msg.sender;
    }

    /// @notice Mint stable tokens to a user. Only callable by owner.
    function mint(address to, uint256 amount) external {
        require(msg.sender == owner, "ONLY_OWNER");
        require(to != address(0), "TO_ZERO");
        require(amount > 0, "AMOUNT_ZERO");
        _mint(to, amount);
    }

    /// @notice Update the owner address.
    function updateOwner(address newOwner) external {
        require(msg.sender == owner, "ONLY_OWNER");
        require(newOwner != address(0), "OWNER_ZERO");
        address oldOwner = owner;
        owner = newOwner;
        emit OwnerUpdated(oldOwner, newOwner);
    }
}
