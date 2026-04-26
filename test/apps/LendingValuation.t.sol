// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BankToken} from "../../contracts/apps/BankToken.sol";
import {BankPolicyEngine} from "../../contracts/apps/BankPolicyEngine.sol";
import {ManualAssetOracle} from "../../contracts/apps/ManualAssetOracle.sol";
import {PolicyControlledVoucherToken} from "../../contracts/apps/PolicyControlledVoucherToken.sol";
import {PolicyControlledLendingPool} from "../../contracts/apps/PolicyControlledLendingPool.sol";

contract LendingValuationTest is Test {
    uint256 internal constant SOURCE_CHAIN_A = 41001;
    uint256 internal constant COLLATERAL_FACTOR_BPS = 7_000;
    uint256 internal constant LIQUIDATION_THRESHOLD_BPS = 8_000;

    address internal alice = address(0xA11CE);
    address internal supplier = address(0x5151);
    address internal liquidator = address(0x119D8);
    bytes32 internal constant PACKET_ONE = bytes32(uint256(1));

    BankPolicyEngine internal policy;
    ManualAssetOracle internal oracle;
    PolicyControlledVoucherToken internal voucher;
    PolicyControlledLendingPool internal lendingPool;
    BankToken internal canonicalAsset;
    BankToken internal debtAsset;

    function setUp() public {
        policy = new BankPolicyEngine(address(this));
        oracle = new ManualAssetOracle(address(this));

        canonicalAsset = new BankToken("Canonical", "CAN");
        debtAsset = new BankToken("Debt", "DEBT");
        voucher = new PolicyControlledVoucherToken(address(this), address(policy), "Voucher", "vCAN");
        lendingPool = new PolicyControlledLendingPool(
            address(this),
            address(voucher),
            address(debtAsset),
            address(policy),
            COLLATERAL_FACTOR_BPS,
            LIQUIDATION_THRESHOLD_BPS
        );

        voucher.grantApp(address(this));
        voucher.bindCanonicalAsset(address(canonicalAsset));
        policy.grantRole(policy.POLICY_APP_ROLE(), address(voucher));
        policy.grantRole(policy.POLICY_APP_ROLE(), address(lendingPool));

        policy.setAccountAllowed(alice, true);
        policy.setSourceChainAllowed(SOURCE_CHAIN_A, true);
        policy.setMintAssetAllowed(address(canonicalAsset), true);
        policy.setCollateralAssetAllowed(address(voucher), true);
        policy.setDebtAssetAllowed(address(debtAsset), true);
        policy.setAccountBorrowCap(alice, 500 ether);
        policy.setDebtAssetBorrowCap(address(debtAsset), 1_000 ether);

        oracle.setPrice(address(voucher), 1 ether);
        oracle.setPrice(address(debtAsset), 1 ether);
        lendingPool.setValuationOracle(address(oracle));

        voucher.mintWithPolicy(alice, address(canonicalAsset), SOURCE_CHAIN_A, 1_000 ether, PACKET_ONE);
        _seedLiquidity(1_000 ether);
    }

    function testMissingOracleAndMissingPriceRevert() public {
        PolicyControlledLendingPool unpricedPool =
            new PolicyControlledLendingPool(
                address(this),
                address(voucher),
                address(debtAsset),
                address(policy),
                COLLATERAL_FACTOR_BPS,
                LIQUIDATION_THRESHOLD_BPS
            );

        vm.expectRevert(bytes("ORACLE_NOT_SET"));
        unpricedPool.maxBorrow(alice);

        ManualAssetOracle missingDebtPrice = new ManualAssetOracle(address(this));
        missingDebtPrice.setPrice(address(voucher), 1 ether);
        lendingPool.setValuationOracle(address(missingDebtPrice));

        vm.expectRevert(bytes("PRICE_NOT_SET"));
        lendingPool.maxBorrow(alice);
    }

    function testStalePriceRevertsAndFreshPriceWorks() public {
        oracle.setMaxStaleness(1);
        assertEq(lendingPool.maxBorrow(alice), 0);

        vm.warp(block.timestamp + 2);
        vm.expectRevert(bytes("PRICE_STALE"));
        lendingPool.maxBorrow(alice);

        oracle.setPrice(address(voucher), 1 ether);
        oracle.setPrice(address(debtAsset), 1 ether);
        assertEq(lendingPool.maxBorrow(alice), 0);
    }

    function testRiskParametersSeparateBorrowLimitFromLiquidationThreshold() public {
        assertEq(lendingPool.collateralFactorBps(), COLLATERAL_FACTOR_BPS);
        assertEq(lendingPool.liquidationThresholdBps(), LIQUIDATION_THRESHOLD_BPS);

        vm.expectRevert(bytes("THRESHOLD_LT_FACTOR"));
        lendingPool.setLiquidationThresholdBps(COLLATERAL_FACTOR_BPS - 1);

        vm.expectRevert(bytes("THRESHOLD_LT_FACTOR"));
        lendingPool.setCollateralFactor(LIQUIDATION_THRESHOLD_BPS + 1);

        vm.expectRevert(bytes("BAD_LIQUIDATION_THRESHOLD"));
        lendingPool.setLiquidationThresholdBps(10_001);
    }

    function testOracleAndHaircutAdjustBorrowCeiling() public {
        oracle.setPrice(address(voucher), 2 ether);
        oracle.setPrice(address(debtAsset), 1 ether);
        lendingPool.setCollateralHaircut(9_000);

        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 100 ether);
        lendingPool.depositCollateral(100 ether);
        vm.stopPrank();

        assertEq(lendingPool.collateralValue(alice), 180 ether);
        assertEq(lendingPool.maxBorrow(alice), 126 ether);
        assertEq(lendingPool.liquidationThresholdValue(alice), 144 ether);
        assertEq(lendingPool.availableToBorrow(alice), 126 ether);

        vm.prank(alice);
        lendingPool.borrow(120 ether);

        assertEq(lendingPool.debtBalance(alice), 120 ether);
        assertEq(lendingPool.availableToBorrow(alice), 6 ether);
        assertEq(lendingPool.healthFactorBps(alice), 12_000);
        assertEq(lendingPool.healthFactorE18(alice), 1.2 ether);

        vm.expectRevert(bytes("BORROW_LIMIT"));
        vm.prank(alice);
        lendingPool.borrow(7 ether);
    }

    function testSupplierDepositsReceiveSharesAndCanRedeemWhenCashAvailable() public {
        assertEq(lendingPool.liquidityShares(supplier), 1_000 ether);
        assertEq(lendingPool.liquidityBalanceOf(supplier), 1_000 ether);
        assertEq(lendingPool.exchangeRateE18(), 1 ether);

        vm.prank(supplier);
        lendingPool.withdrawLiquidity(100 ether);

        assertEq(debtAsset.balanceOf(supplier), 100 ether);
        assertEq(lendingPool.liquidityBalanceOf(supplier), 900 ether);
    }

    function testBorrowerDebtAccruesSupplierExchangeRateRisesAndReservesAccumulate() public {
        lendingPool.setInterestRateModel(1_000, 8_000, 0, 0);

        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 200 ether);
        lendingPool.depositCollateral(200 ether);
        lendingPool.borrow(100 ether);
        vm.stopPrank();

        assertEq(lendingPool.debtBalance(alice), 100 ether);
        vm.warp(block.timestamp + 365 days);

        assertEq(lendingPool.currentBorrowRateBps(), 1_000);
        lendingPool.accrueInterest();

        assertEq(lendingPool.debtBalance(alice), 110 ether);
        assertEq(lendingPool.totalReserves(), 1 ether);
        assertGt(lendingPool.exchangeRateE18(), 1 ether);
        assertEq(policy.accountDebtOutstanding(alice, address(debtAsset)), 100 ether);
    }

    function testUtilizationChangesBorrowRate() public {
        lendingPool.setInterestRateModel(100, 8_000, 900, 5_000);
        assertEq(lendingPool.currentBorrowRateBps(), 100);

        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 500 ether);
        lendingPool.depositCollateral(500 ether);
        lendingPool.borrow(300 ether);
        vm.stopPrank();

        assertGt(lendingPool.utilizationRateBps(), 0);
        assertGt(lendingPool.currentBorrowRateBps(), 100);
    }

    function testSupplierRedeemBlockedWhenLiquidityIsBorrowedOut() public {
        policy.setAccountBorrowCap(alice, 900 ether);
        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 1_000 ether);
        lendingPool.depositCollateral(1_000 ether);
        lendingPool.borrow(700 ether);
        vm.stopPrank();

        vm.expectRevert(bytes("POOL_LIQUIDITY"));
        vm.prank(supplier);
        lendingPool.withdrawLiquidity(900 ether);
    }

    function testCollateralWithdrawalBlockedAfterAccruedDebtMakesPositionUnhealthy() public {
        lendingPool.setInterestRateModel(10_000, 8_000, 0, 0);

        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 100 ether);
        lendingPool.depositCollateral(100 ether);
        lendingPool.borrow(70 ether);
        vm.stopPrank();

        vm.warp(block.timestamp + 1 days);

        vm.expectRevert(bytes("POSITION_UNHEALTHY"));
        vm.prank(alice);
        lendingPool.withdrawCollateral(1 wei);
    }

    function testAuthorizedLiquidatorCanRepayDebtAndSeizeCollateralUsingAccruedDebt() public {
        lendingPool.grantRole(lendingPool.LIQUIDATOR_ROLE(), liquidator);

        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 100 ether);
        lendingPool.depositCollateral(100 ether);
        lendingPool.borrow(70 ether);
        vm.stopPrank();

        oracle.setPrice(address(voucher), 0.5 ether);
        oracle.setPrice(address(debtAsset), 1 ether);

        assertTrue(lendingPool.isLiquidatable(alice));
        assertEq(lendingPool.healthFactorBps(alice), 5_714);
        assertEq(lendingPool.maxLiquidationRepay(alice), 35 ether);
        PolicyControlledLendingPool.LiquidationPreview memory preview = lendingPool.previewLiquidation(alice, 40 ether);
        assertEq(preview.requestedRepayAmount, 40 ether);
        assertEq(preview.actualRepayAmount, 35 ether);
        assertEq(preview.seizedCollateral, 73.5 ether);
        assertEq(preview.remainingDebt, 35 ether);
        assertEq(preview.remainingCollateral, 26.5 ether);
        assertEq(preview.badDebt, 0);
        assertTrue(preview.executable);

        debtAsset.mint(liquidator, 35 ether);
        vm.startPrank(liquidator);
        debtAsset.approve(address(lendingPool), 35 ether);
        lendingPool.liquidate(alice, 40 ether);
        vm.stopPrank();

        assertEq(lendingPool.debtBalance(alice), 35 ether);
        assertEq(lendingPool.collateralBalance(alice), 26.5 ether);
        assertEq(policy.debtAssetOutstanding(address(debtAsset)), 35 ether);
        assertEq(policy.accountDebtOutstanding(alice, address(debtAsset)), 35 ether);
        assertEq(policy.collateralOutstanding(address(voucher)), 26.5 ether);
        assertEq(voucher.balanceOf(liquidator), 73.5 ether);
    }

    function testHealthFactorDropsAfterOracleShockAndPreviewMatchesCloseFactor() public {
        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 100 ether);
        lendingPool.depositCollateral(100 ether);
        lendingPool.borrow(60 ether);
        vm.stopPrank();

        assertEq(lendingPool.healthFactorBps(alice), 13_333);
        assertFalse(lendingPool.isLiquidatable(alice));

        oracle.setPrice(address(voucher), 0.5 ether);
        oracle.setPrice(address(debtAsset), 1 ether);

        assertEq(lendingPool.healthFactorBps(alice), 6_666);
        assertTrue(lendingPool.isLiquidatable(alice));
        assertEq(lendingPool.maxLiquidationRepay(alice), 30 ether);
        PolicyControlledLendingPool.LiquidationPreview memory preview = lendingPool.previewLiquidation(alice, 30 ether);
        assertEq(preview.requestedRepayAmount, 30 ether);
        assertEq(preview.actualRepayAmount, 30 ether);
        assertEq(preview.seizedCollateral, 63 ether);
        assertEq(preview.remainingDebt, 30 ether);
        assertEq(preview.remainingCollateral, 37 ether);
        assertEq(preview.badDebt, 0);
        assertEq(preview.healthFactorBefore, 0.666666666666666666 ether);
        assertEq(preview.healthFactorAfter, 0.493333333333333333 ether);
        assertTrue(preview.executable);
    }

    function testFullLiquidationCanClearDebtWithoutBadDebt() public {
        lendingPool.grantRole(lendingPool.LIQUIDATOR_ROLE(), liquidator);
        lendingPool.setLiquidationConfig(10_000, 500);

        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 100 ether);
        lendingPool.depositCollateral(100 ether);
        lendingPool.borrow(60 ether);
        vm.stopPrank();

        oracle.setPrice(address(voucher), 0.5 ether);
        oracle.setPrice(address(debtAsset), 1 ether);

        PolicyControlledLendingPool.LiquidationPreview memory preview = lendingPool.previewLiquidation(alice, 100 ether);
        assertEq(preview.actualRepayAmount, 60 ether);
        assertEq(preview.seizedCollateral, 100 ether);
        assertEq(preview.remainingDebt, 0);
        assertEq(preview.remainingCollateral, 0);
        assertEq(preview.badDebt, 0);
        assertTrue(preview.executable);

        debtAsset.mint(liquidator, 60 ether);
        vm.startPrank(liquidator);
        debtAsset.approve(address(lendingPool), 60 ether);
        lendingPool.liquidate(alice, 100 ether);
        vm.stopPrank();

        assertEq(lendingPool.debtBalance(alice), 0);
        assertEq(lendingPool.collateralBalance(alice), 0);
        assertEq(lendingPool.totalBadDebt(), 0);
    }

    function testStaleOracleBlocksLiquidationAndPreview() public {
        lendingPool.grantRole(lendingPool.LIQUIDATOR_ROLE(), liquidator);
        oracle.setMaxStaleness(1);

        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 100 ether);
        lendingPool.depositCollateral(100 ether);
        lendingPool.borrow(60 ether);
        vm.stopPrank();

        vm.warp(block.timestamp + 2);
        debtAsset.mint(liquidator, 30 ether);
        vm.startPrank(liquidator);
        debtAsset.approve(address(lendingPool), 30 ether);
        vm.expectRevert(bytes("PRICE_STALE"));
        lendingPool.liquidate(alice, 30 ether);
        vm.stopPrank();

        vm.expectRevert(bytes("PRICE_STALE"));
        lendingPool.previewLiquidation(alice, 30 ether);
    }

    function testLiquidationRecognizesBadDebtWhenCollateralIsExhausted() public {
        lendingPool.grantRole(lendingPool.LIQUIDATOR_ROLE(), liquidator);

        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 100 ether);
        lendingPool.depositCollateral(100 ether);
        lendingPool.borrow(70 ether);
        vm.stopPrank();

        oracle.setPrice(address(voucher), 0.01 ether);
        oracle.setPrice(address(debtAsset), 1 ether);

        PolicyControlledLendingPool.LiquidationPreview memory preview = lendingPool.previewLiquidation(alice, 100 ether);
        assertEq(preview.actualRepayAmount, 35 ether);
        assertEq(preview.seizedCollateral, 100 ether);
        assertEq(preview.remainingDebt, 0);
        assertEq(preview.badDebt, 35 ether);

        debtAsset.mint(liquidator, 35 ether);
        vm.startPrank(liquidator);
        debtAsset.approve(address(lendingPool), 35 ether);
        lendingPool.liquidate(alice, 100 ether);
        vm.stopPrank();

        assertEq(lendingPool.collateralBalance(alice), 0);
        assertEq(lendingPool.debtBalance(alice), 0);
        assertEq(lendingPool.totalBadDebt(), 35 ether);
        assertEq(policy.accountDebtOutstanding(alice, address(debtAsset)), 0);
        assertEq(voucher.balanceOf(liquidator), 100 ether);
    }

    function testLiquidationUsesReservesBeforeRecordingSupplierLoss() public {
        lendingPool.grantRole(lendingPool.LIQUIDATOR_ROLE(), liquidator);
        lendingPool.setInterestRateModel(10_000, 8_000, 0, 0);

        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 100 ether);
        lendingPool.depositCollateral(100 ether);
        lendingPool.borrow(70 ether);
        vm.stopPrank();

        vm.warp(block.timestamp + 365 days);
        lendingPool.accrueInterest();
        assertEq(lendingPool.debtBalance(alice), 140 ether);
        assertEq(lendingPool.totalReserves(), 7 ether);

        oracle.setPrice(address(voucher), 0.01 ether);
        oracle.setPrice(address(debtAsset), 1 ether);

        debtAsset.mint(liquidator, 70 ether);
        vm.startPrank(liquidator);
        debtAsset.approve(address(lendingPool), 70 ether);
        lendingPool.liquidate(alice, 140 ether);
        vm.stopPrank();

        assertEq(lendingPool.collateralBalance(alice), 0);
        assertEq(lendingPool.debtBalance(alice), 0);
        assertEq(lendingPool.totalReserves(), 0);
        assertEq(lendingPool.totalBadDebt(), 63 ether);
    }

    function testLiquidationRejectsHealthyPositionUnauthorizedCallerAndCapsCloseFactorExcess() public {
        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 100 ether);
        lendingPool.depositCollateral(100 ether);
        lendingPool.borrow(40 ether);
        vm.stopPrank();

        debtAsset.mint(liquidator, 50 ether);
        vm.startPrank(liquidator);
        debtAsset.approve(address(lendingPool), 50 ether);
        vm.expectRevert();
        lendingPool.liquidate(alice, 20 ether);
        vm.stopPrank();

        lendingPool.grantRole(lendingPool.LIQUIDATOR_ROLE(), liquidator);
        vm.startPrank(liquidator);
        vm.expectRevert(bytes("POSITION_HEALTHY"));
        lendingPool.liquidate(alice, 20 ether);
        vm.stopPrank();

        oracle.setPrice(address(voucher), 0.4 ether);
        oracle.setPrice(address(debtAsset), 1 ether);

        vm.startPrank(liquidator);
        lendingPool.liquidate(alice, 21 ether);
        vm.stopPrank();

        assertEq(lendingPool.debtBalance(alice), 20 ether);
        assertEq(lendingPool.collateralBalance(alice), 47.5 ether);
    }

    function testPausedPoolRejectsCriticalActions() public {
        lendingPool.pause();

        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 10 ether);
        vm.expectRevert();
        lendingPool.depositCollateral(10 ether);
        vm.expectRevert();
        lendingPool.borrow(1 ether);
        vm.stopPrank();

        debtAsset.mint(supplier, 10 ether);
        vm.startPrank(supplier);
        debtAsset.approve(address(lendingPool), 10 ether);
        vm.expectRevert();
        lendingPool.depositLiquidity(10 ether);
        vm.stopPrank();
    }

    function _seedLiquidity(uint256 amount) internal {
        debtAsset.mint(supplier, amount);
        vm.startPrank(supplier);
        debtAsset.approve(address(lendingPool), amount);
        lendingPool.depositLiquidity(amount);
        vm.stopPrank();
    }
}
