// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCEVMTypesV2} from "../../contracts/v2/core/IBCEVMTypesV2.sol";
import {IBCPacketHandlerSlotsV2} from "../../contracts/v2/core/IBCPacketHandlerSlotsV2.sol";
import {IBCPacketLibV2} from "../../contracts/v2/core/IBCPacketLibV2.sol";
import {PacketHandlerV2Fixture} from "./helpers/PacketHandlerV2Fixture.sol";

contract PacketTimeoutV2Test is PacketHandlerV2Fixture {
    function testTimeoutPacketFromStorageProofMarksTimedOutAndCallsSourceApp() public {
        IBCPacketLibV2.Packet memory packet = _packet();
        bytes32 packetId = IBCPacketLibV2.packetId(packet);
        address remotePacketHandler = address(0xB0B);

        BuiltSingleStorageProof memory built = _buildSingleStorageProof(
            remotePacketHandler,
            IBCPacketHandlerSlotsV2.acknowledgementHash(packetId),
            keccak256("unrelated-existing-slot")
        );
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B, built.stateRoot);

        IBCEVMTypesV2.StorageProof memory receiptAbsenceProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B,
            remotePacketHandler,
            IBCPacketHandlerSlotsV2.packetReceipt(packetId),
            built
        );

        handlerA.timeoutPacketFromStorageProof(packet, remotePacketHandler, receiptAbsenceProof);

        assertTrue(handlerA.packetTimeouts(packetId));
        assertEq(sourceApp.timeoutCount(), 1);
        assertEq(sourceApp.lastTimedOutPacketId(), packetId);
    }

    function testTimeoutPacketFromStorageProofRejectsExistingReceipt() public {
        IBCPacketLibV2.Packet memory packet = _packet();
        bytes32 packetId = IBCPacketLibV2.packetId(packet);
        address remotePacketHandler = address(0xB0B);

        BuiltSingleStorageProof memory built = _buildSingleStorageProof(
            remotePacketHandler,
            IBCPacketHandlerSlotsV2.packetReceipt(packetId),
            bytes32(uint256(1))
        );
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B, built.stateRoot);

        IBCEVMTypesV2.StorageProof memory receiptAbsenceProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B,
            remotePacketHandler,
            IBCPacketHandlerSlotsV2.packetReceipt(packetId),
            built
        );

        vm.expectRevert(bytes("INVALID_RECEIPT_ABSENCE_PROOF"));
        handlerA.timeoutPacketFromStorageProof(packet, remotePacketHandler, receiptAbsenceProof);
    }

    function testTimeoutPacketFromStorageProofRejectsWrongTrustedHeight() public {
        IBCPacketLibV2.Packet memory packet = _packet();
        bytes32 packetId = IBCPacketLibV2.packetId(packet);
        address remotePacketHandler = address(0xB0B);

        BuiltSingleStorageProof memory built = _buildSingleStorageProof(
            remotePacketHandler,
            IBCPacketHandlerSlotsV2.acknowledgementHash(packetId),
            keccak256("unrelated-existing-slot")
        );
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B + 1, built.stateRoot);

        IBCEVMTypesV2.StorageProof memory receiptAbsenceProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B,
            remotePacketHandler,
            IBCPacketHandlerSlotsV2.packetReceipt(packetId),
            built
        );

        vm.expectRevert(bytes("INVALID_RECEIPT_ABSENCE_PROOF"));
        handlerA.timeoutPacketFromStorageProof(packet, remotePacketHandler, receiptAbsenceProof);
    }

    function testTimeoutPacketFromStorageProofRejectsBeforeTimeoutHeight() public {
        IBCPacketLibV2.Packet memory packet = _packet();
        packet.sequence = 2;
        packet.timeout.height = uint64(TRUSTED_HEIGHT_B + 1);
        bytes32 packetId = IBCPacketLibV2.packetId(packet);
        localPacketStore.commitPacket(packet);
        address remotePacketHandler = address(0xB0B);

        BuiltSingleStorageProof memory built = _buildSingleStorageProof(
            remotePacketHandler,
            IBCPacketHandlerSlotsV2.acknowledgementHash(packetId),
            keccak256("unrelated-existing-slot")
        );
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B, built.stateRoot);

        IBCEVMTypesV2.StorageProof memory receiptAbsenceProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B,
            remotePacketHandler,
            IBCPacketHandlerSlotsV2.packetReceipt(packetId),
            built
        );

        vm.expectRevert(bytes("PACKET_NOT_TIMED_OUT"));
        handlerA.timeoutPacketFromStorageProof(packet, remotePacketHandler, receiptAbsenceProof);
    }

    function testTimeoutPacketFromStorageProofAcceptsTimestampTimeout() public {
        IBCPacketLibV2.Packet memory packet = _packet();
        packet.sequence = 2;
        packet.timeout.height = 0;
        packet.timeout.timestamp = 1_800_000_000;
        bytes32 packetId = IBCPacketLibV2.packetId(packet);
        localPacketStore.commitPacket(packet);
        address remotePacketHandler = address(0xB0B);

        BuiltSingleStorageProof memory built = _buildSingleStorageProof(
            remotePacketHandler,
            IBCPacketHandlerSlotsV2.acknowledgementHash(packetId),
            keccak256("unrelated-existing-slot")
        );
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B, built.stateRoot);
        clientA.setTrustedTimestamp(CHAIN_B, TRUSTED_HEIGHT_B, 1_800_000_000);

        IBCEVMTypesV2.StorageProof memory receiptAbsenceProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B,
            remotePacketHandler,
            IBCPacketHandlerSlotsV2.packetReceipt(packetId),
            built
        );

        handlerA.timeoutPacketFromStorageProof(packet, remotePacketHandler, receiptAbsenceProof);

        assertTrue(handlerA.packetTimeouts(packetId));
        assertEq(sourceApp.timeoutCount(), 1);
        assertEq(sourceApp.lastTimedOutPacketId(), packetId);
    }

    function testTimeoutPacketFromStorageProofRejectsBeforeTimestampTimeout() public {
        IBCPacketLibV2.Packet memory packet = _packet();
        packet.sequence = 2;
        packet.timeout.height = 0;
        packet.timeout.timestamp = 1_800_000_000;
        bytes32 packetId = IBCPacketLibV2.packetId(packet);
        localPacketStore.commitPacket(packet);
        address remotePacketHandler = address(0xB0B);

        BuiltSingleStorageProof memory built = _buildSingleStorageProof(
            remotePacketHandler,
            IBCPacketHandlerSlotsV2.acknowledgementHash(packetId),
            keccak256("unrelated-existing-slot")
        );
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B, built.stateRoot);
        clientA.setTrustedTimestamp(CHAIN_B, TRUSTED_HEIGHT_B, 1_799_999_999);

        IBCEVMTypesV2.StorageProof memory receiptAbsenceProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B,
            remotePacketHandler,
            IBCPacketHandlerSlotsV2.packetReceipt(packetId),
            built
        );

        vm.expectRevert(bytes("PACKET_NOT_TIMED_OUT"));
        handlerA.timeoutPacketFromStorageProof(packet, remotePacketHandler, receiptAbsenceProof);
    }

    function testTimeoutPacketFromStorageProofBlocksReplayAndLateAck() public {
        IBCPacketLibV2.Packet memory packet = _packet();
        bytes32 packetId = IBCPacketLibV2.packetId(packet);
        address remotePacketHandler = address(0xB0B);

        BuiltSingleStorageProof memory absenceBuilt = _buildSingleStorageProof(
            remotePacketHandler,
            IBCPacketHandlerSlotsV2.acknowledgementHash(packetId),
            keccak256("unrelated-existing-slot")
        );
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B, absenceBuilt.stateRoot);

        IBCEVMTypesV2.StorageProof memory receiptAbsenceProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B,
            remotePacketHandler,
            IBCPacketHandlerSlotsV2.packetReceipt(packetId),
            absenceBuilt
        );

        handlerA.timeoutPacketFromStorageProof(packet, remotePacketHandler, receiptAbsenceProof);

        vm.expectRevert(bytes("PACKET_ALREADY_TIMED_OUT"));
        handlerA.timeoutPacketFromStorageProof(packet, remotePacketHandler, receiptAbsenceProof);

        bytes memory acknowledgement = abi.encodePacked("ok:", packetId);
        bytes32 acknowledgementHash = keccak256(acknowledgement);
        BuiltSingleStorageProof memory ackBuilt =
            _buildSingleStorageProof(remotePacketHandler, IBCPacketHandlerSlotsV2.acknowledgementHash(packetId), acknowledgementHash);
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B + 1, ackBuilt.stateRoot);

        IBCEVMTypesV2.StorageProof memory acknowledgementProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B + 1,
            remotePacketHandler,
            IBCPacketHandlerSlotsV2.acknowledgementHash(packetId),
            ackBuilt
        );

        vm.expectRevert(bytes("PACKET_ALREADY_TIMED_OUT"));
        handlerA.acknowledgePacketFromStorageProof(packet, acknowledgement, remotePacketHandler, acknowledgementProof);
    }

    function testTimeoutPacketFromStorageProofRejectsUncommittedPacket() public {
        IBCPacketLibV2.Packet memory packet = _packet();
        packet.sequence = 2;
        bytes32 packetId = IBCPacketLibV2.packetId(packet);
        address remotePacketHandler = address(0xB0B);

        BuiltSingleStorageProof memory built = _buildSingleStorageProof(
            remotePacketHandler,
            IBCPacketHandlerSlotsV2.acknowledgementHash(packetId),
            keccak256("unrelated-existing-slot")
        );
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B, built.stateRoot);

        IBCEVMTypesV2.StorageProof memory receiptAbsenceProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B,
            remotePacketHandler,
            IBCPacketHandlerSlotsV2.packetReceipt(packetId),
            built
        );

        vm.expectRevert(bytes("PACKET_NOT_COMMITTED"));
        handlerA.timeoutPacketFromStorageProof(packet, remotePacketHandler, receiptAbsenceProof);
    }
}
