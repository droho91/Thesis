// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {BankToken} from "../../contracts/apps/BankToken.sol";
import {BankPolicyEngine} from "../../contracts/apps/BankPolicyEngine.sol";
import {ManualAssetOracle} from "../../contracts/apps/ManualAssetOracle.sol";
import {PolicyControlledVoucherToken} from "../../contracts/apps/PolicyControlledVoucherToken.sol";
import {PolicyControlledEscrowVault} from "../../contracts/apps/PolicyControlledEscrowVault.sol";
import {PolicyControlledLendingPool} from "../../contracts/apps/PolicyControlledLendingPool.sol";

contract FeeOnTransferToken is ERC20 {
    uint256 internal constant FEE_BPS = 1_000;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value * FEE_BPS / 10_000;
            super._update(from, to, value - fee);
            if (fee > 0) super._update(from, address(0), fee);
            return;
        }
        super._update(from, to, value);
    }
}

contract BankPolicyTest is Test {
    uint256 internal constant SOURCE_CHAIN_A = 41001;
    uint256 internal constant COLLATERAL_FACTOR_BPS = 7_000;
    uint256 internal constant LIQUIDATION_THRESHOLD_BPS = 8_000;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal supplier = address(0x5151);
    bytes32 internal constant PACKET_ONE = bytes32(uint256(1));
    bytes32 internal constant PACKET_TWO = bytes32(uint256(2));

    BankPolicyEngine internal policy;
    ManualAssetOracle internal oracle;
    PolicyControlledVoucherToken internal voucher;
    PolicyControlledEscrowVault internal escrow;
    PolicyControlledLendingPool internal lendingPool;
    BankToken internal canonicalAsset;
    BankToken internal debtAsset;

    function setUp() public {
        policy = new BankPolicyEngine(address(this));
        oracle = new ManualAssetOracle(address(this));
        canonicalAsset = new BankToken("Canonical", "CAN");
        debtAsset = new BankToken("Debt", "DEBT");

        voucher = new PolicyControlledVoucherToken(address(this), address(policy), "Voucher", "vCAN");
        escrow = new PolicyControlledEscrowVault(address(this), address(canonicalAsset), address(policy));
        lendingPool = new PolicyControlledLendingPool(
            address(this),
            address(voucher),
            address(debtAsset),
            address(policy),
            COLLATERAL_FACTOR_BPS,
            LIQUIDATION_THRESHOLD_BPS
        );

        voucher.grantApp(address(this));
        voucher.grantTransferOperator(address(lendingPool));
        voucher.bindCanonicalAsset(address(canonicalAsset));
        escrow.grantApp(address(this));

        policy.grantRole(policy.POLICY_APP_ROLE(), address(voucher));
        policy.grantRole(policy.POLICY_APP_ROLE(), address(escrow));
        policy.grantRole(policy.POLICY_APP_ROLE(), address(lendingPool));

        policy.setAccountAllowed(alice, true);
        policy.setSourceChainAllowed(SOURCE_CHAIN_A, true);
        policy.setMintAssetAllowed(address(canonicalAsset), true);
        policy.setUnlockAssetAllowed(address(canonicalAsset), true);
        policy.setCollateralAssetAllowed(address(voucher), true);
        policy.setDebtAssetAllowed(address(debtAsset), true);
        oracle.setPrice(address(voucher), 1 ether);
        oracle.setPrice(address(debtAsset), 1 ether);
        lendingPool.setValuationOracle(address(oracle));
    }

    function testMintVoucherWithPolicyUpdatesExposureAndRespectsCap() public {
        policy.setVoucherExposureCap(address(canonicalAsset), 100 ether);

        voucher.mintWithPolicy(alice, address(canonicalAsset), SOURCE_CHAIN_A, 60 ether, PACKET_ONE);
        assertEq(voucher.balanceOf(alice), 60 ether);
        assertEq(policy.voucherExposureOutstanding(address(canonicalAsset)), 60 ether);

        vm.expectRevert(abi.encodeWithSelector(PolicyControlledVoucherToken.PolicyDenied.selector, policy.POLICY_VOUCHER_CAP_EXCEEDED()));
        voucher.mintWithPolicy(alice, address(canonicalAsset), SOURCE_CHAIN_A, 50 ether, PACKET_TWO);
    }

    function testVoucherCannotBeTransferredOutsideApprovedInstitutionalOperator() public {
        voucher.mintWithPolicy(alice, address(canonicalAsset), SOURCE_CHAIN_A, 10 ether, PACKET_ONE);

        vm.prank(alice);
        vm.expectRevert(bytes("VOUCHER_TRANSFER_RESTRICTED"));
        voucher.transfer(address(0xB0B), 1 ether);

        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 10 ether);
        lendingPool.depositCollateral(10 ether);
        vm.stopPrank();
        assertEq(voucher.balanceOf(address(lendingPool)), 10 ether);
    }

    function testUnlockCanonicalWithPolicyReducesTrackedExposure() public {
        canonicalAsset.mint(alice, 100 ether);
        vm.startPrank(alice);
        canonicalAsset.approve(address(escrow), 80 ether);
        vm.stopPrank();

        voucher.mintWithPolicy(alice, address(canonicalAsset), SOURCE_CHAIN_A, 80 ether, PACKET_TWO);
        escrow.lockFrom(alice, 80 ether);
        assertEq(policy.voucherExposureOutstanding(address(canonicalAsset)), 80 ether);

        escrow.unlockToWithPolicy(alice, SOURCE_CHAIN_A, 50 ether, PACKET_ONE);

        assertEq(canonicalAsset.balanceOf(alice), 70 ether);
        assertEq(escrow.totalEscrowed(), 30 ether);
        assertEq(policy.voucherExposureOutstanding(address(canonicalAsset)), 30 ether);
    }

    function testCanonicalUnlockUnderflowReverts() public {
        policy.grantRole(policy.POLICY_APP_ROLE(), address(this));

        vm.expectRevert(bytes("VOUCHER_EXPOSURE_UNDERFLOW"));
        policy.noteCanonicalUnlocked(SOURCE_CHAIN_A, alice, address(canonicalAsset), 1 ether);
    }

    function testDirectCanonicalUnlockDecreasesExposureExactly() public {
        policy.grantRole(policy.POLICY_APP_ROLE(), address(this));

        policy.noteVoucherMinted(SOURCE_CHAIN_A, alice, address(canonicalAsset), 80 ether);
        policy.noteCanonicalUnlocked(SOURCE_CHAIN_A, alice, address(canonicalAsset), 30 ether);

        assertEq(policy.voucherExposureOutstanding(address(canonicalAsset)), 50 ether);
    }

    function testExposureRemainsConsistentAcrossMintBurnUnlockSequence() public {
        policy.grantRole(policy.POLICY_APP_ROLE(), address(this));

        policy.noteVoucherMinted(SOURCE_CHAIN_A, alice, address(canonicalAsset), 100 ether);
        policy.noteVoucherBurned(alice, address(canonicalAsset), 25 ether);
        policy.noteCanonicalUnlocked(SOURCE_CHAIN_A, alice, address(canonicalAsset), 15 ether);

        assertEq(policy.voucherExposureOutstanding(address(canonicalAsset)), 60 ether);
    }

    function testEscrowRejectsFeeOnTransferCanonicalAsset() public {
        FeeOnTransferToken feeToken = new FeeOnTransferToken("Fee Canonical", "fCAN");
        BankPolicyEngine feePolicy = new BankPolicyEngine(address(this));
        PolicyControlledEscrowVault feeEscrow =
            new PolicyControlledEscrowVault(address(this), address(feeToken), address(feePolicy));
        feeEscrow.grantApp(address(this));
        feeToken.mint(alice, 100 ether);

        vm.prank(alice);
        feeToken.approve(address(feeEscrow), 10 ether);

        vm.expectRevert(bytes("FEE_ON_TRANSFER_UNSUPPORTED"));
        feeEscrow.lockFrom(alice, 10 ether);

        assertEq(feeEscrow.totalEscrowed(), 0);
        assertEq(feeToken.balanceOf(address(feeEscrow)), 0);
    }

    function testLendingPoolRejectsFeeOnTransferDebtDeposits() public {
        FeeOnTransferToken feeDebt = new FeeOnTransferToken("Fee Debt", "fDEBT");
        PolicyControlledLendingPool feePool = new PolicyControlledLendingPool(
            address(this),
            address(voucher),
            address(feeDebt),
            address(policy),
            COLLATERAL_FACTOR_BPS,
            LIQUIDATION_THRESHOLD_BPS
        );
        feeDebt.mint(supplier, 100 ether);

        vm.startPrank(supplier);
        feeDebt.approve(address(feePool), 100 ether);
        vm.expectRevert(bytes("FEE_ON_TRANSFER_UNSUPPORTED"));
        feePool.depositLiquidity(100 ether);
        vm.stopPrank();

        assertEq(feePool.totalLiquidityShares(), 0);
        assertEq(feeDebt.balanceOf(address(feePool)), 0);
    }

    function testDepositCollateralRequiresPolicyAllowlist() public {
        policy.setAccountAllowed(bob, true);
        voucher.mintWithPolicy(bob, address(canonicalAsset), SOURCE_CHAIN_A, 100 ether, PACKET_ONE);
        policy.setAccountAllowed(bob, false);

        vm.startPrank(bob);
        voucher.approve(address(lendingPool), 100 ether);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyControlledLendingPool.PolicyDenied.selector, policy.POLICY_ACCOUNT_NOT_ALLOWED())
        );
        lendingPool.depositCollateral(100 ether);
        vm.stopPrank();
    }

    function testBorrowRespectsAccountAndAssetCaps() public {
        policy.setAccountBorrowCap(alice, 50 ether);
        policy.setDebtAssetBorrowCap(address(debtAsset), 100 ether);

        voucher.mintWithPolicy(alice, address(canonicalAsset), SOURCE_CHAIN_A, 100 ether, PACKET_ONE);
        debtAsset.mint(address(this), 100 ether);
        debtAsset.approve(address(lendingPool), 100 ether);
        lendingPool.depositLiquidity(100 ether);

        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 100 ether);
        lendingPool.depositCollateral(100 ether);
        lendingPool.borrow(40 ether);
        vm.stopPrank();

        assertEq(lendingPool.debtBalance(alice), 40 ether);
        assertEq(policy.accountDebtOutstanding(alice, address(debtAsset)), 40 ether);
        assertEq(policy.debtAssetOutstanding(address(debtAsset)), 40 ether);

        vm.startPrank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyControlledLendingPool.PolicyDenied.selector, policy.POLICY_ACCOUNT_BORROW_CAP_EXCEEDED()
            )
        );
        lendingPool.borrow(20 ether);
        vm.stopPrank();
    }

    function testRepayAndWithdrawUpdatePolicyAccounting() public {
        policy.setAccountBorrowCap(alice, 50 ether);
        policy.setDebtAssetBorrowCap(address(debtAsset), 100 ether);

        voucher.mintWithPolicy(alice, address(canonicalAsset), SOURCE_CHAIN_A, 100 ether, PACKET_ONE);
        debtAsset.mint(address(this), 100 ether);
        debtAsset.mint(alice, 50 ether);
        debtAsset.approve(address(lendingPool), 100 ether);
        lendingPool.depositLiquidity(100 ether);

        vm.startPrank(alice);
        voucher.approve(address(lendingPool), 100 ether);
        lendingPool.depositCollateral(100 ether);
        lendingPool.borrow(40 ether);
        debtAsset.approve(address(lendingPool), 15 ether);
        lendingPool.repay(15 ether);
        lendingPool.withdrawCollateral(20 ether);
        vm.stopPrank();

        assertEq(lendingPool.debtBalance(alice), 25 ether);
        assertEq(lendingPool.collateralBalance(alice), 80 ether);
        assertEq(policy.debtAssetOutstanding(address(debtAsset)), 25 ether);
        assertEq(policy.accountDebtOutstanding(alice, address(debtAsset)), 25 ether);
        assertEq(policy.collateralOutstanding(address(voucher)), 80 ether);
    }
}
