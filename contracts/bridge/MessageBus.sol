// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MessageLib} from "./MessageLib.sol";

/// @title MessageBus
/// @notice Source-chain canonical outbox for checkpoint-committed bridge messages.
contract MessageBus {
    using MessageLib for MessageLib.Message;

    uint256 public immutable localChainId;
    mapping(address => uint256) public nonces;
    uint256 public messageSequence;
    mapping(uint256 => bytes32) public messageLeafAt;
    mapping(uint256 => bytes32) public messageIdAt;
    mapping(uint256 => bytes32) public messageAccumulatorAt;
    mapping(bytes32 => bool) public dispatched;

    event BridgeMessageDispatched(
        bytes32 indexed messageId,
        bytes32 indexed routeId,
        uint8 indexed action,
        uint256 messageSequence,
        uint256 sourceChainId,
        uint256 destinationChainId,
        address sourceEmitter,
        address sourceSender,
        address owner,
        address recipient,
        address asset,
        uint256 amount,
        uint256 nonce,
        uint256 prepaidFee,
        bytes32 payloadHash,
        bytes32 leaf,
        bytes32 accumulator
    );

    event MessageTreeAppended(
        uint256 indexed messageSequence,
        bytes32 indexed messageId,
        bytes32 indexed leaf,
        bytes32 previousAccumulator,
        bytes32 accumulator
    );

    constructor(uint256 _localChainId) {
        require(_localChainId != 0, "CHAIN_ID_ZERO");
        localChainId = _localChainId;
    }

    function dispatchMessage(
        bytes32 routeId,
        uint8 action,
        uint256 destinationChainId,
        address owner,
        address recipient,
        address asset,
        uint256 amount,
        uint256 prepaidFee,
        bytes32 payloadHash
    ) external returns (bytes32 messageId, uint256 nonce) {
        require(routeId != bytes32(0), "ROUTE_ZERO");
        require(
            action == MessageLib.ACTION_LOCK_TO_MINT || action == MessageLib.ACTION_BURN_TO_UNLOCK,
            "BAD_ACTION"
        );
        require(destinationChainId != 0 && destinationChainId != localChainId, "BAD_DESTINATION");
        require(owner != address(0), "OWNER_ZERO");
        require(recipient != address(0), "RECIPIENT_ZERO");
        require(asset != address(0), "ASSET_ZERO");
        require(amount > 0, "AMOUNT_ZERO");

        nonce = ++nonces[msg.sender];
        MessageLib.Message memory message = MessageLib.Message({
            routeId: routeId,
            action: action,
            sourceChainId: localChainId,
            destinationChainId: destinationChainId,
            sourceEmitter: address(this),
            sourceSender: msg.sender,
            owner: owner,
            recipient: recipient,
            asset: asset,
            amount: amount,
            nonce: nonce,
            prepaidFee: prepaidFee,
            payloadHash: payloadHash
        });

        messageId = message.messageId();
        bytes32 leaf = message.leafHash();
        bytes32 previousAccumulator = messageAccumulatorAt[messageSequence];
        messageSequence += 1;
        messageLeafAt[messageSequence] = leaf;
        messageIdAt[messageSequence] = messageId;
        bytes32 accumulator = keccak256(abi.encodePacked(previousAccumulator, messageSequence, leaf));
        messageAccumulatorAt[messageSequence] = accumulator;
        dispatched[messageId] = true;

        emit BridgeMessageDispatched(
            messageId,
            routeId,
            action,
            messageSequence,
            localChainId,
            destinationChainId,
            address(this),
            msg.sender,
            owner,
            recipient,
            asset,
            amount,
            nonce,
            prepaidFee,
            payloadHash,
            leaf,
            accumulator
        );
        emit MessageTreeAppended(messageSequence, messageId, leaf, previousAccumulator, accumulator);
    }

    function computeMessageId(MessageLib.Message calldata message) external pure returns (bytes32) {
        return MessageLib.messageId(message);
    }

    function computeLeafHash(MessageLib.Message calldata message) external pure returns (bytes32) {
        return MessageLib.leafHash(message);
    }
}
