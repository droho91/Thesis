// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCClientTypes} from "./IBCClientTypes.sol";

/// @title IBCClientStore
/// @notice Small status store shared by IBC-lite clients.
abstract contract IBCClientStore {
    mapping(uint256 => IBCClientTypes.Status) internal clientStatuses;

    event ClientStatusChanged(
        uint256 indexed sourceChainId,
        IBCClientTypes.Status indexed previousStatus,
        IBCClientTypes.Status indexed newStatus,
        bytes32 evidenceHash,
        address actor
    );

    function status(uint256 sourceChainId) public view virtual returns (IBCClientTypes.Status) {
        return clientStatuses[sourceChainId];
    }

    function _setStatus(uint256 sourceChainId, IBCClientTypes.Status newStatus, bytes32 evidenceHash)
        internal
    {
        IBCClientTypes.Status previousStatus = clientStatuses[sourceChainId];
        clientStatuses[sourceChainId] = newStatus;
        emit ClientStatusChanged(sourceChainId, previousStatus, newStatus, evidenceHash, msg.sender);
    }
}
