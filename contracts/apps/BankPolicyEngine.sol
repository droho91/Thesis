// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IBankPolicyEngine} from "./IBankPolicyEngine.sol";
import {IInstitutionalIdentityRegistry} from "../identity/IInstitutionalIdentityRegistry.sol";

/// @title BankPolicyEngine
/// @notice Stateful institutional policy layer for the interchain lane.
///         Transport proves facts; this engine decides whether the bank is willing to act.
contract BankPolicyEngine is AccessControl, IBankPolicyEngine {
    bytes32 public constant POLICY_ADMIN_ROLE = keccak256("POLICY_ADMIN_ROLE");
    bytes32 public constant POLICY_APP_ROLE = keccak256("POLICY_APP_ROLE");

    bytes32 public constant POLICY_ALLOWED = bytes32("ALLOWED");
    bytes32 public constant POLICY_ACCOUNT_NOT_ALLOWED = bytes32("ACCOUNT_NOT_ALLOWED");
    bytes32 public constant POLICY_IDENTITY_NOT_ELIGIBLE = bytes32("IDENTITY_NOT_ELIGIBLE");
    bytes32 public constant POLICY_SOURCE_CHAIN_BLOCKED = bytes32("SOURCE_CHAIN_BLOCKED");
    bytes32 public constant POLICY_MINT_ASSET_BLOCKED = bytes32("MINT_ASSET_BLOCKED");
    bytes32 public constant POLICY_UNLOCK_ASSET_BLOCKED = bytes32("UNLOCK_ASSET_BLOCKED");
    bytes32 public constant POLICY_COLLATERAL_ASSET_BLOCKED = bytes32("COLLATERAL_ASSET_BLOCKED");
    bytes32 public constant POLICY_DEBT_ASSET_BLOCKED = bytes32("DEBT_ASSET_BLOCKED");
    bytes32 public constant POLICY_VOUCHER_CAP_EXCEEDED = bytes32("VOUCHER_CAP_EXCEEDED");
    bytes32 public constant POLICY_COLLATERAL_CAP_EXCEEDED = bytes32("COLLATERAL_CAP_EXCEEDED");
    bytes32 public constant POLICY_DEBT_ORIGINATION_CAP_EXCEEDED = bytes32("DEBT_ORIGINATION_CAP_EXCEEDED");
    bytes32 public constant POLICY_ACCOUNT_ORIGINATION_CAP_EXCEEDED = bytes32("ACCOUNT_ORIGINATION_CAP_EXCEEDED");
    bytes32 public constant POLICY_ACCOUNT_DEFAULTED = bytes32("ACCOUNT_DEFAULTED");

    mapping(address => bool) public accountAllowed;
    mapping(uint256 => bool) public sourceChainAllowed;
    mapping(address => bool) public mintAssetAllowed;
    mapping(address => bool) public unlockAssetAllowed;
    mapping(address => bool) public collateralAssetAllowed;
    mapping(address => bool) public debtAssetAllowed;

    mapping(address => uint256) public voucherExposureCap;
    mapping(address => uint256) public voucherExposureOutstanding;
    mapping(address => uint256) public collateralCap;
    mapping(address => uint256) public collateralOutstanding;
    mapping(address => uint256) public debtAssetOriginationPrincipalCap;
    mapping(address => uint256) public debtAssetOriginationPrincipalOutstanding;
    mapping(address => uint256) public accountOriginationPrincipalCap;
    mapping(address => uint256) public accountOriginationPrincipalOutstanding;
    mapping(address => bool) public accountDefaulted;
    IInstitutionalIdentityRegistry public identityRegistry;

    event AccountAllowedSet(address indexed account, bool allowed);
    event IdentityRegistrySet(address indexed identityRegistry);
    event SourceChainAllowedSet(uint256 indexed sourceChainId, bool allowed);
    event MintAssetAllowedSet(address indexed asset, bool allowed);
    event UnlockAssetAllowedSet(address indexed asset, bool allowed);
    event CollateralAssetAllowedSet(address indexed asset, bool allowed);
    event DebtAssetAllowedSet(address indexed asset, bool allowed);
    event VoucherExposureCapSet(address indexed asset, uint256 cap);
    event CollateralCapSet(address indexed asset, uint256 cap);
    event DebtAssetOriginationPrincipalCapSet(address indexed asset, uint256 cap);
    event AccountOriginationPrincipalCapSet(address indexed account, uint256 cap);
    event VoucherMintNoted(uint256 indexed sourceChainId, address indexed beneficiary, address indexed canonicalAsset, uint256 amount);
    event VoucherBurnNoted(address indexed account, address indexed canonicalAsset, uint256 amount);
    event CanonicalUnlockNoted(
        uint256 indexed sourceChainId, address indexed beneficiary, address indexed canonicalAsset, uint256 amount
    );
    event CollateralAccepted(address indexed account, address indexed collateralAsset, uint256 amount);
    event CollateralReleased(address indexed account, address indexed collateralAsset, uint256 amount);
    event OriginationPrincipalBorrowed(address indexed account, address indexed debtAsset, uint256 amount);
    event OriginationPrincipalRepaid(address indexed account, address indexed debtAsset, uint256 amount);
    event DebtDefaulted(
        address indexed account,
        address indexed debtAsset,
        uint256 originationPrincipalWrittenOff,
        uint256 totalDebtWrittenOff
    );
    event AccountDefaultResolved(address indexed account, bytes32 indexed resolutionReference);

    constructor(address admin) {
        require(admin != address(0), "ADMIN_ZERO");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(POLICY_ADMIN_ROLE, admin);
    }

    function setAccountAllowed(address account, bool allowed) external onlyRole(POLICY_ADMIN_ROLE) {
        require(account != address(0), "ACCOUNT_ZERO");
        accountAllowed[account] = allowed;
        emit AccountAllowedSet(account, allowed);
    }

    function setIdentityRegistry(address identityRegistry_) external onlyRole(POLICY_ADMIN_ROLE) {
        require(identityRegistry_ != address(0), "IDENTITY_REGISTRY_ZERO");
        require(identityRegistry_.code.length > 0, "IDENTITY_REGISTRY_NOT_CONTRACT");
        identityRegistry = IInstitutionalIdentityRegistry(identityRegistry_);
        emit IdentityRegistrySet(identityRegistry_);
    }

    function setSourceChainAllowed(uint256 sourceChainId, bool allowed) external onlyRole(POLICY_ADMIN_ROLE) {
        require(sourceChainId != 0, "CHAIN_ID_ZERO");
        sourceChainAllowed[sourceChainId] = allowed;
        emit SourceChainAllowedSet(sourceChainId, allowed);
    }

    function setMintAssetAllowed(address asset, bool allowed) external onlyRole(POLICY_ADMIN_ROLE) {
        require(asset != address(0), "ASSET_ZERO");
        mintAssetAllowed[asset] = allowed;
        emit MintAssetAllowedSet(asset, allowed);
    }

    function setUnlockAssetAllowed(address asset, bool allowed) external onlyRole(POLICY_ADMIN_ROLE) {
        require(asset != address(0), "ASSET_ZERO");
        unlockAssetAllowed[asset] = allowed;
        emit UnlockAssetAllowedSet(asset, allowed);
    }

    function setCollateralAssetAllowed(address asset, bool allowed) external onlyRole(POLICY_ADMIN_ROLE) {
        require(asset != address(0), "ASSET_ZERO");
        collateralAssetAllowed[asset] = allowed;
        emit CollateralAssetAllowedSet(asset, allowed);
    }

    function setDebtAssetAllowed(address asset, bool allowed) external onlyRole(POLICY_ADMIN_ROLE) {
        require(asset != address(0), "ASSET_ZERO");
        debtAssetAllowed[asset] = allowed;
        emit DebtAssetAllowedSet(asset, allowed);
    }

    function setVoucherExposureCap(address asset, uint256 cap) external onlyRole(POLICY_ADMIN_ROLE) {
        require(asset != address(0), "ASSET_ZERO");
        voucherExposureCap[asset] = cap;
        emit VoucherExposureCapSet(asset, cap);
    }

    function setCollateralCap(address asset, uint256 cap) external onlyRole(POLICY_ADMIN_ROLE) {
        require(asset != address(0), "ASSET_ZERO");
        collateralCap[asset] = cap;
        emit CollateralCapSet(asset, cap);
    }

    function setDebtAssetOriginationPrincipalCap(address asset, uint256 cap) external onlyRole(POLICY_ADMIN_ROLE) {
        require(asset != address(0), "ASSET_ZERO");
        debtAssetOriginationPrincipalCap[asset] = cap;
        emit DebtAssetOriginationPrincipalCapSet(asset, cap);
    }

    function setAccountOriginationPrincipalCap(address account, uint256 cap) external onlyRole(POLICY_ADMIN_ROLE) {
        require(account != address(0), "ACCOUNT_ZERO");
        accountOriginationPrincipalCap[account] = cap;
        emit AccountOriginationPrincipalCapSet(account, cap);
    }

    /// @notice A written-off account remains unable to originate new principal until governed adjudication.
    function resolveAccountDefault(address account, bytes32 resolutionReference) external onlyRole(POLICY_ADMIN_ROLE) {
        require(account != address(0), "ACCOUNT_ZERO");
        require(accountDefaulted[account], "ACCOUNT_NOT_DEFAULTED");
        require(resolutionReference != bytes32(0), "RESOLUTION_REFERENCE_ZERO");
        accountDefaulted[account] = false;
        emit AccountDefaultResolved(account, resolutionReference);
    }

    function canMintVoucher(
        uint256 sourceChainId,
        address beneficiary,
        address canonicalAsset,
        uint256 amount
    ) external view returns (bool allowed, bytes32 policyCode) {
        return _canMintVoucher(sourceChainId, beneficiary, canonicalAsset, amount);
    }

    function canUnlockCanonical(
        uint256 sourceChainId,
        address beneficiary,
        address canonicalAsset,
        uint256 amount
    ) external view returns (bool allowed, bytes32 policyCode) {
        return _canUnlockCanonical(sourceChainId, beneficiary, canonicalAsset, amount);
    }

    function canAcceptCollateral(address account, address collateralAsset, uint256 amount)
        external
        view
        returns (bool allowed, bytes32 policyCode)
    {
        return _canAcceptCollateral(account, collateralAsset, amount);
    }

    function canBorrow(address account, address debtAsset, uint256 amount)
        external
        view
        returns (bool allowed, bytes32 policyCode)
    {
        return _canBorrow(account, debtAsset, amount);
    }

    function noteVoucherMinted(uint256 sourceChainId, address beneficiary, address canonicalAsset, uint256 amount)
        external
        onlyRole(POLICY_APP_ROLE)
    {
        (bool allowed, bytes32 code) = _canMintVoucher(sourceChainId, beneficiary, canonicalAsset, amount);
        require(allowed, _policyCodeString(code));
        voucherExposureOutstanding[canonicalAsset] += amount;
        emit VoucherMintNoted(sourceChainId, beneficiary, canonicalAsset, amount);
    }

    function noteCanonicalUnlocked(uint256 sourceChainId, address beneficiary, address canonicalAsset, uint256 amount)
        external
        onlyRole(POLICY_APP_ROLE)
    {
        (bool allowed, bytes32 code) = _canUnlockCanonical(sourceChainId, beneficiary, canonicalAsset, amount);
        require(allowed, _policyCodeString(code));
        uint256 currentExposure = voucherExposureOutstanding[canonicalAsset];
        require(currentExposure >= amount, "VOUCHER_EXPOSURE_UNDERFLOW");
        voucherExposureOutstanding[canonicalAsset] = currentExposure - amount;
        emit CanonicalUnlockNoted(sourceChainId, beneficiary, canonicalAsset, amount);
    }

    function noteVoucherBurned(address account, address canonicalAsset, uint256 amount)
        external
        onlyRole(POLICY_APP_ROLE)
    {
        require(account != address(0), "ACCOUNT_ZERO");
        require(canonicalAsset != address(0), "ASSET_ZERO");
        require(amount > 0, "AMOUNT_ZERO");
        uint256 currentExposure = voucherExposureOutstanding[canonicalAsset];
        require(currentExposure >= amount, "VOUCHER_EXPOSURE_UNDERFLOW");
        voucherExposureOutstanding[canonicalAsset] = currentExposure - amount;
        emit VoucherBurnNoted(account, canonicalAsset, amount);
    }

    function noteCollateralAccepted(address account, address collateralAsset, uint256 amount)
        external
        onlyRole(POLICY_APP_ROLE)
    {
        (bool allowed, bytes32 code) = _canAcceptCollateral(account, collateralAsset, amount);
        require(allowed, _policyCodeString(code));
        collateralOutstanding[collateralAsset] += amount;
        emit CollateralAccepted(account, collateralAsset, amount);
    }

    function noteCollateralReleased(address account, address collateralAsset, uint256 amount)
        external
        onlyRole(POLICY_APP_ROLE)
    {
        uint256 currentCollateral = collateralOutstanding[collateralAsset];
        require(currentCollateral >= amount, "COLLATERAL_UNDERFLOW");
        collateralOutstanding[collateralAsset] = currentCollateral - amount;
        emit CollateralReleased(account, collateralAsset, amount);
    }

    function noteOriginationPrincipalBorrowed(address account, address debtAsset, uint256 amount)
        external
        onlyRole(POLICY_APP_ROLE)
    {
        (bool allowed, bytes32 code) = _canBorrow(account, debtAsset, amount);
        require(allowed, _policyCodeString(code));
        debtAssetOriginationPrincipalOutstanding[debtAsset] += amount;
        accountOriginationPrincipalOutstanding[account] += amount;
        emit OriginationPrincipalBorrowed(account, debtAsset, amount);
    }

    function noteOriginationPrincipalRepaid(address account, address debtAsset, uint256 amount)
        external
        onlyRole(POLICY_APP_ROLE)
    {
        _reduceOriginationPrincipalOutstanding(account, debtAsset, amount);
        emit OriginationPrincipalRepaid(account, debtAsset, amount);
    }

    function noteDebtDefaulted(
        address account,
        address debtAsset,
        uint256 originationPrincipalWrittenOff,
        uint256 totalDebtWrittenOff
    ) external onlyRole(POLICY_APP_ROLE) {
        require(totalDebtWrittenOff > 0, "DEBT_WRITE_OFF_ZERO");
        if (originationPrincipalWrittenOff > 0) {
            _reduceOriginationPrincipalOutstanding(account, debtAsset, originationPrincipalWrittenOff);
        }
        accountDefaulted[account] = true;
        emit DebtDefaulted(account, debtAsset, originationPrincipalWrittenOff, totalDebtWrittenOff);
    }

    function _reduceOriginationPrincipalOutstanding(address account, address debtAsset, uint256 amount) internal {
        uint256 assetOutstanding = debtAssetOriginationPrincipalOutstanding[debtAsset];
        uint256 accountOutstanding = accountOriginationPrincipalOutstanding[account];
        require(assetOutstanding >= amount, "DEBT_PRINCIPAL_UNDERFLOW");
        require(accountOutstanding >= amount, "ACCOUNT_PRINCIPAL_UNDERFLOW");
        debtAssetOriginationPrincipalOutstanding[debtAsset] = assetOutstanding - amount;
        accountOriginationPrincipalOutstanding[account] = accountOutstanding - amount;
    }

    function _canMintVoucher(uint256 sourceChainId, address beneficiary, address canonicalAsset, uint256 amount)
        internal
        view
        returns (bool allowed, bytes32 policyCode)
    {
        bytes32 accountCode = _accountPolicyCode(beneficiary);
        if (accountCode != POLICY_ALLOWED) return (false, accountCode);
        if (!sourceChainAllowed[sourceChainId]) return (false, POLICY_SOURCE_CHAIN_BLOCKED);
        if (!mintAssetAllowed[canonicalAsset]) return (false, POLICY_MINT_ASSET_BLOCKED);
        uint256 cap = voucherExposureCap[canonicalAsset];
        if (cap != 0 && voucherExposureOutstanding[canonicalAsset] + amount > cap) {
            return (false, POLICY_VOUCHER_CAP_EXCEEDED);
        }
        return (true, POLICY_ALLOWED);
    }

    function _canUnlockCanonical(uint256 sourceChainId, address beneficiary, address canonicalAsset, uint256)
        internal
        view
        returns (bool allowed, bytes32 policyCode)
    {
        bytes32 accountCode = _accountPolicyCode(beneficiary);
        if (accountCode != POLICY_ALLOWED) return (false, accountCode);
        if (!sourceChainAllowed[sourceChainId]) return (false, POLICY_SOURCE_CHAIN_BLOCKED);
        if (!unlockAssetAllowed[canonicalAsset]) return (false, POLICY_UNLOCK_ASSET_BLOCKED);
        return (true, POLICY_ALLOWED);
    }

    function _canAcceptCollateral(address account, address collateralAsset, uint256 amount)
        internal
        view
        returns (bool allowed, bytes32 policyCode)
    {
        bytes32 accountCode = _accountPolicyCode(account);
        if (accountCode != POLICY_ALLOWED) return (false, accountCode);
        if (!collateralAssetAllowed[collateralAsset]) return (false, POLICY_COLLATERAL_ASSET_BLOCKED);
        uint256 cap = collateralCap[collateralAsset];
        if (cap != 0 && collateralOutstanding[collateralAsset] + amount > cap) {
            return (false, POLICY_COLLATERAL_CAP_EXCEEDED);
        }
        return (true, POLICY_ALLOWED);
    }

    function _canBorrow(address account, address debtAsset, uint256 amount)
        internal
        view
        returns (bool allowed, bytes32 policyCode)
    {
        bytes32 accountCode = _accountPolicyCode(account);
        if (accountCode != POLICY_ALLOWED) return (false, accountCode);
        if (!debtAssetAllowed[debtAsset]) return (false, POLICY_DEBT_ASSET_BLOCKED);

        uint256 assetCap = debtAssetOriginationPrincipalCap[debtAsset];
        if (assetCap != 0 && debtAssetOriginationPrincipalOutstanding[debtAsset] + amount > assetCap) {
            return (false, POLICY_DEBT_ORIGINATION_CAP_EXCEEDED);
        }

        uint256 accountCap = accountOriginationPrincipalCap[account];
        if (accountCap != 0 && accountOriginationPrincipalOutstanding[account] + amount > accountCap) {
            return (false, POLICY_ACCOUNT_ORIGINATION_CAP_EXCEEDED);
        }

        return (true, POLICY_ALLOWED);
    }

    function _policyCodeString(bytes32 code) internal pure returns (string memory) {
        return string(abi.encodePacked(code));
    }

    function _accountPolicyCode(address account) internal view returns (bytes32) {
        if (!accountAllowed[account]) return POLICY_ACCOUNT_NOT_ALLOWED;
        if (accountDefaulted[account]) return POLICY_ACCOUNT_DEFAULTED;
        if (address(identityRegistry) != address(0) && !identityRegistry.isEligible(account)) {
            return POLICY_IDENTITY_NOT_ELIGIBLE;
        }
        return POLICY_ALLOWED;
    }
}
