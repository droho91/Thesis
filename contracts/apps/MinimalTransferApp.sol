// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EscrowVault} from "./EscrowVault.sol";
import {VoucherToken} from "./VoucherToken.sol";
import {IBCPacketReceiver} from "../core/IBCPacketHandler.sol";
import {PacketLib} from "../libs/PacketLib.sol";
import {SourcePacketCommitment} from "../source/SourcePacketCommitment.sol";

/// @title MinimalTransferApp
/// @notice ICS-20-like lock/mint and burn/unescrow proof-of-concept.
contract MinimalTransferApp is AccessControl, IBCPacketReceiver {
    bytes32 public constant APP_ADMIN_ROLE = keccak256("APP_ADMIN_ROLE");

    uint256 public immutable localChainId;
    SourcePacketCommitment public immutable sourcePackets;
    address public immutable packetHandler;
    EscrowVault public escrowVault;
    VoucherToken public voucherToken;

    mapping(uint256 => address) public remoteAppByChain;

    event RemoteAppConfigured(uint256 indexed remoteChainId, address indexed remoteApp);
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

    constructor(
        uint256 _localChainId,
        address _sourcePackets,
        address _packetHandler,
        address _escrowVault,
        address _voucherToken
    ) {
        require(_localChainId != 0, "CHAIN_ID_ZERO");
        require(_sourcePackets != address(0), "SOURCE_PACKETS_ZERO");
        require(_packetHandler != address(0), "PACKET_HANDLER_ZERO");
        localChainId = _localChainId;
        sourcePackets = SourcePacketCommitment(_sourcePackets);
        packetHandler = _packetHandler;
        if (_escrowVault != address(0)) escrowVault = EscrowVault(_escrowVault);
        if (_voucherToken != address(0)) voucherToken = VoucherToken(_voucherToken);

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(APP_ADMIN_ROLE, msg.sender);
    }

    function configureRemoteApp(uint256 remoteChainId, address remoteApp) external onlyRole(APP_ADMIN_ROLE) {
        require(remoteChainId != 0 && remoteChainId != localChainId, "BAD_REMOTE_CHAIN");
        require(remoteApp != address(0), "REMOTE_APP_ZERO");
        remoteAppByChain[remoteChainId] = remoteApp;
        emit RemoteAppConfigured(remoteChainId, remoteApp);
    }

    function setEscrowVault(address _escrowVault) external onlyRole(APP_ADMIN_ROLE) {
        require(_escrowVault != address(0), "ESCROW_ZERO");
        escrowVault = EscrowVault(_escrowVault);
    }

    function setVoucherToken(address _voucherToken) external onlyRole(APP_ADMIN_ROLE) {
        require(_voucherToken != address(0), "VOUCHER_ZERO");
        voucherToken = VoucherToken(_voucherToken);
    }

    function sendTransfer(uint256 destinationChainId, address recipient, uint256 amount)
        external
        returns (bytes32 packetId)
    {
        require(address(escrowVault) != address(0), "ESCROW_NOT_SET");
        address remoteApp = remoteAppByChain[destinationChainId];
        require(remoteApp != address(0), "REMOTE_APP_NOT_SET");
        require(recipient != address(0), "RECIPIENT_ZERO");
        require(amount > 0, "AMOUNT_ZERO");

        escrowVault.lockFrom(msg.sender, amount);

        PacketLib.Packet memory packet = PacketLib.Packet({
            sequence: sourcePackets.packetSequence() + 1,
            sourceChainId: localChainId,
            destinationChainId: destinationChainId,
            sourcePort: address(this),
            destinationPort: remoteApp,
            sender: msg.sender,
            recipient: recipient,
            asset: address(escrowVault.asset()),
            amount: amount,
            action: PacketLib.ACTION_LOCK_MINT,
            memo: bytes32(0)
        });
        packetId = sourcePackets.commitPacket(packet);
        emit TransferPacketSent(packetId, destinationChainId, packet.sequence, msg.sender, recipient, amount);
    }

    function burnAndRelease(uint256 destinationChainId, address recipient, uint256 amount)
        external
        returns (bytes32 packetId)
    {
        require(address(voucherToken) != address(0), "VOUCHER_NOT_SET");
        address remoteApp = remoteAppByChain[destinationChainId];
        require(remoteApp != address(0), "REMOTE_APP_NOT_SET");
        require(recipient != address(0), "RECIPIENT_ZERO");
        require(amount > 0, "AMOUNT_ZERO");

        voucherToken.burnFrom(msg.sender, amount);

        PacketLib.Packet memory packet = PacketLib.Packet({
            sequence: sourcePackets.packetSequence() + 1,
            sourceChainId: localChainId,
            destinationChainId: destinationChainId,
            sourcePort: address(this),
            destinationPort: remoteApp,
            sender: msg.sender,
            recipient: recipient,
            asset: address(voucherToken),
            amount: amount,
            action: PacketLib.ACTION_BURN_UNLOCK,
            memo: bytes32(0)
        });
        packetId = sourcePackets.commitPacket(packet);
        emit BurnPacketSent(packetId, destinationChainId, packet.sequence, msg.sender, recipient, amount);
    }

    function onRecvPacket(PacketLib.Packet calldata packet, bytes32 packetId) external override {
        require(msg.sender == packetHandler, "ONLY_PACKET_HANDLER");
        require(packet.destinationChainId == localChainId, "WRONG_DESTINATION_CHAIN");
        require(packet.destinationPort == address(this), "WRONG_DESTINATION_PORT");
        require(remoteAppByChain[packet.sourceChainId] == packet.sourcePort, "UNTRUSTED_SOURCE_PORT");

        if (packet.action == PacketLib.ACTION_LOCK_MINT) {
            require(address(voucherToken) != address(0), "VOUCHER_NOT_SET");
            voucherToken.mint(packet.recipient, packet.amount, packetId);
        } else if (packet.action == PacketLib.ACTION_BURN_UNLOCK) {
            require(address(escrowVault) != address(0), "ESCROW_NOT_SET");
            escrowVault.unlockTo(packet.recipient, packet.amount, packetId);
        } else {
            revert("BAD_ACTION");
        }

        emit PacketReceived(packetId, packet.action, packet.recipient, packet.amount);
    }
}
