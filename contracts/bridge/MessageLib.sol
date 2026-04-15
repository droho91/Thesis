// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title MessageLib
/// @notice Shared deterministic message encoding for cross-chain lending messages.
library MessageLib {
    uint8 internal constant ACTION_LOCK_TO_MINT = 1;
    uint8 internal constant ACTION_BURN_TO_UNLOCK = 2;

    bytes32 internal constant MESSAGE_TYPEHASH = keccak256("CrossChainLending.Message.v1");
    bytes32 internal constant MESSAGE_LEAF_TYPEHASH = keccak256("CrossChainLending.MessageLeaf.v1");

    struct Message {
        bytes32 routeId;
        uint8 action;
        uint256 sourceChainId;
        uint256 destinationChainId;
        address sourceEmitter;
        address sourceSender;
        address owner;
        address recipient;
        address asset;
        uint256 amount;
        uint256 nonce;
        uint256 prepaidFee;
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
                message.sourceEmitter,
                message.sourceSender,
                message.owner,
                message.recipient,
                message.asset,
                message.amount,
                message.nonce,
                message.prepaidFee,
                message.payloadHash
            )
        );
    }

    /// @notice Leaf committed into a source-chain checkpoint message tree.
    function leafHash(Message memory message) internal pure returns (bytes32) {
        return keccak256(abi.encode(MESSAGE_LEAF_TYPEHASH, messageId(message)));
    }
}
