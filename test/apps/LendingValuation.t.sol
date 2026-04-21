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
        policy.grantRole(policy.POLICY_APP_ROLE(), address(voucher));
        policy.grantRole(policy.POLICY_APP_ROLE(), address(lendingPool));

        policy.setAccountAllowed(alice, true);
        policy.setSourceChainAllowed(SOURCE_CHAIN_A, true);
        policy.setMintAssetAllowed(address(canonicalAsset), true);
        policy.setCollateralAssetAllowed(address(voucher), true);
        policy.setDebtAssetAllowed(address(debtAsset), true);
        policy.setAccountBorrowCap(alice, 500 ether);
        policy.setDebtAssetBorrowCap(address(debtAsset), 1_000 ether);

        voucher.mintWithPolicy(alice, address(canonicalAsset), SOURCE_CHAIN_A, 100 ether, PACKET_ONE);
        debtAsset.mint(address(lendingPool), 1_000 ether);
    }

    function testAvailableToBorrowFallsBackToUnitPricingWithoutOracle() public {
        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 100 ether);
        lendingPool.depositCollateral(100 ether);
        vm.stopPrank();

        assertEq(lendingPool.maxBorrow(alice), 80 ether);
        assertEq(lendingPool.availableToBorrow(alice), 80 ether);
        assertEq(lendingPool.collateralValue(alice), 100 ether);
        assertEq(lendingPool.healthFactorBps(alice), type(uint256).max);
    }

    function testOracleAndHaircutAdjustBorrowCeiling() public {
        oracle.setPrice(address(voucher), 2 ether);
        oracle.setPrice(address(debtAsset), 1 ether);
        lendingPool.setValuationOracle(address(oracle));
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

    function testAuthorizedLiquidatorCanRepayBadDebtAndSeizeCollateral() public {
        lendingPool.grantRole(lendingPool.LIQUIDATOR_ROLE(), liquidator);

        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 100 ether);
        lendingPool.depositCollateral(100 ether);
        lendingPool.borrow(80 ether);
        vm.stopPrank();

        oracle.setPrice(address(voucher), 0.5 ether);
        oracle.setPrice(address(debtAsset), 1 ether);
        lendingPool.setValuationOracle(address(oracle));

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
        lendingPool.setValuationOracle(address(oracle));

        vm.startPrank(liquidator);
        vm.expectRevert(bytes("LIQUIDATION_CLOSE_FACTOR"));
        lendingPool.liquidate(alice, 21 ether);
        vm.stopPrank();
    }
}
