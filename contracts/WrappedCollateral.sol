// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title WrappedCollateral
/// @notice ERC20 representing collateral locked on another chain.
/// @dev Only BridgeRouter can mint after proof verification and burn for release messages.
contract WrappedCollateral is ERC20 {
    address public immutable bridge;
    mapping(bytes32 => bool) public processedLockEvents;

    event BridgeMintedFromLock(address indexed to, uint256 amount, bytes32 indexed lockEventId);
    event BridgeBurned(address indexed from, uint256 amount);

    constructor(string memory name_, string memory symbol_, address _bridge) ERC20(name_, symbol_) {
        require(_bridge != address(0), "BRIDGE_ZERO");
        bridge = _bridge;
    }

    /// @notice Mint wrapped tokens from a unique lock event id.
    /// @dev Prevents replay of the same lock event by relayer/bridge logic.
    /// @param to Recipient address.
    /// @param amount Amount to mint.
    /// @param lockEventId Unique id derived from source-chain lock log.
    function mintFromLockEvent(address to, uint256 amount, bytes32 lockEventId) external {
        require(msg.sender == bridge, "ONLY_BRIDGE");
        require(to != address(0), "TO_ZERO");
        require(amount > 0, "AMOUNT_ZERO");
        require(lockEventId != bytes32(0), "EVENT_ID_ZERO");
        require(!processedLockEvents[lockEventId], "LOCK_EVENT_ALREADY_PROCESSED");

        processedLockEvents[lockEventId] = true;
        _mint(to, amount);

        emit BridgeMintedFromLock(to, amount, lockEventId);
    }

    /// @notice Burn wrapped tokens from a user. Only bridge can call.
    /// @param from Address to burn from.
    /// @param amount Amount to burn.
    function burn(address from, uint256 amount) external {
        require(msg.sender == bridge, "ONLY_BRIDGE");
        require(from != address(0), "FROM_ZERO");
        require(amount > 0, "AMOUNT_ZERO");

        _burn(from, amount);
        emit BridgeBurned(from, amount);
    }
}
