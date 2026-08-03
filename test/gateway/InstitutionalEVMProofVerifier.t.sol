// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {EVMProofTypes} from "../../contracts/gateway/EVMProofTypes.sol";
import {IInstitutionalCheckpointClient} from "../../contracts/gateway/IInstitutionalCheckpointClient.sol";
import {InstitutionalCheckpointTypes} from "../../contracts/gateway/InstitutionalCheckpointTypes.sol";
import {InstitutionalEVMProofVerifier} from "../../contracts/gateway/InstitutionalEVMProofVerifier.sol";
import {StorageProofBuilder} from "../../contracts/test/StorageProofBuilder.sol";

contract MockInstitutionalCheckpointClient is IInstitutionalCheckpointClient {
    mapping(uint256 => mapping(uint256 => bytes32)) internal roots;
    mapping(uint256 => InstitutionalCheckpointTypes.ClientStatus) internal statuses;
    mapping(uint256 => uint256) public override checkpointAuthorizationFloor;

    function setCheckpoint(uint256 sourceChainId, uint256 height, bytes32 root) external {
        roots[sourceChainId][height] = root;
        statuses[sourceChainId] = InstitutionalCheckpointTypes.ClientStatus.Active;
    }

    function setStatus(uint256 sourceChainId, InstitutionalCheckpointTypes.ClientStatus status_) external {
        statuses[sourceChainId] = status_;
    }

    function status(uint256 sourceChainId) external view returns (InstitutionalCheckpointTypes.ClientStatus) {
        return statuses[sourceChainId];
    }

    function latestTrustedHeight(uint256) external pure returns (uint256) {
        return 0;
    }

    function trustedStateRoot(uint256 sourceChainId, uint256 blockNumber) external view returns (bytes32) {
        return roots[sourceChainId][blockNumber];
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

contract InstitutionalEVMProofVerifierTest is Test {
    uint256 internal constant SOURCE_CHAIN_ID = 41001;
    uint256 internal constant CHECKPOINT_HEIGHT = 100;
    address internal constant SOURCE_GATEWAY = address(0xA11CE);
    bytes32 internal constant STORAGE_KEY = keccak256("institutional.gateway.message.1");
    bytes32 internal constant STORAGE_WORD = keccak256("message-commitment");

    MockInstitutionalCheckpointClient internal client;
    InstitutionalEVMProofVerifier internal verifier;
    StorageProofBuilder internal builder;

    function setUp() public {
        client = new MockInstitutionalCheckpointClient();
        verifier = new InstitutionalEVMProofVerifier(address(client));
        builder = new StorageProofBuilder();
    }

    function testVerifiesMembershipUnderCheckpointedRoot() public {
        (EVMProofTypes.StorageProof memory proof, bytes32 root) = _proof(STORAGE_WORD);
        client.setCheckpoint(SOURCE_CHAIN_ID, CHECKPOINT_HEIGHT, root);

        assertTrue(verifier.verifyStorageMembership(proof));
    }

    function testVerifiesStorageAbsenceUnderCheckpointedRoot() public {
        (EVMProofTypes.StorageProof memory proof, bytes32 root) = _proof(STORAGE_WORD);
        client.setCheckpoint(SOURCE_CHAIN_ID, CHECKPOINT_HEIGHT, root);

        // The supplied leaf proves a different hashed slot under the same authenticated
        // storage root, which is the canonical divergent-leaf absence witness.
        proof.storageKey = keccak256("institutional.gateway.absent-message");
        proof.expectedValue = "";

        assertTrue(verifier.verifyStorageAbsence(proof));
        assertFalse(verifier.verifyStorageMembership(proof));
    }

    function testRejectsUncheckpointedOrMismatchedRoot() public {
        (EVMProofTypes.StorageProof memory proof,) = _proof(STORAGE_WORD);
        assertFalse(verifier.verifyStorageMembership(proof));

        client.setCheckpoint(SOURCE_CHAIN_ID, CHECKPOINT_HEIGHT, keccak256("different-root"));
        assertFalse(verifier.verifyStorageMembership(proof));
    }

    function testRejectsProofWhenClientFrozen() public {
        (EVMProofTypes.StorageProof memory proof, bytes32 root) = _proof(STORAGE_WORD);
        client.setCheckpoint(SOURCE_CHAIN_ID, CHECKPOINT_HEIGHT, root);
        client.setStatus(SOURCE_CHAIN_ID, InstitutionalCheckpointTypes.ClientStatus.Frozen);

        assertFalse(verifier.verifyStorageMembership(proof));
    }

    function testRejectsWrongStorageValue() public {
        (EVMProofTypes.StorageProof memory proof, bytes32 root) = _proof(STORAGE_WORD);
        client.setCheckpoint(SOURCE_CHAIN_ID, CHECKPOINT_HEIGHT, root);
        proof.expectedValue = EVMProofTypes.rlpEncodeWord(keccak256("forged-message"));

        assertFalse(verifier.verifyStorageMembership(proof));
    }

    function testRejectsWrongAccountAndEmptyProofs() public {
        (EVMProofTypes.StorageProof memory proof, bytes32 root) = _proof(STORAGE_WORD);
        client.setCheckpoint(SOURCE_CHAIN_ID, CHECKPOINT_HEIGHT, root);

        proof.account = address(0);
        assertFalse(verifier.verifyStorageMembership(proof));

        (proof,) = _proof(STORAGE_WORD);
        proof.accountProof = new bytes[](0);
        assertFalse(verifier.verifyStorageMembership(proof));
    }

    function _proof(bytes32 storageWord)
        internal
        view
        returns (EVMProofTypes.StorageProof memory proof, bytes32 stateRoot)
    {
        StorageProofBuilder.BuiltSingleStorageProof memory built =
            builder.buildSingleStorageProof(SOURCE_GATEWAY, STORAGE_KEY, storageWord);
        stateRoot = built.stateRoot;
        proof = EVMProofTypes.StorageProof({
            sourceChainId: SOURCE_CHAIN_ID,
            checkpointHeight: CHECKPOINT_HEIGHT,
            stateRoot: built.stateRoot,
            account: SOURCE_GATEWAY,
            storageKey: STORAGE_KEY,
            expectedValue: built.expectedTrieValue,
            accountProof: built.accountProof,
            storageProof: built.storageProof
        });
    }
}
