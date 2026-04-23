// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IAssetOracle} from "./IAssetOracle.sol";

/// @title ManualAssetOracle
/// @notice Admin-set normalized oracle for tests, demos, and explicit integration boundaries.
contract ManualAssetOracle is AccessControl, IAssetOracle {
    bytes32 public constant ORACLE_ADMIN_ROLE = keccak256("ORACLE_ADMIN_ROLE");
    uint256 public constant MAX_STALENESS_UPPER_BOUND = 365 days;

    mapping(address => uint256) public assetPriceE18;
    mapping(address => uint256) public assetPriceUpdatedAt;
    uint256 public maxStaleness;

    event AssetPriceSet(address indexed asset, uint256 priceE18, uint256 updatedAt);
    event MaxStalenessUpdated(uint256 oldMaxStaleness, uint256 newMaxStaleness);

    constructor(address admin) {
        require(admin != address(0), "ADMIN_ZERO");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ORACLE_ADMIN_ROLE, admin);
        maxStaleness = 1 days;
    }

    function setPrice(address asset, uint256 priceE18) external onlyRole(ORACLE_ADMIN_ROLE) {
        require(asset != address(0), "ASSET_ZERO");
        require(priceE18 > 0, "PRICE_ZERO");
        assetPriceE18[asset] = priceE18;
        assetPriceUpdatedAt[asset] = block.timestamp;
        emit AssetPriceSet(asset, priceE18, block.timestamp);
    }

    function setMaxStaleness(uint256 newMaxStaleness) external onlyRole(ORACLE_ADMIN_ROLE) {
        require(newMaxStaleness > 0 && newMaxStaleness <= MAX_STALENESS_UPPER_BOUND, "BAD_MAX_STALENESS");
        uint256 oldMaxStaleness = maxStaleness;
        maxStaleness = newMaxStaleness;
        emit MaxStalenessUpdated(oldMaxStaleness, newMaxStaleness);
    }

    function priceOf(address asset) external view returns (uint256 priceE18) {
        priceE18 = assetPriceE18[asset];
        require(priceE18 > 0, "PRICE_NOT_SET");
        require(block.timestamp - assetPriceUpdatedAt[asset] <= maxStaleness, "PRICE_STALE");
    }
}
