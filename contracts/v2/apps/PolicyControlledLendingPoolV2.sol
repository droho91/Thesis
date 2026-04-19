// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IBankPolicyEngine} from "./IBankPolicyEngine.sol";
import {IAssetOracleV2} from "./IAssetOracleV2.sol";

/// @title PolicyControlledLendingPoolV2
/// @notice Minimal lending pool with explicit compliance and exposure hooks.
contract PolicyControlledLendingPoolV2 is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant RISK_ADMIN_ROLE = keccak256("RISK_ADMIN_ROLE");
    bytes32 public constant LIQUIDATOR_ROLE = keccak256("LIQUIDATOR_ROLE");
    uint256 public constant BPS = 10_000;

    IERC20 public immutable collateralToken;
    IERC20 public immutable debtToken;
    IBankPolicyEngine public immutable policyEngine;
    IAssetOracleV2 public valuationOracle;

    uint256 public collateralFactorBps;
    uint256 public collateralHaircutBps;
    uint256 public liquidationCloseFactorBps;
    uint256 public liquidationBonusBps;
    uint256 public totalCollateral;
    uint256 public totalDebt;

    mapping(address => uint256) public collateralBalance;
    mapping(address => uint256) public debtBalance;

    error PolicyDenied(bytes32 policyCode);

    event CollateralDeposited(address indexed user, uint256 amount);
    event CollateralWithdrawn(address indexed user, uint256 amount);
    event Borrowed(address indexed user, uint256 amount);
    event Repaid(address indexed user, uint256 amount);
    event CollateralFactorUpdated(uint256 oldFactorBps, uint256 newFactorBps);
    event CollateralHaircutUpdated(uint256 oldHaircutBps, uint256 newHaircutBps);
    event LiquidationConfigUpdated(uint256 closeFactorBps, uint256 bonusBps);
    event ValuationOracleUpdated(address indexed oldOracle, address indexed newOracle);
    event PositionLiquidated(
        address indexed borrower,
        address indexed liquidator,
        uint256 repaidDebt,
        uint256 seizedCollateral
    );

    constructor(
        address admin,
        address collateralToken_,
        address debtToken_,
        address policyEngine_,
        uint256 collateralFactorBps_
    ) {
        require(admin != address(0), "ADMIN_ZERO");
        require(collateralToken_ != address(0), "COLLATERAL_ZERO");
        require(debtToken_ != address(0), "DEBT_ZERO");
        require(policyEngine_ != address(0), "POLICY_ENGINE_ZERO");
        require(collateralFactorBps_ <= BPS, "BAD_COLLATERAL_FACTOR");

        collateralToken = IERC20(collateralToken_);
        debtToken = IERC20(debtToken_);
        policyEngine = IBankPolicyEngine(policyEngine_);
        collateralFactorBps = collateralFactorBps_;
        collateralHaircutBps = BPS;
        liquidationCloseFactorBps = 5_000;
        liquidationBonusBps = 500;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RISK_ADMIN_ROLE, admin);
        _grantRole(LIQUIDATOR_ROLE, admin);
    }

    function setCollateralFactor(uint256 newFactorBps) external onlyRole(RISK_ADMIN_ROLE) {
        require(newFactorBps <= BPS, "BAD_COLLATERAL_FACTOR");
        uint256 oldFactor = collateralFactorBps;
        collateralFactorBps = newFactorBps;
        emit CollateralFactorUpdated(oldFactor, newFactorBps);
    }

    function setCollateralHaircut(uint256 newHaircutBps) external onlyRole(RISK_ADMIN_ROLE) {
        require(newHaircutBps <= BPS, "BAD_HAIRCUT");
        uint256 oldHaircut = collateralHaircutBps;
        collateralHaircutBps = newHaircutBps;
        emit CollateralHaircutUpdated(oldHaircut, newHaircutBps);
    }

    function setValuationOracle(address oracle) external onlyRole(RISK_ADMIN_ROLE) {
        address oldOracle = address(valuationOracle);
        valuationOracle = IAssetOracleV2(oracle);
        emit ValuationOracleUpdated(oldOracle, oracle);
    }

    function setLiquidationConfig(uint256 closeFactorBps, uint256 bonusBps) external onlyRole(RISK_ADMIN_ROLE) {
        require(closeFactorBps > 0 && closeFactorBps <= BPS, "BAD_CLOSE_FACTOR");
        require(bonusBps <= BPS, "BAD_LIQUIDATION_BONUS");
        liquidationCloseFactorBps = closeFactorBps;
        liquidationBonusBps = bonusBps;
        emit LiquidationConfigUpdated(closeFactorBps, bonusBps);
    }

    function depositCollateral(uint256 amount) external {
        require(amount > 0, "AMOUNT_ZERO");

        (bool allowed, bytes32 code) = policyEngine.canAcceptCollateral(msg.sender, address(collateralToken), amount);
        if (!allowed) revert PolicyDenied(code);

        collateralBalance[msg.sender] += amount;
        totalCollateral += amount;
        collateralToken.safeTransferFrom(msg.sender, address(this), amount);
        policyEngine.noteCollateralAccepted(msg.sender, address(collateralToken), amount);
        emit CollateralDeposited(msg.sender, amount);
    }

    function withdrawCollateral(uint256 amount) external {
        require(amount > 0, "AMOUNT_ZERO");
        uint256 currentCollateral = collateralBalance[msg.sender];
        require(currentCollateral >= amount, "INSUFFICIENT_COLLATERAL");

        uint256 remainingCollateral = currentCollateral - amount;
        require(_maxBorrow(remainingCollateral) >= debtBalance[msg.sender], "POSITION_UNHEALTHY");

        collateralBalance[msg.sender] = remainingCollateral;
        totalCollateral -= amount;
        collateralToken.safeTransfer(msg.sender, amount);
        policyEngine.noteCollateralReleased(msg.sender, address(collateralToken), amount);
        emit CollateralWithdrawn(msg.sender, amount);
    }

    function borrow(uint256 amount) external {
        require(amount > 0, "AMOUNT_ZERO");
        require(availableToBorrow(msg.sender) >= amount, "BORROW_LIMIT");
        require(debtToken.balanceOf(address(this)) >= amount, "POOL_LIQUIDITY");

        (bool allowed, bytes32 code) = policyEngine.canBorrow(msg.sender, address(debtToken), amount);
        if (!allowed) revert PolicyDenied(code);

        debtBalance[msg.sender] += amount;
        totalDebt += amount;
        debtToken.safeTransfer(msg.sender, amount);
        policyEngine.noteDebtBorrowed(msg.sender, address(debtToken), amount);
        emit Borrowed(msg.sender, amount);
    }

    function repay(uint256 amount) external {
        require(amount > 0, "AMOUNT_ZERO");
        uint256 currentDebt = debtBalance[msg.sender];
        require(currentDebt > 0, "NO_DEBT");
        uint256 payment = amount > currentDebt ? currentDebt : amount;

        debtBalance[msg.sender] = currentDebt - payment;
        totalDebt -= payment;
        debtToken.safeTransferFrom(msg.sender, address(this), payment);
        policyEngine.noteDebtRepaid(msg.sender, address(debtToken), payment);
        emit Repaid(msg.sender, payment);
    }

    function liquidate(address borrower, uint256 repayAmount) external onlyRole(LIQUIDATOR_ROLE) {
        require(borrower != address(0), "BORROWER_ZERO");
        require(borrower != msg.sender, "SELF_LIQUIDATION");
        require(repayAmount > 0, "AMOUNT_ZERO");
        require(isLiquidatable(borrower), "POSITION_HEALTHY");

        uint256 currentDebt = debtBalance[borrower];
        uint256 maxRepay = _maxLiquidationRepay(currentDebt);
        require(repayAmount <= maxRepay, "LIQUIDATION_CLOSE_FACTOR");

        uint256 seizedCollateral = _liquidationSeizeAmount(repayAmount);
        require(seizedCollateral > 0, "SEIZE_ZERO");
        require(collateralBalance[borrower] >= seizedCollateral, "COLLATERAL_SHORTFALL");

        debtBalance[borrower] = currentDebt - repayAmount;
        totalDebt -= repayAmount;
        collateralBalance[borrower] -= seizedCollateral;
        totalCollateral -= seizedCollateral;

        debtToken.safeTransferFrom(msg.sender, address(this), repayAmount);
        collateralToken.safeTransfer(msg.sender, seizedCollateral);
        policyEngine.noteDebtRepaid(borrower, address(debtToken), repayAmount);
        policyEngine.noteCollateralReleased(borrower, address(collateralToken), seizedCollateral);
        emit PositionLiquidated(borrower, msg.sender, repayAmount, seizedCollateral);
    }

    function maxBorrow(address user) external view returns (uint256) {
        return _maxBorrow(collateralBalance[user]);
    }

    function availableToBorrow(address user) public view returns (uint256) {
        uint256 ceiling = _maxBorrow(collateralBalance[user]);
        uint256 debt = debtBalance[user];
        return ceiling > debt ? ceiling - debt : 0;
    }

    function collateralValue(address user) external view returns (uint256) {
        return _collateralValue(collateralBalance[user]);
    }

    function debtValue(address user) external view returns (uint256) {
        return _debtValue(debtBalance[user]);
    }

    function healthFactorBps(address user) external view returns (uint256) {
        return _healthFactorBps(user);
    }

    function isLiquidatable(address user) public view returns (bool) {
        return debtBalance[user] > 0 && _healthFactorBps(user) < BPS;
    }

    function maxLiquidationRepay(address user) external view returns (uint256) {
        return _maxLiquidationRepay(debtBalance[user]);
    }

    function previewLiquidation(address, uint256 repayAmount) external view returns (uint256 seizedCollateral) {
        require(repayAmount > 0, "AMOUNT_ZERO");
        return _liquidationSeizeAmount(repayAmount);
    }

    function _healthFactorBps(address user) internal view returns (uint256) {
        uint256 debt = debtBalance[user];
        if (debt == 0) return type(uint256).max;

        uint256 permittedDebtValue = _collateralValue(collateralBalance[user]) * collateralFactorBps / BPS;
        uint256 currentDebtValue = _debtValue(debt);
        if (currentDebtValue == 0) return type(uint256).max;
        return permittedDebtValue * BPS / currentDebtValue;
    }

    function _maxLiquidationRepay(uint256 debt) internal view returns (uint256) {
        uint256 closeAmount = debt * liquidationCloseFactorBps / BPS;
        return closeAmount == 0 && debt > 0 ? debt : closeAmount;
    }

    function _liquidationSeizeAmount(uint256 repayAmount) internal view returns (uint256) {
        uint256 debtPrice = _price(address(debtToken));
        uint256 collateralPrice = _price(address(collateralToken));
        uint256 repayValue = repayAmount * debtPrice / 1e18;
        uint256 bonusValue = repayValue * (BPS + liquidationBonusBps) / BPS;
        return bonusValue * 1e18 / collateralPrice;
    }

    function _maxBorrow(uint256 collateralAmount) internal view returns (uint256) {
        uint256 collateralValue_ = _collateralValue(collateralAmount);
        uint256 borrowValue = collateralValue_ * collateralFactorBps / BPS;
        uint256 debtPrice = _price(address(debtToken));
        return borrowValue * 1e18 / debtPrice;
    }

    function _collateralValue(uint256 collateralAmount) internal view returns (uint256) {
        uint256 collateralPrice = _price(address(collateralToken));
        uint256 grossValue = collateralAmount * collateralPrice / 1e18;
        return grossValue * collateralHaircutBps / BPS;
    }

    function _debtValue(uint256 debtAmount) internal view returns (uint256) {
        uint256 debtPrice = _price(address(debtToken));
        return debtAmount * debtPrice / 1e18;
    }

    function _price(address asset) internal view returns (uint256) {
        if (address(valuationOracle) == address(0)) {
            return 1e18;
        }
        return valuationOracle.priceOf(asset);
    }
}
