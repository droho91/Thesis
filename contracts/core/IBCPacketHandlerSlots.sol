// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IBCPacketHandlerSlots
/// @notice Storage-slot helpers for `IBCPacketHandler`.
/// @dev `AccessControl` occupies slot 0. The light-client reference and local chain id are immutable.
library IBCPacketHandlerSlots {
    uint256 internal constant ACCESS_CONTROL_ROLES_SLOT = 0;
    uint256 internal constant TRUSTED_PACKET_STORE_BY_SOURCE_CHAIN_SLOT = 1;
    uint256 internal constant PACKET_RECEIPTS_SLOT = 2;
    uint256 internal constant ACKNOWLEDGEMENT_HASHES_SLOT = 3;
    uint256 internal constant PACKET_ACKNOWLEDGEMENTS_SLOT = 4;
    uint256 internal constant PACKET_TIMEOUTS_SLOT = 5;
    uint256 internal constant PORT_APPLICATIONS_SLOT = 6;

    function packetReceipt(bytes32 packetId) internal pure returns (bytes32) {
        return keccak256(abi.encode(packetId, PACKET_RECEIPTS_SLOT));
    }

    function acknowledgementHash(bytes32 packetId) internal pure returns (bytes32) {
        return keccak256(abi.encode(packetId, ACKNOWLEDGEMENT_HASHES_SLOT));
    }

    function packetAcknowledgement(bytes32 packetId) internal pure returns (bytes32) {
        return keccak256(abi.encode(packetId, PACKET_ACKNOWLEDGEMENTS_SLOT));
    }

    function portApplication(address port) internal pure returns (bytes32) {
        return keccak256(abi.encode(port, PORT_APPLICATIONS_SLOT));
    }

    function packetTimeout(bytes32 packetId) internal pure returns (bytes32) {
        return keccak256(abi.encode(packetId, PACKET_TIMEOUTS_SLOT));
    }
}
