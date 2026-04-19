// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BankToken} from "../../contracts/apps/BankToken.sol";
import {BankPolicyEngineV2} from "../../contracts/v2/apps/BankPolicyEngineV2.sol";
import {PolicyControlledVoucherTokenV2} from "../../contracts/v2/apps/PolicyControlledVoucherTokenV2.sol";
import {PolicyControlledEscrowVaultV2} from "../../contracts/v2/apps/PolicyControlledEscrowVaultV2.sol";
import {PolicyControlledTransferAppV2} from "../../contracts/v2/apps/PolicyControlledTransferAppV2.sol";
import {IBCPacketStoreV2} from "../../contracts/v2/core/IBCPacketStoreV2.sol";
import {IBCPacketLibV2} from "../../contracts/v2/core/IBCPacketLibV2.sol";

contract PolicyTransferAppV2Test is Test {
    uint256 internal constant CHAIN_A = 41001;
    uint256 internal constant CHAIN_B = 41002;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal packetHandlerA = address(0x1001);
    address internal packetHandlerB = address(0x1002);

    bytes32 internal constant CHANNEL_A = bytes32("channel-a");
    bytes32 internal constant CHANNEL_B = bytes32("channel-b");

    BankToken internal canonicalAsset;
    BankPolicyEngineV2 internal policyA;
    BankPolicyEngineV2 internal policyB;
    PolicyControlledVoucherTokenV2 internal voucherB;
    PolicyControlledEscrowVaultV2 internal escrowA;
    IBCPacketStoreV2 internal packetStoreA;
    IBCPacketStoreV2 internal packetStoreB;
    PolicyControlledTransferAppV2 internal appA;
    PolicyControlledTransferAppV2 internal appB;

    function setUp() public {
        canonicalAsset = new BankToken("Canonical", "CAN");

        policyA = new BankPolicyEngineV2(address(this));
        policyB = new BankPolicyEngineV2(address(this));

        escrowA = new PolicyControlledEscrowVaultV2(address(this), address(canonicalAsset), address(policyA));
        voucherB = new PolicyControlledVoucherTokenV2(address(this), address(policyB), "Voucher", "vCAN");

        packetStoreA = new IBCPacketStoreV2(CHAIN_A);
        packetStoreB = new IBCPacketStoreV2(CHAIN_B);

        appA = new PolicyControlledTransferAppV2(
            CHAIN_A, address(packetStoreA), packetHandlerA, address(escrowA), address(0), address(this)
        );
        appB = new PolicyControlledTransferAppV2(
            CHAIN_B, address(packetStoreB), packetHandlerB, address(0), address(voucherB), address(this)
        );

        escrowA.grantApp(address(appA));
        voucherB.grantApp(address(appB));

        policyA.grantRole(policyA.POLICY_APP_ROLE(), address(escrowA));
        policyB.grantRole(policyB.POLICY_APP_ROLE(), address(voucherB));

        appA.configureRemoteRoute(CHAIN_B, address(appB), CHANNEL_A, CHANNEL_B, address(canonicalAsset));
        appB.configureRemoteRoute(CHAIN_A, address(appA), CHANNEL_B, CHANNEL_A, address(canonicalAsset));

        policyA.setAccountAllowed(alice, true);
        policyA.setAccountAllowed(bob, true);
        policyA.setSourceChainAllowed(CHAIN_B, true);
        policyA.setUnlockAssetAllowed(address(canonicalAsset), true);

        policyB.setAccountAllowed(alice, true);
        policyB.setAccountAllowed(bob, true);
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

    function testRecvLockMintPacketMintsVoucherWhenPolicyAllows() public {
        IBCPacketLibV2.Packet memory packet = _forwardPacket(1, alice, bob, 40 ether);
        bytes32 packetId = IBCPacketLibV2.packetId(packet);

        vm.prank(packetHandlerB);
        bytes memory acknowledgement = appB.onRecvPacketV2(packet, packetId);

        assertEq(voucherB.balanceOf(bob), 40 ether);
        assertEq(policyB.voucherExposureOutstanding(address(canonicalAsset)), 40 ether);
        assertEq(keccak256(acknowledgement), keccak256(abi.encodePacked("ok:", packetId)));
    }

    function testRecvLockMintPacketRevertsWhenPolicyDenies() public {
        policyB.setAccountAllowed(bob, false);

        IBCPacketLibV2.Packet memory packet = _forwardPacket(1, alice, bob, 10 ether);
        bytes32 packetId = IBCPacketLibV2.packetId(packet);

        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyControlledVoucherTokenV2.PolicyDenied.selector, policyB.POLICY_ACCOUNT_NOT_ALLOWED()
            )
        );
        vm.prank(packetHandlerB);
        appB.onRecvPacketV2(packet, packetId);
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

    function testTimeoutOnBurnUnlockRestoresVoucher() public {
        _mintVoucherOnB(alice, 60 ether, bytes32(uint256(21)));

        vm.startPrank(alice);
        bytes32 packetId = appB.burnAndRelease(CHAIN_A, alice, 20 ether, 70, 0);
        vm.stopPrank();

        IBCPacketLibV2.Packet memory packet = _burnPacket(1, alice, alice, 20 ether);

        vm.prank(packetHandlerB);
        appB.onTimeoutPacketV2(packet, packetId);

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

        IBCPacketLibV2.Packet memory packet = _burnPacket(1, bob, alice, 20 ether);
        bytes32 packetId = IBCPacketLibV2.packetId(packet);

        vm.prank(packetHandlerA);
        appA.onRecvPacketV2(packet, packetId);

        assertEq(escrowA.totalEscrowed(), 30 ether);
        assertEq(canonicalAsset.balanceOf(alice), 70 ether);
    }

    function testTimeoutOnForwardPacketRefundsSender() public {
        canonicalAsset.mint(alice, 100 ether);
        vm.startPrank(alice);
        canonicalAsset.approve(address(escrowA), 50 ether);
        bytes32 packetId = appA.sendTransfer(CHAIN_B, bob, 50 ether, 50, 0);
        vm.stopPrank();

        IBCPacketLibV2.Packet memory packet = _forwardPacket(1, alice, bob, 50 ether);

        vm.prank(packetHandlerA);
        appA.onTimeoutPacketV2(packet, packetId);

        assertEq(escrowA.totalEscrowed(), 0);
        assertEq(canonicalAsset.balanceOf(alice), 100 ether);
        assertTrue(appA.timedOutPacket(packetId));
    }

    function testAcknowledgementCallbackStoresHash() public {
        IBCPacketLibV2.Packet memory packet = _forwardPacket(1, alice, bob, 10 ether);
        bytes32 packetId = IBCPacketLibV2.packetId(packet);
        bytes memory acknowledgement = abi.encodePacked("ok:", packetId);

        vm.prank(packetHandlerA);
        appA.onAcknowledgementPacketV2(packet, packetId, acknowledgement);

        assertEq(appA.acknowledgementHashByPacket(packetId), keccak256(acknowledgement));
    }

    function _mintVoucherOnB(address beneficiary, uint256 amount, bytes32 packetId) internal {
        IBCPacketLibV2.Packet memory packet = _forwardPacket(99, alice, beneficiary, amount);
        vm.prank(packetHandlerB);
        appB.onRecvPacketV2(packet, packetId);
    }

    function _forwardPacket(uint256 sequence, address sender, address recipient, uint256 amount)
        internal
        view
        returns (IBCPacketLibV2.Packet memory)
    {
        return IBCPacketLibV2.Packet({
            sequence: sequence,
            source: IBCPacketLibV2.Endpoint({chainId: CHAIN_A, port: address(appA), channel: CHANNEL_A}),
            destination: IBCPacketLibV2.Endpoint({chainId: CHAIN_B, port: address(appB), channel: CHANNEL_B}),
            data: IBCPacketLibV2.encodeTransferData(
                IBCPacketLibV2.TransferData({
                    sender: sender,
                    recipient: recipient,
                    asset: address(canonicalAsset),
                    amount: amount,
                    action: IBCPacketLibV2.ACTION_LOCK_MINT,
                    memo: bytes32(0)
                })
            ),
            timeout: IBCPacketLibV2.Timeout({height: 50, timestamp: 0})
        });
    }

    function _burnPacket(uint256 sequence, address sender, address recipient, uint256 amount)
        internal
        view
        returns (IBCPacketLibV2.Packet memory)
    {
        return IBCPacketLibV2.Packet({
            sequence: sequence,
            source: IBCPacketLibV2.Endpoint({chainId: CHAIN_B, port: address(appB), channel: CHANNEL_B}),
            destination: IBCPacketLibV2.Endpoint({chainId: CHAIN_A, port: address(appA), channel: CHANNEL_A}),
            data: IBCPacketLibV2.encodeTransferData(
                IBCPacketLibV2.TransferData({
                    sender: sender,
                    recipient: recipient,
                    asset: address(canonicalAsset),
                    amount: amount,
                    action: IBCPacketLibV2.ACTION_BURN_UNLOCK,
                    memo: bytes32(0)
                })
            ),
            timeout: IBCPacketLibV2.Timeout({height: 70, timestamp: 0})
        });
    }
}
