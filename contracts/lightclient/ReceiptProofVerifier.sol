// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ExecutionHeaderStore} from "./ExecutionHeaderStore.sol";

/// @title ReceiptProofVerifier
/// @notice Verifies dispatch-event receipt inclusion against finalized execution headers.
contract ReceiptProofVerifier {
    bytes32 public constant DEV_RECEIPT_DOMAIN = keccak256("DEV_RECEIPT_INCLUSION_PROOF_V1");

    ExecutionHeaderStore public immutable executionHeaderStore;

    struct ReceiptProof {
        uint256 sourceChainId;
        bytes32 blockHash;
        bytes32 receiptsRoot;
        address emitter;
        uint256 logIndex;
        bytes32 proofRoot;
    }

    constructor(address _executionHeaderStore) {
        require(_executionHeaderStore != address(0), "HEADER_STORE_ZERO");
        executionHeaderStore = ExecutionHeaderStore(_executionHeaderStore);
    }

    function verifyReceiptProof(ReceiptProof calldata proof, bytes32 expectedEventHash)
        external
        view
        returns (bool)
    {
        if (expectedEventHash == bytes32(0) || proof.emitter == address(0)) return false;
        if (!executionHeaderStore.isKnown(proof.sourceChainId, proof.blockHash)) return false;

        bytes32 storedRoot = executionHeaderStore.receiptsRootOf(proof.sourceChainId, proof.blockHash);
        if (storedRoot != proof.receiptsRoot) return false;

        bytes32 expectedProofRoot = keccak256(
            abi.encode(
                DEV_RECEIPT_DOMAIN,
                proof.sourceChainId,
                proof.blockHash,
                proof.receiptsRoot,
                proof.emitter,
                proof.logIndex,
                expectedEventHash
            )
        );
        return proof.proofRoot == expectedProofRoot;
    }

    function computeDevProofRoot(
        uint256 sourceChainId,
        bytes32 blockHash,
        bytes32 receiptsRoot,
        address emitter,
        uint256 logIndex,
        bytes32 expectedEventHash
    ) external pure returns (bytes32) {
        return keccak256(
            abi.encode(DEV_RECEIPT_DOMAIN, sourceChainId, blockHash, receiptsRoot, emitter, logIndex, expectedEventHash)
        );
    }
}
