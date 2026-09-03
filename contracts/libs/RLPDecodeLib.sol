// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title RLPDecodeLib
/// @notice Minimal RLP decoder used by the EVM account/storage proof verifier.
library RLPDecodeLib {
    function readList(bytes memory encoded) internal pure returns (bytes[] memory items) {
        (uint256 payloadOffset, uint256 payloadLength, bool isList) = _payloadBounds(encoded, 0);
        require(isList, "RLP_NOT_LIST");
        require(payloadOffset + payloadLength == encoded.length, "RLP_TRAILING_BYTES");

        uint256 cursor = payloadOffset;
        uint256 end = payloadOffset + payloadLength;
        uint256 count;
        while (cursor < end) {
            cursor += _itemLength(encoded, cursor);
            count++;
        }
        require(cursor == end, "RLP_LIST_LENGTH_MISMATCH");

        items = new bytes[](count);
        cursor = payloadOffset;
        for (uint256 i = 0; i < count; i++) {
            uint256 itemLength = _itemLength(encoded, cursor);
            items[i] = _payload(encoded, cursor, itemLength);
            cursor += itemLength;
        }
    }

    function readListItems(bytes memory encoded) internal pure returns (bytes[] memory items) {
        (uint256 payloadOffset, uint256 payloadLength, bool isList) = _payloadBounds(encoded, 0);
        require(isList, "RLP_NOT_LIST");
        require(payloadOffset + payloadLength == encoded.length, "RLP_TRAILING_BYTES");

        uint256 cursor = payloadOffset;
        uint256 end = payloadOffset + payloadLength;
        uint256 count;
        while (cursor < end) {
            cursor += _itemLength(encoded, cursor);
            count++;
        }
        require(cursor == end, "RLP_LIST_LENGTH_MISMATCH");

        items = new bytes[](count);
        cursor = payloadOffset;
        for (uint256 i = 0; i < count; i++) {
            uint256 itemLength = _itemLength(encoded, cursor);
            items[i] = _slice(encoded, cursor, itemLength);
            cursor += itemLength;
        }
    }

    function readBytes(bytes memory encoded) internal pure returns (bytes memory out) {
        (uint256 payloadOffset, uint256 payloadLength, bool isList) = _payloadBounds(encoded, 0);
        require(!isList, "RLP_NOT_BYTES");
        require(payloadOffset + payloadLength == encoded.length, "RLP_TRAILING_BYTES");
        return _slice(encoded, payloadOffset, payloadLength);
    }

    function toBytes32(bytes memory value) internal pure returns (bytes32 result) {
        // This conversion is used for the fixed-width storageRoot field in an
        // Ethereum account tuple. Short RLP integers have different semantics;
        // accepting them here would make an accidental caller-dependent shift.
        require(value.length == 32, "RLP_BYTES32_LENGTH");
        assembly {
            result := mload(add(value, 32))
        }
    }

    function _payload(bytes memory encoded, uint256 start, uint256 length) private pure returns (bytes memory out) {
        (uint256 payloadOffset, uint256 payloadLength, bool isList) = _payloadBounds(encoded, start);
        require(payloadOffset + payloadLength <= start + length, "RLP_PAYLOAD_OOB");
        // MPT inline children are nested RLP lists. Preserve their complete
        // encoding so callers can compare the child reference with the next
        // proof node; byte-string items continue to return their payload.
        if (isList) return _slice(encoded, start, length);
        out = _slice(encoded, payloadOffset, payloadLength);
    }

    function _payloadBounds(bytes memory encoded, uint256 start)
        private
        pure
        returns (uint256 payloadOffset, uint256 payloadLength, bool isList)
    {
        require(start < encoded.length, "RLP_START_OOB");
        uint8 prefix = uint8(encoded[start]);

        if (prefix <= 0x7f) {
            return (start, 1, false);
        }
        if (prefix <= 0xb7) {
            payloadLength = prefix - 0x80;
            payloadOffset = start + 1;
            require(payloadOffset + payloadLength <= encoded.length, "RLP_SHORT_STRING_OOB");
            if (payloadLength == 1) {
                require(uint8(encoded[payloadOffset]) >= 0x80, "RLP_NON_CANONICAL_SINGLE_BYTE");
            }
            return (payloadOffset, payloadLength, false);
        }
        if (prefix <= 0xbf) {
            uint256 stringLengthOfLength = prefix - 0xb7;
            payloadLength = _readLength(encoded, start + 1, stringLengthOfLength);
            require(payloadLength > 55, "RLP_NON_CANONICAL_LONG_STRING");
            payloadOffset = start + 1 + stringLengthOfLength;
            require(payloadOffset + payloadLength <= encoded.length, "RLP_LONG_STRING_OOB");
            return (payloadOffset, payloadLength, false);
        }
        if (prefix <= 0xf7) {
            payloadLength = prefix - 0xc0;
            payloadOffset = start + 1;
            require(payloadOffset + payloadLength <= encoded.length, "RLP_SHORT_LIST_OOB");
            return (payloadOffset, payloadLength, true);
        }

        uint256 listLengthOfLength = prefix - 0xf7;
        payloadLength = _readLength(encoded, start + 1, listLengthOfLength);
        require(payloadLength > 55, "RLP_NON_CANONICAL_LONG_LIST");
        payloadOffset = start + 1 + listLengthOfLength;
        require(payloadOffset + payloadLength <= encoded.length, "RLP_LONG_LIST_OOB");
        return (payloadOffset, payloadLength, true);
    }

    function _itemLength(bytes memory encoded, uint256 start) private pure returns (uint256) {
        (uint256 payloadOffset, uint256 payloadLength,) = _payloadBounds(encoded, start);
        return (payloadOffset - start) + payloadLength;
    }

    function _readLength(bytes memory encoded, uint256 start, uint256 lengthOfLength)
        private
        pure
        returns (uint256 result)
    {
        require(lengthOfLength > 0 && lengthOfLength <= 32, "RLP_LENGTH_OF_LENGTH_INVALID");
        require(start + lengthOfLength <= encoded.length, "RLP_LENGTH_OOB");
        require(encoded[start] != bytes1(0), "RLP_NON_CANONICAL_LENGTH");
        for (uint256 i = 0; i < lengthOfLength; i++) {
            result = (result << 8) | uint8(encoded[start + i]);
        }
    }

    function _slice(bytes memory input, uint256 start, uint256 length) private pure returns (bytes memory out) {
        require(start + length <= input.length, "RLP_SLICE_OOB");
        out = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            out[i] = input[start + i];
        }
    }
}
