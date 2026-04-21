// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCChannelKeeper} from "../../contracts/core/IBCChannelKeeper.sol";
import {IBCChannelTypes} from "../../contracts/core/IBCChannelTypes.sol";
import {IBCConnectionKeeper} from "../../contracts/core/IBCConnectionKeeper.sol";
import {IBCConnectionTypes} from "../../contracts/core/IBCConnectionTypes.sol";
import {MockBesuLightClient, PacketHandlerFixture} from "../helpers/PacketHandlerFixture.sol";

contract PacketHandshakeTest is PacketHandlerFixture {
    function testOpenChannelRouteUnsafeRequiresOpenConnection() public {
        IBCChannelKeeper keeper = new IBCChannelKeeper(CHAIN_B, address(connectionKeeperB), address(this));

        vm.expectRevert(bytes("CONNECTION_NOT_OPEN"));
        keeper.openChannelRouteUnsafe(
            bytes32("missing-channel"),
            bytes32("missing-connection"),
            CHAIN_A,
            address(sourceApp),
            address(receiver),
            bytes32("channel-a"),
            IBCChannelTypes.Order.Unordered,
            bytes("ics-004")
        );
    }

    function testConnectionProofHandshakeTransitionsBothEndsToOpen() public {
        MockBesuLightClient lightClientOnA = new MockBesuLightClient();
        MockBesuLightClient lightClientOnB = new MockBesuLightClient();
        IBCConnectionKeeper keeperA = new IBCConnectionKeeper(CHAIN_A, address(lightClientOnA), address(this));
        IBCConnectionKeeper keeperB = new IBCConnectionKeeper(CHAIN_B, address(lightClientOnB), address(this));
        bytes32 connectionA = bytes32("connection-a");
        bytes32 connectionB = bytes32("connection-b");
        bytes memory prefix = bytes("ibc");

        keeperA.connectionOpenInit(connectionA, bytes32(uint256(CHAIN_B)), bytes32(uint256(CHAIN_A)), 0, prefix);
        BuiltSingleStorageProof memory initBuilt = _buildSingleStorageProof(
            address(keeperA),
            keeperA.connectionCommitmentStorageSlot(connectionA),
            keeperA.connectionCommitments(connectionA)
        );
        lightClientOnB.setTrustedStateRoot(CHAIN_A, TRUSTED_HEIGHT_A, initBuilt.stateRoot);
        keeperB.connectionOpenTry(
            connectionB,
            bytes32(uint256(CHAIN_A)),
            bytes32(uint256(CHAIN_B)),
            connectionA,
            0,
            prefix,
            address(keeperA),
            _singleProof(CHAIN_A, TRUSTED_HEIGHT_A, address(keeperA), keeperA.connectionCommitmentStorageSlot(connectionA), initBuilt)
        );
        IBCConnectionTypes.ConnectionEnd memory tryEnd = keeperB.connection(connectionB);
        assertEq(uint8(tryEnd.state), uint8(IBCConnectionTypes.State.TryOpen));

        BuiltSingleStorageProof memory tryBuilt = _buildSingleStorageProof(
            address(keeperB),
            keeperB.connectionCommitmentStorageSlot(connectionB),
            keeperB.connectionCommitments(connectionB)
        );
        lightClientOnA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B, tryBuilt.stateRoot);
        keeperA.connectionOpenAck(
            connectionA,
            connectionB,
            address(keeperB),
            _singleProof(CHAIN_B, TRUSTED_HEIGHT_B, address(keeperB), keeperB.connectionCommitmentStorageSlot(connectionB), tryBuilt)
        );
        IBCConnectionTypes.ConnectionEnd memory ackEnd = keeperA.connection(connectionA);
        assertEq(uint8(ackEnd.state), uint8(IBCConnectionTypes.State.Open));

        BuiltSingleStorageProof memory openBuilt = _buildSingleStorageProof(
            address(keeperA),
            keeperA.connectionCommitmentStorageSlot(connectionA),
            keeperA.connectionCommitments(connectionA)
        );
        lightClientOnB.setTrustedStateRoot(CHAIN_A, TRUSTED_HEIGHT_A + 1, openBuilt.stateRoot);
        keeperB.connectionOpenConfirm(
            connectionB,
            address(keeperA),
            _singleProof(
                CHAIN_A,
                TRUSTED_HEIGHT_A + 1,
                address(keeperA),
                keeperA.connectionCommitmentStorageSlot(connectionA),
                openBuilt
            )
        );
        IBCConnectionTypes.ConnectionEnd memory confirmEnd = keeperB.connection(connectionB);
        assertEq(uint8(confirmEnd.state), uint8(IBCConnectionTypes.State.Open));
    }

    function testChannelProofHandshakeTransitionsBothEndsToOpen() public {
        MockBesuLightClient lightClientOnA = new MockBesuLightClient();
        MockBesuLightClient lightClientOnB = new MockBesuLightClient();
        IBCConnectionKeeper keeperA = new IBCConnectionKeeper(CHAIN_A, address(lightClientOnA), address(this));
        IBCConnectionKeeper keeperB = new IBCConnectionKeeper(CHAIN_B, address(lightClientOnB), address(this));
        keeperA.openConnectionUnsafe(
            bytes32("connection-a"),
            bytes32(uint256(CHAIN_B)),
            bytes32(uint256(CHAIN_A)),
            bytes32("connection-b"),
            0,
            bytes("ibc")
        );
        keeperB.openConnectionUnsafe(
            bytes32("connection-b"),
            bytes32(uint256(CHAIN_A)),
            bytes32(uint256(CHAIN_B)),
            bytes32("connection-a"),
            0,
            bytes("ibc")
        );
        IBCChannelKeeper channelsA = new IBCChannelKeeper(CHAIN_A, address(keeperA), address(this));
        IBCChannelKeeper channelsB = new IBCChannelKeeper(CHAIN_B, address(keeperB), address(this));
        bytes32 channelA = bytes32("channel-a");
        bytes32 channelB = bytes32("channel-b");
        bytes memory version = bytes("ics-004");

        channelsA.channelOpenInit(
            channelA,
            bytes32("connection-a"),
            CHAIN_B,
            address(receiver),
            address(sourceApp),
            IBCChannelTypes.Order.Unordered,
            version
        );
        BuiltSingleStorageProof memory initBuilt = _buildSingleStorageProof(
            address(channelsA),
            channelsA.channelCommitmentStorageSlot(channelA),
            channelsA.channelCommitments(channelA)
        );
        lightClientOnB.setTrustedStateRoot(CHAIN_A, TRUSTED_HEIGHT_A, initBuilt.stateRoot);
        channelsB.channelOpenTry(
            channelB,
            bytes32("connection-b"),
            CHAIN_A,
            address(sourceApp),
            address(receiver),
            channelA,
            IBCChannelTypes.Order.Unordered,
            version,
            address(channelsA),
            _singleProof(CHAIN_A, TRUSTED_HEIGHT_A, address(channelsA), channelsA.channelCommitmentStorageSlot(channelA), initBuilt)
        );
        IBCChannelTypes.ChannelEnd memory tryEnd = channelsB.channel(channelB);
        assertEq(uint8(tryEnd.state), uint8(IBCChannelTypes.State.TryOpen));

        BuiltSingleStorageProof memory tryBuilt = _buildSingleStorageProof(
            address(channelsB),
            channelsB.channelCommitmentStorageSlot(channelB),
            channelsB.channelCommitments(channelB)
        );
        lightClientOnA.setTrustedStateRoot(CHAIN_B, TRUSTED_HEIGHT_B, tryBuilt.stateRoot);
        channelsA.channelOpenAck(
            channelA,
            channelB,
            address(channelsB),
            _singleProof(CHAIN_B, TRUSTED_HEIGHT_B, address(channelsB), channelsB.channelCommitmentStorageSlot(channelB), tryBuilt)
        );
        IBCChannelTypes.ChannelEnd memory ackEnd = channelsA.channel(channelA);
        assertEq(uint8(ackEnd.state), uint8(IBCChannelTypes.State.Open));

        BuiltSingleStorageProof memory openBuilt = _buildSingleStorageProof(
            address(channelsA),
            channelsA.channelCommitmentStorageSlot(channelA),
            channelsA.channelCommitments(channelA)
        );
        lightClientOnB.setTrustedStateRoot(CHAIN_A, TRUSTED_HEIGHT_A + 1, openBuilt.stateRoot);
        channelsB.channelOpenConfirm(
            channelB,
            address(channelsA),
            _singleProof(CHAIN_A, TRUSTED_HEIGHT_A + 1, address(channelsA), channelsA.channelCommitmentStorageSlot(channelA), openBuilt)
        );
        IBCChannelTypes.ChannelEnd memory confirmEnd = channelsB.channel(channelB);
        assertEq(uint8(confirmEnd.state), uint8(IBCChannelTypes.State.Open));

        assertTrue(
            channelsA.isPacketRouteOpenForChannel(CHAIN_B, address(receiver), address(sourceApp), channelA, channelB)
        );
        assertTrue(
            channelsB.isPacketRouteOpenForChannel(CHAIN_A, address(sourceApp), address(receiver), channelB, channelA)
        );
    }
}
