// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {HexPrefixLib} from "./HexPrefixLib.sol";
import {RLPDecodeLib} from "./RLPDecodeLib.sol";

/// @title MerklePatriciaProofLib
/// @notice Minimal inclusion verifier for Ethereum Merkle Patricia Trie proofs.
library MerklePatriciaProofLib {
    function verify(bytes32 rootHash, bytes memory trieKey, bytes[] memory proof, bytes memory expectedValue)
        internal
        pure
        returns (bool)
    {
        bytes memory value = extractProofValue(rootHash, trieKey, proof);
        return _equalBytes(value, expectedValue);
    }

    function extractProofValue(bytes32 rootHash, bytes memory trieKey, bytes[] memory proof)
        internal
        pure
        returns (bytes memory)
    {
        if (rootHash == bytes32(0) || proof.length == 0) return new bytes(0);

        bytes memory path = HexPrefixLib.toNibbles(trieKey);
        bytes memory expectedNodeRef = abi.encodePacked(rootHash);
        uint256 pathOffset;

        for (uint256 i = 0; i < proof.length; i++) {
            bytes memory node = proof[i];
            if (!_matchesReference(expectedNodeRef, node, i == 0)) return new bytes(0);

            bytes[] memory decoded = RLPDecodeLib.readList(node);
            if (decoded.length == 17) {
                if (pathOffset == path.length) {
                    return decoded[16];
                }

                bytes memory nextNodeRef = decoded[uint8(path[pathOffset])];
                if (nextNodeRef.length == 0) return new bytes(0);
                expectedNodeRef = nextNodeRef;
                pathOffset += 1;
                continue;
            }

            if (decoded.length == 2) {
                (bytes memory partialPath, bool isLeaf) = HexPrefixLib.decodeCompact(decoded[0]);
                if (!HexPrefixLib.startsWith(path, pathOffset, partialPath)) return new bytes(0);
                pathOffset += partialPath.length;

                if (isLeaf) {
                    return pathOffset == path.length ? decoded[1] : new bytes(0);
                }

                if (decoded[1].length == 0) return new bytes(0);
                expectedNodeRef = decoded[1];
                continue;
            }

            return new bytes(0);
        }

        return new bytes(0);
    }

    function _matchesReference(bytes memory expectedNodeRef, bytes memory node, bool isRoot)
        private
        pure
        returns (bool)
    {
        if (expectedNodeRef.length == 0) return false;
        if (isRoot || expectedNodeRef.length == 32) {
            return keccak256(node) == bytes32(expectedNodeRef);
        }
        return _equalBytes(expectedNodeRef, node);
    }

    function _equalBytes(bytes memory a, bytes memory b) private pure returns (bool) {
        return keccak256(a) == keccak256(b);
    }
}
