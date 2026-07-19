// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BankPolicyEngine} from "../../contracts/apps/BankPolicyEngine.sol";
import {BankToken} from "../../contracts/apps/BankToken.sol";
import {IInstitutionalCrossChainGateway} from "../../contracts/apps/IInstitutionalCrossChainGateway.sol";
import {InstitutionalCollateralApp} from "../../contracts/apps/InstitutionalCollateralApp.sol";
import {InstitutionalCollateralMessageLib} from "../../contracts/apps/InstitutionalCollateralMessageLib.sol";
import {PolicyControlledEscrowVault} from "../../contracts/apps/PolicyControlledEscrowVault.sol";
import {PolicyControlledVoucherToken} from "../../contracts/apps/PolicyControlledVoucherToken.sol";
import {IInstitutionalMessageLifecycle, IInstitutionalMessageReceiver} from
    "../../contracts/gateway/IInstitutionalMessageReceiver.sol";
import {InstitutionalMessageLib} from "../../contracts/gateway/InstitutionalMessageLib.sol";
import {InstitutionalIdentityRegistry} from "../../contracts/identity/InstitutionalIdentityRegistry.sol";

contract MockInstitutionalAppGateway is IInstitutionalCrossChainGateway {
    uint256 public immutable localChainId;
    uint256 public nextNonce = 1;
    bytes public lastPayload;
    bytes32 public lastMessageId;

    constructor(uint256 localChainId_) {
        localChainId = localChainId_;
    }

    function sendMessage(
        uint256 destinationChainId,
        address destinationApplication,
        bytes calldata payload,
        uint64 timeoutTimestamp
    ) external returns (bytes32 messageId, InstitutionalMessageLib.Message memory message) {
        message = InstitutionalMessageLib.Message({
            version: 1,
            nonce: nextNonce++,
            sourceChainId: localChainId,
            sourceGateway: address(this),
            sourceApplication: msg.sender,
            destinationChainId: destinationChainId,
            destinationGateway: address(uint160(destinationChainId)),
            destinationApplication: destinationApplication,
            timeoutTimestamp: timeoutTimestamp,
            payload: payload
        });
        messageId = InstitutionalMessageLib.messageId(message);
        lastMessageId = messageId;
        lastPayload = payload;
    }

    function deliver(
        address application,
        bytes32 messageId,
        uint256 sourceChainId,
        address sourceApplication,
        bytes calldata payload
    ) external returns (bytes memory acknowledgement) {
        return IInstitutionalMessageReceiver(application).onInstitutionalMessage(
            messageId,
            sourceChainId,
            sourceApplication,
            payload
        );
    }

    function acknowledge(address application, bytes32 messageId, bytes calldata acknowledgement) external {
        IInstitutionalMessageLifecycle(application).onInstitutionalAcknowledgement(messageId, acknowledgement);
    }

    function timeOut(address application, bytes32 messageId) external {
        IInstitutionalMessageLifecycle(application).onInstitutionalTimeout(messageId);
    }
}

