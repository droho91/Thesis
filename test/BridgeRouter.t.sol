// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BankCheckpointClient} from "../contracts/checkpoint/BankCheckpointClient.sol";
import {BridgeRouter} from "../contracts/bridge/BridgeRouter.sol";
import {MessageBus} from "../contracts/bridge/MessageBus.sol";
import {MessageInbox} from "../contracts/bridge/MessageInbox.sol";
import {MessageLib} from "../contracts/bridge/MessageLib.sol";
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
    uint256 internal constant VALIDATOR_SET_1 = 1;
    uint256 internal constant VALIDATOR_SET_2 = 2;

    address internal user = address(0x1111);
    address internal relayer = address(0x2222);
    address internal anyRelayer = address(0x3333);

    uint256[] internal validatorKeysA;
    uint256[] internal validatorKeysB;
    uint256[] internal rotatedValidatorKeysA;

    MessageBus internal busA;
    MessageBus internal busB;
    BankCheckpointClient internal checkpointA;
    BankCheckpointClient internal checkpointB;
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
        validatorKeysA.push(101);
        validatorKeysA.push(102);
        validatorKeysA.push(103);
        validatorKeysB.push(201);
        validatorKeysB.push(202);
        validatorKeysB.push(203);
        rotatedValidatorKeysA.push(301);
        rotatedValidatorKeysA.push(302);
        rotatedValidatorKeysA.push(303);

        busA = new MessageBus(CHAIN_A);
        busB = new MessageBus(CHAIN_B);

        (checkpointA, inboxA, routesA, riskA, feesA, routerA) = _deployRouterStack(CHAIN_A, busA);
        (checkpointB, inboxB, routesB, riskB, feesB, routerB) = _deployRouterStack(CHAIN_B, busB);

        _installValidatorSet(checkpointB, CHAIN_A, VALIDATOR_SET_1, validatorKeysA, true);
        _installValidatorSet(checkpointA, CHAIN_B, VALIDATOR_SET_1, validatorKeysB, true);

        collateralA = new StableToken("Bank A Collateral", "aCOL");
        stableB = new StableToken("Bank B Stable", "sB");
        wrappedA = new WrappedCollateral("Wrapped Bank A Collateral", "wA", address(routerB));
        vaultA = new CollateralVault(address(collateralA), address(routerA));

        oracleB = new MockPriceOracle();
        oracleB.setPrice(address(wrappedA), 1e8);
        oracleB.setPrice(address(stableB), 1e8);
        poolB = new LendingPool(address(wrappedA), address(stableB), address(oracleB), 5_000);
        swapRouterB = new MockSwapRouter(address(oracleB), 0);
        poolB.setSwapRouter(address(swapRouterB));
        stableB.mint(address(poolB), 1_000 ether);

        lockRoute = keccak256("BANK_A_TO_BANK_B_LOCK_TO_MINT");
        burnRoute = keccak256("BANK_B_TO_BANK_A_BURN_TO_UNLOCK");

        vaultA.configureDefaultRoute(address(busA), lockRoute, CHAIN_B);
        _setRoute(
            routesB,
            lockRoute,
            ACTION_LOCK_TO_MINT,
            CHAIN_A,
            CHAIN_B,
            address(busA),
            address(vaultA),
            address(collateralA),
            address(wrappedA),
            500 ether,
            1_000 ether,
            1 days,
            0
        );
        _setRoute(
            routesA,
            burnRoute,
            ACTION_BURN_TO_UNLOCK,
            CHAIN_B,
            CHAIN_A,
            address(busB),
            address(routerB),
            address(wrappedA),
            address(vaultA),
            500 ether,
            1_000 ether,
            1 days,
            0
        );
        _setRoute(
            routesB,
            burnRoute,
            ACTION_BURN_TO_UNLOCK,
            CHAIN_B,
            CHAIN_A,
            address(busB),
            address(routerB),
            address(wrappedA),
            address(vaultA),
            500 ether,
            1_000 ether,
            1 days,
            0
        );

        collateralA.mint(user, 1_000 ether);
        vm.prank(user);
        collateralA.approve(address(vaultA), type(uint256).max);
    }

    function testValidCheckpointWithTwoThirdsSignaturesSucceeds() public {
        MessageLib.Message memory message = _lockOnA(100 ether);
        (bytes32 checkpointHash, BankCheckpointClient.MessageProof memory proof) =
            _finalizeMessageOnB(message, 1, VALIDATOR_SET_1, validatorKeysA, 2, bytes32(0), _rightLeaf("A_ROOT_1"));

        assertTrue(checkpointB.isCheckpointVerified(CHAIN_A, checkpointHash));

        vm.prank(relayer);
        routerB.relayMessage(message, proof);

        assertEq(wrappedA.balanceOf(user), 100 ether);
        assertTrue(inboxB.consumed(message.messageId()));
    }

    function testInsufficientSignaturesFail() public {
        MessageLib.Message memory message = _lockOnA(20 ether);
        BankCheckpointClient.Checkpoint memory checkpoint =
            _checkpoint(CHAIN_A, VALIDATOR_SET_1, 1, bytes32(0), message.leafHash());
        bytes32 checkpointHash = checkpointB.hashCheckpoint(checkpoint);

        vm.expectRevert(bytes("INSUFFICIENT_QUORUM"));
        vm.prank(relayer);
        checkpointB.submitCheckpoint(checkpoint, _signatures(validatorKeysA, checkpointHash, 1));
    }

    function testWrongValidatorSetIdFails() public {
        MessageLib.Message memory message = _lockOnA(20 ether);
        _installValidatorSet(checkpointB, CHAIN_A, VALIDATOR_SET_2, rotatedValidatorKeysA, true);

        BankCheckpointClient.Checkpoint memory checkpoint =
            _checkpoint(CHAIN_A, VALIDATOR_SET_2, 1, bytes32(0), message.leafHash());
        bytes32 checkpointHash = checkpointB.hashCheckpoint(checkpoint);

        vm.expectRevert(bytes("SIGNER_NOT_VALIDATOR"));
        vm.prank(relayer);
        checkpointB.submitCheckpoint(checkpoint, _signatures(validatorKeysA, checkpointHash, 2));
    }

    function testValidatorSetRotationRejectsStaleSet() public {
        _installValidatorSet(checkpointB, CHAIN_A, VALIDATOR_SET_2, rotatedValidatorKeysA, true);
        checkpointB.setValidatorSetActive(CHAIN_A, VALIDATOR_SET_1, false);

        MessageLib.Message memory message = _lockOnA(20 ether);
        BankCheckpointClient.Checkpoint memory checkpoint =
            _checkpoint(CHAIN_A, VALIDATOR_SET_1, 1, bytes32(0), message.leafHash());
        bytes32 checkpointHash = checkpointB.hashCheckpoint(checkpoint);

        vm.expectRevert(bytes("VALIDATOR_SET_INACTIVE"));
        vm.prank(relayer);
        checkpointB.submitCheckpoint(checkpoint, _signatures(validatorKeysA, checkpointHash, 2));

        checkpoint.validatorSetId = VALIDATOR_SET_2;
        checkpointHash = checkpointB.hashCheckpoint(checkpoint);
        vm.prank(relayer);
        checkpointB.submitCheckpoint(checkpoint, _signatures(rotatedValidatorKeysA, checkpointHash, 2));
    }

    function testWrongParentCheckpointFails() public {
        MessageLib.Message memory first = _lockOnA(10 ether);
        (bytes32 parentHash,) =
            _finalizeMessageOnB(first, 1, VALIDATOR_SET_1, validatorKeysA, 2, bytes32(0), bytes32(0));

        MessageLib.Message memory second = _lockOnA(11 ether);
        BankCheckpointClient.Checkpoint memory checkpoint =
            _checkpoint(CHAIN_A, VALIDATOR_SET_1, 2, keccak256("wrong-parent"), second.leafHash());
        bytes32 checkpointHash = checkpointB.hashCheckpoint(checkpoint);
        assertTrue(parentHash != checkpoint.parentCheckpointHash);

        vm.expectRevert(bytes("WRONG_PARENT_CHECKPOINT"));
        vm.prank(relayer);
        checkpointB.submitCheckpoint(checkpoint, _signatures(validatorKeysA, checkpointHash, 2));
    }

    function testWrongSequenceFails() public {
        MessageLib.Message memory message = _lockOnA(10 ether);
        BankCheckpointClient.Checkpoint memory checkpoint =
            _checkpoint(CHAIN_A, VALIDATOR_SET_1, 2, bytes32(0), message.leafHash());
        bytes32 checkpointHash = checkpointB.hashCheckpoint(checkpoint);

        vm.expectRevert(bytes("WRONG_SEQUENCE"));
        vm.prank(relayer);
        checkpointB.submitCheckpoint(checkpoint, _signatures(validatorKeysA, checkpointHash, 2));
    }

    function testConflictingCheckpointFreezesSourceAndBlocksProcessing() public {
        MessageLib.Message memory message = _lockOnA(25 ether);
        (bytes32 acceptedHash, BankCheckpointClient.MessageProof memory proof) =
            _finalizeMessageOnB(message, 1, VALIDATOR_SET_1, validatorKeysA, 2, bytes32(0), bytes32(0));

        BankCheckpointClient.Checkpoint memory conflict =
            _checkpoint(CHAIN_A, VALIDATOR_SET_1, 1, bytes32(0), keccak256("conflicting-root"));
        bytes32 conflictHash = checkpointB.hashCheckpoint(conflict);

        vm.prank(anyRelayer);
        checkpointB.submitCheckpoint(conflict, _signatures(validatorKeysA, conflictHash, 2));

        assertTrue(checkpointB.sourceFrozen(CHAIN_A));
        assertTrue(acceptedHash != conflictHash);

        vm.expectRevert(bytes("INVALID_MESSAGE_PROOF"));
        vm.prank(relayer);
        routerB.relayMessage(message, proof);
    }

    function testValidMessageInclusionProofSucceeds() public {
        MessageLib.Message memory message = _lockOnA(30 ether);
        (, BankCheckpointClient.MessageProof memory proof) =
            _finalizeMessageOnB(message, 1, VALIDATOR_SET_1, validatorKeysA, 2, bytes32(0), _rightLeaf("A_ROOT_2"));

        vm.prank(relayer);
        routerB.relayMessage(message, proof);

        assertEq(wrappedA.balanceOf(user), 30 ether);
    }

    function testInvalidMerkleProofFails() public {
        MessageLib.Message memory message = _lockOnA(30 ether);
        (, BankCheckpointClient.MessageProof memory proof) =
            _finalizeMessageOnB(message, 1, VALIDATOR_SET_1, validatorKeysA, 2, bytes32(0), _rightLeaf("A_ROOT_3"));
        proof.siblings[0] = keccak256("not-the-sibling");

        vm.expectRevert(bytes("INVALID_MESSAGE_PROOF"));
        vm.prank(relayer);
        routerB.relayMessage(message, proof);
    }

    function testReplayMessageFails() public {
        MessageLib.Message memory message = _lockOnA(25 ether);
        (, BankCheckpointClient.MessageProof memory proof) =
            _finalizeMessageOnB(message, 1, VALIDATOR_SET_1, validatorKeysA, 2, bytes32(0), bytes32(0));

        vm.prank(relayer);
        routerB.relayMessage(message, proof);

        vm.expectRevert(bytes("MESSAGE_ALREADY_CONSUMED"));
        vm.prank(relayer);
        routerB.relayMessage(message, proof);
    }

    function testWrongRouteFails() public {
        MessageLib.Message memory message = _lockOnA(30 ether);
        message.routeId = keccak256("WRONG_ROUTE");
        (, BankCheckpointClient.MessageProof memory proof) =
            _finalizeMessageOnB(message, 1, VALIDATOR_SET_1, validatorKeysA, 2, bytes32(0), bytes32(0));

        vm.expectRevert(bytes("ROUTE_DISABLED"));
        vm.prank(relayer);
        routerB.relayMessage(message, proof);
    }

    function testWrongSourceEmitterFails() public {
        MessageLib.Message memory message = _lockOnA(30 ether);
        message.sourceEmitter = address(0xBEEF);
        (, BankCheckpointClient.MessageProof memory proof) =
            _finalizeMessageOnB(message, 1, VALIDATOR_SET_1, validatorKeysA, 2, bytes32(0), bytes32(0));

        vm.expectRevert(bytes("SOURCE_EMITTER_MISMATCH"));
        vm.prank(relayer);
        routerB.relayMessage(message, proof);
    }

    function testWrongSourceSenderFails() public {
        MessageLib.Message memory message = _lockOnA(30 ether);
        message.sourceSender = address(0xBEEF);
        (, BankCheckpointClient.MessageProof memory proof) =
            _finalizeMessageOnB(message, 1, VALIDATOR_SET_1, validatorKeysA, 2, bytes32(0), bytes32(0));

        vm.expectRevert(bytes("SOURCE_SENDER_MISMATCH"));
        vm.prank(relayer);
        routerB.relayMessage(message, proof);
    }

    function testPausedRouteFails() public {
        MessageLib.Message memory message = _lockOnA(30 ether);
        (, BankCheckpointClient.MessageProof memory proof) =
            _finalizeMessageOnB(message, 1, VALIDATOR_SET_1, validatorKeysA, 2, bytes32(0), bytes32(0));
        riskB.setRoutePaused(lockRoute, true);

        vm.expectRevert(bytes("ROUTE_PAUSED"));
        vm.prank(relayer);
        routerB.relayMessage(message, proof);
    }

    function testFrozenRouteBlocksProcessing() public {
        MessageLib.Message memory message = _lockOnA(30 ether);
        (, BankCheckpointClient.MessageProof memory proof) =
            _finalizeMessageOnB(message, 1, VALIDATOR_SET_1, validatorKeysA, 2, bytes32(0), bytes32(0));
        riskB.setRouteFrozen(lockRoute, true);

        vm.expectRevert(bytes("ROUTE_FROZEN"));
        vm.prank(relayer);
        routerB.relayMessage(message, proof);
    }

    function testHighValueRequiresApproval() public {
        _setRoute(
            routesB,
            lockRoute,
            ACTION_LOCK_TO_MINT,
            CHAIN_A,
            CHAIN_B,
            address(busA),
            address(vaultA),
            address(collateralA),
            address(wrappedA),
            500 ether,
            1_000 ether,
            1 days,
            50 ether
        );
        MessageLib.Message memory message = _lockOnA(60 ether);
        (, BankCheckpointClient.MessageProof memory proof) =
            _finalizeMessageOnB(message, 1, VALIDATOR_SET_1, validatorKeysA, 2, bytes32(0), bytes32(0));

        vm.expectRevert(bytes("SECONDARY_APPROVAL_REQUIRED"));
        vm.prank(relayer);
        routerB.relayMessage(message, proof);

        riskB.approveHighValue(lockRoute, message.messageId());
        vm.prank(relayer);
        routerB.relayMessage(message, proof);

        assertEq(wrappedA.balanceOf(user), 60 ether);
    }

    function testReverseBurnReleaseUnlockSucceeds() public {
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
        (, BankCheckpointClient.MessageProof memory proof) =
            _finalizeMessageOnA(burnMessage, 1, VALIDATOR_SET_1, validatorKeysB, 2, bytes32(0), _rightLeaf("B_ROOT_1"));

        vm.prank(anyRelayer);
        routerA.relayMessage(burnMessage, proof);

        assertEq(vaultA.lockedBalance(user), 0);
        assertEq(collateralA.balanceOf(user), 1_000 ether);
        assertTrue(inboxA.consumed(burnMessage.messageId()));
    }

    function testAnyRelayerMaySubmitValidCheckpointAndProof() public {
        MessageLib.Message memory message = _lockOnA(45 ether);
        bytes32 leaf = message.leafHash();
        bytes32 rightLeaf = _rightLeaf("ANY_RELAYER_ROOT");
        bytes32 root = _parent(leaf, rightLeaf);
        BankCheckpointClient.Checkpoint memory checkpoint =
            _checkpoint(CHAIN_A, VALIDATOR_SET_1, 1, bytes32(0), root);
        bytes32 checkpointHash = checkpointB.hashCheckpoint(checkpoint);

        vm.prank(anyRelayer);
        checkpointB.submitCheckpoint(checkpoint, _signatures(validatorKeysA, checkpointHash, 2));

        bytes32[] memory siblings = new bytes32[](1);
        siblings[0] = rightLeaf;
        BankCheckpointClient.MessageProof memory proof =
            BankCheckpointClient.MessageProof({checkpointHash: checkpointHash, leafIndex: 0, siblings: siblings});

        vm.prank(anyRelayer);
        routerB.relayMessage(message, proof);

        assertEq(wrappedA.balanceOf(user), 45 ether);
    }

    function _deployRouterStack(uint256 localChainId, MessageBus bus)
        internal
        returns (
            BankCheckpointClient checkpoint,
            MessageInbox inbox,
            RouteRegistry routes,
            RiskManager risk,
            FeeVault fees,
            BridgeRouter router
        )
    {
        checkpoint = new BankCheckpointClient();
        inbox = new MessageInbox();
        routes = new RouteRegistry();
        risk = new RiskManager(address(routes));
        fees = new FeeVault(0);
        router = new BridgeRouter(
            localChainId,
            address(bus),
            address(checkpoint),
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
        (, BankCheckpointClient.MessageProof memory proof) =
            _finalizeMessageOnB(message, 1, VALIDATOR_SET_1, validatorKeysA, 2, bytes32(0), bytes32(0));
        vm.prank(relayer);
        routerB.relayMessage(message, proof);
    }

    function _lockMessage(uint256 amount, uint256 nonce) internal view returns (MessageLib.Message memory) {
        return MessageLib.Message({
            routeId: lockRoute,
            action: ACTION_LOCK_TO_MINT,
            sourceChainId: CHAIN_A,
            destinationChainId: CHAIN_B,
            sourceEmitter: address(busA),
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
            sourceEmitter: address(busB),
            sourceSender: address(routerB),
            recipient: user,
            asset: address(wrappedA),
            amount: amount,
            nonce: nonce,
            payloadHash: bytes32(0)
        });
    }

    function _finalizeMessageOnB(
        MessageLib.Message memory message,
        uint256 sequence,
        uint256 validatorSetId,
        uint256[] storage signerKeys,
        uint256 signerCount,
        bytes32 parentCheckpointHash,
        bytes32 rightLeaf
    ) internal returns (bytes32 checkpointHash, BankCheckpointClient.MessageProof memory proof) {
        return _finalizeMessage(
            checkpointB, CHAIN_A, message, sequence, validatorSetId, signerKeys, signerCount, parentCheckpointHash, rightLeaf
        );
    }

    function _finalizeMessageOnA(
        MessageLib.Message memory message,
        uint256 sequence,
        uint256 validatorSetId,
        uint256[] storage signerKeys,
        uint256 signerCount,
        bytes32 parentCheckpointHash,
        bytes32 rightLeaf
    ) internal returns (bytes32 checkpointHash, BankCheckpointClient.MessageProof memory proof) {
        return _finalizeMessage(
            checkpointA, CHAIN_B, message, sequence, validatorSetId, signerKeys, signerCount, parentCheckpointHash, rightLeaf
        );
    }

    function _finalizeMessage(
        BankCheckpointClient checkpointClient,
        uint256 sourceChainId,
        MessageLib.Message memory message,
        uint256 sequence,
        uint256 validatorSetId,
        uint256[] storage signerKeys,
        uint256 signerCount,
        bytes32 parentCheckpointHash,
        bytes32 rightLeaf
    ) internal returns (bytes32 checkpointHash, BankCheckpointClient.MessageProof memory proof) {
        bytes32 leaf = message.leafHash();
        bytes32 root = rightLeaf == bytes32(0) ? leaf : _parent(leaf, rightLeaf);
        BankCheckpointClient.Checkpoint memory checkpoint =
            _checkpoint(sourceChainId, validatorSetId, sequence, parentCheckpointHash, root);
        checkpointHash = checkpointClient.hashCheckpoint(checkpoint);

        vm.prank(relayer);
        checkpointClient.submitCheckpoint(checkpoint, _signatures(signerKeys, checkpointHash, signerCount));

        bytes32[] memory siblings = new bytes32[](rightLeaf == bytes32(0) ? 0 : 1);
        if (rightLeaf != bytes32(0)) {
            siblings[0] = rightLeaf;
        }
        proof = BankCheckpointClient.MessageProof({checkpointHash: checkpointHash, leafIndex: 0, siblings: siblings});
    }

    function _checkpoint(
        uint256 sourceChainId,
        uint256 validatorSetId,
        uint256 sequence,
        bytes32 parentCheckpointHash,
        bytes32 messageRoot
    ) internal view returns (BankCheckpointClient.Checkpoint memory) {
        return BankCheckpointClient.Checkpoint({
            sourceChainId: sourceChainId,
            validatorSetId: validatorSetId,
            sequence: sequence,
            parentCheckpointHash: parentCheckpointHash,
            messageRoot: messageRoot,
            timestamp: block.timestamp + sequence
        });
    }

    function _installValidatorSet(
        BankCheckpointClient checkpointClient,
        uint256 sourceChainId,
        uint256 validatorSetId,
        uint256[] storage validatorKeys,
        bool active
    ) internal {
        address[] memory validators = new address[](validatorKeys.length);
        uint256[] memory powers = new uint256[](validatorKeys.length);
        for (uint256 i = 0; i < validatorKeys.length; i++) {
            validators[i] = vm.addr(validatorKeys[i]);
            powers[i] = 1;
        }
        checkpointClient.setValidatorSet(sourceChainId, validatorSetId, validators, powers, active);
    }

    function _signatures(uint256[] storage signerKeys, bytes32 digest, uint256 count)
        internal
        returns (bytes[] memory signatures)
    {
        signatures = new bytes[](count);
        for (uint256 i = 0; i < count; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKeys[i], digest);
            signatures[i] = abi.encodePacked(r, s, v);
        }
    }

    function _parent(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(left, right));
    }

    function _rightLeaf(string memory salt) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("right-leaf", salt));
    }
}
