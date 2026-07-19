// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IInstitutionalIdentityRegistry
/// @notice Privacy-minimized eligibility surface consumed by bank applications.
interface IInstitutionalIdentityRegistry {
    function isEligible(address account) external view returns (bool);
}
