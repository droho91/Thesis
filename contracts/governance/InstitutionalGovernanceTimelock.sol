// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title InstitutionalGovernanceTimelock
/// @notice OpenZeppelin timelock profile used as the admin of institutional protocol contracts.
contract InstitutionalGovernanceTimelock is TimelockController {
    constructor(uint256 minimumDelay, address[] memory proposers, address[] memory executors, address bootstrapAdmin)
        TimelockController(minimumDelay, proposers, executors, bootstrapAdmin)
    {}
}
