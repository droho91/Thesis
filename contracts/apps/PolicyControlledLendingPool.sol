// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IBankPolicyEngine} from "./IBankPolicyEngine.sol";
import {IAssetOracle} from "./IAssetOracle.sol";

/// @title PolicyControlledLendingPool
/// @notice Single-market lending pool with policy hooks, lender shares, debt shares, lazy interest,
///         reserve accounting, and explicit bad-debt recognition.
contract PolicyControlledLendingPool is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant RISK_ADMIN_ROLE = keccak256("RISK_ADMIN_ROLE");
    bytes32 public constant LIQUIDATOR_ROLE = keccak256("LIQUIDATOR_ROLE");
    bytes32 public constant RESERVE_MANAGER_ROLE = keccak256("RESERVE_MANAGER_ROLE");

    uint256 public constant BPS = 10_000;
    uint256 public constant WAD = 1e18;
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint256 public constant MAX_COLLATERAL_FACTOR_BPS = 9_500;
    uint256 public constant MAX_LIQUIDATION_BONUS_BPS = 5_000;
    uint256 public constant MAX_RESERVE_FACTOR_BPS = 5_000;
    uint256 public constant MAX_RATE_BPS = 100_000;

    IERC20 public immutable collateralToken;
    IERC20 public immutable debtToken;
    IBankPolicyEngine public immutable policyEngine;
    IAssetOracle public valuationOracle;

    uint256 public collateralFactorBps;
    uint256 public collateralHaircutBps;
    uint256 public liquidationCloseFactorBps;
    uint256 public liquidationBonusBps;
    uint256 public reserveFactorBps;
    uint256 public baseRateBps;
    uint256 public kinkUtilizationBps;
    uint256 public slope1Bps;
    uint256 public slope2Bps;

    uint256 public totalCollateral;
    uint256 public totalBorrows;
    uint256 public totalReserves;
    uint256 public totalBadDebt;
    uint256 public totalDebtShares;
    uint256 public totalLiquidityShares;
    uint256 public borrowIndexE18;
    uint256 public lastAccrualTimestamp;

    mapping(address => uint256) public collateralBalance;
    mapping(address => uint256) public debtShares;
    mapping(address => uint256) public liquidityShares;
    mapping(address => uint256) public policyDebtPrincipal;

    error PolicyDenied(bytes32 policyCode);

    event InterestAccrued(
        uint256 indexed timestamp,
        uint256 interestAccrued,
        uint256 reservesAccrued,
        uint256 borrowIndexE18,
        uint256 totalBorrows
    );
    event LiquidityDeposited(address indexed supplier, uint256 assets, uint256 shares);
    event LiquidityRedeemed(address indexed supplier, address indexed receiver, uint256 assets, uint256 shares);
    event CollateralDeposited(address indexed user, uint256 amount);
    event CollateralWithdrawn(address indexed user, uint256 amount);
    event Borrowed(address indexed user, uint256 amount, uint256 shares);
    event Repaid(address indexed payer, address indexed borrower, uint256 amount, uint256 shares);
    event CollateralFactorUpdated(uint256 oldFactorBps, uint256 newFactorBps);
    event CollateralHaircutUpdated(uint256 oldHaircutBps, uint256 newHaircutBps);
    event LiquidationConfigUpdated(uint256 closeFactorBps, uint256 bonusBps);
    event ReserveFactorUpdated(uint256 oldReserveFactorBps, uint256 newReserveFactorBps);
    event InterestRateModelUpdated(uint256 baseRateBps, uint256 kinkUtilizationBps, uint256 slope1Bps, uint256 slope2Bps);
    event ValuationOracleUpdated(address indexed oldOracle, address indexed newOracle);
    event ReservesWithdrawn(address indexed to, uint256 amount);
    event BadDebtRecognized(address indexed borrower, uint256 debtWrittenOff, uint256 reservesUsed, uint256 supplierLoss);
    event PositionLiquidated(
        address indexed borrower,
        address indexed liquidator,
        uint256 repaidDebt,
        uint256 seizedCollateral,
        uint256 badDebtWrittenOff
    );
    event EmergencyPaused(address indexed account);
    event EmergencyUnpaused(address indexed account);

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
        _validateCollateralFactor(collateralFactorBps_);

        collateralToken = IERC20(collateralToken_);
        debtToken = IERC20(debtToken_);
        policyEngine = IBankPolicyEngine(policyEngine_);
        collateralFactorBps = collateralFactorBps_;
        collateralHaircutBps = BPS;
        liquidationCloseFactorBps = 5_000;
        liquidationBonusBps = 500;
        reserveFactorBps = 1_000;
        baseRateBps = 200;
        kinkUtilizationBps = 8_000;
        slope1Bps = 800;
        slope2Bps = 5_000;
        borrowIndexE18 = WAD;
        lastAccrualTimestamp = block.timestamp;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RISK_ADMIN_ROLE, admin);
        _grantRole(LIQUIDATOR_ROLE, admin);
        _grantRole(RESERVE_MANAGER_ROLE, admin);
    }

    function pause() external onlyRole(RISK_ADMIN_ROLE) {
        _pause();
        emit EmergencyPaused(msg.sender);
    }

    function unpause() external onlyRole(RISK_ADMIN_ROLE) {
        _unpause();
        emit EmergencyUnpaused(msg.sender);
    }

    function setCollateralFactor(uint256 newFactorBps) external onlyRole(RISK_ADMIN_ROLE) {
        _validateCollateralFactor(newFactorBps);
        uint256 oldFactor = collateralFactorBps;
        collateralFactorBps = newFactorBps;
        emit CollateralFactorUpdated(oldFactor, newFactorBps);
    }

    function setCollateralHaircut(uint256 newHaircutBps) external onlyRole(RISK_ADMIN_ROLE) {
        require(newHaircutBps > 0 && newHaircutBps <= BPS, "BAD_HAIRCUT");
        uint256 oldHaircut = collateralHaircutBps;
        collateralHaircutBps = newHaircutBps;
        emit CollateralHaircutUpdated(oldHaircut, newHaircutBps);
    }

    function setValuationOracle(address oracle) external onlyRole(RISK_ADMIN_ROLE) {
        require(oracle != address(0), "ORACLE_ZERO");
        address oldOracle = address(valuationOracle);
        valuationOracle = IAssetOracle(oracle);
        emit ValuationOracleUpdated(oldOracle, oracle);
    }

    function setLiquidationConfig(uint256 closeFactorBps, uint256 bonusBps) external onlyRole(RISK_ADMIN_ROLE) {
        require(closeFactorBps > 0 && closeFactorBps <= BPS, "BAD_CLOSE_FACTOR");
        require(bonusBps <= MAX_LIQUIDATION_BONUS_BPS, "BAD_LIQUIDATION_BONUS");
        liquidationCloseFactorBps = closeFactorBps;
        liquidationBonusBps = bonusBps;
        emit LiquidationConfigUpdated(closeFactorBps, bonusBps);
    }

    function setReserveFactor(uint256 newReserveFactorBps) external onlyRole(RISK_ADMIN_ROLE) {
        require(newReserveFactorBps <= MAX_RESERVE_FACTOR_BPS, "BAD_RESERVE_FACTOR");
        _accrueInterest();
        uint256 oldReserveFactor = reserveFactorBps;
        reserveFactorBps = newReserveFactorBps;
        emit ReserveFactorUpdated(oldReserveFactor, newReserveFactorBps);
    }

    function setInterestRateModel(
        uint256 newBaseRateBps,
        uint256 newKinkUtilizationBps,
        uint256 newSlope1Bps,
        uint256 newSlope2Bps
    ) external onlyRole(RISK_ADMIN_ROLE) {
        require(newBaseRateBps <= MAX_RATE_BPS, "BAD_BASE_RATE");
        require(newKinkUtilizationBps > 0 && newKinkUtilizationBps < BPS, "BAD_KINK");
        require(newSlope1Bps <= MAX_RATE_BPS, "BAD_SLOPE1");
        require(newSlope2Bps <= MAX_RATE_BPS, "BAD_SLOPE2");
        _accrueInterest();
        baseRateBps = newBaseRateBps;
        kinkUtilizationBps = newKinkUtilizationBps;
        slope1Bps = newSlope1Bps;
        slope2Bps = newSlope2Bps;
        emit InterestRateModelUpdated(newBaseRateBps, newKinkUtilizationBps, newSlope1Bps, newSlope2Bps);
    }

    function accrueInterest() external returns (uint256 interestAccrued, uint256 reservesAccrued) {
        return _accrueInterest();
    }

    function depositLiquidity(uint256 assets) external whenNotPaused nonReentrant returns (uint256 shares) {
        require(assets > 0, "AMOUNT_ZERO");
        _accrueInterest();

        uint256 assetsBefore = _totalAssets();
        shares = totalLiquidityShares == 0 || assetsBefore == 0 ? assets : assets * totalLiquidityShares / assetsBefore;
        require(shares > 0, "SHARES_ZERO");

        totalLiquidityShares += shares;
        liquidityShares[msg.sender] += shares;
        debtToken.safeTransferFrom(msg.sender, address(this), assets);
        emit LiquidityDeposited(msg.sender, assets, shares);
    }

    function redeemLiquidity(uint256 shareAmount) external whenNotPaused nonReentrant returns (uint256 assets) {
        return _redeemLiquidity(msg.sender, msg.sender, shareAmount);
    }

    function withdrawLiquidity(uint256 assets) external whenNotPaused nonReentrant returns (uint256 shares) {
        require(assets > 0, "AMOUNT_ZERO");
        _accrueInterest();
        require(assets <= availableLiquidity(), "POOL_LIQUIDITY");

        shares = _assetsToLiquiditySharesUp(assets);
        require(shares > 0, "SHARES_ZERO");
        require(liquidityShares[msg.sender] >= shares, "INSUFFICIENT_LIQUIDITY_SHARES");

        liquidityShares[msg.sender] -= shares;
        totalLiquidityShares -= shares;
        debtToken.safeTransfer(msg.sender, assets);
        emit LiquidityRedeemed(msg.sender, msg.sender, assets, shares);
    }

    function depositCollateral(uint256 amount) external whenNotPaused nonReentrant {
        require(amount > 0, "AMOUNT_ZERO");
        _accrueInterest();

        (bool allowed, bytes32 code) = policyEngine.canAcceptCollateral(msg.sender, address(collateralToken), amount);
        if (!allowed) revert PolicyDenied(code);

        collateralBalance[msg.sender] += amount;
        totalCollateral += amount;
        collateralToken.safeTransferFrom(msg.sender, address(this), amount);
        policyEngine.noteCollateralAccepted(msg.sender, address(collateralToken), amount);
        emit CollateralDeposited(msg.sender, amount);
    }

    function withdrawCollateral(uint256 amount) external whenNotPaused nonReentrant {
        require(amount > 0, "AMOUNT_ZERO");
        _accrueInterest();
        uint256 currentCollateral = collateralBalance[msg.sender];
        require(currentCollateral >= amount, "INSUFFICIENT_COLLATERAL");

        uint256 remainingCollateral = currentCollateral - amount;
        require(_maxBorrow(remainingCollateral) >= debtOf(msg.sender), "POSITION_UNHEALTHY");

        collateralBalance[msg.sender] = remainingCollateral;
        totalCollateral -= amount;
        collateralToken.safeTransfer(msg.sender, amount);
        policyEngine.noteCollateralReleased(msg.sender, address(collateralToken), amount);
        emit CollateralWithdrawn(msg.sender, amount);
    }

    function borrow(uint256 amount) external whenNotPaused nonReentrant {
        require(amount > 0, "AMOUNT_ZERO");
        _accrueInterest();
        require(_availableToBorrow(msg.sender) >= amount, "BORROW_LIMIT");
        require(availableLiquidity() >= amount, "POOL_LIQUIDITY");

        (bool allowed, bytes32 code) = policyEngine.canBorrow(msg.sender, address(debtToken), amount);
        if (!allowed) revert PolicyDenied(code);

        uint256 shares = _debtToSharesUp(amount);
        require(shares > 0, "DEBT_SHARES_ZERO");

        debtShares[msg.sender] += shares;
        totalDebtShares += shares;
        totalBorrows += amount;
        policyDebtPrincipal[msg.sender] += amount;
        debtToken.safeTransfer(msg.sender, amount);
        policyEngine.noteDebtBorrowed(msg.sender, address(debtToken), amount);
        emit Borrowed(msg.sender, amount, shares);
    }

    function repay(uint256 amount) external whenNotPaused nonReentrant returns (uint256 payment) {
        return _repayFor(msg.sender, msg.sender, amount);
    }

    function repayFor(address borrower, uint256 amount) external whenNotPaused nonReentrant returns (uint256 payment) {
        require(borrower != address(0), "BORROWER_ZERO");
        return _repayFor(msg.sender, borrower, amount);
    }

    function liquidate(address borrower, uint256 repayAmount) external onlyRole(LIQUIDATOR_ROLE) whenNotPaused nonReentrant {
        require(borrower != address(0), "BORROWER_ZERO");
        require(borrower != msg.sender, "SELF_LIQUIDATION");
        require(repayAmount > 0, "AMOUNT_ZERO");
        _accrueInterest();

        uint256 currentDebt = debtOf(borrower);
        require(currentDebt > 0, "NO_DEBT");
        require(_healthFactorBps(borrower) < BPS, "POSITION_HEALTHY");
        require(repayAmount <= _maxLiquidationRepay(currentDebt), "LIQUIDATION_CLOSE_FACTOR");

        uint256 seizedCollateral = _liquidationSeizeAmount(repayAmount);
        uint256 borrowerCollateral = collateralBalance[borrower];
        if (seizedCollateral > borrowerCollateral) {
            seizedCollateral = borrowerCollateral;
        }
        require(seizedCollateral > 0, "SEIZE_ZERO");

        (uint256 payment,) = _reduceDebtForPayment(borrower, repayAmount);
        collateralBalance[borrower] = borrowerCollateral - seizedCollateral;
        totalCollateral -= seizedCollateral;

        debtToken.safeTransferFrom(msg.sender, address(this), payment);
        collateralToken.safeTransfer(msg.sender, seizedCollateral);
        policyEngine.noteCollateralReleased(borrower, address(collateralToken), seizedCollateral);

        uint256 badDebtWrittenOff;
        if (collateralBalance[borrower] == 0) {
            badDebtWrittenOff = _recognizeRemainingBadDebt(borrower);
        }

        emit PositionLiquidated(borrower, msg.sender, payment, seizedCollateral, badDebtWrittenOff);
    }

    function absorbBadDebt(address borrower) external onlyRole(LIQUIDATOR_ROLE) whenNotPaused nonReentrant returns (uint256 badDebtWrittenOff) {
        require(borrower != address(0), "BORROWER_ZERO");
        _accrueInterest();
        require(collateralBalance[borrower] == 0, "COLLATERAL_REMAINING");
        require(debtOf(borrower) > 0, "NO_DEBT");
        badDebtWrittenOff = _recognizeRemainingBadDebt(borrower);
    }

    function withdrawReserves(address to, uint256 amount)
        external
        onlyRole(RESERVE_MANAGER_ROLE)
        whenNotPaused
        nonReentrant
    {
        require(to != address(0), "TO_ZERO");
        require(amount > 0, "AMOUNT_ZERO");
        _accrueInterest();
        require(amount <= totalReserves, "INSUFFICIENT_RESERVES");
        require(amount <= debtToken.balanceOf(address(this)), "POOL_LIQUIDITY");
        totalReserves -= amount;
        debtToken.safeTransfer(to, amount);
        emit ReservesWithdrawn(to, amount);
    }

    function maxBorrow(address user) external view returns (uint256) {
        return _maxBorrow(collateralBalance[user]);
    }

    function availableToBorrow(address user) public view returns (uint256) {
        return _availableToBorrow(user);
    }

    function collateralValue(address user) external view returns (uint256) {
        return _collateralValue(collateralBalance[user]);
    }

    function debtValue(address user) external view returns (uint256) {
        return _debtValue(debtOf(user));
    }

    function healthFactorBps(address user) external view returns (uint256) {
        return _healthFactorBps(user);
    }

    function isLiquidatable(address user) public view returns (bool) {
        return debtOf(user) > 0 && _healthFactorBps(user) < BPS;
    }

    function maxLiquidationRepay(address user) external view returns (uint256) {
        return _maxLiquidationRepay(debtOf(user));
    }

    function previewLiquidation(address, uint256 repayAmount) external view returns (uint256 seizedCollateral) {
        require(repayAmount > 0, "AMOUNT_ZERO");
        return _liquidationSeizeAmount(repayAmount);
    }

    function totalCash() public view returns (uint256) {
        return debtToken.balanceOf(address(this));
    }

    function availableLiquidity() public view returns (uint256) {
        uint256 cash = totalCash();
        return cash > totalReserves ? cash - totalReserves : 0;
    }

    function totalAssets() public view returns (uint256) {
        (uint256 interest, uint256 reserves) = pendingInterest();
        uint256 borrows = totalBorrows + interest;
        uint256 reservesTotal = totalReserves + reserves;
        uint256 cashAndBorrows = totalCash() + borrows;
        return cashAndBorrows > reservesTotal ? cashAndBorrows - reservesTotal : 0;
    }

    function exchangeRateE18() public view returns (uint256) {
        if (totalLiquidityShares == 0) return WAD;
        return totalAssets() * WAD / totalLiquidityShares;
    }

    function liquidityBalanceOf(address user) public view returns (uint256) {
        if (totalLiquidityShares == 0) return 0;
        return liquidityShares[user] * totalAssets() / totalLiquidityShares;
    }

    function debtOf(address user) public view returns (uint256) {
        return debtShares[user] * accruedBorrowIndexE18() / WAD;
    }

    function debtBalance(address user) external view returns (uint256) {
        return debtOf(user);
    }

    function totalDebt() external view returns (uint256) {
        return accruedTotalBorrows();
    }

    function accruedTotalBorrows() public view returns (uint256) {
        (uint256 interest,) = pendingInterest();
        return totalBorrows + interest;
    }

    function accruedBorrowIndexE18() public view returns (uint256) {
        if (totalBorrows == 0) return borrowIndexE18;
        uint256 elapsed = block.timestamp - lastAccrualTimestamp;
        if (elapsed == 0) return borrowIndexE18;
        uint256 rateBps = _currentBorrowRateBps(totalBorrows, totalCash());
        return borrowIndexE18 + (borrowIndexE18 * rateBps * elapsed / (BPS * SECONDS_PER_YEAR));
    }

    function pendingInterest() public view returns (uint256 interest, uint256 reserves) {
        if (totalBorrows == 0) return (0, 0);
        uint256 elapsed = block.timestamp - lastAccrualTimestamp;
        if (elapsed == 0) return (0, 0);
        uint256 rateBps = _currentBorrowRateBps(totalBorrows, totalCash());
        interest = totalBorrows * rateBps * elapsed / (BPS * SECONDS_PER_YEAR);
        reserves = interest * reserveFactorBps / BPS;
    }

    function utilizationRateBps() public view returns (uint256) {
        return _utilizationRateBps(accruedTotalBorrows(), totalCash());
    }

    function currentBorrowRateBps() public view returns (uint256) {
        return _currentBorrowRateBps(accruedTotalBorrows(), totalCash());
    }

    function _redeemLiquidity(address owner, address receiver, uint256 shareAmount) internal returns (uint256 assets) {
        require(shareAmount > 0, "SHARES_ZERO");
        _accrueInterest();
        require(liquidityShares[owner] >= shareAmount, "INSUFFICIENT_LIQUIDITY_SHARES");

        assets = shareAmount * _totalAssets() / totalLiquidityShares;
        require(assets > 0, "ASSETS_ZERO");
        require(assets <= availableLiquidity(), "POOL_LIQUIDITY");

        liquidityShares[owner] -= shareAmount;
        totalLiquidityShares -= shareAmount;
        debtToken.safeTransfer(receiver, assets);
        emit LiquidityRedeemed(owner, receiver, assets, shareAmount);
    }

    function _repayFor(address payer, address borrower, uint256 amount) internal returns (uint256 payment) {
        require(amount > 0, "AMOUNT_ZERO");
        _accrueInterest();
        (payment,) = _reduceDebtForPayment(borrower, amount);
        debtToken.safeTransferFrom(payer, address(this), payment);
    }

    function _reduceDebtForPayment(address borrower, uint256 amount) internal returns (uint256 payment, uint256 sharesBurned) {
        uint256 currentDebt = debtOf(borrower);
        require(currentDebt > 0, "NO_DEBT");
        payment = amount > currentDebt ? currentDebt : amount;

        uint256 borrowerShares = debtShares[borrower];
        sharesBurned = payment == currentDebt ? borrowerShares : _debtToSharesUp(payment);
        if (sharesBurned > borrowerShares) sharesBurned = borrowerShares;
        uint256 debtReduction = payment == currentDebt ? currentDebt : _sharesToDebt(sharesBurned);
        if (debtReduction > currentDebt) debtReduction = currentDebt;
        if (debtReduction > totalBorrows) debtReduction = totalBorrows;

        debtShares[borrower] = borrowerShares - sharesBurned;
        totalDebtShares -= sharesBurned;
        totalBorrows -= debtReduction;

        uint256 principalReduction = payment;
        uint256 principalOutstanding = policyDebtPrincipal[borrower];
        if (principalReduction > principalOutstanding) principalReduction = principalOutstanding;
        if (principalReduction > 0) {
            policyDebtPrincipal[borrower] = principalOutstanding - principalReduction;
            policyEngine.noteDebtRepaid(borrower, address(debtToken), principalReduction);
        }

        emit Repaid(msg.sender, borrower, payment, sharesBurned);
    }

    function _recognizeRemainingBadDebt(address borrower) internal returns (uint256 debtWrittenOff) {
        debtWrittenOff = debtOf(borrower);
        if (debtWrittenOff == 0) return 0;

        uint256 shares = debtShares[borrower];
        debtShares[borrower] = 0;
        totalDebtShares -= shares;
        totalBorrows = totalBorrows > debtWrittenOff ? totalBorrows - debtWrittenOff : 0;

        uint256 principalOutstanding = policyDebtPrincipal[borrower];
        if (principalOutstanding > 0) {
            policyDebtPrincipal[borrower] = 0;
            policyEngine.noteDebtWrittenOff(borrower, address(debtToken), principalOutstanding);
        }

        uint256 reservesUsed = debtWrittenOff > totalReserves ? totalReserves : debtWrittenOff;
        totalReserves -= reservesUsed;
        uint256 supplierLoss = debtWrittenOff - reservesUsed;
        totalBadDebt += supplierLoss;

        emit BadDebtRecognized(borrower, debtWrittenOff, reservesUsed, supplierLoss);
    }

    function _accrueInterest() internal returns (uint256 interestAccrued, uint256 reservesAccrued) {
        uint256 elapsed = block.timestamp - lastAccrualTimestamp;
        if (elapsed == 0) return (0, 0);
        lastAccrualTimestamp = block.timestamp;

        if (totalBorrows == 0) {
            emit InterestAccrued(block.timestamp, 0, 0, borrowIndexE18, totalBorrows);
            return (0, 0);
        }

        uint256 rateBps = _currentBorrowRateBps(totalBorrows, totalCash());
        interestAccrued = totalBorrows * rateBps * elapsed / (BPS * SECONDS_PER_YEAR);
        reservesAccrued = interestAccrued * reserveFactorBps / BPS;
        totalBorrows += interestAccrued;
        totalReserves += reservesAccrued;
        borrowIndexE18 += borrowIndexE18 * rateBps * elapsed / (BPS * SECONDS_PER_YEAR);

        emit InterestAccrued(block.timestamp, interestAccrued, reservesAccrued, borrowIndexE18, totalBorrows);
    }

    function _availableToBorrow(address user) internal view returns (uint256) {
        uint256 ceiling = _maxBorrow(collateralBalance[user]);
        uint256 debt = debtOf(user);
        return ceiling > debt ? ceiling - debt : 0;
    }

    function _healthFactorBps(address user) internal view returns (uint256) {
        uint256 debt = debtOf(user);
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
        uint256 repayValue = repayAmount * debtPrice / WAD;
        uint256 bonusValue = repayValue * (BPS + liquidationBonusBps) / BPS;
        return bonusValue * WAD / collateralPrice;
    }

    function _maxBorrow(uint256 collateralAmount) internal view returns (uint256) {
        uint256 collateralValue_ = _collateralValue(collateralAmount);
        uint256 borrowValue = collateralValue_ * collateralFactorBps / BPS;
        uint256 debtPrice = _price(address(debtToken));
        return borrowValue * WAD / debtPrice;
    }

    function _collateralValue(uint256 collateralAmount) internal view returns (uint256) {
        uint256 collateralPrice = _price(address(collateralToken));
        uint256 grossValue = collateralAmount * collateralPrice / WAD;
        return grossValue * collateralHaircutBps / BPS;
    }

    function _debtValue(uint256 debtAmount) internal view returns (uint256) {
        uint256 debtPrice = _price(address(debtToken));
        return debtAmount * debtPrice / WAD;
    }

    function _price(address asset) internal view returns (uint256) {
        require(address(valuationOracle) != address(0), "ORACLE_NOT_SET");
        return valuationOracle.priceOf(asset);
    }

    function _debtToSharesUp(uint256 debtAmount) internal view returns (uint256) {
        return (debtAmount * WAD + borrowIndexE18 - 1) / borrowIndexE18;
    }

    function _sharesToDebt(uint256 shares) internal view returns (uint256) {
        return shares * borrowIndexE18 / WAD;
    }

    function _assetsToLiquiditySharesUp(uint256 assets) internal view returns (uint256) {
        uint256 assetsTotal = _totalAssets();
        if (totalLiquidityShares == 0 || assetsTotal == 0) return assets;
        return (assets * totalLiquidityShares + assetsTotal - 1) / assetsTotal;
    }

    function _totalAssets() internal view returns (uint256) {
        uint256 cashAndBorrows = totalCash() + totalBorrows;
        return cashAndBorrows > totalReserves ? cashAndBorrows - totalReserves : 0;
    }

    function _utilizationRateBps(uint256 borrows, uint256 cash) internal pure returns (uint256) {
        uint256 supplied = cash + borrows;
        if (supplied == 0 || borrows == 0) return 0;
        uint256 utilization = borrows * BPS / supplied;
        return utilization > BPS ? BPS : utilization;
    }

    function _currentBorrowRateBps(uint256 borrows, uint256 cash) internal view returns (uint256) {
        uint256 utilization = _utilizationRateBps(borrows, cash);
        if (utilization <= kinkUtilizationBps) {
            return baseRateBps + slope1Bps * utilization / kinkUtilizationBps;
        }
        uint256 excessUtilization = utilization - kinkUtilizationBps;
        return baseRateBps + slope1Bps + slope2Bps * excessUtilization / (BPS - kinkUtilizationBps);
    }

    function _validateCollateralFactor(uint256 factorBps) internal pure {
        require(factorBps <= MAX_COLLATERAL_FACTOR_BPS, "BAD_COLLATERAL_FACTOR");
    }
}
