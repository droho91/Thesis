// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {LendingPool} from "../contracts/LendingPool.sol";
import {StableToken} from "../contracts/StableToken.sol";
import {WrappedCollateral} from "../contracts/WrappedCollateral.sol";
import {MockPriceOracle} from "../contracts/MockPriceOracle.sol";
import {MockSwapRouter} from "../contracts/MockSwapRouter.sol";

contract LendingPoolTest is Test {
    WrappedCollateral internal wrapped;
    StableToken internal stable;
    MockPriceOracle internal oracle;
    MockSwapRouter internal router;
    LendingPool internal pool;

    address internal bridge = address(0xBEEF);
    address internal user = address(0x5555);
    address internal liquidator = address(0x7777);

    function setUp() public {
        wrapped = new WrappedCollateral("Wrapped Collateral", "wCOL", bridge);
        stable = new StableToken("Stable USD", "sUSD");
        oracle = new MockPriceOracle();

        // 1 USD for both tokens (8 decimals) for simple math in tests.
        oracle.setPrice(address(wrapped), 1e8);
        oracle.setPrice(address(stable), 1e8);

        pool = new LendingPool(address(wrapped), address(stable), address(oracle), 5_000);
        router = new MockSwapRouter(address(oracle), 0);
        pool.setSwapRouter(address(router));

        // Give pool liquidity and user collateral.
        stable.mint(address(pool), 1_000 ether);
        stable.mint(address(router), 1_000 ether);
        vm.prank(bridge);
        wrapped.mintFromLockEvent(user, 200 ether, keccak256("LOCK_EVENT_INIT"));

        vm.prank(user);
        wrapped.approve(address(pool), type(uint256).max);
        vm.prank(user);
        stable.approve(address(pool), type(uint256).max);

        stable.mint(liquidator, 1_000 ether);
        vm.prank(liquidator);
        stable.approve(address(pool), type(uint256).max);
    }

    function testDepositAndBorrowWithinLtv() public {
        vm.startPrank(user);
        pool.depositCollateral(100 ether);
        pool.borrow(40 ether);
        vm.stopPrank();

        (uint256 collateralAmount, uint256 principalAmount,,,,) = pool.positions(user);
        assertEq(collateralAmount, 100 ether);
        assertEq(principalAmount, 40 ether);
        assertEq(stable.balanceOf(user), 40 ether);
    }

    function testBorrowRevertsIfLtvExceeded() public {
        vm.prank(user);
        pool.depositCollateral(100 ether);

        vm.expectRevert(bytes("LTV_EXCEEDED"));
        vm.prank(user);
        pool.borrow(60 ether);
    }

    function testWithdrawRevertsIfItBreaksLtv() public {
        vm.startPrank(user);
        pool.depositCollateral(100 ether);
        pool.borrow(50 ether);
        vm.stopPrank();

        vm.expectRevert(bytes("LTV_EXCEEDED"));
        vm.prank(user);
        pool.withdrawCollateral(1 ether);
    }

    function testRepayThenWithdrawAllCollateral() public {
        vm.startPrank(user);
        pool.depositCollateral(100 ether);
        pool.borrow(50 ether);
        pool.repay(50 ether);
        pool.withdrawCollateral(100 ether);
        vm.stopPrank();

        (uint256 collateralAmount, uint256 principalAmount, uint256 interestAmount, uint256 penaltyAmount,,) = pool.positions(user);
        assertEq(collateralAmount, 0);
        assertEq(principalAmount, 0);
        assertEq(interestAmount, 0);
        assertEq(penaltyAmount, 0);
    }

    function testRepayAllClearsAccruedDebtAndAllowsFullWithdraw() public {
        vm.startPrank(user);
        pool.depositCollateral(100 ether);
        pool.borrow(40 ether);
        vm.stopPrank();

        vm.warp(block.timestamp + 30 days);
        stable.mint(user, 10 ether);

        vm.startPrank(user);
        uint256 debtBefore = pool.previewDebt(user);
        pool.repayAll();
        pool.withdrawCollateral(100 ether);
        vm.stopPrank();

        (uint256 collateralAmount, uint256 principalAmount, uint256 interestAmount, uint256 penaltyAmount, uint256 dueTimestamp, bool overduePenaltyApplied) = pool.positions(user);
        assertGt(debtBefore, 40 ether);
        assertEq(collateralAmount, 0);
        assertEq(principalAmount, 0);
        assertEq(interestAmount, 0);
        assertEq(penaltyAmount, 0);
        assertEq(dueTimestamp, 0);
        assertEq(overduePenaltyApplied, false);
    }

    function testRepayAvailableUsesCurrentWalletBalanceAndClearsDebtWhenSufficient() public {
        vm.startPrank(user);
        pool.depositCollateral(100 ether);
        pool.borrow(40 ether);
        vm.stopPrank();

        vm.warp(block.timestamp + 30 days);
        stable.mint(user, 10 ether);

        vm.prank(user);
        uint256 amountRepaid = pool.repayAvailable();

        (
            uint256 collateralAmount,
            uint256 principalAmount,
            uint256 interestAmount,
            uint256 penaltyAmount,
            uint256 dueTimestamp,
            bool overduePenaltyApplied
        ) = pool.positions(user);

        assertGt(amountRepaid, 40 ether);
        assertEq(collateralAmount, 100 ether);
        assertEq(principalAmount, 0);
        assertEq(interestAmount, 0);
        assertEq(penaltyAmount, 0);
        assertEq(dueTimestamp, 0);
        assertEq(overduePenaltyApplied, false);
    }

    function testRepayWithCollateralReducesDebtWithoutExternalStable() public {
        vm.startPrank(user);
        pool.depositCollateral(100 ether);
        pool.borrow(40 ether);
        pool.repayWithCollateral(10 ether, 10 ether);
        vm.stopPrank();

        (
            uint256 collateralAmount,
            uint256 principalAmount,
            uint256 interestAmount,
            uint256 penaltyAmount,,
        ) = pool.positions(user);

        assertEq(collateralAmount, 90 ether);
        assertEq(principalAmount, 30 ether);
        assertEq(interestAmount, 0);
        assertEq(penaltyAmount, 0);
    }

    function testRepayWithCollateralCanFullyClosePositionThenWithdrawRemainder() public {
        vm.startPrank(user);
        pool.depositCollateral(100 ether);
        pool.borrow(40 ether);
        pool.repayWithCollateral(40 ether, 40 ether);
        pool.withdrawCollateral(60 ether);
        vm.stopPrank();

        (
            uint256 collateralAmount,
            uint256 principalAmount,
            uint256 interestAmount,
            uint256 penaltyAmount,
            uint256 dueTimestamp,
            bool overduePenaltyApplied
        ) = pool.positions(user);

        assertEq(collateralAmount, 0);
        assertEq(principalAmount, 0);
        assertEq(interestAmount, 0);
        assertEq(penaltyAmount, 0);
        assertEq(dueTimestamp, 0);
        assertEq(overduePenaltyApplied, false);
    }

    function testWithdrawMaxUsesFreshStateAndWithdrawsAllWhenDebtIsZero() public {
        vm.startPrank(user);
        pool.depositCollateral(100 ether);
        pool.borrow(40 ether);
        vm.stopPrank();

        stable.mint(user, 10 ether);
        vm.warp(block.timestamp + 30 days);

        vm.startPrank(user);
        pool.repayAll();
        uint256 withdrawn = pool.withdrawMax();
        vm.stopPrank();

        (uint256 collateralAmount,,,,,) = pool.positions(user);
        assertEq(withdrawn, 100 ether);
        assertEq(collateralAmount, 0);
        assertEq(wrapped.balanceOf(user), 200 ether);
    }

    function testOwnerCanUpdateRiskAndInterestParams() public {
        pool.setCollateralFactorBps(4_500);
        pool.setLiquidationThresholdBps(7_500);
        pool.setCloseFactorBps(6_000);
        pool.setLoanDuration(12 hours);
        pool.setOverduePenaltyBps(300);
        pool.setLiquidationBonusBps(700);
        pool.setInterestModel(100, 500, 1500, 7000);

        assertEq(pool.collateralFactorBps(), 4_500);
        assertEq(pool.liquidationThresholdBps(), 7_500);
        assertEq(pool.closeFactorBps(), 6_000);
        assertEq(pool.loanDuration(), 12 hours);
        assertEq(pool.overduePenaltyBps(), 300);
        assertEq(pool.liquidationBonusBps(), 700);
        assertEq(pool.baseRateBps(), 100);
        assertEq(pool.slope1Bps(), 500);
        assertEq(pool.slope2Bps(), 1500);
        assertEq(pool.kinkBps(), 7000);
    }

    function testRiskUpdatesRevertForNonAdmin() public {
        vm.prank(user);
        vm.expectRevert();
        pool.setCollateralFactorBps(6_000);
    }

    function testAccrueInterestIncreasesDebt() public {
        vm.startPrank(user);
        pool.depositCollateral(100 ether);
        pool.borrow(40 ether);
        vm.stopPrank();

        uint256 debtBefore = pool.previewDebt(user);
        vm.warp(block.timestamp + 365 days);
        pool.accrueInterest(user);
        uint256 debtAfter = pool.previewDebt(user);

        assertGt(debtAfter, debtBefore);
    }

    function testInterestDoesNotCompoundOnPriorInterest() public {
        pool.setInterestModel(1_000, 0, 0, 8_000);

        vm.startPrank(user);
        pool.depositCollateral(100 ether);
        pool.borrow(40 ether);
        vm.stopPrank();

        vm.warp(block.timestamp + 365 days);
        pool.accrueInterest(user);
        (, , uint256 firstAccrued,,,) = pool.positions(user);

        vm.warp(block.timestamp + 365 days);
        pool.accrueInterest(user);
        (, , uint256 totalAccrued,,,) = pool.positions(user);

        assertEq(totalAccrued - firstAccrued, firstAccrued);
    }

    function testPenaltyDoesNotAccrueAdditionalInterest() public {
        pool.setInterestModel(1_000, 0, 0, 8_000);

        vm.startPrank(user);
        pool.depositCollateral(100 ether);
        pool.borrow(40 ether);
        vm.stopPrank();

        vm.warp(block.timestamp + pool.loanDuration() + 1);
        pool.applyOverduePenalty(user);

        (, uint256 principalBefore, uint256 interestBefore, uint256 penaltyBefore,,) = pool.positions(user);

        vm.warp(block.timestamp + 365 days);
        pool.accrueInterest(user);

        (, uint256 principalAfter, uint256 interestAfter, uint256 penaltyAfter,,) = pool.positions(user);
        uint256 expectedYearlyInterest = (principalBefore * 1_000) / pool.BPS();

        assertEq(principalAfter, principalBefore);
        assertEq(penaltyAfter, penaltyBefore);
        assertEq(interestAfter - interestBefore, expectedYearlyInterest);
    }

    function testUtilizationAndBorrowRateIncreaseAfterBorrow() public {
        uint256 utilBefore = pool.utilizationBps();
        uint256 rateBefore = pool.borrowRateBps();

        vm.startPrank(user);
        pool.depositCollateral(100 ether);
        pool.borrow(40 ether);
        vm.stopPrank();

        uint256 utilAfter = pool.utilizationBps();
        uint256 rateAfter = pool.borrowRateBps();

        assertGt(utilAfter, utilBefore);
        assertGt(rateAfter, rateBefore);
    }

    function testOverduePenaltyFlow() public {
        vm.startPrank(user);
        pool.depositCollateral(100 ether);
        pool.borrow(40 ether);
        vm.stopPrank();

        vm.warp(block.timestamp + pool.loanDuration() + 1);
        uint256 debtBeforePenalty = pool.previewDebt(user);
        pool.applyOverduePenalty(user);

        (, uint256 principalAmount, uint256 interestAmount, uint256 penaltyAmount,, bool overduePenaltyApplied) = pool.positions(user);
        uint256 expectedPenalty = (debtBeforePenalty * pool.overduePenaltyBps()) / pool.BPS();
        assertEq(principalAmount + interestAmount + penaltyAmount, debtBeforePenalty + expectedPenalty);
        assertEq(penaltyAmount, expectedPenalty);
        assertTrue(overduePenaltyApplied);
    }

    function testBorrowAndWithdrawRevertWhenOverdue() public {
        vm.startPrank(user);
        pool.depositCollateral(100 ether);
        pool.borrow(40 ether);
        vm.stopPrank();

        vm.warp(block.timestamp + pool.loanDuration() + 1);

        vm.expectRevert(bytes("LOAN_OVERDUE"));
        vm.prank(user);
        pool.borrow(1 ether);

        vm.expectRevert(bytes("LOAN_OVERDUE"));
        vm.prank(user);
        pool.withdrawCollateral(1 ether);
    }

    function testHealthFactorLiquidationWhenPriceDrops() public {
        vm.startPrank(user);
        pool.depositCollateral(100 ether);
        pool.borrow(50 ether);
        vm.stopPrank();

        // Drop collateral price by half -> health factor should fall below 1.
        oracle.setPrice(address(wrapped), 5e7);
        assertLt(pool.healthFactorBps(user), pool.BPS());

        uint256 liquidatorBefore = wrapped.balanceOf(liquidator);
        vm.prank(liquidator);
        pool.liquidate(user, 25 ether); // close factor path (not overdue)
        uint256 liquidatorAfter = wrapped.balanceOf(liquidator);

        assertGt(liquidatorAfter, liquidatorBefore);
    }

    function testLiquidateOverdueResetsDebtAndTransfersCollateral() public {
        vm.startPrank(user);
        pool.depositCollateral(100 ether);
        pool.borrow(40 ether);
        vm.stopPrank();

        vm.warp(block.timestamp + pool.loanDuration() + 1);

        uint256 liquidatorBefore = wrapped.balanceOf(liquidator);
        vm.prank(liquidator);
        pool.liquidate(user, type(uint256).max);
        uint256 liquidatorAfter = wrapped.balanceOf(liquidator);

        (uint256 collateralAmount, uint256 principalAmount, uint256 interestAmount, uint256 penaltyAmount, uint256 dueTimestamp, bool overduePenaltyApplied) = pool.positions(user);
        assertEq(principalAmount, 0);
        assertEq(interestAmount, 0);
        assertEq(penaltyAmount, 0);
        assertEq(dueTimestamp, 0);
        assertEq(overduePenaltyApplied, false);
        assertLt(collateralAmount, 100 ether);
        assertGt(liquidatorAfter, liquidatorBefore);
    }

    function testLiquidationRepayIsCappedByCollateralValue() public {
        pool.setCloseFactorBps(10_000);

        vm.startPrank(user);
        pool.depositCollateral(100 ether);
        pool.borrow(50 ether);
        vm.stopPrank();

        oracle.setPrice(address(wrapped), 2e7); // collateral value = 20 USD

        uint256 liquidatorStableBefore = stable.balanceOf(liquidator);
        vm.prank(liquidator);
        pool.liquidate(user, 50 ether);
        uint256 liquidatorStableAfter = stable.balanceOf(liquidator);

        (
            uint256 collateralAmount,
            uint256 principalAmount,
            uint256 interestAmount,
            uint256 penaltyAmount,,
        ) = pool.positions(user);

        uint256 repaid = liquidatorStableBefore - liquidatorStableAfter;
        uint256 collateralValueUsd = (100 ether * 2e7) / pool.ORACLE_DECIMALS();
        uint256 maxRepayValueUsd = (collateralValueUsd * pool.BPS()) / (pool.BPS() + pool.liquidationBonusBps());
        uint256 maxRepayByCollateral = (maxRepayValueUsd * pool.ORACLE_DECIMALS()) / 1e8;

        assertEq(collateralAmount, 0);
        assertLe(repaid, maxRepayByCollateral);
        assertGt(principalAmount + interestAmount + penaltyAmount, 0);
    }

    function testWriteOffBadDebtClearsResidualInsolventPosition() public {
        pool.setCloseFactorBps(10_000);

        vm.startPrank(user);
        pool.depositCollateral(100 ether);
        pool.borrow(50 ether);
        vm.stopPrank();

        oracle.setPrice(address(wrapped), 2e7);

        vm.prank(liquidator);
        pool.liquidate(user, 50 ether);

        uint256 debtBeforeWriteOff = pool.previewDebt(user);
        assertGt(debtBeforeWriteOff, 0);

        pool.writeOffBadDebt(user);

        (
            uint256 collateralAmount,
            uint256 principalAmount,
            uint256 interestAmount,
            uint256 penaltyAmount,
            uint256 dueTimestamp,
            bool overduePenaltyApplied
        ) = pool.positions(user);

        assertEq(collateralAmount, 0);
        assertEq(principalAmount, 0);
        assertEq(interestAmount, 0);
        assertEq(penaltyAmount, 0);
        assertEq(dueTimestamp, 0);
        assertEq(overduePenaltyApplied, false);
        assertEq(pool.previewDebt(user), 0);
        assertEq(pool.totalWrittenOffDebt(), debtBeforeWriteOff);
        assertEq(pool.grossDebtExposure(), debtBeforeWriteOff);
    }

    function testPauseBlocksBorrowAndUnpauseRestores() public {
        vm.prank(user);
        pool.depositCollateral(100 ether);

        pool.pause();

        vm.expectRevert();
        vm.prank(user);
        pool.borrow(1 ether);

        pool.unpause();

        vm.prank(user);
        pool.borrow(1 ether);
        (, uint256 principalAmount,,,,) = pool.positions(user);
        assertEq(principalAmount, 1 ether);
    }

    function testIsLiquidatableTrueWhenOverdue() public {
        vm.startPrank(user);
        pool.depositCollateral(100 ether);
        pool.borrow(10 ether);
        vm.stopPrank();

        vm.warp(block.timestamp + pool.loanDuration() + 1);
        assertTrue(pool.isOverdue(user));
        assertTrue(pool.isLiquidatable(user));
    }
}
