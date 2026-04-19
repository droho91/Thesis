// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCEVMTypesV2} from "../../contracts/v2/core/IBCEVMTypesV2.sol";
import {IBCPacketLibV2} from "../../contracts/v2/core/IBCPacketLibV2.sol";
import {PacketHandlerV2Fixture} from "./helpers/PacketHandlerV2Fixture.sol";

contract PacketReceiveV2Test is PacketHandlerV2Fixture {
    function testRecvPacketFromStorageProofWritesReceiptAndAcknowledgement() public {
        IBCPacketLibV2.Packet memory packet = _packet();
        address packetStore = address(0xA11CE);
        BuiltPacketStorageProof memory built = _buildPacketStorageProof(packetStore, packet);
        clientB.setTrustedStateRoot(CHAIN_A, TRUSTED_HEIGHT_A, built.stateRoot);
        handlerB.setTrustedPacketStore(CHAIN_A, packetStore);

        (IBCEVMTypesV2.StorageProof memory leafProof, IBCEVMTypesV2.StorageProof memory pathProof) =
            _packetProofs(packet, packetStore, TRUSTED_HEIGHT_A, built);

        bytes32 packetId = IBCPacketLibV2.packetId(packet);
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
        IBCPacketLibV2.Packet memory packet = _packet();
        address packetStore = address(0xA11CE);
        BuiltPacketStorageProof memory built = _buildPacketStorageProof(packetStore, packet);
        clientB.setTrustedStateRoot(CHAIN_A, TRUSTED_HEIGHT_A, built.stateRoot);
        handlerB.setTrustedPacketStore(CHAIN_A, packetStore);

        (IBCEVMTypesV2.StorageProof memory leafProof, IBCEVMTypesV2.StorageProof memory pathProof) =
            _packetProofs(packet, packetStore, TRUSTED_HEIGHT_A, built);

        handlerB.recvPacketFromStorageProof(packet, leafProof, pathProof);

        vm.expectRevert(bytes("PACKET_ALREADY_RECEIVED"));
        handlerB.recvPacketFromStorageProof(packet, leafProof, pathProof);
    }

    function testRecvPacketFromStorageProofRejectsWrongTrustedHeight() public {
        IBCPacketLibV2.Packet memory packet = _packet();
        address packetStore = address(0xA11CE);
        BuiltPacketStorageProof memory built = _buildPacketStorageProof(packetStore, packet);
        clientB.setTrustedStateRoot(CHAIN_A, TRUSTED_HEIGHT_A + 1, built.stateRoot);
        handlerB.setTrustedPacketStore(CHAIN_A, packetStore);

        (IBCEVMTypesV2.StorageProof memory leafProof, IBCEVMTypesV2.StorageProof memory pathProof) =
            _packetProofs(packet, packetStore, TRUSTED_HEIGHT_A, built);

        vm.expectRevert(bytes("INVALID_PACKET_STORAGE_PROOF"));
        handlerB.recvPacketFromStorageProof(packet, leafProof, pathProof);
    }

    function testRecvPacketFromStorageProofRejectsClosedChannel() public {
        IBCPacketLibV2.Packet memory packet = _packet();
        address packetStore = address(0xA11CE);
        BuiltPacketStorageProof memory built = _buildPacketStorageProof(packetStore, packet);
        clientB.setTrustedStateRoot(CHAIN_A, TRUSTED_HEIGHT_A, built.stateRoot);
        handlerB.setTrustedPacketStore(CHAIN_A, packetStore);
        channelKeeperB.closeChannel(bytes32("channel-b"));

        (IBCEVMTypesV2.StorageProof memory leafProof, IBCEVMTypesV2.StorageProof memory pathProof) =
            _packetProofs(packet, packetStore, TRUSTED_HEIGHT_A, built);

        vm.expectRevert(bytes("CHANNEL_NOT_OPEN"));
        handlerB.recvPacketFromStorageProof(packet, leafProof, pathProof);
    }
}
