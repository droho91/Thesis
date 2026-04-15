// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title FeeVault
/// @notice Escrows prepaid route fees and pays relayers from route-funded balances.
contract FeeVault is AccessControl {
    bytes32 public constant FEE_ADMIN_ROLE = keccak256("FEE_ADMIN_ROLE");
    bytes32 public constant COLLECTOR_ROLE = keccak256("COLLECTOR_ROLE");
    uint256 public constant BPS = 10_000;

    uint256 public relayerRewardBps;
    mapping(bytes32 => uint256) public routeBalance;

    event CollectorGranted(address indexed collector);
    event RelayerRewardBpsUpdated(uint256 oldBps, uint256 newBps);
    event RouteFunded(bytes32 indexed routeId, address indexed payer, uint256 amount);
    event FeePrepaid(
        bytes32 indexed routeId,
        bytes32 indexed messageId,
        address indexed payer,
        uint256 amount
    );
    event RelayerRewardPaid(
        bytes32 indexed routeId,
        bytes32 indexed messageId,
        address indexed relayer,
        uint256 quotedFee,
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
        revert("USE_ROUTE_FUNDING");
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

    function fundRoute(bytes32 routeId) external payable {
        require(routeId != bytes32(0), "ROUTE_ZERO");
        require(msg.value > 0, "AMOUNT_ZERO");
        routeBalance[routeId] += msg.value;
        emit RouteFunded(routeId, msg.sender, msg.value);
    }

    function collectPrepaidFee(bytes32 routeId, bytes32 messageId)
        external
        payable
        onlyRole(COLLECTOR_ROLE)
    {
        require(routeId != bytes32(0), "ROUTE_ZERO");
        require(messageId != bytes32(0), "MESSAGE_ZERO");
        require(msg.value > 0, "AMOUNT_ZERO");

        routeBalance[routeId] += msg.value;
        emit FeePrepaid(routeId, messageId, msg.sender, msg.value);
    }

    function payRelayerReward(bytes32 routeId, bytes32 messageId, address payable relayer, uint256 quotedFee)
        external
        onlyRole(COLLECTOR_ROLE)
        returns (uint256 reward)
    {
        require(routeId != bytes32(0), "ROUTE_ZERO");
        require(messageId != bytes32(0), "MESSAGE_ZERO");
        require(relayer != address(0), "RELAYER_ZERO");

        reward = (quotedFee * relayerRewardBps) / BPS;
        if (reward == 0) {
            emit RelayerRewardPaid(routeId, messageId, relayer, quotedFee, 0);
            return 0;
        }

        require(routeBalance[routeId] >= reward, "INSUFFICIENT_ROUTE_FEES");
        routeBalance[routeId] -= reward;

        if (reward > 0) {
            (bool ok,) = relayer.call{value: reward}("");
            require(ok, "REWARD_TRANSFER_FAILED");
        }

        emit RelayerRewardPaid(routeId, messageId, relayer, quotedFee, reward);
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
