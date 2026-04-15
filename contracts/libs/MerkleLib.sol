// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title MerkleLib
/// @notice Small binary Merkle helper for local packet commitment proofs.
library MerkleLib {
    function root(bytes32[] memory leaves) internal pure returns (bytes32) {
        require(leaves.length > 0, "LEAVES_EMPTY");
        uint256 levelLength = leaves.length;
        while (levelLength > 1) {
            uint256 nextLength = (levelLength + 1) / 2;
            for (uint256 i = 0; i < nextLength; i++) {
                uint256 leftIndex = i * 2;
                bytes32 left = leaves[leftIndex];
                bytes32 right = leftIndex + 1 < levelLength ? leaves[leftIndex + 1] : left;
                leaves[i] = keccak256(abi.encodePacked(left, right));
            }
            levelLength = nextLength;
        }
        return leaves[0];
    }

    function proofRoot(bytes32 leaf, uint256 leafIndex, bytes32[] memory siblings)
        internal
        pure
        returns (bytes32 computedRoot)
    {
        computedRoot = leaf;
        uint256 index = leafIndex;
        for (uint256 i = 0; i < siblings.length; i++) {
            bytes32 sibling = siblings[i];
            if (index & 1 == 0) {
                computedRoot = keccak256(abi.encodePacked(computedRoot, sibling));
            } else {
                computedRoot = keccak256(abi.encodePacked(sibling, computedRoot));
            }
            index >>= 1;
        }
    }

    function verify(bytes32 rootHash, bytes32 leaf, uint256 leafIndex, bytes32[] memory siblings)
        internal
        pure
        returns (bool)
    {
        return proofRoot(leaf, leafIndex, siblings) == rootHash;
    }
}
