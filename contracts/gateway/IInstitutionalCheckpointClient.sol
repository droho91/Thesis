// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {InstitutionalCheckpointTypes} from "./InstitutionalCheckpointTypes.sol";

/// @title IInstitutionalCheckpointClient
/// @notice State-root client consumed by the institutional cross-chain gateway.
interface IInstitutionalCheckpointClient {
    function status(uint256 sourceChainId) external view returns (InstitutionalCheckpointTypes.ClientStatus);

    function latestTrustedHeight(uint256 sourceChainId) external view returns (uint256);

    /// @notice Lowest checkpoint height that may authorize proofs for a source.
    /// @dev Historical checkpoints below this floor remain queryable for audit but are not proof-authorizing.
    function checkpointAuthorizationFloor(uint256 sourceChainId) external view returns (uint256);

    function trustedStateRoot(uint256 sourceChainId, uint256 blockNumber) external view returns (bytes32);

    function trustedTimestamp(uint256 sourceChainId, uint256 blockNumber) external view returns (uint256);

    function checkpointDigest(InstitutionalCheckpointTypes.Checkpoint calldata checkpoint)
        external
        view
        returns (bytes32);
}
