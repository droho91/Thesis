// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title LendingPool
/// @notice Simple lending pool using wrapped collateral and a stable token.
/// @dev Fixed LTV, no interest, no liquidation (for academic prototype).
contract LendingPool {
    IERC20 public collateralToken;
    IERC20 public stableToken;

    uint256 public constant BPS = 10_000;
    uint256 public collateralFactorBps;

    struct Position {
        uint256 collateralAmount;
        uint256 debtAmount;
    }

    mapping(address => Position) public positions;

    event CollateralDeposited(address indexed user, uint256 amount);
    event CollateralWithdrawn(address indexed user, uint256 amount);
    event Borrowed(address indexed user, uint256 amount);
    event Repaid(address indexed user, uint256 amount);

    constructor(address _collateralToken, address _stableToken, uint256 _collateralFactorBps) {
        require(_collateralToken != address(0), "COLLATERAL_ZERO");
        require(_stableToken != address(0), "STABLE_ZERO");
        require(_collateralFactorBps > 0 && _collateralFactorBps <= BPS, "BAD_FACTOR");
        collateralToken = IERC20(_collateralToken);
        stableToken = IERC20(_stableToken);
        collateralFactorBps = _collateralFactorBps;
    }

    /// @notice Deposit wrapped collateral into the lending pool.
    function depositCollateral(uint256 amount) external {
        require(amount > 0, "AMOUNT_ZERO");
        require(collateralToken.transferFrom(msg.sender, address(this), amount), "TRANSFER_FAILED");
        positions[msg.sender].collateralAmount += amount;
        emit CollateralDeposited(msg.sender, amount);
    }

    /// @notice Withdraw collateral if position remains within LTV.
    function withdrawCollateral(uint256 amount) external {
        require(amount > 0, "AMOUNT_ZERO");
        Position storage p = positions[msg.sender];
        require(p.collateralAmount >= amount, "INSUFFICIENT_COLLATERAL");

        uint256 newCollateral = p.collateralAmount - amount;
        uint256 maxBorrowAfter = (newCollateral * collateralFactorBps) / BPS;
        require(p.debtAmount <= maxBorrowAfter, "LTV_EXCEEDED");

        p.collateralAmount = newCollateral;
        require(collateralToken.transfer(msg.sender, amount), "TRANSFER_FAILED");
        emit CollateralWithdrawn(msg.sender, amount);
    }

    /// @notice Borrow stable tokens if position remains within LTV.
    function borrow(uint256 amount) external {
        require(amount > 0, "AMOUNT_ZERO");
        Position storage p = positions[msg.sender];
        uint256 maxBorrow = (p.collateralAmount * collateralFactorBps) / BPS;
        require(p.debtAmount + amount <= maxBorrow, "LTV_EXCEEDED");

        p.debtAmount += amount;
        require(stableToken.transfer(msg.sender, amount), "TRANSFER_FAILED");
        emit Borrowed(msg.sender, amount);
    }

    /// @notice Repay stable debt.
    function repay(uint256 amount) external {
        require(amount > 0, "AMOUNT_ZERO");
        Position storage p = positions[msg.sender];
        require(p.debtAmount >= amount, "REPAY_TOO_MUCH");

        require(stableToken.transferFrom(msg.sender, address(this), amount), "TRANSFER_FAILED");
        p.debtAmount -= amount;
        emit Repaid(msg.sender, amount);
    }
}
