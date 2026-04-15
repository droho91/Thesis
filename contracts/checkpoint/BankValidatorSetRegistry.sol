// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title BankValidatorSetRegistry
/// @notice Source-chain registry for the validator epochs of one permissioned bank chain.
/// @dev This models the bank chain's own validator-set progression. Destination clients keep
///      a matching remote view and verify checkpoint signatures against the bound set hash.
contract BankValidatorSetRegistry is AccessControl {
    bytes32 public constant VALIDATOR_SET_ADMIN_ROLE = keccak256("VALIDATOR_SET_ADMIN_ROLE");
    bytes32 public constant VALIDATOR_SET_TYPEHASH = keccak256("BankChain.ValidatorSet.v1");

    struct ValidatorSetInfo {
        uint256 totalVotingPower;
        bytes32 validatorSetHash;
        bool active;
        address[] validators;
    }

    uint256 public immutable sourceChainId;
    uint256 public activeValidatorSetId;

    mapping(uint256 => ValidatorSetInfo) private validatorSets;
    mapping(uint256 => mapping(address => uint256)) public validatorVotingPower;

    event BankValidatorSetCommitted(
        uint256 indexed sourceChainId,
        uint256 indexed validatorSetId,
        bytes32 indexed validatorSetHash,
        uint256 totalVotingPower,
        bool active
    );
    event ActiveValidatorSetRotated(
        uint256 indexed sourceChainId,
        uint256 indexed oldValidatorSetId,
        uint256 indexed newValidatorSetId
    );

    constructor(
        uint256 _sourceChainId,
        uint256 initialValidatorSetId,
        address[] memory validators,
        uint256[] memory votingPowers
    ) {
        require(_sourceChainId != 0, "CHAIN_ID_ZERO");
        require(initialValidatorSetId != 0, "VALIDATOR_SET_ZERO");
        sourceChainId = _sourceChainId;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(VALIDATOR_SET_ADMIN_ROLE, msg.sender);
        _commitValidatorSet(initialValidatorSetId, validators, votingPowers, true);
        activeValidatorSetId = initialValidatorSetId;
    }

    function commitValidatorSet(
        uint256 validatorSetId,
        address[] calldata validators,
        uint256[] calldata votingPowers,
        bool active
    ) external onlyRole(VALIDATOR_SET_ADMIN_ROLE) {
        require(validatorSetId != 0, "VALIDATOR_SET_ZERO");
        if (active) {
            require(validatorSetId > activeValidatorSetId, "VALIDATOR_SET_NOT_FORWARD");
            uint256 oldValidatorSetId = activeValidatorSetId;
            if (oldValidatorSetId != 0) {
                validatorSets[oldValidatorSetId].active = false;
                emit BankValidatorSetCommitted(
                    sourceChainId,
                    oldValidatorSetId,
                    validatorSets[oldValidatorSetId].validatorSetHash,
                    validatorSets[oldValidatorSetId].totalVotingPower,
                    false
                );
            }
            activeValidatorSetId = validatorSetId;
            emit ActiveValidatorSetRotated(sourceChainId, oldValidatorSetId, validatorSetId);
        }

        _commitValidatorSet(validatorSetId, validators, votingPowers, active);
    }

    function activeValidatorSet()
        external
        view
        returns (
            uint256 validatorSetId,
            uint256 totalVotingPower,
            bytes32 validatorSetHash,
            address[] memory validators
        )
    {
        validatorSetId = activeValidatorSetId;
        ValidatorSetInfo storage set = validatorSets[validatorSetId];
        return (validatorSetId, set.totalVotingPower, set.validatorSetHash, set.validators);
    }

    function validatorSet(uint256 validatorSetId)
        external
        view
        returns (uint256 totalVotingPower, bytes32 validatorSetHash, bool active, address[] memory validators)
    {
        ValidatorSetInfo storage set = validatorSets[validatorSetId];
        return (set.totalVotingPower, set.validatorSetHash, set.active, set.validators);
    }

    function computeValidatorSetHash(
        uint256 _sourceChainId,
        uint256 validatorSetId,
        address[] memory validators,
        uint256[] memory votingPowers
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(VALIDATOR_SET_TYPEHASH, _sourceChainId, validatorSetId, validators, votingPowers));
    }

    function _commitValidatorSet(
        uint256 validatorSetId,
        address[] memory validators,
        uint256[] memory votingPowers,
        bool active
    ) internal {
        require(validators.length == votingPowers.length, "VALIDATOR_LENGTH_MISMATCH");
        require(validators.length > 0, "VALIDATORS_EMPTY");

        ValidatorSetInfo storage set = validatorSets[validatorSetId];
        for (uint256 i = 0; i < set.validators.length; i++) {
            validatorVotingPower[validatorSetId][set.validators[i]] = 0;
        }
        delete set.validators;

        uint256 totalPower;
        for (uint256 i = 0; i < validators.length; i++) {
            address validator = validators[i];
            uint256 power = votingPowers[i];
            require(validator != address(0), "VALIDATOR_ZERO");
            require(power > 0, "VALIDATOR_POWER_ZERO");
            require(validatorVotingPower[validatorSetId][validator] == 0, "DUPLICATE_VALIDATOR");

            validatorVotingPower[validatorSetId][validator] = power;
            set.validators.push(validator);
            totalPower += power;
        }

        set.totalVotingPower = totalPower;
        set.validatorSetHash = computeValidatorSetHash(sourceChainId, validatorSetId, validators, votingPowers);
        set.active = active;

        emit BankValidatorSetCommitted(sourceChainId, validatorSetId, set.validatorSetHash, totalPower, active);
    }
}
