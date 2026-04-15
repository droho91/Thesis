// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {CommitmentLib} from "../libs/CommitmentLib.sol";

/// @title SourceValidatorEpochRegistry
/// @notice Source-chain canonical validator epoch registry for a permissioned bank chain.
contract SourceValidatorEpochRegistry is AccessControl {
    bytes32 public constant VALIDATOR_EPOCH_PRODUCER_ROLE =
        keccak256("VALIDATOR_EPOCH_PRODUCER_ROLE");
    uint256 public constant QUORUM_NUMERATOR = 2;
    uint256 public constant QUORUM_DENOMINATOR = 3;

    struct ValidatorEpoch {
        uint256 sourceChainId;
        address sourceValidatorSetRegistry;
        uint256 epochId;
        bytes32 parentEpochHash;
        address[] validators;
        uint256[] votingPowers;
        uint256 totalVotingPower;
        uint256 quorumNumerator;
        uint256 quorumDenominator;
        uint256 activationBlockNumber;
        bytes32 activationBlockHash;
        uint256 timestamp;
        bytes32 epochHash;
        bool active;
    }

    uint256 public immutable sourceChainId;
    uint256 public activeValidatorEpochId;
    bytes32 public latestValidatorEpochHash;
    uint256 public latestEpochAnchorBlockNumber;

    mapping(uint256 => ValidatorEpoch) private validatorEpochs;
    mapping(bytes32 => bool) public canonicalValidatorEpochHash;
    mapping(uint256 => mapping(address => uint256)) public validatorVotingPower;

    event SourceValidatorEpochCommitted(
        uint256 indexed sourceChainId,
        uint256 indexed epochId,
        bytes32 indexed epochHash,
        bytes32 parentEpochHash,
        uint256 totalVotingPower,
        uint256 quorumNumerator,
        uint256 quorumDenominator,
        uint256 activationBlockNumber,
        bytes32 activationBlockHash,
        bool active
    );
    event ActiveValidatorEpochRotated(
        uint256 indexed sourceChainId,
        uint256 indexed oldEpochId,
        uint256 indexed newEpochId,
        bytes32 oldEpochHash,
        bytes32 newEpochHash
    );

    constructor(
        uint256 _sourceChainId,
        uint256 initialEpochId,
        address[] memory validators,
        uint256[] memory votingPowers
    ) {
        require(_sourceChainId != 0, "CHAIN_ID_ZERO");
        require(initialEpochId != 0, "EPOCH_ZERO");
        sourceChainId = _sourceChainId;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(VALIDATOR_EPOCH_PRODUCER_ROLE, msg.sender);
        _commitValidatorEpoch(initialEpochId, validators, votingPowers);
    }

    function commitValidatorEpoch(uint256 epochId, address[] calldata validators, uint256[] calldata votingPowers)
        external
        onlyRole(VALIDATOR_EPOCH_PRODUCER_ROLE)
        returns (ValidatorEpoch memory epoch)
    {
        require(epochId == activeValidatorEpochId + 1, "WRONG_EPOCH");
        epoch = _commitValidatorEpoch(epochId, validators, votingPowers);
    }

    function activeValidatorEpoch()
        external
        view
        returns (
            uint256 epochId,
            uint256 totalVotingPower,
            bytes32 epochHash,
            uint256 quorumNumerator,
            uint256 quorumDenominator,
            address[] memory validators
        )
    {
        epochId = activeValidatorEpochId;
        ValidatorEpoch storage epoch = validatorEpochs[epochId];
        return (
            epochId,
            epoch.totalVotingPower,
            epoch.epochHash,
            epoch.quorumNumerator,
            epoch.quorumDenominator,
            epoch.validators
        );
    }

    function validatorEpoch(uint256 epochId) external view returns (ValidatorEpoch memory) {
        ValidatorEpoch memory epoch = validatorEpochs[epochId];
        require(epoch.epochHash != bytes32(0), "EPOCH_UNKNOWN");
        return epoch;
    }

    function computeValidatorEpochHash(
        uint256 _sourceChainId,
        address sourceValidatorSetRegistry,
        uint256 epochId,
        bytes32 parentEpochHash,
        address[] memory validators,
        uint256[] memory votingPowers,
        uint256 totalVotingPower,
        uint256 quorumNumerator,
        uint256 quorumDenominator,
        uint256 activationBlockNumber,
        bytes32 activationBlockHash,
        uint256 timestamp
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CommitmentLib.VALIDATOR_EPOCH_TYPEHASH,
                _sourceChainId,
                sourceValidatorSetRegistry,
                epochId,
                parentEpochHash,
                validators,
                votingPowers,
                totalVotingPower,
                quorumNumerator,
                quorumDenominator,
                activationBlockNumber,
                activationBlockHash,
                timestamp
            )
        );
    }

    function _commitValidatorEpoch(uint256 epochId, address[] memory validators, uint256[] memory votingPowers)
        internal
        returns (ValidatorEpoch memory epoch)
    {
        require(validators.length == votingPowers.length, "VALIDATOR_LENGTH_MISMATCH");
        require(validators.length > 0, "VALIDATORS_EMPTY");

        uint256 oldEpochId = activeValidatorEpochId;
        bytes32 parentEpochHash = latestValidatorEpochHash;
        uint256 totalPower;
        for (uint256 i = 0; i < validators.length; i++) {
            address validator = validators[i];
            uint256 power = votingPowers[i];
            require(validator != address(0), "VALIDATOR_ZERO");
            require(power > 0, "VALIDATOR_POWER_ZERO");
            require(validatorVotingPower[epochId][validator] == 0, "DUPLICATE_VALIDATOR");
            validatorVotingPower[epochId][validator] = power;
            totalPower += power;
        }

        uint256 activationBlockNumber = block.number > 0 ? block.number - 1 : 0;
        bytes32 activationBlockHash = blockhash(activationBlockNumber);
        if (activationBlockHash == bytes32(0)) {
            activationBlockHash = keccak256(
                abi.encodePacked(
                    "LOCAL_IBC_LITE_EPOCH_ANCHOR",
                    block.chainid,
                    address(this),
                    epochId,
                    parentEpochHash,
                    activationBlockNumber
                )
            );
        }
        require(activationBlockNumber >= latestEpochAnchorBlockNumber, "EPOCH_ANCHOR_REGRESSION");

        epoch = ValidatorEpoch({
            sourceChainId: sourceChainId,
            sourceValidatorSetRegistry: address(this),
            epochId: epochId,
            parentEpochHash: parentEpochHash,
            validators: validators,
            votingPowers: votingPowers,
            totalVotingPower: totalPower,
            quorumNumerator: QUORUM_NUMERATOR,
            quorumDenominator: QUORUM_DENOMINATOR,
            activationBlockNumber: activationBlockNumber,
            activationBlockHash: activationBlockHash,
            timestamp: block.timestamp,
            epochHash: bytes32(0),
            active: true
        });
        epoch.epochHash = computeValidatorEpochHash(
            epoch.sourceChainId,
            epoch.sourceValidatorSetRegistry,
            epoch.epochId,
            epoch.parentEpochHash,
            epoch.validators,
            epoch.votingPowers,
            epoch.totalVotingPower,
            epoch.quorumNumerator,
            epoch.quorumDenominator,
            epoch.activationBlockNumber,
            epoch.activationBlockHash,
            epoch.timestamp
        );

        if (oldEpochId != 0) {
            validatorEpochs[oldEpochId].active = false;
        }
        validatorEpochs[epochId] = epoch;
        activeValidatorEpochId = epochId;
        latestValidatorEpochHash = epoch.epochHash;
        latestEpochAnchorBlockNumber = activationBlockNumber;
        canonicalValidatorEpochHash[epoch.epochHash] = true;

        if (oldEpochId != 0) {
            emit SourceValidatorEpochCommitted(
                sourceChainId,
                oldEpochId,
                validatorEpochs[oldEpochId].epochHash,
                validatorEpochs[oldEpochId].parentEpochHash,
                validatorEpochs[oldEpochId].totalVotingPower,
                validatorEpochs[oldEpochId].quorumNumerator,
                validatorEpochs[oldEpochId].quorumDenominator,
                validatorEpochs[oldEpochId].activationBlockNumber,
                validatorEpochs[oldEpochId].activationBlockHash,
                false
            );
        }

        emit SourceValidatorEpochCommitted(
            sourceChainId,
            epochId,
            epoch.epochHash,
            parentEpochHash,
            totalPower,
            QUORUM_NUMERATOR,
            QUORUM_DENOMINATOR,
            activationBlockNumber,
            activationBlockHash,
            true
        );
        emit ActiveValidatorEpochRotated(
            sourceChainId,
            oldEpochId,
            epochId,
            parentEpochHash,
            epoch.epochHash
        );
    }
}
