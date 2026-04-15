// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCClientTypes} from "./IBCClientTypes.sol";

/// @title IBCClient
/// @notice Minimal client interface used by packet handlers.
interface IBCClient {
    function status(uint256 sourceChainId) external view returns (IBCClientTypes.Status);

    function verifyMembership(
        uint256 sourceChainId,
        bytes32 consensusStateHash,
        bytes32 leaf,
        uint256 leafIndex,
        bytes32[] calldata siblings
    ) external view returns (bool);

    function verifyNonMembership(
        uint256 sourceChainId,
        bytes32 consensusStateHash,
        bytes32 path,
        bytes calldata proof
    ) external view returns (bool);
}
