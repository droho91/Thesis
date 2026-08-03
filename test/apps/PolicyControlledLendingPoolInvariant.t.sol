// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {BankToken} from "../../contracts/apps/BankToken.sol";
import {BankPolicyEngine} from "../../contracts/apps/BankPolicyEngine.sol";
import {ManualAssetOracle} from "../../contracts/apps/ManualAssetOracle.sol";
import {PolicyControlledVoucherToken} from "../../contracts/apps/PolicyControlledVoucherToken.sol";
import {PolicyControlledLendingPool} from "../../contracts/apps/PolicyControlledLendingPool.sol";

/// @dev Bounded action surface for stateful lending-accounting exploration. Every externally
///      supplied value is reduced to an executable institutional action; expected business
///      rejections are caught so invariant depth is spent exploring state rather than reverts.
contract LendingPoolInvariantHandler is Test {
    uint256 internal constant MAX_ACTION_AMOUNT = 1_000 ether;
    uint256 internal constant MAX_TIME_STEP = 30 days;
    uint256 internal constant MIN_COLLATERAL_PRICE = 0.01 ether;
    uint256 internal constant MAX_COLLATERAL_PRICE = 2 ether;

    PolicyControlledLendingPool public immutable pool;
    BankPolicyEngine public immutable policy;
    ManualAssetOracle public immutable oracle;
    PolicyControlledVoucherToken public immutable voucher;
    BankToken public immutable debtAsset;

    address[3] internal _borrowers;
    address[2] internal _suppliers;
    address public immutable liquidator;
    address public immutable reserveManager;

    uint256 public successfulDebtTransitions;
    uint256 public defaultResolutionNonce;

    constructor(
        PolicyControlledLendingPool pool_,
        BankPolicyEngine policy_,
        ManualAssetOracle oracle_,
        PolicyControlledVoucherToken voucher_,
        BankToken debtAsset_,
        address[3] memory borrowers_,
        address[2] memory suppliers_,
        address liquidator_,
        address reserveManager_
    ) {
        pool = pool_;
        policy = policy_;
        oracle = oracle_;
        voucher = voucher_;
        debtAsset = debtAsset_;
        _borrowers = borrowers_;
        _suppliers = suppliers_;
        liquidator = liquidator_;
        reserveManager = reserveManager_;
    }

    function borrowerAt(uint256 index) external view returns (address) {
        return _borrowers[index];
    }

    function supplierAt(uint256 index) external view returns (address) {
        return _suppliers[index];
    }

    function depositCollateral(uint256 actorSeed, uint256 rawAmount) external {
        address actor = _borrower(actorSeed);
        uint256 balance = voucher.balanceOf(actor);
        if (balance == 0) return;

        uint256 amount = bound(rawAmount, 1, _min(balance, MAX_ACTION_AMOUNT));
        vm.prank(actor);
        try pool.depositCollateral(amount) {} catch {}
    }

    function withdrawCollateral(uint256 actorSeed, uint256 rawAmount) external {
        address actor = _borrower(actorSeed);
        uint256 deposited = pool.collateralBalance(actor);
        if (deposited == 0) return;

        uint256 amount = bound(rawAmount, 1, _min(deposited, MAX_ACTION_AMOUNT));
        vm.prank(actor);
        try pool.withdrawCollateral(amount) {} catch {}
    }

    function borrow(uint256 actorSeed, uint256 rawAmount) external {
        address actor = _borrower(actorSeed);
        if (policy.accountDefaulted(actor)) return;

        uint256 available;
        try pool.availableToBorrow(actor) returns (uint256 quotedAvailable) {
            available = _min(quotedAvailable, pool.availableLiquidity());
        } catch {
            return;
        }
        if (available == 0) return;

        uint256 amount = bound(rawAmount, 1, _min(available, MAX_ACTION_AMOUNT));
        vm.prank(actor);
        try pool.borrow(amount) {
            successfulDebtTransitions++;
        } catch {}
    }

    function repay(uint256 actorSeed, uint256 rawAmount) external {
        address actor = _borrower(actorSeed);
        uint256 debt = pool.debtOf(actor);
        uint256 balance = debtAsset.balanceOf(actor);
        uint256 maximum = _min(_min(debt, balance), MAX_ACTION_AMOUNT);
        if (maximum == 0) return;

        uint256 amount = bound(rawAmount, 1, maximum);
        vm.prank(actor);
        try pool.repay(amount) {
            successfulDebtTransitions++;
        } catch {}
    }

    function depositLiquidity(uint256 actorSeed, uint256 rawAmount) external {
        address actor = _supplier(actorSeed);
        uint256 balance = debtAsset.balanceOf(actor);
        if (balance == 0) return;

        uint256 amount = bound(rawAmount, 1, _min(balance, MAX_ACTION_AMOUNT));
        vm.prank(actor);
        try pool.depositLiquidity(amount) returns (uint256) {} catch {}
    }

    function withdrawLiquidity(uint256 actorSeed, uint256 rawAmount) external {
        address actor = _supplier(actorSeed);
        uint256 claim = pool.liquidityBalanceOf(actor);
        uint256 maximum = _min(_min(claim, pool.availableLiquidity()), MAX_ACTION_AMOUNT);
        if (maximum == 0) return;

        uint256 amount = bound(rawAmount, 1, maximum);
        vm.prank(actor);
        try pool.withdrawLiquidity(amount) returns (uint256) {} catch {}
    }

    function redeemLiquidity(uint256 actorSeed, uint256 rawShares) external {
        address actor = _supplier(actorSeed);
        uint256 shares = pool.liquidityShares(actor);
        if (shares == 0) return;

        uint256 shareAmount = bound(rawShares, 1, _min(shares, MAX_ACTION_AMOUNT));
        vm.prank(actor);
        try pool.redeemLiquidity(shareAmount) returns (uint256) {} catch {}
    }

    function advanceTime(uint256 rawElapsed) external {
        uint256 elapsed = bound(rawElapsed, 1, MAX_TIME_STEP);
        vm.warp(block.timestamp + elapsed);

        pool.accrueInterest();
        oracle.setPrice(address(voucher), oracle.assetPriceE18(address(voucher)));
        oracle.setPrice(address(debtAsset), oracle.assetPriceE18(address(debtAsset)));
        successfulDebtTransitions++;
    }

    function setCollateralPrice(uint256 rawPrice) external {
        oracle.setPrice(address(voucher), bound(rawPrice, MIN_COLLATERAL_PRICE, MAX_COLLATERAL_PRICE));
        oracle.setPrice(address(debtAsset), 1 ether);
    }

    function liquidate(uint256 actorSeed, uint256 rawRepayAmount) external {
        address borrower = _borrower(actorSeed);
        uint256 debt = pool.debtOf(borrower);
        if (debt == 0) return;

        uint256 request = bound(rawRepayAmount, 1, _min(debt, MAX_ACTION_AMOUNT));
        try pool.previewLiquidation(borrower, request) returns (
            PolicyControlledLendingPool.LiquidationPreview memory preview
        ) {
            if (!preview.executable || preview.actualRepayAmount == 0) return;
            vm.prank(liquidator);
            try pool.liquidate(borrower, request) {
                successfulDebtTransitions++;
            } catch {}
        } catch {}
    }

    function withdrawReserves(uint256 rawAmount) external {
        uint256 maximum = _min(_min(pool.totalReserves(), pool.totalCash()), MAX_ACTION_AMOUNT);
        if (maximum == 0) return;

        uint256 amount = bound(rawAmount, 1, maximum);
        vm.prank(reserveManager);
        try pool.withdrawReserves(reserveManager, amount) {} catch {}
    }

    function resolveDefault(uint256 actorSeed) external {
        address actor = _borrower(actorSeed);
        if (!policy.accountDefaulted(actor)) return;

        defaultResolutionNonce++;
        policy.resolveAccountDefault(
            actor,
            keccak256(abi.encode("INVARIANT_GOVERNANCE_RESOLUTION", actor, defaultResolutionNonce))
        );
    }

    function _borrower(uint256 seed) internal view returns (address) {
        return _borrowers[seed % _borrowers.length];
    }

    function _supplier(uint256 seed) internal view returns (address) {
        return _suppliers[seed % _suppliers.length];
    }

    function _min(uint256 left, uint256 right) internal pure returns (uint256) {
        return left < right ? left : right;
    }
}

