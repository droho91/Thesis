// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CollateralVault} from "../contracts/CollateralVault.sol";
import {StableToken} from "../contracts/StableToken.sol";

contract CollateralVaultTest is Test {
    StableToken internal collateral;
    CollateralVault internal vault;

    address internal user = address(0x1111);
    address internal bridge = address(0xBEEF);

    function setUp() public {
        collateral = new StableToken("Mock Collateral", "mCOL");
        vault = new CollateralVault(address(collateral), bridge);

        collateral.mint(user, 1_000 ether);

        vm.prank(user);
        collateral.approve(address(vault), type(uint256).max);
    }

    function testLockUpdatesBalanceAndTransfersToken() public {
        vm.prank(user);
        vault.lock(100 ether);

        assertEq(vault.lockedBalance(user), 100 ether);
        assertEq(collateral.balanceOf(address(vault)), 100 ether);
        assertEq(collateral.balanceOf(user), 900 ether);
    }

    function testUnlockByBridgeWorks() public {
        vm.prank(user);
        vault.lock(120 ether);

        bytes32 burnEventId = keccak256("BURN_EVENT_A");
        vm.prank(bridge);
        vault.unlockFromBurnEvent(user, 50 ether, burnEventId);

        assertEq(vault.lockedBalance(user), 70 ether);
        assertEq(collateral.balanceOf(user), 930 ether);
        assertEq(collateral.balanceOf(address(vault)), 70 ether);
    }

    function testUnlockRevertsIfCallerIsNotBridge() public {
        vm.prank(user);
        vault.lock(100 ether);

        vm.expectRevert(bytes("ONLY_BRIDGE"));
        vm.prank(user);
        vault.unlockFromBurnEvent(user, 10 ether, keccak256("BURN_EVENT_B"));
    }

    function testUnlockRevertsIfAmountExceedsLocked() public {
        vm.prank(user);
        vault.lock(30 ether);

        vm.expectRevert(bytes("INSUFFICIENT_LOCKED"));
        vm.prank(bridge);
        vault.unlockFromBurnEvent(user, 40 ether, keccak256("BURN_EVENT_C"));
    }

    function testUnlockFromBurnEventPreventsReplay() public {
        vm.prank(user);
        vault.lock(100 ether);

        bytes32 burnEventId = keccak256("BURN_EVENT_1");

        vm.prank(bridge);
        vault.unlockFromBurnEvent(user, 20 ether, burnEventId);
        assertEq(vault.lockedBalance(user), 80 ether);
        assertTrue(vault.processedBurnEvents(burnEventId));

        vm.expectRevert(bytes("BURN_EVENT_ALREADY_PROCESSED"));
        vm.prank(bridge);
        vault.unlockFromBurnEvent(user, 20 ether, burnEventId);
    }
}
