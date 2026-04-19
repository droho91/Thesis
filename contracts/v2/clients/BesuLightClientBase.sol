// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {BesuLightClientTypes} from "./BesuLightClientTypes.sol";
import {BesuQBFTExtraDataLib} from "./BesuQBFTExtraDataLib.sol";
import {BesuBlockHeaderLib} from "./BesuBlockHeaderLib.sol";
import {IBesuLightClient} from "./IBesuLightClient.sol";

/// @title BesuLightClientBase
/// @notice v2 foundation for a native Besu/QBFT light client.
/// @dev This base intentionally centers raw header material and parsed QBFT extra-data. The finality
///      verification hook is left abstract so the rebuild can add commit-seal verification without
///      inheriting assumptions from the legacy bespoke checkpoint client.
abstract contract BesuLightClientBase is AccessControl, IBesuLightClient {
    bytes32 public constant CLIENT_ADMIN_ROLE = keccak256("CLIENT_ADMIN_ROLE");

    mapping(uint256 => BesuLightClientTypes.ClientStatus) internal clientStatuses;
    mapping(uint256 => mapping(uint256 => BesuLightClientTypes.TrustedHeader)) internal trustedHeaders;
    mapping(uint256 => mapping(uint256 => BesuLightClientTypes.ValidatorSet)) internal validatorSets;
    mapping(uint256 => uint256) public latestTrustedHeight;
    mapping(uint256 => uint256) public latestValidatorEpoch;
    mapping(uint256 => BesuLightClientTypes.MisbehaviourEvidence) public frozenEvidence;

    event TrustAnchorInitialized(
        uint256 indexed sourceChainId,
        uint256 indexed height,
        bytes32 headerHash,
        uint256 validatorEpoch,
        bytes32 validatorsHash
    );
    event TrustedHeaderAccepted(
        uint256 indexed sourceChainId,
        uint256 indexed height,
        bytes32 headerHash,
        bytes32 parentHash,
        bytes32 stateRoot,
        uint256 validatorEpoch,
        bytes32 validatorsHash
    );
    event ClientFrozen(
        uint256 indexed sourceChainId,
        uint256 indexed height,
        bytes32 trustedHeaderHash,
        bytes32 conflictingHeaderHash,
        bytes32 evidenceHash
    );

    constructor(address admin) {
        require(admin != address(0), "ADMIN_ZERO");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CLIENT_ADMIN_ROLE, admin);
    }

    function status(uint256 sourceChainId) external view returns (BesuLightClientTypes.ClientStatus) {
        return clientStatuses[sourceChainId];
    }

    function initializeTrustAnchor(
        uint256 sourceChainId,
        BesuLightClientTypes.TrustedHeader calldata trustedAnchor,
        BesuLightClientTypes.ValidatorSet calldata validatorSet_
    ) external onlyRole(CLIENT_ADMIN_ROLE) {
        require(clientStatuses[sourceChainId] == BesuLightClientTypes.ClientStatus.Uninitialized, "CLIENT_EXISTS");
        require(trustedAnchor.sourceChainId == sourceChainId, "TRUST_CHAIN_MISMATCH");
        require(trustedAnchor.exists, "TRUST_HEADER_MISSING");
        require(trustedAnchor.height > 0, "TRUST_HEIGHT_ZERO");
        require(trustedAnchor.headerHash != bytes32(0), "TRUST_HEADER_HASH_ZERO");
        require(trustedAnchor.stateRoot != bytes32(0), "TRUST_STATE_ROOT_ZERO");
        require(trustedAnchor.timestamp != 0, "TRUST_TIMESTAMP_ZERO");
        require(validatorSet_.validators.length > 0, "VALIDATOR_SET_EMPTY");

        bytes32 validatorsHash = BesuQBFTExtraDataLib.validatorsHash(validatorSet_.validators);
        require(trustedAnchor.validatorsHash == validatorsHash, "VALIDATORS_HASH_MISMATCH");

        _storeValidatorSet(sourceChainId, validatorSet_);
        trustedHeaders[sourceChainId][trustedAnchor.height] = trustedAnchor;
        latestTrustedHeight[sourceChainId] = trustedAnchor.height;
        latestValidatorEpoch[sourceChainId] = validatorSet_.epoch;
        clientStatuses[sourceChainId] = BesuLightClientTypes.ClientStatus.Active;

        emit TrustAnchorInitialized(
            sourceChainId,
            trustedAnchor.height,
            trustedAnchor.headerHash,
            validatorSet_.epoch,
            validatorsHash
        );
    }

    function updateClient(
        BesuLightClientTypes.HeaderUpdate calldata update,
        BesuLightClientTypes.ValidatorSet calldata expectedValidatorSet
    ) external returns (bytes32 trustedHeaderHash) {
        uint256 sourceChainId = update.sourceChainId;
        require(clientStatuses[sourceChainId] == BesuLightClientTypes.ClientStatus.Active, "CLIENT_NOT_ACTIVE");
        require(update.height > 0, "HEIGHT_ZERO");
        require(update.rawHeaderRlp.length > 0, "HEADER_RLP_EMPTY");
        require(update.headerHash == keccak256(update.rawHeaderRlp), "HEADER_HASH_MISMATCH");
        require(expectedValidatorSet.validators.length > 0, "VALIDATOR_SET_EMPTY");

        BesuBlockHeaderLib.ParsedHeader memory parsedHeader = BesuBlockHeaderLib.parse(update.rawHeaderRlp);
        require(parsedHeader.parentHash == update.parentHash, "HEADER_PARENT_FIELD_MISMATCH");
        require(parsedHeader.stateRoot == update.stateRoot, "HEADER_STATE_ROOT_MISMATCH");
        require(parsedHeader.number == update.height, "HEADER_HEIGHT_FIELD_MISMATCH");

        BesuLightClientTypes.TrustedHeader storage latest = trustedHeaders[sourceChainId][latestTrustedHeight[sourceChainId]];
        require(latest.exists, "TRUST_ANCHOR_MISSING");
        require(update.height > latest.height, "HEIGHT_NOT_FORWARD");
        if (update.height == latest.height + 1) {
            require(update.parentHash == latest.headerHash, "PARENT_HASH_MISMATCH");
        }

        BesuLightClientTypes.ParsedExtraData memory parsed = BesuQBFTExtraDataLib.parse(update.extraData);
        BesuLightClientTypes.ParsedExtraData memory sealParsed = BesuQBFTExtraDataLib.parse(parsedHeader.extraData);
        _requireSealHeaderExtraDataMatches(parsed, sealParsed);
        bytes32 validatorsHash = BesuQBFTExtraDataLib.validatorsHash(expectedValidatorSet.validators);
        _verifyFinality(update, parsed, expectedValidatorSet);

        trustedHeaderHash = update.headerHash;
        BesuLightClientTypes.TrustedHeader memory nextTrustedHeader = BesuLightClientTypes.TrustedHeader({
            sourceChainId: sourceChainId,
            height: update.height,
            headerHash: trustedHeaderHash,
            parentHash: update.parentHash,
            stateRoot: update.stateRoot,
            timestamp: parsedHeader.timestamp,
            validatorsHash: validatorsHash,
            exists: true
        });

        BesuLightClientTypes.TrustedHeader storage existing = trustedHeaders[sourceChainId][update.height];
        if (existing.exists && existing.headerHash != trustedHeaderHash) {
            _freeze(sourceChainId, update.height, existing.headerHash, trustedHeaderHash);
            return trustedHeaderHash;
        }

        trustedHeaders[sourceChainId][update.height] = nextTrustedHeader;
        latestTrustedHeight[sourceChainId] = update.height;
        _upsertValidatorSet(sourceChainId, expectedValidatorSet);

        emit TrustedHeaderAccepted(
            sourceChainId,
            update.height,
            trustedHeaderHash,
            update.parentHash,
            update.stateRoot,
            expectedValidatorSet.epoch,
            validatorsHash
        );
    }

    function trustedStateRoot(uint256 sourceChainId, uint256 height) external view returns (bytes32) {
        return trustedHeaders[sourceChainId][height].stateRoot;
    }

    function trustedTimestamp(uint256 sourceChainId, uint256 height) external view returns (uint256) {
        return trustedHeaders[sourceChainId][height].timestamp;
    }

    function trustedHeader(uint256 sourceChainId, uint256 height)
        external
        view
        returns (BesuLightClientTypes.TrustedHeader memory)
    {
        return trustedHeaders[sourceChainId][height];
    }

    function validatorSet(uint256 sourceChainId, uint256 epoch)
        external
        view
        returns (BesuLightClientTypes.ValidatorSet memory)
    {
        return validatorSets[sourceChainId][epoch];
    }

    function _requireSealHeaderExtraDataMatches(
        BesuLightClientTypes.ParsedExtraData memory parsed,
        BesuLightClientTypes.ParsedExtraData memory sealParsed
    ) internal pure {
        require(sealParsed.commitSeals.length == 0, "SEAL_HEADER_HAS_COMMIT_SEALS");
        require(parsed.vanity == sealParsed.vanity, "SEAL_EXTRA_VANITY_MISMATCH");
        require(
            BesuQBFTExtraDataLib.validatorsHash(parsed.validators) ==
                BesuQBFTExtraDataLib.validatorsHash(sealParsed.validators),
            "SEAL_EXTRA_VALIDATORS_MISMATCH"
        );
        require(keccak256(parsed.vote) == keccak256(sealParsed.vote), "SEAL_EXTRA_VOTE_MISMATCH");
        require(parsed.round == sealParsed.round, "SEAL_EXTRA_ROUND_MISMATCH");
    }

    function _verifyFinality(
        BesuLightClientTypes.HeaderUpdate calldata update,
        BesuLightClientTypes.ParsedExtraData memory parsed,
        BesuLightClientTypes.ValidatorSet calldata expectedValidatorSet
    ) internal view virtual;

    function _freeze(
        uint256 sourceChainId,
        uint256 height,
        bytes32 trustedHeaderHash_,
        bytes32 conflictingHeaderHash
    ) internal {
        bytes32 evidenceHash =
            keccak256(abi.encode(sourceChainId, height, trustedHeaderHash_, conflictingHeaderHash));
        frozenEvidence[sourceChainId] = BesuLightClientTypes.MisbehaviourEvidence({
            sourceChainId: sourceChainId,
            height: height,
            trustedHeaderHash: trustedHeaderHash_,
            conflictingHeaderHash: conflictingHeaderHash,
            evidenceHash: evidenceHash,
            detectedAt: block.timestamp
        });
        clientStatuses[sourceChainId] = BesuLightClientTypes.ClientStatus.Frozen;
        emit ClientFrozen(sourceChainId, height, trustedHeaderHash_, conflictingHeaderHash, evidenceHash);
    }

    function _upsertValidatorSet(uint256 sourceChainId, BesuLightClientTypes.ValidatorSet calldata validatorSet_) internal {
        BesuLightClientTypes.ValidatorSet storage stored = validatorSets[sourceChainId][validatorSet_.epoch];
        if (stored.validators.length == 0) {
            _storeValidatorSet(sourceChainId, validatorSet_);
        } else {
            require(
                BesuQBFTExtraDataLib.validatorsHash(stored.validators) ==
                    BesuQBFTExtraDataLib.validatorsHash(validatorSet_.validators),
                "VALIDATOR_SET_MISMATCH"
            );
        }
        if (validatorSet_.epoch > latestValidatorEpoch[sourceChainId]) {
            latestValidatorEpoch[sourceChainId] = validatorSet_.epoch;
        }
    }

    function _storeValidatorSet(uint256 sourceChainId, BesuLightClientTypes.ValidatorSet calldata validatorSet_) internal {
        BesuLightClientTypes.ValidatorSet storage stored = validatorSets[sourceChainId][validatorSet_.epoch];
        stored.epoch = validatorSet_.epoch;
        stored.activationHeight = validatorSet_.activationHeight;
        delete stored.validators;
        for (uint256 i = 0; i < validatorSet_.validators.length; i++) {
            stored.validators.push(validatorSet_.validators[i]);
        }
    }
}
