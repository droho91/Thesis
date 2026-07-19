// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {EVMProofTypes} from "../../contracts/gateway/EVMProofTypes.sol";
import {IInstitutionalCheckpointClient} from "../../contracts/gateway/IInstitutionalCheckpointClient.sol";
import {
    IInstitutionalMessageLifecycle,
    IInstitutionalMessageReceiver
} from "../../contracts/gateway/IInstitutionalMessageReceiver.sol";
import {InstitutionalCheckpointTypes} from "../../contracts/gateway/InstitutionalCheckpointTypes.sol";
import {InstitutionalCrossChainGateway} from "../../contracts/gateway/InstitutionalCrossChainGateway.sol";
import {InstitutionalMessageLib} from "../../contracts/gateway/InstitutionalMessageLib.sol";
import {StorageProofBuilder} from "../../contracts/test/StorageProofBuilder.sol";

contract GatewayMockCheckpointClient is IInstitutionalCheckpointClient {
    mapping(uint256 => mapping(uint256 => bytes32)) internal roots;
    mapping(uint256 => mapping(uint256 => uint256)) internal timestamps;
    mapping(uint256 => uint256) internal heights;
    mapping(uint256 => InstitutionalCheckpointTypes.ClientStatus) internal statuses;

    function setCheckpoint(uint256 sourceChainId, uint256 height, bytes32 root, uint256 timestamp) external {
        roots[sourceChainId][height] = root;
        timestamps[sourceChainId][height] = timestamp;
        if (height > heights[sourceChainId]) heights[sourceChainId] = height;
        statuses[sourceChainId] = InstitutionalCheckpointTypes.ClientStatus.Active;
    }

    function setStatus(uint256 sourceChainId, InstitutionalCheckpointTypes.ClientStatus status_) external {
        statuses[sourceChainId] = status_;
    }

    function status(uint256 sourceChainId) external view returns (InstitutionalCheckpointTypes.ClientStatus) {
        return statuses[sourceChainId];
    }

    function latestTrustedHeight(uint256 sourceChainId) external view returns (uint256) {
        return heights[sourceChainId];
    }

    function trustedStateRoot(uint256 sourceChainId, uint256 blockNumber) external view returns (bytes32) {
        return roots[sourceChainId][blockNumber];
    }

    function trustedTimestamp(uint256 sourceChainId, uint256 blockNumber) external view returns (uint256) {
        return timestamps[sourceChainId][blockNumber];
    }

    function checkpointDigest(InstitutionalCheckpointTypes.Checkpoint calldata checkpoint)
        external
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(checkpoint));
    }
}

contract GatewayTestApplication is IInstitutionalMessageReceiver, IInstitutionalMessageLifecycle {
    InstitutionalCrossChainGateway public immutable gateway;
    uint256 public receiveCount;
    uint256 public acknowledgementCount;
    uint256 public timeoutCount;
    bytes32 public lastMessageId;
    bytes public lastPayload;
    bytes public lastAcknowledgement;
    bool public failReceive;
    bool public failAcknowledgement;

    constructor(InstitutionalCrossChainGateway gateway_) {
        gateway = gateway_;
    }

    function setFailureModes(bool failReceive_, bool failAcknowledgement_) external {
        failReceive = failReceive_;
        failAcknowledgement = failAcknowledgement_;
    }

    function send(uint256 destinationChainId, address destinationApplication, bytes calldata payload, uint64 timeout)
        external
        returns (bytes32 messageId, InstitutionalMessageLib.Message memory message)
    {
        return gateway.sendMessage(destinationChainId, destinationApplication, payload, timeout);
    }

    function onInstitutionalMessage(bytes32 messageId, uint256, address, bytes calldata payload)
        external
        returns (bytes memory acknowledgement)
    {
        require(msg.sender == address(gateway), "ONLY_GATEWAY");
        require(!failReceive, "RECEIVE_REJECTED");
        receiveCount++;
        lastMessageId = messageId;
        lastPayload = payload;
        return abi.encodePacked("accepted:", messageId);
    }

    function onInstitutionalAcknowledgement(bytes32 messageId, bytes calldata acknowledgement) external {
        require(msg.sender == address(gateway), "ONLY_GATEWAY");
        require(!failAcknowledgement, "ACK_REJECTED");
        acknowledgementCount++;
        lastMessageId = messageId;
        lastAcknowledgement = acknowledgement;
    }

    function onInstitutionalTimeout(bytes32 messageId) external {
        require(msg.sender == address(gateway), "ONLY_GATEWAY");
        timeoutCount++;
        lastMessageId = messageId;
    }
}

