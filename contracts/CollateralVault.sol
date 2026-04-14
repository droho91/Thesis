// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageBus} from "./bridge/MessageBus.sol";
import {MessageLib} from "./bridge/MessageLib.sol";

/// @title CollateralVault
/// @notice Holds native collateral on the source chain and emits canonical lock messages.
/// @dev BridgeRouter unlocks only after signed checkpoint and Merkle inclusion verification.
contract CollateralVault {
    IERC20 public immutable collateralToken;
    address public immutable bridge;
    address public immutable owner;

    MessageBus public messageBus;
    bytes32 public defaultRouteId;
    uint256 public defaultDestinationChainId;

    mapping(bytes32 => bool) public processedBurnEvents;
    mapping(address => uint256) public lockedBalance;

    event Locked(address indexed user, uint256 amount);
    event DefaultRouteConfigured(address indexed messageBus, bytes32 indexed routeId, uint256 destinationChainId);
    event LockMessageDispatched(
        bytes32 indexed messageId,
        bytes32 indexed routeId,
        address indexed user,
        uint256 destinationChainId,
        uint256 amount
    );
    event UnlockedFromBurn(address indexed user, uint256 amount, bytes32 indexed burnEventId);

    modifier onlyOwner() {
        require(msg.sender == owner, "ONLY_OWNER");
        _;
    }

    constructor(address _collateralToken, address _bridge) {
        require(_collateralToken != address(0), "COLLATERAL_ZERO");
        require(_bridge != address(0), "BRIDGE_ZERO");

        collateralToken = IERC20(_collateralToken);
        bridge = _bridge;
        owner = msg.sender;
    }

    function configureDefaultRoute(address _messageBus, bytes32 _routeId, uint256 _destinationChainId)
        external
        onlyOwner
    {
        require(_messageBus != address(0), "MESSAGE_BUS_ZERO");
        require(_routeId != bytes32(0), "ROUTE_ZERO");
        require(_destinationChainId != 0, "DESTINATION_ZERO");

        messageBus = MessageBus(_messageBus);
        defaultRouteId = _routeId;
        defaultDestinationChainId = _destinationChainId;

        emit DefaultRouteConfigured(_messageBus, _routeId, _destinationChainId);
    }

    /// @notice Lock collateral and dispatch a default route message.
    function lock(uint256 amount) external returns (bytes32 messageId) {
        require(address(messageBus) != address(0), "MESSAGE_BUS_NOT_SET");
        require(defaultRouteId != bytes32(0), "ROUTE_NOT_SET");
        require(defaultDestinationChainId != 0, "DESTINATION_NOT_SET");
        return _lock(defaultRouteId, defaultDestinationChainId, msg.sender, amount, bytes32(0));
    }

    /// @notice Lock collateral for an explicit route and recipient.
    function lockForRoute(bytes32 routeId, uint256 destinationChainId, address recipient, uint256 amount)
        external
        returns (bytes32 messageId)
    {
        require(address(messageBus) != address(0), "MESSAGE_BUS_NOT_SET");
        return _lock(routeId, destinationChainId, recipient, amount, bytes32(0));
    }

    function _lock(bytes32 routeId, uint256 destinationChainId, address recipient, uint256 amount, bytes32 payloadHash)
        internal
        returns (bytes32 messageId)
    {
        require(routeId != bytes32(0), "ROUTE_ZERO");
        require(destinationChainId != 0, "DESTINATION_ZERO");
        require(recipient != address(0), "RECIPIENT_ZERO");
        require(amount > 0, "AMOUNT_ZERO");

        require(collateralToken.transferFrom(msg.sender, address(this), amount), "TRANSFER_FAILED");
        lockedBalance[msg.sender] += amount;

        emit Locked(msg.sender, amount);
        (messageId,) = messageBus.dispatchMessage(
            routeId,
            MessageLib.ACTION_LOCK_TO_MINT,
            destinationChainId,
            recipient,
            address(collateralToken),
            amount,
            payloadHash
        );
        emit LockMessageDispatched(messageId, routeId, recipient, destinationChainId, amount);
    }

    /// @notice Unlock collateral from a unique finalized burn message id.
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
