// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCChannelKeeperV2} from "../../contracts/v2/core/IBCChannelKeeperV2.sol";
import {IBCChannelTypes} from "../../contracts/v2/core/IBCChannelTypes.sol";
import {IBCConnectionKeeperV2} from "../../contracts/v2/core/IBCConnectionKeeperV2.sol";
import {IBCConnectionTypes} from "../../contracts/v2/core/IBCConnectionTypes.sol";
import {MockBesuLightClient, PacketHandlerV2Fixture} from "./helpers/PacketHandlerV2Fixture.sol";

contract PacketHandshakeV2Test is PacketHandlerV2Fixture {
    function testOpenChannelRouteUnsafeRequiresOpenConnection() public {
        IBCChannelKeeperV2 keeper = new IBCChannelKeeperV2(CHAIN_B, address(connectionKeeperB), address(this));

        vm.expectRevert(bytes("CONNECTION_NOT_OPEN"));
        keeper.openChannelRouteUnsafe(
            bytes32("missing-channel"),
            bytes32("missing-connection"),
            CHAIN_A,
            address(sourceApp),
            address(receiver),
            bytes32("channel-a"),
            IBCChannelTypes.Order.Unordered,
            bytes("ics-v2")
        );
    }

    function testConnectionProofHandshakeTransitionsBothEndsToOpen() public {
        MockBesuLightClient lightClientOnA = new MockBesuLightClient();
        MockBesuLightClient lightClientOnB = new MockBesuLightClient();
        IBCConnectionKeeperV2 keeperA = new IBCConnectionKeeperV2(CHAIN_A, address(lightClientOnA), address(this));
        IBCConnectionKeeperV2 keeperB = new IBCConnectionKeeperV2(CHAIN_B, address(lightClientOnB), address(this));
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
        IBCConnectionKeeperV2 keeperA = new IBCConnectionKeeperV2(CHAIN_A, address(lightClientOnA), address(this));
        IBCConnectionKeeperV2 keeperB = new IBCConnectionKeeperV2(CHAIN_B, address(lightClientOnB), address(this));
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
        IBCChannelKeeperV2 channelsA = new IBCChannelKeeperV2(CHAIN_A, address(keeperA), address(this));
        IBCChannelKeeperV2 channelsB = new IBCChannelKeeperV2(CHAIN_B, address(keeperB), address(this));
        bytes32 channelA = bytes32("channel-a");
        bytes32 channelB = bytes32("channel-b");
        bytes memory version = bytes("ics-v2");

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