contract InstitutionalCrossChainGatewayTest is Test {
    uint256 internal constant CHAIN_A = 41001;
    uint256 internal constant CHAIN_B = 41002;
    uint256 internal constant HEIGHT_A = 100;
    uint256 internal constant HEIGHT_B = 200;

    GatewayMockCheckpointClient internal clientA;
    GatewayMockCheckpointClient internal clientB;
    InstitutionalCrossChainGateway internal gatewayA;
    InstitutionalCrossChainGateway internal gatewayB;
    GatewayTestApplication internal appA;
    GatewayTestApplication internal appB;
    StorageProofBuilder internal builder;

    event MessageReceived(
        bytes32 indexed messageId,
        uint256 indexed sourceChainId,
        uint256 indexed checkpointHeight,
        bytes32 acknowledgementHash,
        bytes acknowledgement
    );

    function setUp() public {
        vm.warp(1_800_000_000);
        clientA = new GatewayMockCheckpointClient();
        clientB = new GatewayMockCheckpointClient();
        gatewayA = new InstitutionalCrossChainGateway(CHAIN_A, address(clientA), address(this));
        gatewayB = new InstitutionalCrossChainGateway(CHAIN_B, address(clientB), address(this));
        appA = new GatewayTestApplication(gatewayA);
        appB = new GatewayTestApplication(gatewayB);
        builder = new StorageProofBuilder();

        gatewayA.setRemoteGateway(CHAIN_B, address(gatewayB));
        gatewayB.setRemoteGateway(CHAIN_A, address(gatewayA));
        gatewayA.setApplicationRoute(address(appA), CHAIN_B, address(appB), true);
        gatewayB.setApplicationRoute(address(appB), CHAIN_A, address(appA), true);
    }

    function testSendReceiveAndAcknowledgeEndToEnd() public {
        bytes memory payload = abi.encode(uint256(25_000), "USD", "loan-collateral-001");
        (bytes32 messageId, InstitutionalMessageLib.Message memory message) =
            appA.send(CHAIN_B, address(appB), payload, uint64(block.timestamp + 1 hours));

        bytes32 commitment = InstitutionalMessageLib.commitment(message);
        assertEq(gatewayA.messageCommitment(messageId), commitment);
        assertEq(message.sourceApplication, address(appA));
        assertEq(message.destinationApplication, address(appB));

        EVMProofTypes.StorageProof memory commitmentProof = _membershipProof(
            clientB,
            CHAIN_A,
            HEIGHT_A,
            address(gatewayA),
            gatewayA.commitmentStorageSlot(messageId),
            commitment,
            block.timestamp
        );

        bytes memory acknowledgement = abi.encodePacked("accepted:", messageId);
        bytes32 expectedAcknowledgementHash = keccak256(acknowledgement);
        vm.expectEmit(true, true, true, true, address(gatewayB));
        emit MessageReceived(messageId, CHAIN_A, HEIGHT_A, expectedAcknowledgementHash, acknowledgement);
        (, bytes32 acknowledgementHash) = gatewayB.receiveMessage(message, commitmentProof);
        assertEq(acknowledgementHash, keccak256(acknowledgement));
        assertTrue(gatewayB.messageReceived(messageId));
        assertEq(appB.receiveCount(), 1);
        assertEq(appB.lastPayload(), payload);

        EVMProofTypes.StorageProof memory acknowledgementProof = _membershipProof(
            clientA,
            CHAIN_B,
            HEIGHT_B,
            address(gatewayB),
            gatewayB.acknowledgementStorageSlot(messageId),
            acknowledgementHash,
            block.timestamp
        );
        gatewayA.acknowledgeMessage(message, acknowledgement, acknowledgementProof);

        assertTrue(gatewayA.messageCompleted(messageId));
        assertEq(appA.acknowledgementCount(), 1);
        assertEq(appA.lastAcknowledgement(), acknowledgement);

        vm.expectRevert(bytes("MESSAGE_ALREADY_COMPLETED"));
        gatewayA.acknowledgeMessage(message, acknowledgement, acknowledgementProof);
    }

    function testReceiveRejectsReplayAndForgedCommitment() public {
        (bytes32 messageId, InstitutionalMessageLib.Message memory message) = _sendDefault();
        bytes32 commitment = InstitutionalMessageLib.commitment(message);
        EVMProofTypes.StorageProof memory validProof = _membershipProof(
            clientB,
            CHAIN_A,
            HEIGHT_A,
            address(gatewayA),
            gatewayA.commitmentStorageSlot(messageId),
            commitment,
            block.timestamp
        );

        EVMProofTypes.StorageProof memory forgedProof = validProof;
        forgedProof.expectedValue = EVMProofTypes.rlpEncodeWord(keccak256("forged-commitment"));
        vm.expectRevert(bytes("PROOF_EXPECTED_VALUE_MISMATCH"));
        gatewayB.receiveMessage(message, forgedProof);

        validProof.expectedValue = EVMProofTypes.rlpEncodeWord(commitment);
        gatewayB.receiveMessage(message, validProof);
        vm.expectRevert(bytes("MESSAGE_ALREADY_RECEIVED"));
        gatewayB.receiveMessage(message, validProof);
    }

    function testReceiveRejectsFrozenCheckpointClient() public {
        (bytes32 messageId, InstitutionalMessageLib.Message memory message) = _sendDefault();
        EVMProofTypes.StorageProof memory proof = _membershipProof(
            clientB,
            CHAIN_A,
            HEIGHT_A,
            address(gatewayA),
            gatewayA.commitmentStorageSlot(messageId),
            InstitutionalMessageLib.commitment(message),
            block.timestamp
        );
        clientB.setStatus(CHAIN_A, InstitutionalCheckpointTypes.ClientStatus.Frozen);

        vm.expectRevert(bytes("INVALID_MESSAGE_COMMITMENT_PROOF"));
        gatewayB.receiveMessage(message, proof);
    }

    function testReceiveRollsBackReceiptWhenApplicationRejects() public {
        (bytes32 messageId, InstitutionalMessageLib.Message memory message) = _sendDefault();
        EVMProofTypes.StorageProof memory proof = _membershipProof(
            clientB,
            CHAIN_A,
            HEIGHT_A,
            address(gatewayA),
            gatewayA.commitmentStorageSlot(messageId),
            InstitutionalMessageLib.commitment(message),
            block.timestamp
        );
        appB.setFailureModes(true, false);

        vm.expectRevert(bytes("RECEIVE_REJECTED"));
        gatewayB.receiveMessage(message, proof);
        assertFalse(gatewayB.messageReceived(messageId));
    }

    function testAcknowledgeRollsBackCompletionWhenSourceApplicationRejects() public {
        (bytes32 messageId, InstitutionalMessageLib.Message memory message) = _sendDefault();
        bytes memory acknowledgement = abi.encodePacked("accepted:", messageId);
        bytes32 acknowledgementHash = keccak256(acknowledgement);
        EVMProofTypes.StorageProof memory proof = _membershipProof(
            clientA,
            CHAIN_B,
            HEIGHT_B,
            address(gatewayB),
            gatewayB.acknowledgementStorageSlot(messageId),
            acknowledgementHash,
            block.timestamp
        );
        appA.setFailureModes(false, true);

        vm.expectRevert(bytes("ACK_REJECTED"));
        gatewayA.acknowledgeMessage(message, acknowledgement, proof);
        assertFalse(gatewayA.messageCompleted(messageId));
    }

    function testPauseBlocksNewMessagesButAllowsProofCheckedAcknowledgement() public {
        (bytes32 messageId, InstitutionalMessageLib.Message memory message) = _sendDefault();
        bytes memory acknowledgement = abi.encodePacked("accepted:", messageId);
        EVMProofTypes.StorageProof memory proof = _membershipProof(
            clientA,
            CHAIN_B,
            HEIGHT_B,
            address(gatewayB),
            gatewayB.acknowledgementStorageSlot(messageId),
            keccak256(acknowledgement),
            block.timestamp
        );
        gatewayA.pause();

        vm.expectRevert();
        appA.send(CHAIN_B, address(appB), bytes("blocked-while-paused"), uint64(block.timestamp + 1 hours));
        gatewayA.acknowledgeMessage(message, acknowledgement, proof);

        assertTrue(gatewayA.messageCompleted(messageId));
        assertEq(appA.acknowledgementCount(), 1);
    }

    function testTimeoutRequiresRemoteCheckpointTimeAndReceiptAbsence() public {
        uint64 timeout = uint64(block.timestamp + 10 minutes);
        (bytes32 messageId, InstitutionalMessageLib.Message memory message) =
            appA.send(CHAIN_B, address(appB), bytes("pending-transfer"), timeout);

        EVMProofTypes.StorageProof memory earlyProof = _absenceProof(
            clientA,
            CHAIN_B,
            HEIGHT_B,
            address(gatewayB),
            gatewayB.receiptStorageSlot(messageId),
            gatewayB.acknowledgementStorageSlot(messageId),
            timeout - 1
        );
        vm.expectRevert(bytes("MESSAGE_NOT_TIMED_OUT"));
        gatewayA.timeoutMessage(message, earlyProof);

        EVMProofTypes.StorageProof memory timeoutProof = _absenceProof(
            clientA,
            CHAIN_B,
            HEIGHT_B + 1,
            address(gatewayB),
            gatewayB.receiptStorageSlot(messageId),
            gatewayB.acknowledgementStorageSlot(messageId),
            timeout
        );
        gatewayA.timeoutMessage(message, timeoutProof);

        assertTrue(gatewayA.messageTimedOut(messageId));
        assertEq(appA.timeoutCount(), 1);
        vm.expectRevert(bytes("MESSAGE_ALREADY_TIMED_OUT"));
        gatewayA.timeoutMessage(message, timeoutProof);
    }

    function testPauseStillAllowsProofCheckedTimeout() public {
        uint64 timeout = uint64(block.timestamp + 10 minutes);
        (bytes32 messageId, InstitutionalMessageLib.Message memory message) =
            appA.send(CHAIN_B, address(appB), bytes("paused-timeout"), timeout);
        EVMProofTypes.StorageProof memory timeoutProof = _absenceProof(
            clientA,
            CHAIN_B,
            HEIGHT_B,
            address(gatewayB),
            gatewayB.receiptStorageSlot(messageId),
            gatewayB.acknowledgementStorageSlot(messageId),
            timeout
        );
        gatewayA.pause();

        gatewayA.timeoutMessage(message, timeoutProof);

        assertTrue(gatewayA.messageTimedOut(messageId));
        assertEq(appA.timeoutCount(), 1);
    }

    function testTimeoutRejectsProofOfExistingReceipt() public {
        uint64 timeout = uint64(block.timestamp + 10 minutes);
        (bytes32 messageId, InstitutionalMessageLib.Message memory message) =
            appA.send(CHAIN_B, address(appB), bytes("already-received"), timeout);
        EVMProofTypes.StorageProof memory receiptProof = _membershipProof(
            clientA,
            CHAIN_B,
            HEIGHT_B,
            address(gatewayB),
            gatewayB.receiptStorageSlot(messageId),
            bytes32(uint256(1)),
            timeout
        );
        receiptProof.expectedValue = "";

        vm.expectRevert(bytes("INVALID_RECEIPT_ABSENCE_PROOF"));
        gatewayA.timeoutMessage(message, receiptProof);
    }

    function testReceiveRejectsExpiredOrWrongRouteEnvelope() public {
        (bytes32 messageId, InstitutionalMessageLib.Message memory message) = _sendDefault();
        EVMProofTypes.StorageProof memory proof = _membershipProof(
            clientB,
            CHAIN_A,
            HEIGHT_A,
            address(gatewayA),
            gatewayA.commitmentStorageSlot(messageId),
            InstitutionalMessageLib.commitment(message),
            block.timestamp
        );

        gatewayB.setApplicationRoute(address(appB), CHAIN_A, address(appA), false);
        vm.expectRevert(bytes("APPLICATION_ROUTE_NOT_ALLOWED"));
        gatewayB.receiveMessage(message, proof);

        gatewayB.setApplicationRoute(address(appB), CHAIN_A, address(appA), true);
        vm.warp(message.timeoutTimestamp);
        vm.expectRevert(bytes("MESSAGE_TIMEOUT_EXPIRED"));
        gatewayB.receiveMessage(message, proof);
    }

    function testGatewayMigrationPreservesInFlightMessageUntilOldGatewayIsRevoked() public {
        (bytes32 messageId, InstitutionalMessageLib.Message memory message) = _sendDefault();
        bytes32 commitment = InstitutionalMessageLib.commitment(message);
        EVMProofTypes.StorageProof memory proof = _membershipProof(
            clientB,
            CHAIN_A,
            HEIGHT_A,
            address(gatewayA),
            gatewayA.commitmentStorageSlot(messageId),
            commitment,
            block.timestamp
        );

        gatewayB.setRemoteGateway(CHAIN_A, address(0xBEEF));
        gatewayB.receiveMessage(message, proof);
        assertTrue(gatewayB.messageReceived(messageId));

        (messageId, message) = _sendDefault();
        commitment = InstitutionalMessageLib.commitment(message);
        proof = _membershipProof(
            clientB,
            CHAIN_A,
            HEIGHT_A + 1,
            address(gatewayA),
            gatewayA.commitmentStorageSlot(messageId),
            commitment,
            block.timestamp
        );
        gatewayB.setRemoteGatewayTrust(CHAIN_A, address(gatewayA), false);

        vm.expectRevert(bytes("UNTRUSTED_SOURCE_GATEWAY"));
        gatewayB.receiveMessage(message, proof);
    }

    function _sendDefault()
        internal
        returns (bytes32 messageId, InstitutionalMessageLib.Message memory message)
    {
        return appA.send(
            CHAIN_B,
            address(appB),
            bytes("institutional-transfer"),
            uint64(block.timestamp + 1 hours)
        );
    }

    function _membershipProof(
        GatewayMockCheckpointClient client,
        uint256 sourceChainId,
        uint256 height,
        address account,
        bytes32 storageKey,
        bytes32 storageWord,
        uint256 timestamp
    ) internal returns (EVMProofTypes.StorageProof memory proof) {
        StorageProofBuilder.BuiltSingleStorageProof memory built =
            builder.buildSingleStorageProof(account, storageKey, storageWord);
        client.setCheckpoint(sourceChainId, height, built.stateRoot, timestamp);
        proof = EVMProofTypes.StorageProof({
            sourceChainId: sourceChainId,
            checkpointHeight: height,
            stateRoot: built.stateRoot,
            account: account,
            storageKey: storageKey,
            expectedValue: built.expectedTrieValue,
            accountProof: built.accountProof,
            storageProof: built.storageProof
        });
    }

    function _absenceProof(
        GatewayMockCheckpointClient client,
        uint256 sourceChainId,
        uint256 height,
        address account,
        bytes32 absentStorageKey,
        bytes32 unrelatedStorageKey,
        uint256 timestamp
    ) internal returns (EVMProofTypes.StorageProof memory proof) {
        StorageProofBuilder.BuiltSingleStorageProof memory built = builder.buildSingleStorageProof(
            account, unrelatedStorageKey, keccak256("unrelated-existing-value")
        );
        client.setCheckpoint(sourceChainId, height, built.stateRoot, timestamp);
        proof = EVMProofTypes.StorageProof({
            sourceChainId: sourceChainId,
            checkpointHeight: height,
            stateRoot: built.stateRoot,
            account: account,
            storageKey: absentStorageKey,
            expectedValue: "",
            accountProof: built.accountProof,
            storageProof: built.storageProof
        });
    }
}
