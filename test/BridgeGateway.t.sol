// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BridgeGateway} from "../contracts/BridgeGateway.sol";

contract MockBridgeTarget {
    address public lastUser;
    uint256 public lastAmount;
    bytes32 public lastEventId;
    uint256 public mintCount;
    uint256 public unlockCount;
    uint256 public burnCount;

    function mintFromLockEvent(address user, uint256 amount, bytes32 lockEventId) external {
        lastUser = user;
        lastAmount = amount;
        lastEventId = lockEventId;
        mintCount++;
    }

    function unlockFromBurnEvent(address user, uint256 amount, bytes32 burnEventId) external {
        lastUser = user;
        lastAmount = amount;
        lastEventId = burnEventId;
        unlockCount++;
    }

    function burn(address from, uint256 amount) external {
        lastUser = from;
        lastAmount = amount;
        burnCount++;
    }
}

contract MockRevertingBridgeTarget {
    function mintFromLockEvent(address, uint256, bytes32) external pure {
        revert("MINT_FAILED");
    }

    function burn(address, uint256) external pure {
        revert("BURN_FAILED");
    }
}

contract BridgeGatewayTest is Test {
    BridgeGateway internal gateway;
    MockBridgeTarget internal target;

    address internal validator1 = address(0x1111);
    address internal validator2 = address(0x2222);
    address internal validator3 = address(0x3333);
    address internal user = address(0x4444);
    address internal sourceEmitter = address(0xABCD);
    address[] internal validators;

    function setUp() public {
        target = new MockBridgeTarget();
        validators.push(validator1);
        validators.push(validator2);
        validators.push(validator3);

        gateway = _deployGateway(
            31337,
            31338,
            1,
            bytes4(keccak256("mintFromLockEvent(address,uint256,bytes32)")),
            bytes4(keccak256("burn(address,uint256)")),
            0
        );
        gateway.initializeTarget(address(target));
        gateway.initializeSourceEmitter(sourceEmitter);
    }

    function _deployGateway(
        uint256 sourceChainId,
        uint256 destinationChainId,
        uint8 action,
        bytes4 targetSelector,
        bytes4 burnSelector,
        uint256 txCap
    ) internal returns (BridgeGateway) {
        return new BridgeGateway(sourceChainId, destinationChainId, action, validators, 2, targetSelector, burnSelector, txCap);
    }

    function testThresholdAttestThenExecute() public {
        bytes32 txHash = keccak256("SRC_TX_1");
        uint256 logIndex = 3;
        uint256 amount = 100 ether;

        vm.prank(validator1);
        gateway.attest(txHash, logIndex, user, amount);

        vm.expectRevert(bytes("INSUFFICIENT_ATTESTATIONS"));
        gateway.execute(txHash, logIndex, user, amount);

        vm.prank(validator2);
        gateway.attest(txHash, logIndex, user, amount);

        bytes32 messageId = gateway.computeMessageId(txHash, logIndex, user, amount);
        gateway.execute(txHash, logIndex, user, amount);

        assertTrue(gateway.executed(messageId));
        assertEq(gateway.attestCount(messageId), 2);
        assertEq(target.lastUser(), user);
        assertEq(target.lastAmount(), amount);
        assertEq(target.lastEventId(), messageId);
        assertEq(target.mintCount(), 1);
    }

    function testValidatorCannotAttestTwice() public {
        bytes32 txHash = keccak256("SRC_TX_2");
        uint256 logIndex = 1;
        uint256 amount = 10 ether;

        vm.prank(validator1);
        gateway.attest(txHash, logIndex, user, amount);

        vm.expectRevert(bytes("ALREADY_ATTESTED"));
        vm.prank(validator1);
        gateway.attest(txHash, logIndex, user, amount);
    }

    function testOnlyValidatorCanAttest() public {
        vm.expectRevert(bytes("ONLY_VALIDATOR"));
        vm.prank(user);
        gateway.attest(keccak256("SRC_TX_3"), 0, user, 1 ether);
    }

    function testRequestBurnCallsTargetBurn() public {
        vm.prank(user);
        gateway.requestBurn(5 ether);

        assertEq(target.lastUser(), user);
        assertEq(target.lastAmount(), 5 ether);
        assertEq(target.burnCount(), 1);
    }

    function testPauseBlocksAttestExecuteAndBurn() public {
        gateway.setPaused(true);

        vm.expectRevert(bytes("PAUSED"));
        vm.prank(validator1);
        gateway.attest(keccak256("SRC_TX_PAUSE"), 0, user, 1 ether);

        vm.expectRevert(bytes("PAUSED"));
        gateway.execute(keccak256("SRC_TX_PAUSE"), 0, user, 1 ether);

        vm.expectRevert(bytes("PAUSED"));
        vm.prank(user);
        gateway.requestBurn(1 ether);
    }

    function testTxCapBlocksAttestExecuteAndBurn() public {
        BridgeGateway capped = _deployGateway(
            31337,
            31338,
            1,
            bytes4(keccak256("mintFromLockEvent(address,uint256,bytes32)")),
            bytes4(keccak256("burn(address,uint256)")),
            10 ether
        );
        capped.initializeTarget(address(target));
        capped.initializeSourceEmitter(sourceEmitter);

        vm.expectRevert(bytes("AMOUNT_ABOVE_CAP"));
        vm.prank(validator1);
        capped.attest(keccak256("SRC_TX_CAP"), 0, user, 11 ether);

        vm.prank(validator1);
        capped.attest(keccak256("SRC_TX_CAP_OK"), 0, user, 10 ether);
        vm.prank(validator2);
        capped.attest(keccak256("SRC_TX_CAP_OK"), 0, user, 10 ether);

        vm.expectRevert(bytes("AMOUNT_ABOVE_CAP"));
        capped.execute(keccak256("SRC_TX_CAP_OK"), 0, user, 11 ether);

        vm.expectRevert(bytes("AMOUNT_ABOVE_CAP"));
        vm.prank(user);
        capped.requestBurn(11 ether);
    }

    function testExecuteCannotReplayAfterSuccess() public {
        bytes32 txHash = keccak256("SRC_TX_REPLAY");
        uint256 amount = 7 ether;

        vm.prank(validator1);
        gateway.attest(txHash, 0, user, amount);
        vm.prank(validator2);
        gateway.attest(txHash, 0, user, amount);

        gateway.execute(txHash, 0, user, amount);

        vm.expectRevert(bytes("ALREADY_EXECUTED"));
        gateway.execute(txHash, 0, user, amount);
    }

    function testInitializeTargetOnlyOnce() public {
        vm.expectRevert(bytes("TARGET_ALREADY_SET"));
        gateway.initializeTarget(address(target));
    }

    function testInitializeSourceEmitterOnlyOnce() public {
        vm.expectRevert(bytes("SOURCE_EMITTER_ALREADY_SET"));
        gateway.initializeSourceEmitter(sourceEmitter);
    }

    function testRequestBurnRevertsWhenBurnDisabled() public {
        BridgeGateway burnDisabled = _deployGateway(
            31337,
            31338,
            1,
            bytes4(keccak256("mintFromLockEvent(address,uint256,bytes32)")),
            bytes4(0),
            0
        );
        burnDisabled.initializeTarget(address(target));

        vm.expectRevert(bytes("BURN_DISABLED"));
        vm.prank(user);
        burnDisabled.requestBurn(1 ether);
    }

    function testAttestAndExecuteRequireInitializedTarget() public {
        BridgeGateway uninitialized = _deployGateway(
            31337,
            31338,
            1,
            bytes4(keccak256("mintFromLockEvent(address,uint256,bytes32)")),
            bytes4(keccak256("burn(address,uint256)")),
            0
        );

        vm.expectRevert(bytes("TARGET_NOT_SET"));
        vm.prank(validator1);
        uninitialized.attest(keccak256("SRC_TX_UNINIT"), 0, user, 1 ether);

        vm.expectRevert(bytes("TARGET_NOT_SET"));
        uninitialized.execute(keccak256("SRC_TX_UNINIT"), 0, user, 1 ether);

        vm.expectRevert(bytes("TARGET_NOT_SET"));
        vm.prank(user);
        uninitialized.requestBurn(1 ether);
    }

    function testAttestAndExecuteRequireInitializedSourceEmitter() public {
        BridgeGateway missingSourceEmitter = _deployGateway(
            31337,
            31338,
            1,
            bytes4(keccak256("mintFromLockEvent(address,uint256,bytes32)")),
            bytes4(keccak256("burn(address,uint256)")),
            0
        );
        missingSourceEmitter.initializeTarget(address(target));

        vm.expectRevert(bytes("SOURCE_EMITTER_NOT_SET"));
        vm.prank(validator1);
        missingSourceEmitter.attest(keccak256("SRC_TX_NO_SOURCE"), 0, user, 1 ether);

        vm.expectRevert(bytes("SOURCE_EMITTER_NOT_SET"));
        missingSourceEmitter.execute(keccak256("SRC_TX_NO_SOURCE"), 0, user, 1 ether);
    }

    function testExecuteBubblesTargetRevertReason() public {
        MockRevertingBridgeTarget revertingTarget = new MockRevertingBridgeTarget();
        BridgeGateway revertingGateway = _deployGateway(
            31337,
            31338,
            1,
            bytes4(keccak256("mintFromLockEvent(address,uint256,bytes32)")),
            bytes4(keccak256("burn(address,uint256)")),
            0
        );
        revertingGateway.initializeTarget(address(revertingTarget));
        revertingGateway.initializeSourceEmitter(sourceEmitter);

        bytes32 txHash = keccak256("SRC_TX_REVERT");
        vm.prank(validator1);
        revertingGateway.attest(txHash, 0, user, 1 ether);
        vm.prank(validator2);
        revertingGateway.attest(txHash, 0, user, 1 ether);

        vm.expectRevert(bytes("MINT_FAILED"));
        revertingGateway.execute(txHash, 0, user, 1 ether);
    }
}
