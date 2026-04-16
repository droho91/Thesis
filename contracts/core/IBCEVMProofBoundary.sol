// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCClient} from "./IBCClient.sol";
import {IBCEVMTypes} from "./IBCEVMTypes.sol";
import {MerklePatriciaProofLib} from "../libs/MerklePatriciaProofLib.sol";
import {RLPDecodeLib} from "../libs/RLPDecodeLib.sol";

/// @title IBCEVMProofBoundary
/// @notice Transitional helper for the Besu/EVM path. It binds EVM proofs to a trusted
///         remote `stateRoot` and verifies account/storage inclusion under that root.
///         It still does not verify Besu header finality or replace the packet flow end-to-end.
abstract contract IBCEVMProofBoundary {
    IBCClient public immutable ibcClient;

    constructor(address _ibcClient) {
        require(_ibcClient != address(0), "CLIENT_ZERO");
        ibcClient = IBCClient(_ibcClient);
    }

    function _trustedStateRoot(uint256 sourceChainId, bytes32 consensusStateHash) internal view returns (bytes32) {
        return ibcClient.trustedStateRoot(sourceChainId, consensusStateHash);
    }

    function _verifyTrustedEVMStorageProofBoundary(IBCEVMTypes.StorageProof calldata proof)
        internal
        view
        returns (bool)
    {
        bytes32 trustedRoot = _trustedStateRoot(proof.sourceChainId, proof.consensusStateHash);
        if (trustedRoot == bytes32(0) || trustedRoot != proof.stateRoot) return false;
        if (proof.account == address(0) || proof.storageKey == bytes32(0) || proof.expectedValue.length == 0) {
            return false;
        }
        if (proof.accountProof.length == 0 || proof.storageProof.length == 0) return false;
        return true;
    }

    function _verifyTrustedEVMStorageProof(IBCEVMTypes.StorageProof calldata proof) internal view returns (bool) {
        if (!_verifyTrustedEVMStorageProofBoundary(proof)) return false;

        bytes memory accountValue = MerklePatriciaProofLib.extractProofValue(
            proof.stateRoot,
            abi.encodePacked(IBCEVMTypes.accountTrieKey(proof.account)),
            proof.accountProof
        );
        if (accountValue.length == 0) return false;

        bytes[] memory accountFields = RLPDecodeLib.readList(accountValue);
        if (accountFields.length != 4) return false;
        bytes memory storageRootBytes = accountFields[2];
        if (storageRootBytes.length != 32) return false;
        bytes32 storageRoot = RLPDecodeLib.toBytes32(storageRootBytes);

        return MerklePatriciaProofLib.verify(
            storageRoot,
            abi.encodePacked(IBCEVMTypes.storageTrieKey(proof.storageKey)),
            proof.storageProof,
            proof.expectedValue
        );
    }
}