contract InstitutionalCollateralAppTest is Test {
    uint256 internal constant CHAIN_A = 41001;
    uint256 internal constant CHAIN_B = 41002;
    uint256 internal constant ROUTE_LIMIT = 500 ether;
    address internal constant CUSTOMER_A = address(0xA11CE);
    address internal constant CUSTOMER_B = address(0xB0B);

    BankToken internal canonicalToken;
    BankPolicyEngine internal policyA;
    BankPolicyEngine internal policyB;
    InstitutionalIdentityRegistry internal identityA;
    InstitutionalIdentityRegistry internal identityB;
    PolicyControlledEscrowVault internal escrow;
    PolicyControlledVoucherToken internal voucher;
    MockInstitutionalAppGateway internal gatewayA;
    MockInstitutionalAppGateway internal gatewayB;
    InstitutionalCollateralApp internal appA;
    InstitutionalCollateralApp internal appB;

    function setUp() public {
        vm.warp(1_800_000_000);
        canonicalToken = new BankToken("Bank A Deposit", "aBANK");
        policyA = new BankPolicyEngine(address(this));
        policyB = new BankPolicyEngine(address(this));
        identityA = new InstitutionalIdentityRegistry(address(this));
        identityB = new InstitutionalIdentityRegistry(address(this));
        _configureIdentity(identityA);
        _configureIdentity(identityB);
        _configurePolicy();

        escrow = new PolicyControlledEscrowVault(address(this), address(canonicalToken), address(policyA));
        voucher = new PolicyControlledVoucherToken(address(this), address(policyB), "Bank A Receipt", "xBANK");
        voucher.bindCanonicalAsset(address(canonicalToken));
        policyB.grantRole(policyB.POLICY_APP_ROLE(), address(voucher));

        gatewayA = new MockInstitutionalAppGateway(CHAIN_A);
        gatewayB = new MockInstitutionalAppGateway(CHAIN_B);
        appA = new InstitutionalCollateralApp(
            CHAIN_A,
            address(gatewayA),
            address(identityA),
            address(escrow),
            address(0),
            address(this)
        );
        appB = new InstitutionalCollateralApp(
            CHAIN_B,
            address(gatewayB),
            address(identityB),
            address(0),
            address(voucher),
            address(this)
        );
        appA.configureRemoteRoute(CHAIN_B, address(appB), address(canonicalToken), ROUTE_LIMIT, true);
        appB.configureRemoteRoute(CHAIN_A, address(appA), address(canonicalToken), ROUTE_LIMIT, true);
        escrow.grantApp(address(appA));
        voucher.grantApp(address(appB));

        canonicalToken.mint(CUSTOMER_A, 1_000 ether);
        vm.prank(CUSTOMER_A);
        canonicalToken.approve(address(escrow), type(uint256).max);
    }

    function testLockMintAndAcknowledgementCompletesTransfer() public {
        bytes32 messageId = _sendLock(100 ether, CUSTOMER_B);
        assertEq(canonicalToken.balanceOf(address(escrow)), 100 ether);
        assertEq(uint256(appA.transferStatus(messageId)), uint256(InstitutionalCollateralApp.TransferStatus.Pending));

        bytes memory acknowledgement = _deliverAtoB(messageId);
        assertEq(voucher.balanceOf(CUSTOMER_B), 100 ether);
        gatewayA.acknowledge(address(appA), messageId, acknowledgement);

        assertEq(uint256(appA.transferStatus(messageId)), uint256(InstitutionalCollateralApp.TransferStatus.Completed));
        assertEq(policyB.voucherExposureOutstanding(address(canonicalToken)), 100 ether);
    }

    function testClientReferencePreventsDuplicateOriginSubmission() public {
        bytes32 clientRef = keccak256("idempotent-lock");
        vm.prank(CUSTOMER_A);
        bytes32 messageId = appA.lockAndMint(
            CHAIN_B,
            CUSTOMER_B,
            100 ether,
            uint64(block.timestamp + 1 hours),
            clientRef
        );
        assertEq(appA.messageByClientReference(CUSTOMER_A, clientRef), messageId);

        vm.prank(CUSTOMER_A);
        vm.expectRevert(
            abi.encodeWithSelector(
                InstitutionalCollateralApp.ClientReferenceAlreadyUsed.selector,
                CUSTOMER_A,
                clientRef
            )
        );
        appA.lockAndMint(
            CHAIN_B,
            CUSTOMER_B,
            100 ether,
            uint64(block.timestamp + 1 hours),
            clientRef
        );
        assertEq(canonicalToken.balanceOf(address(escrow)), 100 ether);
    }

    function testLockTimeoutRefundsCanonicalAssetEvenWhileApplicationPaused() public {
        bytes32 messageId = _sendLock(100 ether, CUSTOMER_B);
        appA.pause();

        gatewayA.timeOut(address(appA), messageId);

        assertEq(canonicalToken.balanceOf(CUSTOMER_A), 1_000 ether);
        assertEq(escrow.totalEscrowed(), 0);
        assertEq(uint256(appA.transferStatus(messageId)), uint256(InstitutionalCollateralApp.TransferStatus.Refunded));
    }

    function testPausedEscrowKeepsTimeoutPendingUntilSafeRetry() public {
        bytes32 messageId = _sendLock(100 ether, CUSTOMER_B);
        escrow.pause();

        vm.expectRevert();
        gatewayA.timeOut(address(appA), messageId);
        assertEq(uint256(appA.transferStatus(messageId)), uint256(InstitutionalCollateralApp.TransferStatus.Pending));
        assertEq(escrow.totalEscrowed(), 100 ether);
        assertEq(canonicalToken.balanceOf(CUSTOMER_A), 900 ether);

        escrow.unpause();
        gatewayA.timeOut(address(appA), messageId);
        assertEq(uint256(appA.transferStatus(messageId)), uint256(InstitutionalCollateralApp.TransferStatus.Refunded));
        assertEq(canonicalToken.balanceOf(CUSTOMER_A), 1_000 ether);
    }

    function testComplianceSuspensionKeepsRefundPendingUntilResolution() public {
        bytes32 messageId = _sendLock(100 ether, CUSTOMER_B);
        identityA.setCredentialStatus(CUSTOMER_A, InstitutionalIdentityRegistry.CredentialStatus.Suspended);

        vm.expectRevert();
        gatewayA.timeOut(address(appA), messageId);
        assertEq(uint256(appA.transferStatus(messageId)), uint256(InstitutionalCollateralApp.TransferStatus.Pending));
        assertEq(escrow.totalEscrowed(), 100 ether);

        identityA.setCredentialStatus(CUSTOMER_A, InstitutionalIdentityRegistry.CredentialStatus.Active);
        gatewayA.timeOut(address(appA), messageId);
        assertEq(uint256(appA.transferStatus(messageId)), uint256(InstitutionalCollateralApp.TransferStatus.Refunded));
        assertEq(canonicalToken.balanceOf(CUSTOMER_A), 1_000 ether);
    }

    function testOperationalGuardianCanPauseButCannotReconfigureCustodyContracts() public {
        address guardian = address(0xCAFE);
        escrow.grantRole(escrow.GUARDIAN_ROLE(), guardian);
        voucher.grantRole(voucher.GUARDIAN_ROLE(), guardian);

        vm.prank(guardian);
        escrow.pause();
        vm.prank(guardian);
        voucher.pause();

        vm.prank(guardian);
        vm.expectRevert();
        escrow.grantApp(guardian);
        vm.prank(guardian);
        vm.expectRevert();
        voucher.bindCanonicalAsset(address(0xBEEF));
        vm.prank(guardian);
        vm.expectRevert();
        escrow.unpause();
        vm.prank(guardian);
        vm.expectRevert();
        voucher.unpause();

        escrow.unpause();
        voucher.unpause();
    }

    function testBurnUnlockReleasesCanonicalCollateralAndCompletes() public {
        bytes32 lockMessageId = _sendLock(100 ether, CUSTOMER_B);
        gatewayA.acknowledge(address(appA), lockMessageId, _deliverAtoB(lockMessageId));

        vm.prank(CUSTOMER_B);
        bytes32 burnMessageId = appB.burnAndUnlock(
            CHAIN_A,
            CUSTOMER_A,
            40 ether,
            uint64(block.timestamp + 1 hours),
            keccak256("release-001")
        );
        bytes memory acknowledgement = gatewayA.deliver(
            address(appA),
            burnMessageId,
            CHAIN_B,
            address(appB),
            gatewayB.lastPayload()
        );
        gatewayB.acknowledge(address(appB), burnMessageId, acknowledgement);

        assertEq(voucher.balanceOf(CUSTOMER_B), 60 ether);
        assertEq(canonicalToken.balanceOf(CUSTOMER_A), 940 ether);
        assertEq(escrow.totalEscrowed(), 60 ether);
        assertEq(uint256(appB.transferStatus(burnMessageId)), uint256(InstitutionalCollateralApp.TransferStatus.Completed));
    }

    function testBurnTimeoutRemintsReceiptAndRestoresExposure() public {
        bytes32 lockMessageId = _sendLock(100 ether, CUSTOMER_B);
        gatewayA.acknowledge(address(appA), lockMessageId, _deliverAtoB(lockMessageId));

        vm.prank(CUSTOMER_B);
        bytes32 burnMessageId = appB.burnAndUnlock(
            CHAIN_A,
            CUSTOMER_A,
            40 ether,
            uint64(block.timestamp + 1 hours),
            keccak256("release-timeout")
        );
        assertEq(voucher.balanceOf(CUSTOMER_B), 60 ether);
        gatewayB.timeOut(address(appB), burnMessageId);

        assertEq(voucher.balanceOf(CUSTOMER_B), 100 ether);
        assertEq(policyB.voucherExposureOutstanding(address(canonicalToken)), 100 ether);
        assertEq(uint256(appB.transferStatus(burnMessageId)), uint256(InstitutionalCollateralApp.TransferStatus.Refunded));
    }

    function testPausedVoucherKeepsBurnRefundPendingUntilSafeRetry() public {
        bytes32 lockMessageId = _sendLock(100 ether, CUSTOMER_B);
        gatewayA.acknowledge(address(appA), lockMessageId, _deliverAtoB(lockMessageId));

        vm.prank(CUSTOMER_B);
        bytes32 burnMessageId = appB.burnAndUnlock(
            CHAIN_A,
            CUSTOMER_A,
            40 ether,
            uint64(block.timestamp + 1 hours),
            keccak256("paused-voucher-refund")
        );
        voucher.pause();

        vm.expectRevert();
        gatewayB.timeOut(address(appB), burnMessageId);
        assertEq(uint256(appB.transferStatus(burnMessageId)), uint256(InstitutionalCollateralApp.TransferStatus.Pending));
        assertEq(voucher.balanceOf(CUSTOMER_B), 60 ether);

        voucher.unpause();
        gatewayB.timeOut(address(appB), burnMessageId);
        assertEq(uint256(appB.transferStatus(burnMessageId)), uint256(InstitutionalCollateralApp.TransferStatus.Refunded));
        assertEq(voucher.balanceOf(CUSTOMER_B), 100 ether);
    }

    function testSuspendedIdentityBlocksOriginAndDestinationExecution() public {
        identityA.setCredentialStatus(CUSTOMER_A, InstitutionalIdentityRegistry.CredentialStatus.Suspended);
        vm.prank(CUSTOMER_A);
        vm.expectRevert(abi.encodeWithSelector(InstitutionalCollateralApp.IdentityNotEligible.selector, CUSTOMER_A));
        appA.lockAndMint(
            CHAIN_B,
            CUSTOMER_B,
            100 ether,
            uint64(block.timestamp + 1 hours),
            keccak256("blocked-origin")
        );

        identityA.setCredentialStatus(CUSTOMER_A, InstitutionalIdentityRegistry.CredentialStatus.Active);
        bytes32 messageId = _sendLock(100 ether, CUSTOMER_B);
        identityB.setCredentialStatus(CUSTOMER_B, InstitutionalIdentityRegistry.CredentialStatus.Suspended);
        bytes memory payload = gatewayA.lastPayload();
        vm.expectRevert(abi.encodeWithSelector(InstitutionalCollateralApp.IdentityNotEligible.selector, CUSTOMER_B));
        gatewayB.deliver(address(appB), messageId, CHAIN_A, address(appA), payload);

        gatewayA.timeOut(address(appA), messageId);
        assertEq(canonicalToken.balanceOf(CUSTOMER_A), 1_000 ether);
    }

    function testPolicyEngineAlsoBlocksBorrowWhenCredentialIsSuspended() public {
        policyB.setDebtAssetAllowed(address(canonicalToken), true);
        (bool allowedBefore,) = policyB.canBorrow(CUSTOMER_B, address(canonicalToken), 1 ether);
        assertTrue(allowedBefore);

        identityB.setCredentialStatus(CUSTOMER_B, InstitutionalIdentityRegistry.CredentialStatus.Suspended);
        (bool allowedAfter, bytes32 code) = policyB.canBorrow(CUSTOMER_B, address(canonicalToken), 1 ether);
        assertFalse(allowedAfter);
        assertEq(code, policyB.POLICY_IDENTITY_NOT_ELIGIBLE());
    }

    function testPolicyIdentityRegistryCannotBeDisabledOrSetToEoa() public {
        vm.expectRevert(bytes("IDENTITY_REGISTRY_ZERO"));
        policyB.setIdentityRegistry(address(0));

        vm.expectRevert(bytes("IDENTITY_REGISTRY_NOT_CONTRACT"));
        policyB.setIdentityRegistry(address(0x1234));
    }

    function testRouteAndDailyVelocityLimitsAreEnforced() public {
        vm.prank(CUSTOMER_A);
        vm.expectRevert(bytes("PER_TRANSFER_LIMIT_EXCEEDED"));
        appA.lockAndMint(
            CHAIN_B,
            CUSTOMER_B,
            ROUTE_LIMIT + 1,
            uint64(block.timestamp + 1 hours),
            keccak256("over-route-limit")
        );

        appA.setDailyOutboundLimit(address(canonicalToken), 150 ether);
        _sendLock(100 ether, CUSTOMER_B);
        vm.prank(CUSTOMER_A);
        vm.expectRevert(bytes("DAILY_OUTBOUND_LIMIT_EXCEEDED"));
        appA.lockAndMint(
            CHAIN_B,
            CUSTOMER_B,
            60 ether,
            uint64(block.timestamp + 1 hours),
            keccak256("over-daily-limit")
        );
    }

    function testForgedAcknowledgementAndDirectCallbacksAreRejected() public {
        bytes32 messageId = _sendLock(100 ether, CUSTOMER_B);
        bytes memory forged = InstitutionalCollateralMessageLib.acknowledgement(
            messageId,
            InstitutionalCollateralMessageLib.Action.LockMint,
            101 ether
        );
        vm.expectRevert(bytes("ACKNOWLEDGEMENT_TRANSFER_MISMATCH"));
        gatewayA.acknowledge(address(appA), messageId, forged);

        vm.expectRevert(bytes("ONLY_GATEWAY"));
        appA.onInstitutionalTimeout(messageId);
    }

    function _sendLock(uint256 amount, address recipient) internal returns (bytes32 messageId) {
        vm.prank(CUSTOMER_A);
        return appA.lockAndMint(
            CHAIN_B,
            recipient,
            amount,
            uint64(block.timestamp + 1 hours),
            keccak256("collateral-lock")
        );
    }

    function _deliverAtoB(bytes32 messageId) internal returns (bytes memory acknowledgement) {
        return gatewayB.deliver(
            address(appB),
            messageId,
            CHAIN_A,
            address(appA),
            gatewayA.lastPayload()
        );
    }

    function _configureIdentity(InstitutionalIdentityRegistry registry) internal {
        registry.grantRole(registry.IDENTITY_ISSUER_ROLE(), address(this));
        registry.grantRole(registry.COMPLIANCE_ROLE(), address(this));
        registry.issueCredential(
            CUSTOMER_A,
            keccak256("customer-a-record"),
            bytes32("VN"),
            uint64(block.timestamp + 365 days),
            2
        );
        registry.issueCredential(
            CUSTOMER_B,
            keccak256("customer-b-record"),
            bytes32("SG"),
            uint64(block.timestamp + 365 days),
            2
        );
    }

    function _configurePolicy() internal {
        policyA.setIdentityRegistry(address(identityA));
        policyB.setIdentityRegistry(address(identityB));
        for (uint256 index = 0; index < 2; index++) {
            address account = index == 0 ? CUSTOMER_A : CUSTOMER_B;
            policyA.setAccountAllowed(account, true);
            policyB.setAccountAllowed(account, true);
        }
        policyA.setSourceChainAllowed(CHAIN_B, true);
        policyA.setUnlockAssetAllowed(address(canonicalToken), true);
        policyB.setSourceChainAllowed(CHAIN_A, true);
        policyB.setMintAssetAllowed(address(canonicalToken), true);
        policyB.setVoucherExposureCap(address(canonicalToken), 10_000 ether);
    }
}
