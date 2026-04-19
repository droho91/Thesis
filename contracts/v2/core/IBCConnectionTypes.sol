// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IBCConnectionTypes
/// @notice v2 connection-layer types for a less bespoke IBC core.
library IBCConnectionTypes {
    enum State {
        Uninitialized,
        Init,
        TryOpen,
        Open
    }

    struct Counterparty {
        bytes32 clientId;
        bytes32 connectionId;
        bytes prefix;
    }

    struct ConnectionEnd {
        State state;
        bytes32 clientId;
        Counterparty counterparty;
        uint64 delayPeriod;
        bytes[] versions;
    }
}
