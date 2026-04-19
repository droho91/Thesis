// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IBankPolicyEngine} from "./IBankPolicyEngine.sol";

/// @title PolicyControlledEscrowVaultV2
/// @notice Canonical-asset escrow that applies institutional policy on unlock.
contract PolicyControlledEscrowVaultV2 is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant APP_ROLE = keccak256("APP_ROLE");

    IERC20 public immutable asset;
    IBankPolicyEngine public immutable policyEngine;
    uint256 public totalEscrowed;

    mapping(address => uint256) public escrowedBalance;
    mapping(bytes32 => bool) public processedUnlockPackets;

    error PolicyDenied(bytes32 policyCode);

    event Escrowed(address indexed from, uint256 amount);
    event Unescrowed(address indexed to, uint256 amount, uint256 indexed sourceChainId, bytes32 packetId);

    constructor(address admin, address asset_, address policyEngine_) {
        require(admin != address(0), "ADMIN_ZERO");
        require(asset_ != address(0), "ASSET_ZERO");
        require(policyEngine_ != address(0), "POLICY_ENGINE_ZERO");
        asset = IERC20(asset_);
        policyEngine = IBankPolicyEngine(policyEngine_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
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

    function unlockToWithPolicy(address to, uint256 sourceChainId, uint256 amount, bytes32 packetId)
        external
        onlyRole(APP_ROLE)
    {
        _unlockToWithPolicy(to, sourceChainId, amount, packetId, true);
    }

    function unlockToWithPolicyNoExposureReduction(address to, uint256 sourceChainId, uint256 amount, bytes32 packetId)
        external
        onlyRole(APP_ROLE)
    {
        _unlockToWithPolicy(to, sourceChainId, amount, packetId, false);
    }

    function _unlockToWithPolicy(address to, uint256 sourceChainId, uint256 amount, bytes32 packetId, bool reduceExposure)
        internal
    {
        require(to != address(0), "TO_ZERO");
        require(amount > 0, "AMOUNT_ZERO");
        require(packetId != bytes32(0), "PACKET_ZERO");
        require(!processedUnlockPackets[packetId], "UNLOCK_PACKET_PROCESSED");
        require(totalEscrowed >= amount, "INSUFFICIENT_ESCROW");

        (bool allowed, bytes32 code) = policyEngine.canUnlockCanonical(sourceChainId, to, address(asset), amount);
        if (!allowed) revert PolicyDenied(code);

        processedUnlockPackets[packetId] = true;
        totalEscrowed -= amount;
        if (escrowedBalance[to] >= amount) {
            escrowedBalance[to] -= amount;
        }
        asset.safeTransfer(to, amount);
        if (reduceExposure) {
            policyEngine.noteCanonicalUnlocked(sourceChainId, to, address(asset), amount);
        }
        emit Unescrowed(to, amount, sourceChainId, packetId);
    }
}
