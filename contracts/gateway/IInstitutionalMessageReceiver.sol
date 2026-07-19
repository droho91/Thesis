// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IInstitutionalMessageReceiver
/// @notice Application callbacks invoked only after gateway proof verification.
interface IInstitutionalMessageReceiver {
    function onInstitutionalMessage(
        bytes32 messageId,
        uint256 sourceChainId,
        address sourceApplication,
        bytes calldata payload
    ) external returns (bytes memory acknowledgement);
}

/// @title IInstitutionalMessageLifecycle
/// @notice Source callbacks for proven acknowledgement and timeout completion.
interface IInstitutionalMessageLifecycle {
    function onInstitutionalAcknowledgement(bytes32 messageId, bytes calldata acknowledgement) external;

    function onInstitutionalTimeout(bytes32 messageId) external;
}
