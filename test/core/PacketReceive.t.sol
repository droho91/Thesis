// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCEVMTypes} from "../../contracts/core/IBCEVMTypes.sol";
import {IBCPacketLib} from "../../contracts/core/IBCPacketLib.sol";
import {PacketHandlerFixture} from "../helpers/PacketHandlerFixture.sol";

contract PacketReceiveTest is PacketHandlerFixture {
    function testRecvPacketFromStorageProofWritesReceiptAndAcknowledgement() public {
        IBCPacketLib.Packet memory packet = _packet();
        address packetStore = address(0xA11CE);
        BuiltPacketStorageProof memory built = _buildPacketStorageProof(packetStore, packet);
        clientB.setTrustedStateRoot(CHAIN_A, TRUSTED_HEIGHT_A, built.stateRoot);
        handlerB.setTrustedPacketStore(CHAIN_A, packetStore);

        (IBCEVMTypes.StorageProof memory leafProof, IBCEVMTypes.StorageProof memory pathProof) =
            _packetProofs(packet, packetStore, TRUSTED_HEIGHT_A, built);

        bytes32 packetId = IBCPacketLib.packetId(packet);
        bytes memory acknowledgement = abi.encodePacked("ok:", packetId);
        bytes32 expectedAcknowledgementHash = keccak256(acknowledgement);

        handlerB.recvPacketFromStorageProof(packet, leafProof, pathProof);

        assertTrue(handlerB.packetReceipts(packetId));
        assertEq(handlerB.acknowledgementHashes(packetId), expectedAcknowledgementHash);
        assertEq(receiver.receiveCount(), 1);
        assertEq(receiver.lastPacketId(), packetId);
        assertEq(receiver.lastAcknowledgementHash(), expectedAcknowledgementHash);
    }

    function testRecvPacketFromStorageProofBlocksReplay() public {
        IBCPacketLib.Packet memory packet = _packet();
        address packetStore = address(0xA11CE);
        BuiltPacketStorageProof memory built = _buildPacketStorageProof(packetStore, packet);
        clientB.setTrustedStateRoot(CHAIN_A, TRUSTED_HEIGHT_A, built.stateRoot);
        handlerB.setTrustedPacketStore(CHAIN_A, packetStore);

        (IBCEVMTypes.StorageProof memory leafProof, IBCEVMTypes.StorageProof memory pathProof) =
            _packetProofs(packet, packetStore, TRUSTED_HEIGHT_A, built);

        handlerB.recvPacketFromStorageProof(packet, leafProof, pathProof);

        vm.expectRevert(bytes("PACKET_ALREADY_RECEIVED"));
        handlerB.recvPacketFromStorageProof(packet, leafProof, pathProof);
    }

    function testRecvPacketFromStorageProofRejectsWrongTrustedHeight() public {
        IBCPacketLib.Packet memory packet = _packet();
        address packetStore = address(0xA11CE);
        BuiltPacketStorageProof memory built = _buildPacketStorageProof(packetStore, packet);
        clientB.setTrustedStateRoot(CHAIN_A, TRUSTED_HEIGHT_A + 1, built.stateRoot);
        handlerB.setTrustedPacketStore(CHAIN_A, packetStore);

        (IBCEVMTypes.StorageProof memory leafProof, IBCEVMTypes.StorageProof memory pathProof) =
            _packetProofs(packet, packetStore, TRUSTED_HEIGHT_A, built);

        vm.expectRevert(bytes("INVALID_PACKET_STORAGE_PROOF"));
        handlerB.recvPacketFromStorageProof(packet, leafProof, pathProof);
    }

    function testRecvPacketFromStorageProofRejectsClosedChannel() public {
        IBCPacketLib.Packet memory packet = _packet();
        address packetStore = address(0xA11CE);
        BuiltPacketStorageProof memory built = _buildPacketStorageProof(packetStore, packet);
        clientB.setTrustedStateRoot(CHAIN_A, TRUSTED_HEIGHT_A, built.stateRoot);
        handlerB.setTrustedPacketStore(CHAIN_A, packetStore);
        channelKeeperB.closeChannel(bytes32("channel-b"));

        (IBCEVMTypes.StorageProof memory leafProof, IBCEVMTypes.StorageProof memory pathProof) =
            _packetProofs(packet, packetStore, TRUSTED_HEIGHT_A, built);

        vm.expectRevert(bytes("CHANNEL_NOT_OPEN"));
        handlerB.recvPacketFromStorageProof(packet, leafProof, pathProof);
    }
}
