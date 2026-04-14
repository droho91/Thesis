// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title MessageInbox
/// @notice Replay protection for verified cross-chain messages.
contract MessageInbox is AccessControl {
    bytes32 public constant INBOX_ADMIN_ROLE = keccak256("INBOX_ADMIN_ROLE");
    bytes32 public constant CONSUMER_ROLE = keccak256("CONSUMER_ROLE");

    mapping(bytes32 => bool) public consumed;

    event ConsumerGranted(address indexed consumer);
    event MessageConsumed(bytes32 indexed messageId, address indexed consumer);

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(INBOX_ADMIN_ROLE, msg.sender);
    }

    function grantConsumer(address consumer) external onlyRole(INBOX_ADMIN_ROLE) {
        require(consumer != address(0), "CONSUMER_ZERO");
        _grantRole(CONSUMER_ROLE, consumer);
        emit ConsumerGranted(consumer);
    }

    function consume(bytes32 messageId) external onlyRole(CONSUMER_ROLE) {
        require(messageId != bytes32(0), "MESSAGE_ZERO");
        require(!consumed[messageId], "MESSAGE_ALREADY_CONSUMED");
        consumed[messageId] = true;
        emit MessageConsumed(messageId, msg.sender);
    }
}
