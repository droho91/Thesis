// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title CrossChainLendingPool
/// @notice Minimal lending use case: verified remote-asset vouchers become collateral for local bank liquidity.
contract CrossChainLendingPool is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant RISK_ADMIN_ROLE = keccak256("RISK_ADMIN_ROLE");
    uint256 public constant BPS = 10_000;

    IERC20 public immutable collateralToken;
    IERC20 public immutable debtToken;
    uint256 public collateralFactorBps;
    uint256 public totalCollateral;
    uint256 public totalDebt;

    mapping(address => uint256) public collateralBalance;
    mapping(address => uint256) public debtBalance;

    event CollateralDeposited(address indexed user, uint256 amount);
    event CollateralWithdrawn(address indexed user, uint256 amount);
    event Borrowed(address indexed user, uint256 amount);
    event Repaid(address indexed user, uint256 amount);
    event CollateralFactorUpdated(uint256 oldFactorBps, uint256 newFactorBps);

    constructor(address _collateralToken, address _debtToken, uint256 _collateralFactorBps) {
        require(_collateralToken != address(0), "COLLATERAL_ZERO");
        require(_debtToken != address(0), "DEBT_ZERO");
        require(_collateralFactorBps <= BPS, "BAD_COLLATERAL_FACTOR");

        collateralToken = IERC20(_collateralToken);
        debtToken = IERC20(_debtToken);
        collateralFactorBps = _collateralFactorBps;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(RISK_ADMIN_ROLE, msg.sender);
    }

    function setCollateralFactor(uint256 newFactorBps) external onlyRole(RISK_ADMIN_ROLE) {
        require(newFactorBps <= BPS, "BAD_COLLATERAL_FACTOR");
        uint256 oldFactor = collateralFactorBps;
        collateralFactorBps = newFactorBps;
        emit CollateralFactorUpdated(oldFactor, newFactorBps);
    }

    function depositCollateral(uint256 amount) external {
        require(amount > 0, "AMOUNT_ZERO");
        collateralBalance[msg.sender] += amount;
        totalCollateral += amount;
        collateralToken.safeTransferFrom(msg.sender, address(this), amount);
        emit CollateralDeposited(msg.sender, amount);
    }

    function withdrawCollateral(uint256 amount) external {
        require(amount > 0, "AMOUNT_ZERO");
        uint256 currentCollateral = collateralBalance[msg.sender];
        require(currentCollateral >= amount, "INSUFFICIENT_COLLATERAL");

        uint256 remainingCollateral = currentCollateral - amount;
        require(_maxBorrow(remainingCollateral) >= debtBalance[msg.sender], "POSITION_UNHEALTHY");

        collateralBalance[msg.sender] = remainingCollateral;
        totalCollateral -= amount;
        collateralToken.safeTransfer(msg.sender, amount);
        emit CollateralWithdrawn(msg.sender, amount);
    }

    function borrow(uint256 amount) external {
        require(amount > 0, "AMOUNT_ZERO");
        require(availableToBorrow(msg.sender) >= amount, "BORROW_LIMIT");
        require(debtToken.balanceOf(address(this)) >= amount, "POOL_LIQUIDITY");

        debtBalance[msg.sender] += amount;
        totalDebt += amount;
        debtToken.safeTransfer(msg.sender, amount);
        emit Borrowed(msg.sender, amount);
    }

    function repay(uint256 amount) external {
        require(amount > 0, "AMOUNT_ZERO");
        uint256 currentDebt = debtBalance[msg.sender];
        require(currentDebt > 0, "NO_DEBT");
        uint256 payment = amount > currentDebt ? currentDebt : amount;

        debtBalance[msg.sender] = currentDebt - payment;
        totalDebt -= payment;
        debtToken.safeTransferFrom(msg.sender, address(this), payment);
        emit Repaid(msg.sender, payment);
    }

    function maxBorrow(address user) external view returns (uint256) {
        return _maxBorrow(collateralBalance[user]);
    }

    function availableToBorrow(address user) public view returns (uint256) {
        uint256 ceiling = _maxBorrow(collateralBalance[user]);
        uint256 debt = debtBalance[user];
        return ceiling > debt ? ceiling - debt : 0;
    }

    function _maxBorrow(uint256 collateralAmount) internal view returns (uint256) {
        return collateralAmount * collateralFactorBps / BPS;
    }
}
