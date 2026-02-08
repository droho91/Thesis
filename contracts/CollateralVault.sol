// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title CollateralVault
/// @notice Holds collateral tokens on the "Collateral Chain" side.
/// @dev Bridge is trusted to unlock on behalf of users.
contract CollateralVault {
    IERC20 public collateralToken;
    address public bridge;

    mapping(address => uint256) public lockedBalance;

    event Locked(address indexed user, uint256 amount);
    event Unlocked(address indexed user, uint256 amount);
    event BridgeUpdated(address indexed oldBridge, address indexed newBridge);

    constructor(address _collateralToken, address _bridge) {
        require(_collateralToken != address(0), "COLLATERAL_ZERO");
        require(_bridge != address(0), "BRIDGE_ZERO");
        collateralToken = IERC20(_collateralToken);
        bridge = _bridge;
    }

    /// @notice Lock collateral tokens into the vault.
    /// @param amount Amount of collateral to lock.
    function lock(uint256 amount) external {
        require(amount > 0, "AMOUNT_ZERO");
        // Pull tokens from user into the vault.
        require(collateralToken.transferFrom(msg.sender, address(this), amount), "TRANSFER_FAILED");
        lockedBalance[msg.sender] += amount;
        emit Locked(msg.sender, amount);
    }

    /// @notice Unlock collateral tokens to a user. Only callable by bridge.
    /// @param user The recipient of unlocked collateral.
    /// @param amount Amount of collateral to unlock.
    function unlock(address user, uint256 amount) external {
        require(msg.sender == bridge, "ONLY_BRIDGE");
        require(user != address(0), "USER_ZERO");
        require(amount > 0, "AMOUNT_ZERO");
        require(lockedBalance[user] >= amount, "INSUFFICIENT_LOCKED");
        lockedBalance[user] -= amount;
        require(collateralToken.transfer(user, amount), "TRANSFER_FAILED");
        emit Unlocked(user, amount);
    }

    /// @notice Update the trusted bridge address.
    /// @param newBridge The new bridge address.
    function updateBridge(address newBridge) external {
        require(msg.sender == bridge, "ONLY_BRIDGE");
        require(newBridge != address(0), "BRIDGE_ZERO");
        address oldBridge = bridge;
        bridge = newBridge;
        emit BridgeUpdated(oldBridge, newBridge);
    }
}
