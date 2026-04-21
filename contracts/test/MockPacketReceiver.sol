// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBCPacketReceiver} from "../core/IBCPacketReceiver.sol";
import {IBCPacketLib} from "../core/IBCPacketLib.sol";

/// @title MockPacketReceiver
/// @notice Minimal destination app used by the IBC packet verification flow.
contract MockPacketReceiver is IBCPacketReceiver {
    bytes32 public lastPacketId;
    address public lastSender;
    address public lastRecipient;
    uint256 public lastAmount;
    uint8 public lastAction;
    bytes32 public lastAckHash;

    event PacketObserved(bytes32 indexed packetId, address indexed sender, address indexed recipient, uint256 amount);

    function onRecvPacket(IBCPacketLib.Packet calldata packet, bytes32 packetId)
        external
        returns (bytes memory acknowledgement)
    {
        IBCPacketLib.TransferData memory transferData = IBCPacketLib.decodeTransferData(packet.data);
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
