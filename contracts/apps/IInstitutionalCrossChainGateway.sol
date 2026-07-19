// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {InstitutionalMessageLib} from "../gateway/InstitutionalMessageLib.sol";

/// @title IInstitutionalCrossChainGateway
/// @notice Application-facing gateway surface.
interface IInstitutionalCrossChainGateway {
    function sendMessage(
        uint256 destinationChainId,
        address destinationApplication,
        bytes calldata payload,
        uint64 timeoutTimestamp
    ) external returns (bytes32 messageId, InstitutionalMessageLib.Message memory message);
}
