// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCLocalSimulationBase} from "../helpers/IBCLocalSimulationBase.sol";
import {PacketLib} from "../../contracts/libs/PacketLib.sol";

contract CrossChainLendingUseCaseTest is IBCLocalSimulationBase {
    function testVerifiedVoucherCanCollateralizeBankBLending() public {
        (PacketLib.Packet memory packet, uint256 sequence) = _sendLock(100 ether);
        StorageFinalizedPacket memory finalized = _finalizeAtoBForStorageProof(sequence, validatorKeysA, 2);

        vm.prank(relayer);
        handlerB.recvPacketFromStorageProof(packet, finalized.leafProof, finalized.pathProof);

        vm.startPrank(user);
        voucherB.approve(address(lendingPoolB), 100 ether);
        lendingPoolB.depositCollateral(100 ether);
        lendingPoolB.borrow(50 ether);
        vm.stopPrank();

        assertEq(voucherB.balanceOf(user), 0);
        assertEq(lendingPoolB.collateralBalance(user), 100 ether);
        assertEq(lendingPoolB.debtBalance(user), 50 ether);
        assertEq(bankLiquidityB.balanceOf(user), 50 ether);
    }

    function testCannotBorrowAboveVerifiedCollateralLimit() public {
        (PacketLib.Packet memory packet, uint256 sequence) = _sendLock(100 ether);
        StorageFinalizedPacket memory finalized = _finalizeAtoBForStorageProof(sequence, validatorKeysA, 2);

        vm.prank(relayer);
        handlerB.recvPacketFromStorageProof(packet, finalized.leafProof, finalized.pathProof);

        vm.startPrank(user);
        voucherB.approve(address(lendingPoolB), 100 ether);
        lendingPoolB.depositCollateral(100 ether);
        vm.expectRevert(bytes("BORROW_LIMIT"));
        lendingPoolB.borrow(51 ether);
        vm.stopPrank();
    }

    function testRepayThenWithdrawCollateralBeforeBurnPath() public {
        (PacketLib.Packet memory packet, uint256 sequence) = _sendLock(100 ether);
        StorageFinalizedPacket memory finalized = _finalizeAtoBForStorageProof(sequence, validatorKeysA, 2);

        vm.prank(relayer);
        handlerB.recvPacketFromStorageProof(packet, finalized.leafProof, finalized.pathProof);

        vm.startPrank(user);
        voucherB.approve(address(lendingPoolB), 100 ether);
        lendingPoolB.depositCollateral(100 ether);
        lendingPoolB.borrow(40 ether);
        bankLiquidityB.approve(address(lendingPoolB), 40 ether);
        lendingPoolB.repay(40 ether);
        lendingPoolB.withdrawCollateral(100 ether);
        vm.stopPrank();

        assertEq(lendingPoolB.collateralBalance(user), 0);
        assertEq(lendingPoolB.debtBalance(user), 0);
        assertEq(voucherB.balanceOf(user), 100 ether);
    }
}
