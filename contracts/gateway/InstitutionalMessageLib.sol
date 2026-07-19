// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title InstitutionalMessageLib
/// @notice Canonical message envelope and hashes for the institutional gateway.
library InstitutionalMessageLib {
    uint64 internal constant PROTOCOL_VERSION = 1;
    bytes32 internal constant MESSAGE_ID_TYPEHASH =
        keccak256("InstitutionalMessageId(uint64 version,uint256 sourceChainId,address sourceGateway,uint256 nonce)");
    bytes32 internal constant MESSAGE_COMMITMENT_TYPEHASH = keccak256(
        "InstitutionalMessage(bytes32 messageId,address sourceApplication,uint256 destinationChainId,address destinationGateway,address destinationApplication,bytes32 payloadHash,uint64 timeoutTimestamp)"
    );

    struct Message {
        uint64 version;
        uint256 nonce;
        uint256 sourceChainId;
        address sourceGateway;
        address sourceApplication;
        uint256 destinationChainId;
        address destinationGateway;
        address destinationApplication;
        uint64 timeoutTimestamp;
        bytes payload;
    }

    function messageId(Message memory message) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                MESSAGE_ID_TYPEHASH,
                message.version,
                message.sourceChainId,
                message.sourceGateway,
                message.nonce
            )
        );
    }

    function commitment(Message memory message) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                MESSAGE_COMMITMENT_TYPEHASH,
                messageId(message),
                message.sourceApplication,
                message.destinationChainId,
                message.destinationGateway,
                message.destinationApplication,
                keccak256(message.payload),
                message.timeoutTimestamp
            )
        );
    }
}
