// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCLocalSimulationBase} from "../helpers/IBCLocalSimulationBase.sol";
import {IBCClientTypes} from "../../contracts/core/IBCClientTypes.sol";
import {PacketLib} from "../../contracts/libs/PacketLib.sol";

contract PacketHandlerTest is IBCLocalSimulationBase {
    function testMembershipProofSucceedsForValidPacketCommitment() public {
        (PacketLib.Packet memory packet, uint256 sequence) = _sendLock(30 ether);
        FinalizedPacket memory finalized = _finalizeAtoB(sequence, validatorKeysA, 2);

        bytes32 packetId = PacketLib.packetId(packet);
        vm.prank(relayer);
        handlerB.recvPacket(packet, finalized.proof);

        assertTrue(handlerB.consumedPackets(packetId));
        assertEq(voucherB.balanceOf(user), 30 ether);
    }

    function testInvalidMembershipProofFails() public {
        (PacketLib.Packet memory packet, uint256 sequence) = _sendLock(30 ether);
        FinalizedPacket memory finalized = _finalizeAtoB(sequence, validatorKeysA, 2);
        finalized.proof.leafIndex = 1;

        vm.expectRevert(bytes("INVALID_PACKET_PROOF"));
        vm.prank(relayer);
        handlerB.recvPacket(packet, finalized.proof);
    }

    function testReplayedPacketFails() public {
        (PacketLib.Packet memory packet, uint256 sequence) = _sendLock(25 ether);
        FinalizedPacket memory finalized = _finalizeAtoB(sequence, validatorKeysA, 2);

        vm.prank(relayer);
        handlerB.recvPacket(packet, finalized.proof);

        vm.expectRevert(bytes("PACKET_ALREADY_CONSUMED"));
        vm.prank(anyRelayer);
        handlerB.recvPacket(packet, finalized.proof);
    }

    function testOnlyTrustedRemoteStateCanAuthorizeExecution() public {
        (PacketLib.Packet memory packet, uint256 sequence) = _sendLock(10 ether);
        bytes32[] memory siblings = new bytes32[](0);
        IBCClientTypes.MembershipProof memory untrustedProof = IBCClientTypes.MembershipProof({
            consensusStateHash: packetsA.packetLeafAt(sequence),
            leafIndex: 0,
            siblings: siblings
        });

        vm.expectRevert(bytes("INVALID_PACKET_PROOF"));
        vm.prank(relayer);
        handlerB.recvPacket(packet, untrustedProof);
        assertEq(voucherB.balanceOf(user), 0);
    }
}
