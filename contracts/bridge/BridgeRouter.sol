// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MessageBus} from "./MessageBus.sol";
import {MessageInbox} from "./MessageInbox.sol";
import {MessageLib} from "./MessageLib.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ReceiptProofVerifier} from "../lightclient/ReceiptProofVerifier.sol";
import {RouteRegistry} from "../risk/RouteRegistry.sol";
import {RiskManager} from "../risk/RiskManager.sol";
import {FeeVault} from "../fees/FeeVault.sol";
import {WrappedCollateral} from "../WrappedCollateral.sol";
import {CollateralVault} from "../CollateralVault.sol";

/// @title BridgeRouter
/// @notice Executes bridge actions only after finalized-header and receipt-proof verification.
contract BridgeRouter is ReentrancyGuard {
    using MessageLib for MessageLib.Message;

    uint256 public immutable localChainId;
    MessageBus public immutable messageBus;
    ReceiptProofVerifier public immutable receiptProofVerifier;
    MessageInbox public immutable inbox;
    RouteRegistry public immutable routeRegistry;
    RiskManager public immutable riskManager;
    FeeVault public immutable feeVault;

    event ProofVerified(bytes32 indexed messageId, bytes32 indexed routeId, address indexed relayer);
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
        address recipient,
        uint256 amount
    );

    constructor(
        uint256 _localChainId,
        address _messageBus,
        address _receiptProofVerifier,
        address _inbox,
        address _routeRegistry,
        address _riskManager,
        address _feeVault
    ) {
        require(_localChainId != 0, "CHAIN_ID_ZERO");
        require(_messageBus != address(0), "MESSAGE_BUS_ZERO");
        require(_receiptProofVerifier != address(0), "PROOF_VERIFIER_ZERO");
        require(_inbox != address(0), "INBOX_ZERO");
        require(_routeRegistry != address(0), "ROUTE_REGISTRY_ZERO");
        require(_riskManager != address(0), "RISK_MANAGER_ZERO");
        require(_feeVault != address(0), "FEE_VAULT_ZERO");

        localChainId = _localChainId;
        messageBus = MessageBus(_messageBus);
        receiptProofVerifier = ReceiptProofVerifier(_receiptProofVerifier);
        inbox = MessageInbox(_inbox);
        routeRegistry = RouteRegistry(_routeRegistry);
        riskManager = RiskManager(_riskManager);
        feeVault = FeeVault(payable(_feeVault));
    }

    /// @notice Burn wrapped collateral and emit a canonical release message on the local MessageBus.
    function requestBurn(bytes32 routeId, uint256 amount, address recipient)
        external
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

        WrappedCollateral(route.sourceAsset).burn(msg.sender, amount);
        (messageId,) = messageBus.dispatchMessage(
            routeId,
            MessageLib.ACTION_BURN_TO_UNLOCK,
            route.destinationChainId,
            recipient,
            route.sourceAsset,
            amount,
            bytes32(0)
        );

        emit ReleaseRequested(messageId, routeId, msg.sender, recipient, amount);
    }

    function relayMessage(MessageLib.Message calldata message, ReceiptProofVerifier.ReceiptProof calldata proof)
        external
        payable
        nonReentrant
        returns (bytes32 messageId)
    {
        require(message.destinationChainId == localChainId, "WRONG_DESTINATION_CHAIN");
        require(message.sourceChainId == proof.sourceChainId, "PROOF_CHAIN_MISMATCH");

        RouteRegistry.RouteConfig memory route = routeRegistry.getRoute(message.routeId);
        require(route.enabled, "ROUTE_DISABLED");
        require(route.action == message.action, "ROUTE_ACTION_MISMATCH");
        require(route.sourceChainId == message.sourceChainId, "ROUTE_SOURCE_MISMATCH");
        require(route.destinationChainId == message.destinationChainId, "ROUTE_DESTINATION_MISMATCH");
        require(route.sourceEmitter == proof.emitter, "SOURCE_EMITTER_MISMATCH");
        require(route.sourceSender == message.sourceSender, "SOURCE_SENDER_MISMATCH");
        require(route.sourceAsset == message.asset, "SOURCE_ASSET_MISMATCH");
        require(message.amount > 0, "AMOUNT_ZERO");
        require(message.recipient != address(0), "RECIPIENT_ZERO");

        messageId = MessageLib.messageId(message);
        bytes32 expectedEventHash = MessageLib.eventHash(message);
        require(receiptProofVerifier.verifyReceiptProof(proof, expectedEventHash), "INVALID_RECEIPT_PROOF");

        inbox.consume(messageId);
        uint256 fee = riskManager.validateAndConsume(message.routeId, messageId, message.amount);
        require(msg.value >= fee, "INSUFFICIENT_FEE");
        if (fee > 0) {
            feeVault.collectFee{value: fee}(message.routeId, messageId, payable(msg.sender));
        }
        if (msg.value > fee) {
            (bool refundOk,) = payable(msg.sender).call{value: msg.value - fee}("");
            require(refundOk, "FEE_REFUND_FAILED");
        }

        emit ProofVerified(messageId, message.routeId, msg.sender);

        if (message.action == MessageLib.ACTION_LOCK_TO_MINT) {
            WrappedCollateral(route.target).mintFromLockEvent(message.recipient, message.amount, messageId);
        } else if (message.action == MessageLib.ACTION_BURN_TO_UNLOCK) {
            CollateralVault(route.target).unlockFromBurnEvent(message.recipient, message.amount, messageId);
        } else {
            revert("BAD_ACTION");
        }

        emit Routed(messageId, message.routeId, message.action, route.target, message.recipient, message.amount);
    }
}
