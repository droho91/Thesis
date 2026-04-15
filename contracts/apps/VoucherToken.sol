// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title VoucherToken
/// @notice ERC20 voucher minted for assets escrowed on a remote source chain.
contract VoucherToken is ERC20, AccessControl {
    bytes32 public constant APP_ROLE = keccak256("APP_ROLE");

    mapping(bytes32 => bool) public processedMintPackets;

    event VoucherMinted(address indexed to, uint256 amount, bytes32 indexed packetId);
    event VoucherBurned(address indexed from, uint256 amount);

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function grantApp(address app) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(app != address(0), "APP_ZERO");
        _grantRole(APP_ROLE, app);
    }

    function mint(address to, uint256 amount, bytes32 packetId) external onlyRole(APP_ROLE) {
        require(to != address(0), "TO_ZERO");
        require(amount > 0, "AMOUNT_ZERO");
        require(packetId != bytes32(0), "PACKET_ZERO");
        require(!processedMintPackets[packetId], "MINT_PACKET_PROCESSED");

        processedMintPackets[packetId] = true;
        _mint(to, amount);
        emit VoucherMinted(to, amount, packetId);
    }

    function burnFrom(address from, uint256 amount) external onlyRole(APP_ROLE) {
        require(from != address(0), "FROM_ZERO");
        require(amount > 0, "AMOUNT_ZERO");
        _burn(from, amount);
        emit VoucherBurned(from, amount);
    }
}
