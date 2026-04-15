// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title BankChainClientVerifier
/// @notice Signature recovery helpers for local bank validator quorum checks.
library BankChainClientVerifier {
    function recoverDirect(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        return ECDSA.recover(digest, signature);
    }

    function recoverEthSigned(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        return ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(digest), signature);
    }
}
