// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {LightClient} from "./LightClient.sol";

/// @title ExecutionHeaderStore
/// @notice Stores execution headers whose blocks are finalized by the light client.
contract ExecutionHeaderStore {
    LightClient public immutable lightClient;

    struct ExecutionHeader {
        uint256 sourceChainId;
        uint256 blockNumber;
        bytes32 blockHash;
        bytes32 parentHash;
        bytes32 receiptsRoot;
        uint256 timestamp;
        bytes32 finalizedCheckpoint;
    }

    struct StoredExecutionHeader {
        uint256 blockNumber;
        bytes32 blockHash;
        bytes32 parentHash;
        bytes32 receiptsRoot;
        uint256 timestamp;
        bytes32 finalizedCheckpoint;
        bool exists;
    }

    mapping(uint256 => mapping(bytes32 => StoredExecutionHeader)) private headers;

    event ExecutionHeaderStored(
        uint256 indexed sourceChainId,
        uint256 indexed blockNumber,
        bytes32 indexed blockHash,
        bytes32 receiptsRoot,
        bytes32 finalizedCheckpoint,
        address relayer
    );

    constructor(address _lightClient) {
        require(_lightClient != address(0), "LIGHT_CLIENT_ZERO");
        lightClient = LightClient(_lightClient);
    }

    function submitExecutionHeader(ExecutionHeader calldata header) external returns (bytes32 blockHash) {
        require(header.sourceChainId != 0, "CHAIN_ID_ZERO");
        require(header.blockNumber != 0, "BLOCK_NUMBER_ZERO");
        require(header.blockHash != bytes32(0), "BLOCK_HASH_ZERO");
        require(header.receiptsRoot != bytes32(0), "RECEIPTS_ROOT_ZERO");
        require(header.finalizedCheckpoint != bytes32(0), "CHECKPOINT_ZERO");
        require(!headers[header.sourceChainId][header.blockHash].exists, "EXEC_HEADER_EXISTS");
        require(lightClient.isFinalized(header.sourceChainId, header.finalizedCheckpoint), "CHECKPOINT_NOT_FINALIZED");

        LightClient.FinalizedHeader memory checkpoint =
            lightClient.finalizedHeader(header.sourceChainId, header.finalizedCheckpoint);
        require(checkpoint.blockNumber >= header.blockNumber, "HEADER_AFTER_CHECKPOINT");

        // Local/demo mode uses the finalized execution block directly. Production implementations can
        // replace this store with ancestry proofs from finalized checkpoints to execution payloads.
        require(header.blockHash == header.finalizedCheckpoint, "ANCESTRY_NOT_PROVEN");

        headers[header.sourceChainId][header.blockHash] = StoredExecutionHeader({
            blockNumber: header.blockNumber,
            blockHash: header.blockHash,
            parentHash: header.parentHash,
            receiptsRoot: header.receiptsRoot,
            timestamp: header.timestamp,
            finalizedCheckpoint: header.finalizedCheckpoint,
            exists: true
        });

        emit ExecutionHeaderStored(
            header.sourceChainId,
            header.blockNumber,
            header.blockHash,
            header.receiptsRoot,
            header.finalizedCheckpoint,
            msg.sender
        );
        return header.blockHash;
    }

    function isKnown(uint256 sourceChainId, bytes32 blockHash) external view returns (bool) {
        return headers[sourceChainId][blockHash].exists;
    }

    function executionHeader(uint256 sourceChainId, bytes32 blockHash)
        external
        view
        returns (StoredExecutionHeader memory)
    {
        StoredExecutionHeader memory header = headers[sourceChainId][blockHash];
        require(header.exists, "EXEC_HEADER_UNKNOWN");
        return header;
    }

    function receiptsRootOf(uint256 sourceChainId, bytes32 blockHash) external view returns (bytes32) {
        StoredExecutionHeader memory header = headers[sourceChainId][blockHash];
        require(header.exists, "EXEC_HEADER_UNKNOWN");
        return header.receiptsRoot;
    }
}
