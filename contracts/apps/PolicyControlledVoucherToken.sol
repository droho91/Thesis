// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IBankPolicyEngine} from "./IBankPolicyEngine.sol";

/// @title PolicyControlledVoucherToken
/// @notice Voucher token that only mints when the bank policy engine approves the remote claim.
contract PolicyControlledVoucherToken is ERC20, AccessControl {
    bytes32 public constant APP_ROLE = keccak256("APP_ROLE");

    IBankPolicyEngine public immutable policyEngine;
    mapping(bytes32 => bool) public processedMintPackets;

    error PolicyDenied(bytes32 policyCode);

    event VoucherMinted(address indexed to, address indexed canonicalAsset, uint256 amount, uint256 indexed sourceChainId, bytes32 packetId);
    event VoucherBurned(address indexed from, uint256 amount);

    constructor(address admin, address policyEngine_, string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        require(admin != address(0), "ADMIN_ZERO");
        require(policyEngine_ != address(0), "POLICY_ENGINE_ZERO");
        policyEngine = IBankPolicyEngine(policyEngine_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function grantApp(address app) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(app != address(0), "APP_ZERO");
        _grantRole(APP_ROLE, app);
    }

    function mintWithPolicy(address to, address canonicalAsset, uint256 sourceChainId, uint256 amount, bytes32 packetId)
        external
        onlyRole(APP_ROLE)
    {
        require(to != address(0), "TO_ZERO");
        require(canonicalAsset != address(0), "ASSET_ZERO");
        require(amount > 0, "AMOUNT_ZERO");
        require(packetId != bytes32(0), "PACKET_ZERO");
        require(!processedMintPackets[packetId], "MINT_PACKET_PROCESSED");

        (bool allowed, bytes32 code) = policyEngine.canMintVoucher(sourceChainId, to, canonicalAsset, amount);
        if (!allowed) revert PolicyDenied(code);

        processedMintPackets[packetId] = true;
        _mint(to, amount);
        policyEngine.noteVoucherMinted(sourceChainId, to, canonicalAsset, amount);
        emit VoucherMinted(to, canonicalAsset, amount, sourceChainId, packetId);
    }

    function burnFrom(address from, uint256 amount) external onlyRole(APP_ROLE) {
        require(from != address(0), "FROM_ZERO");
        require(amount > 0, "AMOUNT_ZERO");
        _burn(from, amount);
        emit VoucherBurned(from, amount);
    }

    function burnFromWithPolicy(address from, address canonicalAsset, uint256 amount) external onlyRole(APP_ROLE) {
        require(canonicalAsset != address(0), "ASSET_ZERO");
        require(from != address(0), "FROM_ZERO");
        require(amount > 0, "AMOUNT_ZERO");
        _burn(from, amount);
        policyEngine.noteVoucherBurned(from, canonicalAsset, amount);
        emit VoucherBurned(from, amount);
    }
}
