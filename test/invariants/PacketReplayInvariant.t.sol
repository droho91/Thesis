// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCLocalSimulationBase} from "../helpers/IBCLocalSimulationBase.sol";
import {PacketLib} from "../../contracts/libs/PacketLib.sol";

contract PacketReplayInvariantTest is IBCLocalSimulationBase {
    function testExecutedPacketCannotIncreaseVoucherSupplyTwice() public {
        (PacketLib.Packet memory packet, uint256 sequence) = _sendLock(45 ether);
        StorageFinalizedPacket memory finalized = _finalizeAtoBForStorageProof(sequence, validatorKeysA, 2);

        vm.prank(relayer);
        handlerB.recvPacketFromStorageProof(packet, finalized.leafProof, finalized.pathProof);
        uint256 supplyAfterFirstExecution = voucherB.totalSupply();

        vm.expectRevert(bytes("PACKET_ALREADY_CONSUMED"));
        vm.prank(relayer);
        handlerB.recvPacketFromStorageProof(packet, finalized.leafProof, finalized.pathProof);

        assertEq(voucherB.totalSupply(), supplyAfterFirstExecution);
    }
}
