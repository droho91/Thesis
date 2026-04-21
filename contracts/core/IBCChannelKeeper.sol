// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IBCEVMProofBoundary} from "./IBCEVMProofBoundary.sol";
import {IBCEVMTypes} from "./IBCEVMTypes.sol";
import {IBCChannelTypes} from "./IBCChannelTypes.sol";
import {IBCConnectionTypes} from "./IBCConnectionTypes.sol";
import {IBCConnectionKeeper} from "./IBCConnectionKeeper.sol";

/// @title IBCChannelKeeper
/// @notice Minimal channel keeper for the interchain lane.
/// @dev This intentionally gates the existing address-port packet shape while keeping channel state explicit.
contract IBCChannelKeeper is AccessControl, IBCEVMProofBoundary {
    bytes32 public constant CHANNEL_ADMIN_ROLE = keccak256("CHANNEL_ADMIN_ROLE");
    bytes32 public constant CHANNEL_COMMITMENT_TYPEHASH = keccak256("IBC.ChannelEnd");

    uint256 internal constant CHANNEL_COMMITMENTS_SLOT = 3;

    uint256 public immutable localChainId;
    IBCConnectionKeeper public immutable connectionKeeper;

    struct PacketRoute {
        bytes32 connectionId;
        uint256 counterpartyChainId;
        address counterpartyPort;
        address localPort;
        bytes32 channelId;
        bool exists;
    }

    mapping(bytes32 => IBCChannelTypes.ChannelEnd) internal channels;
    mapping(bytes32 => PacketRoute) public packetRoutes;
    mapping(bytes32 => bytes32) public channelCommitments;
    mapping(bytes32 => PacketRoute) internal routesByChannel;

    event ChannelRouteOpened(
        bytes32 indexed channelId,
        bytes32 indexed connectionId,
        uint256 indexed counterpartyChainId,
        address localPort,
        address counterpartyPort,
        bytes32 counterpartyChannelId
    );
    event ChannelHandshakeState(bytes32 indexed channelId, IBCChannelTypes.State state);
    event ChannelClosed(bytes32 indexed channelId);

    constructor(uint256 _localChainId, address connectionKeeper_, address admin)
        IBCEVMProofBoundary(address(IBCConnectionKeeper(connectionKeeper_).besuLightClient()))
    {
        require(_localChainId != 0, "CHAIN_ID_ZERO");
        require(connectionKeeper_ != address(0), "CONNECTION_KEEPER_ZERO");
        require(admin != address(0), "ADMIN_ZERO");
        localChainId = _localChainId;
        connectionKeeper = IBCConnectionKeeper(connectionKeeper_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CHANNEL_ADMIN_ROLE, admin);
    }

    /// @dev Unsafe admin shortcut kept only for tests and controlled scaffolding.
    ///      Production packet routes should be reached through the proof-checked channel handshake.
    function openChannelRouteUnsafe(
        bytes32 channelId,
        bytes32 connectionId,
        uint256 counterpartyChainId,
        address counterpartyPort,
        address localPort,
        bytes32 counterpartyChannelId,
        IBCChannelTypes.Order ordering,
        bytes calldata version
    ) external onlyRole(CHANNEL_ADMIN_ROLE) {
        require(channelId != bytes32(0), "CHANNEL_ID_ZERO");
        require(counterpartyChainId != 0 && counterpartyChainId != localChainId, "BAD_COUNTERPARTY_CHAIN");
        require(counterpartyPort != address(0), "COUNTERPARTY_PORT_ZERO");
        require(localPort != address(0), "LOCAL_PORT_ZERO");
        require(ordering == IBCChannelTypes.Order.Unordered || ordering == IBCChannelTypes.Order.Ordered, "BAD_ORDERING");
        require(channels[channelId].state == IBCChannelTypes.State.Uninitialized, "CHANNEL_EXISTS");
        require(connectionKeeper.isConnectionOpen(connectionId), "CONNECTION_NOT_OPEN");

        _writeChannel(
            ChannelWrite({
                channelId: channelId,
                connectionId: connectionId,
                counterpartyChainId: counterpartyChainId,
                counterpartyPort: counterpartyPort,
                localPort: localPort,
                counterpartyChannelId: counterpartyChannelId,
                ordering: ordering,
                version: version,
                state: IBCChannelTypes.State.Open
            })
        );

        emit ChannelRouteOpened(
            channelId, connectionId, counterpartyChainId, localPort, counterpartyPort, counterpartyChannelId
        );
    }

    function channelOpenInit(
        bytes32 channelId,
        bytes32 connectionId,
        uint256 counterpartyChainId,
        address counterpartyPort,
        address localPort,
        IBCChannelTypes.Order ordering,
        bytes calldata version
    ) external onlyRole(CHANNEL_ADMIN_ROLE) {
        require(connectionKeeper.isConnectionOpen(connectionId), "CONNECTION_NOT_OPEN");
        require(channels[channelId].state == IBCChannelTypes.State.Uninitialized, "CHANNEL_EXISTS");
        _writeChannel(
            ChannelWrite({
                channelId: channelId,
                connectionId: connectionId,
                counterpartyChainId: counterpartyChainId,
                counterpartyPort: counterpartyPort,
                localPort: localPort,
                counterpartyChannelId: bytes32(0),
                ordering: ordering,
                version: version,
                state: IBCChannelTypes.State.Init
            })
        );
    }

    function channelOpenTry(
        bytes32 channelId,
        bytes32 connectionId,
        uint256 counterpartyChainId,
        address counterpartyPort,
        address localPort,
        bytes32 counterpartyChannelId,
        IBCChannelTypes.Order ordering,
        bytes calldata version,
        address counterpartyChannelKeeper,
        IBCEVMTypes.StorageProof calldata counterpartyInitProof
    ) external onlyRole(CHANNEL_ADMIN_ROLE) {
        require(connectionKeeper.isConnectionOpen(connectionId), "CONNECTION_NOT_OPEN");
        require(channels[channelId].state == IBCChannelTypes.State.Uninitialized, "CHANNEL_EXISTS");
        IBCConnectionTypes.ConnectionEnd memory connectionEnd = connectionKeeper.connection(connectionId);
        bytes32 expectedCounterpartyCommitment = channelCommitment(
            counterpartyInitProof.sourceChainId,
            counterpartyChannelId,
            IBCChannelTypes.State.Init,
            ordering,
            localChainId,
            counterpartyPort,
            localPort,
            bytes32(0),
            connectionEnd.counterparty.connectionId,
            version
        );
        _requireCounterpartyChannelProof(
            counterpartyChannelKeeper, counterpartyChannelId, expectedCounterpartyCommitment, counterpartyInitProof
        );
        _writeChannel(
            ChannelWrite({
                channelId: channelId,
                connectionId: connectionId,
                counterpartyChainId: counterpartyChainId,
                counterpartyPort: counterpartyPort,
                localPort: localPort,
                counterpartyChannelId: counterpartyChannelId,
                ordering: ordering,
                version: version,
                state: IBCChannelTypes.State.TryOpen
            })
        );
    }

    function channelOpenAck(
        bytes32 channelId,
        bytes32 counterpartyChannelId,
        address counterpartyChannelKeeper,
        IBCEVMTypes.StorageProof calldata counterpartyTryProof
    ) external onlyRole(CHANNEL_ADMIN_ROLE) {
        IBCChannelTypes.ChannelEnd memory channelEnd = channels[channelId];
        require(channelEnd.state == IBCChannelTypes.State.Init, "CHANNEL_NOT_INIT");
        PacketRoute memory route = routesByChannel[channelId];
        require(route.exists, "CHANNEL_ROUTE_MISSING");
        IBCConnectionTypes.ConnectionEnd memory connectionEnd = connectionKeeper.connection(route.connectionId);
        bytes32 expectedCounterpartyCommitment = channelCommitment(
            counterpartyTryProof.sourceChainId,
            counterpartyChannelId,
            IBCChannelTypes.State.TryOpen,
            channelEnd.ordering,
            localChainId,
            route.counterpartyPort,
            route.localPort,
            channelId,
            connectionEnd.counterparty.connectionId,
            channelEnd.version
        );
        _requireCounterpartyChannelProof(
            counterpartyChannelKeeper, counterpartyChannelId, expectedCounterpartyCommitment, counterpartyTryProof
        );
        _writeChannel(
            ChannelWrite({
                channelId: channelId,
                connectionId: route.connectionId,
                counterpartyChainId: route.counterpartyChainId,
                counterpartyPort: route.counterpartyPort,
                localPort: route.localPort,
                counterpartyChannelId: counterpartyChannelId,
                ordering: channelEnd.ordering,
                version: channelEnd.version,
                state: IBCChannelTypes.State.Open
            })
        );
        emit ChannelRouteOpened(
            channelId,
            route.connectionId,
            route.counterpartyChainId,
            route.localPort,
            route.counterpartyPort,
            counterpartyChannelId
        );
    }

    function channelOpenConfirm(
        bytes32 channelId,
        address counterpartyChannelKeeper,
        IBCEVMTypes.StorageProof calldata counterpartyOpenProof
    ) external onlyRole(CHANNEL_ADMIN_ROLE) {
        IBCChannelTypes.ChannelEnd memory channelEnd = channels[channelId];
        require(channelEnd.state == IBCChannelTypes.State.TryOpen, "CHANNEL_NOT_TRYOPEN");
        PacketRoute memory route = routesByChannel[channelId];
        require(route.exists, "CHANNEL_ROUTE_MISSING");
        IBCConnectionTypes.ConnectionEnd memory connectionEnd = connectionKeeper.connection(route.connectionId);
        bytes32 counterpartyChannelId = channelEnd.counterparty.channelId;
        bytes32 expectedCounterpartyCommitment = channelCommitment(
            counterpartyOpenProof.sourceChainId,
            counterpartyChannelId,
            IBCChannelTypes.State.Open,
            channelEnd.ordering,
            localChainId,
            route.counterpartyPort,
            route.localPort,
            channelId,
            connectionEnd.counterparty.connectionId,
            channelEnd.version
        );
        _requireCounterpartyChannelProof(
            counterpartyChannelKeeper, counterpartyChannelId, expectedCounterpartyCommitment, counterpartyOpenProof
        );
        _writeChannel(
            ChannelWrite({
                channelId: channelId,
                connectionId: route.connectionId,
                counterpartyChainId: route.counterpartyChainId,
                counterpartyPort: route.counterpartyPort,
                localPort: route.localPort,
                counterpartyChannelId: counterpartyChannelId,
                ordering: channelEnd.ordering,
                version: channelEnd.version,
                state: IBCChannelTypes.State.Open
            })
        );
        emit ChannelRouteOpened(
            channelId,
            route.connectionId,
            route.counterpartyChainId,
            route.localPort,
            route.counterpartyPort,
            counterpartyChannelId
        );
    }

    function closeChannel(bytes32 channelId) external onlyRole(CHANNEL_ADMIN_ROLE) {
        require(channels[channelId].state == IBCChannelTypes.State.Open, "CHANNEL_NOT_OPEN");
        channels[channelId].state = IBCChannelTypes.State.Closed;
        emit ChannelClosed(channelId);
    }

    function isPacketRouteOpen(uint256 counterpartyChainId, address counterpartyPort, address localPort)
        external
        view
        returns (bool)
    {
        bytes32 routeKey = packetRouteKey(counterpartyChainId, counterpartyPort, localPort);
        PacketRoute storage route = packetRoutes[routeKey];
        return route.exists && channels[route.channelId].state == IBCChannelTypes.State.Open;
    }

    function isPacketRouteOpenForChannel(
        uint256 counterpartyChainId,
        address counterpartyPort,
        address localPort,
        bytes32 localChannelId,
        bytes32 counterpartyChannelId
    ) external view returns (bool) {
        bytes32 routeKey = packetRouteKey(counterpartyChainId, counterpartyPort, localPort);
        PacketRoute storage route = packetRoutes[routeKey];
        IBCChannelTypes.ChannelEnd storage channelEnd = channels[route.channelId];
        return route.exists && route.channelId == localChannelId && channelEnd.state == IBCChannelTypes.State.Open
            && channelEnd.counterparty.channelId == counterpartyChannelId;
    }

    function channel(bytes32 channelId) external view returns (IBCChannelTypes.ChannelEnd memory) {
        return channels[channelId];
    }

    function channelCommitmentStorageSlot(bytes32 channelId) public pure returns (bytes32) {
        return keccak256(abi.encode(channelId, CHANNEL_COMMITMENTS_SLOT));
    }

    function channelCommitment(
        uint256 chainId,
        bytes32 channelId,
        IBCChannelTypes.State state,
        IBCChannelTypes.Order ordering,
        uint256 counterpartyChainId,
        address localPort,
        address counterpartyPort,
        bytes32 counterpartyChannelId,
        bytes32 connectionId,
        bytes memory version
    ) public pure returns (bytes32) {
        require(chainId != 0, "CHAIN_ID_ZERO");
        require(channelId != bytes32(0), "CHANNEL_ID_ZERO");
        require(counterpartyChainId != 0 && counterpartyChainId != chainId, "BAD_COUNTERPARTY_CHAIN");
        require(localPort != address(0), "LOCAL_PORT_ZERO");
        require(counterpartyPort != address(0), "COUNTERPARTY_PORT_ZERO");
        require(connectionId != bytes32(0), "CONNECTION_ID_ZERO");
        return keccak256(
            abi.encode(
                CHANNEL_COMMITMENT_TYPEHASH,
                chainId,
                channelId,
                state,
                ordering,
                counterpartyChainId,
                localPort,
                counterpartyPort,
                counterpartyChannelId,
                connectionId,
                keccak256(version)
            )
        );
    }

    function packetRouteKey(uint256 counterpartyChainId, address counterpartyPort, address localPort)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(counterpartyChainId, counterpartyPort, localPort));
    }

    struct ChannelWrite {
        bytes32 channelId;
        bytes32 connectionId;
        uint256 counterpartyChainId;
        address counterpartyPort;
        address localPort;
        bytes32 counterpartyChannelId;
        IBCChannelTypes.Order ordering;
        bytes version;
        IBCChannelTypes.State state;
    }

    function _writeChannel(ChannelWrite memory channelWrite) internal {
        require(channelWrite.channelId != bytes32(0), "CHANNEL_ID_ZERO");
        require(
            channelWrite.counterpartyChainId != 0 && channelWrite.counterpartyChainId != localChainId,
            "BAD_COUNTERPARTY_CHAIN"
        );
        require(channelWrite.counterpartyPort != address(0), "COUNTERPARTY_PORT_ZERO");
        require(channelWrite.localPort != address(0), "LOCAL_PORT_ZERO");
        require(
            channelWrite.ordering == IBCChannelTypes.Order.Unordered
                || channelWrite.ordering == IBCChannelTypes.Order.Ordered,
            "BAD_ORDERING"
        );

        bytes32 routeKey =
            packetRouteKey(channelWrite.counterpartyChainId, channelWrite.counterpartyPort, channelWrite.localPort);
        PacketRoute memory existingRoute = packetRoutes[routeKey];
        require(!existingRoute.exists || existingRoute.channelId == channelWrite.channelId, "ROUTE_EXISTS");

        bytes32[] memory connectionHops = new bytes32[](1);
        connectionHops[0] = channelWrite.connectionId;
        channels[channelWrite.channelId] = IBCChannelTypes.ChannelEnd({
            state: channelWrite.state,
            ordering: channelWrite.ordering,
            counterparty: IBCChannelTypes.Counterparty({
                portId: bytes32(uint256(uint160(channelWrite.counterpartyPort))),
                channelId: channelWrite.counterpartyChannelId
            }),
            connectionHops: connectionHops,
            version: channelWrite.version
        });

        PacketRoute memory route = PacketRoute({
            connectionId: channelWrite.connectionId,
            counterpartyChainId: channelWrite.counterpartyChainId,
            counterpartyPort: channelWrite.counterpartyPort,
            localPort: channelWrite.localPort,
            channelId: channelWrite.channelId,
            exists: true
        });
        packetRoutes[routeKey] = route;
        routesByChannel[channelWrite.channelId] = route;
        channelCommitments[channelWrite.channelId] = channelCommitment(
            localChainId,
            channelWrite.channelId,
            channelWrite.state,
            channelWrite.ordering,
            channelWrite.counterpartyChainId,
            channelWrite.localPort,
            channelWrite.counterpartyPort,
            channelWrite.counterpartyChannelId,
            channelWrite.connectionId,
            channelWrite.version
        );
        emit ChannelHandshakeState(channelWrite.channelId, channelWrite.state);
    }

    function _requireCounterpartyChannelProof(
        address counterpartyChannelKeeper,
        bytes32 counterpartyChannelId,
        bytes32 expectedCommitment,
        IBCEVMTypes.StorageProof calldata proof
    ) internal view {
        require(counterpartyChannelKeeper != address(0), "COUNTERPARTY_KEEPER_ZERO");
        require(proof.sourceChainId != 0 && proof.sourceChainId != localChainId, "BAD_COUNTERPARTY_CHAIN");
        require(proof.account == counterpartyChannelKeeper, "CHANNEL_PROOF_ACCOUNT_MISMATCH");
        require(proof.storageKey == channelCommitmentStorageSlot(counterpartyChannelId), "CHANNEL_PROOF_KEY_MISMATCH");
        require(
            keccak256(proof.expectedValue) == keccak256(IBCEVMTypes.rlpEncodeWord(expectedCommitment)),
            "CHANNEL_PROOF_VALUE_MISMATCH"
        );
        require(_verifyTrustedEVMStorageProof(proof), "INVALID_CHANNEL_PROOF");
    }
}
