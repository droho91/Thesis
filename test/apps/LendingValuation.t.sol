// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {BankToken} from "../../contracts/apps/BankToken.sol";
import {BankPolicyEngine} from "../../contracts/apps/BankPolicyEngine.sol";
import {ManualAssetOracle} from "../../contracts/apps/ManualAssetOracle.sol";
import {PolicyControlledVoucherToken} from "../../contracts/apps/PolicyControlledVoucherToken.sol";
import {PolicyControlledLendingPool} from "../../contracts/apps/PolicyControlledLendingPool.sol";

contract ConfigurableDecimalsToken is ERC20 {
    uint8 private immutable _configuredDecimals;

    constructor(uint8 configuredDecimals) ERC20("Configured decimals", "DEC") {
        _configuredDecimals = configuredDecimals;
    }

    function decimals() public view override returns (uint8) {
        return _configuredDecimals;
    }
}

contract PolicyControlledLendingPoolHarness is PolicyControlledLendingPool {
    constructor(
        address admin,
        address collateralToken_,
        address debtToken_,
        address policyEngine_,
        uint256 collateralFactorBps_,
        uint256 liquidationThresholdBps_
    )
        PolicyControlledLendingPool(
            admin,
            collateralToken_,
            debtToken_,
            policyEngine_,
            collateralFactorBps_,
            liquidationThresholdBps_
        )
    {}

    function setDebtPosition(address borrower, uint256 shares, uint256 borrows, uint256 policyPrincipal) external {
        debtShares[borrower] = shares;
        totalDebtShares = shares;
        totalBorrows = borrows;
        originationPrincipalDebt[borrower] = policyPrincipal;
    }
}

