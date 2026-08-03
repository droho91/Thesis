// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IInstitutionalIdentityRegistry
/// @notice Data-minimized eligibility surface consumed by bank applications.
interface IInstitutionalIdentityRegistry {
    function isEligible(address account) external view returns (bool);

    function isRevoked(address account) external view returns (bool);
}
