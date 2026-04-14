// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MessageLib} from "./MessageLib.sol";

/// @title MessageBus
/// @notice Source-chain canonical event emitter for bridge messages.
/// @dev The event is the object that destination light-client proof verification targets.
contract MessageBus {
    using MessageLib for MessageLib.Message;

    uint256 public immutable localChainId;
    mapping(address => uint256) public nonces;

    event BridgeMessageDispatched(
        bytes32 indexed messageId,
        bytes32 indexed routeId,
        uint8 indexed action,
        uint256 sourceChainId,
        uint256 destinationChainId,
        address sourceSender,
        address recipient,
        address asset,
        uint256 amount,
        uint256 nonce,
        bytes32 payloadHash
    );

    constructor(uint256 _localChainId) {
        require(_localChainId != 0, "CHAIN_ID_ZERO");
        localChainId = _localChainId;
    }

    function dispatchMessage(
        bytes32 routeId,
        uint8 action,
        uint256 destinationChainId,
        address recipient,
        address asset,
        uint256 amount,
        bytes32 payloadHash
    ) external returns (bytes32 messageId, uint256 nonce) {
        require(routeId != bytes32(0), "ROUTE_ZERO");
        require(
            action == MessageLib.ACTION_LOCK_TO_MINT || action == MessageLib.ACTION_BURN_TO_UNLOCK,
            "BAD_ACTION"
        );
        require(destinationChainId != 0 && destinationChainId != localChainId, "BAD_DESTINATION");
        require(recipient != address(0), "RECIPIENT_ZERO");
        require(asset != address(0), "ASSET_ZERO");
        require(amount > 0, "AMOUNT_ZERO");

        nonce = ++nonces[msg.sender];
        MessageLib.Message memory message = MessageLib.Message({
            routeId: routeId,
            action: action,
            sourceChainId: localChainId,
            destinationChainId: destinationChainId,
            sourceSender: msg.sender,
            recipient: recipient,
            asset: asset,
            amount: amount,
            nonce: nonce,
            payloadHash: payloadHash
        });

        messageId = message.messageId();
        emit BridgeMessageDispatched(
            messageId,
            routeId,
            action,
            localChainId,
            destinationChainId,
            msg.sender,
            recipient,
            asset,
            amount,
            nonce,
            payloadHash
        );
    }

    function computeMessageId(MessageLib.Message calldata message) external pure returns (bytes32) {
        return MessageLib.messageId(message);
    }

    function computeEventHash(MessageLib.Message calldata message) external pure returns (bytes32) {
        return MessageLib.eventHash(message);
    }
}
