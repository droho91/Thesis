// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BridgeRouter} from "../contracts/bridge/BridgeRouter.sol";
import {MessageBus} from "../contracts/bridge/MessageBus.sol";
import {MessageInbox} from "../contracts/bridge/MessageInbox.sol";
import {MessageLib} from "../contracts/bridge/MessageLib.sol";
import {LightClient, DevHeaderUpdateVerifier} from "../contracts/lightclient/LightClient.sol";
import {ExecutionHeaderStore} from "../contracts/lightclient/ExecutionHeaderStore.sol";
import {ReceiptProofVerifier} from "../contracts/lightclient/ReceiptProofVerifier.sol";
import {RouteRegistry} from "../contracts/risk/RouteRegistry.sol";
import {RiskManager} from "../contracts/risk/RiskManager.sol";
import {FeeVault} from "../contracts/fees/FeeVault.sol";
import {CollateralVault} from "../contracts/CollateralVault.sol";
import {WrappedCollateral} from "../contracts/WrappedCollateral.sol";
import {StableToken} from "../contracts/StableToken.sol";
import {LendingPool} from "../contracts/LendingPool.sol";
import {MockPriceOracle} from "../contracts/MockPriceOracle.sol";
import {MockSwapRouter} from "../contracts/MockSwapRouter.sol";

