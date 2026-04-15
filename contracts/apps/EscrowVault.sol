// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title EscrowVault
/// @notice Minimal source-chain escrow for canonical assets.
contract EscrowVault is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant APP_ROLE = keccak256("APP_ROLE");

    IERC20 public immutable asset;
    uint256 public totalEscrowed;
    mapping(address => uint256) public escrowedBalance;
    mapping(bytes32 => bool) public processedUnlockPackets;

    event Escrowed(address indexed from, uint256 amount);
    event Unescrowed(address indexed to, uint256 amount, bytes32 indexed packetId);

    constructor(address _asset) {
        require(_asset != address(0), "ASSET_ZERO");
        asset = IERC20(_asset);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function grantApp(address app) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(app != address(0), "APP_ZERO");
        _grantRole(APP_ROLE, app);
    }

    function lockFrom(address from, uint256 amount) external onlyRole(APP_ROLE) {
        require(from != address(0), "FROM_ZERO");
        require(amount > 0, "AMOUNT_ZERO");
        escrowedBalance[from] += amount;
        totalEscrowed += amount;
        asset.safeTransferFrom(from, address(this), amount);
        emit Escrowed(from, amount);
    }

    function unlockTo(address to, uint256 amount, bytes32 packetId) external onlyRole(APP_ROLE) {
        require(to != address(0), "TO_ZERO");
        require(amount > 0, "AMOUNT_ZERO");
        require(packetId != bytes32(0), "PACKET_ZERO");
        require(!processedUnlockPackets[packetId], "UNLOCK_PACKET_PROCESSED");
        require(totalEscrowed >= amount, "INSUFFICIENT_ESCROW");

        processedUnlockPackets[packetId] = true;
        totalEscrowed -= amount;
        if (escrowedBalance[to] >= amount) {
            escrowedBalance[to] -= amount;
        }
        asset.safeTransfer(to, amount);
        emit Unescrowed(to, amount, packetId);
    }
}
