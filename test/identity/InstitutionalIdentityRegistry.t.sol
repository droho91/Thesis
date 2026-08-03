// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {InstitutionalIdentityRegistry} from "../../contracts/identity/InstitutionalIdentityRegistry.sol";

contract InstitutionalIdentityRegistryTest is Test {
    address internal constant CUSTOMER = address(0xC001);
    address internal constant ISSUER = address(0x1550);
    address internal constant COMPLIANCE = address(0xC0A1);
    address internal constant GUARDIAN = address(0x600D);

    InstitutionalIdentityRegistry internal registry;

    function setUp() public {
        vm.warp(1_800_000_000);
        registry = new InstitutionalIdentityRegistry(address(this));
        registry.grantRole(registry.IDENTITY_ISSUER_ROLE(), ISSUER);
        registry.grantRole(registry.COMPLIANCE_ROLE(), COMPLIANCE);
        registry.grantRole(registry.GUARDIAN_ROLE(), GUARDIAN);
    }

    function testIssuerCreatesDataMinimizedCredential() public {
        _issue(CUSTOMER, uint64(block.timestamp + 365 days), 2);

        (InstitutionalIdentityRegistry.Credential memory credential, InstitutionalIdentityRegistry.CredentialStatus status) =
            registry.getCredential(CUSTOMER);
        assertEq(credential.customerRecordHash, keccak256("off-chain-customer-record"));
        assertEq(credential.jurisdictionCode, bytes32("VN"));
        assertEq(credential.riskTier, 2);
        assertEq(uint256(status), uint256(InstitutionalIdentityRegistry.CredentialStatus.Active));
        assertTrue(registry.isEligible(CUSTOMER));
    }

    function testExpiredCredentialBecomesIneligibleWithoutAdministrativeTransaction() public {
        uint64 validUntil = uint64(block.timestamp + 30 days);
        _issue(CUSTOMER, validUntil, 2);
        vm.warp(validUntil);

        assertFalse(registry.isEligible(CUSTOMER));
        assertEq(
            uint256(registry.effectiveStatus(CUSTOMER)),
            uint256(InstitutionalIdentityRegistry.CredentialStatus.Expired)
        );
    }

    function testComplianceSuspendsAndReactivatesCredential() public {
        _issue(CUSTOMER, uint64(block.timestamp + 365 days), 2);

        vm.prank(COMPLIANCE);
        registry.setCredentialStatus(CUSTOMER, InstitutionalIdentityRegistry.CredentialStatus.Suspended);
        assertFalse(registry.isEligible(CUSTOMER));

        vm.prank(COMPLIANCE);
        registry.setCredentialStatus(CUSTOMER, InstitutionalIdentityRegistry.CredentialStatus.Active);
        assertTrue(registry.isEligible(CUSTOMER));
    }

    function testGuardianCanSuspendButCannotReactivate() public {
        _issue(CUSTOMER, uint64(block.timestamp + 365 days), 2);
        vm.prank(GUARDIAN);
        registry.guardianSuspend(CUSTOMER);
        assertFalse(registry.isEligible(CUSTOMER));

        vm.prank(GUARDIAN);
        vm.expectRevert();
        registry.setCredentialStatus(CUSTOMER, InstitutionalIdentityRegistry.CredentialStatus.Active);
    }

    function testRevokedCredentialCannotBeReactivatedOrRenewed() public {
        _issue(CUSTOMER, uint64(block.timestamp + 365 days), 2);
        vm.prank(COMPLIANCE);
        registry.setCredentialStatus(CUSTOMER, InstitutionalIdentityRegistry.CredentialStatus.Revoked);
        assertTrue(registry.isRevoked(CUSTOMER));
        assertFalse(registry.isEligible(CUSTOMER));

        vm.prank(COMPLIANCE);
        vm.expectRevert(bytes("CREDENTIAL_REVOKED_TERMINAL"));
        registry.setCredentialStatus(CUSTOMER, InstitutionalIdentityRegistry.CredentialStatus.Active);

        vm.prank(ISSUER);
        vm.expectRevert(bytes("CREDENTIAL_NOT_RENEWABLE"));
        registry.renewCredential(CUSTOMER, uint64(block.timestamp + 500 days), 2);
    }

    function testIssuerCanRenewButCannotDuplicateCredential() public {
        uint64 firstExpiry = uint64(block.timestamp + 30 days);
        _issue(CUSTOMER, firstExpiry, 2);

        vm.prank(ISSUER);
        registry.renewCredential(CUSTOMER, uint64(block.timestamp + 365 days), 3);
        (InstitutionalIdentityRegistry.Credential memory credential,) = registry.getCredential(CUSTOMER);
        assertEq(credential.riskTier, 3);
        assertGt(credential.validUntil, firstExpiry);

        vm.prank(ISSUER);
        vm.expectRevert(bytes("CREDENTIAL_ALREADY_EXISTS"));
        registry.issueCredential(
            CUSTOMER,
            keccak256("different-record"),
            bytes32("VN"),
            uint64(block.timestamp + 400 days),
            2
        );
    }

    function testRejectsInvalidExpiryAndRiskTier() public {
        vm.startPrank(ISSUER);
        vm.expectRevert(bytes("CREDENTIAL_NOT_FORWARD"));
        registry.issueCredential(CUSTOMER, keccak256("record"), bytes32("VN"), uint64(block.timestamp), 2);

        vm.expectRevert(bytes("BAD_RISK_TIER"));
        registry.issueCredential(
            CUSTOMER,
            keccak256("record"),
            bytes32("VN"),
            uint64(block.timestamp + 365 days),
            6
        );
        vm.stopPrank();
    }

    function _issue(address account, uint64 validUntil, uint8 riskTier) internal {
        vm.prank(ISSUER);
        registry.issueCredential(
            account,
            keccak256("off-chain-customer-record"),
            bytes32("VN"),
            validUntil,
            riskTier
        );
    }
}
