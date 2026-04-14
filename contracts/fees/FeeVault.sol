// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title FeeVault
/// @notice Collects route fees and optionally pays relayer rewards.
contract FeeVault is AccessControl {
    bytes32 public constant FEE_ADMIN_ROLE = keccak256("FEE_ADMIN_ROLE");
    bytes32 public constant COLLECTOR_ROLE = keccak256("COLLECTOR_ROLE");
    uint256 public constant BPS = 10_000;

    uint256 public relayerRewardBps;
    mapping(bytes32 => uint256) public routeBalance;

    event CollectorGranted(address indexed collector);
    event RelayerRewardBpsUpdated(uint256 oldBps, uint256 newBps);
    event FeeCollected(
        bytes32 indexed routeId,
        bytes32 indexed messageId,
        address indexed relayer,
        uint256 amount,
        uint256 reward
    );
    event FeesWithdrawn(bytes32 indexed routeId, address indexed to, uint256 amount);

    constructor(uint256 _relayerRewardBps) {
        require(_relayerRewardBps <= BPS, "REWARD_TOO_HIGH");
        relayerRewardBps = _relayerRewardBps;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(FEE_ADMIN_ROLE, msg.sender);
    }

    receive() external payable {
        revert("USE_COLLECT_FEE");
    }

    function grantCollector(address collector) external onlyRole(FEE_ADMIN_ROLE) {
        require(collector != address(0), "COLLECTOR_ZERO");
        _grantRole(COLLECTOR_ROLE, collector);
        emit CollectorGranted(collector);
    }

    function setRelayerRewardBps(uint256 newBps) external onlyRole(FEE_ADMIN_ROLE) {
        require(newBps <= BPS, "REWARD_TOO_HIGH");
        uint256 oldBps = relayerRewardBps;
        relayerRewardBps = newBps;
        emit RelayerRewardBpsUpdated(oldBps, newBps);
    }

    function collectFee(bytes32 routeId, bytes32 messageId, address payable relayer)
        external
        payable
        onlyRole(COLLECTOR_ROLE)
        returns (uint256 reward)
    {
        require(routeId != bytes32(0), "ROUTE_ZERO");
        require(messageId != bytes32(0), "MESSAGE_ZERO");

        reward = (msg.value * relayerRewardBps) / BPS;
        uint256 retained = msg.value - reward;
        routeBalance[routeId] += retained;

        if (reward > 0) {
            (bool ok,) = relayer.call{value: reward}("");
            require(ok, "REWARD_TRANSFER_FAILED");
        }

        emit FeeCollected(routeId, messageId, relayer, msg.value, reward);
    }

    function withdraw(bytes32 routeId, address payable to, uint256 amount) external onlyRole(FEE_ADMIN_ROLE) {
        require(to != address(0), "TO_ZERO");
        require(routeBalance[routeId] >= amount, "INSUFFICIENT_ROUTE_FEES");
        routeBalance[routeId] -= amount;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "FEE_TRANSFER_FAILED");
        emit FeesWithdrawn(routeId, to, amount);
    }
}
