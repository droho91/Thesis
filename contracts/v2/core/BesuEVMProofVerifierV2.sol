// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCEVMProofBoundaryV2} from "./IBCEVMProofBoundaryV2.sol";
import {IBCEVMTypesV2} from "./IBCEVMTypesV2.sol";

/// @title BesuEVMProofVerifierV2
/// @notice Thin wrapper so the v2 lane can smoke-test trusted storage proofs against BesuLightClient.
contract BesuEVMProofVerifierV2 is IBCEVMProofBoundaryV2 {
    constructor(address besuLightClient_) IBCEVMProofBoundaryV2(besuLightClient_) {}

    function verifyStorageProof(IBCEVMTypesV2.StorageProof calldata proof) external view returns (bool) {
        return _verifyTrustedEVMStorageProof(proof);
    }
}
