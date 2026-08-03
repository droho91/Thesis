// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IInstitutionalIdentityRegistry} from "../identity/IInstitutionalIdentityRegistry.sol";
import {IBankPolicyEngine} from "./IBankPolicyEngine.sol";

/// @title InstitutionalRestitutionVault
/// @notice Restricted custody for timeout restitution when the original account is terminally revoked.
/// @dev Recording remains application-driven; release requires governed adjudication and fresh policy eligibility.
contract InstitutionalRestitutionVault is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant APP_ROLE = keccak256("APP_ROLE");
    bytes32 public constant APP_ADMIN_ROLE = keccak256("APP_ADMIN_ROLE");
    bytes32 public constant CLAIM_ADMIN_ROLE = keccak256("CLAIM_ADMIN_ROLE");

    enum AssetKind {
        None,
        Canonical,
        Voucher
    }

    enum ClaimStatus {
        None,
        Held,
        Released
    }

    struct Claim {
        address originalAccount;
        address asset;
        address canonicalAsset;
        uint256 amount;
        uint256 sourceChainId;
        AssetKind assetKind;
        ClaimStatus status;
    }

    IInstitutionalIdentityRegistry public immutable identityRegistry;
    IBankPolicyEngine public immutable policyEngine;

    mapping(bytes32 => Claim) public claims;
    mapping(address => uint256) public accountedBalance;

    error PolicyDenied(bytes32 policyCode);

    event ApplicationGranted(address indexed application);
    event RestitutionRecorded(
        bytes32 indexed messageId,
        address indexed originalAccount,
        address indexed asset,
        address canonicalAsset,
        uint256 amount,
        uint256 sourceChainId,
        AssetKind assetKind
    );
    event RestitutionReleased(
        bytes32 indexed messageId,
        address indexed originalAccount,
        address indexed recipient,
        address asset,
        uint256 amount,
        bytes32 adjudicationReference
    );

    constructor(address admin, address identityRegistry_, address policyEngine_) {
        require(admin != address(0), "ADMIN_ZERO");
        require(identityRegistry_ != address(0) && identityRegistry_.code.length > 0, "BAD_IDENTITY_REGISTRY");
        require(policyEngine_ != address(0) && policyEngine_.code.length > 0, "BAD_POLICY_ENGINE");
        identityRegistry = IInstitutionalIdentityRegistry(identityRegistry_);
        policyEngine = IBankPolicyEngine(policyEngine_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(APP_ADMIN_ROLE, admin);
        _grantRole(CLAIM_ADMIN_ROLE, admin);
    }

    function grantApp(address application) external onlyRole(APP_ADMIN_ROLE) {
        require(application != address(0) && application.code.length > 0, "BAD_APPLICATION");
        _grantRole(APP_ROLE, application);
        emit ApplicationGranted(application);
    }

    function recordRestitution(
        bytes32 messageId,
        address originalAccount,
        address asset,
        address canonicalAsset,
        uint256 amount,
        uint256 sourceChainId,
        AssetKind assetKind
    ) external onlyRole(APP_ROLE) nonReentrant {
        require(messageId != bytes32(0), "MESSAGE_ID_ZERO");
        require(originalAccount != address(0), "ORIGINAL_ACCOUNT_ZERO");
        require(asset != address(0) && asset.code.length > 0, "BAD_ASSET");
        require(canonicalAsset != address(0), "CANONICAL_ASSET_ZERO");
        require(amount > 0, "AMOUNT_ZERO");
        require(sourceChainId != 0, "SOURCE_CHAIN_ZERO");
        require(assetKind == AssetKind.Canonical || assetKind == AssetKind.Voucher, "BAD_ASSET_KIND");
        require(claims[messageId].status == ClaimStatus.None, "CLAIM_ALREADY_RECORDED");

        uint256 newAccountedBalance = accountedBalance[asset] + amount;
        require(IERC20(asset).balanceOf(address(this)) >= newAccountedBalance, "RESTITUTION_NOT_FUNDED");
        accountedBalance[asset] = newAccountedBalance;
        claims[messageId] = Claim({
            originalAccount: originalAccount,
            asset: asset,
            canonicalAsset: canonicalAsset,
            amount: amount,
            sourceChainId: sourceChainId,
            assetKind: assetKind,
            status: ClaimStatus.Held
        });

        emit RestitutionRecorded(
            messageId,
            originalAccount,
            asset,
            canonicalAsset,
            amount,
            sourceChainId,
            assetKind
        );
    }

    function release(bytes32 messageId, address recipient, bytes32 adjudicationReference)
        external
        onlyRole(CLAIM_ADMIN_ROLE)
        nonReentrant
    {
        Claim storage claim = claims[messageId];
        require(claim.status == ClaimStatus.Held, "CLAIM_NOT_HELD");
        require(recipient != address(0) && recipient != address(this), "BAD_RECIPIENT");
        require(adjudicationReference != bytes32(0), "ADJUDICATION_REFERENCE_ZERO");
        require(identityRegistry.isEligible(recipient), "RECIPIENT_IDENTITY_NOT_ELIGIBLE");

        (bool allowed, bytes32 policyCode) = claim.assetKind == AssetKind.Canonical
            ? policyEngine.canUnlockCanonical(claim.sourceChainId, recipient, claim.canonicalAsset, 0)
            : policyEngine.canMintVoucher(claim.sourceChainId, recipient, claim.canonicalAsset, 0);
        if (!allowed) revert PolicyDenied(policyCode);

        claim.status = ClaimStatus.Released;
        accountedBalance[claim.asset] -= claim.amount;
        IERC20 token = IERC20(claim.asset);
        uint256 vaultBalanceBefore = token.balanceOf(address(this));
        uint256 recipientBalanceBefore = token.balanceOf(recipient);
        token.safeTransfer(recipient, claim.amount);
        require(vaultBalanceBefore - token.balanceOf(address(this)) == claim.amount, "NON_EXACT_VAULT_DEBIT");
        require(token.balanceOf(recipient) - recipientBalanceBefore == claim.amount, "NON_EXACT_RECIPIENT_CREDIT");

        emit RestitutionReleased(
            messageId,
            claim.originalAccount,
            recipient,
            claim.asset,
            claim.amount,
            adjudicationReference
        );
    }
}
