// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IAssetOracle} from "./IAssetOracle.sol";

/// @title ManualAssetOracle
/// @notice Admin-set normalized oracle for tests, demos, and explicit integration boundaries.
contract ManualAssetOracle is AccessControl, IAssetOracle {
    bytes32 public constant ORACLE_ADMIN_ROLE = keccak256("ORACLE_ADMIN_ROLE");

    mapping(address => uint256) public assetPriceE18;

    event AssetPriceSet(address indexed asset, uint256 priceE18);

    constructor(address admin) {
        require(admin != address(0), "ADMIN_ZERO");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ORACLE_ADMIN_ROLE, admin);
    }

    function setPrice(address asset, uint256 priceE18) external onlyRole(ORACLE_ADMIN_ROLE) {
        require(asset != address(0), "ASSET_ZERO");
        require(priceE18 > 0, "PRICE_ZERO");
        assetPriceE18[asset] = priceE18;
        emit AssetPriceSet(asset, priceE18);
    }

    function priceOf(address asset) external view returns (uint256 priceE18) {
        priceE18 = assetPriceE18[asset];
        require(priceE18 > 0, "PRICE_NOT_SET");
    }
}
