// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCEVMTypesV2} from "../../contracts/v2/core/IBCEVMTypesV2.sol";
import {IBCPacketHandlerSlotsV2} from "../../contracts/v2/core/IBCPacketHandlerSlotsV2.sol";
import {IBCPacketLibV2} from "../../contracts/v2/core/IBCPacketLibV2.sol";
import {PacketHandlerV2Fixture} from "./helpers/PacketHandlerV2Fixture.sol";

contract PacketAcknowledgementV2Test is PacketHandlerV2Fixture {
    function testStorageProofBuilderUsesCanonicalRlpForLeadingZeroWord() public view {
        bytes32 storageWord = bytes32(uint256(0x1234));
        BuiltSingleStorageProof memory built =
            _buildSingleStorageProof(address(0xB0B), bytes32("slot"), storageWord);

        assertEq(built.expectedTrieValue, IBCEVMTypesV2.rlpEncodeWord(storageWord));
        assertEq(built.expectedTrieValue, hex"821234");
        assertEq(IBCEVMTypesV2.rlpEncodeWord(bytes32(0)), hex"80");
        assertEq(IBCEVMTypesV2.rlpEncodeWord(bytes32(uint256(0x7f))), hex"7f");
        assertEq(IBCEVMTypesV2.rlpEncodeWord(bytes32(uint256(0x80))), hex"8180");
    }

    function testAcknowledgePacketFromStorageProofMarksSourceAcknowledged() public {
        IBCPacketLibV2.Packet memory packet = _packet();
        bytes32 packetId = IBCPacketLibV2.packetId(packet);
        bytes memory acknowledgement = abi.encodePacked("ok:", packetId);
        bytes32 acknowledgementHash = keccak256(acknowledgement);
        address remotePacketHandler = address(0xB0B);

        BuiltSingleStorageProof memory built =
            _buildSingleStorageProof(remotePacketHandler, IBCPacketHandlerSlotsV2.acknowledgementHash(packetId), acknowledgementHash);
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B, built.stateRoot);

        IBCEVMTypesV2.StorageProof memory acknowledgementProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B,
            remotePacketHandler,
            IBCPacketHandlerSlotsV2.acknowledgementHash(packetId),
            built
        );

        handlerA.acknowledgePacketFromStorageProof(packet, acknowledgement, remotePacketHandler, acknowledgementProof);

        assertTrue(handlerA.packetAcknowledgements(packetId));
        assertEq(handlerA.acknowledgementHashes(packetId), acknowledgementHash);
        assertEq(sourceApp.acknowledgementCount(), 1);
        assertEq(sourceApp.lastPacketId(), packetId);
        assertEq(sourceApp.lastAcknowledgementHash(), acknowledgementHash);
    }

    function testAcknowledgePacketFromStorageProofRejectsInvalidStorageProof() public {
        IBCPacketLibV2.Packet memory packet = _packet();
        bytes32 packetId = IBCPacketLibV2.packetId(packet);
        bytes memory acknowledgement = abi.encodePacked("ok:", packetId);
        bytes32 acknowledgementHash = keccak256(acknowledgement);
        address remotePacketHandler = address(0xB0B);

        BuiltSingleStorageProof memory built = _buildSingleStorageProof(
            remotePacketHandler,
            IBCPacketHandlerSlotsV2.acknowledgementHash(packetId),
            keccak256("wrong-ack")
        );
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B, built.stateRoot);

        IBCEVMTypesV2.StorageProof memory acknowledgementProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B,
            remotePacketHandler,
            IBCPacketHandlerSlotsV2.acknowledgementHash(packetId),
            built
        );
        acknowledgementProof.expectedValue = IBCEVMTypesV2.rlpEncodeWord(acknowledgementHash);

        vm.expectRevert(bytes("INVALID_ACK_STORAGE_PROOF"));
        handlerA.acknowledgePacketFromStorageProof(packet, acknowledgement, remotePacketHandler, acknowledgementProof);
    }

    function testAcknowledgePacketFromStorageProofBlocksReplay() public {
        IBCPacketLibV2.Packet memory packet = _packet();
        bytes32 packetId = IBCPacketLibV2.packetId(packet);
        bytes memory acknowledgement = abi.encodePacked("ok:", packetId);
        bytes32 acknowledgementHash = keccak256(acknowledgement);
        address remotePacketHandler = address(0xB0B);

        BuiltSingleStorageProof memory built =
            _buildSingleStorageProof(remotePacketHandler, IBCPacketHandlerSlotsV2.acknowledgementHash(packetId), acknowledgementHash);
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B, built.stateRoot);

        IBCEVMTypesV2.StorageProof memory acknowledgementProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B,
            remotePacketHandler,
            IBCPacketHandlerSlotsV2.acknowledgementHash(packetId),
            built
        );

        handlerA.acknowledgePacketFromStorageProof(packet, acknowledgement, remotePacketHandler, acknowledgementProof);

        vm.expectRevert(bytes("PACKET_ALREADY_ACKNOWLEDGED"));
        handlerA.acknowledgePacketFromStorageProof(packet, acknowledgement, remotePacketHandler, acknowledgementProof);
    }

    function testAcknowledgePacketFromStorageProofRejectsClosedChannel() public {
        IBCPacketLibV2.Packet memory packet = _packet();
        bytes32 packetId = IBCPacketLibV2.packetId(packet);
        bytes memory acknowledgement = abi.encodePacked("ok:", packetId);
        bytes32 acknowledgementHash = keccak256(acknowledgement);
        address remotePacketHandler = address(0xB0B);
        channelKeeperA.closeChannel(bytes32("channel-a"));

        BuiltSingleStorageProof memory built =
            _buildSingleStorageProof(remotePacketHandler, IBCPacketHandlerSlotsV2.acknowledgementHash(packetId), acknowledgementHash);
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B, built.stateRoot);

        IBCEVMTypesV2.StorageProof memory acknowledgementProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B,
            remotePacketHandler,
            IBCPacketHandlerSlotsV2.acknowledgementHash(packetId),
            built
        );

        vm.expectRevert(bytes("CHANNEL_NOT_OPEN"));
        handlerA.acknowledgePacketFromStorageProof(packet, acknowledgement, remotePacketHandler, acknowledgementProof);
    }

    function testAcknowledgePacketFromStorageProofRejectsUncommittedPacket() public {
        IBCPacketLibV2.Packet memory packet = _packet();
        packet.sequence = 2;
        bytes32 packetId = IBCPacketLibV2.packetId(packet);
        bytes memory acknowledgement = abi.encodePacked("ok:", packetId);
        bytes32 acknowledgementHash = keccak256(acknowledgement);
        address remotePacketHandler = address(0xB0B);

        BuiltSingleStorageProof memory built =
            _buildSingleStorageProof(remotePacketHandler, IBCPacketHandlerSlotsV2.acknowledgementHash(packetId), acknowledgementHash);
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B, built.stateRoot);

        IBCEVMTypesV2.StorageProof memory acknowledgementProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B,
            remotePacketHandler,
            IBCPacketHandlerSlotsV2.acknowledgementHash(packetId),
            built
        );

        vm.expectRevert(bytes("PACKET_NOT_COMMITTED"));
        handlerA.acknowledgePacketFromStorageProof(packet, acknowledgement, remotePacketHandler, acknowledgementProof);
    }
}
