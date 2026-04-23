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
        lendingPool =
            new PolicyControlledLendingPool(address(this), address(voucher), address(debtAsset), address(policy), 8_000);

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
            new PolicyControlledLendingPool(address(this), address(voucher), address(debtAsset), address(policy), 8_000);

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

    function testOracleAndHaircutAdjustBorrowCeiling() public {
        oracle.setPrice(address(voucher), 2 ether);
        oracle.setPrice(address(debtAsset), 1 ether);
        lendingPool.setCollateralHaircut(9_000);

        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 100 ether);
        lendingPool.depositCollateral(100 ether);
        vm.stopPrank();

        assertEq(lendingPool.collateralValue(alice), 180 ether);
        assertEq(lendingPool.maxBorrow(alice), 144 ether);
        assertEq(lendingPool.availableToBorrow(alice), 144 ether);

        vm.prank(alice);
        lendingPool.borrow(140 ether);

        assertEq(lendingPool.debtBalance(alice), 140 ether);
        assertEq(lendingPool.availableToBorrow(alice), 4 ether);
        assertEq(lendingPool.healthFactorBps(alice), 10_285);

        vm.expectRevert(bytes("BORROW_LIMIT"));
        vm.prank(alice);
        lendingPool.borrow(5 ether);
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
        lendingPool.borrow(800 ether);
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
        lendingPool.borrow(80 ether);
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
        lendingPool.borrow(80 ether);
        vm.stopPrank();

        oracle.setPrice(address(voucher), 0.5 ether);
        oracle.setPrice(address(debtAsset), 1 ether);

        assertTrue(lendingPool.isLiquidatable(alice));
        assertEq(lendingPool.healthFactorBps(alice), 5_000);
        assertEq(lendingPool.maxLiquidationRepay(alice), 40 ether);
        assertEq(lendingPool.previewLiquidation(alice, 40 ether), 84 ether);

        debtAsset.mint(liquidator, 40 ether);
        vm.startPrank(liquidator);
        debtAsset.approve(address(lendingPool), 40 ether);
        lendingPool.liquidate(alice, 40 ether);
        vm.stopPrank();

        assertEq(lendingPool.debtBalance(alice), 40 ether);
        assertEq(lendingPool.collateralBalance(alice), 16 ether);
        assertEq(policy.debtAssetOutstanding(address(debtAsset)), 40 ether);
        assertEq(policy.accountDebtOutstanding(alice, address(debtAsset)), 40 ether);
        assertEq(policy.collateralOutstanding(address(voucher)), 16 ether);
        assertEq(voucher.balanceOf(liquidator), 84 ether);
    }

    function testLiquidationRecognizesBadDebtWhenCollateralIsExhausted() public {
        lendingPool.grantRole(lendingPool.LIQUIDATOR_ROLE(), liquidator);

        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 100 ether);
        lendingPool.depositCollateral(100 ether);
        lendingPool.borrow(80 ether);
        vm.stopPrank();

        oracle.setPrice(address(voucher), 0.01 ether);
        oracle.setPrice(address(debtAsset), 1 ether);

        debtAsset.mint(liquidator, 40 ether);
        vm.startPrank(liquidator);
        debtAsset.approve(address(lendingPool), 40 ether);
        lendingPool.liquidate(alice, 40 ether);
        vm.stopPrank();

        assertEq(lendingPool.collateralBalance(alice), 0);
        assertEq(lendingPool.debtBalance(alice), 0);
        assertEq(lendingPool.totalBadDebt(), 40 ether);
        assertEq(policy.accountDebtOutstanding(alice, address(debtAsset)), 0);
        assertEq(voucher.balanceOf(liquidator), 100 ether);
    }

    function testLiquidationRejectsHealthyPositionUnauthorizedCallerAndCloseFactorExcess() public {
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
        vm.expectRevert(bytes("LIQUIDATION_CLOSE_FACTOR"));
        lendingPool.liquidate(alice, 21 ether);
        vm.stopPrank();
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
