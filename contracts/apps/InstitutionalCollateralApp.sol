// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IInstitutionalMessageLifecycle, IInstitutionalMessageReceiver} from
    "../gateway/IInstitutionalMessageReceiver.sol";
import {IInstitutionalIdentityRegistry} from "../identity/IInstitutionalIdentityRegistry.sol";
import {IInstitutionalCrossChainGateway} from "./IInstitutionalCrossChainGateway.sol";
import {InstitutionalCollateralMessageLib} from "./InstitutionalCollateralMessageLib.sol";
import {PolicyControlledEscrowVault} from "./PolicyControlledEscrowVault.sol";
import {PolicyControlledVoucherToken} from "./PolicyControlledVoucherToken.sol";

/// @title InstitutionalCollateralApp
/// @notice Identity- and policy-controlled lock/mint and burn/unlock application for the institutional gateway.
contract InstitutionalCollateralApp is
    AccessControl,
    Pausable,
    ReentrancyGuard,
    IInstitutionalMessageReceiver,
    IInstitutionalMessageLifecycle
{
    bytes32 public constant APP_ADMIN_ROLE = keccak256("APP_ADMIN_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    enum TransferStatus {
        None,
        Pending,
        Completed,
        Refunded
    }

    struct RemoteRoute {
        address remoteApplication;
        address canonicalAsset;
        uint256 perTransferLimit;
        bool enabled;
    }

    struct PendingTransfer {
        InstitutionalCollateralMessageLib.Action action;
        address sender;
        address recipient;
        address canonicalAsset;
        uint256 amount;
        uint256 destinationChainId;
        TransferStatus status;
    }

    uint256 public immutable localChainId;
    IInstitutionalCrossChainGateway public immutable gateway;
    IInstitutionalIdentityRegistry public immutable identityRegistry;
    PolicyControlledEscrowVault public immutable escrowVault;
    PolicyControlledVoucherToken public immutable voucherToken;

    mapping(uint256 => RemoteRoute) public remoteRoutes;
    mapping(bytes32 => PendingTransfer) public pendingTransfers;
    mapping(address => mapping(bytes32 => bytes32)) public messageByClientReference;
    mapping(address => mapping(bytes32 => bool)) public clientReferenceUsed;
    mapping(address => uint256) public dailyOutboundLimit;
    mapping(address => mapping(uint256 => uint256)) public outboundByDay;

    event RemoteRouteConfigured(
        uint256 indexed remoteChainId,
        address indexed remoteApplication,
        address indexed canonicalAsset,
        uint256 perTransferLimit,
        bool enabled
    );
    event DailyOutboundLimitSet(address indexed canonicalAsset, uint256 limit);
    event CollateralMessageSent(
        bytes32 indexed messageId,
        InstitutionalCollateralMessageLib.Action indexed action,
        address indexed sender,
        address recipient,
        uint256 amount,
        uint256 destinationChainId,
        bytes32 clientReference
    );
    event CollateralMessageReceived(
        bytes32 indexed messageId,
        InstitutionalCollateralMessageLib.Action indexed action,
        address indexed recipient,
        uint256 amount
    );
    event CollateralMessageCompleted(bytes32 indexed messageId, bytes32 acknowledgementHash);
    event CollateralMessageRefunded(
        bytes32 indexed messageId,
        InstitutionalCollateralMessageLib.Action indexed action,
        address indexed account,
        uint256 amount
    );

    error IdentityNotEligible(address account);
    error ClientReferenceAlreadyUsed(address account, bytes32 clientReference);

    constructor(
        uint256 localChainId_,
        address gateway_,
        address identityRegistry_,
        address escrowVault_,
        address voucherToken_,
        address admin
    ) {
        require(localChainId_ != 0, "CHAIN_ID_ZERO");
        require(gateway_ != address(0), "GATEWAY_ZERO");
        require(identityRegistry_ != address(0), "IDENTITY_REGISTRY_ZERO");
        require(escrowVault_ != address(0) || voucherToken_ != address(0), "APPLICATION_MODE_EMPTY");
        require(admin != address(0), "ADMIN_ZERO");
        localChainId = localChainId_;
        gateway = IInstitutionalCrossChainGateway(gateway_);
        identityRegistry = IInstitutionalIdentityRegistry(identityRegistry_);
        escrowVault = PolicyControlledEscrowVault(escrowVault_);
        voucherToken = PolicyControlledVoucherToken(voucherToken_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(APP_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, admin);
    }

    function configureRemoteRoute(
        uint256 remoteChainId,
        address remoteApplication,
        address canonicalAsset,
        uint256 perTransferLimit,
        bool enabled
    ) external onlyRole(APP_ADMIN_ROLE) {
        require(remoteChainId != 0 && remoteChainId != localChainId, "BAD_REMOTE_CHAIN");
        require(remoteApplication != address(0), "REMOTE_APPLICATION_ZERO");
        require(canonicalAsset != address(0), "CANONICAL_ASSET_ZERO");
        remoteRoutes[remoteChainId] = RemoteRoute({
            remoteApplication: remoteApplication,
            canonicalAsset: canonicalAsset,
            perTransferLimit: perTransferLimit,
            enabled: enabled
        });
        emit RemoteRouteConfigured(remoteChainId, remoteApplication, canonicalAsset, perTransferLimit, enabled);
    }

    function setDailyOutboundLimit(address canonicalAsset, uint256 limit) external onlyRole(APP_ADMIN_ROLE) {
        require(canonicalAsset != address(0), "CANONICAL_ASSET_ZERO");
        dailyOutboundLimit[canonicalAsset] = limit;
        emit DailyOutboundLimitSet(canonicalAsset, limit);
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(APP_ADMIN_ROLE) {
        _unpause();
    }

    function transferStatus(bytes32 messageId) external view returns (TransferStatus) {
        return pendingTransfers[messageId].status;
    }

    function lockAndMint(
        uint256 destinationChainId,
        address recipient,
        uint256 amount,
        uint64 timeoutTimestamp,
        bytes32 clientReference
    ) external whenNotPaused nonReentrant returns (bytes32 messageId) {
        require(address(escrowVault) != address(0), "ESCROW_NOT_CONFIGURED");
        _requireEligible(msg.sender);
        RemoteRoute memory route = _requireOutboundRoute(destinationChainId, amount);
        _consumeOutbound(msg.sender, route.canonicalAsset, amount);
        escrowVault.lockFrom(msg.sender, amount);
        messageId = _sendTransfer(
            destinationChainId,
            route,
            InstitutionalCollateralMessageLib.Action.LockMint,
            msg.sender,
            recipient,
            amount,
            timeoutTimestamp,
            clientReference
        );
    }

    function burnAndUnlock(
        uint256 destinationChainId,
        address recipient,
        uint256 amount,
        uint64 timeoutTimestamp,
        bytes32 clientReference
    ) external whenNotPaused nonReentrant returns (bytes32 messageId) {
        require(address(voucherToken) != address(0), "VOUCHER_NOT_CONFIGURED");
        _requireEligible(msg.sender);
        RemoteRoute memory route = _requireOutboundRoute(destinationChainId, amount);
        require(voucherToken.canonicalAsset() == route.canonicalAsset, "VOUCHER_ASSET_ROUTE_MISMATCH");
        _consumeOutbound(msg.sender, route.canonicalAsset, amount);
        voucherToken.burnFromWithPolicy(msg.sender, route.canonicalAsset, amount);
        messageId = _sendTransfer(
            destinationChainId,
            route,
            InstitutionalCollateralMessageLib.Action.BurnUnlock,
            msg.sender,
            recipient,
            amount,
            timeoutTimestamp,
            clientReference
        );
    }

    function onInstitutionalMessage(
        bytes32 messageId,
        uint256 sourceChainId,
        address sourceApplication,
        bytes calldata payload
    ) external whenNotPaused returns (bytes memory acknowledgement) {
        require(msg.sender == address(gateway), "ONLY_GATEWAY");
        RemoteRoute memory route = remoteRoutes[sourceChainId];
        require(route.enabled && route.remoteApplication == sourceApplication, "UNTRUSTED_SOURCE_APPLICATION");
        InstitutionalCollateralMessageLib.TransferData memory transfer = InstitutionalCollateralMessageLib.decode(payload);
        require(transfer.canonicalAsset == route.canonicalAsset, "TRANSFER_ASSET_ROUTE_MISMATCH");
        _requireWithinLimit(route, transfer.amount);
        _requireEligible(transfer.recipient);

        if (transfer.action == InstitutionalCollateralMessageLib.Action.LockMint) {
            require(address(voucherToken) != address(0), "VOUCHER_NOT_CONFIGURED");
            require(voucherToken.canonicalAsset() == transfer.canonicalAsset, "VOUCHER_ASSET_ROUTE_MISMATCH");
            voucherToken.mintWithPolicy(
                transfer.recipient,
                transfer.canonicalAsset,
                sourceChainId,
                transfer.amount,
                messageId
            );
        } else {
            require(address(escrowVault) != address(0), "ESCROW_NOT_CONFIGURED");
            require(address(escrowVault.asset()) == transfer.canonicalAsset, "ESCROW_ASSET_ROUTE_MISMATCH");
            escrowVault.unlockToWithPolicyNoExposureReduction(
                transfer.recipient,
                sourceChainId,
                transfer.amount,
                messageId
            );
        }

        acknowledgement = InstitutionalCollateralMessageLib.acknowledgement(messageId, transfer.action, transfer.amount);
        emit CollateralMessageReceived(messageId, transfer.action, transfer.recipient, transfer.amount);
    }

    function onInstitutionalAcknowledgement(bytes32 messageId, bytes calldata acknowledgement) external {
        require(msg.sender == address(gateway), "ONLY_GATEWAY");
        PendingTransfer storage pending = pendingTransfers[messageId];
        require(pending.status == TransferStatus.Pending, "TRANSFER_NOT_PENDING");
        (uint64 version, bytes32 acknowledgedMessageId, InstitutionalCollateralMessageLib.Action action, uint256 amount) =
            abi.decode(acknowledgement, (uint64, bytes32, InstitutionalCollateralMessageLib.Action, uint256));
        require(version == InstitutionalCollateralMessageLib.ACKNOWLEDGEMENT_VERSION, "BAD_ACKNOWLEDGEMENT_VERSION");
        require(acknowledgedMessageId == messageId, "ACKNOWLEDGEMENT_MESSAGE_MISMATCH");
        require(action == pending.action && amount == pending.amount, "ACKNOWLEDGEMENT_TRANSFER_MISMATCH");
        require(
            keccak256(acknowledgement)
                == keccak256(InstitutionalCollateralMessageLib.acknowledgement(messageId, action, amount)),
            "NON_CANONICAL_ACKNOWLEDGEMENT"
        );
        pending.status = TransferStatus.Completed;
        emit CollateralMessageCompleted(messageId, keccak256(acknowledgement));
    }

    function onInstitutionalTimeout(bytes32 messageId) external nonReentrant {
        require(msg.sender == address(gateway), "ONLY_GATEWAY");
        PendingTransfer storage pending = pendingTransfers[messageId];
        require(pending.status == TransferStatus.Pending, "TRANSFER_NOT_PENDING");
        pending.status = TransferStatus.Refunded;

        if (pending.action == InstitutionalCollateralMessageLib.Action.LockMint) {
            escrowVault.unlockToWithPolicyNoExposureReduction(
                pending.sender,
                pending.destinationChainId,
                pending.amount,
                messageId
            );
        } else {
            voucherToken.mintWithPolicy(
                pending.sender,
                pending.canonicalAsset,
                pending.destinationChainId,
                pending.amount,
                messageId
            );
        }
        emit CollateralMessageRefunded(messageId, pending.action, pending.sender, pending.amount);
    }

    function _sendTransfer(
        uint256 destinationChainId,
        RemoteRoute memory route,
        InstitutionalCollateralMessageLib.Action action,
        address sender,
        address recipient,
        uint256 amount,
        uint64 timeoutTimestamp,
        bytes32 clientReference
    ) internal returns (bytes32 messageId) {
        require(recipient != address(0), "RECIPIENT_ZERO");
        require(timeoutTimestamp > block.timestamp, "TIMEOUT_NOT_FORWARD");
        require(clientReference != bytes32(0), "CLIENT_REFERENCE_ZERO");
        if (clientReferenceUsed[sender][clientReference]) {
            revert ClientReferenceAlreadyUsed(sender, clientReference);
        }
        bytes memory payload = InstitutionalCollateralMessageLib.encode(
            InstitutionalCollateralMessageLib.TransferData({
                version: InstitutionalCollateralMessageLib.VERSION,
                action: action,
                sender: sender,
                recipient: recipient,
                canonicalAsset: route.canonicalAsset,
                amount: amount,
                clientReference: clientReference
            })
        );
        (messageId,) = gateway.sendMessage(destinationChainId, route.remoteApplication, payload, timeoutTimestamp);
        clientReferenceUsed[sender][clientReference] = true;
        messageByClientReference[sender][clientReference] = messageId;
        require(pendingTransfers[messageId].status == TransferStatus.None, "TRANSFER_ALREADY_EXISTS");
        pendingTransfers[messageId] = PendingTransfer({
            action: action,
            sender: sender,
            recipient: recipient,
            canonicalAsset: route.canonicalAsset,
            amount: amount,
            destinationChainId: destinationChainId,
            status: TransferStatus.Pending
        });
        emit CollateralMessageSent(messageId, action, sender, recipient, amount, destinationChainId, clientReference);
    }

    function _requireOutboundRoute(uint256 destinationChainId, uint256 amount)
        internal
        view
        returns (RemoteRoute memory route)
    {
        route = remoteRoutes[destinationChainId];
        require(route.enabled, "REMOTE_ROUTE_DISABLED");
        _requireWithinLimit(route, amount);
    }

    function _requireWithinLimit(RemoteRoute memory route, uint256 amount) internal pure {
        require(amount > 0, "AMOUNT_ZERO");
        require(route.perTransferLimit == 0 || amount <= route.perTransferLimit, "PER_TRANSFER_LIMIT_EXCEEDED");
    }

    function _consumeOutbound(address account, address canonicalAsset, uint256 amount) internal {
        uint256 limit = dailyOutboundLimit[canonicalAsset];
        if (limit == 0) return;
        uint256 day = block.timestamp / 1 days;
        uint256 consumed = outboundByDay[account][day] + amount;
        require(consumed <= limit, "DAILY_OUTBOUND_LIMIT_EXCEEDED");
        outboundByDay[account][day] = consumed;
    }

    function _requireEligible(address account) internal view {
        if (!identityRegistry.isEligible(account)) revert IdentityNotEligible(account);
    }
}