contract PolicyControlledLendingPoolInvariantTest is StdInvariant, Test {
    uint256 internal constant SOURCE_CHAIN = 41_001;
    uint256 internal constant DEBT_ROUNDING_TOLERANCE_WEI = 10_000;

    BankPolicyEngine internal policy;
    ManualAssetOracle internal oracle;
    PolicyControlledVoucherToken internal voucher;
    PolicyControlledLendingPool internal pool;
    BankToken internal canonicalAsset;
    BankToken internal debtAsset;
    LendingPoolInvariantHandler internal handler;

    address[3] internal borrowers = [address(0xA11CE), address(0xB0B), address(0xCA401)];
    address[2] internal suppliers = [address(0x5151), address(0x5252)];
    address internal liquidator = address(0x119D8);
    address internal reserveManager = address(0x2E5E2E);

    function setUp() public {
        policy = new BankPolicyEngine(address(this));
        oracle = new ManualAssetOracle(address(this));
        canonicalAsset = new BankToken("Invariant canonical", "iCAN");
        debtAsset = new BankToken("Invariant debt", "iDEBT");
        voucher = new PolicyControlledVoucherToken(address(this), address(policy), "Invariant voucher", "ivCAN");
        pool = new PolicyControlledLendingPool(
            address(this), address(voucher), address(debtAsset), address(policy), 7_000, 8_000
        );

        voucher.grantApp(address(this));
        voucher.grantTransferOperator(address(pool));
        voucher.bindCanonicalAsset(address(canonicalAsset));
        policy.grantRole(policy.POLICY_APP_ROLE(), address(voucher));
        policy.grantRole(policy.POLICY_APP_ROLE(), address(pool));
        policy.setSourceChainAllowed(SOURCE_CHAIN, true);
        policy.setMintAssetAllowed(address(canonicalAsset), true);
        policy.setCollateralAssetAllowed(address(voucher), true);
        policy.setDebtAssetAllowed(address(debtAsset), true);
        policy.setDebtAssetOriginationPrincipalCap(address(debtAsset), 100_000 ether);

        oracle.setMaxStaleness(365 days);
        oracle.setPrice(address(voucher), 1 ether);
        oracle.setPrice(address(debtAsset), 1 ether);
        pool.setValuationOracle(address(oracle));
        pool.setInterestRateModel(500, 8_000, 1_500, 10_000);

        for (uint256 i = 0; i < borrowers.length; i++) {
            address borrower = borrowers[i];
            policy.setAccountAllowed(borrower, true);
            policy.setAccountOriginationPrincipalCap(borrower, 25_000 ether);
            voucher.mintWithPolicy(
                borrower,
                address(canonicalAsset),
                SOURCE_CHAIN,
                5_000 ether,
                keccak256(abi.encode("INVARIANT_VOUCHER", i))
            );
            debtAsset.mint(borrower, 10_000 ether);
            vm.startPrank(borrower);
            voucher.approve(address(pool), type(uint256).max);
            debtAsset.approve(address(pool), type(uint256).max);
            vm.stopPrank();
        }

        for (uint256 i = 0; i < suppliers.length; i++) {
            debtAsset.mint(suppliers[i], 10_000 ether);
            vm.prank(suppliers[i]);
            debtAsset.approve(address(pool), type(uint256).max);
        }

        debtAsset.mint(liquidator, 25_000 ether);
        vm.prank(liquidator);
        debtAsset.approve(address(pool), type(uint256).max);
        pool.grantRole(pool.LIQUIDATOR_ROLE(), liquidator);
        pool.grantRole(pool.RESERVE_MANAGER_ROLE(), reserveManager);

        vm.prank(suppliers[0]);
        pool.depositLiquidity(5_000 ether);

        handler = new LendingPoolInvariantHandler(
            pool,
            policy,
            oracle,
            voucher,
            debtAsset,
            borrowers,
            suppliers,
            liquidator,
            reserveManager
        );
        oracle.grantRole(oracle.ORACLE_ADMIN_ROLE(), address(handler));
        policy.grantRole(policy.POLICY_ADMIN_ROLE(), address(handler));

        bytes4[] memory selectors = new bytes4[](12);
        selectors[0] = LendingPoolInvariantHandler.depositCollateral.selector;
        selectors[1] = LendingPoolInvariantHandler.withdrawCollateral.selector;
        selectors[2] = LendingPoolInvariantHandler.borrow.selector;
        selectors[3] = LendingPoolInvariantHandler.repay.selector;
        selectors[4] = LendingPoolInvariantHandler.depositLiquidity.selector;
        selectors[5] = LendingPoolInvariantHandler.withdrawLiquidity.selector;
        selectors[6] = LendingPoolInvariantHandler.redeemLiquidity.selector;
        selectors[7] = LendingPoolInvariantHandler.advanceTime.selector;
        selectors[8] = LendingPoolInvariantHandler.setCollateralPrice.selector;
        selectors[9] = LendingPoolInvariantHandler.liquidate.selector;
        selectors[10] = LendingPoolInvariantHandler.withdrawReserves.selector;
        selectors[11] = LendingPoolInvariantHandler.resolveDefault.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariant_collateralTokenPoolAndPolicyLedgersStaySynchronized() public view {
        uint256 borrowerCollateral;
        for (uint256 i = 0; i < borrowers.length; i++) {
            borrowerCollateral += pool.collateralBalance(borrowers[i]);
        }

        assertEq(pool.totalCollateral(), borrowerCollateral, "pool collateral != borrower ledger");
        assertEq(voucher.balanceOf(address(pool)), borrowerCollateral, "voucher custody != pool collateral");
        assertEq(
            policy.collateralOutstanding(address(voucher)),
            borrowerCollateral,
            "policy collateral != pool collateral"
        );
    }

    function invariant_debtSharesAndPrincipalLedgersStaySynchronized() public view {
        uint256 borrowerDebtShares;
        uint256 borrowerPrincipal;
        uint256 borrowerDebtClaims;

        for (uint256 i = 0; i < borrowers.length; i++) {
            address borrower = borrowers[i];
            uint256 principal = pool.originationPrincipalDebt(borrower);
            uint256 debt = pool.debtOf(borrower);

            borrowerDebtShares += pool.debtShares(borrower);
            borrowerPrincipal += principal;
            borrowerDebtClaims += debt;
            assertEq(
                policy.accountOriginationPrincipalOutstanding(borrower),
                principal,
                "account principal != pool principal"
            );
            assertLe(principal, debt, "origination principal exceeds accrued debt");
        }

        assertEq(pool.totalDebtShares(), borrowerDebtShares, "global debt shares != borrower shares");
        assertEq(
            policy.debtAssetOriginationPrincipalOutstanding(address(debtAsset)),
            borrowerPrincipal,
            "asset principal != borrower principal"
        );

        uint256 aggregateDebt = pool.accruedTotalBorrows();
        uint256 debtDifference = aggregateDebt > borrowerDebtClaims
            ? aggregateDebt - borrowerDebtClaims
            : borrowerDebtClaims - aggregateDebt;
        assertLe(debtDifference, DEBT_ROUNDING_TOLERANCE_WEI, "debt-share rounding drift too large");
    }

    function invariant_activeSupplierSharesEqualGlobalShareSupply() public view {
        uint256 supplierShares;
        uint256 supplierClaims;
        for (uint256 i = 0; i < suppliers.length; i++) {
            supplierShares += pool.liquidityShares(suppliers[i]);
            supplierClaims += pool.liquidityBalanceOf(suppliers[i]);
        }

        assertEq(pool.totalLiquidityShares(), supplierShares, "global liquidity shares != supplier shares");
        if (supplierShares > 0) {
            uint256 assets = pool.totalAssets();
            assertLe(supplierClaims, assets, "supplier claims exceed pool assets");
            assertLe(assets - supplierClaims, suppliers.length, "supplier-claim rounding dust too large");
        }
    }

    function invariant_globalAccountingBoundsHold() public view {
        assertLe(pool.lastAccrualTimestamp(), block.timestamp, "accrual timestamp is in the future");
        assertGe(pool.borrowIndexE18(), 1 ether, "borrow index fell below its initial value");
        assertLe(pool.availableLiquidity(), pool.totalCash(), "available liquidity exceeds cash");
        assertLe(pool.utilizationRateBps(), pool.BPS(), "utilization exceeds 100 percent");
        assertLe(
            pool.totalReserves(),
            pool.totalCash() + pool.accruedTotalBorrows(),
            "reserve claim exceeds cash plus receivables"
        );
    }
}
