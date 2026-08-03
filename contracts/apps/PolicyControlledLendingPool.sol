// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IBankPolicyEngine} from "./IBankPolicyEngine.sol";
import {IAssetOracle} from "./IAssetOracle.sol";
import {LendingPoolMath} from "./LendingPoolMath.sol";

/// @title PolicyControlledLendingPool
/// @notice Single-market lending pool with policy hooks, lender shares, debt shares, lazy interest,
///         reserve accounting, and explicit bad-debt recognition.
contract PolicyControlledLendingPool is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant RISK_ADMIN_ROLE = keccak256("RISK_ADMIN_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant LIQUIDATOR_ROLE = keccak256("LIQUIDATOR_ROLE");
    bytes32 public constant RESERVE_MANAGER_ROLE = keccak256("RESERVE_MANAGER_ROLE");

    uint256 public constant BPS = 10_000;
    uint256 public constant WAD = 1e18;
    uint8 public constant SUPPORTED_TOKEN_DECIMALS = 18;
    uint8 public constant ORACLE_PRICE_DECIMALS = 18;
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint256 public constant MAX_ACCRUAL_ELAPSED = 365 days;
    uint256 public constant MAX_COLLATERAL_FACTOR_BPS = BPS;
    uint256 public constant MAX_LIQUIDATION_BONUS_BPS = 5_000;
    uint256 public constant MAX_RESERVE_FACTOR_BPS = 5_000;
    uint256 public constant MAX_RATE_BPS = 100_000;
    uint256 public constant MAX_ACCRUAL_BATCHES_PER_CALL = 32;

    uint256 public constant PAUSE_BORROW = 1 << 0;
    uint256 public constant PAUSE_COLLATERAL_WITHDRAWAL = 1 << 1;
    uint256 public constant PAUSE_LIQUIDITY_DEPOSIT = 1 << 2;
    uint256 public constant PAUSE_LIQUIDITY_WITHDRAWAL = 1 << 3;
    uint256 public constant PAUSE_LIQUIDATION = 1 << 4;
    uint256 public constant PAUSE_BAD_DEBT_ABSORPTION = 1 << 5;
    uint256 public constant PAUSE_RESERVE_WITHDRAWAL = 1 << 6;
    uint256 public constant ALL_PAUSE_ACTIONS = (1 << 7) - 1;
    uint256 public constant DEFAULT_EMERGENCY_PAUSE_MASK =
        PAUSE_BORROW | PAUSE_COLLATERAL_WITHDRAWAL | PAUSE_LIQUIDITY_WITHDRAWAL | PAUSE_RESERVE_WITHDRAWAL;

    IERC20 public immutable collateralToken;
    IERC20 public immutable debtToken;
    IBankPolicyEngine public immutable policyEngine;
    IAssetOracle public valuationOracle;

    uint256 public collateralFactorBps;
    uint256 public liquidationThresholdBps;
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
    uint256 public liquidityEpoch;
    uint256 public borrowIndexE18;
    uint256 public lastAccrualTimestamp;
    uint256 public pausedActionMask;

    mapping(address => uint256) public collateralBalance;
    mapping(address => uint256) public debtShares;
    mapping(address => uint256) private _liquidityShares;
    mapping(address => uint256) public liquidityShareEpoch;
    mapping(address => uint256) public originationPrincipalDebt;

    error PolicyDenied(bytes32 policyCode);
    error LendingActionPaused(uint256 action);

    struct LiquidationPreview {
        uint256 requestedRepayAmount;
        uint256 actualRepayAmount;
        uint256 seizedCollateral;
        uint256 remainingDebt;
        uint256 remainingCollateral;
        uint256 badDebt;
        uint256 healthFactorBefore;
        uint256 healthFactorAfter;
        uint256 nominalSeizedCollateral;
        bool riskLimited;
        bool executable;
    }

    event InterestAccrued(
        uint256 indexed timestamp,
        uint256 interestAccrued,
        uint256 reservesAccrued,
        uint256 borrowIndexE18,
        uint256 totalBorrows
    );
    event LiquidityDeposited(address indexed supplier, uint256 assets, uint256 shares);
    event LiquidityRedeemed(address indexed supplier, address indexed receiver, uint256 assets, uint256 shares);
    event LiquidityLossEpochAdvanced(
        uint256 indexed previousEpoch, uint256 indexed newEpoch, uint256 forfeitedShares
    );
    event CollateralDeposited(address indexed user, uint256 amount);
    event CollateralWithdrawn(address indexed user, uint256 amount);
    event Borrowed(address indexed user, uint256 amount, uint256 shares);
    event Repaid(address indexed payer, address indexed borrower, uint256 amount, uint256 shares);
    event CollateralFactorUpdated(uint256 oldFactorBps, uint256 newFactorBps);
    event LiquidationThresholdUpdated(uint256 oldThresholdBps, uint256 newThresholdBps);
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
        uint256 badDebt,
        uint256 healthFactorBefore,
        uint256 healthFactorAfter
    );
    event EmergencyPaused(address indexed account);
    event EmergencyUnpaused(address indexed account);
    event ActionPauseMaskUpdated(address indexed account, uint256 previousMask, uint256 newMask);

    constructor(
        address admin,
        address collateralToken_,
        address debtToken_,
        address policyEngine_,
        uint256 collateralFactorBps_,
        uint256 liquidationThresholdBps_
    ) {
        require(admin != address(0), "ADMIN_ZERO");
        require(collateralToken_ != address(0), "COLLATERAL_ZERO");
        require(debtToken_ != address(0), "DEBT_ZERO");
        require(policyEngine_ != address(0), "POLICY_ENGINE_ZERO");
        require(collateralToken_.code.length > 0, "COLLATERAL_NOT_CONTRACT");
        require(debtToken_.code.length > 0, "DEBT_NOT_CONTRACT");
        require(policyEngine_.code.length > 0, "POLICY_ENGINE_NOT_CONTRACT");
        require(
            IERC20Metadata(collateralToken_).decimals() == SUPPORTED_TOKEN_DECIMALS,
            "UNSUPPORTED_COLLATERAL_DECIMALS"
        );
        require(
            IERC20Metadata(debtToken_).decimals() == SUPPORTED_TOKEN_DECIMALS,
            "UNSUPPORTED_DEBT_DECIMALS"
        );
        LendingPoolMath.validateRiskThresholds(collateralFactorBps_, liquidationThresholdBps_);

        collateralToken = IERC20(collateralToken_);
        debtToken = IERC20(debtToken_);
        policyEngine = IBankPolicyEngine(policyEngine_);
        collateralFactorBps = collateralFactorBps_;
        liquidationThresholdBps = liquidationThresholdBps_;
        collateralHaircutBps = BPS;
        liquidationCloseFactorBps = 5_000;
        liquidationBonusBps = 500;
        reserveFactorBps = 1_000;
        baseRateBps = 200;
        kinkUtilizationBps = 8_000;
        slope1Bps = 800;
        slope2Bps = 5_000;
        LendingPoolMath.validateLiquidationRiskParameters(
            collateralHaircutBps, liquidationThresholdBps, liquidationBonusBps
        );
        borrowIndexE18 = WAD;
        liquidityEpoch = 1;
        lastAccrualTimestamp = block.timestamp;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RISK_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, admin);
        _grantRole(LIQUIDATOR_ROLE, admin);
        _grantRole(RESERVE_MANAGER_ROLE, admin);
    }

    modifier whenActionNotPaused(uint256 action) {
        if ((pausedActionMask & action) != 0) revert LendingActionPaused(action);
        _;
    }

    /// @notice Applies the conservative emergency mask while keeping repayment, collateral top-up,
    ///         liquidity supply, liquidation, and bad-debt recognition available.
    function pause() external onlyRole(GUARDIAN_ROLE) {
        _setPausedActions(pausedActionMask | DEFAULT_EMERGENCY_PAUSE_MASK);
        emit EmergencyPaused(msg.sender);
    }

    function unpause() external onlyRole(RISK_ADMIN_ROLE) {
        _setPausedActions(0);
        emit EmergencyUnpaused(msg.sender);
    }

    /// @notice A guardian may stop additional action classes without gaining authority to resume them.
    function pauseActions(uint256 actionMask) external onlyRole(GUARDIAN_ROLE) {
        LendingPoolMath.validatePauseMask(actionMask, ALL_PAUSE_ACTIONS);
        _setPausedActions(pausedActionMask | actionMask);
    }

    /// @notice Only risk governance may resume selected action classes.
    function unpauseActions(uint256 actionMask) external onlyRole(RISK_ADMIN_ROLE) {
        LendingPoolMath.validatePauseMask(actionMask, ALL_PAUSE_ACTIONS);
        _setPausedActions(pausedActionMask & ~actionMask);
    }

    function setCollateralFactor(uint256 newFactorBps) external onlyRole(RISK_ADMIN_ROLE) {
        LendingPoolMath.validateRiskThresholds(newFactorBps, liquidationThresholdBps);
        uint256 oldFactor = collateralFactorBps;
        collateralFactorBps = newFactorBps;
        emit CollateralFactorUpdated(oldFactor, newFactorBps);
    }

    function setLiquidationThresholdBps(uint256 newThresholdBps) external onlyRole(RISK_ADMIN_ROLE) {
        LendingPoolMath.validateRiskThresholds(collateralFactorBps, newThresholdBps);
        LendingPoolMath.validateLiquidationRiskParameters(collateralHaircutBps, newThresholdBps, liquidationBonusBps);
        uint256 oldThreshold = liquidationThresholdBps;
        liquidationThresholdBps = newThresholdBps;
        emit LiquidationThresholdUpdated(oldThreshold, newThresholdBps);
    }

    function setCollateralHaircut(uint256 newHaircutBps) external onlyRole(RISK_ADMIN_ROLE) {
        require(newHaircutBps > 0 && newHaircutBps <= BPS, "BAD_HAIRCUT");
        LendingPoolMath.validateLiquidationRiskParameters(newHaircutBps, liquidationThresholdBps, liquidationBonusBps);
        uint256 oldHaircut = collateralHaircutBps;
        collateralHaircutBps = newHaircutBps;
        emit CollateralHaircutUpdated(oldHaircut, newHaircutBps);
    }

    function setValuationOracle(address oracle) external onlyRole(RISK_ADMIN_ROLE) {
        require(oracle != address(0), "ORACLE_ZERO");
        require(oracle.code.length > 0, "ORACLE_NOT_CONTRACT");
        address oldOracle = address(valuationOracle);
        valuationOracle = IAssetOracle(oracle);
        emit ValuationOracleUpdated(oldOracle, oracle);
    }

    function setLiquidationConfig(uint256 closeFactorBps, uint256 bonusBps) external onlyRole(RISK_ADMIN_ROLE) {
        require(closeFactorBps > 0 && closeFactorBps <= BPS, "BAD_CLOSE_FACTOR");
        require(bonusBps <= MAX_LIQUIDATION_BONUS_BPS, "BAD_LIQUIDATION_BONUS");
        LendingPoolMath.validateLiquidationRiskParameters(collateralHaircutBps, liquidationThresholdBps, bonusBps);
        liquidationCloseFactorBps = closeFactorBps;
        liquidationBonusBps = bonusBps;
        emit LiquidationConfigUpdated(closeFactorBps, bonusBps);
    }

    function setReserveFactor(uint256 newReserveFactorBps) external onlyRole(RISK_ADMIN_ROLE) {
        require(newReserveFactorBps <= MAX_RESERVE_FACTOR_BPS, "BAD_RESERVE_FACTOR");
        _accrueInterestForAction();
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
        _accrueInterestForAction();
        baseRateBps = newBaseRateBps;
        kinkUtilizationBps = newKinkUtilizationBps;
        slope1Bps = newSlope1Bps;
        slope2Bps = newSlope2Bps;
        emit InterestRateModelUpdated(newBaseRateBps, newKinkUtilizationBps, newSlope1Bps, newSlope2Bps);
    }

    function accrueInterest() external returns (uint256 interestAccrued, uint256 reservesAccrued) {
        return _accrueInterestBatch();
    }

    /// @notice Processes retained accrual backlog in bounded one-year batches without forgiving elapsed time.
    function catchUpInterest(uint256 maxBatches)
        external
        returns (uint256 interestAccrued, uint256 reservesAccrued, uint256 batchesProcessed)
    {
        require(maxBatches > 0 && maxBatches <= MAX_ACCRUAL_BATCHES_PER_CALL, "BAD_ACCRUAL_BATCH_COUNT");
        for (uint256 i = 0; i < maxBatches && lastAccrualTimestamp < block.timestamp; i++) {
            (uint256 batchInterest, uint256 batchReserves) = _accrueInterestBatch();
            interestAccrued += batchInterest;
            reservesAccrued += batchReserves;
            batchesProcessed++;
        }
    }

    function depositLiquidity(uint256 assets)
        external
        whenActionNotPaused(PAUSE_LIQUIDITY_DEPOSIT)
        nonReentrant
        returns (uint256 shares)
    {
        require(assets > 0, "AMOUNT_ZERO");
        _accrueInterestForAction();

        uint256 assetsBefore = _totalAssets();
        if (totalLiquidityShares > 0 && assetsBefore == 0) _advanceLiquidityLossEpoch();
        shares = totalLiquidityShares == 0 ? assets : assets * totalLiquidityShares / assetsBefore;
        require(shares > 0, "SHARES_ZERO");

        totalLiquidityShares += shares;
        _creditLiquidityShares(msg.sender, shares);
        _transferFromExact(debtToken, msg.sender, assets);
        emit LiquidityDeposited(msg.sender, assets, shares);
    }

    function redeemLiquidity(uint256 shareAmount)
        external
        whenActionNotPaused(PAUSE_LIQUIDITY_WITHDRAWAL)
        nonReentrant
        returns (uint256 assets)
    {
        return _redeemLiquidity(msg.sender, msg.sender, shareAmount);
    }

    function withdrawLiquidity(uint256 assets)
        external
        whenActionNotPaused(PAUSE_LIQUIDITY_WITHDRAWAL)
        nonReentrant
        returns (uint256 shares)
    {
        require(assets > 0, "AMOUNT_ZERO");
        _accrueInterestForAction();
        require(assets <= availableLiquidity(), "POOL_LIQUIDITY");

        shares = LendingPoolMath.assetsToLiquiditySharesUp(assets, totalLiquidityShares, _totalAssets());
        require(shares > 0, "SHARES_ZERO");
        require(liquidityShares(msg.sender) >= shares, "INSUFFICIENT_LIQUIDITY_SHARES");

        _liquidityShares[msg.sender] -= shares;
        totalLiquidityShares -= shares;
        debtToken.safeTransfer(msg.sender, assets);
        emit LiquidityRedeemed(msg.sender, msg.sender, assets, shares);
    }

    function depositCollateral(uint256 amount) external nonReentrant {
        require(amount > 0, "AMOUNT_ZERO");
        _accrueInterestForAction();

        (bool allowed, bytes32 code) = policyEngine.canAcceptCollateral(msg.sender, address(collateralToken), amount);
        if (!allowed) revert PolicyDenied(code);

        collateralBalance[msg.sender] += amount;
        totalCollateral += amount;
        _transferFromExact(collateralToken, msg.sender, amount);
        policyEngine.noteCollateralAccepted(msg.sender, address(collateralToken), amount);
        emit CollateralDeposited(msg.sender, amount);
    }

    function withdrawCollateral(uint256 amount)
        external
        whenActionNotPaused(PAUSE_COLLATERAL_WITHDRAWAL)
        nonReentrant
    {
        require(amount > 0, "AMOUNT_ZERO");
        _accrueInterestForAction();
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

    function borrow(uint256 amount) external whenActionNotPaused(PAUSE_BORROW) nonReentrant {
        require(amount > 0, "AMOUNT_ZERO");
        _accrueInterestForAction();
        require(_availableToBorrow(msg.sender) >= amount, "BORROW_LIMIT");
        require(availableLiquidity() >= amount, "POOL_LIQUIDITY");

        (bool allowed, bytes32 code) = policyEngine.canBorrow(msg.sender, address(debtToken), amount);
        if (!allowed) revert PolicyDenied(code);

        uint256 shares = LendingPoolMath.debtToSharesUp(amount, borrowIndexE18);
        require(shares > 0, "DEBT_SHARES_ZERO");

        debtShares[msg.sender] += shares;
        totalDebtShares += shares;
        totalBorrows += amount;
        originationPrincipalDebt[msg.sender] += amount;
        debtToken.safeTransfer(msg.sender, amount);
        policyEngine.noteOriginationPrincipalBorrowed(msg.sender, address(debtToken), amount);
        emit Borrowed(msg.sender, amount, shares);
    }

    function repay(uint256 amount) external nonReentrant returns (uint256 payment) {
        return _repayFor(msg.sender, msg.sender, amount);
    }

    function repayFor(address borrower, uint256 amount) external nonReentrant returns (uint256 payment) {
        require(borrower != address(0), "BORROWER_ZERO");
        return _repayFor(msg.sender, borrower, amount);
    }

    /// @notice Repays the caller's complete accrued balance without relying on a stale UI quote.
    function repayAll() external nonReentrant returns (uint256 payment) {
        return _repayFor(msg.sender, msg.sender, type(uint256).max);
    }

    function liquidate(address borrower, uint256 repayAmount)
        external
        onlyRole(LIQUIDATOR_ROLE)
        whenActionNotPaused(PAUSE_LIQUIDATION)
        nonReentrant
    {
        require(borrower != address(0), "BORROWER_ZERO");
        require(borrower != msg.sender, "SELF_LIQUIDATION");
        require(repayAmount > 0, "AMOUNT_ZERO");
        _accrueInterestForAction();

        LiquidationPreview memory preview = _previewLiquidation(borrower, repayAmount);
        require(preview.requestedRepayAmount > 0, "AMOUNT_ZERO");
        require(preview.actualRepayAmount > 0, "NO_DEBT");
        require(preview.executable, "POSITION_HEALTHY");

        uint256 borrowerCollateral = collateralBalance[borrower];

        (uint256 payment,) = _reduceDebtForPayment(borrower, preview.actualRepayAmount);
        if (preview.seizedCollateral > 0) {
            collateralBalance[borrower] = borrowerCollateral - preview.seizedCollateral;
            totalCollateral -= preview.seizedCollateral;
        }

        _transferFromExact(debtToken, msg.sender, payment);
        if (preview.seizedCollateral > 0) {
            collateralToken.safeTransfer(msg.sender, preview.seizedCollateral);
            policyEngine.noteCollateralReleased(borrower, address(collateralToken), preview.seizedCollateral);
            // Voucher exposure is not decremented here because the voucher is transferred, not burned.
            // Exposure remains outstanding until the liquidator settles it through the transfer app.
        }

        uint256 badDebtWrittenOff;
        if (collateralBalance[borrower] == 0) {
            badDebtWrittenOff = _recognizeRemainingBadDebt(borrower);
        }

        emit PositionLiquidated(
            borrower,
            msg.sender,
            payment,
            preview.seizedCollateral,
            badDebtWrittenOff,
            preview.healthFactorBefore,
            _healthFactorE18(borrower)
        );
    }

    function absorbBadDebt(address borrower)
        external
        onlyRole(LIQUIDATOR_ROLE)
        whenActionNotPaused(PAUSE_BAD_DEBT_ABSORPTION)
        nonReentrant
        returns (uint256 badDebtWrittenOff)
    {
        require(borrower != address(0), "BORROWER_ZERO");
        _accrueInterestForAction();
        require(collateralBalance[borrower] == 0, "COLLATERAL_REMAINING");
        require(debtOf(borrower) > 0, "NO_DEBT");
        badDebtWrittenOff = _recognizeRemainingBadDebt(borrower);
    }

    function withdrawReserves(address to, uint256 amount)
        external
        onlyRole(RESERVE_MANAGER_ROLE)
        whenActionNotPaused(PAUSE_RESERVE_WITHDRAWAL)
        nonReentrant
    {
        require(to != address(0), "TO_ZERO");
        require(amount > 0, "AMOUNT_ZERO");
        _accrueInterestForAction();
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

    function liquidationThresholdValue(address user) external view returns (uint256) {
        return _liquidationThresholdValue(collateralBalance[user]);
    }

    function healthFactorE18(address user) external view returns (uint256) {
        return _healthFactorE18(user);
    }

    function healthFactorBps(address user) external view returns (uint256) {
        return _healthFactorBps(user);
    }

    function isLiquidatable(address user) public view returns (bool) {
        return debtOf(user) > 0 && _healthFactorE18(user) < WAD;
    }

    function maxLiquidationRepay(address user) external view returns (uint256) {
        return LendingPoolMath.maxLiquidationRepay(debtOf(user), liquidationCloseFactorBps);
    }

    function previewLiquidation(address borrower, uint256 repayAmount) external view returns (LiquidationPreview memory) {
        require(borrower != address(0), "BORROWER_ZERO");
        return _previewLiquidation(borrower, repayAmount);
    }

    function totalCash() public view returns (uint256) {
        return debtToken.balanceOf(address(this));
    }

    function availableLiquidity() public view returns (uint256) {
        return _availableCash();
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

    /// @notice Returns only shares from the active supplier-loss epoch.
    function liquidityShares(address user) public view returns (uint256) {
        if (liquidityShareEpoch[user] != liquidityEpoch) return 0;
        return _liquidityShares[user];
    }

    function liquidityBalanceOf(address user) public view returns (uint256) {
        if (totalLiquidityShares == 0) return 0;
        return liquidityShares(user) * totalAssets() / totalLiquidityShares;
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
        uint256 elapsed = _cappedElapsed();
        if (elapsed == 0) return borrowIndexE18;
        uint256 rateBps = _currentBorrowRateBps(totalBorrows, _availableCash());
        return borrowIndexE18 + (borrowIndexE18 * rateBps * elapsed / (BPS * SECONDS_PER_YEAR));
    }

    function pendingInterest() public view returns (uint256 interest, uint256 reserves) {
        if (totalBorrows == 0) return (0, 0);
        uint256 elapsed = _cappedElapsed();
        if (elapsed == 0) return (0, 0);
        uint256 rateBps = _currentBorrowRateBps(totalBorrows, _availableCash());
        interest = totalBorrows * rateBps * elapsed / (BPS * SECONDS_PER_YEAR);
        reserves = interest * reserveFactorBps / BPS;
    }

    function utilizationRateBps() public view returns (uint256) {
        return LendingPoolMath.utilizationRateBps(totalBorrows, _availableCash());
    }

    /// @notice Utilization rate including pending accrued interest, suitable for external monitoring.
    function accruedUtilizationRateBps() external view returns (uint256) {
        (uint256 interest, uint256 reserves) = pendingInterest();
        return LendingPoolMath.utilizationRateBps(totalBorrows + interest, _availableCash(totalReserves + reserves));
    }

    function currentBorrowRateBps() public view returns (uint256) {
        return _currentBorrowRateBps(totalBorrows, _availableCash());
    }

    function accrualBacklogSeconds() public view returns (uint256) {
        return block.timestamp - lastAccrualTimestamp;
    }

    function accrualBatchesRequired() external view returns (uint256) {
        uint256 backlog = accrualBacklogSeconds();
        if (backlog == 0 || totalBorrows == 0) return 0;
        return (backlog + MAX_ACCRUAL_ELAPSED - 1) / MAX_ACCRUAL_ELAPSED;
    }

    function isAccrualCurrent() external view returns (bool) {
        return totalBorrows == 0 || lastAccrualTimestamp == block.timestamp;
    }

    function _redeemLiquidity(address owner, address receiver, uint256 shareAmount) internal returns (uint256 assets) {
        require(shareAmount > 0, "SHARES_ZERO");
        _accrueInterestForAction();
        require(liquidityShares(owner) >= shareAmount, "INSUFFICIENT_LIQUIDITY_SHARES");

        assets = shareAmount * _totalAssets() / totalLiquidityShares;
        require(assets > 0, "ASSETS_ZERO");
        require(assets <= availableLiquidity(), "POOL_LIQUIDITY");

        _liquidityShares[owner] -= shareAmount;
        totalLiquidityShares -= shareAmount;
        debtToken.safeTransfer(receiver, assets);
        emit LiquidityRedeemed(owner, receiver, assets, shareAmount);
    }

    function _repayFor(address payer, address borrower, uint256 amount) internal returns (uint256 payment) {
        require(amount > 0, "AMOUNT_ZERO");
        _accrueInterestForAction();
        (payment,) = _reduceDebtForPayment(borrower, amount);
        _transferFromExact(debtToken, payer, payment);
    }

    function _reduceDebtForPayment(address borrower, uint256 amount) internal returns (uint256 payment, uint256 sharesBurned) {
        uint256 currentDebt = debtOf(borrower);
        require(currentDebt > 0, "NO_DEBT");
        payment = amount > currentDebt ? currentDebt : amount;

        uint256 borrowerShares = debtShares[borrower];
        sharesBurned = payment == currentDebt
            ? borrowerShares
            : LendingPoolMath.debtToSharesUp(payment, borrowIndexE18);
        if (sharesBurned > borrowerShares) sharesBurned = borrowerShares;
        uint256 debtReduction = payment == currentDebt
            ? currentDebt
            : LendingPoolMath.sharesToDebt(sharesBurned, borrowIndexE18);
        if (debtReduction > currentDebt) debtReduction = currentDebt;
        if (debtReduction > totalBorrows) debtReduction = totalBorrows;

        debtShares[borrower] = borrowerShares - sharesBurned;
        totalDebtShares -= sharesBurned;
        totalBorrows -= debtReduction;

        // Contractual repayments service accrued interest before releasing origination-principal capacity.
        uint256 principalOutstanding = originationPrincipalDebt[borrower];
        uint256 accruedInterestOutstanding = currentDebt > principalOutstanding ? currentDebt - principalOutstanding : 0;
        uint256 principalReduction = debtReduction > accruedInterestOutstanding
            ? debtReduction - accruedInterestOutstanding
            : 0;
        if (principalReduction > principalOutstanding) principalReduction = principalOutstanding;
        if (principalReduction > 0) {
            originationPrincipalDebt[borrower] = principalOutstanding - principalReduction;
            policyEngine.noteOriginationPrincipalRepaid(borrower, address(debtToken), principalReduction);
        }

        emit Repaid(msg.sender, borrower, payment, sharesBurned);
    }

    function _transferFromExact(IERC20 token, address from, uint256 amount) internal {
        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - balanceBefore;
        require(received == amount, "FEE_ON_TRANSFER_UNSUPPORTED");
    }

    function _recognizeRemainingBadDebt(address borrower) internal returns (uint256 debtWrittenOff) {
        debtWrittenOff = debtOf(borrower);
        if (debtWrittenOff == 0) return 0;

        uint256 shares = debtShares[borrower];
        debtShares[borrower] = 0;
        totalDebtShares -= shares;
        totalBorrows = totalBorrows > debtWrittenOff ? totalBorrows - debtWrittenOff : 0;

        uint256 principalOutstanding = originationPrincipalDebt[borrower];
        originationPrincipalDebt[borrower] = 0;
        policyEngine.noteDebtDefaulted(borrower, address(debtToken), principalOutstanding, debtWrittenOff);

        // Bad debt is first absorbed by accumulated reserves; only the uncovered remainder is supplier loss.
        uint256 reservesUsed = debtWrittenOff > totalReserves ? totalReserves : debtWrittenOff;
        totalReserves -= reservesUsed;
        uint256 supplierLoss = debtWrittenOff - reservesUsed;
        totalBadDebt += supplierLoss;

        emit BadDebtRecognized(borrower, debtWrittenOff, reservesUsed, supplierLoss);
        if (totalLiquidityShares > 0 && _totalAssets() == 0) _advanceLiquidityLossEpoch();
    }

    function _accrueInterestForAction() internal returns (uint256 interestAccrued, uint256 reservesAccrued) {
        if (totalBorrows > 0) {
            require(block.timestamp - lastAccrualTimestamp <= MAX_ACCRUAL_ELAPSED, "ACCRUAL_CATCH_UP_REQUIRED");
        }
        return _accrueInterestBatch();
    }

    function _accrueInterestBatch() internal returns (uint256 interestAccrued, uint256 reservesAccrued) {
        uint256 elapsed = block.timestamp - lastAccrualTimestamp;
        if (elapsed == 0) return (0, 0);

        if (totalBorrows == 0) {
            lastAccrualTimestamp = block.timestamp;
            emit InterestAccrued(block.timestamp, 0, 0, borrowIndexE18, totalBorrows);
            return (0, 0);
        }

        if (elapsed > MAX_ACCRUAL_ELAPSED) elapsed = MAX_ACCRUAL_ELAPSED;
        lastAccrualTimestamp += elapsed;

        // Borrowers hold debt shares, so interest updates the global borrow index instead of each account.
        uint256 rateBps = _currentBorrowRateBps(totalBorrows, _availableCash());
        interestAccrued = totalBorrows * rateBps * elapsed / (BPS * SECONDS_PER_YEAR);
        reservesAccrued = interestAccrued * reserveFactorBps / BPS;
        totalBorrows += interestAccrued;
        totalReserves += reservesAccrued;
        borrowIndexE18 += borrowIndexE18 * rateBps * elapsed / (BPS * SECONDS_PER_YEAR);

        emit InterestAccrued(lastAccrualTimestamp, interestAccrued, reservesAccrued, borrowIndexE18, totalBorrows);
    }

    function _availableToBorrow(address user) internal view returns (uint256) {
        uint256 ceiling = _maxBorrow(collateralBalance[user]);
        uint256 debt = debtOf(user);
        return ceiling > debt ? ceiling - debt : 0;
    }

    function _healthFactorBps(address user) internal view returns (uint256) {
        uint256 health = _healthFactorE18(user);
        if (health == type(uint256).max) return type(uint256).max;
        return health / (WAD / BPS);
    }

    function _healthFactorE18(address user) internal view returns (uint256) {
        return _healthFactorE18For(collateralBalance[user], debtOf(user));
    }

    function _healthFactorE18For(uint256 collateralAmount, uint256 debtAmount) internal view returns (uint256) {
        if (debtAmount == 0) return type(uint256).max;

        uint256 thresholdDebtValue = _liquidationThresholdValue(collateralAmount);
        uint256 currentDebtValue = _debtValue(debtAmount);
        if (currentDebtValue == 0) return type(uint256).max;
        return thresholdDebtValue * WAD / currentDebtValue;
    }

    function _previewLiquidation(address borrower, uint256 repayAmount) internal view returns (LiquidationPreview memory preview) {
        uint256 debt = debtOf(borrower);
        uint256 collateral = collateralBalance[borrower];
        uint256 actualRepay = repayAmount;
        uint256 maxRepay = LendingPoolMath.maxLiquidationRepay(debt, liquidationCloseFactorBps);
        if (actualRepay > debt) actualRepay = debt;
        if (actualRepay > maxRepay) actualRepay = maxRepay;

        uint256 nominalSeizedCollateral;
        uint256 seizedCollateral;
        bool riskLimited;
        if (actualRepay > 0) {
            nominalSeizedCollateral = _liquidationSeizeAmount(actualRepay);
            seizedCollateral = nominalSeizedCollateral;
            if (seizedCollateral > collateral) seizedCollateral = collateral;

            // A partial liquidation may not reduce the position's health factor. For deeply
            // underwater positions the contractual bonus is therefore capped by the maximum
            // collateral fraction proportional to debt repaid. Full collateral exhaustion is
            // exempt because the residual debt is atomically recognized as defaulted bad debt.
            if (actualRepay < debt && seizedCollateral < collateral) {
                uint256 maxRiskSafeSeize = Math.mulDiv(collateral, actualRepay, debt);
                if (seizedCollateral > maxRiskSafeSeize) {
                    seizedCollateral = maxRiskSafeSeize;
                    riskLimited = true;
                }
            }
        }

        uint256 debtAfterRepay = debt > actualRepay ? debt - actualRepay : 0;
        uint256 remainingCollateral = collateral > seizedCollateral ? collateral - seizedCollateral : 0;
        uint256 badDebt = remainingCollateral == 0 ? debtAfterRepay : 0;
        uint256 remainingDebt = badDebt > 0 ? 0 : debtAfterRepay;

        uint256 healthFactorBefore = _healthFactorE18For(collateral, debt);
        uint256 healthFactorAfter = _healthFactorE18For(remainingCollateral, remainingDebt);
        if (
            healthFactorAfter < healthFactorBefore && seizedCollateral > 0 && remainingCollateral > 0
                && remainingDebt > 0
        ) {
            // Leave a one-basis-point rounding buffer only when nested price/haircut division
            // would otherwise move the computed health factor down by integer dust.
            uint256 bufferedSeize = Math.mulDiv(seizedCollateral, BPS - 1, BPS);
            if (bufferedSeize == seizedCollateral) bufferedSeize--;
            seizedCollateral = bufferedSeize;
            remainingCollateral = collateral - seizedCollateral;
            healthFactorAfter = _healthFactorE18For(remainingCollateral, remainingDebt);
            riskLimited = true;
        }
        preview = LiquidationPreview({
            requestedRepayAmount: repayAmount,
            actualRepayAmount: actualRepay,
            seizedCollateral: seizedCollateral,
            remainingDebt: remainingDebt,
            remainingCollateral: remainingCollateral,
            badDebt: badDebt,
            healthFactorBefore: healthFactorBefore,
            healthFactorAfter: healthFactorAfter,
            nominalSeizedCollateral: nominalSeizedCollateral,
            riskLimited: riskLimited,
            executable: debt > 0 && actualRepay > 0 && healthFactorBefore < WAD && healthFactorAfter >= healthFactorBefore
        });
    }

    function _liquidationSeizeAmount(uint256 repayAmount) internal view returns (uint256) {
        uint256 debtPrice = _price(address(debtToken));
        uint256 collateralPrice = _price(address(collateralToken));
        uint256 repayValue = repayAmount * debtPrice / WAD;
        // The liquidation bonus compensates the liquidator by increasing collateral seized for a given repayment.
        uint256 bonusValue = repayValue * (BPS + liquidationBonusBps) / BPS;
        return bonusValue * WAD / collateralPrice;
    }

    function _maxBorrow(uint256 collateralAmount) internal view returns (uint256) {
        uint256 collateralValue_ = _collateralValue(collateralAmount);
        uint256 borrowValue = collateralValue_ * collateralFactorBps / BPS;
        uint256 debtPrice = _price(address(debtToken));
        return borrowValue * WAD / debtPrice;
    }

    function _liquidationThresholdValue(uint256 collateralAmount) internal view returns (uint256) {
        return _collateralValue(collateralAmount) * liquidationThresholdBps / BPS;
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

    function _creditLiquidityShares(address owner, uint256 shares) internal {
        if (liquidityShareEpoch[owner] != liquidityEpoch) {
            liquidityShareEpoch[owner] = liquidityEpoch;
            _liquidityShares[owner] = 0;
        }
        _liquidityShares[owner] += shares;
    }

    /// @dev Invalidates every unenumerable legacy claim before any fresh capital can enter a zero-asset pool.
    function _advanceLiquidityLossEpoch() internal {
        uint256 previousEpoch = liquidityEpoch;
        uint256 forfeitedShares = totalLiquidityShares;
        liquidityEpoch = previousEpoch + 1;
        totalLiquidityShares = 0;
        emit LiquidityLossEpochAdvanced(previousEpoch, liquidityEpoch, forfeitedShares);
    }

    function _totalAssets() internal view returns (uint256) {
        uint256 cashAndBorrows = totalCash() + totalBorrows;
        return cashAndBorrows > totalReserves ? cashAndBorrows - totalReserves : 0;
    }

    function _availableCash() internal view returns (uint256) {
        return _availableCash(totalReserves);
    }

    function _availableCash(uint256 reserves) internal view returns (uint256) {
        uint256 cash = totalCash();
        return cash > reserves ? cash - reserves : 0;
    }

    function _cappedElapsed() internal view returns (uint256 elapsed) {
        elapsed = block.timestamp - lastAccrualTimestamp;
        if (elapsed > MAX_ACCRUAL_ELAPSED) elapsed = MAX_ACCRUAL_ELAPSED;
    }

    function _currentBorrowRateBps(uint256 borrows, uint256 availableCash_) internal view returns (uint256) {
        return LendingPoolMath.borrowRateBps(
            borrows,
            availableCash_,
            baseRateBps,
            kinkUtilizationBps,
            slope1Bps,
            slope2Bps
        );
    }

    function _setPausedActions(uint256 newMask) internal {
        LendingPoolMath.validateStoredPauseMask(newMask, ALL_PAUSE_ACTIONS);
        uint256 previousMask = pausedActionMask;
        pausedActionMask = newMask;
        if (previousMask == 0 && newMask != 0) {
            _pause();
        } else if (previousMask != 0 && newMask == 0) {
            _unpause();
        }
        emit ActionPauseMaskUpdated(msg.sender, previousMask, newMask);
    }
}
