// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CommitmentLib} from "../libs/CommitmentLib.sol";

/// @title BankChainClientState
/// @notice Client state and validator epoch hashing for a permissioned bank-chain client.
library BankChainClientState {
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

    function hash(ValidatorEpoch memory epoch) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CommitmentLib.VALIDATOR_EPOCH_TYPEHASH,
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
            )
        );
    }

    function hashCalldata(ValidatorEpoch calldata epoch) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CommitmentLib.VALIDATOR_EPOCH_TYPEHASH,
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
            )
        );
    }
}
