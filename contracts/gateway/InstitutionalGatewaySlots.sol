// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title InstitutionalGatewaySlots
/// @notice Stable storage paths used by cross-chain EVM proofs.
library InstitutionalGatewaySlots {
    bytes32 internal constant COMMITMENTS_SLOT = keccak256("thesis.institutional.gateway.commitments.v1");
    bytes32 internal constant RECEIPTS_SLOT = keccak256("thesis.institutional.gateway.receipts.v1");
    bytes32 internal constant ACKNOWLEDGEMENTS_SLOT = keccak256("thesis.institutional.gateway.acknowledgements.v1");
    bytes32 internal constant COMPLETIONS_SLOT = keccak256("thesis.institutional.gateway.completions.v1");
    bytes32 internal constant TIMEOUTS_SLOT = keccak256("thesis.institutional.gateway.timeouts.v1");

    function commitment(bytes32 messageId) internal pure returns (bytes32) {
        return keccak256(abi.encode(messageId, COMMITMENTS_SLOT));
    }

    function receipt(bytes32 messageId) internal pure returns (bytes32) {
        return keccak256(abi.encode(messageId, RECEIPTS_SLOT));
    }

    function acknowledgement(bytes32 messageId) internal pure returns (bytes32) {
        return keccak256(abi.encode(messageId, ACKNOWLEDGEMENTS_SLOT));
    }

    function completion(bytes32 messageId) internal pure returns (bytes32) {
        return keccak256(abi.encode(messageId, COMPLETIONS_SLOT));
    }

    function timeout(bytes32 messageId) internal pure returns (bytes32) {
        return keccak256(abi.encode(messageId, TIMEOUTS_SLOT));
    }
}