contract BridgeRouterTest is Test {
    using MessageLib for MessageLib.Message;

    uint8 internal constant ACTION_LOCK_TO_MINT = 1;
    uint8 internal constant ACTION_BURN_TO_UNLOCK = 2;
    uint256 internal constant CHAIN_A = 100;
    uint256 internal constant CHAIN_B = 200;

    bytes32 internal constant DEV_HEADER_DOMAIN = keccak256("DEV_LIGHT_CLIENT_HEADER_UPDATE_V1");
    bytes32 internal constant DEV_RECEIPT_DOMAIN = keccak256("DEV_RECEIPT_INCLUSION_PROOF_V1");

    address internal user = address(0x1111);
    address internal relayer = address(0x2222);
    address internal anyRelayer = address(0x3333);

    MessageBus internal busA;
    MessageBus internal busB;
    LightClient internal lightClientA;
    LightClient internal lightClientB;
    ExecutionHeaderStore internal headerStoreA;
    ExecutionHeaderStore internal headerStoreB;
    ReceiptProofVerifier internal proofVerifierA;
    ReceiptProofVerifier internal proofVerifierB;
    MessageInbox internal inboxA;
    MessageInbox internal inboxB;
    RouteRegistry internal routesA;
    RouteRegistry internal routesB;
    RiskManager internal riskA;
    RiskManager internal riskB;
    FeeVault internal feesA;
    FeeVault internal feesB;
    BridgeRouter internal routerA;
    BridgeRouter internal routerB;

    StableToken internal collateralA;
    StableToken internal stableB;
    WrappedCollateral internal wrappedA;
    CollateralVault internal vaultA;
    MockPriceOracle internal oracleB;
    MockSwapRouter internal swapRouterB;
    LendingPool internal poolB;

    bytes32 internal lockRoute;
    bytes32 internal burnRoute;

    function setUp() public {
        busA = new MessageBus(CHAIN_A);
        busB = new MessageBus(CHAIN_B);

        (lightClientA, headerStoreA, proofVerifierA, inboxA, routesA, riskA, feesA, routerA) =
            _deployRouterStack(CHAIN_A, busA);
        (lightClientB, headerStoreB, proofVerifierB, inboxB, routesB, riskB, feesB, routerB) =
            _deployRouterStack(CHAIN_B, busB);

        collateralA = new StableToken("Chain A Collateral", "aCOL");
        stableB = new StableToken("Chain B Stable", "sB");
        wrappedA = new WrappedCollateral("Wrapped A Collateral", "wA", address(routerB));
        vaultA = new CollateralVault(address(collateralA), address(routerA));

        oracleB = new MockPriceOracle();
        oracleB.setPrice(address(wrappedA), 1e8);
        oracleB.setPrice(address(stableB), 1e8);
        poolB = new LendingPool(address(wrappedA), address(stableB), address(oracleB), 5_000);
        swapRouterB = new MockSwapRouter(address(oracleB), 0);
        poolB.setSwapRouter(address(swapRouterB));
        stableB.mint(address(poolB), 1_000 ether);

        lockRoute = keccak256("A_TO_B_LOCK_TO_MINT");
        burnRoute = keccak256("B_TO_A_BURN_TO_UNLOCK");

        vaultA.configureDefaultRoute(address(busA), lockRoute, CHAIN_B);
        _setRoute(routesB, lockRoute, ACTION_LOCK_TO_MINT, CHAIN_A, CHAIN_B, address(busA), address(vaultA), address(collateralA), address(wrappedA), 500 ether, 1_000 ether, 1 days, 0);
        _setRoute(routesA, burnRoute, ACTION_BURN_TO_UNLOCK, CHAIN_B, CHAIN_A, address(busB), address(routerB), address(wrappedA), address(vaultA), 500 ether, 1_000 ether, 1 days, 0);
        _setRoute(routesB, burnRoute, ACTION_BURN_TO_UNLOCK, CHAIN_B, CHAIN_A, address(busB), address(routerB), address(wrappedA), address(vaultA), 500 ether, 1_000 ether, 1 days, 0);

        collateralA.mint(user, 1_000 ether);
        vm.prank(user);
        collateralA.approve(address(vaultA), type(uint256).max);
    }

    function testLockMintSucceedsOnlyAfterFinalizedHeaderAndProof() public {
        MessageLib.Message memory message = _lockOnA(100 ether);
        ReceiptProofVerifier.ReceiptProof memory proof =
            _proofFor(message, address(busA), 7, keccak256("A_BLOCK_1"), keccak256("A_RECEIPTS_1"));

        vm.expectRevert(bytes("INVALID_RECEIPT_PROOF"));
        vm.prank(relayer);
        routerB.relayMessage(message, proof);

        _finalizeOnB(CHAIN_A, 10, proof.blockHash, proof.receiptsRoot);

        vm.prank(relayer);
        routerB.relayMessage(message, proof);

        assertEq(wrappedA.balanceOf(user), 100 ether);
        assertTrue(inboxB.consumed(message.messageId()));
    }

    function testBurnUnlockSucceedsOnlyAfterFinalizedHeaderAndProof() public {
        _mintFromA(120 ether);

        vm.startPrank(user);
        wrappedA.approve(address(poolB), type(uint256).max);
        stableB.approve(address(poolB), type(uint256).max);
        poolB.depositCollateral(120 ether);
        poolB.borrow(40 ether);
        poolB.repay(40 ether);
        poolB.withdrawCollateral(120 ether);
        routerB.requestBurn(burnRoute, 120 ether, user);
        vm.stopPrank();

        MessageLib.Message memory burnMessage = _burnMessage(120 ether, busB.nonces(address(routerB)));
        ReceiptProofVerifier.ReceiptProof memory proof =
            _proofFor(burnMessage, address(busB), 3, keccak256("B_BLOCK_1"), keccak256("B_RECEIPTS_1"));

        vm.expectRevert(bytes("INVALID_RECEIPT_PROOF"));
        vm.prank(relayer);
        routerA.relayMessage(burnMessage, proof);

        _finalizeOnA(CHAIN_B, 20, proof.blockHash, proof.receiptsRoot);

        vm.prank(relayer);
        routerA.relayMessage(burnMessage, proof);

        assertEq(vaultA.lockedBalance(user), 0);
        assertEq(collateralA.balanceOf(user), 1_000 ether);
        assertTrue(inboxA.consumed(burnMessage.messageId()));
    }

    function testReplayAttackFails() public {
        MessageLib.Message memory message = _lockOnA(25 ether);
        ReceiptProofVerifier.ReceiptProof memory proof =
            _proofFor(message, address(busA), 1, keccak256("A_BLOCK_REPLAY"), keccak256("A_RECEIPTS_REPLAY"));
        _finalizeOnB(CHAIN_A, 11, proof.blockHash, proof.receiptsRoot);

        vm.prank(relayer);
        routerB.relayMessage(message, proof);

        vm.expectRevert(bytes("MESSAGE_ALREADY_CONSUMED"));
        vm.prank(relayer);
        routerB.relayMessage(message, proof);
    }

    function testInvalidProofFails() public {
        MessageLib.Message memory message = _lockOnA(30 ether);
        ReceiptProofVerifier.ReceiptProof memory proof =
            _proofFor(message, address(busA), 1, keccak256("A_BLOCK_BAD_PROOF"), keccak256("A_RECEIPTS_BAD_PROOF"));
        _finalizeOnB(CHAIN_A, 12, proof.blockHash, proof.receiptsRoot);

        proof.proofRoot = keccak256("invalid proof");
        vm.expectRevert(bytes("INVALID_RECEIPT_PROOF"));
        vm.prank(relayer);
        routerB.relayMessage(message, proof);
    }

    function testWrongRouteFails() public {
        MessageLib.Message memory message = _lockOnA(30 ether);
        message.routeId = keccak256("WRONG_ROUTE");
        ReceiptProofVerifier.ReceiptProof memory proof =
            _proofFor(message, address(busA), 1, keccak256("A_BLOCK_WRONG_ROUTE"), keccak256("A_RECEIPTS_WRONG_ROUTE"));
        _finalizeOnB(CHAIN_A, 13, proof.blockHash, proof.receiptsRoot);

        vm.expectRevert(bytes("ROUTE_DISABLED"));
        vm.prank(relayer);
        routerB.relayMessage(message, proof);
    }

    function testWrongSourceEmitterFails() public {
        MessageLib.Message memory message = _lockOnA(30 ether);
        ReceiptProofVerifier.ReceiptProof memory proof =
            _proofFor(message, address(0xBEEF), 1, keccak256("A_BLOCK_BAD_EMITTER"), keccak256("A_RECEIPTS_BAD_EMITTER"));
        _finalizeOnB(CHAIN_A, 14, proof.blockHash, proof.receiptsRoot);

        vm.expectRevert(bytes("SOURCE_EMITTER_MISMATCH"));
        vm.prank(relayer);
        routerB.relayMessage(message, proof);
    }

    function testWrongSourceSenderFails() public {
        MessageLib.Message memory message = _lockOnA(30 ether);
        message.sourceSender = address(0xBEEF);
        ReceiptProofVerifier.ReceiptProof memory proof =
            _proofFor(message, address(busA), 1, keccak256("A_BLOCK_BAD_SENDER"), keccak256("A_RECEIPTS_BAD_SENDER"));
        _finalizeOnB(CHAIN_A, 19, proof.blockHash, proof.receiptsRoot);

        vm.expectRevert(bytes("SOURCE_SENDER_MISMATCH"));
        vm.prank(relayer);
        routerB.relayMessage(message, proof);
    }

    function testPausedRouteFails() public {
        MessageLib.Message memory message = _lockOnA(30 ether);
        ReceiptProofVerifier.ReceiptProof memory proof =
            _proofFor(message, address(busA), 1, keccak256("A_BLOCK_PAUSED"), keccak256("A_RECEIPTS_PAUSED"));
        _finalizeOnB(CHAIN_A, 15, proof.blockHash, proof.receiptsRoot);

        riskB.setRoutePaused(lockRoute, true);

        vm.expectRevert(bytes("ROUTE_PAUSED"));
        vm.prank(relayer);
        routerB.relayMessage(message, proof);
    }

    function testRateLimitExceededFails() public {
        _setRoute(routesB, lockRoute, ACTION_LOCK_TO_MINT, CHAIN_A, CHAIN_B, address(busA), address(vaultA), address(collateralA), address(wrappedA), 500 ether, 50 ether, 1 days, 0);
        MessageLib.Message memory message = _lockOnA(60 ether);
        ReceiptProofVerifier.ReceiptProof memory proof =
            _proofFor(message, address(busA), 1, keccak256("A_BLOCK_RATE"), keccak256("A_RECEIPTS_RATE"));
        _finalizeOnB(CHAIN_A, 16, proof.blockHash, proof.receiptsRoot);

        vm.expectRevert(bytes("RATE_LIMIT_EXCEEDED"));
        vm.prank(relayer);
        routerB.relayMessage(message, proof);
    }

    function testHighValueRequiresSecondaryApproval() public {
        _setRoute(routesB, lockRoute, ACTION_LOCK_TO_MINT, CHAIN_A, CHAIN_B, address(busA), address(vaultA), address(collateralA), address(wrappedA), 500 ether, 1_000 ether, 1 days, 50 ether);
        MessageLib.Message memory message = _lockOnA(60 ether);
        ReceiptProofVerifier.ReceiptProof memory proof =
            _proofFor(message, address(busA), 1, keccak256("A_BLOCK_HIGH"), keccak256("A_RECEIPTS_HIGH"));
        _finalizeOnB(CHAIN_A, 17, proof.blockHash, proof.receiptsRoot);

        vm.expectRevert(bytes("SECONDARY_APPROVAL_REQUIRED"));
        vm.prank(relayer);
        routerB.relayMessage(message, proof);

        riskB.approveHighValue(lockRoute, message.messageId());

        vm.prank(relayer);
        routerB.relayMessage(message, proof);

        assertEq(wrappedA.balanceOf(user), 60 ether);
    }

    function testAnyRelayerCanSubmitHeadersAndProofs() public {
        MessageLib.Message memory message = _lockOnA(45 ether);
        ReceiptProofVerifier.ReceiptProof memory proof =
            _proofFor(message, address(busA), 1, keccak256("A_BLOCK_ANY"), keccak256("A_RECEIPTS_ANY"));

        vm.startPrank(anyRelayer);
        _submitHeader(lightClientB, CHAIN_A, 18, proof.blockHash);
        headerStoreB.submitExecutionHeader(
            ExecutionHeaderStore.ExecutionHeader({
                sourceChainId: CHAIN_A,
                blockNumber: 18,
                blockHash: proof.blockHash,
                parentHash: bytes32(0),
                receiptsRoot: proof.receiptsRoot,
                timestamp: block.timestamp,
                finalizedCheckpoint: proof.blockHash
            })
        );
        routerB.relayMessage(message, proof);
        vm.stopPrank();

        assertEq(wrappedA.balanceOf(user), 45 ether);
    }

    function _deployRouterStack(uint256 localChainId, MessageBus bus)
        internal
        returns (
            LightClient lightClient,
            ExecutionHeaderStore headerStore,
            ReceiptProofVerifier proofVerifier,
            MessageInbox inbox,
            RouteRegistry routes,
            RiskManager risk,
            FeeVault fees,
            BridgeRouter router
        )
    {
        DevHeaderUpdateVerifier headerVerifier = new DevHeaderUpdateVerifier();
        lightClient = new LightClient(address(headerVerifier));
        headerStore = new ExecutionHeaderStore(address(lightClient));
        proofVerifier = new ReceiptProofVerifier(address(headerStore));
        inbox = new MessageInbox();
        routes = new RouteRegistry();
        risk = new RiskManager(address(routes));
        fees = new FeeVault(0);
        router = new BridgeRouter(
            localChainId,
            address(bus),
            address(proofVerifier),
            address(inbox),
            address(routes),
            address(risk),
            address(fees)
        );
        inbox.grantConsumer(address(router));
        risk.grantPolicyCaller(address(router));
        fees.grantCollector(address(router));
    }

    function _setRoute(
        RouteRegistry registry,
        bytes32 routeId,
        uint8 action,
        uint256 sourceChainId,
        uint256 destinationChainId,
        address sourceEmitter,
        address sourceSender,
        address sourceAsset,
        address target,
        uint256 transferCap,
        uint256 rateLimitAmount,
        uint256 rateLimitWindow,
        uint256 highValueThreshold
    ) internal {
        registry.setRoute(
            routeId,
            RouteRegistry.RouteConfig({
                enabled: true,
                action: action,
                sourceChainId: sourceChainId,
                destinationChainId: destinationChainId,
                sourceEmitter: sourceEmitter,
                sourceSender: sourceSender,
                sourceAsset: sourceAsset,
                target: target,
                flatFee: 0,
                feeBps: 0,
                transferCap: transferCap,
                rateLimitAmount: rateLimitAmount,
                rateLimitWindow: rateLimitWindow,
                highValueThreshold: highValueThreshold
            })
        );
    }

    function _lockOnA(uint256 amount) internal returns (MessageLib.Message memory message) {
        vm.prank(user);
        vaultA.lock(amount);
        return _lockMessage(amount, busA.nonces(address(vaultA)));
    }

    function _mintFromA(uint256 amount) internal returns (MessageLib.Message memory message) {
        message = _lockOnA(amount);
        ReceiptProofVerifier.ReceiptProof memory proof =
            _proofFor(message, address(busA), 1, keccak256(abi.encode("A_BLOCK_MINT", amount)), keccak256(abi.encode("A_RECEIPTS_MINT", amount)));
        _finalizeOnB(CHAIN_A, 30 + (amount / 1 ether), proof.blockHash, proof.receiptsRoot);
        vm.prank(relayer);
        routerB.relayMessage(message, proof);
    }

    function _lockMessage(uint256 amount, uint256 nonce) internal view returns (MessageLib.Message memory) {
        return MessageLib.Message({
            routeId: lockRoute,
            action: ACTION_LOCK_TO_MINT,
            sourceChainId: CHAIN_A,
            destinationChainId: CHAIN_B,
            sourceSender: address(vaultA),
            recipient: user,
            asset: address(collateralA),
            amount: amount,
            nonce: nonce,
            payloadHash: bytes32(0)
        });
    }

    function _burnMessage(uint256 amount, uint256 nonce) internal view returns (MessageLib.Message memory) {
        return MessageLib.Message({
            routeId: burnRoute,
            action: ACTION_BURN_TO_UNLOCK,
            sourceChainId: CHAIN_B,
            destinationChainId: CHAIN_A,
            sourceSender: address(routerB),
            recipient: user,
            asset: address(wrappedA),
            amount: amount,
            nonce: nonce,
            payloadHash: bytes32(0)
        });
    }

    function _proofFor(
        MessageLib.Message memory message,
        address emitter,
        uint256 logIndex,
        bytes32 blockHash,
        bytes32 receiptsRoot
    ) internal pure returns (ReceiptProofVerifier.ReceiptProof memory proof) {
        bytes32 eventHash = message.eventHash();
        proof = ReceiptProofVerifier.ReceiptProof({
            sourceChainId: message.sourceChainId,
            blockHash: blockHash,
            receiptsRoot: receiptsRoot,
            emitter: emitter,
            logIndex: logIndex,
            proofRoot: keccak256(
                abi.encode(DEV_RECEIPT_DOMAIN, message.sourceChainId, blockHash, receiptsRoot, emitter, logIndex, eventHash)
            )
        });
    }

    function _finalizeOnA(uint256 sourceChainId, uint256 blockNumber, bytes32 blockHash, bytes32 receiptsRoot)
        internal
    {
        _submitHeader(lightClientA, sourceChainId, blockNumber, blockHash);
        headerStoreA.submitExecutionHeader(
            ExecutionHeaderStore.ExecutionHeader({
                sourceChainId: sourceChainId,
                blockNumber: blockNumber,
                blockHash: blockHash,
                parentHash: bytes32(0),
                receiptsRoot: receiptsRoot,
                timestamp: block.timestamp,
                finalizedCheckpoint: blockHash
            })
        );
    }

    function _finalizeOnB(uint256 sourceChainId, uint256 blockNumber, bytes32 blockHash, bytes32 receiptsRoot)
        internal
    {
        _submitHeader(lightClientB, sourceChainId, blockNumber, blockHash);
        headerStoreB.submitExecutionHeader(
            ExecutionHeaderStore.ExecutionHeader({
                sourceChainId: sourceChainId,
                blockNumber: blockNumber,
                blockHash: blockHash,
                parentHash: bytes32(0),
                receiptsRoot: receiptsRoot,
                timestamp: block.timestamp,
                finalizedCheckpoint: blockHash
            })
        );
    }

    function _submitHeader(LightClient client, uint256 sourceChainId, uint256 blockNumber, bytes32 blockHash) internal {
        LightClient.HeaderUpdate memory update = LightClient.HeaderUpdate({
            sourceChainId: sourceChainId,
            blockNumber: blockNumber,
            blockHash: blockHash,
            parentHash: bytes32(0),
            stateRoot: keccak256(abi.encode("state", sourceChainId, blockNumber, blockHash)),
            timestamp: block.timestamp
        });
        bytes memory proof = abi.encode(
            keccak256(
                abi.encode(
                    DEV_HEADER_DOMAIN,
                    update.sourceChainId,
                    update.blockNumber,
                    update.blockHash,
                    update.parentHash,
                    update.stateRoot,
                    update.timestamp
                )
            )
        );
        client.submitFinalizedHeader(update, proof);
    }
}
