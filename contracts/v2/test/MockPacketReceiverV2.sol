// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCPacketReceiverV2} from "../core/IBCPacketReceiverV2.sol";
import {IBCPacketLibV2} from "../core/IBCPacketLibV2.sol";

/// @title MockPacketReceiverV2
/// @notice Minimal destination app used by the v2 packet smoke flow.
contract MockPacketReceiverV2 is IBCPacketReceiverV2 {
    bytes32 public lastPacketId;
    address public lastSender;
    address public lastRecipient;
    uint256 public lastAmount;
    uint8 public lastAction;
    bytes32 public lastAckHash;

    event PacketObserved(bytes32 indexed packetId, address indexed sender, address indexed recipient, uint256 amount);

    function onRecvPacketV2(IBCPacketLibV2.Packet calldata packet, bytes32 packetId)
        external
        returns (bytes memory acknowledgement)
    {
        IBCPacketLibV2.TransferData memory transferData = IBCPacketLibV2.decodeTransferData(packet.data);
        lastPacketId = packetId;
        lastSender = transferData.sender;
        lastRecipient = transferData.recipient;
        lastAmount = transferData.amount;
        lastAction = transferData.action;

        acknowledgement = abi.encodePacked("ok:", packetId);
        lastAckHash = keccak256(acknowledgement);
        emit PacketObserved(packetId, transferData.sender, transferData.recipient, transferData.amount);
    }
}
