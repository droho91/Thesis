// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCEVMProofBoundary} from "./IBCEVMProofBoundary.sol";
import {IBCEVMTypes} from "./IBCEVMTypes.sol";

/// @title BesuEVMProofVerifier
/// @notice Thin wrapper so the interchain lane can verify trusted storage proofs against BesuLightClient.
contract BesuEVMProofVerifier is IBCEVMProofBoundary {
    constructor(address besuLightClient_) IBCEVMProofBoundary(besuLightClient_) {}

    function verifyStorageProof(IBCEVMTypes.StorageProof calldata proof) external view returns (bool) {
        return _verifyTrustedEVMStorageProof(proof);
    }
}
