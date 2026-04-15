// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCLocalSimulationBase} from "../helpers/IBCLocalSimulationBase.sol";
import {PacketLib} from "../../contracts/libs/PacketLib.sol";

contract MinimalTransferAppTest is IBCLocalSimulationBase {
    function testMinimalEscrowToVoucherMintFlowWorks() public {
        (PacketLib.Packet memory packet, uint256 sequence) = _sendLock(100 ether);
        FinalizedPacket memory finalized = _finalizeAtoB(sequence, validatorKeysA, 2);

        assertEq(escrowA.totalEscrowed(), 100 ether);
        assertEq(canonicalA.balanceOf(address(escrowA)), 100 ether);
        assertEq(canonicalA.balanceOf(user), 900 ether);

        vm.prank(relayer);
        handlerB.recvPacket(packet, finalized.proof);

        assertEq(voucherB.balanceOf(user), 100 ether);
        assertTrue(voucherB.processedMintPackets(PacketLib.packetId(packet)));
    }

    function testMinimalBurnToUnescrowFlowWorks() public {
        (PacketLib.Packet memory lockPacket, uint256 lockSequence) = _sendLock(120 ether);
        FinalizedPacket memory finalizedLock = _finalizeAtoB(lockSequence, validatorKeysA, 2);

        vm.prank(relayer);
        handlerB.recvPacket(lockPacket, finalizedLock.proof);
        assertEq(voucherB.balanceOf(user), 120 ether);

        (PacketLib.Packet memory burnPacket, uint256 burnSequence) = _sendBurn(120 ether);
        FinalizedPacket memory finalizedBurn = _finalizeBtoA(burnSequence, validatorKeysB, 2);

        vm.prank(anyRelayer);
        handlerA.recvPacket(burnPacket, finalizedBurn.proof);

        assertEq(voucherB.balanceOf(user), 0);
        assertEq(escrowA.totalEscrowed(), 0);
        assertEq(escrowA.escrowedBalance(user), 0);
        assertEq(canonicalA.balanceOf(user), 1_000 ether);
        assertTrue(escrowA.processedUnlockPackets(PacketLib.packetId(burnPacket)));
    }
}
