// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BesuLightClientTypes} from "../../contracts/clients/BesuLightClientTypes.sol";
import {IBCEVMTypes} from "../../contracts/core/IBCEVMTypes.sol";
import {IBCPacketHandlerSlots} from "../../contracts/core/IBCPacketHandlerSlots.sol";
import {IBCPacketLib} from "../../contracts/core/IBCPacketLib.sol";
import {PacketHandlerFixture} from "../helpers/PacketHandlerFixture.sol";

contract PacketTimeoutTest is PacketHandlerFixture {
    function testTimeoutPacketFromStorageProofMarksTimedOutAndCallsSourceApp() public {
        IBCPacketLib.Packet memory packet = _packet();
        bytes32 packetId = IBCPacketLib.packetId(packet);
        address remotePacketHandler = address(0xB0B);

        BuiltSingleStorageProof memory built = _buildSingleStorageProof(
            remotePacketHandler,
            IBCPacketHandlerSlots.acknowledgementHash(packetId),
            keccak256("unrelated-existing-slot")
        );
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B, built.stateRoot);

        IBCEVMTypes.StorageProof memory receiptAbsenceProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B,
            remotePacketHandler,
            IBCPacketHandlerSlots.packetReceipt(packetId),
            built
        );

        handlerA.timeoutPacketFromStorageProof(packet, remotePacketHandler, receiptAbsenceProof);

        assertTrue(handlerA.packetTimeouts(packetId));
        assertEq(sourceApp.timeoutCount(), 1);
        assertEq(sourceApp.lastTimedOutPacketId(), packetId);
    }

    function testTimeoutPacketFromStorageProofRejectsExistingReceipt() public {
        IBCPacketLib.Packet memory packet = _packet();
        bytes32 packetId = IBCPacketLib.packetId(packet);
        address remotePacketHandler = address(0xB0B);

        BuiltSingleStorageProof memory built = _buildSingleStorageProof(
            remotePacketHandler,
            IBCPacketHandlerSlots.packetReceipt(packetId),
            bytes32(uint256(1))
        );
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B, built.stateRoot);

        IBCEVMTypes.StorageProof memory receiptAbsenceProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B,
            remotePacketHandler,
            IBCPacketHandlerSlots.packetReceipt(packetId),
            built
        );

        vm.expectRevert(bytes("INVALID_RECEIPT_ABSENCE_PROOF"));
        handlerA.timeoutPacketFromStorageProof(packet, remotePacketHandler, receiptAbsenceProof);
    }

    function testTimeoutPacketFromStorageProofRejectsFrozenClient() public {
        IBCPacketLib.Packet memory packet = _packet();
        bytes32 packetId = IBCPacketLib.packetId(packet);
        address remotePacketHandler = address(0xB0B);

        BuiltSingleStorageProof memory built = _buildSingleStorageProof(
            remotePacketHandler,
            IBCPacketHandlerSlots.acknowledgementHash(packetId),
            keccak256("unrelated-existing-slot")
        );
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B, built.stateRoot);
        clientA.setStatus(CHAIN_B, BesuLightClientTypes.ClientStatus.Frozen);

        IBCEVMTypes.StorageProof memory receiptAbsenceProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B,
            remotePacketHandler,
            IBCPacketHandlerSlots.packetReceipt(packetId),
            built
        );

        vm.expectRevert(bytes("INVALID_RECEIPT_ABSENCE_PROOF"));
        handlerA.timeoutPacketFromStorageProof(packet, remotePacketHandler, receiptAbsenceProof);
    }

    function testTimeoutPacketFromStorageProofRejectsWrongTrustedHeight() public {
        IBCPacketLib.Packet memory packet = _packet();
        bytes32 packetId = IBCPacketLib.packetId(packet);
        address remotePacketHandler = address(0xB0B);

        BuiltSingleStorageProof memory built = _buildSingleStorageProof(
            remotePacketHandler,
            IBCPacketHandlerSlots.acknowledgementHash(packetId),
            keccak256("unrelated-existing-slot")
        );
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B + 1, built.stateRoot);

        IBCEVMTypes.StorageProof memory receiptAbsenceProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B,
            remotePacketHandler,
            IBCPacketHandlerSlots.packetReceipt(packetId),
            built
        );

        vm.expectRevert(bytes("INVALID_RECEIPT_ABSENCE_PROOF"));
        handlerA.timeoutPacketFromStorageProof(packet, remotePacketHandler, receiptAbsenceProof);
    }

    function testTimeoutPacketFromStorageProofRejectsBeforeTimeoutHeight() public {
        IBCPacketLib.Packet memory packet = _packet();
        packet.sequence = 2;
        packet.timeout.height = uint64(TRUSTED_HEIGHT_B + 1);
        bytes32 packetId = IBCPacketLib.packetId(packet);
        localPacketStore.commitPacket(packet);
        address remotePacketHandler = address(0xB0B);

        BuiltSingleStorageProof memory built = _buildSingleStorageProof(
            remotePacketHandler,
            IBCPacketHandlerSlots.acknowledgementHash(packetId),
            keccak256("unrelated-existing-slot")
        );
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B, built.stateRoot);

        IBCEVMTypes.StorageProof memory receiptAbsenceProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B,
            remotePacketHandler,
            IBCPacketHandlerSlots.packetReceipt(packetId),
            built
        );

        vm.expectRevert(bytes("PACKET_NOT_TIMED_OUT"));
        handlerA.timeoutPacketFromStorageProof(packet, remotePacketHandler, receiptAbsenceProof);
    }

    function testTimeoutPacketFromStorageProofAcceptsTimestampTimeout() public {
        IBCPacketLib.Packet memory packet = _packet();
        packet.sequence = 2;
        packet.timeout.height = 0;
        packet.timeout.timestamp = 1_800_000_000;
        bytes32 packetId = IBCPacketLib.packetId(packet);
        localPacketStore.commitPacket(packet);
        address remotePacketHandler = address(0xB0B);

        BuiltSingleStorageProof memory built = _buildSingleStorageProof(
            remotePacketHandler,
            IBCPacketHandlerSlots.acknowledgementHash(packetId),
            keccak256("unrelated-existing-slot")
        );
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B, built.stateRoot);
        clientA.setTrustedTimestamp(CHAIN_B, TRUSTED_HEIGHT_B, 1_800_000_000);

        IBCEVMTypes.StorageProof memory receiptAbsenceProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B,
            remotePacketHandler,
            IBCPacketHandlerSlots.packetReceipt(packetId),
            built
        );

        handlerA.timeoutPacketFromStorageProof(packet, remotePacketHandler, receiptAbsenceProof);

        assertTrue(handlerA.packetTimeouts(packetId));
        assertEq(sourceApp.timeoutCount(), 1);
        assertEq(sourceApp.lastTimedOutPacketId(), packetId);
    }

    function testTimeoutPacketFromStorageProofRejectsBeforeTimestampTimeout() public {
        IBCPacketLib.Packet memory packet = _packet();
        packet.sequence = 2;
        packet.timeout.height = 0;
        packet.timeout.timestamp = 1_800_000_000;
        bytes32 packetId = IBCPacketLib.packetId(packet);
        localPacketStore.commitPacket(packet);
        address remotePacketHandler = address(0xB0B);

        BuiltSingleStorageProof memory built = _buildSingleStorageProof(
            remotePacketHandler,
            IBCPacketHandlerSlots.acknowledgementHash(packetId),
            keccak256("unrelated-existing-slot")
        );
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B, built.stateRoot);
        clientA.setTrustedTimestamp(CHAIN_B, TRUSTED_HEIGHT_B, 1_799_999_999);

        IBCEVMTypes.StorageProof memory receiptAbsenceProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B,
            remotePacketHandler,
            IBCPacketHandlerSlots.packetReceipt(packetId),
            built
        );

        vm.expectRevert(bytes("PACKET_NOT_TIMED_OUT"));
        handlerA.timeoutPacketFromStorageProof(packet, remotePacketHandler, receiptAbsenceProof);
    }

    function testTimeoutPacketFromStorageProofBlocksReplayAndLateAck() public {
        IBCPacketLib.Packet memory packet = _packet();
        bytes32 packetId = IBCPacketLib.packetId(packet);
        address remotePacketHandler = address(0xB0B);

        BuiltSingleStorageProof memory absenceBuilt = _buildSingleStorageProof(
            remotePacketHandler,
            IBCPacketHandlerSlots.acknowledgementHash(packetId),
            keccak256("unrelated-existing-slot")
        );
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B, absenceBuilt.stateRoot);

        IBCEVMTypes.StorageProof memory receiptAbsenceProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B,
            remotePacketHandler,
            IBCPacketHandlerSlots.packetReceipt(packetId),
            absenceBuilt
        );

        handlerA.timeoutPacketFromStorageProof(packet, remotePacketHandler, receiptAbsenceProof);

        vm.expectRevert(bytes("PACKET_ALREADY_TIMED_OUT"));
        handlerA.timeoutPacketFromStorageProof(packet, remotePacketHandler, receiptAbsenceProof);

        bytes memory acknowledgement = abi.encodePacked("ok:", packetId);
        bytes32 acknowledgementHash = keccak256(acknowledgement);
        BuiltSingleStorageProof memory ackBuilt =
            _buildSingleStorageProof(remotePacketHandler, IBCPacketHandlerSlots.acknowledgementHash(packetId), acknowledgementHash);
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B + 1, ackBuilt.stateRoot);

        IBCEVMTypes.StorageProof memory acknowledgementProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B + 1,
            remotePacketHandler,
            IBCPacketHandlerSlots.acknowledgementHash(packetId),
            ackBuilt
        );

        vm.expectRevert(bytes("PACKET_ALREADY_TIMED_OUT"));
        handlerA.acknowledgePacketFromStorageProof(packet, acknowledgement, remotePacketHandler, acknowledgementProof);
    }

    function testTimeoutPacketFromStorageProofRejectsUncommittedPacket() public {
        IBCPacketLib.Packet memory packet = _packet();
        packet.sequence = 2;
        bytes32 packetId = IBCPacketLib.packetId(packet);
        address remotePacketHandler = address(0xB0B);

        BuiltSingleStorageProof memory built = _buildSingleStorageProof(
            remotePacketHandler,
            IBCPacketHandlerSlots.acknowledgementHash(packetId),
            keccak256("unrelated-existing-slot")
        );
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B, built.stateRoot);

        IBCEVMTypes.StorageProof memory receiptAbsenceProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B,
            remotePacketHandler,
            IBCPacketHandlerSlots.packetReceipt(packetId),
            built
        );

        vm.expectRevert(bytes("PACKET_NOT_COMMITTED"));
        handlerA.timeoutPacketFromStorageProof(packet, remotePacketHandler, receiptAbsenceProof);
    }
}
