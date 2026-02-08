// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title WrappedCollateral
/// @notice ERC20 representing locked collateral from another chain.
/// @dev Only the trusted bridge can mint/burn.
contract WrappedCollateral is ERC20 {
    address public bridge;

    event BridgeUpdated(address indexed oldBridge, address indexed newBridge);

    constructor(string memory name_, string memory symbol_, address _bridge) ERC20(name_, symbol_) {
        require(_bridge != address(0), "BRIDGE_ZERO");
        bridge = _bridge;
    }

    /// @notice Mint wrapped collateral to a user. Only callable by bridge.
    function mint(address to, uint256 amount) external {
        require(msg.sender == bridge, "ONLY_BRIDGE");
        require(to != address(0), "TO_ZERO");
        require(amount > 0, "AMOUNT_ZERO");
        _mint(to, amount);
    }

    /// @notice Burn wrapped collateral from a user. Only callable by bridge.
    function burn(address from, uint256 amount) external {
        require(msg.sender == bridge, "ONLY_BRIDGE");
        require(from != address(0), "FROM_ZERO");
        require(amount > 0, "AMOUNT_ZERO");
        _burn(from, amount);
    }

    /// @notice Update the trusted bridge address.
    function updateBridge(address newBridge) external {
        require(msg.sender == bridge, "ONLY_BRIDGE");
        require(newBridge != address(0), "BRIDGE_ZERO");
        address oldBridge = bridge;
        bridge = newBridge;
        emit BridgeUpdated(oldBridge, newBridge);
    }
}
