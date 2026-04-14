// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {RouteRegistry} from "./RouteRegistry.sol";

/// @title RiskManager
/// @notice Defense-in-depth route controls. It never replaces light-client proof verification.
contract RiskManager is AccessControl {
    bytes32 public constant RISK_ADMIN_ROLE = keccak256("RISK_ADMIN_ROLE");
    bytes32 public constant POLICY_CALLER_ROLE = keccak256("POLICY_CALLER_ROLE");
    bytes32 public constant SECONDARY_APPROVER_ROLE = keccak256("SECONDARY_APPROVER_ROLE");
    uint256 private constant BPS = 10_000;

    RouteRegistry public immutable routeRegistry;

    struct Window {
        uint256 windowStart;
        uint256 usedAmount;
    }

    mapping(bytes32 => bool) public routePaused;
    mapping(bytes32 => bool) public routeCursed;
    mapping(bytes32 => Window) public windows;
    mapping(bytes32 => mapping(bytes32 => bool)) public secondaryApproved;

    event RoutePaused(bytes32 indexed routeId, bool paused);
    event RouteCursed(bytes32 indexed routeId, bool cursed);
    event SecondaryApproval(bytes32 indexed routeId, bytes32 indexed messageId, address indexed approver);
    event RoutePolicyConsumed(bytes32 indexed routeId, bytes32 indexed messageId, uint256 amount, uint256 usedAmount);

    constructor(address _routeRegistry) {
        require(_routeRegistry != address(0), "ROUTE_REGISTRY_ZERO");
        routeRegistry = RouteRegistry(_routeRegistry);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(RISK_ADMIN_ROLE, msg.sender);
        _grantRole(SECONDARY_APPROVER_ROLE, msg.sender);
    }

    function grantPolicyCaller(address caller) external onlyRole(RISK_ADMIN_ROLE) {
        require(caller != address(0), "CALLER_ZERO");
        _grantRole(POLICY_CALLER_ROLE, caller);
    }

    function setRoutePaused(bytes32 routeId, bool paused) external onlyRole(RISK_ADMIN_ROLE) {
        routePaused[routeId] = paused;
        emit RoutePaused(routeId, paused);
    }

    function setRouteCursed(bytes32 routeId, bool cursed) external onlyRole(RISK_ADMIN_ROLE) {
        routeCursed[routeId] = cursed;
        emit RouteCursed(routeId, cursed);
    }

    function approveHighValue(bytes32 routeId, bytes32 messageId) external onlyRole(SECONDARY_APPROVER_ROLE) {
        require(routeId != bytes32(0), "ROUTE_ZERO");
        require(messageId != bytes32(0), "MESSAGE_ZERO");
        secondaryApproved[routeId][messageId] = true;
        emit SecondaryApproval(routeId, messageId, msg.sender);
    }

    function quoteFee(bytes32 routeId, uint256 amount) public view returns (uint256) {
        RouteRegistry.RouteConfig memory config = routeRegistry.getRoute(routeId);
        return config.flatFee + ((amount * config.feeBps) / BPS);
    }

    function validateAndConsume(bytes32 routeId, bytes32 messageId, uint256 amount)
        external
        onlyRole(POLICY_CALLER_ROLE)
        returns (uint256 fee)
    {
        RouteRegistry.RouteConfig memory config = routeRegistry.getRoute(routeId);
        require(config.enabled, "ROUTE_DISABLED");
        require(!routePaused[routeId], "ROUTE_PAUSED");
        require(!routeCursed[routeId], "ROUTE_CURSED");
        require(amount > 0, "AMOUNT_ZERO");

        if (config.transferCap > 0) {
            require(amount <= config.transferCap, "TRANSFER_CAP_EXCEEDED");
        }

        if (config.highValueThreshold > 0 && amount >= config.highValueThreshold) {
            require(secondaryApproved[routeId][messageId], "SECONDARY_APPROVAL_REQUIRED");
        }

        if (config.rateLimitAmount > 0 && config.rateLimitWindow > 0) {
            Window storage window = windows[routeId];
            if (window.windowStart == 0 || block.timestamp >= window.windowStart + config.rateLimitWindow) {
                window.windowStart = block.timestamp;
                window.usedAmount = 0;
            }

            require(window.usedAmount + amount <= config.rateLimitAmount, "RATE_LIMIT_EXCEEDED");
            window.usedAmount += amount;
            emit RoutePolicyConsumed(routeId, messageId, amount, window.usedAmount);
        } else {
            emit RoutePolicyConsumed(routeId, messageId, amount, amount);
        }

        return quoteFee(routeId, amount);
    }
}
