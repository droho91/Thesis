// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MerklePatriciaProofLib} from "../libs/MerklePatriciaProofLib.sol";
import {RLPDecodeLib} from "../libs/RLPDecodeLib.sol";
import {EVMProofTypes} from "./EVMProofTypes.sol";
import {IInstitutionalCheckpointClient} from "./IInstitutionalCheckpointClient.sol";
import {InstitutionalCheckpointTypes} from "./InstitutionalCheckpointTypes.sol";

/// @title InstitutionalEVMProofBoundary
/// @notice Verifies Ethereum storage proofs under quorum-attested source-chain state roots.
abstract contract InstitutionalEVMProofBoundary {
    IInstitutionalCheckpointClient public immutable checkpointClient;

    constructor(address checkpointClient_) {
        require(checkpointClient_ != address(0), "CHECKPOINT_CLIENT_ZERO");
        checkpointClient = IInstitutionalCheckpointClient(checkpointClient_);
    }

    function _verifyStorageMembership(EVMProofTypes.StorageProof calldata proof) internal view returns (bool) {
        if (!_validBoundary(proof, true)) return false;
        bytes32 storageRoot = _extractStorageRoot(proof);
        if (storageRoot == bytes32(0)) return false;

        return MerklePatriciaProofLib.verify(
            storageRoot,
            abi.encodePacked(EVMProofTypes.storageTrieKey(proof.storageKey)),
            proof.storageProof,
            proof.expectedValue
        );
    }

    function _verifyStorageAbsence(EVMProofTypes.StorageProof calldata proof) internal view returns (bool) {
        if (!_validBoundary(proof, false)) return false;
        bytes32 storageRoot = _extractStorageRoot(proof);
        if (storageRoot == bytes32(0)) return false;

        return MerklePatriciaProofLib.verifyAbsence(
            storageRoot,
            abi.encodePacked(EVMProofTypes.storageTrieKey(proof.storageKey)),
            proof.storageProof
        );
    }

    function _validBoundary(EVMProofTypes.StorageProof calldata proof, bool requireExpectedValue)
        private
        view
        returns (bool)
    {
        if (
            checkpointClient.status(proof.sourceChainId) != InstitutionalCheckpointTypes.ClientStatus.Active
        ) return false;
        bytes32 trustedRoot = checkpointClient.trustedStateRoot(proof.sourceChainId, proof.checkpointHeight);
        if (trustedRoot == bytes32(0) || trustedRoot != proof.stateRoot) return false;
        if (proof.account == address(0) || proof.accountProof.length == 0 || proof.storageProof.length == 0) {
            return false;
        }
        if (requireExpectedValue && proof.expectedValue.length == 0) return false;
        return true;
    }

    function _extractStorageRoot(EVMProofTypes.StorageProof calldata proof) private pure returns (bytes32) {
        bytes memory accountValue = MerklePatriciaProofLib.extractProofValue(
            proof.stateRoot,
            abi.encodePacked(EVMProofTypes.accountTrieKey(proof.account)),
            proof.accountProof
        );
        if (accountValue.length == 0) return bytes32(0);

        bytes[] memory accountFields = RLPDecodeLib.readList(accountValue);
        if (accountFields.length != 4 || accountFields[2].length != 32) return bytes32(0);
        return RLPDecodeLib.toBytes32(accountFields[2]);
    }
}
