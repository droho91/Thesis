// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {ISwapRouter} from "./interfaces/ISwapRouter.sol";

/// @title LendingPool
/// @notice Lending pool with oracle-based valuation, utilization APR, and liquidation.
/// @dev Educational implementation for thesis demo.
contract LendingPool is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant RISK_ADMIN_ROLE = keccak256("RISK_ADMIN_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint256 public constant BPS = 10_000;
    uint256 public constant YEAR = 365 days;
    uint256 public constant ORACLE_DECIMALS = 1e8;

    IERC20 public collateralToken;
    IERC20 public stableToken;
    IPriceOracle public priceOracle;
    ISwapRouter public swapRouter;

    // Risk parameters.
    uint256 public collateralFactorBps; // Borrow limit.
    uint256 public liquidationThresholdBps; // HF threshold.
    uint256 public closeFactorBps; // Max repay in one non-overdue liquidation.
    uint256 public liquidationBonusBps;
    uint256 public loanDuration;
    uint256 public overduePenaltyBps;

    // Interest model (kinked utilization APR).
    uint256 public baseRateBps;
    uint256 public slope1Bps;
    uint256 public slope2Bps;
    uint256 public kinkBps;

    // Total outstanding debt = principal + accrued interest + penalty.
    uint256 public totalDebt;
    // Tracks realized losses removed from active debt via write-off.
    uint256 public totalWrittenOffDebt;

    struct Position {
        uint256 collateralAmount;
        uint256 principalAmount;
        uint256 accruedInterestAmount;
        uint256 penaltyAmount;
        uint256 dueTimestamp;
        bool overduePenaltyApplied;
    }

    mapping(address => Position) public positions;
    mapping(address => uint256) public lastInterestTimestamp;

    event CollateralDeposited(address indexed user, uint256 amount);
    event CollateralWithdrawn(address indexed user, uint256 amount);
    event Borrowed(address indexed user, uint256 amount);
    event Repaid(address indexed user, uint256 amount);

    event OracleUpdated(address indexed oldOracle, address indexed newOracle);
    event SwapRouterUpdated(address indexed oldRouter, address indexed newRouter);
    event CollateralFactorUpdated(uint256 oldFactorBps, uint256 newFactorBps);
    event LiquidationThresholdUpdated(uint256 oldThresholdBps, uint256 newThresholdBps);
    event CloseFactorUpdated(uint256 oldCloseFactorBps, uint256 newCloseFactorBps);
    event LoanDurationUpdated(uint256 oldDuration, uint256 newDuration);
    event OverduePenaltyUpdated(uint256 oldPenaltyBps, uint256 newPenaltyBps);
    event LiquidationBonusUpdated(uint256 oldBonusBps, uint256 newBonusBps);

    event InterestModelUpdated(uint256 baseRateBps, uint256 slope1Bps, uint256 slope2Bps, uint256 kinkBps);
    event InterestAccrued(address indexed user, uint256 interestAmount, uint256 newDebtAmount, uint256 rateBps, uint256 elapsedSeconds);

    event OverduePenaltyApplied(address indexed user, uint256 penaltyAmount, uint256 newDebtAmount);
    event Liquidated(
        address indexed user,
        address indexed liquidator,
        uint256 repaidDebt,
        uint256 seizedCollateral,
        bool overdueLiquidation
    );
    event BadDebtWrittenOff(address indexed user, uint256 amount, uint256 cumulativeWrittenOffDebt);
    event RepaidWithCollateral(
        address indexed user,
        uint256 collateralSold,
        uint256 stableReceived,
        uint256 debtRepaid,
        uint256 stableRefunded
    );

    constructor(address _collateralToken, address _stableToken, address _oracle, uint256 _collateralFactorBps) {
        require(_collateralToken != address(0), "COLLATERAL_ZERO");
        require(_stableToken != address(0), "STABLE_ZERO");
        require(_oracle != address(0), "ORACLE_ZERO");
        require(_collateralFactorBps > 0 && _collateralFactorBps <= BPS, "BAD_FACTOR");

        collateralToken = IERC20(_collateralToken);
        stableToken = IERC20(_stableToken);
        priceOracle = IPriceOracle(_oracle);

        collateralFactorBps = _collateralFactorBps;
        liquidationThresholdBps = 8_500;
        closeFactorBps = 5_000;
        liquidationBonusBps = 500;
        loanDuration = 3 days;
        overduePenaltyBps = 500;

        // APR defaults: base 2%, slope1 8%, slope2 40%, kink at 80% utilization.
        baseRateBps = 200;
        slope1Bps = 800;
        slope2Bps = 4_000;
        kinkBps = 8_000;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(RISK_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
    }

    /// @notice Pause borrow/repay/liquidation actions.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Unpause borrow/repay/liquidation actions.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Update oracle contract.
    function setOracle(address newOracle) external onlyRole(RISK_ADMIN_ROLE) {
        require(newOracle != address(0), "ORACLE_ZERO");
        address oldOracle = address(priceOracle);
        priceOracle = IPriceOracle(newOracle);
        emit OracleUpdated(oldOracle, newOracle);
    }

    /// @notice Update same-chain swap router used for repay-with-collateral flows.
    function setSwapRouter(address newRouter) external onlyRole(RISK_ADMIN_ROLE) {
        address oldRouter = address(swapRouter);
        swapRouter = ISwapRouter(newRouter);
        emit SwapRouterUpdated(oldRouter, newRouter);
    }

    /// @notice Update collateral factor (borrow LTV).
    function setCollateralFactorBps(uint256 newFactorBps) external onlyRole(RISK_ADMIN_ROLE) {
        require(newFactorBps > 0 && newFactorBps <= BPS, "BAD_FACTOR");
        require(newFactorBps <= liquidationThresholdBps, "FACTOR_GT_LIQ_THRESHOLD");
        uint256 oldFactor = collateralFactorBps;
        collateralFactorBps = newFactorBps;
        emit CollateralFactorUpdated(oldFactor, newFactorBps);
    }

    /// @notice Update liquidation threshold.
    function setLiquidationThresholdBps(uint256 newThresholdBps) external onlyRole(RISK_ADMIN_ROLE) {
        require(newThresholdBps > 0 && newThresholdBps <= BPS, "BAD_THRESHOLD");
        require(newThresholdBps >= collateralFactorBps, "THRESH_LT_FACTOR");
        uint256 oldThreshold = liquidationThresholdBps;
        liquidationThresholdBps = newThresholdBps;
        emit LiquidationThresholdUpdated(oldThreshold, newThresholdBps);
    }

    /// @notice Update close factor.
    function setCloseFactorBps(uint256 newCloseFactorBps) external onlyRole(RISK_ADMIN_ROLE) {
        require(newCloseFactorBps > 0 && newCloseFactorBps <= BPS, "BAD_CLOSE_FACTOR");
        uint256 oldClose = closeFactorBps;
        closeFactorBps = newCloseFactorBps;
        emit CloseFactorUpdated(oldClose, newCloseFactorBps);
    }

    /// @notice Update loan duration in seconds.
    function setLoanDuration(uint256 newDuration) external onlyRole(RISK_ADMIN_ROLE) {
        require(newDuration > 0, "BAD_DURATION");
        uint256 oldDuration = loanDuration;
        loanDuration = newDuration;
        emit LoanDurationUpdated(oldDuration, newDuration);
    }

    /// @notice Update overdue penalty in basis points.
    function setOverduePenaltyBps(uint256 newPenaltyBps) external onlyRole(RISK_ADMIN_ROLE) {
        require(newPenaltyBps <= BPS, "BAD_PENALTY");
        uint256 oldPenalty = overduePenaltyBps;
        overduePenaltyBps = newPenaltyBps;
        emit OverduePenaltyUpdated(oldPenalty, newPenaltyBps);
    }

    /// @notice Update liquidation bonus in basis points.
    function setLiquidationBonusBps(uint256 newBonusBps) external onlyRole(RISK_ADMIN_ROLE) {
        require(newBonusBps <= BPS, "BAD_BONUS");
        uint256 oldBonus = liquidationBonusBps;
        liquidationBonusBps = newBonusBps;
        emit LiquidationBonusUpdated(oldBonus, newBonusBps);
    }

    /// @notice Update utilization APR model.
    function setInterestModel(
        uint256 newBaseRateBps,
        uint256 newSlope1Bps,
        uint256 newSlope2Bps,
        uint256 newKinkBps
    ) external onlyRole(RISK_ADMIN_ROLE) {
        require(newKinkBps > 0 && newKinkBps <= BPS, "BAD_KINK");
        require(newBaseRateBps <= BPS * 5, "BASE_TOO_HIGH");
        require(newSlope1Bps <= BPS * 10, "SLOPE1_TOO_HIGH");
        require(newSlope2Bps <= BPS * 20, "SLOPE2_TOO_HIGH");

        baseRateBps = newBaseRateBps;
        slope1Bps = newSlope1Bps;
        slope2Bps = newSlope2Bps;
        kinkBps = newKinkBps;

        emit InterestModelUpdated(newBaseRateBps, newSlope1Bps, newSlope2Bps, newKinkBps);
    }

    /// @notice Current utilization in bps.
    function utilizationBps() public view returns (uint256) {
        uint256 liquidity = stableToken.balanceOf(address(this));
        uint256 denom = totalDebt + liquidity;
        if (denom == 0) return 0;
        return (totalDebt * BPS) / denom;
    }

    /// @notice Current borrow APR in bps based on utilization.
    function borrowRateBps() public view returns (uint256) {
        uint256 util = utilizationBps();
        if (util <= kinkBps) {
            return baseRateBps + ((slope1Bps * util) / kinkBps);
        }

        uint256 excessUtil = util - kinkBps;
        uint256 range = BPS - kinkBps;
        return baseRateBps + slope1Bps + ((slope2Bps * excessUtil) / range);
    }

    /// @notice Gross historical debt exposure including debt already written off as losses.
    function grossDebtExposure() public view returns (uint256) {
        return totalDebt + totalWrittenOffDebt;
    }

    function storedDebt(address user) public view returns (uint256) {
        Position storage p = positions[user];
        return p.principalAmount + p.accruedInterestAmount + p.penaltyAmount;
    }

    function previewInterest(address user) public view returns (uint256) {
        Position storage p = positions[user];
        uint256 stored = p.accruedInterestAmount;
        uint256 principalOutstanding = p.principalAmount;
        if (principalOutstanding == 0) return stored;

        uint256 lastTs = lastInterestTimestamp[user];
        if (lastTs == 0 || block.timestamp <= lastTs) return stored;

        uint256 elapsed = block.timestamp - lastTs;
        uint256 rate = borrowRateBps();
        uint256 pending = (principalOutstanding * rate * elapsed) / (BPS * YEAR);
        return stored + pending;
    }

    function debtBreakdown(address user) public view returns (uint256 principal, uint256 interest, uint256 penalty, uint256 total) {
        Position storage p = positions[user];
        principal = p.principalAmount;
        interest = previewInterest(user);
        penalty = p.penaltyAmount;
        total = principal + interest + penalty;
    }

    /// @notice Preview current debt including unaccrued interest.
    function previewDebt(address user) public view returns (uint256) {
        (, , , uint256 total) = debtBreakdown(user);
        return total;
    }

    function collateralValueUsd(address user) public view returns (uint256) {
        uint256 price = priceOracle.getPrice(address(collateralToken));
        return (positions[user].collateralAmount * price) / ORACLE_DECIMALS;
    }

    function debtValueUsd(address user) public view returns (uint256) {
        uint256 price = priceOracle.getPrice(address(stableToken));
        return (previewDebt(user) * price) / ORACLE_DECIMALS;
    }

    function maxDebtValueUsd(address user) public view returns (uint256) {
        return (collateralValueUsd(user) * collateralFactorBps) / BPS;
    }

    /// @notice Max additional stable tokens user can borrow now.
    function maxBorrowable(address user) public view returns (uint256) {
        uint256 maxDebtUsd = maxDebtValueUsd(user);
        uint256 currentDebtUsd = debtValueUsd(user);
        if (maxDebtUsd <= currentDebtUsd) return 0;

        uint256 availableUsd = maxDebtUsd - currentDebtUsd;
        uint256 stablePrice = priceOracle.getPrice(address(stableToken));
        return (availableUsd * ORACLE_DECIMALS) / stablePrice;
    }

    /// @notice Max collateral amount user can safely withdraw now.
    function maxWithdrawable(address user) public view returns (uint256) {
        Position storage p = positions[user];
        if (p.collateralAmount == 0) return 0;

        uint256 currentDebtUsd = debtValueUsd(user);
        if (currentDebtUsd == 0) return p.collateralAmount;

        uint256 collateralPrice = priceOracle.getPrice(address(collateralToken));
        uint256 minCollateralUsd = _ceilDiv(currentDebtUsd * BPS, collateralFactorBps);
        uint256 minCollateralAmount = _ceilDiv(minCollateralUsd * ORACLE_DECIMALS, collateralPrice);

        if (p.collateralAmount <= minCollateralAmount) return 0;
        return p.collateralAmount - minCollateralAmount;
    }

    /// @notice Health factor in bps. HF < 10000 means liquidatable by market risk.
    function healthFactorBps(address user) public view returns (uint256) {
        uint256 currentDebtUsd = debtValueUsd(user);
        if (currentDebtUsd == 0) return type(uint256).max;

        uint256 adjustedCollateralUsd = (collateralValueUsd(user) * liquidationThresholdBps) / BPS;
        return (adjustedCollateralUsd * BPS) / currentDebtUsd;
    }

    function isOverdue(address user) public view returns (bool) {
        Position storage p = positions[user];
        return previewDebt(user) > 0 && p.dueTimestamp > 0 && block.timestamp > p.dueTimestamp;
    }

    function isLiquidatable(address user) public view returns (bool) {
        if (isOverdue(user)) return true;
        return healthFactorBps(user) < BPS;
    }

    /// @notice Accrue interest for user debt.
    function accrueInterest(address user) external returns (uint256 interestAmount) {
        return _accrueUserInterest(user);
    }

    /// @notice Deposit wrapped collateral.
    function depositCollateral(uint256 amount) external whenNotPaused nonReentrant {
        require(amount > 0, "AMOUNT_ZERO");
        collateralToken.safeTransferFrom(msg.sender, address(this), amount);
        positions[msg.sender].collateralAmount += amount;
        emit CollateralDeposited(msg.sender, amount);
    }

    /// @notice Withdraw collateral while keeping position safe.
    function withdrawCollateral(uint256 amount) external whenNotPaused nonReentrant {
        require(amount > 0, "AMOUNT_ZERO");
        _accrueUserInterest(msg.sender);

        Position storage p = positions[msg.sender];
        require(!isOverdue(msg.sender), "LOAN_OVERDUE");
        require(p.collateralAmount >= amount, "INSUFFICIENT_COLLATERAL");
        require(amount <= maxWithdrawable(msg.sender), "LTV_EXCEEDED");

        p.collateralAmount -= amount;
        collateralToken.safeTransfer(msg.sender, amount);

        emit CollateralWithdrawn(msg.sender, amount);
    }

    /// @notice Withdraw the exact maximum collateral currently withdrawable after accruing interest.
    /// @dev This keeps "withdraw max" atomic so UI preview drift does not cause reverts.
    function withdrawMax() external whenNotPaused nonReentrant returns (uint256 amountWithdrawn) {
        _accrueUserInterest(msg.sender);

        Position storage p = positions[msg.sender];
        require(!isOverdue(msg.sender), "LOAN_OVERDUE");

        amountWithdrawn = maxWithdrawable(msg.sender);
        require(amountWithdrawn > 0, "NOTHING_TO_WITHDRAW");

        p.collateralAmount -= amountWithdrawn;
        collateralToken.safeTransfer(msg.sender, amountWithdrawn);

        emit CollateralWithdrawn(msg.sender, amountWithdrawn);
    }

    /// @notice Borrow stable token based on oracle value and LTV.
    function borrow(uint256 amount) external whenNotPaused nonReentrant {
        require(amount > 0, "AMOUNT_ZERO");
        _accrueUserInterest(msg.sender);

        Position storage p = positions[msg.sender];
        require(!isOverdue(msg.sender), "LOAN_OVERDUE");
        require(amount <= maxBorrowable(msg.sender), "LTV_EXCEEDED");

        if (storedDebt(msg.sender) == 0) {
            p.dueTimestamp = block.timestamp + loanDuration;
            p.overduePenaltyApplied = false;
        }

        p.principalAmount += amount;
        totalDebt += amount;
        stableToken.safeTransfer(msg.sender, amount);

        emit Borrowed(msg.sender, amount);
    }

    /// @notice Repay debt.
    function repay(uint256 amount) external whenNotPaused nonReentrant {
        require(amount > 0, "AMOUNT_ZERO");
        _accrueUserInterest(msg.sender);

        Position storage p = positions[msg.sender];
        uint256 currentDebt = storedDebt(msg.sender);
        require(currentDebt >= amount, "REPAY_TOO_MUCH");

        stableToken.safeTransferFrom(msg.sender, address(this), amount);
        _applyRepayment(p, amount);
        totalDebt -= amount;

        if (_positionDebt(p) == 0) {
            p.dueTimestamp = 0;
            p.overduePenaltyApplied = false;
        }

        emit Repaid(msg.sender, amount);
    }

    /// @notice Repay the full current debt amount after accruing interest.
    function repayAll() external whenNotPaused nonReentrant returns (uint256 amountRepaid) {
        _accrueUserInterest(msg.sender);

        Position storage p = positions[msg.sender];
        amountRepaid = _positionDebt(p);
        require(amountRepaid > 0, "NO_DEBT");

        stableToken.safeTransferFrom(msg.sender, address(this), amountRepaid);
        p.principalAmount = 0;
        p.accruedInterestAmount = 0;
        p.penaltyAmount = 0;
        totalDebt -= amountRepaid;
        p.dueTimestamp = 0;
        p.overduePenaltyApplied = false;

        emit Repaid(msg.sender, amountRepaid);
    }

    /// @notice Repay as much debt as possible using the caller's current stable balance.
    /// @dev This avoids UI-side "max" dust caused by debt changing between preview and transaction execution.
    function repayAvailable() external whenNotPaused nonReentrant returns (uint256 amountRepaid) {
        _accrueUserInterest(msg.sender);

        Position storage p = positions[msg.sender];
        uint256 currentDebt = _positionDebt(p);
        require(currentDebt > 0, "NO_DEBT");

        uint256 walletStable = stableToken.balanceOf(msg.sender);
        amountRepaid = _min(currentDebt, walletStable);
        require(amountRepaid > 0, "NO_STABLE_BALANCE");

        stableToken.safeTransferFrom(msg.sender, address(this), amountRepaid);
        _applyRepayment(p, amountRepaid);
        totalDebt -= amountRepaid;

        if (_positionDebt(p) == 0) {
            p.dueTimestamp = 0;
            p.overduePenaltyApplied = false;
        }

        emit Repaid(msg.sender, amountRepaid);
    }

    /// @notice Sell a portion of collateral on the same chain and use received stable to repay debt.
    /// @dev This models a product-style "repay with collateral" periphery flow without cross-chain shortcuts.
    function repayWithCollateral(uint256 collateralAmount, uint256 minStableOut)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 stableReceived, uint256 debtRepaid, uint256 stableRefunded)
    {
        require(collateralAmount > 0, "AMOUNT_ZERO");
        require(address(swapRouter) != address(0), "SWAP_ROUTER_ZERO");
        _accrueUserInterest(msg.sender);

        Position storage p = positions[msg.sender];
        uint256 currentDebt = _positionDebt(p);
        require(currentDebt > 0, "NO_DEBT");
        require(p.collateralAmount >= collateralAmount, "INSUFFICIENT_COLLATERAL");

        p.collateralAmount -= collateralAmount;
        IERC20(address(collateralToken)).forceApprove(address(swapRouter), 0);
        IERC20(address(collateralToken)).forceApprove(address(swapRouter), collateralAmount);

        stableReceived = swapRouter.swapExactIn(address(collateralToken), address(stableToken), collateralAmount, address(this));
        require(stableReceived >= minStableOut, "SLIPPAGE");

        debtRepaid = _min(stableReceived, currentDebt);
        _applyRepayment(p, debtRepaid);
        totalDebt -= debtRepaid;

        if (_positionDebt(p) == 0) {
            p.dueTimestamp = 0;
            p.overduePenaltyApplied = false;
        }

        stableRefunded = stableReceived - debtRepaid;
        if (stableRefunded > 0) {
            stableToken.safeTransfer(msg.sender, stableRefunded);
        }

        emit RepaidWithCollateral(msg.sender, collateralAmount, stableReceived, debtRepaid, stableRefunded);
    }

    /// @notice Apply one-time overdue penalty to user debt.
    function applyOverduePenalty(address user) external whenNotPaused nonReentrant {
        _accrueUserInterest(user);
        Position storage p = positions[user];

        uint256 currentDebt = _positionDebt(p);
        require(currentDebt > 0, "NO_DEBT");
        require(isOverdue(user), "NOT_OVERDUE");
        require(!p.overduePenaltyApplied, "PENALTY_APPLIED");

        uint256 penaltyAmount = (currentDebt * overduePenaltyBps) / BPS;
        p.penaltyAmount += penaltyAmount;
        totalDebt += penaltyAmount;
        p.overduePenaltyApplied = true;

        emit OverduePenaltyApplied(user, penaltyAmount, _positionDebt(p));
    }

    /// @notice Liquidate user debt by repaying and seizing collateral.
    /// @param user Borrower.
    /// @param requestedRepayAmount Requested repay amount by liquidator.
    function liquidate(address user, uint256 requestedRepayAmount) public whenNotPaused nonReentrant {
        require(requestedRepayAmount > 0, "AMOUNT_ZERO");
        _accrueUserInterest(user);

        Position storage p = positions[user];
        uint256 currentDebt = _positionDebt(p);
        require(currentDebt > 0, "NO_DEBT");

        bool overdue = isOverdue(user);
        bool undercollateralized = healthFactorBps(user) < BPS;
        require(overdue || undercollateralized, "NOT_LIQUIDATABLE");

        if (overdue && !p.overduePenaltyApplied) {
            uint256 autoPenaltyAmount = (currentDebt * overduePenaltyBps) / BPS;
            p.penaltyAmount += autoPenaltyAmount;
            totalDebt += autoPenaltyAmount;
            p.overduePenaltyApplied = true;
            currentDebt += autoPenaltyAmount;
            emit OverduePenaltyApplied(user, autoPenaltyAmount, currentDebt);
        }

        uint256 repayAmount;
        bool cappedByCollateralValue;
        uint256 seizeCollateral;
        {
            uint256 maxRepay = overdue ? currentDebt : (currentDebt * closeFactorBps) / BPS;
            if (maxRepay == 0) {
                maxRepay = currentDebt;
            }

            repayAmount = _min(requestedRepayAmount, _min(currentDebt, maxRepay));
        }
        require(repayAmount > 0, "NOTHING_TO_LIQUIDATE");

        {
            uint256 stablePrice = priceOracle.getPrice(address(stableToken));
            uint256 collateralPrice = priceOracle.getPrice(address(collateralToken));
            uint256 collateralUsd = (p.collateralAmount * collateralPrice) / ORACLE_DECIMALS;
            uint256 maxRepayValueUsd = (collateralUsd * BPS) / (BPS + liquidationBonusBps);
            uint256 maxRepayByCollateral = (maxRepayValueUsd * ORACLE_DECIMALS) / stablePrice;

            cappedByCollateralValue = repayAmount > maxRepayByCollateral;
            repayAmount = _min(repayAmount, maxRepayByCollateral);
            require(repayAmount > 0, "INSUFFICIENT_COLLATERAL_VALUE");

            uint256 repayUsd = (repayAmount * stablePrice) / ORACLE_DECIMALS;
            uint256 seizeUsd = (repayUsd * (BPS + liquidationBonusBps)) / BPS;
            seizeCollateral = _ceilDiv(seizeUsd * ORACLE_DECIMALS, collateralPrice);
        }
        require(repayAmount > 0, "INSUFFICIENT_COLLATERAL_VALUE");

        if (cappedByCollateralValue || seizeCollateral > p.collateralAmount) {
            seizeCollateral = p.collateralAmount;
        }

        stableToken.safeTransferFrom(msg.sender, address(this), repayAmount);
        _applyRepayment(p, repayAmount);
        totalDebt -= repayAmount;

        p.collateralAmount -= seizeCollateral;
        collateralToken.safeTransfer(msg.sender, seizeCollateral);

        if (_positionDebt(p) == 0) {
            p.dueTimestamp = 0;
            p.overduePenaltyApplied = false;
        }

        emit Liquidated(user, msg.sender, repayAmount, seizeCollateral, overdue);
    }

    /// @notice Write off residual bad debt after all collateral has been exhausted.
    /// @dev Thesis-oriented insolvency escape hatch so zero-collateral toxic positions do not remain forever.
    function writeOffBadDebt(address user) external onlyRole(RISK_ADMIN_ROLE) whenNotPaused nonReentrant returns (uint256 writtenOff) {
        Position storage p = positions[user];
        require(p.collateralAmount == 0, "COLLATERAL_REMAINING");
        writtenOff = _positionDebt(p);
        require(writtenOff > 0, "NO_BAD_DEBT");

        p.principalAmount = 0;
        p.accruedInterestAmount = 0;
        p.penaltyAmount = 0;
        p.dueTimestamp = 0;
        p.overduePenaltyApplied = false;
        totalDebt -= writtenOff;
        totalWrittenOffDebt += writtenOff;

        emit BadDebtWrittenOff(user, writtenOff, totalWrittenOffDebt);
    }

    function _accrueUserInterest(address user) internal returns (uint256 interestAmount) {
        Position storage p = positions[user];
        uint256 principalOutstanding = p.principalAmount;
        if (principalOutstanding == 0) {
            lastInterestTimestamp[user] = block.timestamp;
            return 0;
        }

        uint256 lastTs = lastInterestTimestamp[user];
        if (lastTs == 0 || block.timestamp <= lastTs) {
            lastInterestTimestamp[user] = block.timestamp;
            return 0;
        }

        uint256 elapsed = block.timestamp - lastTs;
        uint256 rate = borrowRateBps();
        interestAmount = (principalOutstanding * rate * elapsed) / (BPS * YEAR);

        if (interestAmount > 0) {
            p.accruedInterestAmount += interestAmount;
            totalDebt += interestAmount;
            emit InterestAccrued(user, interestAmount, _positionDebt(p), rate, elapsed);
        }

        lastInterestTimestamp[user] = block.timestamp;
    }

    function _applyRepayment(Position storage p, uint256 amount) internal {
        if (amount == 0) return;

        uint256 remaining = amount;

        if (p.penaltyAmount > 0) {
            uint256 appliedToPenalty = _min(remaining, p.penaltyAmount);
            p.penaltyAmount -= appliedToPenalty;
            remaining -= appliedToPenalty;
        }

        if (remaining > 0 && p.accruedInterestAmount > 0) {
            uint256 appliedToInterest = _min(remaining, p.accruedInterestAmount);
            p.accruedInterestAmount -= appliedToInterest;
            remaining -= appliedToInterest;
        }

        if (remaining > 0 && p.principalAmount > 0) {
            uint256 appliedToPrincipal = _min(remaining, p.principalAmount);
            p.principalAmount -= appliedToPrincipal;
        }
    }

    function _positionDebt(Position storage p) internal view returns (uint256) {
        return p.principalAmount + p.accruedInterestAmount + p.penaltyAmount;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : ((a - 1) / b) + 1;
    }
}
