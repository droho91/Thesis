// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title InstitutionalCollateralMessageLib
/// @notice Canonical business payload exchanged by institutional collateral applications.
library InstitutionalCollateralMessageLib {
    uint64 internal constant VERSION = 1;
    uint64 internal constant ACKNOWLEDGEMENT_VERSION = 1;

    enum Action {
        Invalid,
        LockMint,
        BurnUnlock
    }

    struct TransferData {
        uint64 version;
        Action action;
        address sender;
        address recipient;
        address canonicalAsset;
        uint256 amount;
        bytes32 clientReference;
    }

    function encode(TransferData memory transfer) internal pure returns (bytes memory) {
        return abi.encode(transfer);
    }

    function decode(bytes calldata payload) internal pure returns (TransferData memory transfer) {
        transfer = abi.decode(payload, (TransferData));
        require(transfer.version == VERSION, "UNSUPPORTED_TRANSFER_VERSION");
        require(transfer.action == Action.LockMint || transfer.action == Action.BurnUnlock, "BAD_TRANSFER_ACTION");
        require(transfer.sender != address(0), "TRANSFER_SENDER_ZERO");
        require(transfer.recipient != address(0), "TRANSFER_RECIPIENT_ZERO");
        require(transfer.canonicalAsset != address(0), "TRANSFER_ASSET_ZERO");
        require(transfer.amount > 0, "TRANSFER_AMOUNT_ZERO");
    }

    function acknowledgement(bytes32 messageId, Action action, uint256 amount) internal pure returns (bytes memory) {
        return abi.encode(ACKNOWLEDGEMENT_VERSION, messageId, action, amount);
    }
}
