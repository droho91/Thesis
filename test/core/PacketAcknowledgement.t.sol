// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCEVMTypes} from "../../contracts/core/IBCEVMTypes.sol";
import {IBCPacketHandlerSlots} from "../../contracts/core/IBCPacketHandlerSlots.sol";
import {IBCPacketLib} from "../../contracts/core/IBCPacketLib.sol";
import {PacketHandlerFixture} from "../helpers/PacketHandlerFixture.sol";

contract PacketAcknowledgementTest is PacketHandlerFixture {
    function testStorageProofBuilderUsesCanonicalRlpForLeadingZeroWord() public view {
        bytes32 storageWord = bytes32(uint256(0x1234));
        BuiltSingleStorageProof memory built =
            _buildSingleStorageProof(address(0xB0B), bytes32("slot"), storageWord);

        assertEq(built.expectedTrieValue, IBCEVMTypes.rlpEncodeWord(storageWord));
        assertEq(built.expectedTrieValue, hex"821234");
        assertEq(IBCEVMTypes.rlpEncodeWord(bytes32(0)), hex"80");
        assertEq(IBCEVMTypes.rlpEncodeWord(bytes32(uint256(0x7f))), hex"7f");
        assertEq(IBCEVMTypes.rlpEncodeWord(bytes32(uint256(0x80))), hex"8180");
    }

    function testAcknowledgePacketFromStorageProofMarksSourceAcknowledged() public {
        IBCPacketLib.Packet memory packet = _packet();
        bytes32 packetId = IBCPacketLib.packetId(packet);
        bytes memory acknowledgement = abi.encodePacked("ok:", packetId);
        bytes32 acknowledgementHash = keccak256(acknowledgement);
        address remotePacketHandler = address(0xB0B);

        BuiltSingleStorageProof memory built =
            _buildSingleStorageProof(remotePacketHandler, IBCPacketHandlerSlots.acknowledgementHash(packetId), acknowledgementHash);
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B, built.stateRoot);

        IBCEVMTypes.StorageProof memory acknowledgementProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B,
            remotePacketHandler,
            IBCPacketHandlerSlots.acknowledgementHash(packetId),
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
        IBCPacketLib.Packet memory packet = _packet();
        bytes32 packetId = IBCPacketLib.packetId(packet);
        bytes memory acknowledgement = abi.encodePacked("ok:", packetId);
        bytes32 acknowledgementHash = keccak256(acknowledgement);
        address remotePacketHandler = address(0xB0B);

        BuiltSingleStorageProof memory built = _buildSingleStorageProof(
            remotePacketHandler,
            IBCPacketHandlerSlots.acknowledgementHash(packetId),
            keccak256("wrong-ack")
        );
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B, built.stateRoot);

        IBCEVMTypes.StorageProof memory acknowledgementProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B,
            remotePacketHandler,
            IBCPacketHandlerSlots.acknowledgementHash(packetId),
            built
        );
        acknowledgementProof.expectedValue = IBCEVMTypes.rlpEncodeWord(acknowledgementHash);

        vm.expectRevert(bytes("INVALID_ACK_STORAGE_PROOF"));
        handlerA.acknowledgePacketFromStorageProof(packet, acknowledgement, remotePacketHandler, acknowledgementProof);
    }

    function testAcknowledgePacketFromStorageProofBlocksReplay() public {
        IBCPacketLib.Packet memory packet = _packet();
        bytes32 packetId = IBCPacketLib.packetId(packet);
        bytes memory acknowledgement = abi.encodePacked("ok:", packetId);
        bytes32 acknowledgementHash = keccak256(acknowledgement);
        address remotePacketHandler = address(0xB0B);

        BuiltSingleStorageProof memory built =
            _buildSingleStorageProof(remotePacketHandler, IBCPacketHandlerSlots.acknowledgementHash(packetId), acknowledgementHash);
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B, built.stateRoot);

        IBCEVMTypes.StorageProof memory acknowledgementProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B,
            remotePacketHandler,
            IBCPacketHandlerSlots.acknowledgementHash(packetId),
            built
        );

        handlerA.acknowledgePacketFromStorageProof(packet, acknowledgement, remotePacketHandler, acknowledgementProof);

        vm.expectRevert(bytes("PACKET_ALREADY_ACKNOWLEDGED"));
        handlerA.acknowledgePacketFromStorageProof(packet, acknowledgement, remotePacketHandler, acknowledgementProof);
    }

    function testAcknowledgePacketFromStorageProofRejectsClosedChannel() public {
        IBCPacketLib.Packet memory packet = _packet();
        bytes32 packetId = IBCPacketLib.packetId(packet);
        bytes memory acknowledgement = abi.encodePacked("ok:", packetId);
        bytes32 acknowledgementHash = keccak256(acknowledgement);
        address remotePacketHandler = address(0xB0B);
        channelKeeperA.closeChannel(bytes32("channel-a"));

        BuiltSingleStorageProof memory built =
            _buildSingleStorageProof(remotePacketHandler, IBCPacketHandlerSlots.acknowledgementHash(packetId), acknowledgementHash);
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B, built.stateRoot);

        IBCEVMTypes.StorageProof memory acknowledgementProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B,
            remotePacketHandler,
            IBCPacketHandlerSlots.acknowledgementHash(packetId),
            built
        );

        vm.expectRevert(bytes("CHANNEL_NOT_OPEN"));
        handlerA.acknowledgePacketFromStorageProof(packet, acknowledgement, remotePacketHandler, acknowledgementProof);
    }

    function testAcknowledgePacketFromStorageProofRejectsUncommittedPacket() public {
        IBCPacketLib.Packet memory packet = _packet();
        packet.sequence = 2;
        bytes32 packetId = IBCPacketLib.packetId(packet);
        bytes memory acknowledgement = abi.encodePacked("ok:", packetId);
        bytes32 acknowledgementHash = keccak256(acknowledgement);
        address remotePacketHandler = address(0xB0B);

        BuiltSingleStorageProof memory built =
            _buildSingleStorageProof(remotePacketHandler, IBCPacketHandlerSlots.acknowledgementHash(packetId), acknowledgementHash);
        clientA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B, built.stateRoot);

        IBCEVMTypes.StorageProof memory acknowledgementProof = _singleProof(
            CHAIN_B,
            TRUSTED_HEIGHT_B,
            remotePacketHandler,
            IBCPacketHandlerSlots.acknowledgementHash(packetId),
            built
        );

        vm.expectRevert(bytes("PACKET_NOT_COMMITTED"));
        handlerA.acknowledgePacketFromStorageProof(packet, acknowledgement, remotePacketHandler, acknowledgementProof);
    }
}
