// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCPacketAcknowledgementReceiverV2, IBCPacketTimeoutReceiverV2} from "../core/IBCPacketReceiverV2.sol";
import {IBCPacketLibV2} from "../core/IBCPacketLibV2.sol";

/// @title MockPacketLifecycleAppV2
/// @notice Source-side app used to prove acknowledgements are delivered back to the application layer.
contract MockPacketLifecycleAppV2 is IBCPacketAcknowledgementReceiverV2, IBCPacketTimeoutReceiverV2 {
    address public immutable packetHandler;

    uint256 public acknowledgementCount;
    uint256 public timeoutCount;
    bytes32 public lastAcknowledgedPacketId;
    bytes32 public lastAcknowledgementHash;
    bytes32 public lastTimedOutPacketId;

    event AcknowledgementObserved(bytes32 indexed packetId, bytes32 acknowledgementHash);
    event TimeoutObserved(bytes32 indexed packetId);

    constructor(address packetHandler_) {
        require(packetHandler_ != address(0), "PACKET_HANDLER_ZERO");
        packetHandler = packetHandler_;
    }

    function onAcknowledgementPacketV2(
        IBCPacketLibV2.Packet calldata,
        bytes32 packetId,
        bytes calldata acknowledgement
    ) external {
        require(msg.sender == packetHandler, "ONLY_PACKET_HANDLER");
        acknowledgementCount += 1;
        lastAcknowledgedPacketId = packetId;
        lastAcknowledgementHash = keccak256(acknowledgement);
        emit AcknowledgementObserved(packetId, lastAcknowledgementHash);
    }

    function onTimeoutPacketV2(IBCPacketLibV2.Packet calldata, bytes32 packetId) external {
        require(msg.sender == packetHandler, "ONLY_PACKET_HANDLER");
        timeoutCount += 1;
        lastTimedOutPacketId = packetId;
        emit TimeoutObserved(packetId);
    }
}
