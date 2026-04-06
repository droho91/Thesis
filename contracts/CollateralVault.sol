// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title CollateralVault
/// @notice Holds collateral tokens on the "Collateral Chain" side.
/// @dev Bridge is trusted to unlock on behalf of users.
contract CollateralVault {
    IERC20 public immutable collateralToken;
    address public immutable bridge;

    mapping(bytes32 => bool) public processedBurnEvents;

    // Tracks how much collateral each user has locked in the vault.
    mapping(address => uint256) public lockedBalance;

    event Locked(address indexed user, uint256 amount);
    event UnlockedFromBurn(address indexed user, uint256 amount, bytes32 indexed burnEventId);

    constructor(address _collateralToken, address _bridge) {
        require(_collateralToken != address(0), "COLLATERAL_ZERO");
        require(_bridge != address(0), "BRIDGE_ZERO");

        collateralToken = IERC20(_collateralToken);
        bridge = _bridge;
    }

    /// @notice Lock collateral tokens into the vault.
    /// @dev User must approve this contract before calling.
    /// @param amount Amount of collateral tokens to lock.
    function lock(uint256 amount) external {
        require(amount > 0, "AMOUNT_ZERO");

        require(collateralToken.transferFrom(msg.sender, address(this), amount), "TRANSFER_FAILED");
        lockedBalance[msg.sender] += amount;

        emit Locked(msg.sender, amount);
    }

    /// @notice Unlock collateral from a unique burn event id.
    /// @dev Prevents replay of the same burn event by relayer/bridge logic.
    /// @param user Recipient of unlocked collateral.
    /// @param amount Amount of collateral to unlock.
    /// @param burnEventId Unique id derived from source-chain burn log.
    function unlockFromBurnEvent(address user, uint256 amount, bytes32 burnEventId) external {
        require(msg.sender == bridge, "ONLY_BRIDGE");
        require(burnEventId != bytes32(0), "EVENT_ID_ZERO");
        require(!processedBurnEvents[burnEventId], "BURN_EVENT_ALREADY_PROCESSED");

        processedBurnEvents[burnEventId] = true;
        require(user != address(0), "USER_ZERO");
        require(amount > 0, "AMOUNT_ZERO");
        require(lockedBalance[user] >= amount, "INSUFFICIENT_LOCKED");

        lockedBalance[user] -= amount;
        require(collateralToken.transfer(user, amount), "TRANSFER_FAILED");

        emit UnlockedFromBurn(user, amount, burnEventId);
    }
}
