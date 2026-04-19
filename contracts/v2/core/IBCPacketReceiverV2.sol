// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCPacketLibV2} from "./IBCPacketLibV2.sol";

/// @title IBCPacketReceiverV2
/// @notice v2 application callback surface for verified packet delivery.
interface IBCPacketReceiverV2 {
    function onRecvPacketV2(IBCPacketLibV2.Packet calldata packet, bytes32 packetId)
        external
        returns (bytes memory acknowledgement);
}

/// @title IBCPacketAcknowledgementReceiverV2
/// @notice v2 source application callback for verified acknowledgements.
interface IBCPacketAcknowledgementReceiverV2 {
    function onAcknowledgementPacketV2(IBCPacketLibV2.Packet calldata packet, bytes32 packetId, bytes calldata acknowledgement)
        external;
}

/// @title IBCPacketTimeoutReceiverV2
/// @notice v2 source application callback for verified packet timeouts.
interface IBCPacketTimeoutReceiverV2 {
    function onTimeoutPacketV2(IBCPacketLibV2.Packet calldata packet, bytes32 packetId) external;
}
