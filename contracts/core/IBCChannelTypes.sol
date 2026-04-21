// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IBCChannelTypes
/// @notice IBC channel and packet lifecycle types.
library IBCChannelTypes {
    enum State {
        Uninitialized,
        Init,
        TryOpen,
        Open,
        Closed
    }

    enum Order {
        None,
        Unordered,
        Ordered
    }

    struct Counterparty {
        bytes32 portId;
        bytes32 channelId;
    }

    struct ChannelEnd {
        State state;
        Order ordering;
        Counterparty counterparty;
        bytes32[] connectionHops;
        bytes version;
    }

    struct Packet {
        uint64 sequence;
        bytes32 sourcePort;
        bytes32 sourceChannel;
        bytes32 destinationPort;
        bytes32 destinationChannel;
        uint64 timeoutHeight;
        uint64 timeoutTimestamp;
        bytes data;
    }

    struct Acknowledgement {
        bool success;
        bytes result;
        string errorMessage;
    }
}
