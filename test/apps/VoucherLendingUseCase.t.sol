// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCLocalSimulationBase} from "../helpers/IBCLocalSimulationBase.sol";
import {PacketLib} from "../../contracts/libs/PacketLib.sol";

contract VoucherLendingUseCaseTest is IBCLocalSimulationBase {
    function testVoucherCanBeUsedAsMinimalLendingCollateralAfterProofExecution() public {
        (PacketLib.Packet memory lockPacket, uint256 lockSequence) = _sendLock(200 ether);
        FinalizedPacket memory finalizedLock = _finalizeAtoB(lockSequence, validatorKeysA, 2);

        vm.prank(relayer);
        handlerB.recvPacket(lockPacket, finalizedLock.proof);
        assertEq(voucherB.balanceOf(user), 200 ether);

        vm.startPrank(user);
        voucherB.approve(address(lendingB), type(uint256).max);
        stableB.approve(address(lendingB), type(uint256).max);
        lendingB.depositCollateral(200 ether);
        lendingB.borrow(80 ether);
        lendingB.repay(80 ether);
        lendingB.withdrawCollateral(200 ether);
        vm.stopPrank();

        assertEq(lendingB.collateralBalance(user), 0);
        assertEq(lendingB.debtBalance(user), 0);
        assertEq(voucherB.balanceOf(user), 200 ether);
    }

    function testEndToEndLendingUseCaseThenBurnAndUnescrow() public {
        (PacketLib.Packet memory lockPacket, uint256 lockSequence) = _sendLock(150 ether);
        FinalizedPacket memory finalizedLock = _finalizeAtoB(lockSequence, validatorKeysA, 2);

        vm.prank(relayer);
        handlerB.recvPacket(lockPacket, finalizedLock.proof);

        vm.startPrank(user);
        voucherB.approve(address(lendingB), type(uint256).max);
        stableB.approve(address(lendingB), type(uint256).max);
        lendingB.depositCollateral(150 ether);
        lendingB.borrow(60 ether);
        lendingB.repay(60 ether);
        lendingB.withdrawCollateral(150 ether);
        vm.stopPrank();

        (PacketLib.Packet memory burnPacket, uint256 burnSequence) = _sendBurn(150 ether);
        FinalizedPacket memory finalizedBurn = _finalizeBtoA(burnSequence, validatorKeysB, 2);

        vm.prank(anyRelayer);
        handlerA.recvPacket(burnPacket, finalizedBurn.proof);

        assertEq(voucherB.balanceOf(user), 0);
        assertEq(escrowA.totalEscrowed(), 0);
        assertEq(canonicalA.balanceOf(user), 1_000 ether);
    }

    function testLendingCannotStartBeforeVoucherMint() public {
        vm.expectRevert();
        vm.prank(user);
        lendingB.depositCollateral(1 ether);
    }
}
