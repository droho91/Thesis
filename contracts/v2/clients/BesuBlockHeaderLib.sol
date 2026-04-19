// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RLPDecodeLib} from "../../libs/RLPDecodeLib.sol";

/// @title BesuBlockHeaderLib
/// @notice Minimal RLP header parser for the Besu light-client rebuild lane.
library BesuBlockHeaderLib {
    struct ParsedHeader {
        bytes32 parentHash;
        address miner;
        bytes32 stateRoot;
        uint256 number;
        uint256 timestamp;
        bytes extraData;
    }

    function parse(bytes memory rawHeaderRlp) internal pure returns (ParsedHeader memory header) {
        bytes[] memory fields = RLPDecodeLib.readList(rawHeaderRlp);
        require(fields.length >= 15, "BESU_HEADER_FIELDS");

        header.parentHash = _toBytes32Strict(fields[0], "PARENT_HASH_LENGTH");
        header.miner = _toAddressStrict(fields[2], "MINER_LENGTH");
        header.stateRoot = _toBytes32Strict(fields[3], "STATE_ROOT_LENGTH");
        header.number = _toUint(fields[8]);
        header.timestamp = _toUint(fields[11]);
        header.extraData = fields[12];
    }

    function _toBytes32Strict(bytes memory value, string memory errorMessage) private pure returns (bytes32 result) {
        require(value.length == 32, errorMessage);
        result = RLPDecodeLib.toBytes32(value);
    }

    function _toAddressStrict(bytes memory value, string memory errorMessage) private pure returns (address result) {
        require(value.length == 20, errorMessage);
        assembly {
            result := shr(96, mload(add(value, 32)))
        }
    }

    function _toUint(bytes memory value) private pure returns (uint256 result) {
        require(value.length <= 32, "HEADER_UINT_TOO_LONG");
        for (uint256 i = 0; i < value.length; i++) {
            result = (result << 8) | uint8(value[i]);
        }
    }
}
