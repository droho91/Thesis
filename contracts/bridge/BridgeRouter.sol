// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MessageBus} from "./MessageBus.sol";
import {MessageInbox} from "./MessageInbox.sol";
import {MessageLib} from "./MessageLib.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {BankCheckpointClient} from "../checkpoint/BankCheckpointClient.sol";
import {RouteRegistry} from "../risk/RouteRegistry.sol";
import {RiskManager} from "../risk/RiskManager.sol";
import {FeeVault} from "../fees/FeeVault.sol";
import {WrappedCollateral} from "../WrappedCollateral.sol";
import {CollateralVault} from "../CollateralVault.sol";

/// @title BridgeRouter
/// @notice Executes bridge actions only after signed checkpoint and message inclusion verification.
contract BridgeRouter is ReentrancyGuard {
    using MessageLib for MessageLib.Message;

    uint256 public immutable localChainId;
    MessageBus public immutable messageBus;
    BankCheckpointClient public immutable checkpointClient;
    MessageInbox public immutable inbox;
    RouteRegistry public immutable routeRegistry;
    RiskManager public immutable riskManager;
    FeeVault public immutable feeVault;
    mapping(bytes32 => mapping(address => address)) public unlockOwnerForRecipient;
    mapping(bytes32 => mapping(address => uint256)) public mintedBalanceForRecipient;
    mapping(address => mapping(address => address)) public unlockOwnerForAssetRecipient;
    mapping(address => mapping(address => uint256)) public mintedBalanceForAssetRecipient;

    event InclusionProofVerified(
        bytes32 indexed messageId,
        bytes32 indexed routeId,
        bytes32 indexed checkpointHash,
        address relayer
    );
    event Routed(
        bytes32 indexed messageId,
        bytes32 indexed routeId,
        uint8 indexed action,
        address target,
        address recipient,
        uint256 amount
    );
    event ReleaseRequested(
        bytes32 indexed messageId,
        bytes32 indexed routeId,
        address indexed user,
        address unlockOwner,
        uint256 amount
    );
    event UnlockRightRecorded(
        bytes32 indexed routeId,
        address indexed wrappedRecipient,
        address indexed unlockOwner,
        uint256 amount
    );

    constructor(
        uint256 _localChainId,
        address _messageBus,
        address _checkpointClient,
        address _inbox,
        address _routeRegistry,
        address _riskManager,
        address _feeVault
    ) {
        require(_localChainId != 0, "CHAIN_ID_ZERO");
        require(_messageBus != address(0), "MESSAGE_BUS_ZERO");
        require(_checkpointClient != address(0), "CHECKPOINT_CLIENT_ZERO");
        require(_inbox != address(0), "INBOX_ZERO");
        require(_routeRegistry != address(0), "ROUTE_REGISTRY_ZERO");
        require(_riskManager != address(0), "RISK_MANAGER_ZERO");
        require(_feeVault != address(0), "FEE_VAULT_ZERO");

        localChainId = _localChainId;
        messageBus = MessageBus(_messageBus);
        checkpointClient = BankCheckpointClient(_checkpointClient);
        inbox = MessageInbox(_inbox);
        routeRegistry = RouteRegistry(_routeRegistry);
        riskManager = RiskManager(_riskManager);
        feeVault = FeeVault(payable(_feeVault));
    }

    /// @notice Burn wrapped collateral and emit a canonical release message on the local MessageBus.
    function requestBurn(bytes32 routeId, uint256 amount, address recipient)
        external
        payable
        nonReentrant
        returns (bytes32 messageId)
    {
        RouteRegistry.RouteConfig memory route = routeRegistry.getRoute(routeId);
        require(route.enabled, "ROUTE_DISABLED");
        require(route.action == MessageLib.ACTION_BURN_TO_UNLOCK, "BAD_ACTION");
        require(route.sourceChainId == localChainId, "ROUTE_SOURCE_MISMATCH");
        require(route.destinationChainId != localChainId, "ROUTE_DESTINATION_MISMATCH");
        require(route.sourceAsset != address(0), "SOURCE_ASSET_ZERO");
        require(recipient != address(0), "RECIPIENT_ZERO");
        require(amount > 0, "AMOUNT_ZERO");
        require(unlockOwnerForAssetRecipient[route.sourceAsset][msg.sender] == recipient, "UNLOCK_OWNER_MISMATCH");
        require(mintedBalanceForAssetRecipient[route.sourceAsset][msg.sender] >= amount, "INSUFFICIENT_UNLOCK_RIGHTS");

        uint256 fee = riskManager.quoteFee(routeId, amount);
        require(msg.value >= fee, "INSUFFICIENT_PREPAID_FEE");
        mintedBalanceForAssetRecipient[route.sourceAsset][msg.sender] -= amount;
        WrappedCollateral(route.sourceAsset).burn(msg.sender, amount);
        (messageId,) = messageBus.dispatchMessage(
            routeId,
            MessageLib.ACTION_BURN_TO_UNLOCK,
            route.destinationChainId,
            msg.sender,
            recipient,
            route.sourceAsset,
            amount,
            fee,
            bytes32(0)
        );
        if (fee > 0) {
            feeVault.collectPrepaidFee{value: fee}(routeId, messageId);
        }
        if (msg.value > fee) {
            (bool refundOk,) = payable(msg.sender).call{value: msg.value - fee}("");
            require(refundOk, "FEE_REFUND_FAILED");
        }

        emit ReleaseRequested(messageId, routeId, msg.sender, recipient, amount);
    }

    function relayMessage(MessageLib.Message calldata message, BankCheckpointClient.MessageProof calldata proof)
        external
        nonReentrant
        returns (bytes32 messageId)
    {
        require(message.destinationChainId == localChainId, "WRONG_DESTINATION_CHAIN");

        RouteRegistry.RouteConfig memory route = routeRegistry.getRoute(message.routeId);
        require(route.enabled, "ROUTE_DISABLED");
        require(route.action == message.action, "ROUTE_ACTION_MISMATCH");
        require(route.sourceChainId == message.sourceChainId, "ROUTE_SOURCE_MISMATCH");
        require(route.destinationChainId == message.destinationChainId, "ROUTE_DESTINATION_MISMATCH");
        require(route.sourceEmitter == message.sourceEmitter, "SOURCE_EMITTER_MISMATCH");
        require(route.sourceSender == message.sourceSender, "SOURCE_SENDER_MISMATCH");
        require(route.sourceAsset == message.asset, "SOURCE_ASSET_MISMATCH");
        require(message.owner != address(0), "OWNER_ZERO");
        require(message.amount > 0, "AMOUNT_ZERO");
        require(message.recipient != address(0), "RECIPIENT_ZERO");

        messageId = MessageLib.messageId(message);
        bytes32 leaf = MessageLib.leafHash(message);
        require(
            checkpointClient.verifyMessageInclusion(
                message.sourceChainId,
                proof.checkpointHash,
                leaf,
                proof.leafIndex,
                proof.siblings
            ),
            "INVALID_MESSAGE_PROOF"
        );

        require(!inbox.consumed(messageId), "MESSAGE_ALREADY_CONSUMED");
        uint256 fee = riskManager.validateAndConsume(message.routeId, messageId, message.amount);
        require(message.prepaidFee >= fee, "PREPAID_FEE_TOO_LOW");
        if (fee > 0) {
            feeVault.payRelayerReward(message.routeId, messageId, payable(msg.sender), fee);
        }
        inbox.consume(messageId);

        emit InclusionProofVerified(messageId, message.routeId, proof.checkpointHash, msg.sender);

        if (message.action == MessageLib.ACTION_LOCK_TO_MINT) {
            address existingOwner = unlockOwnerForRecipient[message.routeId][message.recipient];
            require(existingOwner == address(0) || existingOwner == message.owner, "UNLOCK_OWNER_CONFLICT");
            unlockOwnerForRecipient[message.routeId][message.recipient] = message.owner;
            mintedBalanceForRecipient[message.routeId][message.recipient] += message.amount;
            address existingAssetOwner = unlockOwnerForAssetRecipient[route.target][message.recipient];
            require(existingAssetOwner == address(0) || existingAssetOwner == message.owner, "UNLOCK_OWNER_CONFLICT");
            unlockOwnerForAssetRecipient[route.target][message.recipient] = message.owner;
            mintedBalanceForAssetRecipient[route.target][message.recipient] += message.amount;
            WrappedCollateral(route.target).mintFromLockEvent(message.recipient, message.amount, messageId);
            emit UnlockRightRecorded(message.routeId, message.recipient, message.owner, message.amount);
        } else if (message.action == MessageLib.ACTION_BURN_TO_UNLOCK) {
            CollateralVault(route.target).unlockFromBurnEvent(message.recipient, message.amount, messageId);
        } else {
            revert("BAD_ACTION");
        }

        emit Routed(messageId, message.routeId, message.action, route.target, message.recipient, message.amount);
    }
}
