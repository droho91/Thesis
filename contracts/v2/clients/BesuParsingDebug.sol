// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BesuBlockHeaderLib} from "./BesuBlockHeaderLib.sol";
import {BesuLightClientTypes} from "./BesuLightClientTypes.sol";
import {BesuQBFTExtraDataLib} from "./BesuQBFTExtraDataLib.sol";

/// @title BesuParsingDebug
/// @notice Temporary harness for isolating raw-header and QBFT extraData parsing issues on-chain.
contract BesuParsingDebug {
    function parseHeader(bytes calldata rawHeaderRlp)
        external
        pure
        returns (
            bytes32 parentHash,
            address miner,
            bytes32 stateRoot,
            uint256 number,
            uint256 timestamp,
            bytes memory extraData
        )
    {
        BesuBlockHeaderLib.ParsedHeader memory header = BesuBlockHeaderLib.parse(rawHeaderRlp);
        return (header.parentHash, header.miner, header.stateRoot, header.number, header.timestamp, header.extraData);
    }

    function parseExtraData(bytes calldata extraData)
        external
        pure
        returns (
            bytes32 vanity,
            address[] memory validators,
            bytes memory vote,
            uint256 round,
            bytes[] memory commitSeals
        )
    {
        BesuLightClientTypes.ParsedExtraData memory parsed = BesuQBFTExtraDataLib.parse(extraData);
        return (parsed.vanity, parsed.validators, parsed.vote, parsed.round, parsed.commitSeals);
    }

    function parseHeaderThenExtraData(bytes calldata rawHeaderRlp)
        external
        pure
        returns (
            bytes32 parentHash,
            uint256 number,
            bytes32 validatorsHash,
            uint256 commitSealCount
        )
    {
        BesuBlockHeaderLib.ParsedHeader memory header = BesuBlockHeaderLib.parse(rawHeaderRlp);
        BesuLightClientTypes.ParsedExtraData memory parsed = BesuQBFTExtraDataLib.parse(header.extraData);
        return (
            header.parentHash,
            header.number,
            BesuQBFTExtraDataLib.validatorsHash(parsed.validators),
            parsed.commitSeals.length
        );
    }
}
