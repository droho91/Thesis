// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title VoucherLendingPool
/// @notice Minimal lending workload that uses IBC-lite vouchers as collateral.
/// @dev This is intentionally small: no oracle, liquidation, swaps, or interest model.
contract VoucherLendingPool is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant LENDING_ADMIN_ROLE = keccak256("LENDING_ADMIN_ROLE");
    uint256 public constant BPS = 10_000;

    IERC20 public immutable collateralVoucher;
    IERC20 public immutable stableToken;
    uint256 public collateralFactorBps;

    mapping(address => uint256) public collateralBalance;
    mapping(address => uint256) public debtBalance;

    event CollateralDeposited(address indexed user, uint256 amount);
    event CollateralWithdrawn(address indexed user, uint256 amount);
    event Borrowed(address indexed user, uint256 amount);
    event Repaid(address indexed user, uint256 amount);
    event CollateralFactorUpdated(uint256 oldFactorBps, uint256 newFactorBps);

    constructor(address _collateralVoucher, address _stableToken, uint256 _collateralFactorBps) {
        require(_collateralVoucher != address(0), "COLLATERAL_ZERO");
        require(_stableToken != address(0), "STABLE_ZERO");
        require(_collateralFactorBps > 0 && _collateralFactorBps <= BPS, "BAD_FACTOR");
        collateralVoucher = IERC20(_collateralVoucher);
        stableToken = IERC20(_stableToken);
        collateralFactorBps = _collateralFactorBps;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(LENDING_ADMIN_ROLE, msg.sender);
    }

    function setCollateralFactorBps(uint256 newFactorBps) external onlyRole(LENDING_ADMIN_ROLE) {
        require(newFactorBps > 0 && newFactorBps <= BPS, "BAD_FACTOR");
        uint256 oldFactorBps = collateralFactorBps;
        collateralFactorBps = newFactorBps;
        emit CollateralFactorUpdated(oldFactorBps, newFactorBps);
    }

    function maxBorrowable(address user) public view returns (uint256) {
        uint256 limit = (collateralBalance[user] * collateralFactorBps) / BPS;
        uint256 debt = debtBalance[user];
        if (limit <= debt) return 0;
        return limit - debt;
    }

    function depositCollateral(uint256 amount) external {
        require(amount > 0, "AMOUNT_ZERO");
        collateralBalance[msg.sender] += amount;
        collateralVoucher.safeTransferFrom(msg.sender, address(this), amount);
        emit CollateralDeposited(msg.sender, amount);
    }

    function withdrawCollateral(uint256 amount) external {
        require(amount > 0, "AMOUNT_ZERO");
        require(collateralBalance[msg.sender] >= amount, "INSUFFICIENT_COLLATERAL");
        collateralBalance[msg.sender] -= amount;
        require(debtBalance[msg.sender] <= (collateralBalance[msg.sender] * collateralFactorBps) / BPS, "LTV_EXCEEDED");
        collateralVoucher.safeTransfer(msg.sender, amount);
        emit CollateralWithdrawn(msg.sender, amount);
    }

    function borrow(uint256 amount) external {
        require(amount > 0, "AMOUNT_ZERO");
        require(amount <= maxBorrowable(msg.sender), "LTV_EXCEEDED");
        debtBalance[msg.sender] += amount;
        stableToken.safeTransfer(msg.sender, amount);
        emit Borrowed(msg.sender, amount);
    }

    function repay(uint256 amount) external {
        require(amount > 0, "AMOUNT_ZERO");
        uint256 debt = debtBalance[msg.sender];
        require(debt > 0, "NO_DEBT");
        uint256 repayAmount = amount > debt ? debt : amount;
        debtBalance[msg.sender] = debt - repayAmount;
        stableToken.safeTransferFrom(msg.sender, address(this), repayAmount);
        emit Repaid(msg.sender, repayAmount);
    }
}
