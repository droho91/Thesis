// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IInstitutionalCheckpointClient} from "./IInstitutionalCheckpointClient.sol";
import {InstitutionalCheckpointTypes} from "./InstitutionalCheckpointTypes.sol";

/// @title InstitutionalCheckpointClient
/// @notice Trusts source-chain state roots only after an institutional attestor quorum signs them.
/// @dev The EIP-712 domain binds signatures to this destination chain and client contract. Relayers are
///      permissionless: they transport signatures but cannot create a trusted root without quorum.
contract InstitutionalCheckpointClient is AccessControl, EIP712, IInstitutionalCheckpointClient {
    bytes32 public constant CHECKPOINT_ADMIN_ROLE = keccak256("CHECKPOINT_ADMIN_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant CHECKPOINT_TYPEHASH = keccak256(
        "InstitutionalCheckpoint(uint256 sourceChainId,uint256 blockNumber,bytes32 blockHash,bytes32 stateRoot,uint256 timestamp,uint64 attestorEpoch)"
    );

    struct AttestorSet {
        uint64 threshold;
        uint256 activationHeight;
        address[] attestors;
        bool exists;
    }

    /// @notice Maximum age of a checkpoint at submission time.
    /// @dev An accepted checkpoint does not expire automatically; incident recovery advances the
    ///      authorization floor when historical roots must stop authorizing proofs.
    uint256 public immutable maxCheckpointSubmissionAge;
    uint256 public immutable maxClockDrift;

    mapping(uint256 => InstitutionalCheckpointTypes.ClientStatus) private clientStatuses;
    mapping(uint256 => uint256) public override latestTrustedHeight;
    mapping(uint256 => uint256) public override checkpointAuthorizationFloor;
    mapping(uint256 => uint64) public currentAttestorEpoch;
    mapping(uint256 => mapping(uint64 => AttestorSet)) private attestorSets;
    mapping(uint256 => mapping(uint64 => mapping(address => bool))) public isAttestor;
    mapping(uint256 => mapping(uint256 => InstitutionalCheckpointTypes.TrustedCheckpoint)) private checkpoints;
    mapping(uint256 => InstitutionalCheckpointTypes.ConflictEvidence) public conflictEvidence;

    event SourceConfigured(uint256 indexed sourceChainId, uint64 indexed attestorEpoch, uint64 threshold);
    event AttestorSetRotated(
        uint256 indexed sourceChainId,
        uint64 indexed attestorEpoch,
        uint64 threshold,
        uint256 activationHeight
    );
    event CheckpointAccepted(
        uint256 indexed sourceChainId,
        uint256 indexed blockNumber,
        bytes32 blockHash,
        bytes32 stateRoot,
        uint64 attestorEpoch,
        bytes32 checkpointDigest
    );
    event ClientFrozen(
        uint256 indexed sourceChainId,
        uint256 indexed blockNumber,
        bytes32 trustedDigest,
        bytes32 conflictingDigest
    );
    event ClientRecovered(
        uint256 indexed sourceChainId,
        uint256 indexed blockNumber,
        uint64 indexed attestorEpoch,
        bytes32 stateRoot
    );

    constructor(address admin, uint256 maxCheckpointSubmissionAge_, uint256 maxClockDrift_)
        EIP712("InstitutionalCheckpointClient", "1")
    {
        require(admin != address(0), "ADMIN_ZERO");
        require(maxCheckpointSubmissionAge_ > 0, "MAX_SUBMISSION_AGE_ZERO");
        maxCheckpointSubmissionAge = maxCheckpointSubmissionAge_;
        maxClockDrift = maxClockDrift_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CHECKPOINT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, admin);
    }

    function status(uint256 sourceChainId)
        external
        view
        override
        returns (InstitutionalCheckpointTypes.ClientStatus)
    {
        return clientStatuses[sourceChainId];
    }

    function configureSource(uint256 sourceChainId, address[] calldata attestors, uint64 threshold)
        external
        onlyRole(CHECKPOINT_ADMIN_ROLE)
    {
        require(sourceChainId != 0 && sourceChainId != block.chainid, "BAD_SOURCE_CHAIN");
        require(
            clientStatuses[sourceChainId] == InstitutionalCheckpointTypes.ClientStatus.Uninitialized,
            "SOURCE_ALREADY_CONFIGURED"
        );

        _installAttestorSet(sourceChainId, 1, 0, attestors, threshold);
        currentAttestorEpoch[sourceChainId] = 1;
        clientStatuses[sourceChainId] = InstitutionalCheckpointTypes.ClientStatus.Active;
        emit SourceConfigured(sourceChainId, 1, threshold);
    }

    function rotateAttestors(
        uint256 sourceChainId,
        address[] calldata attestors,
        uint64 threshold,
        uint256 activationHeight
    ) external onlyRole(CHECKPOINT_ADMIN_ROLE) {
        require(clientStatuses[sourceChainId] == InstitutionalCheckpointTypes.ClientStatus.Active, "CLIENT_NOT_ACTIVE");
        uint64 currentEpoch = currentAttestorEpoch[sourceChainId];
        AttestorSet storage currentSet = attestorSets[sourceChainId][currentEpoch];
        require(latestTrustedHeight[sourceChainId] >= currentSet.activationHeight, "ROTATION_ALREADY_PENDING");
        require(activationHeight > latestTrustedHeight[sourceChainId], "ACTIVATION_NOT_FORWARD");

        uint64 nextEpoch = currentEpoch + 1;
        _installAttestorSet(sourceChainId, nextEpoch, activationHeight, attestors, threshold);
        currentAttestorEpoch[sourceChainId] = nextEpoch;
        emit AttestorSetRotated(sourceChainId, nextEpoch, threshold, activationHeight);
    }

    function submitCheckpoint(
        InstitutionalCheckpointTypes.Checkpoint calldata checkpoint,
        bytes[] calldata signatures
    ) external returns (bytes32 digest) {
        uint256 sourceChainId = checkpoint.sourceChainId;
        require(clientStatuses[sourceChainId] == InstitutionalCheckpointTypes.ClientStatus.Active, "CLIENT_NOT_ACTIVE");
        _validateCheckpointEnvelope(checkpoint);

        AttestorSet storage set = _attestorSetForCheckpoint(checkpoint);
        digest = checkpointDigest(checkpoint);
        _requireQuorum(sourceChainId, checkpoint.attestorEpoch, set, digest, signatures);

        InstitutionalCheckpointTypes.TrustedCheckpoint storage existing =
            checkpoints[sourceChainId][checkpoint.blockNumber];
        if (existing.exists) {
            bytes32 trustedDigest = _trustedCheckpointDigest(sourceChainId, checkpoint.blockNumber, existing);
            require(trustedDigest != digest, "CHECKPOINT_ALREADY_TRUSTED");
            _freeze(sourceChainId, checkpoint.blockNumber, trustedDigest, digest);
            return digest;
        }

        require(checkpoint.blockNumber > latestTrustedHeight[sourceChainId], "CHECKPOINT_NOT_FORWARD");
        _requireMonotonicTimestamp(sourceChainId, checkpoint.timestamp);
        _storeCheckpoint(checkpoint);
        emit CheckpointAccepted(
            sourceChainId,
            checkpoint.blockNumber,
            checkpoint.blockHash,
            checkpoint.stateRoot,
            checkpoint.attestorEpoch,
            digest
        );
    }

    function freezeSource(uint256 sourceChainId, bytes32 reason) external onlyRole(GUARDIAN_ROLE) {
        require(clientStatuses[sourceChainId] == InstitutionalCheckpointTypes.ClientStatus.Active, "CLIENT_NOT_ACTIVE");
        _freeze(sourceChainId, latestTrustedHeight[sourceChainId], bytes32(0), reason);
    }

    /// @notice Governance recovery is an explicit institutional trust action after incident review.
    function recoverSource(
        InstitutionalCheckpointTypes.Checkpoint calldata recoveryCheckpoint,
        address[] calldata attestors,
        uint64 threshold
    ) external onlyRole(CHECKPOINT_ADMIN_ROLE) {
        uint256 sourceChainId = recoveryCheckpoint.sourceChainId;
        require(clientStatuses[sourceChainId] == InstitutionalCheckpointTypes.ClientStatus.Frozen, "CLIENT_NOT_FROZEN");
        require(recoveryCheckpoint.blockNumber > latestTrustedHeight[sourceChainId], "RECOVERY_NOT_FORWARD");
        _validateCheckpointEnvelope(recoveryCheckpoint);
        _requireMonotonicTimestamp(sourceChainId, recoveryCheckpoint.timestamp);

        uint64 nextEpoch = currentAttestorEpoch[sourceChainId] + 1;
        require(recoveryCheckpoint.attestorEpoch == nextEpoch, "RECOVERY_EPOCH_MISMATCH");
        _installAttestorSet(sourceChainId, nextEpoch, recoveryCheckpoint.blockNumber, attestors, threshold);
        currentAttestorEpoch[sourceChainId] = nextEpoch;
        _storeCheckpoint(recoveryCheckpoint);
        checkpointAuthorizationFloor[sourceChainId] = recoveryCheckpoint.blockNumber;
        delete conflictEvidence[sourceChainId];
        clientStatuses[sourceChainId] = InstitutionalCheckpointTypes.ClientStatus.Active;
        emit ClientRecovered(sourceChainId, recoveryCheckpoint.blockNumber, nextEpoch, recoveryCheckpoint.stateRoot);
    }

    function checkpointDigest(InstitutionalCheckpointTypes.Checkpoint calldata checkpoint)
        public
        view
        override
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    CHECKPOINT_TYPEHASH,
                    checkpoint.sourceChainId,
                    checkpoint.blockNumber,
                    checkpoint.blockHash,
                    checkpoint.stateRoot,
                    checkpoint.timestamp,
                    checkpoint.attestorEpoch
                )
            )
        );
    }

    function trustedStateRoot(uint256 sourceChainId, uint256 blockNumber)
        external
        view
        override
        returns (bytes32)
    {
        return checkpoints[sourceChainId][blockNumber].stateRoot;
    }

    function trustedTimestamp(uint256 sourceChainId, uint256 blockNumber)
        external
        view
        override
        returns (uint256)
    {
        return checkpoints[sourceChainId][blockNumber].timestamp;
    }

    function trustedCheckpoint(uint256 sourceChainId, uint256 blockNumber)
        external
        view
        returns (InstitutionalCheckpointTypes.TrustedCheckpoint memory)
    {
        return checkpoints[sourceChainId][blockNumber];
    }

    function attestorSet(uint256 sourceChainId, uint64 epoch)
        external
        view
        returns (uint64 threshold, uint256 activationHeight, address[] memory attestors, bool exists)
    {
        AttestorSet storage set = attestorSets[sourceChainId][epoch];
        return (set.threshold, set.activationHeight, set.attestors, set.exists);
    }

    function _validateCheckpointEnvelope(InstitutionalCheckpointTypes.Checkpoint calldata checkpoint) internal view {
        require(checkpoint.sourceChainId != 0 && checkpoint.sourceChainId != block.chainid, "BAD_SOURCE_CHAIN");
        require(checkpoint.blockNumber > 0, "BLOCK_NUMBER_ZERO");
        require(checkpoint.blockHash != bytes32(0), "BLOCK_HASH_ZERO");
        require(checkpoint.stateRoot != bytes32(0), "STATE_ROOT_ZERO");
        require(checkpoint.timestamp > 0, "TIMESTAMP_ZERO");
        require(checkpoint.timestamp <= block.timestamp + maxClockDrift, "CHECKPOINT_FROM_FUTURE");
        require(
            block.timestamp <= checkpoint.timestamp + maxCheckpointSubmissionAge,
            "CHECKPOINT_SUBMISSION_TOO_OLD"
        );
    }

    function _attestorSetForCheckpoint(InstitutionalCheckpointTypes.Checkpoint calldata checkpoint)
        internal
        view
        returns (AttestorSet storage set)
    {
        uint64 currentEpoch = currentAttestorEpoch[checkpoint.sourceChainId];
        if (checkpoint.attestorEpoch == currentEpoch) {
            set = attestorSets[checkpoint.sourceChainId][currentEpoch];
            require(checkpoint.blockNumber >= set.activationHeight, "ATTESTOR_EPOCH_NOT_ACTIVE");
            return set;
        }

        if (checkpoint.attestorEpoch + 1 == currentEpoch) {
            AttestorSet storage nextSet = attestorSets[checkpoint.sourceChainId][currentEpoch];
            require(checkpoint.blockNumber < nextSet.activationHeight, "ATTESTOR_EPOCH_NOT_VALID");
            set = attestorSets[checkpoint.sourceChainId][checkpoint.attestorEpoch];
            require(set.exists, "ATTESTOR_SET_MISSING");
            return set;
        }

        revert("ATTESTOR_EPOCH_NOT_VALID");
    }

    function _requireQuorum(
        uint256 sourceChainId,
        uint64 epoch,
        AttestorSet storage set,
        bytes32 digest,
        bytes[] calldata signatures
    ) internal view {
        require(signatures.length >= set.threshold, "ATTESTOR_QUORUM_NOT_MET");
        address previousSigner;
        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = ECDSA.recover(digest, signatures[i]);
            require(signer > previousSigner, "SIGNERS_NOT_STRICTLY_ORDERED");
            require(isAttestor[sourceChainId][epoch][signer], "SIGNER_NOT_ATTESTOR");
            previousSigner = signer;
        }
    }

    function _installAttestorSet(
        uint256 sourceChainId,
        uint64 epoch,
        uint256 activationHeight,
        address[] calldata attestors,
        uint64 threshold
    ) internal {
        require(attestors.length >= 4, "ATTESTOR_SET_TOO_SMALL");
        require(
            uint256(threshold) * 3 > attestors.length * 2 && threshold <= attestors.length,
            "BAD_THRESHOLD"
        );
        require(!attestorSets[sourceChainId][epoch].exists, "ATTESTOR_SET_EXISTS");

        AttestorSet storage set = attestorSets[sourceChainId][epoch];
        set.threshold = threshold;
        set.activationHeight = activationHeight;
        set.exists = true;
        address previousAttestor;
        for (uint256 i = 0; i < attestors.length; i++) {
            address attestor = attestors[i];
            require(attestor != address(0), "ATTESTOR_ZERO");
            require(attestor > previousAttestor, "ATTESTORS_NOT_STRICTLY_ORDERED");
            set.attestors.push(attestor);
            isAttestor[sourceChainId][epoch][attestor] = true;
            previousAttestor = attestor;
        }
    }

    function _storeCheckpoint(InstitutionalCheckpointTypes.Checkpoint calldata checkpoint) internal {
        checkpoints[checkpoint.sourceChainId][checkpoint.blockNumber] = InstitutionalCheckpointTypes.TrustedCheckpoint({
            blockHash: checkpoint.blockHash,
            stateRoot: checkpoint.stateRoot,
            timestamp: checkpoint.timestamp,
            attestorEpoch: checkpoint.attestorEpoch,
            exists: true
        });
        latestTrustedHeight[checkpoint.sourceChainId] = checkpoint.blockNumber;
    }

    function _requireMonotonicTimestamp(uint256 sourceChainId, uint256 timestamp) internal view {
        uint256 latestHeight = latestTrustedHeight[sourceChainId];
        if (latestHeight == 0) return;
        require(timestamp >= checkpoints[sourceChainId][latestHeight].timestamp, "CHECKPOINT_TIME_REGRESSION");
    }

    function _trustedCheckpointDigest(
        uint256 sourceChainId,
        uint256 blockNumber,
        InstitutionalCheckpointTypes.TrustedCheckpoint storage checkpoint
    ) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    CHECKPOINT_TYPEHASH,
                    sourceChainId,
                    blockNumber,
                    checkpoint.blockHash,
                    checkpoint.stateRoot,
                    checkpoint.timestamp,
                    checkpoint.attestorEpoch
                )
            )
        );
    }

    function _freeze(uint256 sourceChainId, uint256 blockNumber, bytes32 trustedDigest, bytes32 conflictingDigest)
        internal
    {
        clientStatuses[sourceChainId] = InstitutionalCheckpointTypes.ClientStatus.Frozen;
        conflictEvidence[sourceChainId] = InstitutionalCheckpointTypes.ConflictEvidence({
            blockNumber: blockNumber,
            trustedDigest: trustedDigest,
            conflictingDigest: conflictingDigest,
            detectedAt: block.timestamp
        });
        emit ClientFrozen(sourceChainId, blockNumber, trustedDigest, conflictingDigest);
    }
}
