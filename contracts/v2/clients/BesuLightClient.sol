// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {BesuLightClientTypes} from "./BesuLightClientTypes.sol";
import {BesuQBFTExtraDataLib} from "./BesuQBFTExtraDataLib.sol";
import {BesuLightClientBase} from "./BesuLightClientBase.sol";

/// @title BesuLightClient
/// @notice Concrete v2 Besu/QBFT light-client shell.
/// @dev This version verifies the validator set committed in `extraData` and the commit seals that sign
///      the Besu block hash directly. Validator-set transitions are still intentionally conservative and
///      explicit; dynamic epoch derivation can evolve on top of this shell.
contract BesuLightClient is BesuLightClientBase {
    constructor(address admin) BesuLightClientBase(admin) {}

    function _verifyFinality(
        BesuLightClientTypes.HeaderUpdate calldata update,
        BesuLightClientTypes.ParsedExtraData memory parsed,
        BesuLightClientTypes.ValidatorSet calldata expectedValidatorSet
    ) internal view override {
        require(parsed.validators.length == expectedValidatorSet.validators.length, "EXTRA_DATA_VALIDATOR_COUNT");
        require(
            BesuQBFTExtraDataLib.validatorsHash(parsed.validators) ==
                BesuQBFTExtraDataLib.validatorsHash(expectedValidatorSet.validators),
            "EXTRA_DATA_VALIDATOR_SET_MISMATCH"
        );

        uint256 minimumSeals = BesuQBFTExtraDataLib.minimumCommitSeals(expectedValidatorSet.validators.length);
        require(parsed.commitSeals.length >= minimumSeals, "INSUFFICIENT_COMMIT_SEALS");

        address[] memory recovered = new address[](parsed.commitSeals.length);
        uint256 uniqueRecovered;
        for (uint256 i = 0; i < parsed.commitSeals.length; i++) {
            address signer = _recoverCommitSeal(update.headerHash, parsed.commitSeals[i]);
            require(_contains(expectedValidatorSet.validators, signer), "COMMIT_SEAL_SIGNER_UNKNOWN");
            require(!_contains(recovered, signer, uniqueRecovered), "COMMIT_SEAL_DUPLICATE_SIGNER");
            recovered[uniqueRecovered] = signer;
            uniqueRecovered++;
        }

        require(uniqueRecovered >= minimumSeals, "COMMIT_SEAL_QUORUM_NOT_MET");

        if (expectedValidatorSet.epoch > 0) {
            BesuLightClientTypes.ValidatorSet storage current = validatorSets[update.sourceChainId][latestValidatorEpoch[update.sourceChainId]];
            if (current.validators.length > 0 && expectedValidatorSet.epoch == current.epoch) {
                require(
                    BesuQBFTExtraDataLib.validatorsHash(current.validators) ==
                        BesuQBFTExtraDataLib.validatorsHash(expectedValidatorSet.validators),
                    "CURRENT_VALIDATOR_SET_MISMATCH"
                );
            }
        }
    }

    function _contains(address[] memory values, address needle) private pure returns (bool) {
        return _contains(values, needle, values.length);
    }

    function _contains(address[] memory values, address needle, uint256 length) private pure returns (bool) {
        for (uint256 i = 0; i < length; i++) {
            if (values[i] == needle) return true;
        }
        return false;
    }

    function _recoverCommitSeal(bytes32 headerHash, bytes memory seal) private pure returns (address signer) {
        require(seal.length == 65, "COMMIT_SEAL_LENGTH");

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(seal, 32))
            s := mload(add(seal, 64))
            v := byte(0, mload(add(seal, 96)))
        }

        if (v < 27) {
            v += 27;
        }

        return ECDSA.recover(headerHash, v, r, s);
    }
}
