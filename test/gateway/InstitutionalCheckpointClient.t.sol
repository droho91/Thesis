// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {InstitutionalCheckpointClient} from "../../contracts/gateway/InstitutionalCheckpointClient.sol";
import {InstitutionalCheckpointTypes} from "../../contracts/gateway/InstitutionalCheckpointTypes.sol";

contract InstitutionalCheckpointClientTest is Test {
    uint256 internal constant SOURCE_CHAIN_ID = 41001;
    uint256 internal constant DESTINATION_CHAIN_ID = 41002;
    uint256 internal constant TRUSTING_PERIOD = 7 days;
    uint256 internal constant MAX_CLOCK_DRIFT = 30 seconds;

    InstitutionalCheckpointClient internal client;
    uint256[] internal attestorKeys;
    address[] internal attestors;

    function setUp() public {
        vm.chainId(DESTINATION_CHAIN_ID);
        vm.warp(1_800_000_000);
        client = new InstitutionalCheckpointClient(address(this), TRUSTING_PERIOD, MAX_CLOCK_DRIFT);
        _setSortedAttestors(_keys(101, 102, 103, 104));
        client.configureSource(SOURCE_CHAIN_ID, attestors, 3);
    }

    function testAcceptsSkippedCheckpointWithThreeOfFourQuorum() public {
        InstitutionalCheckpointTypes.Checkpoint memory checkpoint = _checkpoint(100, 1, "block-100", "root-100");

        bytes32 digest = client.submitCheckpoint(checkpoint, _sign(checkpoint, attestorKeys, 3));

        assertEq(digest, client.checkpointDigest(checkpoint));
        assertEq(client.latestTrustedHeight(SOURCE_CHAIN_ID), 100);
        assertEq(client.trustedStateRoot(SOURCE_CHAIN_ID, 100), checkpoint.stateRoot);
        assertEq(client.trustedTimestamp(SOURCE_CHAIN_ID, 100), checkpoint.timestamp);
    }

    function testRejectsInsufficientQuorum() public {
        InstitutionalCheckpointTypes.Checkpoint memory checkpoint = _checkpoint(100, 1, "block-100", "root-100");
        bytes[] memory signatures = _sign(checkpoint, attestorKeys, 2);

        vm.expectRevert(bytes("ATTESTOR_QUORUM_NOT_MET"));
        client.submitCheckpoint(checkpoint, signatures);
    }

    function testRejectsUnknownSigner() public {
        InstitutionalCheckpointTypes.Checkpoint memory checkpoint = _checkpoint(100, 1, "block-100", "root-100");
        uint256[] memory keys = _keys(attestorKeys[0], attestorKeys[1], 999, 0);
        _sortKeys(keys, 3);
        bytes[] memory signatures = _sign(checkpoint, keys, 3);

        vm.expectRevert(bytes("SIGNER_NOT_ATTESTOR"));
        client.submitCheckpoint(checkpoint, signatures);
    }

    function testRejectsDuplicateSigner() public {
        InstitutionalCheckpointTypes.Checkpoint memory checkpoint = _checkpoint(100, 1, "block-100", "root-100");
        bytes memory signature = _signature(attestorKeys[0], client.checkpointDigest(checkpoint));
        bytes[] memory signatures = new bytes[](3);
        signatures[0] = signature;
        signatures[1] = signature;
        signatures[2] = _signature(attestorKeys[1], client.checkpointDigest(checkpoint));

        vm.expectRevert(bytes("SIGNERS_NOT_STRICTLY_ORDERED"));
        client.submitCheckpoint(checkpoint, signatures);
    }

    function testRejectsReplayOfTrustedCheckpoint() public {
        InstitutionalCheckpointTypes.Checkpoint memory checkpoint = _checkpoint(100, 1, "block-100", "root-100");
        bytes[] memory signatures = _sign(checkpoint, attestorKeys, 3);
        client.submitCheckpoint(checkpoint, signatures);

        vm.expectRevert(bytes("CHECKPOINT_ALREADY_TRUSTED"));
        client.submitCheckpoint(checkpoint, signatures);
    }

    function testConflictingQuorumCheckpointFreezesClient() public {
        InstitutionalCheckpointTypes.Checkpoint memory trusted = _checkpoint(100, 1, "block-100", "root-100");
        InstitutionalCheckpointTypes.Checkpoint memory conflict = _checkpoint(100, 1, "block-100b", "root-100b");
        client.submitCheckpoint(trusted, _sign(trusted, attestorKeys, 3));

        client.submitCheckpoint(conflict, _sign(conflict, attestorKeys, 3));

        assertEq(
            uint256(client.status(SOURCE_CHAIN_ID)),
            uint256(InstitutionalCheckpointTypes.ClientStatus.Frozen)
        );
        (uint256 blockNumber, bytes32 trustedDigest, bytes32 conflictingDigest, uint256 detectedAt) =
            client.conflictEvidence(SOURCE_CHAIN_ID);
        assertEq(blockNumber, 100);
        assertEq(trustedDigest, client.checkpointDigest(trusted));
        assertEq(conflictingDigest, client.checkpointDigest(conflict));
        assertGt(detectedAt, 0);
    }

    function testRejectsCheckpointWhileFrozen() public {
        client.freezeSource(SOURCE_CHAIN_ID, keccak256("incident"));
        InstitutionalCheckpointTypes.Checkpoint memory checkpoint = _checkpoint(100, 1, "block-100", "root-100");
        bytes[] memory signatures = _sign(checkpoint, attestorKeys, 3);

        vm.expectRevert(bytes("CLIENT_NOT_ACTIVE"));
        client.submitCheckpoint(checkpoint, signatures);
    }

    function testRejectsExpiredAndFutureCheckpoint() public {
        InstitutionalCheckpointTypes.Checkpoint memory expired = _checkpoint(100, 1, "block-100", "root-100");
        expired.timestamp = block.timestamp - TRUSTING_PERIOD - 1;
        bytes[] memory expiredSignatures = _sign(expired, attestorKeys, 3);
        vm.expectRevert(bytes("CHECKPOINT_EXPIRED"));
        client.submitCheckpoint(expired, expiredSignatures);

        InstitutionalCheckpointTypes.Checkpoint memory future = _checkpoint(100, 1, "block-100", "root-100");
        future.timestamp = block.timestamp + MAX_CLOCK_DRIFT + 1;
        bytes[] memory futureSignatures = _sign(future, attestorKeys, 3);
        vm.expectRevert(bytes("CHECKPOINT_FROM_FUTURE"));
        client.submitCheckpoint(future, futureSignatures);
    }

    function testRotationSupportsOldSetBeforeActivationAndNewSetAtActivation() public {
        InstitutionalCheckpointTypes.Checkpoint memory first = _checkpoint(100, 1, "block-100", "root-100");
        client.submitCheckpoint(first, _sign(first, attestorKeys, 3));

        uint256[] memory nextKeys = _keys(201, 202, 203, 204);
        (uint256[] memory sortedNextKeys, address[] memory nextAttestors) = _sorted(nextKeys, 4);
        client.rotateAttestors(SOURCE_CHAIN_ID, nextAttestors, 3, 150);

        InstitutionalCheckpointTypes.Checkpoint memory beforeActivation =
            _checkpoint(120, 1, "block-120", "root-120");
        client.submitCheckpoint(beforeActivation, _sign(beforeActivation, attestorKeys, 3));

        InstitutionalCheckpointTypes.Checkpoint memory atActivation =
            _checkpoint(150, 2, "block-150", "root-150");
        client.submitCheckpoint(atActivation, _sign(atActivation, sortedNextKeys, 3));

        assertEq(client.latestTrustedHeight(SOURCE_CHAIN_ID), 150);
        assertEq(client.trustedStateRoot(SOURCE_CHAIN_ID, 150), atActivation.stateRoot);
    }

    function testRejectsOldEpochAfterRotationActivation() public {
        InstitutionalCheckpointTypes.Checkpoint memory first = _checkpoint(100, 1, "block-100", "root-100");
        client.submitCheckpoint(first, _sign(first, attestorKeys, 3));
        (uint256[] memory nextKeys, address[] memory nextAttestors) = _sorted(_keys(201, 202, 203, 204), 4);
        client.rotateAttestors(SOURCE_CHAIN_ID, nextAttestors, 3, 150);

        InstitutionalCheckpointTypes.Checkpoint memory activated = _checkpoint(150, 2, "block-150", "root-150");
        client.submitCheckpoint(activated, _sign(activated, nextKeys, 3));
        InstitutionalCheckpointTypes.Checkpoint memory oldEpoch = _checkpoint(151, 1, "block-151", "root-151");
        bytes[] memory oldEpochSignatures = _sign(oldEpoch, attestorKeys, 3);

        vm.expectRevert(bytes("ATTESTOR_EPOCH_NOT_VALID"));
        client.submitCheckpoint(oldEpoch, oldEpochSignatures);
    }

    function testGovernanceRecoveryInstallsNewSetAndTrustedRoot() public {
        InstitutionalCheckpointTypes.Checkpoint memory trusted = _checkpoint(100, 1, "block-100", "root-100");
        InstitutionalCheckpointTypes.Checkpoint memory conflict = _checkpoint(100, 1, "block-100b", "root-100b");
        client.submitCheckpoint(trusted, _sign(trusted, attestorKeys, 3));
        client.submitCheckpoint(conflict, _sign(conflict, attestorKeys, 3));

        (, address[] memory recoveryAttestors) = _sorted(_keys(301, 302, 303, 304), 4);
        InstitutionalCheckpointTypes.Checkpoint memory recovery = _checkpoint(200, 2, "block-200", "root-200");
        client.recoverSource(recovery, recoveryAttestors, 3);

        assertEq(
            uint256(client.status(SOURCE_CHAIN_ID)),
            uint256(InstitutionalCheckpointTypes.ClientStatus.Active)
        );
        assertEq(client.latestTrustedHeight(SOURCE_CHAIN_ID), 200);
        assertEq(client.trustedStateRoot(SOURCE_CHAIN_ID, 200), recovery.stateRoot);
        assertEq(client.currentAttestorEpoch(SOURCE_CHAIN_ID), 2);
    }

    function testConfigurationRequiresBftSupermajorityAndSortedUniqueAttestors() public {
        InstitutionalCheckpointClient another =
            new InstitutionalCheckpointClient(address(this), TRUSTING_PERIOD, MAX_CLOCK_DRIFT);

        vm.expectRevert(bytes("BAD_THRESHOLD"));
        another.configureSource(SOURCE_CHAIN_ID, attestors, 2);

        address[] memory unsorted = new address[](4);
        unsorted[0] = attestors[1];
        unsorted[1] = attestors[0];
        unsorted[2] = attestors[2];
        unsorted[3] = attestors[3];
        vm.expectRevert(bytes("ATTESTORS_NOT_STRICTLY_ORDERED"));
        another.configureSource(SOURCE_CHAIN_ID, unsorted, 3);

        (, address[] memory threeAttestors) = _sorted(_keys(201, 202, 203, 0), 3);
        vm.expectRevert(bytes("ATTESTOR_SET_TOO_SMALL"));
        another.configureSource(SOURCE_CHAIN_ID, threeAttestors, 3);
    }

    function testRejectsCheckpointTimestampRegression() public {
        InstitutionalCheckpointTypes.Checkpoint memory first = _checkpoint(100, 1, "block-100", "root-100");
        client.submitCheckpoint(first, _sign(first, attestorKeys, 3));

        InstitutionalCheckpointTypes.Checkpoint memory regressed = _checkpoint(120, 1, "block-120", "root-120");
        regressed.timestamp = first.timestamp - 1;
        bytes[] memory signatures = _sign(regressed, attestorKeys, 3);

        vm.expectRevert(bytes("CHECKPOINT_TIME_REGRESSION"));
        client.submitCheckpoint(regressed, signatures);
    }

    function _checkpoint(uint256 blockNumber, uint64 epoch, string memory blockLabel, string memory rootLabel)
        internal
        view
        returns (InstitutionalCheckpointTypes.Checkpoint memory)
    {
        return InstitutionalCheckpointTypes.Checkpoint({
            sourceChainId: SOURCE_CHAIN_ID,
            blockNumber: blockNumber,
            blockHash: keccak256(bytes(blockLabel)),
            stateRoot: keccak256(bytes(rootLabel)),
            timestamp: block.timestamp,
            attestorEpoch: epoch
        });
    }

    function _sign(
        InstitutionalCheckpointTypes.Checkpoint memory checkpoint,
        uint256[] memory keys,
        uint256 count
    ) internal view returns (bytes[] memory signatures) {
        bytes32 digest = client.checkpointDigest(checkpoint);
        signatures = new bytes[](count);
        for (uint256 i = 0; i < count; i++) {
            signatures[i] = _signature(keys[i], digest);
        }
    }

    function _signature(uint256 privateKey, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _setSortedAttestors(uint256[] memory keys) internal {
        (uint256[] memory sortedKeys, address[] memory sortedAttestors) = _sorted(keys, keys.length);
        for (uint256 i = 0; i < sortedKeys.length; i++) {
            attestorKeys.push(sortedKeys[i]);
            attestors.push(sortedAttestors[i]);
        }
    }

    function _sorted(uint256[] memory keys, uint256 count)
        internal
        pure
        returns (uint256[] memory sortedKeys, address[] memory sortedAttestors)
    {
        sortedKeys = new uint256[](count);
        for (uint256 i = 0; i < count; i++) sortedKeys[i] = keys[i];
        _sortKeys(sortedKeys, count);
        sortedAttestors = new address[](count);
        for (uint256 i = 0; i < count; i++) sortedAttestors[i] = vm.addr(sortedKeys[i]);
    }

    function _sortKeys(uint256[] memory keys, uint256 count) internal pure returns (uint256[] memory) {
        for (uint256 i = 0; i < count; i++) {
            for (uint256 j = i + 1; j < count; j++) {
                if (vm.addr(keys[j]) < vm.addr(keys[i])) {
                    (keys[i], keys[j]) = (keys[j], keys[i]);
                }
            }
        }
        return keys;
    }

    function _keys(uint256 a, uint256 b, uint256 c, uint256 d) internal pure returns (uint256[] memory keys) {
        uint256 length = d == 0 ? 3 : 4;
        keys = new uint256[](length);
        keys[0] = a;
        keys[1] = b;
        keys[2] = c;
        if (length == 4) keys[3] = d;
    }
}
