// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IBankPolicyEngine} from "./IBankPolicyEngine.sol";

/// @title BankPolicyEngine
/// @notice Stateful institutional policy layer for the interchain lane.
///         Transport proves facts; this engine decides whether the bank is willing to act.
contract BankPolicyEngine is AccessControl, IBankPolicyEngine {
    bytes32 public constant POLICY_ADMIN_ROLE = keccak256("POLICY_ADMIN_ROLE");
    bytes32 public constant POLICY_APP_ROLE = keccak256("POLICY_APP_ROLE");

    bytes32 public constant POLICY_ALLOWED = bytes32("ALLOWED");
    bytes32 public constant POLICY_ACCOUNT_NOT_ALLOWED = bytes32("ACCOUNT_NOT_ALLOWED");
    bytes32 public constant POLICY_SOURCE_CHAIN_BLOCKED = bytes32("SOURCE_CHAIN_BLOCKED");
    bytes32 public constant POLICY_MINT_ASSET_BLOCKED = bytes32("MINT_ASSET_BLOCKED");
    bytes32 public constant POLICY_UNLOCK_ASSET_BLOCKED = bytes32("UNLOCK_ASSET_BLOCKED");
    bytes32 public constant POLICY_COLLATERAL_ASSET_BLOCKED = bytes32("COLLATERAL_ASSET_BLOCKED");
    bytes32 public constant POLICY_DEBT_ASSET_BLOCKED = bytes32("DEBT_ASSET_BLOCKED");
    bytes32 public constant POLICY_VOUCHER_CAP_EXCEEDED = bytes32("VOUCHER_CAP_EXCEEDED");
    bytes32 public constant POLICY_COLLATERAL_CAP_EXCEEDED = bytes32("COLLATERAL_CAP_EXCEEDED");
    bytes32 public constant POLICY_DEBT_CAP_EXCEEDED = bytes32("DEBT_CAP_EXCEEDED");
    bytes32 public constant POLICY_ACCOUNT_BORROW_CAP_EXCEEDED = bytes32("ACCOUNT_BORROW_CAP_EXCEEDED");

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
    mapping(address => uint256) public debtAssetBorrowCap;
    mapping(address => uint256) public debtAssetOutstanding;
    mapping(address => uint256) public accountBorrowCap;
    mapping(address => mapping(address => uint256)) public accountDebtOutstanding;

    event AccountAllowedSet(address indexed account, bool allowed);
    event SourceChainAllowedSet(uint256 indexed sourceChainId, bool allowed);
    event MintAssetAllowedSet(address indexed asset, bool allowed);
    event UnlockAssetAllowedSet(address indexed asset, bool allowed);
    event CollateralAssetAllowedSet(address indexed asset, bool allowed);
    event DebtAssetAllowedSet(address indexed asset, bool allowed);
    event VoucherExposureCapSet(address indexed asset, uint256 cap);
    event CollateralCapSet(address indexed asset, uint256 cap);
    event DebtAssetBorrowCapSet(address indexed asset, uint256 cap);
    event AccountBorrowCapSet(address indexed account, uint256 cap);
    event VoucherMintNoted(uint256 indexed sourceChainId, address indexed beneficiary, address indexed canonicalAsset, uint256 amount);
    event VoucherBurnNoted(address indexed account, address indexed canonicalAsset, uint256 amount);
    event CanonicalUnlockNoted(
        uint256 indexed sourceChainId, address indexed beneficiary, address indexed canonicalAsset, uint256 amount
    );
    event CollateralAccepted(address indexed account, address indexed collateralAsset, uint256 amount);
    event CollateralReleased(address indexed account, address indexed collateralAsset, uint256 amount);
    event DebtBorrowed(address indexed account, address indexed debtAsset, uint256 amount);
    event DebtRepaid(address indexed account, address indexed debtAsset, uint256 amount);

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

    function setDebtAssetBorrowCap(address asset, uint256 cap) external onlyRole(POLICY_ADMIN_ROLE) {
        require(asset != address(0), "ASSET_ZERO");
        debtAssetBorrowCap[asset] = cap;
        emit DebtAssetBorrowCapSet(asset, cap);
    }

    function setAccountBorrowCap(address account, uint256 cap) external onlyRole(POLICY_ADMIN_ROLE) {
        require(account != address(0), "ACCOUNT_ZERO");
        accountBorrowCap[account] = cap;
        emit AccountBorrowCapSet(account, cap);
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
        voucherExposureOutstanding[canonicalAsset] = currentExposure > amount ? currentExposure - amount : 0;
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

    function noteDebtBorrowed(address account, address debtAsset, uint256 amount) external onlyRole(POLICY_APP_ROLE) {
        (bool allowed, bytes32 code) = _canBorrow(account, debtAsset, amount);
        require(allowed, _policyCodeString(code));
        debtAssetOutstanding[debtAsset] += amount;
        accountDebtOutstanding[account][debtAsset] += amount;
        emit DebtBorrowed(account, debtAsset, amount);
    }

    function noteDebtRepaid(address account, address debtAsset, uint256 amount) external onlyRole(POLICY_APP_ROLE) {
        uint256 assetOutstanding = debtAssetOutstanding[debtAsset];
        uint256 accountOutstanding = accountDebtOutstanding[account][debtAsset];
        require(assetOutstanding >= amount, "DEBT_ASSET_UNDERFLOW");
        require(accountOutstanding >= amount, "ACCOUNT_DEBT_UNDERFLOW");
        debtAssetOutstanding[debtAsset] = assetOutstanding - amount;
        accountDebtOutstanding[account][debtAsset] = accountOutstanding - amount;
        emit DebtRepaid(account, debtAsset, amount);
    }

    function _canMintVoucher(uint256 sourceChainId, address beneficiary, address canonicalAsset, uint256 amount)
        internal
        view
        returns (bool allowed, bytes32 policyCode)
    {
        if (!accountAllowed[beneficiary]) return (false, POLICY_ACCOUNT_NOT_ALLOWED);
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
        if (!accountAllowed[beneficiary]) return (false, POLICY_ACCOUNT_NOT_ALLOWED);
        if (!sourceChainAllowed[sourceChainId]) return (false, POLICY_SOURCE_CHAIN_BLOCKED);
        if (!unlockAssetAllowed[canonicalAsset]) return (false, POLICY_UNLOCK_ASSET_BLOCKED);
        return (true, POLICY_ALLOWED);
    }

    function _canAcceptCollateral(address account, address collateralAsset, uint256 amount)
        internal
        view
        returns (bool allowed, bytes32 policyCode)
    {
        if (!accountAllowed[account]) return (false, POLICY_ACCOUNT_NOT_ALLOWED);
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
        if (!accountAllowed[account]) return (false, POLICY_ACCOUNT_NOT_ALLOWED);
        if (!debtAssetAllowed[debtAsset]) return (false, POLICY_DEBT_ASSET_BLOCKED);

        uint256 assetCap = debtAssetBorrowCap[debtAsset];
        if (assetCap != 0 && debtAssetOutstanding[debtAsset] + amount > assetCap) {
            return (false, POLICY_DEBT_CAP_EXCEEDED);
        }

        uint256 accountCap = accountBorrowCap[account];
        if (accountCap != 0 && accountDebtOutstanding[account][debtAsset] + amount > accountCap) {
            return (false, POLICY_ACCOUNT_BORROW_CAP_EXCEEDED);
        }

        return (true, POLICY_ALLOWED);
    }

    function _policyCodeString(bytes32 code) internal pure returns (string memory) {
        return string(abi.encodePacked(code));
    }
}
