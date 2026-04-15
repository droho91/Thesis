// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BankCheckpointClient} from "../contracts/checkpoint/BankCheckpointClient.sol";
import {BankCheckpointRegistry} from "../contracts/checkpoint/BankCheckpointRegistry.sol";
import {BankValidatorSetRegistry} from "../contracts/checkpoint/BankValidatorSetRegistry.sol";
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
    uint256 internal constant VALIDATOR_EPOCH_1 = 1;
    uint256 internal constant VALIDATOR_EPOCH_2 = 2;

    address internal user = address(0x1111);
    address internal relayer = address(0x2222);
    address internal anyRelayer = address(0x3333);

    uint256[] internal validatorKeysA;
    uint256[] internal validatorKeysB;
    uint256[] internal rotatedValidatorKeysA;

    MessageBus internal busA;
    MessageBus internal busB;
    BankValidatorSetRegistry internal validatorRegistryA;
    BankValidatorSetRegistry internal validatorRegistryB;
    BankCheckpointRegistry internal registryA;
    BankCheckpointRegistry internal registryB;
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

    struct FinalizedMessage {
        bytes32 checkpointHash;
        BankCheckpointClient.MessageProof proof;
        BankCheckpointRegistry.SourceCheckpoint sourceCheckpoint;
    }

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
        validatorRegistryA = new BankValidatorSetRegistry(
            CHAIN_A,
            VALIDATOR_EPOCH_1,
            _validatorAddresses(validatorKeysA),
            _equalPowers(validatorKeysA.length)
        );
        validatorRegistryB = new BankValidatorSetRegistry(
            CHAIN_B,
            VALIDATOR_EPOCH_1,
            _validatorAddresses(validatorKeysB),
            _equalPowers(validatorKeysB.length)
        );
        registryA = new BankCheckpointRegistry(CHAIN_A, address(busA), address(validatorRegistryA));
        registryB = new BankCheckpointRegistry(CHAIN_B, address(busB), address(validatorRegistryB));

        (checkpointA, inboxA, routesA, riskA, feesA, routerA) =
            _deployRouterStack(CHAIN_A, busA, _clientEpoch(validatorRegistryB.validatorEpoch(VALIDATOR_EPOCH_1)));
        (checkpointB, inboxB, routesB, riskB, feesB, routerB) =
            _deployRouterStack(CHAIN_B, busB, _clientEpoch(validatorRegistryA.validatorEpoch(VALIDATOR_EPOCH_1)));

        collateralA = new StableToken("Bank A Collateral", "aCOL");
        stableB = new StableToken("Bank B Stable", "sB");
        wrappedA = new WrappedCollateral("Wrapped Bank A Collateral", "wA", address(routerB));
        vaultA = new CollateralVault(address(collateralA), address(routerA));
        vaultA.configureFeeModules(address(riskA), address(feesA));
        feesA.grantCollector(address(vaultA));

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
        _setRoute(routesA, lockRoute, ACTION_LOCK_TO_MINT, CHAIN_A, CHAIN_B, address(busA), address(vaultA), address(collateralA), address(wrappedA), 500 ether, 1_000 ether, 1 days, 0);
        _setRoute(routesB, lockRoute, ACTION_LOCK_TO_MINT, CHAIN_A, CHAIN_B, address(busA), address(vaultA), address(collateralA), address(wrappedA), 500 ether, 1_000 ether, 1 days, 0);
        _setRoute(routesA, burnRoute, ACTION_BURN_TO_UNLOCK, CHAIN_B, CHAIN_A, address(busB), address(routerB), address(wrappedA), address(vaultA), 500 ether, 1_000 ether, 1 days, 0);
        _setRoute(routesB, burnRoute, ACTION_BURN_TO_UNLOCK, CHAIN_B, CHAIN_A, address(busB), address(routerB), address(wrappedA), address(vaultA), 500 ether, 1_000 ether, 1 days, 0);

        collateralA.mint(user, 1_000 ether);
        vm.prank(user);
        collateralA.approve(address(vaultA), type(uint256).max);
    }

    function testSourceCheckpointMustBeCommittedCanonicallyBeforeRelay() public {
        (MessageLib.Message memory message, uint256 messageSequence) = _lockOnA(100 ether);
        BankCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint = registryA.commitCheckpoint(messageSequence);

        assertTrue(registryA.canonicalCheckpointHash(sourceCheckpoint.checkpointHash));
        assertEq(registryA.messageRootBySequence(sourceCheckpoint.sequence), sourceCheckpoint.messageRoot);
        assertEq(sourceCheckpoint.sourceCheckpointRegistry, address(registryA));
        assertEq(sourceCheckpoint.sourceMessageBus, address(busA));
        assertEq(sourceCheckpoint.messageAccumulator, busA.messageAccumulatorAt(messageSequence));

        BankCheckpointClient.Checkpoint memory checkpoint = _clientCheckpoint(sourceCheckpoint);
        checkpoint.sourceBlockNumber += 1;
        bytes32 tamperedHash = checkpointB.hashCheckpoint(checkpoint);

        vm.expectRevert(bytes("SOURCE_COMMITMENT_MISMATCH"));
        vm.prank(relayer);
        checkpointB.submitCheckpoint(checkpoint, _signatures(validatorKeysA, tamperedHash, 2));

        checkpoint = _clientCheckpoint(sourceCheckpoint);
        bytes32 checkpointHash = checkpointB.hashCheckpoint(checkpoint);
        vm.prank(relayer);
        checkpointB.submitCheckpoint(checkpoint, _signatures(validatorKeysA, checkpointHash, 2));

        BankCheckpointClient.MessageProof memory proof = _proofFor(busA, sourceCheckpoint, messageSequence, checkpointHash);
        vm.prank(anyRelayer);
        routerB.relayMessage(message, proof);
        assertEq(wrappedA.balanceOf(user), 100 ether);
    }

    function testRelayerOnlyCheckpointWithoutSourceCommitmentCannotAdvance() public {
        (, uint256 messageSequence) = _lockOnA(12 ether);
        BankValidatorSetRegistry.ValidatorEpoch memory sourceEpoch =
            validatorRegistryA.validatorEpoch(VALIDATOR_EPOCH_1);
        BankCheckpointClient.Checkpoint memory checkpoint = BankCheckpointClient.Checkpoint({
            sourceChainId: CHAIN_A,
            sourceCheckpointRegistry: address(registryA),
            sourceMessageBus: address(busA),
            sourceValidatorSetRegistry: address(validatorRegistryA),
            validatorEpochId: sourceEpoch.epochId,
            validatorEpochHash: sourceEpoch.epochHash,
            sequence: 1,
            parentCheckpointHash: bytes32(0),
            messageRoot: busA.messageLeafAt(messageSequence),
            firstMessageSequence: messageSequence,
            lastMessageSequence: messageSequence,
            messageCount: 1,
            messageAccumulator: busA.messageAccumulatorAt(messageSequence),
            sourceBlockNumber: block.number,
            sourceBlockHash: keccak256("relayer-only-anchor"),
            timestamp: block.timestamp,
            sourceCommitmentHash: bytes32(0)
        });

        vm.expectRevert(bytes("SOURCE_COMMITMENT_ZERO"));
        vm.prank(relayer);
        checkpointB.submitCheckpoint(checkpoint, new bytes[](0));
    }

    function testSourceProgressionAnchorIsValidated() public {
        (, uint256 messageSequence) = _lockOnA(12 ether);
        BankCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint = registryA.commitCheckpoint(messageSequence);
        BankCheckpointClient.Checkpoint memory checkpoint = _clientCheckpoint(sourceCheckpoint);
        checkpoint.sourceBlockHash = bytes32(0);
        checkpoint.sourceCommitmentHash = checkpointB.hashSourceCommitment(checkpoint);
        bytes32 checkpointHash = checkpointB.hashCheckpoint(checkpoint);

        vm.expectRevert(bytes("SOURCE_BLOCK_HASH_ZERO"));
        vm.prank(relayer);
        checkpointB.submitCheckpoint(checkpoint, _signatures(validatorKeysA, checkpointHash, 2));
    }

    function testValidCheckpointWithTwoThirdsSignaturesSucceeds() public {
        (MessageLib.Message memory message, uint256 messageSequence) = _lockOnA(100 ether);
        FinalizedMessage memory finalized = _finalizeAtoB(messageSequence, validatorKeysA, 2);

        assertTrue(checkpointB.isCheckpointVerified(CHAIN_A, finalized.checkpointHash));
        vm.prank(relayer);
        routerB.relayMessage(message, finalized.proof);

        assertEq(wrappedA.balanceOf(user), 100 ether);
        assertTrue(inboxB.consumed(message.messageId()));
    }

    function testInsufficientQuorumFails() public {
        (, uint256 messageSequence) = _lockOnA(20 ether);
        BankCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint = registryA.commitCheckpoint(messageSequence);
        BankCheckpointClient.Checkpoint memory checkpoint = _clientCheckpoint(sourceCheckpoint);
        bytes32 checkpointHash = checkpointB.hashCheckpoint(checkpoint);

        vm.expectRevert(bytes("INSUFFICIENT_QUORUM"));
        vm.prank(relayer);
        checkpointB.submitCheckpoint(checkpoint, _signatures(validatorKeysA, checkpointHash, 1));
    }

    function testRemoteValidatorEpochCannotAdvanceByPlainAdminSync() public {
        bytes memory callData = abi.encodeWithSignature(
            "setValidatorSet(uint256,uint256,address[],uint256[],bool)",
            CHAIN_A,
            VALIDATOR_EPOCH_2,
            _validatorAddresses(rotatedValidatorKeysA),
            _equalPowers(rotatedValidatorKeysA.length),
            true
        );

        (bool ok,) = address(checkpointB).call(callData);
        assertFalse(ok);
        assertEq(checkpointB.activeValidatorEpochId(CHAIN_A), VALIDATOR_EPOCH_1);
    }

    function testWrongValidatorEpochIdFails() public {
        (, uint256 messageSequence) = _lockOnA(20 ether);
        BankCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint = registryA.commitCheckpoint(messageSequence);
        BankCheckpointClient.Checkpoint memory checkpoint = _clientCheckpoint(sourceCheckpoint);
        checkpoint.validatorEpochId = VALIDATOR_EPOCH_2;
        checkpoint.validatorEpochHash = keccak256("unknown-epoch");
        checkpoint.sourceCommitmentHash = checkpointB.hashSourceCommitment(checkpoint);
        bytes32 checkpointHash = checkpointB.hashCheckpoint(checkpoint);

        vm.expectRevert(bytes("VALIDATOR_EPOCH_INACTIVE"));
        vm.prank(relayer);
        checkpointB.submitCheckpoint(checkpoint, _signatures(validatorKeysA, checkpointHash, 2));
    }

    function testValidatorRotationRequiresSourceCertifiedBankEpoch() public {
        validatorRegistryA.commitValidatorEpoch(
            VALIDATOR_EPOCH_2,
            _validatorAddresses(rotatedValidatorKeysA),
            _equalPowers(rotatedValidatorKeysA.length)
        );
        BankCheckpointClient.ValidatorEpoch memory rotatedEpoch =
            _clientEpoch(validatorRegistryA.validatorEpoch(VALIDATOR_EPOCH_2));

        (, uint256 messageSequence) = _lockOnA(20 ether);
        BankCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint = registryA.commitCheckpoint(messageSequence);
        BankCheckpointClient.Checkpoint memory checkpoint = _clientCheckpoint(sourceCheckpoint);
        bytes32 checkpointHash = checkpointB.hashCheckpoint(checkpoint);

        assertEq(checkpoint.validatorEpochId, VALIDATOR_EPOCH_2);
        vm.expectRevert(bytes("VALIDATOR_EPOCH_INACTIVE"));
        vm.prank(relayer);
        checkpointB.submitCheckpoint(checkpoint, _signatures(rotatedValidatorKeysA, checkpointHash, 2));

        vm.prank(anyRelayer);
        checkpointB.submitValidatorEpoch(rotatedEpoch, _signatures(validatorKeysA, rotatedEpoch.epochHash, 2));

        vm.prank(anyRelayer);
        checkpointB.submitCheckpoint(checkpoint, _signatures(rotatedValidatorKeysA, checkpointHash, 2));
        assertTrue(checkpointB.isCheckpointVerified(CHAIN_A, checkpointHash));
    }

    function testDestinationRejectsStaleValidatorEpochAfterCertifiedRotation() public {
        validatorRegistryA.commitValidatorEpoch(
            VALIDATOR_EPOCH_2,
            _validatorAddresses(rotatedValidatorKeysA),
            _equalPowers(rotatedValidatorKeysA.length)
        );
        BankCheckpointClient.ValidatorEpoch memory rotatedEpoch =
            _clientEpoch(validatorRegistryA.validatorEpoch(VALIDATOR_EPOCH_2));
        vm.prank(anyRelayer);
        checkpointB.submitValidatorEpoch(rotatedEpoch, _signatures(validatorKeysA, rotatedEpoch.epochHash, 2));

        (, uint256 messageSequence) = _lockOnA(20 ether);
        BankCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint = registryA.commitCheckpoint(messageSequence);
        BankCheckpointClient.Checkpoint memory checkpoint = _clientCheckpoint(sourceCheckpoint);
        checkpoint.validatorEpochId = VALIDATOR_EPOCH_1;
        checkpoint.validatorEpochHash = validatorRegistryA.validatorEpoch(VALIDATOR_EPOCH_1).epochHash;
        checkpoint.sourceCommitmentHash = checkpointB.hashSourceCommitment(checkpoint);
        bytes32 checkpointHash = checkpointB.hashCheckpoint(checkpoint);

        vm.expectRevert(bytes("VALIDATOR_EPOCH_INACTIVE"));
        vm.prank(relayer);
        checkpointB.submitCheckpoint(checkpoint, _signatures(validatorKeysA, checkpointHash, 2));
    }

    function testWrongParentCheckpointFails() public {
        (, uint256 firstSequence) = _lockOnA(10 ether);
        FinalizedMessage memory first = _finalizeAtoB(firstSequence, validatorKeysA, 2);

        (, uint256 secondSequence) = _lockOnA(11 ether);
        BankCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint = registryA.commitCheckpoint(secondSequence);
        BankCheckpointClient.Checkpoint memory checkpoint = _clientCheckpoint(sourceCheckpoint);
        checkpoint.parentCheckpointHash = keccak256("wrong-parent");
        checkpoint.sourceCommitmentHash = checkpointB.hashSourceCommitment(checkpoint);
        bytes32 checkpointHash = checkpointB.hashCheckpoint(checkpoint);

        assertTrue(first.checkpointHash != checkpoint.parentCheckpointHash);
        vm.expectRevert(bytes("WRONG_PARENT_CHECKPOINT"));
        vm.prank(relayer);
        checkpointB.submitCheckpoint(checkpoint, _signatures(validatorKeysA, checkpointHash, 2));
    }

    function testWrongSequenceFails() public {
        (, uint256 messageSequence) = _lockOnA(10 ether);
        BankCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint = registryA.commitCheckpoint(messageSequence);
        BankCheckpointClient.Checkpoint memory checkpoint = _clientCheckpoint(sourceCheckpoint);
        checkpoint.sequence = 2;
        checkpoint.sourceCommitmentHash = checkpointB.hashSourceCommitment(checkpoint);
        bytes32 checkpointHash = checkpointB.hashCheckpoint(checkpoint);

        vm.expectRevert(bytes("WRONG_SEQUENCE"));
        vm.prank(relayer);
        checkpointB.submitCheckpoint(checkpoint, _signatures(validatorKeysA, checkpointHash, 2));
    }

    function testDuplicateCheckpointFailsWithoutFreezing() public {
        (, uint256 messageSequence) = _lockOnA(10 ether);
        BankCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint = registryA.commitCheckpoint(messageSequence);
        BankCheckpointClient.Checkpoint memory checkpoint = _clientCheckpoint(sourceCheckpoint);
        bytes32 checkpointHash = checkpointB.hashCheckpoint(checkpoint);

        vm.prank(relayer);
        checkpointB.submitCheckpoint(checkpoint, _signatures(validatorKeysA, checkpointHash, 2));

        vm.expectRevert(bytes("CHECKPOINT_EXISTS"));
        vm.prank(anyRelayer);
        checkpointB.submitCheckpoint(checkpoint, _signatures(validatorKeysA, checkpointHash, 2));
        assertFalse(checkpointB.sourceFrozen(CHAIN_A));
    }

    function testConflictingCheckpointFreezesSourceAndBlocksProcessing() public {
        (MessageLib.Message memory message, uint256 messageSequence) = _lockOnA(25 ether);
        FinalizedMessage memory finalized = _finalizeAtoB(messageSequence, validatorKeysA, 2);

        BankCheckpointClient.Checkpoint memory conflict = _clientCheckpoint(finalized.sourceCheckpoint);
        conflict.messageRoot = keccak256("conflicting-root");
        conflict.sourceCommitmentHash = checkpointB.hashSourceCommitment(conflict);
        bytes32 conflictHash = checkpointB.hashCheckpoint(conflict);

        vm.prank(anyRelayer);
        checkpointB.submitCheckpoint(conflict, _signatures(validatorKeysA, conflictHash, 2));

        assertTrue(checkpointB.sourceFrozen(CHAIN_A));
        assertEq(checkpointB.conflictingCheckpointHashBySequence(CHAIN_A, 1), conflictHash);
        vm.expectRevert(bytes("SOURCE_FROZEN"));
        vm.prank(relayer);
        routerB.relayMessage(message, finalized.proof);

        validatorRegistryA.commitValidatorEpoch(
            VALIDATOR_EPOCH_2,
            _validatorAddresses(rotatedValidatorKeysA),
            _equalPowers(rotatedValidatorKeysA.length)
        );
        BankCheckpointClient.ValidatorEpoch memory recoveryEpoch =
            _clientEpoch(validatorRegistryA.validatorEpoch(VALIDATOR_EPOCH_2));
        checkpointB.beginRecovery(CHAIN_A);
        assertTrue(checkpointB.sourceFrozen(CHAIN_A));
        vm.prank(anyRelayer);
        checkpointB.submitValidatorEpoch(recoveryEpoch, _signatures(validatorKeysA, recoveryEpoch.epochHash, 2));
        assertFalse(checkpointB.sourceFrozen(CHAIN_A));
    }

    function testMultiMessageCheckpointProofSucceeds() public {
        _lockOnA(15 ether);
        (MessageLib.Message memory second, uint256 secondSequence) = _lockOnA(17 ether);
        FinalizedMessage memory finalized = _finalizeAtoB(secondSequence, validatorKeysA, 2);

        assertEq(finalized.sourceCheckpoint.messageCount, 2);
        vm.prank(anyRelayer);
        routerB.relayMessage(second, finalized.proof);

        assertEq(wrappedA.balanceOf(user), 17 ether);
        assertTrue(inboxB.consumed(second.messageId()));
    }

    function testInvalidMerkleProofFailsBeforeRoutePolicy() public {
        (MessageLib.Message memory message, uint256 messageSequence) = _lockOnA(30 ether);
        FinalizedMessage memory finalized = _finalizeAtoB(messageSequence, validatorKeysA, 2);
        riskB.setRoutePaused(lockRoute, true);
        finalized.proof.leafIndex = 1;

        vm.expectRevert(bytes("INVALID_MESSAGE_PROOF"));
        vm.prank(relayer);
        routerB.relayMessage(message, finalized.proof);
    }

    function testReplayMessageFails() public {
        (MessageLib.Message memory message, uint256 messageSequence) = _lockOnA(25 ether);
        FinalizedMessage memory finalized = _finalizeAtoB(messageSequence, validatorKeysA, 2);

        vm.prank(relayer);
        routerB.relayMessage(message, finalized.proof);

        vm.expectRevert(bytes("MESSAGE_ALREADY_CONSUMED"));
        vm.prank(relayer);
        routerB.relayMessage(message, finalized.proof);
    }

    function testWrongRouteFailsAfterValidCheckpointProof() public {
        bytes32 wrongRoute = keccak256("WRONG_ROUTE");
        (MessageLib.Message memory message, uint256 sequence) = _lockForRouteOnA(wrongRoute, 30 ether);
        FinalizedMessage memory finalized = _finalizeAtoB(sequence, validatorKeysA, 2);

        vm.expectRevert(bytes("ROUTE_DISABLED"));
        vm.prank(relayer);
        routerB.relayMessage(message, finalized.proof);
    }

    function testWrongSourceEmitterFailsAfterProofVerification() public {
        (MessageLib.Message memory message, uint256 messageSequence) = _lockOnA(30 ether);
        FinalizedMessage memory finalized = _finalizeAtoB(messageSequence, validatorKeysA, 2);
        _setRoute(routesB, lockRoute, ACTION_LOCK_TO_MINT, CHAIN_A, CHAIN_B, address(0xBEEF), address(vaultA), address(collateralA), address(wrappedA), 500 ether, 1_000 ether, 1 days, 0);

        vm.expectRevert(bytes("SOURCE_EMITTER_MISMATCH"));
        vm.prank(relayer);
        routerB.relayMessage(message, finalized.proof);
    }

    function testWrongSourceSenderFailsAfterProofVerification() public {
        (MessageLib.Message memory message, uint256 messageSequence) = _lockOnA(30 ether);
        FinalizedMessage memory finalized = _finalizeAtoB(messageSequence, validatorKeysA, 2);
        _setRoute(routesB, lockRoute, ACTION_LOCK_TO_MINT, CHAIN_A, CHAIN_B, address(busA), address(0xBEEF), address(collateralA), address(wrappedA), 500 ether, 1_000 ether, 1 days, 0);

        vm.expectRevert(bytes("SOURCE_SENDER_MISMATCH"));
        vm.prank(relayer);
        routerB.relayMessage(message, finalized.proof);
    }

    function testPausedAndFrozenRouteFailAfterProofVerification() public {
        (MessageLib.Message memory pausedMessage, uint256 pausedSequence) = _lockOnA(30 ether);
        FinalizedMessage memory paused = _finalizeAtoB(pausedSequence, validatorKeysA, 2);
        riskB.setRoutePaused(lockRoute, true);

        vm.expectRevert(bytes("ROUTE_PAUSED"));
        vm.prank(relayer);
        routerB.relayMessage(pausedMessage, paused.proof);

        riskB.setRoutePaused(lockRoute, false);
        (MessageLib.Message memory frozenMessage, uint256 frozenSequence) = _lockOnA(31 ether);
        FinalizedMessage memory frozen = _finalizeAtoB(frozenSequence, validatorKeysA, 2);
        riskB.setRouteFrozen(lockRoute, true);

        vm.expectRevert(bytes("ROUTE_FROZEN"));
        vm.prank(relayer);
        routerB.relayMessage(frozenMessage, frozen.proof);
    }

    function testHighValueRequiresApproval() public {
        _setRoute(routesB, lockRoute, ACTION_LOCK_TO_MINT, CHAIN_A, CHAIN_B, address(busA), address(vaultA), address(collateralA), address(wrappedA), 500 ether, 1_000 ether, 1 days, 50 ether);
        (MessageLib.Message memory message, uint256 messageSequence) = _lockOnA(60 ether);
        FinalizedMessage memory finalized = _finalizeAtoB(messageSequence, validatorKeysA, 2);

        vm.expectRevert(bytes("SECONDARY_APPROVAL_REQUIRED"));
        vm.prank(relayer);
        routerB.relayMessage(message, finalized.proof);

        riskB.approveHighValue(lockRoute, message.messageId());
        vm.prank(relayer);
        routerB.relayMessage(message, finalized.proof);
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
        uint256 burnSequence = busB.messageSequence();
        FinalizedMessage memory finalized = _finalizeBtoA(burnSequence, validatorKeysB, 2);

        vm.prank(anyRelayer);
        routerA.relayMessage(burnMessage, finalized.proof);

        assertEq(vaultA.lockedBalance(user), 0);
        assertEq(collateralA.balanceOf(user), 1_000 ether);
        assertTrue(inboxA.consumed(burnMessage.messageId()));
    }

    function testFeeHandlingPaysRelayerFromRouteVault() public {
        uint256 relayFee = 0.02 ether;
        _setRouteWithFee(routesA, lockRoute, ACTION_LOCK_TO_MINT, CHAIN_A, CHAIN_B, address(busA), address(vaultA), address(collateralA), address(wrappedA), 500 ether, 1_000 ether, 1 days, 0, relayFee, 0);
        _setRouteWithFee(routesB, lockRoute, ACTION_LOCK_TO_MINT, CHAIN_A, CHAIN_B, address(busA), address(vaultA), address(collateralA), address(wrappedA), 500 ether, 1_000 ether, 1 days, 0, relayFee, 0);
        feesB.setRelayerRewardBps(10_000);
        feesB.fundRoute{value: relayFee}(lockRoute);
        vm.deal(user, 1 ether);

        vm.prank(user);
        vaultA.lock{value: relayFee}(40 ether);
        MessageLib.Message memory message = _lockMessage(40 ether, busA.nonces(address(vaultA)), relayFee);
        uint256 messageSequence = busA.messageSequence();
        FinalizedMessage memory finalized = _finalizeAtoB(messageSequence, validatorKeysA, 2);

        uint256 beforeBalance = relayer.balance;
        vm.prank(relayer);
        routerB.relayMessage(message, finalized.proof);

        assertEq(feesA.routeBalance(lockRoute), relayFee);
        assertEq(relayer.balance, beforeBalance + relayFee);
        assertEq(feesB.routeBalance(lockRoute), 0);
    }

    function testAnyRelayerMaySubmitValidCheckpointAndProof() public {
        (MessageLib.Message memory message, uint256 messageSequence) = _lockOnA(45 ether);
        BankCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint = registryA.commitCheckpoint(messageSequence);
        BankCheckpointClient.Checkpoint memory checkpoint = _clientCheckpoint(sourceCheckpoint);
        bytes32 checkpointHash = checkpointB.hashCheckpoint(checkpoint);

        vm.prank(anyRelayer);
        checkpointB.submitCheckpoint(checkpoint, _signatures(validatorKeysA, checkpointHash, 2));

        BankCheckpointClient.MessageProof memory proof = _proofFor(busA, sourceCheckpoint, messageSequence, checkpointHash);
        vm.prank(anyRelayer);
        routerB.relayMessage(message, proof);

        assertEq(wrappedA.balanceOf(user), 45 ether);
    }

    function _deployRouterStack(
        uint256 localChainId,
        MessageBus bus,
        BankCheckpointClient.ValidatorEpoch memory initialRemoteEpoch
    )
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
        checkpoint = new BankCheckpointClient(initialRemoteEpoch);
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
        _setRouteWithFee(
            registry,
            routeId,
            action,
            sourceChainId,
            destinationChainId,
            sourceEmitter,
            sourceSender,
            sourceAsset,
            target,
            transferCap,
            rateLimitAmount,
            rateLimitWindow,
            highValueThreshold,
            0,
            0
        );
    }

    function _setRouteWithFee(
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
        uint256 highValueThreshold,
        uint256 flatFee,
        uint16 feeBps
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
                flatFee: flatFee,
                feeBps: feeBps,
                transferCap: transferCap,
                rateLimitAmount: rateLimitAmount,
                rateLimitWindow: rateLimitWindow,
                highValueThreshold: highValueThreshold
            })
        );
    }

    function _lockOnA(uint256 amount) internal returns (MessageLib.Message memory message, uint256 messageSequence) {
        vm.prank(user);
        vaultA.lock(amount);
        messageSequence = busA.messageSequence();
        return (_lockMessage(amount, busA.nonces(address(vaultA)), 0), messageSequence);
    }

    function _lockForRouteOnA(bytes32 routeId, uint256 amount)
        internal
        returns (MessageLib.Message memory message, uint256 messageSequence)
    {
        vm.prank(user);
        vaultA.lockForRoute(routeId, CHAIN_B, user, amount);
        messageSequence = busA.messageSequence();
        message = MessageLib.Message({
            routeId: routeId,
            action: ACTION_LOCK_TO_MINT,
            sourceChainId: CHAIN_A,
            destinationChainId: CHAIN_B,
            sourceEmitter: address(busA),
            sourceSender: address(vaultA),
            owner: user,
            recipient: user,
            asset: address(collateralA),
            amount: amount,
            nonce: busA.nonces(address(vaultA)),
            prepaidFee: 0,
            payloadHash: bytes32(0)
        });
    }

    function _mintFromA(uint256 amount) internal returns (MessageLib.Message memory message) {
        uint256 messageSequence;
        (message, messageSequence) = _lockOnA(amount);
        FinalizedMessage memory finalized = _finalizeAtoB(messageSequence, validatorKeysA, 2);
        vm.prank(relayer);
        routerB.relayMessage(message, finalized.proof);
    }

    function _lockMessage(uint256 amount, uint256 nonce, uint256 prepaidFee)
        internal
        view
        returns (MessageLib.Message memory)
    {
        return MessageLib.Message({
            routeId: lockRoute,
            action: ACTION_LOCK_TO_MINT,
            sourceChainId: CHAIN_A,
            destinationChainId: CHAIN_B,
            sourceEmitter: address(busA),
            sourceSender: address(vaultA),
            owner: user,
            recipient: user,
            asset: address(collateralA),
            amount: amount,
            nonce: nonce,
            prepaidFee: prepaidFee,
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
            owner: user,
            recipient: user,
            asset: address(wrappedA),
            amount: amount,
            nonce: nonce,
            prepaidFee: 0,
            payloadHash: bytes32(0)
        });
    }

    function _finalizeAtoB(uint256 messageSequence, uint256[] storage signerKeys, uint256 signerCount)
        internal
        returns (FinalizedMessage memory finalized)
    {
        return _finalize(registryA, busA, checkpointB, CHAIN_A, messageSequence, signerKeys, signerCount);
    }

    function _finalizeBtoA(uint256 messageSequence, uint256[] storage signerKeys, uint256 signerCount)
        internal
        returns (FinalizedMessage memory finalized)
    {
        return _finalize(registryB, busB, checkpointA, CHAIN_B, messageSequence, signerKeys, signerCount);
    }

    function _finalize(
        BankCheckpointRegistry registry,
        MessageBus bus,
        BankCheckpointClient checkpointClient,
        uint256 sourceChainId,
        uint256 messageSequence,
        uint256[] storage signerKeys,
        uint256 signerCount
    ) internal returns (FinalizedMessage memory finalized) {
        BankCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint = registry.commitCheckpoint(bus.messageSequence());
        BankCheckpointClient.Checkpoint memory checkpoint = _clientCheckpoint(sourceCheckpoint);
        bytes32 checkpointHash = checkpointClient.hashCheckpoint(checkpoint);

        vm.prank(relayer);
        checkpointClient.submitCheckpoint(checkpoint, _signatures(signerKeys, checkpointHash, signerCount));

        finalized = FinalizedMessage({
            checkpointHash: checkpointHash,
            proof: _proofFor(bus, sourceCheckpoint, messageSequence, checkpointHash),
            sourceCheckpoint: sourceCheckpoint
        });
        assertEq(sourceCheckpoint.sourceChainId, sourceChainId);
    }

    function _proofFor(
        MessageBus bus,
        BankCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint,
        uint256 messageSequence,
        bytes32 checkpointHash
    ) internal view returns (BankCheckpointClient.MessageProof memory proof) {
        require(messageSequence >= sourceCheckpoint.firstMessageSequence, "MESSAGE_BEFORE_CHECKPOINT");
        require(messageSequence <= sourceCheckpoint.lastMessageSequence, "MESSAGE_AFTER_CHECKPOINT");
        uint256 leafIndex = messageSequence - sourceCheckpoint.firstMessageSequence;
        bytes32[] memory leaves = _leavesFor(bus, sourceCheckpoint);
        bytes32[] memory siblings = _buildMerkleProof(leaves, leafIndex);
        return BankCheckpointClient.MessageProof({checkpointHash: checkpointHash, leafIndex: leafIndex, siblings: siblings});
    }

    function _leavesFor(MessageBus bus, BankCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint)
        internal
        view
        returns (bytes32[] memory leaves)
    {
        leaves = new bytes32[](sourceCheckpoint.messageCount);
        for (uint256 i = 0; i < sourceCheckpoint.messageCount; i++) {
            leaves[i] = bus.messageLeafAt(sourceCheckpoint.firstMessageSequence + i);
        }
    }

    function _buildMerkleProof(bytes32[] memory leaves, uint256 leafIndex)
        internal
        pure
        returns (bytes32[] memory siblings)
    {
        require(leafIndex < leaves.length, "LEAF_INDEX_OOB");
        uint256 proofLength;
        uint256 levelLength = leaves.length;
        while (levelLength > 1) {
            proofLength++;
            levelLength = (levelLength + 1) / 2;
        }

        siblings = new bytes32[](proofLength);
        bytes32[] memory level = leaves;
        uint256 index = leafIndex;
        uint256 siblingCount;
        while (level.length > 1) {
            uint256 siblingIndex = index % 2 == 0 ? index + 1 : index - 1;
            siblings[siblingCount] = siblingIndex < level.length ? level[siblingIndex] : level[index];
            siblingCount++;

            uint256 nextLength = (level.length + 1) / 2;
            bytes32[] memory next = new bytes32[](nextLength);
            for (uint256 i = 0; i < nextLength; i++) {
                uint256 leftIndex = i * 2;
                bytes32 left = level[leftIndex];
                bytes32 right = leftIndex + 1 < level.length ? level[leftIndex + 1] : left;
                next[i] = keccak256(abi.encodePacked(left, right));
            }
            index = index / 2;
            level = next;
        }
    }

    function _clientCheckpoint(BankCheckpointRegistry.SourceCheckpoint memory sourceCheckpoint)
        internal
        pure
        returns (BankCheckpointClient.Checkpoint memory)
    {
        return BankCheckpointClient.Checkpoint({
            sourceChainId: sourceCheckpoint.sourceChainId,
            sourceCheckpointRegistry: sourceCheckpoint.sourceCheckpointRegistry,
            sourceMessageBus: sourceCheckpoint.sourceMessageBus,
            sourceValidatorSetRegistry: sourceCheckpoint.sourceValidatorSetRegistry,
            validatorEpochId: sourceCheckpoint.validatorEpochId,
            validatorEpochHash: sourceCheckpoint.validatorEpochHash,
            sequence: sourceCheckpoint.sequence,
            parentCheckpointHash: sourceCheckpoint.parentCheckpointHash,
            messageRoot: sourceCheckpoint.messageRoot,
            firstMessageSequence: sourceCheckpoint.firstMessageSequence,
            lastMessageSequence: sourceCheckpoint.lastMessageSequence,
            messageCount: sourceCheckpoint.messageCount,
            messageAccumulator: sourceCheckpoint.messageAccumulator,
            sourceBlockNumber: sourceCheckpoint.sourceBlockNumber,
            sourceBlockHash: sourceCheckpoint.sourceBlockHash,
            timestamp: sourceCheckpoint.timestamp,
            sourceCommitmentHash: sourceCheckpoint.sourceCommitmentHash
        });
    }

    function _clientEpoch(BankValidatorSetRegistry.ValidatorEpoch memory sourceEpoch)
        internal
        pure
        returns (BankCheckpointClient.ValidatorEpoch memory)
    {
        return BankCheckpointClient.ValidatorEpoch({
            sourceChainId: sourceEpoch.sourceChainId,
            sourceValidatorSetRegistry: sourceEpoch.sourceValidatorSetRegistry,
            epochId: sourceEpoch.epochId,
            parentEpochHash: sourceEpoch.parentEpochHash,
            validators: sourceEpoch.validators,
            votingPowers: sourceEpoch.votingPowers,
            totalVotingPower: sourceEpoch.totalVotingPower,
            quorumNumerator: sourceEpoch.quorumNumerator,
            quorumDenominator: sourceEpoch.quorumDenominator,
            activationBlockNumber: sourceEpoch.activationBlockNumber,
            activationBlockHash: sourceEpoch.activationBlockHash,
            timestamp: sourceEpoch.timestamp,
            epochHash: sourceEpoch.epochHash,
            active: sourceEpoch.active
        });
    }

    function _validatorAddresses(uint256[] storage validatorKeys) internal view returns (address[] memory validators) {
        validators = new address[](validatorKeys.length);
        for (uint256 i = 0; i < validatorKeys.length; i++) {
            validators[i] = vm.addr(validatorKeys[i]);
        }
    }

    function _equalPowers(uint256 count) internal pure returns (uint256[] memory powers) {
        powers = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            powers[i] = 1;
        }
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
}
