// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MerklePatriciaProofLib} from "../../libs/MerklePatriciaProofLib.sol";
import {RLPDecodeLib} from "../../libs/RLPDecodeLib.sol";
import {IBesuLightClient} from "../clients/IBesuLightClient.sol";
import {IBCEVMTypesV2} from "./IBCEVMTypesV2.sol";

/// @title IBCEVMProofBoundaryV2
/// @notice Verifies Ethereum account/storage proofs under a Besu light-client trusted state root.
abstract contract IBCEVMProofBoundaryV2 {
    IBesuLightClient public immutable besuLightClient;

    constructor(address _besuLightClient) {
        require(_besuLightClient != address(0), "CLIENT_ZERO");
        besuLightClient = IBesuLightClient(_besuLightClient);
    }

    function _trustedStateRoot(uint256 sourceChainId, uint256 trustedHeight) internal view returns (bytes32) {
        return besuLightClient.trustedStateRoot(sourceChainId, trustedHeight);
    }

    function _verifyTrustedEVMStorageProofBoundary(IBCEVMTypesV2.StorageProof calldata proof)
        internal
        view
        returns (bool)
    {
        bytes32 trustedRoot = _trustedStateRoot(proof.sourceChainId, proof.trustedHeight);
        if (trustedRoot == bytes32(0) || trustedRoot != proof.stateRoot) return false;
        if (proof.account == address(0) || proof.expectedValue.length == 0) {
            return false;
        }
        if (proof.accountProof.length == 0 || proof.storageProof.length == 0) return false;
        return true;
    }

    function _verifyTrustedEVMStorageProof(IBCEVMTypesV2.StorageProof calldata proof) internal view returns (bool) {
        if (!_verifyTrustedEVMStorageProofBoundary(proof)) return false;

        bytes memory accountValue = MerklePatriciaProofLib.extractProofValue(
            proof.stateRoot,
            abi.encodePacked(IBCEVMTypesV2.accountTrieKey(proof.account)),
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
            abi.encodePacked(IBCEVMTypesV2.storageTrieKey(proof.storageKey)),
            proof.storageProof,
            proof.expectedValue
        );
    }

    function _verifyTrustedEVMStorageAbsenceProof(IBCEVMTypesV2.StorageProof calldata proof)
        internal
        view
        returns (bool)
    {
        bytes32 trustedRoot = _trustedStateRoot(proof.sourceChainId, proof.trustedHeight);
        if (trustedRoot == bytes32(0) || trustedRoot != proof.stateRoot) return false;
        if (proof.account == address(0) || proof.accountProof.length == 0 || proof.storageProof.length == 0) {
            return false;
        }

        bytes memory accountValue = MerklePatriciaProofLib.extractProofValue(
            proof.stateRoot,
            abi.encodePacked(IBCEVMTypesV2.accountTrieKey(proof.account)),
            proof.accountProof
        );
        if (accountValue.length == 0) return false;

        bytes[] memory accountFields = RLPDecodeLib.readList(accountValue);
        if (accountFields.length != 4) return false;
        bytes memory storageRootBytes = accountFields[2];
        if (storageRootBytes.length != 32) return false;
        bytes32 storageRoot = RLPDecodeLib.toBytes32(storageRootBytes);

        return MerklePatriciaProofLib.verifyAbsence(
            storageRoot,
            abi.encodePacked(IBCEVMTypesV2.storageTrieKey(proof.storageKey)),
            proof.storageProof
        );
    }
}
