// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {MessageLib} from "../bridge/MessageLib.sol";

/// @title RouteRegistry
/// @notice Stores route-level bridge configuration and asset mapping.
contract RouteRegistry is AccessControl {
    bytes32 public constant ROUTE_ADMIN_ROLE = keccak256("ROUTE_ADMIN_ROLE");
    uint16 public constant BPS = 10_000;

    struct RouteConfig {
        bool enabled;
        uint8 action;
        uint256 sourceChainId;
        uint256 destinationChainId;
        address sourceEmitter;
        address sourceSender;
        address sourceAsset;
        address target;
        uint256 flatFee;
        uint16 feeBps;
        uint256 transferCap;
        uint256 rateLimitAmount;
        uint256 rateLimitWindow;
        uint256 highValueThreshold;
    }

    mapping(bytes32 => RouteConfig) private routes;

    event RouteUpdated(
        bytes32 indexed routeId,
        uint8 indexed action,
        uint256 indexed sourceChainId,
        uint256 destinationChainId,
        address sourceEmitter,
        address sourceSender,
        address sourceAsset,
        address target,
        bool enabled
    );

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ROUTE_ADMIN_ROLE, msg.sender);
    }

    function setRoute(bytes32 routeId, RouteConfig calldata config) external onlyRole(ROUTE_ADMIN_ROLE) {
        require(routeId != bytes32(0), "ROUTE_ZERO");
        require(
            config.action == MessageLib.ACTION_LOCK_TO_MINT || config.action == MessageLib.ACTION_BURN_TO_UNLOCK,
            "BAD_ACTION"
        );
        require(config.sourceChainId != 0 && config.destinationChainId != 0, "CHAIN_ID_ZERO");
        require(config.sourceChainId != config.destinationChainId, "SAME_CHAIN");
        require(config.sourceEmitter != address(0), "EMITTER_ZERO");
        require(config.sourceSender != address(0), "SOURCE_SENDER_ZERO");
        require(config.sourceAsset != address(0), "SOURCE_ASSET_ZERO");
        require(config.target != address(0), "TARGET_ZERO");
        require(config.feeBps <= BPS, "FEE_TOO_HIGH");

        routes[routeId] = config;
        emit RouteUpdated(
            routeId,
            config.action,
            config.sourceChainId,
            config.destinationChainId,
            config.sourceEmitter,
            config.sourceSender,
            config.sourceAsset,
            config.target,
            config.enabled
        );
    }

    function getRoute(bytes32 routeId) external view returns (RouteConfig memory) {
        return routes[routeId];
    }

    function routeEnabled(bytes32 routeId) external view returns (bool) {
        return routes[routeId].enabled;
    }
}
