// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCPacketLib} from "./IBCPacketLib.sol";

/// @title IBCPacketReceiver
/// @notice IBC application callback surface for verified packet delivery.
interface IBCPacketReceiver {
    function onRecvPacket(IBCPacketLib.Packet calldata packet, bytes32 packetId)
        external
        returns (bytes memory acknowledgement);
}

/// @title IBCPacketAcknowledgementReceiver
/// @notice IBC source application callback for verified acknowledgements.
interface IBCPacketAcknowledgementReceiver {
    function onAcknowledgementPacket(IBCPacketLib.Packet calldata packet, bytes32 packetId, bytes calldata acknowledgement)
        external;
}

/// @title IBCPacketTimeoutReceiver
/// @notice IBC source application callback for verified packet timeouts.
interface IBCPacketTimeoutReceiver {
    function onTimeoutPacket(IBCPacketLib.Packet calldata packet, bytes32 packetId) external;
}
