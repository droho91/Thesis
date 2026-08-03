// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {EVMProofTypes} from "../../contracts/gateway/EVMProofTypes.sol";
import {IInstitutionalCheckpointClient} from "../../contracts/gateway/IInstitutionalCheckpointClient.sol";
import {InstitutionalCheckpointTypes} from "../../contracts/gateway/InstitutionalCheckpointTypes.sol";
import {InstitutionalEVMProofVerifier} from "../../contracts/gateway/InstitutionalEVMProofVerifier.sol";
import {
    IndependentMPTReference,
    MPTProofHarness
} from "../../contracts/test/MPTProofAssurance.sol";
import {PinnedMPTProofCorpus} from "../../contracts/test/PinnedMPTProofCorpus.sol";

contract PinnedCorpusCheckpointClient is IInstitutionalCheckpointClient {
    mapping(uint256 => mapping(uint256 => bytes32)) private roots;
    mapping(uint256 => InstitutionalCheckpointTypes.ClientStatus) private statuses;
    mapping(uint256 => uint256) public override checkpointAuthorizationFloor;

    function trust(uint256 sourceChainId, uint256 height, bytes32 root) external {
        roots[sourceChainId][height] = root;
        statuses[sourceChainId] = InstitutionalCheckpointTypes.ClientStatus.Active;
    }

    function status(uint256 sourceChainId) external view returns (InstitutionalCheckpointTypes.ClientStatus) {
        return statuses[sourceChainId];
    }

    function latestTrustedHeight(uint256) external pure returns (uint256) {
        return 0;
    }

    function trustedStateRoot(uint256 sourceChainId, uint256 height) external view returns (bytes32) {
        return roots[sourceChainId][height];
    }

    function trustedTimestamp(uint256, uint256) external pure returns (uint256) {
        return 0;
    }

    function checkpointDigest(InstitutionalCheckpointTypes.Checkpoint calldata checkpoint)
        external
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(checkpoint));
    }
}

/// @notice Exercises production proof code with committed client-neutral fixtures.
/// @dev These fixtures are test assurance, not evidence from a live execution client.
contract PinnedMPTProofCorpusTest is Test {
    PinnedMPTProofCorpus private corpus;
    MPTProofHarness private harness;
    IndependentMPTReference private referenceVerifier;
    PinnedCorpusCheckpointClient private checkpointClient;
    InstitutionalEVMProofVerifier private storageVerifier;

    function setUp() public {
        corpus = new PinnedMPTProofCorpus();
        harness = new MPTProofHarness();
        referenceVerifier = new IndependentMPTReference();
        checkpointClient = new PinnedCorpusCheckpointClient();
        storageVerifier = new InstitutionalEVMProofVerifier(address(checkpointClient));
    }

    function testPinnedGenericCorpusMatchesProductionAndIndependentReference() public view {
        assertEq(corpus.genericCount(), 5, "unexpected generic corpus size");
        for (uint256 i = 0; i < corpus.genericCount(); i++) {
            PinnedMPTProofCorpus.GenericVector memory vector = corpus.genericAt(i);
            (bool valid, bool found, bytes memory referenceValue) =
                referenceVerifier.evaluate(vector.root, vector.key, vector.proof);

            assertTrue(valid, "independent reference rejected pinned proof");
            assertEq(found, vector.present, "independent reference outcome mismatch");
            if (vector.present) {
                assertTrue(harness.verify(vector.root, vector.key, vector.proof, vector.value));
                assertEq(harness.extract(vector.root, vector.key, vector.proof), vector.value);
                assertEq(referenceValue, vector.value, "independent reference value mismatch");
                assertFalse(harness.verifyAbsence(vector.root, vector.key, vector.proof));
            } else {
                assertEq(harness.extract(vector.root, vector.key, vector.proof).length, 0);
                assertTrue(harness.verifyAbsence(vector.root, vector.key, vector.proof));
            }
        }
    }

    function testPinnedEip1186StorageCorpusPassesProductionBoundary() public {
        assertEq(corpus.storageCount(), 3, "unexpected storage corpus size");
        for (uint256 i = 0; i < corpus.storageCount(); i++) {
            PinnedMPTProofCorpus.StorageVector memory vector = corpus.storageAt(i);
            checkpointClient.trust(vector.sourceChainId, vector.checkpointHeight, vector.stateRoot);
            EVMProofTypes.StorageProof memory proof = _storageProof(vector);

            if (vector.present) {
                assertTrue(storageVerifier.verifyStorageMembership(proof));
                assertFalse(storageVerifier.verifyStorageAbsence(proof));
            } else {
                assertFalse(storageVerifier.verifyStorageMembership(proof));
                assertTrue(storageVerifier.verifyStorageAbsence(proof));
            }
        }
    }

    function testPinnedCorpusMutationsFailClosed() public {
        PinnedMPTProofCorpus.GenericVector memory genericVector = corpus.genericAt(0);
        genericVector.proof[genericVector.proof.length - 1][0] ^= bytes1(uint8(1));
        assertFalse(harness.verify(genericVector.root, genericVector.key, genericVector.proof, genericVector.value));
        assertFalse(harness.verifyAbsence(genericVector.root, genericVector.key, genericVector.proof));

        PinnedMPTProofCorpus.StorageVector memory storageVector = corpus.storageAt(0);
        checkpointClient.trust(storageVector.sourceChainId, storageVector.checkpointHeight, storageVector.stateRoot);
        storageVector.storageProof[storageVector.storageProof.length - 1][0] ^= bytes1(uint8(1));
        assertFalse(storageVerifier.verifyStorageMembership(_storageProof(storageVector)));
        assertFalse(storageVerifier.verifyStorageAbsence(_storageProof(storageVector)));
    }

    function _storageProof(PinnedMPTProofCorpus.StorageVector memory vector)
        private
        pure
        returns (EVMProofTypes.StorageProof memory)
    {
        return EVMProofTypes.StorageProof({
            sourceChainId: vector.sourceChainId,
            checkpointHeight: vector.checkpointHeight,
            stateRoot: vector.stateRoot,
            account: vector.account,
            storageKey: vector.storageKey,
            expectedValue: vector.expectedValue,
            accountProof: vector.accountProof,
            storageProof: vector.storageProof
        });
    }
}
