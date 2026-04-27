// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BankToken} from "../../contracts/apps/BankToken.sol";
import {BankPolicyEngine} from "../../contracts/apps/BankPolicyEngine.sol";
import {ManualAssetOracle} from "../../contracts/apps/ManualAssetOracle.sol";
import {PolicyControlledVoucherToken} from "../../contracts/apps/PolicyControlledVoucherToken.sol";
import {PolicyControlledEscrowVault} from "../../contracts/apps/PolicyControlledEscrowVault.sol";
import {PolicyControlledLendingPool} from "../../contracts/apps/PolicyControlledLendingPool.sol";
import {PolicyControlledTransferApp} from "../../contracts/apps/PolicyControlledTransferApp.sol";
import {IBCPacketStore} from "../../contracts/core/IBCPacketStore.sol";
import {IBCPacketLib} from "../../contracts/core/IBCPacketLib.sol";

contract PolicyTransferAppTest is Test {
    uint256 internal constant CHAIN_A = 41001;
    uint256 internal constant CHAIN_B = 41002;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal liquidator = address(0x119D8);
    address internal outsider = address(0xBAD);
    address internal packetHandlerA = address(0x1001);
    address internal packetHandlerB = address(0x1002);

    bytes32 internal constant CHANNEL_A = bytes32("channel-a");
    bytes32 internal constant CHANNEL_B = bytes32("channel-b");

    BankToken internal canonicalAsset;
    BankPolicyEngine internal policyA;
    BankPolicyEngine internal policyB;
    PolicyControlledVoucherToken internal voucherB;
    PolicyControlledEscrowVault internal escrowA;
    IBCPacketStore internal packetStoreA;
    IBCPacketStore internal packetStoreB;
    PolicyControlledTransferApp internal appA;
    PolicyControlledTransferApp internal appB;

    function setUp() public {
        canonicalAsset = new BankToken("Canonical", "CAN");

        policyA = new BankPolicyEngine(address(this));
        policyB = new BankPolicyEngine(address(this));

        escrowA = new PolicyControlledEscrowVault(address(this), address(canonicalAsset), address(policyA));
        voucherB = new PolicyControlledVoucherToken(address(this), address(policyB), "Voucher", "vCAN");

        packetStoreA = new IBCPacketStore(CHAIN_A);
        packetStoreB = new IBCPacketStore(CHAIN_B);

        appA = new PolicyControlledTransferApp(
            CHAIN_A, address(packetStoreA), packetHandlerA, address(escrowA), address(0), address(this)
        );
        appB = new PolicyControlledTransferApp(
            CHAIN_B, address(packetStoreB), packetHandlerB, address(0), address(voucherB), address(this)
        );

        escrowA.grantApp(address(appA));
        voucherB.grantApp(address(appB));
        voucherB.bindCanonicalAsset(address(canonicalAsset));
        packetStoreA.setPacketWriter(address(appA), true);
        packetStoreB.setPacketWriter(address(appB), true);

        policyA.grantRole(policyA.POLICY_APP_ROLE(), address(escrowA));
        policyB.grantRole(policyB.POLICY_APP_ROLE(), address(voucherB));

        appA.configureRemoteRoute(CHAIN_B, address(appB), CHANNEL_A, CHANNEL_B, address(canonicalAsset));
        appB.configureRemoteRoute(CHAIN_A, address(appA), CHANNEL_B, CHANNEL_A, address(canonicalAsset));

        policyA.setAccountAllowed(alice, true);
        policyA.setAccountAllowed(bob, true);
        policyA.setAccountAllowed(liquidator, true);
        policyA.setSourceChainAllowed(CHAIN_B, true);
        policyA.setUnlockAssetAllowed(address(canonicalAsset), true);

        policyB.setAccountAllowed(alice, true);
        policyB.setAccountAllowed(bob, true);
        policyB.setAccountAllowed(liquidator, true);
        policyB.setSourceChainAllowed(CHAIN_A, true);
        policyB.setMintAssetAllowed(address(canonicalAsset), true);
    }

    function testSendTransferLocksCanonicalAndCommitsPacket() public {
        canonicalAsset.mint(alice, 100 ether);
        vm.startPrank(alice);
        canonicalAsset.approve(address(escrowA), 25 ether);
        bytes32 packetId = appA.sendTransfer(CHAIN_B, bob, 25 ether, 50, 0);
        vm.stopPrank();

        assertEq(packetStoreA.packetSequence(), 1);
        assertEq(packetStoreA.packetIdAt(1), packetId);
        assertTrue(packetStoreA.committedPacket(packetId));
        assertEq(escrowA.totalEscrowed(), 25 ether);
        assertEq(canonicalAsset.balanceOf(alice), 75 ether);
    }

    function testUnauthorizedPacketWriterCannotCommitOrConsumeSequence() public {
        IBCPacketLib.Packet memory packet = _forwardPacket(1, alice, bob, 1 ether);

        vm.expectRevert(bytes("PACKET_WRITER_NOT_AUTHORIZED"));
        vm.prank(alice);
        packetStoreA.commitPacket(packet);

        assertEq(packetStoreA.packetSequence(), 0);
    }

    function testAuthorizedWriterMustMatchSourcePort() public {
        IBCPacketLib.Packet memory packet = _forwardPacket(1, alice, bob, 1 ether);
        packetStoreA.setPacketWriter(alice, true);

        vm.expectRevert(bytes("SOURCE_PORT_MISMATCH"));
        vm.prank(alice);
        packetStoreA.commitPacket(packet);

        assertEq(packetStoreA.packetSequence(), 0);
    }

    function testRecvLockMintPacketMintsVoucherWhenPolicyAllows() public {
        IBCPacketLib.Packet memory packet = _forwardPacket(1, alice, bob, 40 ether);
        bytes32 packetId = IBCPacketLib.packetId(packet);

        vm.prank(packetHandlerB);
        bytes memory acknowledgement = appB.onRecvPacket(packet, packetId);

        assertEq(voucherB.balanceOf(bob), 40 ether);
        assertEq(policyB.voucherExposureOutstanding(address(canonicalAsset)), 40 ether);
        assertEq(keccak256(acknowledgement), keccak256(abi.encodePacked("ok:", packetId)));
    }

    function testRecvLockMintPacketRevertsWhenPolicyDenies() public {
        policyB.setAccountAllowed(bob, false);

        IBCPacketLib.Packet memory packet = _forwardPacket(1, alice, bob, 10 ether);
        bytes32 packetId = IBCPacketLib.packetId(packet);

        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyControlledVoucherToken.PolicyDenied.selector, policyB.POLICY_ACCOUNT_NOT_ALLOWED()
            )
        );
        vm.prank(packetHandlerB);
        appB.onRecvPacket(packet, packetId);
    }

    function testRecvPacketRejectsMismatchedAsset() public {
        IBCPacketLib.Packet memory packet = _forwardPacket(1, alice, bob, 10 ether);
        packet.data = IBCPacketLib.encodeTransferData(
            IBCPacketLib.TransferData({
                sender: alice,
                recipient: bob,
                asset: address(0xCAFE),
                amount: 10 ether,
                action: IBCPacketLib.ACTION_LOCK_MINT,
                memo: bytes32(0)
            })
        );
        bytes32 packetId = IBCPacketLib.packetId(packet);

        vm.expectRevert(bytes("PACKET_ASSET_MISMATCH"));
        vm.prank(packetHandlerB);
        appB.onRecvPacket(packet, packetId);
    }

    function testRecvBurnUnlockPacketRejectsMismatchedAsset() public {
        IBCPacketLib.Packet memory packet = _burnPacket(1, bob, alice, 10 ether);
        packet.data = IBCPacketLib.encodeTransferData(
            IBCPacketLib.TransferData({
                sender: bob,
                recipient: alice,
                asset: address(0xCAFE),
                amount: 10 ether,
                action: IBCPacketLib.ACTION_BURN_UNLOCK,
                memo: bytes32(0)
            })
        );
        bytes32 packetId = IBCPacketLib.packetId(packet);

        vm.expectRevert(bytes("PACKET_ASSET_MISMATCH"));
        vm.prank(packetHandlerA);
        appA.onRecvPacket(packet, packetId);
    }

    function testBurnAndReleaseBurnsVoucherAndReducesExposure() public {
        _mintVoucherOnB(alice, 60 ether, bytes32(uint256(11)));

        vm.startPrank(alice);
        bytes32 packetId = appB.burnAndRelease(CHAIN_A, alice, 20 ether, 70, 0);
        vm.stopPrank();

        assertEq(voucherB.balanceOf(alice), 40 ether);
        assertEq(policyB.voucherExposureOutstanding(address(canonicalAsset)), 40 ether);
        assertTrue(packetStoreB.committedPacket(packetId));
        assertEq(packetStoreB.packetSequence(), 1);
    }

    function testBurnAndReleaseRejectsRouteVoucherAssetMismatch() public {
        _mintVoucherOnB(alice, 20 ether, bytes32(uint256(31)));
        address otherCanonicalAsset = address(0xCAFE);
        appB.configureRemoteRoute(CHAIN_A, address(appA), CHANNEL_B, CHANNEL_A, otherCanonicalAsset);

        vm.expectRevert(bytes("VOUCHER_ASSET_ROUTE_MISMATCH"));
        vm.prank(alice);
        appB.burnAndRelease(CHAIN_A, alice, 10 ether, 70, 0);
    }

    function testAuthorizedLiquidatorCanRedeemSeizedVoucher() public {
        _lockCanonicalOnA(alice, 80 ether);
        _mintVoucherOnB(liquidator, 60 ether, bytes32(uint256(41)));
        appB.grantRole(appB.SETTLEMENT_OPERATOR_ROLE(), liquidator);

        vm.prank(liquidator);
        bytes32 packetId = appB.settleSeizedVoucher(CHAIN_A, liquidator, 30 ether, 70, 0);

        IBCPacketLib.Packet memory packet = _burnPacket(1, liquidator, liquidator, 30 ether);
        assertEq(packetId, IBCPacketLib.packetId(packet));
        assertEq(packetStoreB.packetIdAt(1), packetId);
        assertEq(voucherB.balanceOf(liquidator), 30 ether);
        assertEq(policyB.voucherExposureOutstanding(address(canonicalAsset)), 30 ether);

        vm.prank(packetHandlerA);
        appA.onRecvPacket(packet, packetId);

        assertEq(canonicalAsset.balanceOf(liquidator), 30 ether);
        assertEq(escrowA.totalEscrowed(), 50 ether);
    }

    function testUnauthorizedLiquidatorCannotRedeemSeizedVoucher() public {
        policyB.setAccountAllowed(outsider, true);
        _mintVoucherOnB(outsider, 20 ether, bytes32(uint256(42)));

        vm.expectRevert();
        vm.prank(outsider);
        appB.settleSeizedVoucher(CHAIN_A, outsider, 20 ether, 70, 0);
    }

    function testRedeemSeizedVoucherRespectsPolicy() public {
        _lockCanonicalOnA(alice, 80 ether);
        _mintVoucherOnB(liquidator, 40 ether, bytes32(uint256(43)));
        appB.grantRole(appB.SETTLEMENT_OPERATOR_ROLE(), liquidator);

        vm.prank(liquidator);
        bytes32 packetId = appB.settleSeizedVoucher(CHAIN_A, liquidator, 20 ether, 70, 0);

        policyA.setAccountAllowed(liquidator, false);
        IBCPacketLib.Packet memory packet = _burnPacket(1, liquidator, liquidator, 20 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyControlledEscrowVault.PolicyDenied.selector, policyA.POLICY_ACCOUNT_NOT_ALLOWED()
            )
        );
        vm.prank(packetHandlerA);
        appA.onRecvPacket(packet, packetId);
    }

    function testRedeemSeizedVoucherCannotExceedLiquidatorBalance() public {
        _mintVoucherOnB(liquidator, 10 ether, bytes32(uint256(44)));
        appB.grantRole(appB.SETTLEMENT_OPERATOR_ROLE(), liquidator);

        vm.expectRevert();
        vm.prank(liquidator);
        appB.settleSeizedVoucher(CHAIN_A, liquidator, 10 ether + 1, 70, 0);
    }

    function testReplayOfSettlementPacketIsRejected() public {
        _lockCanonicalOnA(alice, 80 ether);
        _mintVoucherOnB(liquidator, 50 ether, bytes32(uint256(45)));
        appB.grantRole(appB.SETTLEMENT_OPERATOR_ROLE(), liquidator);

        vm.prank(liquidator);
        bytes32 packetId = appB.settleSeizedVoucher(CHAIN_A, liquidator, 25 ether, 70, 0);

        IBCPacketLib.Packet memory packet = _burnPacket(1, liquidator, liquidator, 25 ether);
        vm.prank(packetHandlerA);
        appA.onRecvPacket(packet, packetId);

        vm.expectRevert(bytes("UNLOCK_PACKET_PROCESSED"));
        vm.prank(packetHandlerA);
        appA.onRecvPacket(packet, packetId);
    }

    function testLiquidationPlusRedeemSettlementAccountingRemainsConsistent() public {
        BankToken debtAsset = new BankToken("Debt", "DEBT");
        ManualAssetOracle oracle = new ManualAssetOracle(address(this));
        PolicyControlledLendingPool lendingPool = new PolicyControlledLendingPool(
            address(this), address(voucherB), address(debtAsset), address(policyB), 7_000, 8_000
        );
        policyB.grantRole(policyB.POLICY_APP_ROLE(), address(lendingPool));
        policyB.setCollateralAssetAllowed(address(voucherB), true);
        policyB.setDebtAssetAllowed(address(debtAsset), true);
        policyB.setAccountBorrowCap(alice, 500 ether);
        policyB.setDebtAssetBorrowCap(address(debtAsset), 1_000 ether);
        oracle.setPrice(address(voucherB), 1 ether);
        oracle.setPrice(address(debtAsset), 1 ether);
        lendingPool.setValuationOracle(address(oracle));
        lendingPool.grantRole(lendingPool.LIQUIDATOR_ROLE(), liquidator);

        debtAsset.mint(address(this), 1_000 ether);
        debtAsset.approve(address(lendingPool), 1_000 ether);
        lendingPool.depositLiquidity(1_000 ether);
        _lockCanonicalOnA(alice, 100 ether);
        _mintVoucherOnB(alice, 100 ether, bytes32(uint256(46)));

        vm.startPrank(alice);
        voucherB.approve(address(lendingPool), 100 ether);
        lendingPool.depositCollateral(100 ether);
        lendingPool.borrow(70 ether);
        vm.stopPrank();

        oracle.setPrice(address(voucherB), 0.5 ether);
        debtAsset.mint(liquidator, 35 ether);
        vm.startPrank(liquidator);
        debtAsset.approve(address(lendingPool), 35 ether);
        lendingPool.liquidate(alice, 40 ether);
        vm.stopPrank();

        uint256 seized = voucherB.balanceOf(liquidator);
        assertEq(seized, 73.5 ether);
        assertEq(lendingPool.collateralBalance(alice), 26.5 ether);

        appB.grantRole(appB.SETTLEMENT_OPERATOR_ROLE(), liquidator);
        vm.prank(liquidator);
        bytes32 settlementPacketId = appB.settleSeizedVoucher(CHAIN_A, liquidator, seized, 70, 0);

        IBCPacketLib.Packet memory settlementPacket = _burnPacket(1, liquidator, liquidator, seized);
        vm.prank(packetHandlerA);
        appA.onRecvPacket(settlementPacket, settlementPacketId);

        assertEq(voucherB.balanceOf(liquidator), 0);
        assertEq(canonicalAsset.balanceOf(liquidator), seized);
        assertEq(escrowA.totalEscrowed(), 26.5 ether);
        assertEq(policyB.voucherExposureOutstanding(address(canonicalAsset)), 26.5 ether);
        assertEq(policyB.collateralOutstanding(address(voucherB)), 26.5 ether);
        assertEq(lendingPool.debtBalance(alice), 35 ether);
    }

    function testTimeoutOnBurnUnlockRestoresVoucher() public {
        _mintVoucherOnB(alice, 60 ether, bytes32(uint256(21)));

        vm.startPrank(alice);
        bytes32 packetId = appB.burnAndRelease(CHAIN_A, alice, 20 ether, 70, 0);
        vm.stopPrank();

        IBCPacketLib.Packet memory packet = _burnPacket(1, alice, alice, 20 ether);

        vm.prank(packetHandlerB);
        appB.onTimeoutPacket(packet, packetId);

        assertEq(voucherB.balanceOf(alice), 60 ether);
        assertEq(policyB.voucherExposureOutstanding(address(canonicalAsset)), 60 ether);
        assertTrue(appB.timedOutPacket(packetId));
    }

    function testRecvBurnUnlockPacketUnlocksEscrowedCanonical() public {
        canonicalAsset.mint(alice, 100 ether);
        vm.startPrank(alice);
        canonicalAsset.approve(address(escrowA), 50 ether);
        appA.sendTransfer(CHAIN_B, bob, 50 ether, 50, 0);
        vm.stopPrank();

        IBCPacketLib.Packet memory packet = _burnPacket(1, bob, alice, 20 ether);
        bytes32 packetId = IBCPacketLib.packetId(packet);

        vm.prank(packetHandlerA);
        appA.onRecvPacket(packet, packetId);

        assertEq(escrowA.totalEscrowed(), 30 ether);
        assertEq(canonicalAsset.balanceOf(alice), 70 ether);
    }

    function testRecvBurnUnlockCanReleasePooledEscrowToDifferentRecipient() public {
        canonicalAsset.mint(alice, 100 ether);
        vm.startPrank(alice);
        canonicalAsset.approve(address(escrowA), 50 ether);
        appA.sendTransfer(CHAIN_B, bob, 50 ether, 50, 0);
        vm.stopPrank();

        IBCPacketLib.Packet memory packet = _burnPacket(1, bob, bob, 20 ether);
        bytes32 packetId = IBCPacketLib.packetId(packet);

        vm.prank(packetHandlerA);
        appA.onRecvPacket(packet, packetId);

        assertEq(escrowA.totalEscrowed(), 30 ether);
        assertEq(canonicalAsset.balanceOf(alice), 50 ether);
        assertEq(canonicalAsset.balanceOf(bob), 20 ether);
    }

    function testTimeoutOnForwardPacketRefundsSender() public {
        canonicalAsset.mint(alice, 100 ether);
        vm.startPrank(alice);
        canonicalAsset.approve(address(escrowA), 50 ether);
        bytes32 packetId = appA.sendTransfer(CHAIN_B, bob, 50 ether, 50, 0);
        vm.stopPrank();

        IBCPacketLib.Packet memory packet = _forwardPacket(1, alice, bob, 50 ether);

        vm.prank(packetHandlerA);
        appA.onTimeoutPacket(packet, packetId);

        assertEq(escrowA.totalEscrowed(), 0);
        assertEq(canonicalAsset.balanceOf(alice), 100 ether);
        assertTrue(appA.timedOutPacket(packetId));
    }

    function testPausedContractsBlockCriticalTransferFlows() public {
        canonicalAsset.mint(alice, 100 ether);
        appA.pause();

        vm.startPrank(alice);
        canonicalAsset.approve(address(escrowA), 10 ether);
        vm.expectRevert();
        appA.sendTransfer(CHAIN_B, bob, 10 ether, 50, 0);
        vm.stopPrank();

        appA.unpause();
        escrowA.pause();
        vm.startPrank(alice);
        vm.expectRevert();
        appA.sendTransfer(CHAIN_B, bob, 10 ether, 50, 0);
        vm.stopPrank();
        escrowA.unpause();

        voucherB.pause();
        IBCPacketLib.Packet memory packet = _forwardPacket(1, alice, bob, 10 ether);
        vm.expectRevert();
        vm.prank(packetHandlerB);
        appB.onRecvPacket(packet, IBCPacketLib.packetId(packet));
    }

    function testAcknowledgementCallbackStoresHash() public {
        IBCPacketLib.Packet memory packet = _forwardPacket(1, alice, bob, 10 ether);
        bytes32 packetId = IBCPacketLib.packetId(packet);
        bytes memory acknowledgement = abi.encodePacked("ok:", packetId);

        vm.prank(packetHandlerA);
        appA.onAcknowledgementPacket(packet, packetId, acknowledgement);

        assertEq(appA.acknowledgementHashByPacket(packetId), keccak256(acknowledgement));
    }

    function _mintVoucherOnB(address beneficiary, uint256 amount, bytes32 packetId) internal {
        IBCPacketLib.Packet memory packet = _forwardPacket(99, alice, beneficiary, amount);
        vm.prank(packetHandlerB);
        appB.onRecvPacket(packet, packetId);
    }

    function _lockCanonicalOnA(address account, uint256 amount) internal {
        canonicalAsset.mint(account, amount);
        vm.startPrank(account);
        canonicalAsset.approve(address(escrowA), amount);
        appA.sendTransfer(CHAIN_B, bob, amount, 50, 0);
        vm.stopPrank();
    }

    function _forwardPacket(uint256 sequence, address sender, address recipient, uint256 amount)
        internal
        view
        returns (IBCPacketLib.Packet memory)
    {
        return IBCPacketLib.Packet({
            sequence: sequence,
            source: IBCPacketLib.Endpoint({chainId: CHAIN_A, port: address(appA), channel: CHANNEL_A}),
            destination: IBCPacketLib.Endpoint({chainId: CHAIN_B, port: address(appB), channel: CHANNEL_B}),
            data: IBCPacketLib.encodeTransferData(
                IBCPacketLib.TransferData({
                    sender: sender,
                    recipient: recipient,
                    asset: address(canonicalAsset),
                    amount: amount,
                    action: IBCPacketLib.ACTION_LOCK_MINT,
                    memo: bytes32(0)
                })
            ),
            timeout: IBCPacketLib.Timeout({height: 50, timestamp: 0})
        });
    }

    function _burnPacket(uint256 sequence, address sender, address recipient, uint256 amount)
        internal
        view
        returns (IBCPacketLib.Packet memory)
    {
        return IBCPacketLib.Packet({
            sequence: sequence,
            source: IBCPacketLib.Endpoint({chainId: CHAIN_B, port: address(appB), channel: CHANNEL_B}),
            destination: IBCPacketLib.Endpoint({chainId: CHAIN_A, port: address(appA), channel: CHANNEL_A}),
            data: IBCPacketLib.encodeTransferData(
                IBCPacketLib.TransferData({
                    sender: sender,
                    recipient: recipient,
                    asset: address(canonicalAsset),
                    amount: amount,
                    action: IBCPacketLib.ACTION_BURN_UNLOCK,
                    memo: bytes32(0)
                })
            ),
            timeout: IBCPacketLib.Timeout({height: 70, timestamp: 0})
        });
    }
}
