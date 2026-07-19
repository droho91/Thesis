// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EVMProofTypes} from "./EVMProofTypes.sol";
import {InstitutionalEVMProofBoundary} from "./InstitutionalEVMProofBoundary.sol";

/// @title InstitutionalEVMProofVerifier
/// @notice Public verifier surface used for integration tests and external inspection.
contract InstitutionalEVMProofVerifier is InstitutionalEVMProofBoundary {
    constructor(address checkpointClient_) InstitutionalEVMProofBoundary(checkpointClient_) {}

    function verifyStorageMembership(EVMProofTypes.StorageProof calldata proof) external view returns (bool) {
        return _verifyStorageMembership(proof);
    }

    function verifyStorageAbsence(EVMProofTypes.StorageProof calldata proof) external view returns (bool) {
        return _verifyStorageAbsence(proof);
    }
}
