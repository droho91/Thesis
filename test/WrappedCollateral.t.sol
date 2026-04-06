// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {WrappedCollateral} from "../contracts/WrappedCollateral.sol";

contract WrappedCollateralTest is Test {
    WrappedCollateral internal wrapped;

    address internal bridge = address(0xBEEF);
    address internal user = address(0x2222);

    function setUp() public {
        wrapped = new WrappedCollateral("Wrapped Collateral", "wCOL", bridge);
    }

    function testBridgeCanMintAndBurn() public {
        bytes32 lockEventId = keccak256("LOCK_EVENT_A");
        vm.prank(bridge);
        wrapped.mintFromLockEvent(user, 200 ether, lockEventId);
        assertEq(wrapped.balanceOf(user), 200 ether);

        vm.prank(bridge);
        wrapped.burn(user, 80 ether);
        assertEq(wrapped.balanceOf(user), 120 ether);
    }

    function testMintRevertsIfNotBridge() public {
        vm.expectRevert(bytes("ONLY_BRIDGE"));
        vm.prank(user);
        wrapped.mintFromLockEvent(user, 10 ether, keccak256("LOCK_EVENT_B"));
    }

    function testBurnRevertsIfNotBridge() public {
        bytes32 lockEventId = keccak256("LOCK_EVENT_C");
        vm.prank(bridge);
        wrapped.mintFromLockEvent(user, 50 ether, lockEventId);

        vm.expectRevert(bytes("ONLY_BRIDGE"));
        vm.prank(user);
        wrapped.burn(user, 10 ether);
    }

    function testMintFromLockEventPreventsReplay() public {
        bytes32 lockEventId = keccak256("LOCK_EVENT_1");

        vm.prank(bridge);
        wrapped.mintFromLockEvent(user, 25 ether, lockEventId);
        assertEq(wrapped.balanceOf(user), 25 ether);
        assertTrue(wrapped.processedLockEvents(lockEventId));

        vm.expectRevert(bytes("LOCK_EVENT_ALREADY_PROCESSED"));
        vm.prank(bridge);
        wrapped.mintFromLockEvent(user, 10 ether, lockEventId);
    }
}
