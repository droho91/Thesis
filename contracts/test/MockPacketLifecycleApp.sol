// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCPacketAcknowledgementReceiver, IBCPacketTimeoutReceiver} from "../core/IBCPacketReceiver.sol";
import {IBCPacketLib} from "../core/IBCPacketLib.sol";

/// @title MockPacketLifecycleApp
/// @notice Source-side app used to prove acknowledgements are delivered back to the application layer.
contract MockPacketLifecycleApp is IBCPacketAcknowledgementReceiver, IBCPacketTimeoutReceiver {
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

    function onAcknowledgementPacket(
        IBCPacketLib.Packet calldata,
        bytes32 packetId,
        bytes calldata acknowledgement
    ) external {
        require(msg.sender == packetHandler, "ONLY_PACKET_HANDLER");
        acknowledgementCount += 1;
        lastAcknowledgedPacketId = packetId;
        lastAcknowledgementHash = keccak256(acknowledgement);
        emit AcknowledgementObserved(packetId, lastAcknowledgementHash);
    }

    function onTimeoutPacket(IBCPacketLib.Packet calldata, bytes32 packetId) external {
        require(msg.sender == packetHandler, "ONLY_PACKET_HANDLER");
        timeoutCount += 1;
        lastTimedOutPacketId = packetId;
        emit TimeoutObserved(packetId);
    }
}
