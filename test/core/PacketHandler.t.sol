// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCLocalSimulationBase} from "../helpers/IBCLocalSimulationBase.sol";
import {PacketLib} from "../../contracts/libs/PacketLib.sol";

contract PacketHandlerTest is IBCLocalSimulationBase {
    function testMembershipProofSucceedsForValidPacketCommitment() public {
        (PacketLib.Packet memory packet, uint256 sequence) = _sendLock(30 ether);
        StorageFinalizedPacket memory finalized = _finalizeAtoBForStorageProof(sequence, validatorKeysA, 2);

        bytes32 packetId = PacketLib.packetId(packet);
        vm.prank(relayer);
        handlerB.recvPacketFromStorageProof(packet, finalized.leafProof, finalized.pathProof);

        assertTrue(handlerB.consumedPackets(packetId));
        assertEq(voucherB.balanceOf(user), 30 ether);
    }

    function testInvalidMembershipProofFails() public {
        (PacketLib.Packet memory packet, uint256 sequence) = _sendLock(30 ether);
        StorageFinalizedPacket memory finalized = _finalizeAtoBForStorageProof(sequence, validatorKeysA, 2);
        finalized.leafProof.storageKey = bytes32(uint256(123));

        vm.expectRevert(bytes("INVALID_PACKET_STORAGE_PROOF"));
        vm.prank(relayer);
        handlerB.recvPacketFromStorageProof(packet, finalized.leafProof, finalized.pathProof);
    }

    function testReplayedPacketFails() public {
        (PacketLib.Packet memory packet, uint256 sequence) = _sendLock(25 ether);
        StorageFinalizedPacket memory finalized = _finalizeAtoBForStorageProof(sequence, validatorKeysA, 2);

        vm.prank(relayer);
        handlerB.recvPacketFromStorageProof(packet, finalized.leafProof, finalized.pathProof);

        vm.expectRevert(bytes("PACKET_ALREADY_CONSUMED"));
        vm.prank(anyRelayer);
        handlerB.recvPacketFromStorageProof(packet, finalized.leafProof, finalized.pathProof);
    }

    function testOnlyTrustedRemoteStateCanAuthorizeExecution() public {
        (PacketLib.Packet memory packet, uint256 sequence) = _sendLock(10 ether);
        StorageFinalizedPacket memory finalized = _finalizeAtoBForStorageProof(sequence, validatorKeysA, 2);
        finalized.leafProof.consensusStateHash = keccak256("untrusted");
        finalized.pathProof.consensusStateHash = finalized.leafProof.consensusStateHash;

        vm.expectRevert(bytes("INVALID_PACKET_STORAGE_PROOF"));
        vm.prank(relayer);
        handlerB.recvPacketFromStorageProof(packet, finalized.leafProof, finalized.pathProof);
        assertEq(voucherB.balanceOf(user), 0);
    }
}