contract LendingValuationTest is Test {
    uint256 internal constant SOURCE_CHAIN_A = 41001;
    uint256 internal constant COLLATERAL_FACTOR_BPS = 7_000;
    uint256 internal constant LIQUIDATION_THRESHOLD_BPS = 8_000;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal supplier = address(0x5151);
    address internal supplierTwo = address(0x5252);
    address internal liquidator = address(0x119D8);
    bytes32 internal constant PACKET_ONE = bytes32(uint256(1));
    bytes32 internal constant PACKET_TWO = bytes32(uint256(2));

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
        voucher.grantTransferOperator(address(lendingPool));
        voucher.bindCanonicalAsset(address(canonicalAsset));
        policy.grantRole(policy.POLICY_APP_ROLE(), address(voucher));
        policy.grantRole(policy.POLICY_APP_ROLE(), address(lendingPool));

        policy.setAccountAllowed(alice, true);
        policy.setAccountAllowed(bob, true);
        policy.setSourceChainAllowed(SOURCE_CHAIN_A, true);
        policy.setMintAssetAllowed(address(canonicalAsset), true);
        policy.setCollateralAssetAllowed(address(voucher), true);
        policy.setDebtAssetAllowed(address(debtAsset), true);
        policy.setAccountOriginationPrincipalCap(alice, 500 ether);
        policy.setAccountOriginationPrincipalCap(bob, 500 ether);
        policy.setDebtAssetOriginationPrincipalCap(address(debtAsset), 1_000 ether);

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

    function testValuationOracleMustBeAContract() public {
        vm.expectRevert(bytes("ORACLE_NOT_CONTRACT"));
        lendingPool.setValuationOracle(address(0x1234));
    }

    function testLendingPoolRejectsUnsupportedTokenDecimals() public {
        ConfigurableDecimalsToken sixDecimalToken = new ConfigurableDecimalsToken(6);

        vm.expectRevert(bytes("UNSUPPORTED_COLLATERAL_DECIMALS"));
        new PolicyControlledLendingPool(
            address(this),
            address(sixDecimalToken),
            address(debtAsset),
            address(policy),
            COLLATERAL_FACTOR_BPS,
            LIQUIDATION_THRESHOLD_BPS
        );

        vm.expectRevert(bytes("UNSUPPORTED_DEBT_DECIMALS"));
        new PolicyControlledLendingPool(
            address(this),
            address(voucher),
            address(sixDecimalToken),
            address(policy),
            COLLATERAL_FACTOR_BPS,
            LIQUIDATION_THRESHOLD_BPS
        );
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
        assertEq(policy.accountOriginationPrincipalOutstanding(alice), 100 ether);
    }

    function testDebtSharesRemainConsistentAfterMultipleBorrowRepayAndInterestAccrual() public {
        lendingPool.setInterestRateModel(1_000, 8_000, 0, 0);
        voucher.mintWithPolicy(bob, address(canonicalAsset), SOURCE_CHAIN_A, 500 ether, PACKET_TWO);

        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 200 ether);
        lendingPool.depositCollateral(200 ether);
        lendingPool.borrow(80 ether);
        vm.stopPrank();

        vm.startPrank(bob);
        voucher.approve(address(lendingPool), 200 ether);
        lendingPool.depositCollateral(200 ether);
        lendingPool.borrow(120 ether);
        vm.stopPrank();

        uint256 indexBefore = lendingPool.borrowIndexE18();
        vm.warp(block.timestamp + 180 days);
        lendingPool.accrueInterest();
        assertGt(lendingPool.borrowIndexE18(), indexBefore);
        assertEq(lendingPool.debtShares(alice) + lendingPool.debtShares(bob), lendingPool.totalDebtShares());
        assertApproxEqAbs(lendingPool.debtBalance(alice) + lendingPool.debtBalance(bob), lendingPool.totalDebt(), 1_000);

        debtAsset.mint(alice, 30 ether);
        vm.startPrank(alice);
        debtAsset.approve(address(lendingPool), 30 ether);
        lendingPool.repay(30 ether);
        vm.stopPrank();

        assertEq(lendingPool.debtShares(alice) + lendingPool.debtShares(bob), lendingPool.totalDebtShares());
        assertApproxEqAbs(lendingPool.debtBalance(alice) + lendingPool.debtBalance(bob), lendingPool.totalDebt(), 1_000);
    }

    function testSupplierSharesRepresentClaimsAfterInterestAccrualAndRepay() public {
        lendingPool.setInterestRateModel(1_000, 8_000, 0, 0);
        debtAsset.mint(supplierTwo, 1_000 ether);
        vm.startPrank(supplierTwo);
        debtAsset.approve(address(lendingPool), 1_000 ether);
        lendingPool.depositLiquidity(1_000 ether);
        vm.stopPrank();

        policy.setAccountOriginationPrincipalCap(alice, 900 ether);
        oracle.setPrice(address(voucher), 2 ether);
        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 1_000 ether);
        lendingPool.depositCollateral(1_000 ether);
        lendingPool.borrow(500 ether);
        vm.stopPrank();

        vm.warp(block.timestamp + 365 days);
        lendingPool.accrueInterest();
        assertGt(lendingPool.exchangeRateE18(), 1 ether);
        assertGt(lendingPool.liquidityBalanceOf(supplier), 1_000 ether);
        assertGt(lendingPool.liquidityBalanceOf(supplierTwo), 1_000 ether);

        uint256 debt = lendingPool.debtBalance(alice);
        debtAsset.mint(alice, debt);
        vm.startPrank(alice);
        debtAsset.approve(address(lendingPool), debt);
        lendingPool.repay(debt);
        vm.stopPrank();

        uint256 supplierBalanceBefore = debtAsset.balanceOf(supplier);
        uint256 supplierShares = lendingPool.liquidityShares(supplier);
        vm.prank(supplier);
        lendingPool.redeemLiquidity(supplierShares);
        assertGt(debtAsset.balanceOf(supplier) - supplierBalanceBefore, 1_000 ether);
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

    function testUtilizationRateModelMovesBelowAndAboveKink() public {
        lendingPool.setInterestRateModel(100, 8_000, 900, 5_000);
        policy.setAccountOriginationPrincipalCap(alice, 2_000 ether);
        oracle.setPrice(address(voucher), 2 ether);

        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 1_000 ether);
        lendingPool.depositCollateral(1_000 ether);
        lendingPool.borrow(400 ether);
        vm.stopPrank();

        assertEq(lendingPool.utilizationRateBps(), 4_000);
        assertEq(lendingPool.currentBorrowRateBps(), 550);

        vm.prank(alice);
        lendingPool.borrow(500 ether);

        assertEq(lendingPool.utilizationRateBps(), 9_000);
        assertEq(lendingPool.currentBorrowRateBps(), 3_500);
    }

    function testUtilizationRateExcludesReservesFromDenominator() public {
        lendingPool.setInterestRateModel(1_000, 8_000, 0, 0);
        policy.setAccountOriginationPrincipalCap(alice, 1_000 ether);
        oracle.setPrice(address(voucher), 2 ether);

        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 1_000 ether);
        lendingPool.depositCollateral(1_000 ether);
        lendingPool.borrow(800 ether);
        vm.stopPrank();

        assertEq(lendingPool.utilizationRateBps(), 8_000);

        vm.warp(block.timestamp + 365 days);
        lendingPool.accrueInterest();

        uint256 reserves = lendingPool.totalReserves();
        assertGt(reserves, 0, "reserves should accrue");

        uint256 totalBorrows = lendingPool.totalBorrows();
        uint256 availableCash = lendingPool.availableLiquidity();
        uint256 expectedUtilization = totalBorrows * 10_000 / (availableCash + totalBorrows);
        uint256 utilizationIfReservesWereIncluded = totalBorrows * 10_000 / (lendingPool.totalCash() + totalBorrows);

        assertEq(lendingPool.utilizationRateBps(), expectedUtilization);
        assertEq(lendingPool.accruedUtilizationRateBps(), expectedUtilization);
        assertGt(lendingPool.utilizationRateBps(), utilizationIfReservesWereIncluded);
    }

    function testInterestAccrualIsConsistentAcrossTimeSteps() public {
        lendingPool.setInterestRateModel(1_000, 8_000, 0, 0);
        policy.setAccountOriginationPrincipalCap(alice, 1_000 ether);
        oracle.setPrice(address(voucher), 2 ether);

        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 1_000 ether);
        lendingPool.depositCollateral(1_000 ether);
        lendingPool.borrow(500 ether);
        vm.stopPrank();

        uint256 debtBefore = lendingPool.debtOf(alice);
        uint256 indexBefore = lendingPool.borrowIndexE18();

        for (uint256 i = 0; i < 10; i++) {
            vm.warp(block.timestamp + 36 days);
            lendingPool.accrueInterest();
        }

        uint256 debtAfterSmallSteps = lendingPool.debtOf(alice);
        assertGt(debtAfterSmallSteps, debtBefore, "debt must grow with interest");
        assertGt(lendingPool.borrowIndexE18(), indexBefore, "borrow index must grow");
        assertGt(lendingPool.totalReserves(), 0, "reserves must accrue");
        assertApproxEqAbs(lendingPool.totalBorrows(), debtAfterSmallSteps, 1_000);
    }

    function testInterestAccrualRetainsAndCatchesUpElapsedTimeBeyondOneYear() public {
        lendingPool.setInterestRateModel(10_000, 8_000, 0, 0);

        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 200 ether);
        lendingPool.depositCollateral(200 ether);
        lendingPool.borrow(100 ether);
        vm.stopPrank();

        vm.warp(block.timestamp + 730 days);
        lendingPool.accrueInterest();

        assertEq(lendingPool.totalBorrows(), 200 ether);
        assertEq(lendingPool.totalReserves(), 10 ether);
        assertEq(lendingPool.accrualBacklogSeconds(), 365 days);
        assertEq(lendingPool.accrualBatchesRequired(), 1);
        assertFalse(lendingPool.isAccrualCurrent());

        (uint256 catchUpInterest, uint256 catchUpReserves, uint256 batches) = lendingPool.catchUpInterest(2);
        assertEq(catchUpInterest, 200 ether);
        assertEq(catchUpReserves, 20 ether);
        assertEq(batches, 1);
        assertEq(lendingPool.debtBalance(alice), 400 ether);
        assertEq(lendingPool.totalReserves(), 30 ether);
        assertEq(lendingPool.accrualBacklogSeconds(), 0);
        assertTrue(lendingPool.isAccrualCurrent());
    }

    function testFinancialActionsRequireCatchUpWhenMoreThanOneBatchIsOutstanding() public {
        lendingPool.setInterestRateModel(1_000, 8_000, 0, 0);

        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 201 ether);
        lendingPool.depositCollateral(200 ether);
        lendingPool.borrow(100 ether);
        vm.stopPrank();

        vm.warp(block.timestamp + 731 days);
        vm.prank(alice);
        vm.expectRevert(bytes("ACCRUAL_CATCH_UP_REQUIRED"));
        lendingPool.depositCollateral(1 ether);

        (,, uint256 batches) = lendingPool.catchUpInterest(2);
        assertEq(batches, 2);
        assertEq(lendingPool.accrualBacklogSeconds(), 1 days);

        vm.prank(alice);
        lendingPool.depositCollateral(1 ether);
        assertEq(lendingPool.accrualBacklogSeconds(), 0);
    }

    function testRepaymentServicesAccruedInterestBeforeReleasingOriginationPrincipalCapacity() public {
        lendingPool.setInterestRateModel(10_000, 8_000, 0, 0);

        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 200 ether);
        lendingPool.depositCollateral(200 ether);
        lendingPool.borrow(100 ether);
        debtAsset.approve(address(lendingPool), type(uint256).max);
        vm.stopPrank();

        vm.warp(block.timestamp + 365 days);
        lendingPool.accrueInterest();
        assertEq(lendingPool.debtBalance(alice), 200 ether);
        assertEq(lendingPool.originationPrincipalDebt(alice), 100 ether);

        vm.prank(alice);
        lendingPool.repay(50 ether);
        assertEq(lendingPool.originationPrincipalDebt(alice), 100 ether);
        assertEq(policy.accountOriginationPrincipalOutstanding(alice), 100 ether);

        debtAsset.mint(alice, 25 ether);
        vm.prank(alice);
        lendingPool.repay(75 ether);
        assertEq(lendingPool.originationPrincipalDebt(alice), 75 ether);
        assertEq(policy.accountOriginationPrincipalOutstanding(alice), 75 ether);
    }

    function testPolicyCapsRejectOverCapBorrowAndCollateral() public {
        policy.setCollateralCap(address(voucher), 50 ether);

        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 60 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyControlledLendingPool.PolicyDenied.selector, policy.POLICY_COLLATERAL_CAP_EXCEEDED()
            )
        );
        lendingPool.depositCollateral(60 ether);
        vm.stopPrank();

        policy.setCollateralCap(address(voucher), 0);
        policy.setAccountOriginationPrincipalCap(alice, 500 ether);
        policy.setDebtAssetOriginationPrincipalCap(address(debtAsset), 50 ether);

        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 100 ether);
        lendingPool.depositCollateral(100 ether);
        lendingPool.borrow(40 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyControlledLendingPool.PolicyDenied.selector,
                policy.POLICY_DEBT_ORIGINATION_CAP_EXCEEDED()
            )
        );
        lendingPool.borrow(11 ether);
        vm.stopPrank();
    }

    function testBorrowFailsWithMissingPriceAndInsufficientLiquidity() public {
        ManualAssetOracle missingDebtPrice = new ManualAssetOracle(address(this));
        missingDebtPrice.setPrice(address(voucher), 1 ether);
        lendingPool.setValuationOracle(address(missingDebtPrice));

        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 100 ether);
        lendingPool.depositCollateral(100 ether);
        vm.expectRevert(bytes("PRICE_NOT_SET"));
        lendingPool.borrow(1 ether);
        vm.stopPrank();

        lendingPool.setValuationOracle(address(oracle));
        policy.setAccountOriginationPrincipalCap(alice, 2_000 ether);
        oracle.setPrice(address(voucher), 2 ether);
        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 900 ether);
        lendingPool.depositCollateral(900 ether);
        vm.stopPrank();
        vm.expectRevert(bytes("POOL_LIQUIDITY"));
        vm.prank(alice);
        lendingPool.borrow(1_001 ether);
    }

    function testRepayMoreThanDebtSafelyCapsPayment() public {
        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 100 ether);
        lendingPool.depositCollateral(100 ether);
        lendingPool.borrow(40 ether);
        vm.stopPrank();

        debtAsset.mint(alice, 100 ether);
        uint256 balanceBefore = debtAsset.balanceOf(alice);
        vm.startPrank(alice);
        debtAsset.approve(address(lendingPool), 100 ether);
        uint256 payment = lendingPool.repay(100 ether);
        vm.stopPrank();

        assertEq(payment, 40 ether);
        assertEq(lendingPool.debtBalance(alice), 0);
        assertEq(balanceBefore - debtAsset.balanceOf(alice), 40 ether);
        assertEq(policy.accountOriginationPrincipalOutstanding(alice), 0);
    }

    function testRepayAllCollectsExactRemainingBalanceAndUnlocksCollateral() public {
        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 100 ether);
        lendingPool.depositCollateral(100 ether);
        lendingPool.borrow(40 ether);
        vm.stopPrank();

        debtAsset.mint(alice, 40 ether);
        vm.startPrank(alice);
        debtAsset.approve(address(lendingPool), 40 ether);
        lendingPool.repay(39.995 ether);

        assertEq(lendingPool.debtBalance(alice), 0.005 ether);
        uint256 poolCashBefore = lendingPool.totalCash();
        uint256 badDebtBefore = lendingPool.totalBadDebt();
        assertEq(lendingPool.repayAll(), 0.005 ether);
        assertEq(lendingPool.debtBalance(alice), 0);
        assertEq(policy.accountOriginationPrincipalOutstanding(alice), 0);
        assertEq(lendingPool.totalCash() - poolCashBefore, 0.005 ether);
        assertEq(lendingPool.totalBadDebt(), badDebtBefore);

        lendingPool.withdrawCollateral(100 ether);
        assertEq(lendingPool.collateralBalance(alice), 0);
        vm.stopPrank();
    }

    function testRepayAllCannotWriteOffDebtWithoutPayment() public {
        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 100 ether);
        lendingPool.depositCollateral(100 ether);
        lendingPool.borrow(1 ether);
        debtAsset.transfer(bob, 1 ether);
        debtAsset.approve(address(lendingPool), type(uint256).max);

        vm.expectRevert();
        lendingPool.repayAll();
        assertEq(lendingPool.debtBalance(alice), 1 ether);
        assertEq(lendingPool.totalBadDebt(), 0);
        vm.stopPrank();
    }

    function testFuzzRepayAllCollectsEveryClearedDebtUnit(uint96 rawBorrowAmount) public {
        uint256 borrowAmount = bound(uint256(rawBorrowAmount), 1, 100 ether);
        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 200 ether);
        lendingPool.depositCollateral(200 ether);
        lendingPool.borrow(borrowAmount);
        debtAsset.approve(address(lendingPool), type(uint256).max);

        uint256 debtBefore = lendingPool.debtBalance(alice);
        uint256 cashBefore = lendingPool.totalCash();
        uint256 badDebtBefore = lendingPool.totalBadDebt();
        uint256 payment = lendingPool.repayAll();

        assertEq(payment, debtBefore);
        assertEq(lendingPool.totalCash() - cashBefore, payment);
        assertEq(lendingPool.debtBalance(alice), 0);
        assertEq(lendingPool.totalBadDebt(), badDebtBefore);
        assertEq(policy.accountOriginationPrincipalOutstanding(alice), 0);
        vm.stopPrank();
    }

    function testSupplierRedeemBlockedWhenLiquidityIsBorrowedOut() public {
        policy.setAccountOriginationPrincipalCap(alice, 900 ether);
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
        assertEq(preview.nominalSeizedCollateral, 73.5 ether);
        assertEq(preview.seizedCollateral, 50 ether);
        assertEq(preview.remainingDebt, 35 ether);
        assertEq(preview.remainingCollateral, 50 ether);
        assertEq(preview.badDebt, 0);
        assertTrue(preview.riskLimited);
        assertGe(preview.healthFactorAfter, preview.healthFactorBefore);
        assertTrue(preview.executable);

        debtAsset.mint(liquidator, 35 ether);
        vm.startPrank(liquidator);
        debtAsset.approve(address(lendingPool), 35 ether);
        lendingPool.liquidate(alice, 40 ether);
        vm.stopPrank();

        assertEq(lendingPool.debtBalance(alice), 35 ether);
        assertEq(lendingPool.collateralBalance(alice), 50 ether);
        assertEq(policy.debtAssetOriginationPrincipalOutstanding(address(debtAsset)), 35 ether);
        assertEq(policy.accountOriginationPrincipalOutstanding(alice), 35 ether);
        assertEq(policy.collateralOutstanding(address(voucher)), 50 ether);
        assertEq(voucher.balanceOf(liquidator), 50 ether);
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
        assertEq(preview.nominalSeizedCollateral, 63 ether);
        assertEq(preview.seizedCollateral, 50 ether);
        assertEq(preview.remainingDebt, 30 ether);
        assertEq(preview.remainingCollateral, 50 ether);
        assertEq(preview.badDebt, 0);
        assertEq(preview.healthFactorBefore, 0.666666666666666666 ether);
        assertEq(preview.healthFactorAfter, 0.666666666666666666 ether);
        assertTrue(preview.riskLimited);
        assertTrue(preview.executable);
    }

    function testLiquidationConfigurationEnforcesAggregateRiskInvariant() public {
        lendingPool.setLiquidationConfig(5_000, 0);
        lendingPool.setLiquidationThresholdBps(10_000);

        vm.expectRevert(bytes("LIQUIDATION_RISK_INVARIANT"));
        lendingPool.setLiquidationConfig(5_000, 1);

        lendingPool.setLiquidationThresholdBps(8_000);
        lendingPool.setLiquidationConfig(5_000, 2_500);
        vm.expectRevert(bytes("LIQUIDATION_RISK_INVARIANT"));
        lendingPool.setLiquidationConfig(5_000, 2_501);
    }

    function testFuzzExecutableLiquidationNeverWorsensHealthAcrossAllowedParameters(
        uint16 rawHaircut,
        uint16 rawThreshold,
        uint16 rawBonus,
        uint16 rawCloseFactor,
        uint96 rawCollateralPrice,
        uint96 rawRepay
    ) public {
        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 100 ether);
        lendingPool.depositCollateral(100 ether);
        lendingPool.borrow(70 ether);
        vm.stopPrank();

        uint256 haircut = bound(uint256(rawHaircut), 1, 10_000);
        uint256 threshold = bound(uint256(rawThreshold), COLLATERAL_FACTOR_BPS, 10_000);
        uint256 riskRatioBps = 1_000_000_000_000 / (haircut * threshold);
        uint256 maxAllowedBonus = riskRatioBps > 10_000 ? riskRatioBps - 10_000 : 0;
        if (maxAllowedBonus > 5_000) maxAllowedBonus = 5_000;
        uint256 bonus = bound(uint256(rawBonus), 0, maxAllowedBonus);
        uint256 closeFactor = bound(uint256(rawCloseFactor), 1, 10_000);

        lendingPool.setLiquidationConfig(closeFactor, 0);
        lendingPool.setCollateralHaircut(haircut);
        lendingPool.setLiquidationThresholdBps(threshold);
        lendingPool.setLiquidationConfig(closeFactor, bonus);

        oracle.setPrice(address(voucher), bound(uint256(rawCollateralPrice), 0.001 ether, 1 ether));
        uint256 repayAmount = bound(uint256(rawRepay), 1 gwei, 70 ether);
        PolicyControlledLendingPool.LiquidationPreview memory preview =
            lendingPool.previewLiquidation(alice, repayAmount);

        if (preview.healthFactorBefore < 1 ether) {
            assertTrue(preview.executable);
            assertGe(preview.healthFactorAfter, preview.healthFactorBefore);
        }
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
        assertEq(policy.accountOriginationPrincipalOutstanding(alice), 0);
        assertEq(voucher.balanceOf(liquidator), 100 ether);

        assertTrue(policy.accountDefaulted(alice));
        (bool allowedWhileDefaulted, bytes32 defaultCode) = policy.canBorrow(alice, address(debtAsset), 1 ether);
        assertFalse(allowedWhileDefaulted);
        assertEq(defaultCode, policy.POLICY_ACCOUNT_DEFAULTED());

        vm.expectRevert(bytes("RESOLUTION_REFERENCE_ZERO"));
        policy.resolveAccountDefault(alice, bytes32(0));
        policy.resolveAccountDefault(alice, keccak256("credit-committee-resolution-2026-001"));
        (bool allowedAfterResolution,) = policy.canBorrow(alice, address(debtAsset), 1 ether);
        assertTrue(allowedAfterResolution);
    }

    function testAbsorbBadDebtWhenCollateralIsZero() public {
        PolicyControlledLendingPoolHarness harness = new PolicyControlledLendingPoolHarness(
            address(this),
            address(voucher),
            address(debtAsset),
            address(policy),
            COLLATERAL_FACTOR_BPS,
            LIQUIDATION_THRESHOLD_BPS
        );
        harness.grantRole(harness.LIQUIDATOR_ROLE(), liquidator);
        policy.grantRole(policy.POLICY_APP_ROLE(), address(harness));
        harness.setDebtPosition(alice, 70 ether, 70 ether, 0);

        uint256 badDebtBefore = harness.totalBadDebt();
        vm.prank(liquidator);
        uint256 absorbed = harness.absorbBadDebt(alice);

        assertEq(absorbed, 70 ether);
        assertEq(harness.debtOf(alice), 0);
        assertEq(harness.totalBorrows(), 0);
        assertEq(harness.totalBadDebt(), badDebtBefore + 70 ether);
    }

    function testTotalSupplierLossAdvancesEpochBeforeRecapitalization() public {
        PolicyControlledLendingPoolHarness harness = new PolicyControlledLendingPoolHarness(
            address(this),
            address(voucher),
            address(debtAsset),
            address(policy),
            COLLATERAL_FACTOR_BPS,
            LIQUIDATION_THRESHOLD_BPS
        );
        harness.grantRole(harness.LIQUIDATOR_ROLE(), liquidator);
        policy.grantRole(policy.POLICY_APP_ROLE(), address(harness));

        debtAsset.mint(supplierTwo, 1_000 ether);
        vm.startPrank(supplierTwo);
        debtAsset.approve(address(harness), 1_000 ether);
        harness.depositLiquidity(1_000 ether);
        vm.stopPrank();
        assertEq(harness.liquidityEpoch(), 1);
        assertEq(harness.liquidityShares(supplierTwo), 1_000 ether);

        harness.setDebtPosition(alice, 1_000 ether, 1_000 ether, 0);
        vm.prank(address(harness));
        debtAsset.transfer(address(0xD3FA017), 1_000 ether);
        assertEq(harness.totalAssets(), 1_000 ether);

        vm.prank(liquidator);
        harness.absorbBadDebt(alice);

        assertEq(harness.totalAssets(), 0);
        assertEq(harness.liquidityEpoch(), 2);
        assertEq(harness.totalLiquidityShares(), 0);
        assertEq(harness.liquidityShares(supplierTwo), 0);
        assertEq(harness.liquidityBalanceOf(supplierTwo), 0);

        uint256 freshCapital = 250 ether;
        debtAsset.mint(bob, freshCapital);
        vm.startPrank(bob);
        debtAsset.approve(address(harness), freshCapital);
        uint256 freshShares = harness.depositLiquidity(freshCapital);
        vm.stopPrank();

        assertEq(freshShares, freshCapital);
        assertEq(harness.totalLiquidityShares(), freshCapital);
        assertEq(harness.liquidityShares(bob), freshCapital);
        assertEq(harness.liquidityBalanceOf(bob), freshCapital);
        assertEq(harness.liquidityBalanceOf(supplierTwo), 0);
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
        assertEq(lendingPool.collateralBalance(alice), 50 ether);
    }

    function testEmergencyPauseBlocksRiskIncreaseButKeepsRiskReductionAndSupplyAvailable() public {
        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 110 ether);
        lendingPool.depositCollateral(100 ether);
        lendingPool.borrow(20 ether);
        debtAsset.approve(address(lendingPool), 10 ether);
        vm.stopPrank();

        lendingPool.pause();
        assertTrue(lendingPool.paused());
        assertEq(lendingPool.pausedActionMask(), lendingPool.DEFAULT_EMERGENCY_PAUSE_MASK());
        assertEq(lendingPool.pausedActionMask() & lendingPool.PAUSE_LIQUIDATION(), 0);
        assertEq(lendingPool.pausedActionMask() & lendingPool.PAUSE_LIQUIDITY_DEPOSIT(), 0);

        vm.startPrank(alice);
        lendingPool.depositCollateral(10 ether);
        lendingPool.repay(10 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyControlledLendingPool.LendingActionPaused.selector, lendingPool.PAUSE_BORROW()
            )
        );
        lendingPool.borrow(1 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyControlledLendingPool.LendingActionPaused.selector,
                lendingPool.PAUSE_COLLATERAL_WITHDRAWAL()
            )
        );
        lendingPool.withdrawCollateral(1 ether);
        vm.stopPrank();

        debtAsset.mint(supplier, 10 ether);
        vm.startPrank(supplier);
        debtAsset.approve(address(lendingPool), 10 ether);
        lendingPool.depositLiquidity(10 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyControlledLendingPool.LendingActionPaused.selector,
                lendingPool.PAUSE_LIQUIDITY_WITHDRAWAL()
            )
        );
        lendingPool.withdrawLiquidity(1 ether);
        vm.stopPrank();

        assertEq(lendingPool.debtBalance(alice), 10 ether);
        assertEq(lendingPool.collateralBalance(alice), 110 ether);
    }

    function testGuardianCanPauseButCannotChangeRiskOrUnpause() public {
        address guardian = address(0xCAFE);
        lendingPool.grantRole(lendingPool.GUARDIAN_ROLE(), guardian);

        vm.prank(guardian);
        lendingPool.pause();

        vm.prank(guardian);
        vm.expectRevert();
        lendingPool.setCollateralFactor(6_000);
        vm.prank(guardian);
        vm.expectRevert();
        lendingPool.unpause();

        lendingPool.unpause();
    }

    function _seedLiquidity(uint256 amount) internal {
        debtAsset.mint(supplier, amount);
        vm.startPrank(supplier);
        debtAsset.approve(address(lendingPool), amount);
        lendingPool.depositLiquidity(amount);
        vm.stopPrank();
    }
}
