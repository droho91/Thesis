// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title MessageLib
/// @notice Shared deterministic message encoding for cross-chain lending messages.
library MessageLib {
    uint8 internal constant ACTION_LOCK_TO_MINT = 1;
    uint8 internal constant ACTION_BURN_TO_UNLOCK = 2;

    bytes32 internal constant MESSAGE_TYPEHASH = keccak256("CrossChainLending.Message.v1");
    bytes32 internal constant EVENT_TYPEHASH = keccak256("CrossChainLending.MessageDispatchedEvent.v1");

    struct Message {
        bytes32 routeId;
        uint8 action;
        uint256 sourceChainId;
        uint256 destinationChainId;
        address sourceSender;
        address recipient;
        address asset;
        uint256 amount;
        uint256 nonce;
        bytes32 payloadHash;
    }

    function messageId(Message memory message) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                MESSAGE_TYPEHASH,
                message.routeId,
                message.action,
                message.sourceChainId,
                message.destinationChainId,
                message.sourceSender,
                message.recipient,
                message.asset,
                message.amount,
                message.nonce,
                message.payloadHash
            )
        );
    }

    /// @notice Hash of the canonical dispatch event payload used by the dev receipt proof verifier.
    function eventHash(Message memory message) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                EVENT_TYPEHASH,
                messageId(message),
                message.routeId,
                message.action,
                message.sourceChainId,
                message.destinationChainId,
                message.sourceSender,
                message.recipient,
                message.asset,
                message.amount,
                message.nonce,
                message.payloadHash
            )
        );
    }
}
