// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IBCEVMProofBoundaryV2} from "./IBCEVMProofBoundaryV2.sol";
import {IBCEVMTypesV2} from "./IBCEVMTypesV2.sol";
import {IBCConnectionTypes} from "./IBCConnectionTypes.sol";

/// @title IBCConnectionKeeperV2
/// @notice Minimal connection state keeper for the v2 rebuild lane.
/// @dev The proof-checked handshake stores compact commitments instead of proving Solidity struct layout directly.
contract IBCConnectionKeeperV2 is AccessControl, IBCEVMProofBoundaryV2 {
    bytes32 public constant CONNECTION_ADMIN_ROLE = keccak256("CONNECTION_ADMIN_ROLE");
    bytes32 public constant CONNECTION_COMMITMENT_TYPEHASH = keccak256("IBCLite.ConnectionEnd.v2");

    uint256 internal constant CONNECTION_COMMITMENTS_SLOT = 2;

    uint256 public immutable localChainId;

    mapping(bytes32 => IBCConnectionTypes.ConnectionEnd) internal connections;
    mapping(bytes32 => bytes32) public connectionCommitments;

    event UnsafeConnectionOpened(
        bytes32 indexed connectionId,
        bytes32 indexed clientId,
        bytes32 indexed counterpartyClientId,
        bytes32 counterpartyConnectionId
    );
    event ConnectionHandshakeState(bytes32 indexed connectionId, IBCConnectionTypes.State state);

    constructor(uint256 _localChainId, address besuLightClient_, address admin) IBCEVMProofBoundaryV2(besuLightClient_) {
        require(_localChainId != 0, "CHAIN_ID_ZERO");
        require(admin != address(0), "ADMIN_ZERO");
        localChainId = _localChainId;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CONNECTION_ADMIN_ROLE, admin);
    }

    /// @dev Unsafe admin shortcut kept only for tests and controlled scaffolding.
    ///      Production flows should use the proof-checked handshake path.
    function openConnectionUnsafe(
        bytes32 connectionId,
        bytes32 clientId,
        bytes32 counterpartyClientId,
        bytes32 counterpartyConnectionId,
        uint64 delayPeriod,
        bytes calldata prefix
    ) external onlyRole(CONNECTION_ADMIN_ROLE) {
        require(connectionId != bytes32(0), "CONNECTION_ID_ZERO");
        require(clientId != bytes32(0), "CLIENT_ID_ZERO");
        require(counterpartyClientId != bytes32(0), "COUNTERPARTY_CLIENT_ID_ZERO");
        require(connections[connectionId].state == IBCConnectionTypes.State.Uninitialized, "CONNECTION_EXISTS");

        _writeConnection(
            connectionId,
            IBCConnectionTypes.State.Open,
            clientId,
            counterpartyClientId,
            counterpartyConnectionId,
            delayPeriod,
            prefix
        );

        emit UnsafeConnectionOpened(connectionId, clientId, counterpartyClientId, counterpartyConnectionId);
    }

    function connectionOpenInit(
        bytes32 connectionId,
        bytes32 clientId,
        bytes32 counterpartyClientId,
        uint64 delayPeriod,
        bytes calldata prefix
    ) external onlyRole(CONNECTION_ADMIN_ROLE) {
        require(connectionId != bytes32(0), "CONNECTION_ID_ZERO");
        require(clientId != bytes32(0), "CLIENT_ID_ZERO");
        require(counterpartyClientId != bytes32(0), "COUNTERPARTY_CLIENT_ID_ZERO");
        require(connections[connectionId].state == IBCConnectionTypes.State.Uninitialized, "CONNECTION_EXISTS");

        _writeConnection(
            connectionId,
            IBCConnectionTypes.State.Init,
            clientId,
            counterpartyClientId,
            bytes32(0),
            delayPeriod,
            prefix
        );
    }

    function connectionOpenTry(
        bytes32 connectionId,
        bytes32 clientId,
        bytes32 counterpartyClientId,
        bytes32 counterpartyConnectionId,
        uint64 delayPeriod,
        bytes calldata prefix,
        address counterpartyConnectionKeeper,
        IBCEVMTypesV2.StorageProof calldata counterpartyInitProof
    ) external onlyRole(CONNECTION_ADMIN_ROLE) {
        require(connectionId != bytes32(0), "CONNECTION_ID_ZERO");
        require(clientId != bytes32(0), "CLIENT_ID_ZERO");
        require(counterpartyClientId != bytes32(0), "COUNTERPARTY_CLIENT_ID_ZERO");
        require(counterpartyConnectionId != bytes32(0), "COUNTERPARTY_CONNECTION_ID_ZERO");
        require(connections[connectionId].state == IBCConnectionTypes.State.Uninitialized, "CONNECTION_EXISTS");

        bytes32 expectedCounterpartyCommitment = connectionCommitment(
            counterpartyInitProof.sourceChainId,
            counterpartyConnectionId,
            IBCConnectionTypes.State.Init,
            counterpartyClientId,
            clientId,
            bytes32(0),
            delayPeriod,
            prefix
        );
        _requireCounterpartyConnectionProof(
            counterpartyConnectionKeeper, counterpartyConnectionId, expectedCounterpartyCommitment, counterpartyInitProof
        );

        _writeConnection(
            connectionId,
            IBCConnectionTypes.State.TryOpen,
            clientId,
            counterpartyClientId,
            counterpartyConnectionId,
            delayPeriod,
            prefix
        );
    }

    function connectionOpenAck(
        bytes32 connectionId,
        bytes32 counterpartyConnectionId,
        address counterpartyConnectionKeeper,
        IBCEVMTypesV2.StorageProof calldata counterpartyTryProof
    ) external onlyRole(CONNECTION_ADMIN_ROLE) {
        IBCConnectionTypes.ConnectionEnd memory localConnection = connections[connectionId];
        require(localConnection.state == IBCConnectionTypes.State.Init, "CONNECTION_NOT_INIT");
        require(counterpartyConnectionId != bytes32(0), "COUNTERPARTY_CONNECTION_ID_ZERO");

        bytes32 expectedCounterpartyCommitment = connectionCommitment(
            counterpartyTryProof.sourceChainId,
            counterpartyConnectionId,
            IBCConnectionTypes.State.TryOpen,
            localConnection.counterparty.clientId,
            localConnection.clientId,
            connectionId,
            localConnection.delayPeriod,
            localConnection.counterparty.prefix
        );
        _requireCounterpartyConnectionProof(
            counterpartyConnectionKeeper, counterpartyConnectionId, expectedCounterpartyCommitment, counterpartyTryProof
        );

        _writeConnection(
            connectionId,
            IBCConnectionTypes.State.Open,
            localConnection.clientId,
            localConnection.counterparty.clientId,
            counterpartyConnectionId,
            localConnection.delayPeriod,
            localConnection.counterparty.prefix
        );
    }

    function connectionOpenConfirm(
        bytes32 connectionId,
        address counterpartyConnectionKeeper,
        IBCEVMTypesV2.StorageProof calldata counterpartyOpenProof
    ) external onlyRole(CONNECTION_ADMIN_ROLE) {
        IBCConnectionTypes.ConnectionEnd memory localConnection = connections[connectionId];
        require(localConnection.state == IBCConnectionTypes.State.TryOpen, "CONNECTION_NOT_TRYOPEN");
        bytes32 counterpartyConnectionId = localConnection.counterparty.connectionId;

        bytes32 expectedCounterpartyCommitment = connectionCommitment(
            counterpartyOpenProof.sourceChainId,
            counterpartyConnectionId,
            IBCConnectionTypes.State.Open,
            localConnection.counterparty.clientId,
            localConnection.clientId,
            connectionId,
            localConnection.delayPeriod,
            localConnection.counterparty.prefix
        );
        _requireCounterpartyConnectionProof(
            counterpartyConnectionKeeper, counterpartyConnectionId, expectedCounterpartyCommitment, counterpartyOpenProof
        );

        _writeConnection(
            connectionId,
            IBCConnectionTypes.State.Open,
            localConnection.clientId,
            localConnection.counterparty.clientId,
            counterpartyConnectionId,
            localConnection.delayPeriod,
            localConnection.counterparty.prefix
        );
    }

    function isConnectionOpen(bytes32 connectionId) external view returns (bool) {
        return connections[connectionId].state == IBCConnectionTypes.State.Open;
    }

    function connection(bytes32 connectionId) external view returns (IBCConnectionTypes.ConnectionEnd memory) {
        return connections[connectionId];
    }

    function chainClientId(uint256 chainId) external pure returns (bytes32) {
        require(chainId != 0, "CHAIN_ID_ZERO");
        return bytes32(uint256(chainId));
    }

    function connectionCommitmentStorageSlot(bytes32 connectionId) public pure returns (bytes32) {
        return keccak256(abi.encode(connectionId, CONNECTION_COMMITMENTS_SLOT));
    }

    function connectionCommitment(
        uint256 chainId,
        bytes32 connectionId,
        IBCConnectionTypes.State state,
        bytes32 clientId,
        bytes32 counterpartyClientId,
        bytes32 counterpartyConnectionId,
        uint64 delayPeriod,
        bytes memory prefix
    ) public pure returns (bytes32) {
        require(chainId != 0, "CHAIN_ID_ZERO");
        require(connectionId != bytes32(0), "CONNECTION_ID_ZERO");
        return keccak256(
            abi.encode(
                CONNECTION_COMMITMENT_TYPEHASH,
                chainId,
                connectionId,
                state,
                clientId,
                counterpartyClientId,
                counterpartyConnectionId,
                delayPeriod,
                keccak256(prefix)
            )
        );
    }

    function _writeConnection(
        bytes32 connectionId,
        IBCConnectionTypes.State state,
        bytes32 clientId,
        bytes32 counterpartyClientId,
        bytes32 counterpartyConnectionId,
        uint64 delayPeriod,
        bytes memory prefix
    ) internal {
        IBCConnectionTypes.ConnectionEnd storage connectionEnd = connections[connectionId];
        connectionEnd.state = state;
        connectionEnd.clientId = clientId;
        connectionEnd.counterparty = IBCConnectionTypes.Counterparty({
            clientId: counterpartyClientId,
            connectionId: counterpartyConnectionId,
            prefix: prefix
        });
        connectionEnd.delayPeriod = delayPeriod;
        delete connectionEnd.versions;
        connectionCommitments[connectionId] = connectionCommitment(
            localChainId, connectionId, state, clientId, counterpartyClientId, counterpartyConnectionId, delayPeriod, prefix
        );
        emit ConnectionHandshakeState(connectionId, state);
    }

    function _requireCounterpartyConnectionProof(
        address counterpartyConnectionKeeper,
        bytes32 counterpartyConnectionId,
        bytes32 expectedCommitment,
        IBCEVMTypesV2.StorageProof calldata proof
    ) internal view {
        require(counterpartyConnectionKeeper != address(0), "COUNTERPARTY_KEEPER_ZERO");
        require(proof.sourceChainId != 0 && proof.sourceChainId != localChainId, "BAD_COUNTERPARTY_CHAIN");
        require(proof.account == counterpartyConnectionKeeper, "CONNECTION_PROOF_ACCOUNT_MISMATCH");
        require(
            proof.storageKey == connectionCommitmentStorageSlot(counterpartyConnectionId),
            "CONNECTION_PROOF_KEY_MISMATCH"
        );
        require(
            keccak256(proof.expectedValue) == keccak256(IBCEVMTypesV2.rlpEncodeWord(expectedCommitment)),
            "CONNECTION_PROOF_VALUE_MISMATCH"
        );
        require(_verifyTrustedEVMStorageProof(proof), "INVALID_CONNECTION_PROOF");
    }
}
