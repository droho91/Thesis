// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IInstitutionalIdentityRegistry} from "./IInstitutionalIdentityRegistry.sol";

/// @title InstitutionalIdentityRegistry
/// @notice Stores eligibility and hashes of off-chain customer records without putting raw PII on-chain.
contract InstitutionalIdentityRegistry is AccessControl, IInstitutionalIdentityRegistry {
    bytes32 public constant IDENTITY_ISSUER_ROLE = keccak256("IDENTITY_ISSUER_ROLE");
    bytes32 public constant COMPLIANCE_ROLE = keccak256("COMPLIANCE_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    enum CredentialStatus {
        Unverified,
        Active,
        Suspended,
        Revoked,
        Expired
    }

    struct Credential {
        bytes32 customerRecordHash;
        bytes32 jurisdictionCode;
        uint64 validUntil;
        uint8 riskTier;
        CredentialStatus status;
    }

    mapping(address => Credential) private credentials;

    event CredentialIssued(
        address indexed account,
        bytes32 indexed customerRecordHash,
        bytes32 indexed jurisdictionCode,
        uint64 validUntil,
        uint8 riskTier
    );
    event CredentialRenewed(address indexed account, uint64 validUntil, uint8 riskTier);
    event CredentialStatusChanged(address indexed account, CredentialStatus previousStatus, CredentialStatus newStatus);

    constructor(address admin) {
        require(admin != address(0), "ADMIN_ZERO");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function issueCredential(
        address account,
        bytes32 customerRecordHash,
        bytes32 jurisdictionCode,
        uint64 validUntil,
        uint8 riskTier
    ) external onlyRole(IDENTITY_ISSUER_ROLE) {
        require(account != address(0), "ACCOUNT_ZERO");
        require(customerRecordHash != bytes32(0), "CUSTOMER_HASH_ZERO");
        require(jurisdictionCode != bytes32(0), "JURISDICTION_ZERO");
        require(validUntil > block.timestamp, "CREDENTIAL_NOT_FORWARD");
        require(riskTier > 0 && riskTier <= 5, "BAD_RISK_TIER");
        require(credentials[account].status == CredentialStatus.Unverified, "CREDENTIAL_ALREADY_EXISTS");

        credentials[account] = Credential({
            customerRecordHash: customerRecordHash,
            jurisdictionCode: jurisdictionCode,
            validUntil: validUntil,
            riskTier: riskTier,
            status: CredentialStatus.Active
        });
        emit CredentialIssued(account, customerRecordHash, jurisdictionCode, validUntil, riskTier);
    }

    function renewCredential(address account, uint64 validUntil, uint8 riskTier)
        external
        onlyRole(IDENTITY_ISSUER_ROLE)
    {
        Credential storage credential = credentials[account];
        require(
            credential.status == CredentialStatus.Active || credential.status == CredentialStatus.Suspended,
            "CREDENTIAL_NOT_RENEWABLE"
        );
        require(validUntil > block.timestamp && validUntil > credential.validUntil, "RENEWAL_NOT_FORWARD");
        require(riskTier > 0 && riskTier <= 5, "BAD_RISK_TIER");
        credential.validUntil = validUntil;
        credential.riskTier = riskTier;
        emit CredentialRenewed(account, validUntil, riskTier);
    }

    function setCredentialStatus(address account, CredentialStatus newStatus) external onlyRole(COMPLIANCE_ROLE) {
        require(newStatus == CredentialStatus.Active || newStatus == CredentialStatus.Suspended || newStatus == CredentialStatus.Revoked, "BAD_STATUS");
        Credential storage credential = credentials[account];
        CredentialStatus previousStatus = effectiveStatus(account);
        require(credential.status != CredentialStatus.Unverified, "CREDENTIAL_NOT_FOUND");
        require(credential.status != CredentialStatus.Revoked, "CREDENTIAL_REVOKED_TERMINAL");
        if (newStatus == CredentialStatus.Active) require(credential.validUntil > block.timestamp, "CREDENTIAL_EXPIRED");
        credential.status = newStatus;
        emit CredentialStatusChanged(account, previousStatus, newStatus);
    }

    function guardianSuspend(address account) external onlyRole(GUARDIAN_ROLE) {
        Credential storage credential = credentials[account];
        CredentialStatus previousStatus = effectiveStatus(account);
        require(previousStatus == CredentialStatus.Active, "CREDENTIAL_NOT_ACTIVE");
        credential.status = CredentialStatus.Suspended;
        emit CredentialStatusChanged(account, previousStatus, CredentialStatus.Suspended);
    }

    function isEligible(address account) public view override returns (bool) {
        return effectiveStatus(account) == CredentialStatus.Active;
    }

    function effectiveStatus(address account) public view returns (CredentialStatus) {
        Credential storage credential = credentials[account];
        if (credential.status == CredentialStatus.Active && credential.validUntil <= block.timestamp) {
            return CredentialStatus.Expired;
        }
        return credential.status;
    }

    function getCredential(address account) external view returns (Credential memory value, CredentialStatus status) {
        value = credentials[account];
        status = effectiveStatus(account);
    }
}
