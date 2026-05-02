// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BesuLightClientTypes} from "../../contracts/clients/BesuLightClientTypes.sol";
import {IBCEVMTypes} from "../../contracts/core/IBCEVMTypes.sol";
import {IBCPacketHandlerSlots} from "../../contracts/core/IBCPacketHandlerSlots.sol";
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

    function testRecvPacketFromStorageProofRevertsAtTimeoutHeight() public {
        IBCPacketLib.Packet memory packet = _packet();
        address packetStore = address(0xA11CE);
        BuiltPacketStorageProof memory built = _buildPacketStorageProof(packetStore, packet);
        clientB.setTrustedStateRoot(CHAIN_A, TRUSTED_HEIGHT_A, built.stateRoot);
        handlerB.setTrustedPacketStore(CHAIN_A, packetStore);

        (IBCEVMTypes.StorageProof memory leafProof, IBCEVMTypes.StorageProof memory pathProof) =
            _packetProofs(packet, packetStore, TRUSTED_HEIGHT_A, built);

        vm.roll(packet.timeout.height);

        vm.expectRevert(bytes("PACKET_TIMEOUT_HEIGHT_EXPIRED"));
        handlerB.recvPacketFromStorageProof(packet, leafProof, pathProof);
    }

    function testRecvPacketFromStorageProofRevertsAtTimeoutTimestamp() public {
        IBCPacketLib.Packet memory packet = _packet();
        packet.timeout.height = 0;
        packet.timeout.timestamp = 1_800_000_000;
        address packetStore = address(0xA11CE);
        BuiltPacketStorageProof memory built = _buildPacketStorageProof(packetStore, packet);
        clientB.setTrustedStateRoot(CHAIN_A, TRUSTED_HEIGHT_A, built.stateRoot);
        handlerB.setTrustedPacketStore(CHAIN_A, packetStore);

        (IBCEVMTypes.StorageProof memory leafProof, IBCEVMTypes.StorageProof memory pathProof) =
            _packetProofs(packet, packetStore, TRUSTED_HEIGHT_A, built);

        vm.warp(packet.timeout.timestamp);

        vm.expectRevert(bytes("PACKET_TIMEOUT_TIMESTAMP_EXPIRED"));
        handlerB.recvPacketFromStorageProof(packet, leafProof, pathProof);
    }

    function testRecvPacketFromStorageProofAcceptsBeforeTimeoutHeightAndTimestamp() public {
        IBCPacketLib.Packet memory packet = _packet();
        packet.timeout.height = 101;
        packet.timeout.timestamp = 1_800_000_000;
        address packetStore = address(0xA11CE);
        BuiltPacketStorageProof memory built = _buildPacketStorageProof(packetStore, packet);
        clientB.setTrustedStateRoot(CHAIN_A, TRUSTED_HEIGHT_A, built.stateRoot);
        handlerB.setTrustedPacketStore(CHAIN_A, packetStore);

        (IBCEVMTypes.StorageProof memory leafProof, IBCEVMTypes.StorageProof memory pathProof) =
            _packetProofs(packet, packetStore, TRUSTED_HEIGHT_A, built);

        vm.roll(packet.timeout.height - 1);
        vm.warp(packet.timeout.timestamp - 1);

        bytes32 packetId = IBCPacketLib.packetId(packet);
        handlerB.recvPacketFromStorageProof(packet, leafProof, pathProof);

        assertTrue(handlerB.packetReceipts(packetId));
        assertEq(receiver.receiveCount(), 1);
    }

    function testReceivedPacketCannotAlsoTimeoutRefund() public {
        IBCPacketLib.Packet memory packet = _packet();
        bytes32 packetId = IBCPacketLib.packetId(packet);
        address packetStore = address(0xA11CE);
        BuiltPacketStorageProof memory receiveBuilt = _buildPacketStorageProof(packetStore, packet);
        clientB.setTrustedStateRoot(CHAIN_A, TRUSTED_HEIGHT_A, receiveBuilt.stateRoot);
        handlerB.setTrustedPacketStore(CHAIN_A, packetStore);

        (IBCEVMTypes.StorageProof memory leafProof, IBCEVMTypes.StorageProof memory pathProof) =
            _packetProofs(packet, packetStore, TRUSTED_HEIGHT_A, receiveBuilt);

        handlerB.recvPacketFromStorageProof(packet, leafProof, pathProof);
        assertTrue(handlerB.packetReceipts(packetId));

        BuiltSingleStorageProof memory receiptBuilt = _buildSingleStorageProof(
            address(handlerB),
            IBCPacketHandlerSlots.packetReceipt(packetId),
            bytes32(uint256(1))
        );
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B, receiptBuilt.stateRoot);
        IBCEVMTypes.StorageProof memory receiptAbsenceProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B,
            address(handlerB),
            IBCPacketHandlerSlots.packetReceipt(packetId),
            receiptBuilt
        );

        vm.expectRevert(bytes("INVALID_RECEIPT_ABSENCE_PROOF"));
        handlerA.timeoutPacketFromStorageProof(packet, address(handlerB), receiptAbsenceProof);

        assertFalse(handlerA.packetTimeouts(packetId));
        assertEq(sourceApp.timeoutCount(), 0);
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

    function testRecvPacketFromStorageProofRejectsUntrustedStateRoot() public {
        IBCPacketLib.Packet memory packet = _packet();
        address packetStore = address(0xA11CE);
        BuiltPacketStorageProof memory built = _buildPacketStorageProof(packetStore, packet);
        handlerB.setTrustedPacketStore(CHAIN_A, packetStore);

        (IBCEVMTypes.StorageProof memory leafProof, IBCEVMTypes.StorageProof memory pathProof) =
            _packetProofs(packet, packetStore, TRUSTED_HEIGHT_A, built);

        vm.expectRevert(bytes("INVALID_PACKET_STORAGE_PROOF"));
        handlerB.recvPacketFromStorageProof(packet, leafProof, pathProof);
    }

    function testRecvPacketFromStorageProofRejectsFrozenClient() public {
        IBCPacketLib.Packet memory packet = _packet();
        address packetStore = address(0xA11CE);
        BuiltPacketStorageProof memory built = _buildPacketStorageProof(packetStore, packet);
        clientB.setTrustedStateRoot(CHAIN_A, TRUSTED_HEIGHT_A, built.stateRoot);
        clientB.setStatus(CHAIN_A, BesuLightClientTypes.ClientStatus.Frozen);
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
