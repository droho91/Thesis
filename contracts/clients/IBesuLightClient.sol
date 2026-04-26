// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BesuLightClientTypes} from "./BesuLightClientTypes.sol";

/// @title IBesuLightClient
/// @notice Minimal Besu/QBFT light-client interface for a native Besu/QBFT light client.
interface IBesuLightClient {
    function status(uint256 sourceChainId) external view returns (BesuLightClientTypes.ClientStatus);

    function beginRecovery(uint256 sourceChainId) external;

    function recoverClient(
        uint256 sourceChainId,
        BesuLightClientTypes.TrustedHeader calldata trustedHeader,
        BesuLightClientTypes.ValidatorSet calldata validatorSet
    ) external;

    function initializeTrustAnchor(
        uint256 sourceChainId,
        BesuLightClientTypes.TrustedHeader calldata trustedHeader,
        BesuLightClientTypes.ValidatorSet calldata validatorSet
    ) external;

    function updateClient(
        BesuLightClientTypes.HeaderUpdate calldata update,
        BesuLightClientTypes.ValidatorSet calldata expectedValidatorSet
    ) external returns (bytes32 trustedHeaderHash);

    function updateClientBatch(
        BesuLightClientTypes.HeaderUpdate[] calldata updates,
        BesuLightClientTypes.ValidatorSet[] calldata expectedValidatorSets
    ) external returns (bytes32 trustedHeaderHash);

    function trustedStateRoot(uint256 sourceChainId, uint256 height) external view returns (bytes32);

    function trustedTimestamp(uint256 sourceChainId, uint256 height) external view returns (uint256);

    function trustedHeader(uint256 sourceChainId, uint256 height)
        external
        view
        returns (BesuLightClientTypes.TrustedHeader memory);

    function validatorSet(uint256 sourceChainId, uint256 epoch)
        external
        view
        returns (BesuLightClientTypes.ValidatorSet memory);
}
