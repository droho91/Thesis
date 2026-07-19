// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EVMProofTypes} from "./EVMProofTypes.sol";
import {IInstitutionalMessageLifecycle, IInstitutionalMessageReceiver} from "./IInstitutionalMessageReceiver.sol";
import {InstitutionalEVMProofBoundary} from "./InstitutionalEVMProofBoundary.sol";
import {InstitutionalGatewaySlots} from "./InstitutionalGatewaySlots.sol";
import {InstitutionalMessageLib} from "./InstitutionalMessageLib.sol";

/// @title InstitutionalCrossChainGateway
/// @notice Proof-checked asynchronous message lane for governed bank applications.
contract InstitutionalCrossChainGateway is AccessControl, Pausable, ReentrancyGuard, InstitutionalEVMProofBoundary {
    bytes32 public constant GATEWAY_ADMIN_ROLE = keccak256("GATEWAY_ADMIN_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    uint256 public constant MAX_PAYLOAD_BYTES = 16_384;
    uint256 public constant MAX_ACKNOWLEDGEMENT_BYTES = 4_096;

    uint256 public immutable localChainId;
    uint256 public nextNonce = 1;

    mapping(uint256 => address) public remoteGatewayByChain;
    mapping(uint256 => mapping(address => bool)) public trustedRemoteGateways;
    mapping(bytes32 => bool) public applicationRoutes;

    event RemoteGatewaySet(uint256 indexed remoteChainId, address indexed remoteGateway);
    event RemoteGatewayTrustSet(uint256 indexed remoteChainId, address indexed remoteGateway, bool trusted);
    event ApplicationRouteSet(
        address indexed localApplication,
        uint256 indexed remoteChainId,
        address indexed remoteApplication,
        bool enabled
    );
    event MessageCommitted(
        bytes32 indexed messageId,
        uint256 indexed nonce,
        address indexed sourceApplication,
        uint256 destinationChainId,
        address destinationGateway,
        address destinationApplication,
        uint64 timeoutTimestamp,
        bytes payload
    );
    event MessageReceived(
        bytes32 indexed messageId,
        uint256 indexed sourceChainId,
        uint256 indexed checkpointHeight,
        bytes32 acknowledgementHash,
        bytes acknowledgement
    );
    event MessageAcknowledged(
        bytes32 indexed messageId,
        uint256 indexed destinationChainId,
        uint256 indexed checkpointHeight,
        bytes32 acknowledgementHash
    );
    event MessageTimedOut(
        bytes32 indexed messageId,
        uint256 indexed destinationChainId,
        uint256 indexed checkpointHeight
    );

    constructor(uint256 localChainId_, address checkpointClient_, address admin)
        InstitutionalEVMProofBoundary(checkpointClient_)
    {
        require(localChainId_ != 0, "LOCAL_CHAIN_ZERO");
        require(admin != address(0), "ADMIN_ZERO");
        localChainId = localChainId_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GATEWAY_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, admin);
    }

    function setRemoteGateway(uint256 remoteChainId, address remoteGateway)
        external
        onlyRole(GATEWAY_ADMIN_ROLE)
    {
        require(remoteChainId != 0 && remoteChainId != localChainId, "BAD_REMOTE_CHAIN");
        require(remoteGateway != address(0), "REMOTE_GATEWAY_ZERO");
        remoteGatewayByChain[remoteChainId] = remoteGateway;
        trustedRemoteGateways[remoteChainId][remoteGateway] = true;
        emit RemoteGatewaySet(remoteChainId, remoteGateway);
        emit RemoteGatewayTrustSet(remoteChainId, remoteGateway, true);
    }

    /// @notice Retains old gateways during migration, then revokes them after all in-flight messages settle.
    function setRemoteGatewayTrust(uint256 remoteChainId, address remoteGateway, bool trusted)
        external
        onlyRole(GATEWAY_ADMIN_ROLE)
    {
        require(remoteGateway != address(0), "REMOTE_GATEWAY_ZERO");
        require(trusted || remoteGateway != remoteGatewayByChain[remoteChainId], "CURRENT_GATEWAY_REQUIRED");
        trustedRemoteGateways[remoteChainId][remoteGateway] = trusted;
        emit RemoteGatewayTrustSet(remoteChainId, remoteGateway, trusted);
    }

    function setApplicationRoute(
        address localApplication,
        uint256 remoteChainId,
        address remoteApplication,
        bool enabled
    ) external onlyRole(GATEWAY_ADMIN_ROLE) {
        require(localApplication != address(0), "LOCAL_APPLICATION_ZERO");
        require(remoteApplication != address(0), "REMOTE_APPLICATION_ZERO");
        require(remoteGatewayByChain[remoteChainId] != address(0), "REMOTE_GATEWAY_NOT_CONFIGURED");
        applicationRoutes[routeKey(localApplication, remoteChainId, remoteApplication)] = enabled;
        emit ApplicationRouteSet(localApplication, remoteChainId, remoteApplication, enabled);
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(GATEWAY_ADMIN_ROLE) {
        _unpause();
    }

    function sendMessage(
        uint256 destinationChainId,
        address destinationApplication,
        bytes calldata payload,
        uint64 timeoutTimestamp
    )
        external
        whenNotPaused
        nonReentrant
        returns (bytes32 messageId, InstitutionalMessageLib.Message memory message)
    {
        address destinationGateway = remoteGatewayByChain[destinationChainId];
        require(destinationGateway != address(0), "REMOTE_GATEWAY_NOT_CONFIGURED");
        require(
            applicationRoutes[routeKey(msg.sender, destinationChainId, destinationApplication)],
            "APPLICATION_ROUTE_NOT_ALLOWED"
        );
        require(msg.sender.code.length > 0, "SOURCE_APPLICATION_NOT_CONTRACT");
        require(destinationApplication != address(0), "DESTINATION_APPLICATION_ZERO");
        require(payload.length > 0 && payload.length <= MAX_PAYLOAD_BYTES, "BAD_PAYLOAD_LENGTH");
        require(timeoutTimestamp > block.timestamp, "TIMEOUT_NOT_FORWARD");

        uint256 nonce = nextNonce++;
        message = InstitutionalMessageLib.Message({
            version: InstitutionalMessageLib.PROTOCOL_VERSION,
            nonce: nonce,
            sourceChainId: localChainId,
            sourceGateway: address(this),
            sourceApplication: msg.sender,
            destinationChainId: destinationChainId,
            destinationGateway: destinationGateway,
            destinationApplication: destinationApplication,
            timeoutTimestamp: timeoutTimestamp,
            payload: payload
        });
        messageId = InstitutionalMessageLib.messageId(message);
        bytes32 commitment = InstitutionalMessageLib.commitment(message);
        _storeWord(InstitutionalGatewaySlots.commitment(messageId), commitment);
        emit MessageCommitted(
            messageId,
            nonce,
            msg.sender,
            destinationChainId,
            destinationGateway,
            destinationApplication,
            timeoutTimestamp,
            payload
        );
    }

    function receiveMessage(
        InstitutionalMessageLib.Message calldata message,
        EVMProofTypes.StorageProof calldata commitmentProof
    ) external whenNotPaused nonReentrant returns (bytes32 messageId, bytes32 ackHash) {
        messageId = _validateIncomingMessage(message);
        require(_loadWord(InstitutionalGatewaySlots.receipt(messageId)) == bytes32(0), "MESSAGE_ALREADY_RECEIVED");
        require(block.timestamp < message.timeoutTimestamp, "MESSAGE_TIMEOUT_EXPIRED");

        bytes32 commitment = InstitutionalMessageLib.commitment(message);
        _requireMembershipProof(
            commitmentProof,
            message.sourceChainId,
            message.sourceGateway,
            InstitutionalGatewaySlots.commitment(messageId),
            commitment,
            "INVALID_MESSAGE_COMMITMENT_PROOF"
        );

        _storeWord(InstitutionalGatewaySlots.receipt(messageId), bytes32(uint256(1)));
        bytes memory acknowledgement = IInstitutionalMessageReceiver(message.destinationApplication)
            .onInstitutionalMessage(messageId, message.sourceChainId, message.sourceApplication, message.payload);
        require(
            acknowledgement.length > 0 && acknowledgement.length <= MAX_ACKNOWLEDGEMENT_BYTES,
            "BAD_ACKNOWLEDGEMENT_LENGTH"
        );
        ackHash = keccak256(acknowledgement);
        _storeWord(InstitutionalGatewaySlots.acknowledgement(messageId), ackHash);
        emit MessageReceived(
            messageId,
            message.sourceChainId,
            commitmentProof.checkpointHeight,
            ackHash,
            acknowledgement
        );
    }

    function acknowledgeMessage(
        InstitutionalMessageLib.Message calldata message,
        bytes calldata acknowledgement,
        EVMProofTypes.StorageProof calldata acknowledgementProof
    ) external nonReentrant returns (bytes32 messageId) {
        messageId = _validateOutgoingMessage(message);
        _requirePendingSourceMessage(messageId, message);
        require(acknowledgement.length > 0 && acknowledgement.length <= MAX_ACKNOWLEDGEMENT_BYTES, "BAD_ACKNOWLEDGEMENT_LENGTH");
        bytes32 ackHash = keccak256(acknowledgement);
        _requireMembershipProof(
            acknowledgementProof,
            message.destinationChainId,
            message.destinationGateway,
            InstitutionalGatewaySlots.acknowledgement(messageId),
            ackHash,
            "INVALID_ACKNOWLEDGEMENT_PROOF"
        );

        _storeWord(InstitutionalGatewaySlots.completion(messageId), bytes32(uint256(1)));
        IInstitutionalMessageLifecycle(message.sourceApplication).onInstitutionalAcknowledgement(
            messageId, acknowledgement
        );
        emit MessageAcknowledged(
            messageId,
            message.destinationChainId,
            acknowledgementProof.checkpointHeight,
            ackHash
        );
    }

    function timeoutMessage(
        InstitutionalMessageLib.Message calldata message,
        EVMProofTypes.StorageProof calldata receiptAbsenceProof
    ) external nonReentrant returns (bytes32 messageId) {
        messageId = _validateOutgoingMessage(message);
        _requirePendingSourceMessage(messageId, message);
        require(receiptAbsenceProof.sourceChainId == message.destinationChainId, "PROOF_CHAIN_MISMATCH");
        require(receiptAbsenceProof.account == message.destinationGateway, "PROOF_ACCOUNT_MISMATCH");
        require(
            receiptAbsenceProof.storageKey == InstitutionalGatewaySlots.receipt(messageId),
            "PROOF_STORAGE_KEY_MISMATCH"
        );
        require(receiptAbsenceProof.expectedValue.length == 0, "ABSENCE_EXPECTED_VALUE_NOT_EMPTY");
        uint256 remoteTimestamp = checkpointClient.trustedTimestamp(
            message.destinationChainId, receiptAbsenceProof.checkpointHeight
        );
        require(remoteTimestamp >= message.timeoutTimestamp, "MESSAGE_NOT_TIMED_OUT");
        require(_verifyStorageAbsence(receiptAbsenceProof), "INVALID_RECEIPT_ABSENCE_PROOF");

        _storeWord(InstitutionalGatewaySlots.timeout(messageId), bytes32(uint256(1)));
        IInstitutionalMessageLifecycle(message.sourceApplication).onInstitutionalTimeout(messageId);
        emit MessageTimedOut(messageId, message.destinationChainId, receiptAbsenceProof.checkpointHeight);
    }

    function messageCommitment(bytes32 messageId) external view returns (bytes32) {
        return _loadWord(InstitutionalGatewaySlots.commitment(messageId));
    }

    function messageReceived(bytes32 messageId) external view returns (bool) {
        return _loadWord(InstitutionalGatewaySlots.receipt(messageId)) != bytes32(0);
    }

    function acknowledgementHash(bytes32 messageId) external view returns (bytes32) {
        return _loadWord(InstitutionalGatewaySlots.acknowledgement(messageId));
    }

    function messageCompleted(bytes32 messageId) external view returns (bool) {
        return _loadWord(InstitutionalGatewaySlots.completion(messageId)) != bytes32(0);
    }

    function messageTimedOut(bytes32 messageId) external view returns (bool) {
        return _loadWord(InstitutionalGatewaySlots.timeout(messageId)) != bytes32(0);
    }

    function commitmentStorageSlot(bytes32 messageId) external pure returns (bytes32) {
        return InstitutionalGatewaySlots.commitment(messageId);
    }

    function receiptStorageSlot(bytes32 messageId) external pure returns (bytes32) {
        return InstitutionalGatewaySlots.receipt(messageId);
    }

    function acknowledgementStorageSlot(bytes32 messageId) external pure returns (bytes32) {
        return InstitutionalGatewaySlots.acknowledgement(messageId);
    }

    function routeKey(address localApplication, uint256 remoteChainId, address remoteApplication)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(localApplication, remoteChainId, remoteApplication));
    }

    function _validateIncomingMessage(InstitutionalMessageLib.Message calldata message)
        private
        view
        returns (bytes32 messageId)
    {
        require(message.version == InstitutionalMessageLib.PROTOCOL_VERSION, "UNSUPPORTED_MESSAGE_VERSION");
        require(message.destinationChainId == localChainId, "WRONG_DESTINATION_CHAIN");
        require(message.destinationGateway == address(this), "WRONG_DESTINATION_GATEWAY");
        require(trustedRemoteGateways[message.sourceChainId][message.sourceGateway], "UNTRUSTED_SOURCE_GATEWAY");
        require(message.destinationApplication.code.length > 0, "DESTINATION_APPLICATION_NOT_CONTRACT");
        require(
            applicationRoutes[
                routeKey(message.destinationApplication, message.sourceChainId, message.sourceApplication)
            ],
            "APPLICATION_ROUTE_NOT_ALLOWED"
        );
        require(message.payload.length > 0 && message.payload.length <= MAX_PAYLOAD_BYTES, "BAD_PAYLOAD_LENGTH");
        return InstitutionalMessageLib.messageId(message);
    }

    function _validateOutgoingMessage(InstitutionalMessageLib.Message calldata message)
        private
        view
        returns (bytes32 messageId)
    {
        require(message.version == InstitutionalMessageLib.PROTOCOL_VERSION, "UNSUPPORTED_MESSAGE_VERSION");
        require(message.sourceChainId == localChainId, "WRONG_SOURCE_CHAIN");
        require(message.sourceGateway == address(this), "WRONG_SOURCE_GATEWAY");
        return InstitutionalMessageLib.messageId(message);
    }

    function _requirePendingSourceMessage(bytes32 messageId, InstitutionalMessageLib.Message calldata message)
        private
        view
    {
        require(
            _loadWord(InstitutionalGatewaySlots.commitment(messageId)) == InstitutionalMessageLib.commitment(message),
            "MESSAGE_NOT_COMMITTED"
        );
        require(_loadWord(InstitutionalGatewaySlots.completion(messageId)) == bytes32(0), "MESSAGE_ALREADY_COMPLETED");
        require(_loadWord(InstitutionalGatewaySlots.timeout(messageId)) == bytes32(0), "MESSAGE_ALREADY_TIMED_OUT");
    }

    function _requireMembershipProof(
        EVMProofTypes.StorageProof calldata proof,
        uint256 expectedSourceChainId,
        address expectedAccount,
        bytes32 expectedStorageKey,
        bytes32 expectedWord,
        string memory invalidProofReason
    ) private view {
        require(proof.sourceChainId == expectedSourceChainId, "PROOF_CHAIN_MISMATCH");
        require(proof.account == expectedAccount, "PROOF_ACCOUNT_MISMATCH");
        require(proof.storageKey == expectedStorageKey, "PROOF_STORAGE_KEY_MISMATCH");
        require(
            keccak256(proof.expectedValue) == keccak256(EVMProofTypes.rlpEncodeWord(expectedWord)),
            "PROOF_EXPECTED_VALUE_MISMATCH"
        );
        require(_verifyStorageMembership(proof), invalidProofReason);
    }

    function _storeWord(bytes32 slot, bytes32 value) private {
        assembly {
            sstore(slot, value)
        }
    }

    function _loadWord(bytes32 slot) private view returns (bytes32 value) {
        assembly {
            value := sload(slot)
        }
    }
}
