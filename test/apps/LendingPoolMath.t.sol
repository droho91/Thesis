// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {LendingPoolMath} from "../../contracts/apps/LendingPoolMath.sol";

contract LendingPoolMathTest is Test {
    function testUtilizationAndKinkedBorrowRate() public pure {
        assertEq(LendingPoolMath.utilizationRateBps(0, 0), 0);
        assertEq(LendingPoolMath.utilizationRateBps(80 ether, 20 ether), 8_000);
        assertEq(LendingPoolMath.borrowRateBps(80 ether, 20 ether, 200, 8_000, 800, 5_000), 1_000);
        assertEq(LendingPoolMath.borrowRateBps(90 ether, 10 ether, 200, 8_000, 800, 5_000), 3_500);
    }

    function testShareConversionsRoundConservatively() public pure {
        uint256 index = 1.1 ether;
        assertEq(LendingPoolMath.debtToSharesUp(1 ether, index), 909090909090909091);
        assertEq(LendingPoolMath.sharesToDebt(909090909090909091, index), 1 ether);
        assertEq(LendingPoolMath.assetsToLiquiditySharesUp(1 ether, 3 ether, 2 ether), 1.5 ether);
    }

    function testTinyLiquidationStillRepaysDebt() public pure {
        assertEq(LendingPoolMath.maxLiquidationRepay(1, 1), 1);
        assertEq(LendingPoolMath.maxLiquidationRepay(100, 5_000), 50);
    }

    function testRiskAndPauseValidationPreservePoolErrors() public {
        vm.expectRevert(bytes("BAD_COLLATERAL_FACTOR"));
        this.validateRiskThresholds(10_001, 10_001);

        vm.expectRevert(bytes("THRESHOLD_LT_FACTOR"));
        this.validateRiskThresholds(8_001, 8_000);

        vm.expectRevert(bytes("BAD_PAUSE_MASK"));
        this.validatePauseMask(0, 127);
    }

    function validateRiskThresholds(uint256 factorBps, uint256 thresholdBps) external pure {
        LendingPoolMath.validateRiskThresholds(factorBps, thresholdBps);
    }

    function validatePauseMask(uint256 actionMask, uint256 allPauseActions) external pure {
        LendingPoolMath.validatePauseMask(actionMask, allPauseActions);
    }
}
