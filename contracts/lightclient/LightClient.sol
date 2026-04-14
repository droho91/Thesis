// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title LightClient
/// @notice Stores finalized source-chain checkpoints accepted by a pluggable consensus verifier.
contract LightClient is AccessControl {
    bytes32 public constant LIGHT_CLIENT_ADMIN_ROLE = keccak256("LIGHT_CLIENT_ADMIN_ROLE");

    struct HeaderUpdate {
        uint256 sourceChainId;
        uint256 blockNumber;
        bytes32 blockHash;
        bytes32 parentHash;
        bytes32 stateRoot;
        uint256 timestamp;
    }

    struct FinalizedHeader {
        uint256 blockNumber;
        bytes32 blockHash;
        bytes32 parentHash;
        bytes32 stateRoot;
        uint256 timestamp;
        bool exists;
    }

    IHeaderUpdateVerifier public verifier;
    mapping(uint256 => mapping(bytes32 => FinalizedHeader)) private headers;
    mapping(uint256 => bytes32) public latestFinalizedBlockHash;
    mapping(uint256 => uint256) public latestFinalizedBlockNumber;

    event VerifierUpdated(address indexed oldVerifier, address indexed newVerifier);
    event FinalizedHeaderAccepted(
        uint256 indexed sourceChainId,
        uint256 indexed blockNumber,
        bytes32 indexed blockHash,
        bytes32 parentHash,
        bytes32 stateRoot,
        address relayer
    );

    constructor(address _verifier) {
        require(_verifier != address(0), "VERIFIER_ZERO");
        verifier = IHeaderUpdateVerifier(_verifier);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(LIGHT_CLIENT_ADMIN_ROLE, msg.sender);
    }

    function setVerifier(address newVerifier) external onlyRole(LIGHT_CLIENT_ADMIN_ROLE) {
        require(newVerifier != address(0), "VERIFIER_ZERO");
        address oldVerifier = address(verifier);
        verifier = IHeaderUpdateVerifier(newVerifier);
        emit VerifierUpdated(oldVerifier, newVerifier);
    }

    /// @notice Permissionless update entry point. Correctness comes from verifier logic, not caller identity.
    function submitFinalizedHeader(HeaderUpdate calldata update, bytes calldata proof) external returns (bytes32 blockHash) {
        require(update.sourceChainId != 0, "CHAIN_ID_ZERO");
        require(update.blockNumber != 0, "BLOCK_NUMBER_ZERO");
        require(update.blockHash != bytes32(0), "BLOCK_HASH_ZERO");
        require(!headers[update.sourceChainId][update.blockHash].exists, "HEADER_EXISTS");
        require(verifier.verifyHeaderUpdate(update, proof), "INVALID_HEADER_UPDATE");

        headers[update.sourceChainId][update.blockHash] = FinalizedHeader({
            blockNumber: update.blockNumber,
            blockHash: update.blockHash,
            parentHash: update.parentHash,
            stateRoot: update.stateRoot,
            timestamp: update.timestamp,
            exists: true
        });

        if (update.blockNumber >= latestFinalizedBlockNumber[update.sourceChainId]) {
            latestFinalizedBlockNumber[update.sourceChainId] = update.blockNumber;
            latestFinalizedBlockHash[update.sourceChainId] = update.blockHash;
        }

        emit FinalizedHeaderAccepted(
            update.sourceChainId,
            update.blockNumber,
            update.blockHash,
            update.parentHash,
            update.stateRoot,
            msg.sender
        );
        return update.blockHash;
    }

    function isFinalized(uint256 sourceChainId, bytes32 blockHash) external view returns (bool) {
        return headers[sourceChainId][blockHash].exists;
    }

    function finalizedHeader(uint256 sourceChainId, bytes32 blockHash)
        external
        view
        returns (FinalizedHeader memory)
    {
        FinalizedHeader memory header = headers[sourceChainId][blockHash];
        require(header.exists, "HEADER_UNKNOWN");
        return header;
    }
}

interface IHeaderUpdateVerifier {
    function verifyHeaderUpdate(LightClient.HeaderUpdate calldata update, bytes calldata proof)
        external
        view
        returns (bool);
}

/// @title DevHeaderUpdateVerifier
/// @notice Deterministic local verifier for tests and demos; replace for production networks.
/// @dev This is a strict local stand-in for consensus verification.
contract DevHeaderUpdateVerifier is IHeaderUpdateVerifier {
    bytes32 public constant DEV_HEADER_DOMAIN = keccak256("DEV_LIGHT_CLIENT_HEADER_UPDATE_V1");

    function verifyHeaderUpdate(LightClient.HeaderUpdate calldata update, bytes calldata proof)
        external
        pure
        returns (bool)
    {
        bytes32 expected = keccak256(
            abi.encode(
                DEV_HEADER_DOMAIN,
                update.sourceChainId,
                update.blockNumber,
                update.blockHash,
                update.parentHash,
                update.stateRoot,
                update.timestamp
            )
        );
        return proof.length == 32 && abi.decode(proof, (bytes32)) == expected;
    }
}
