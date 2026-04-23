// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IBCPacketAcknowledgementReceiver, IBCPacketReceiver, IBCPacketTimeoutReceiver} from
    "../core/IBCPacketReceiver.sol";
import {IBCPacketLib} from "../core/IBCPacketLib.sol";
import {IBCPacketStore} from "../core/IBCPacketStore.sol";
import {PolicyControlledEscrowVault} from "./PolicyControlledEscrowVault.sol";
import {PolicyControlledVoucherToken} from "./PolicyControlledVoucherToken.sol";

/// @title PolicyControlledTransferApp
/// @notice Policy-aware IBC packet application that bridges the transport lane to voucher and escrow actions.
contract PolicyControlledTransferApp is
    AccessControl,
    Pausable,
    IBCPacketReceiver,
    IBCPacketAcknowledgementReceiver,
    IBCPacketTimeoutReceiver
{
    bytes32 public constant APP_ADMIN_ROLE = keccak256("APP_ADMIN_ROLE");

    struct RemoteRoute {
        address remoteApp;
        bytes32 localChannel;
        bytes32 remoteChannel;
        address canonicalAsset;
        bool exists;
    }

    uint256 public immutable localChainId;
    IBCPacketStore public immutable packetStore;
    address public immutable packetHandler;
    PolicyControlledEscrowVault public escrowVault;
    PolicyControlledVoucherToken public voucherToken;

    mapping(uint256 => RemoteRoute) public remoteRouteByChain;
    mapping(bytes32 => bytes32) public acknowledgementHashByPacket;
    mapping(bytes32 => bool) public timedOutPacket;

    event RemoteRouteConfigured(
        uint256 indexed remoteChainId,
        address indexed remoteApp,
        bytes32 indexed localChannel,
        bytes32 remoteChannel,
        address canonicalAsset
    );
    event TransferPacketSent(
        bytes32 indexed packetId,
        uint256 indexed destinationChainId,
        uint256 indexed sequence,
        address sender,
        address recipient,
        uint256 amount
    );
    event BurnPacketSent(
        bytes32 indexed packetId,
        uint256 indexed destinationChainId,
        uint256 indexed sequence,
        address sender,
        address recipient,
        uint256 amount
    );
    event PacketReceived(bytes32 indexed packetId, uint8 indexed action, address indexed recipient, uint256 amount);
    event PacketAcknowledged(bytes32 indexed packetId, bytes32 acknowledgementHash);
    event PacketTimedOut(bytes32 indexed packetId, uint8 indexed action, address indexed refundAccount, uint256 amount);
    event EmergencyPaused(address indexed account);
    event EmergencyUnpaused(address indexed account);

    constructor(
        uint256 localChainId_,
        address packetStore_,
        address packetHandler_,
        address escrowVault_,
        address voucherToken_,
        address admin
    ) {
        require(localChainId_ != 0, "CHAIN_ID_ZERO");
        require(packetStore_ != address(0), "PACKET_STORE_ZERO");
        require(packetHandler_ != address(0), "PACKET_HANDLER_ZERO");
        require(admin != address(0), "ADMIN_ZERO");

        localChainId = localChainId_;
        packetStore = IBCPacketStore(packetStore_);
        packetHandler = packetHandler_;
        if (escrowVault_ != address(0)) escrowVault = PolicyControlledEscrowVault(escrowVault_);
        if (voucherToken_ != address(0)) voucherToken = PolicyControlledVoucherToken(voucherToken_);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(APP_ADMIN_ROLE, admin);
    }

    function setEscrowVault(address escrowVault_) external onlyRole(APP_ADMIN_ROLE) {
        require(escrowVault_ != address(0), "ESCROW_ZERO");
        escrowVault = PolicyControlledEscrowVault(escrowVault_);
    }

    function setVoucherToken(address voucherToken_) external onlyRole(APP_ADMIN_ROLE) {
        require(voucherToken_ != address(0), "VOUCHER_ZERO");
        voucherToken = PolicyControlledVoucherToken(voucherToken_);
    }

    function pause() external onlyRole(APP_ADMIN_ROLE) {
        _pause();
        emit EmergencyPaused(msg.sender);
    }

    function unpause() external onlyRole(APP_ADMIN_ROLE) {
        _unpause();
        emit EmergencyUnpaused(msg.sender);
    }

    function configureRemoteRoute(
        uint256 remoteChainId,
        address remoteApp,
        bytes32 localChannel,
        bytes32 remoteChannel,
        address canonicalAsset
    ) external onlyRole(APP_ADMIN_ROLE) {
        require(remoteChainId != 0 && remoteChainId != localChainId, "BAD_REMOTE_CHAIN");
        require(remoteApp != address(0), "REMOTE_APP_ZERO");
        require(localChannel != bytes32(0), "LOCAL_CHANNEL_ZERO");
        require(remoteChannel != bytes32(0), "REMOTE_CHANNEL_ZERO");
        require(canonicalAsset != address(0), "CANONICAL_ASSET_ZERO");

        remoteRouteByChain[remoteChainId] = RemoteRoute({
            remoteApp: remoteApp,
            localChannel: localChannel,
            remoteChannel: remoteChannel,
            canonicalAsset: canonicalAsset,
            exists: true
        });

        emit RemoteRouteConfigured(remoteChainId, remoteApp, localChannel, remoteChannel, canonicalAsset);
    }

    function sendTransfer(uint256 destinationChainId, address recipient, uint256 amount, uint64 timeoutHeight, uint64 timeoutTimestamp)
        external
        whenNotPaused
        returns (bytes32 packetId)
    {
        require(address(escrowVault) != address(0), "ESCROW_NOT_SET");
        RemoteRoute memory route = _requireRoute(destinationChainId);
        require(address(escrowVault.asset()) == route.canonicalAsset, "ESCROW_ASSET_ROUTE_MISMATCH");
        require(recipient != address(0), "RECIPIENT_ZERO");
        require(amount > 0, "AMOUNT_ZERO");

        escrowVault.lockFrom(msg.sender, amount);

        IBCPacketLib.Packet memory packet = IBCPacketLib.Packet({
            sequence: packetStore.nextSequence(),
            source: IBCPacketLib.Endpoint({
                chainId: localChainId,
                port: address(this),
                channel: route.localChannel
            }),
            destination: IBCPacketLib.Endpoint({
                chainId: destinationChainId,
                port: route.remoteApp,
                channel: route.remoteChannel
            }),
            data: IBCPacketLib.encodeTransferData(
                IBCPacketLib.TransferData({
                    sender: msg.sender,
                    recipient: recipient,
                    asset: route.canonicalAsset,
                    amount: amount,
                    action: IBCPacketLib.ACTION_LOCK_MINT,
                    memo: bytes32(0)
                })
            ),
            timeout: IBCPacketLib.Timeout({height: timeoutHeight, timestamp: timeoutTimestamp})
        });

        packetId = packetStore.commitPacket(packet);
        emit TransferPacketSent(packetId, destinationChainId, packet.sequence, msg.sender, recipient, amount);
    }

    function burnAndRelease(
        uint256 destinationChainId,
        address recipient,
        uint256 amount,
        uint64 timeoutHeight,
        uint64 timeoutTimestamp
    ) external whenNotPaused returns (bytes32 packetId) {
        require(address(voucherToken) != address(0), "VOUCHER_NOT_SET");
        RemoteRoute memory route = _requireRoute(destinationChainId);
        require(voucherToken.canonicalAsset() == route.canonicalAsset, "VOUCHER_ASSET_ROUTE_MISMATCH");
        require(recipient != address(0), "RECIPIENT_ZERO");
        require(amount > 0, "AMOUNT_ZERO");

        voucherToken.burnFromWithPolicy(msg.sender, route.canonicalAsset, amount);

        IBCPacketLib.Packet memory packet = IBCPacketLib.Packet({
            sequence: packetStore.nextSequence(),
            source: IBCPacketLib.Endpoint({
                chainId: localChainId,
                port: address(this),
                channel: route.localChannel
            }),
            destination: IBCPacketLib.Endpoint({
                chainId: destinationChainId,
                port: route.remoteApp,
                channel: route.remoteChannel
            }),
            data: IBCPacketLib.encodeTransferData(
                IBCPacketLib.TransferData({
                    sender: msg.sender,
                    recipient: recipient,
                    asset: route.canonicalAsset,
                    amount: amount,
                    action: IBCPacketLib.ACTION_BURN_UNLOCK,
                    memo: bytes32(0)
                })
            ),
            timeout: IBCPacketLib.Timeout({height: timeoutHeight, timestamp: timeoutTimestamp})
        });

        packetId = packetStore.commitPacket(packet);
        emit BurnPacketSent(packetId, destinationChainId, packet.sequence, msg.sender, recipient, amount);
    }

    function onRecvPacket(IBCPacketLib.Packet calldata packet, bytes32 packetId)
        external
        whenNotPaused
        returns (bytes memory acknowledgement)
    {
        require(msg.sender == packetHandler, "ONLY_PACKET_HANDLER");
        require(packet.destination.chainId == localChainId, "WRONG_DESTINATION_CHAIN");
        require(packet.destination.port == address(this), "WRONG_DESTINATION_PORT");

        RemoteRoute memory route = _requireRoute(packet.source.chainId);
        require(route.remoteApp == packet.source.port, "UNTRUSTED_SOURCE_PORT");
        require(route.localChannel == packet.destination.channel, "WRONG_DESTINATION_CHANNEL");
        require(route.remoteChannel == packet.source.channel, "WRONG_SOURCE_CHANNEL");

        IBCPacketLib.TransferData memory transferData = IBCPacketLib.decodeTransferData(packet.data);
        require(transferData.asset == route.canonicalAsset, "PACKET_ASSET_MISMATCH");
        if (transferData.action == IBCPacketLib.ACTION_LOCK_MINT) {
            require(address(voucherToken) != address(0), "VOUCHER_NOT_SET");
            require(voucherToken.canonicalAsset() == route.canonicalAsset, "VOUCHER_ASSET_ROUTE_MISMATCH");
            voucherToken.mintWithPolicy(
                transferData.recipient, transferData.asset, packet.source.chainId, transferData.amount, packetId
            );
        } else if (transferData.action == IBCPacketLib.ACTION_BURN_UNLOCK) {
            require(address(escrowVault) != address(0), "ESCROW_NOT_SET");
            require(address(escrowVault.asset()) == route.canonicalAsset, "ESCROW_ASSET_ROUTE_MISMATCH");
            escrowVault.unlockToWithPolicyNoExposureReduction(
                transferData.recipient, packet.source.chainId, transferData.amount, packetId
            );
        } else {
            revert("BAD_ACTION");
        }

        acknowledgement = abi.encodePacked("ok:", packetId);
        emit PacketReceived(packetId, transferData.action, transferData.recipient, transferData.amount);
    }

    function onAcknowledgementPacket(
        IBCPacketLib.Packet calldata,
        bytes32 packetId,
        bytes calldata acknowledgement
    ) external {
        require(msg.sender == packetHandler, "ONLY_PACKET_HANDLER");
        bytes32 acknowledgementHash = keccak256(acknowledgement);
        acknowledgementHashByPacket[packetId] = acknowledgementHash;
        emit PacketAcknowledged(packetId, acknowledgementHash);
    }

    function onTimeoutPacket(IBCPacketLib.Packet calldata packet, bytes32 packetId) external whenNotPaused {
        require(msg.sender == packetHandler, "ONLY_PACKET_HANDLER");
        require(!timedOutPacket[packetId], "PACKET_TIMEOUT_RECORDED");

        require(packet.source.chainId == localChainId, "WRONG_SOURCE_CHAIN");
        require(packet.source.port == address(this), "WRONG_SOURCE_PORT");
        RemoteRoute memory route = _requireRoute(packet.destination.chainId);
        require(packet.source.channel == route.localChannel, "WRONG_SOURCE_CHANNEL");
        require(packet.destination.port == route.remoteApp, "WRONG_DESTINATION_PORT");
        require(packet.destination.channel == route.remoteChannel, "WRONG_DESTINATION_CHANNEL");

        IBCPacketLib.TransferData memory transferData = IBCPacketLib.decodeTransferData(packet.data);
        require(transferData.asset == route.canonicalAsset, "PACKET_ASSET_MISMATCH");
        if (transferData.action == IBCPacketLib.ACTION_LOCK_MINT) {
            require(address(escrowVault) != address(0), "ESCROW_NOT_SET");
            require(address(escrowVault.asset()) == route.canonicalAsset, "ESCROW_ASSET_ROUTE_MISMATCH");
            escrowVault.unlockToWithPolicyNoExposureReduction(
                transferData.sender, packet.destination.chainId, transferData.amount, packetId
            );
            emit PacketTimedOut(packetId, transferData.action, transferData.sender, transferData.amount);
        } else if (transferData.action == IBCPacketLib.ACTION_BURN_UNLOCK) {
            require(address(voucherToken) != address(0), "VOUCHER_NOT_SET");
            require(voucherToken.canonicalAsset() == route.canonicalAsset, "VOUCHER_ASSET_ROUTE_MISMATCH");
            voucherToken.mintWithPolicy(
                transferData.sender, transferData.asset, packet.destination.chainId, transferData.amount, packetId
            );
            emit PacketTimedOut(packetId, transferData.action, transferData.sender, transferData.amount);
        } else {
            revert("BAD_ACTION");
        }

        timedOutPacket[packetId] = true;
    }

    function _requireRoute(uint256 remoteChainId) internal view returns (RemoteRoute memory route) {
        route = remoteRouteByChain[remoteChainId];
        require(route.exists, "REMOTE_ROUTE_NOT_SET");
    }
}
