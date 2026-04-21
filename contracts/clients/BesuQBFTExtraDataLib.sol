// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RLPDecodeLib} from "../libs/RLPDecodeLib.sol";
import {BesuLightClientTypes} from "./BesuLightClientTypes.sol";

/// @title BesuQBFTExtraDataLib
/// @notice Parses the QBFT `extraData` structure so the interchain lane is anchored on Besu-native artifacts.
library BesuQBFTExtraDataLib {
    function parse(bytes memory extraData)
        internal
        pure
        returns (BesuLightClientTypes.ParsedExtraData memory parsed)
    {
        bytes[] memory outer = RLPDecodeLib.readListItems(extraData);
        require(outer.length == 5, "QBFT_EXTRA_DATA_SHAPE");

        bytes memory vanity = RLPDecodeLib.readBytes(outer[0]);
        require(vanity.length == 32, "QBFT_VANITY_LENGTH");
        parsed.vanity = RLPDecodeLib.toBytes32(vanity);
        parsed.validators = _readAddressList(outer[1]);
        // QBFT vote is itself an RLP item and may be an empty list rather than a byte string.
        // Keep the encoded vote item verbatim so the client stays faithful to the native header shape.
        parsed.vote = outer[2];
        parsed.round = _toUint(RLPDecodeLib.readBytes(outer[3]));
        parsed.commitSeals = _readBytesList(outer[4]);
    }

    function validatorsHash(address[] memory validators) internal pure returns (bytes32) {
        return keccak256(abi.encode(validators));
    }

    function minimumCommitSeals(uint256 validatorCount) internal pure returns (uint256) {
        require(validatorCount > 0, "VALIDATOR_COUNT_ZERO");
        return (validatorCount * 2) / 3 + 1;
    }

    function _readAddressList(bytes memory encoded) private pure returns (address[] memory addresses) {
        bytes[] memory items = RLPDecodeLib.readListItems(encoded);
        addresses = new address[](items.length);
        for (uint256 i = 0; i < items.length; i++) {
            addresses[i] = _toAddress(RLPDecodeLib.readBytes(items[i]));
        }
    }

    function _readBytesList(bytes memory encoded) private pure returns (bytes[] memory out) {
        bytes[] memory items = RLPDecodeLib.readListItems(encoded);
        out = new bytes[](items.length);
        for (uint256 i = 0; i < items.length; i++) {
            out[i] = RLPDecodeLib.readBytes(items[i]);
        }
    }

    function _toAddress(bytes memory value) private pure returns (address result) {
        require(value.length == 20, "QBFT_ADDRESS_LENGTH");
        assembly {
            result := shr(96, mload(add(value, 32)))
        }
    }

    function _toUint(bytes memory value) private pure returns (uint256 result) {
        require(value.length <= 32, "QBFT_UINT_TOO_LONG");
        for (uint256 i = 0; i < value.length; i++) {
            result = (result << 8) | uint8(value[i]);
        }
    }
}
