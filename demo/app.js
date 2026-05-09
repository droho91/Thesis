import { markControllerOffline, renderRoadmap, renderStatus, setText } from "./demo-status-view.js";

const buttons = [...document.querySelectorAll("button")];
const actionButtons = [...document.querySelectorAll("[data-action]")];
const deploySeedButton = document.getElementById("deploySeed");
const resetSeededButton = document.getElementById("resetSeeded");
const resumeSessionButtons = [
  document.getElementById("resumeSession"),
  document.getElementById("resumeSessionDrawer"),
].filter(Boolean);
const refreshButton = document.getElementById("refreshState");
const focusModeButton = document.getElementById("focusMode");
const openDemoToolsButton = document.getElementById("openDemoTools");
const openRuntimeOutputButton = document.getElementById("openRuntimeOutput");
const topUpRepayCashButton = document.getElementById("topUpRepayCashButton");
const primaryWorkflowCta = document.getElementById("primaryWorkflowCta");
const workflowPanelTitle = document.getElementById("workflowPanelTitle");
const workflowPanelStatus = document.getElementById("workflowPanelStatus");
const primaryActionTitle = document.getElementById("primaryActionTitle");
const primaryActionDescription = document.getElementById("primaryActionDescription");
const primaryActionHint = document.getElementById("primaryActionHint");
const workflowStepButtons = [...document.querySelectorAll("[data-workflow-step]")];
const workflowPanels = [...document.querySelectorAll("[data-workflow-panel]")];
const verificationOpenButtons = [
  document.getElementById("openVerificationPanel"),
  document.getElementById("openVerificationPanelInline"),
].filter(Boolean);
const drawers = [...document.querySelectorAll(".surface-drawer")];
const drawerCloseButtons = [...document.querySelectorAll("[data-drawer-close]")];
const amountInputs = [...document.querySelectorAll(".amount-field input")];
const amountFillButtons = [...document.querySelectorAll("[data-fill-target]")];
const loanTabButtons = [...document.querySelectorAll("[data-loan-tab]")];
const loanTabPanels = [...document.querySelectorAll("[data-loan-panel]")];
const actionCards = [...document.querySelectorAll("[data-action-card]")];
const portalButtons = [...document.querySelectorAll("[data-portal-tab]")];
const primaryLinky = document.getElementById("primaryLinky");
const primaryLinkyImage = document.getElementById("primaryLinkyImage");
const linkyImages = [...document.querySelectorAll("[data-linky-img]")];
buttons.forEach((button) => {
  button.dataset.originalTitle = button.getAttribute("title") || "";
});
const FOCUS_MODE_STORAGE_KEY = "interchain-lending-focus-mode";
const PORTAL_STORAGE_KEY = "interchain-lending-active-portal";
const CLIENT_STATUS = ["Uninitialized", "Active", "Frozen", "Recovering"];
const LINKY_ASSETS = {
  head: "./assets/linky/linky-head.png",
  wave: "./assets/linky/linky-wave.png",
  thinking: "./assets/linky/linky-thinking.png",
  success: "./assets/linky/linky-success.png",
  risk: "./assets/linky/linky-risk.png",
};
const missingLinkyAssets = new Set();
const SAFETY_MODE_ACTIONS = new Set(["recoverClient", "topUpRepayCash", "simulatePriceShock", "executeLiquidation"]);
const REPAY_CLOSE_BUFFER_BPS = 1;
const REPAY_CLOSE_MIN_BUFFER = 0.01;
const POSITION_EPSILON = 0.000001;
const AMOUNT_ACTIONS = {
  lock: { inputId: "bridgeAmount", unit: "aBANK" },
  depositCollateral: { inputId: "depositAmount", unit: "vA" },
  borrow: { inputId: "borrowAmount", unit: "bCASH" },
  repay: { inputId: "repayAmount", unit: "bCASH" },
  withdrawCollateral: { inputId: "withdrawAmount", unit: "vA" },
  simulatePriceShock: { inputId: "shockPrice", unit: "bCASH/vA" },
  executeLiquidation: { inputId: "liquidationRepayAmount", unit: "bCASH" },
};
const STRICT_VISIBLE_COMPLETION_ACTIONS = new Set([
  "resetSeeded",
  "lock",
  "proveForwardMint",
  "depositCollateral",
  "borrow",
  "topUpRepayCash",
  "repay",
  "withdrawCollateral",
  "burn",
  "proveReverseUnlock",
  "updateForwardClient",
  "updateReverseClient",
]);
const ACTION_CARD_BY_ACTION = {
  openRoute: "bridge",
  lock: "bridge",
  finalizeForwardHeader: "bridge",
  updateForwardClient: "bridge",
  proveForwardMint: "bridge",
  depositCollateral: "activate",
  borrow: "loan",
  repay: "loan",
  withdrawCollateral: "loan",
  topUpRepayCash: "loan",
  simulatePriceShock: "loan",
  executeLiquidation: "loan",
  settleSeizedVoucher: "redeem",
  burn: "redeem",
  finalizeReverseHeader: "redeem",
  updateReverseClient: "redeem",
  proveReverseUnlock: "redeem",
};
const FORWARD_PROOF_STEP_LABELS = {
  finalizeForwardHeader: "1/3 Fetch Bank A header",
  updateForwardClient: "2/3 Import Bank A header on Bank B",
  proveForwardMint: "Receive Verified Collateral",
};
const REVERSE_PROOF_STEP_LABELS = {
  finalizeReverseHeader: "1/3 Fetch Bank B header",
  updateReverseClient: "2/3 Import Bank B header on Bank A",
  proveReverseUnlock: "3/3 Verify proof and unlock aBANK",
};
const WORKFLOW_STEP_TITLES = {
  connect: "Prepare Account",
  bridge: "Bridge Collateral",
  activate: "Deposit",
  borrow: "Borrow",
  manage: "Manage Position",
  return: "Review Evidence",
};
const DO_NOT_REPEAT_COMPLETED_ACTIONS = new Set([
  "depositCollateral",
  "borrow",
  "repay",
  "withdrawCollateral",
  "burn",
  "proveReverseUnlock",
]);
const ACTION_GUIDE = {
  deploySeed: {
    runningTitle: "Prepare Demo Session",
    currentAction: "Checking whether the existing seeded Besu/QBFT runtime can be reused. This does not reset oracle price, liquidation state, balances, or previous actions.",
    expectedVisibleChange: "If the reuse check confirms the runtime, the account moves to Ready and keeps the current on-chain state.",
    nextAfterSuccess: "Establish the bank route, then transfer collateral to Bank B.",
    affectedPortal: "borrower",
    affectedMetrics: ["deploymentStatus", "bankABalance", "workflowStepConnect"],
    failureRecovery: "Start the local Besu runtime and run Prepare Demo Session. Use Fresh Reset only if the deployment is stale or corrupted.",
  },
  resetSeeded: {
    runningTitle: "Fresh Reset (slow setup only)",
    currentAction: "Deliberately redeploying and reseeding the permissioned prototype baseline.",
    expectedVisibleChange: "Balances, policy, oracle, liquidity, and latest trace return to the clean seeded state.",
    nextAfterSuccess: "Begin the guided borrower flow from Establish Bank Route.",
    affectedPortal: "borrower",
    affectedMetrics: ["deploymentStatus", "bankABalance", "bankBBalance", "poolLiquidity"],
    failureRecovery: "Check the runtime output. Fresh Reset is slow setup/recovery only because it redeploys and reseeds the whole environment.",
  },
  resumeSession: {
    runningTitle: "Resume Session",
    currentAction: "Reloading runtime config, checking Besu RPC health, verifying deployed code, and refreshing light-client proof anchors when the gap is small.",
    expectedVisibleChange: "The dashboard keeps current balances and previous actions, but proof-readiness state and the next valid action are refreshed.",
    nextAfterSuccess: "Continue with the next enabled borrower action.",
    affectedPortal: "borrower",
    affectedMetrics: ["deploymentStatus", "trustedAOnB", "trustedBOnA", "workflowPanelStatus"],
    failureRecovery: "If the chain was reset with besu:down -v, run npm run deploy and npm run seed once. If only proof anchors are behind, keep demo:ui running and click Resume again.",
  },
  openRoute: {
    runningTitle: "Establish Bank Route",
    currentAction: "Opening or reusing the proof-checked connection and channel. A first-time route performs several handshake transactions and storage proofs.",
    expectedVisibleChange: "The route timeline marks connection/channel ready; if already open, this should complete quickly.",
    nextAfterSuccess: "Transfer collateral to Bank B to create the forward packet.",
    affectedPortal: "borrower",
    affectedMetrics: ["routeEscrow", "routeHeader", "visualEscrowState", "deploymentStatus"],
    failureRecovery: "Retry the route step; use Fresh Reset only if the handshake was interrupted in an incompatible state.",
  },
  lock: {
    runningTitle: "Transfer Collateral to Bank B",
    currentAction: "Confirming escrow allowance if needed, then submitting the source-chain escrow transaction and writing the forward packet commitment.",
    expectedVisibleChange: "Locked collateral and the Bank A packet sequence update after transaction confirmation.",
    nextAfterSuccess: "Receive verified collateral on Bank B by verifying the forward proof.",
    affectedPortal: "borrower",
    affectedMetrics: ["escrowBalance", "packetSequenceA", "forwardPacketId", "routeEscrow"],
    failureRecovery: "Wait for the transaction confirmation or lower the amount if it exceeds the Bank A balance.",
  },
  finalizeForwardHeader: {
    runningTitle: "Fetch Bank A Header",
    currentAction: "Reading the Bank A Besu header at the forward packet commitment height.",
    expectedVisibleChange: "Forward header hash, state root, and proof timeline move to header prepared.",
    nextAfterSuccess: "Import the Bank A header on Bank B or verify the packet proof if trust is already current.",
    affectedPortal: "technical",
    affectedMetrics: ["proofHeaderHash", "proofStateRoot", "routeHeader", "headerHeightA"],
    failureRecovery: "Lock collateral first so there is a packet height to inspect.",
  },
  updateForwardClient: {
    runningTitle: "Import Bank A Header on Bank B",
    currentAction: "Submitting a Besu light-client update so Bank B trusts the Bank A packet height.",
    expectedVisibleChange: "Trusted height and light-client status update in the proof inspector.",
    nextAfterSuccess: "Verify the forward packet proof and mint voucher collateral.",
    affectedPortal: "technical",
    affectedMetrics: ["trustedAOnB", "proofTrustedHeight", "proofLightClientStatus", "routeClient"],
    failureRecovery: "Fetch or retry the source header, then import the header again.",
  },
  proveForwardMint: {
    runningTitle: "Receive Verified Collateral",
    currentAction: "Importing the needed Bank A header if needed, generating a storage proof, and submitting the receive proof on Bank B.",
    expectedVisibleChange: "Voucher balance appears on Bank B and packet receipt/proof status changes to verified.",
    nextAfterSuccess: "Deposit the voucher as collateral in the Bank B lending pool.",
    affectedPortal: "borrower",
    affectedMetrics: ["voucherBalance", "proofVerificationResult", "proofReceiptStatus", "routeProof"],
    failureRecovery: "The local Besu RPC can no longer serve the historical proof state for the packet height. Use Resume Session to refresh the proof anchor, or run Fresh Reset if the session is too stale.",
  },
  depositCollateral: {
    runningTitle: "Deposit Collateral",
    currentAction: "Confirming voucher allowance if needed, then depositing the selected collateral into the Bank B lending pool.",
    expectedVisibleChange: "Active collateral increases and available borrowing power refreshes.",
    nextAfterSuccess: "Borrow cash, deposit more collateral, transfer more collateral, or leave the position idle.",
    affectedPortal: "borrower",
    affectedMetrics: ["poolCollateral", "availableBorrowHero", "riskCollateralValue", "workflowStepActivate"],
    failureRecovery: "Receive verified collateral first, then retry the deposit.",
  },
  borrow: {
    runningTitle: "Borrow Cash",
    currentAction: "Submitting a borrow transaction bounded by policy, liquidity, and oracle valuation.",
    expectedVisibleChange: "Current debt and Bank B bCASH balance increase; health factor decreases but remains visible.",
    nextAfterSuccess: "Repay debt, withdraw safe collateral, or monitor health in Risk Admin.",
    affectedPortal: "borrower",
    affectedMetrics: ["currentDebtHero", "bankBBalance", "poolDebt", "healthFactorHero", "scenarioHealthyStatus"],
    failureRecovery: "Use an amount within available borrowing power and market liquidity.",
  },
  repay: {
    runningTitle: "Repay Loan",
    currentAction: "Confirming repayment allowance if needed, then reducing the borrower debt balance.",
    expectedVisibleChange: "Debt falls and health factor improves; closeout may unlock withdrawal.",
    nextAfterSuccess: "Withdraw collateral if debt is closed or continue monitoring health.",
    affectedPortal: "borrower",
    affectedMetrics: ["currentDebtHero", "poolDebt", "healthFactorHero", "scenarioRepayStatus"],
    failureRecovery: "Top up demo bCASH if the account is short, then retry repayment.",
  },
  topUpRepayCash: {
    runningTitle: "Top Up Demo bCASH",
    currentAction: "Minting enough demo bCASH for the borrower to close debt with a small interest buffer.",
    expectedVisibleChange: "Bank B bCASH balance increases and repayment becomes available.",
    nextAfterSuccess: "Repay the loan from the borrower portal.",
    affectedPortal: "borrower",
    affectedMetrics: ["bankBBalance", "repayDemoCashBalance", "repayShortfall"],
    failureRecovery: "Borrow first so there is active debt to fund for repayment.",
  },
  withdrawCollateral: {
    runningTitle: "Withdraw Collateral",
    currentAction: "Withdrawing voucher collateral only if the remaining position stays healthy.",
    expectedVisibleChange: "Deposited collateral decreases and free voucher balance increases.",
    nextAfterSuccess: "Burn voucher collateral to start the Bank A unlock path, or continue managing the loan.",
    affectedPortal: "borrower",
    affectedMetrics: ["poolCollateral", "voucherBalance", "withdrawableInline", "scenarioRepayStatus"],
    failureRecovery: "Repay more debt or reduce the withdrawal amount until projected health is safe.",
  },
  burn: {
    runningTitle: "Burn Voucher on Bank B",
    currentAction: "Burning free voucher collateral and committing the reverse packet for Bank A escrow unlock.",
    expectedVisibleChange: "Reverse packet ID and Bank B packet sequence appear in the proof inspector.",
    nextAfterSuccess: "Verify the reverse proof and unlock aBANK on Bank A.",
    affectedPortal: "borrower",
    affectedMetrics: ["voucherBalance", "reversePacketId", "packetSequenceB", "routeReverse"],
    failureRecovery: "Repay and withdraw collateral first so a free voucher balance is available.",
  },
  finalizeReverseHeader: {
    runningTitle: "Fetch Bank B Header",
    currentAction: "Reading the Bank B Besu header at the reverse packet commitment height.",
    expectedVisibleChange: "Reverse header evidence appears for the collateral unlock path.",
    nextAfterSuccess: "Import the Bank B header on Bank A.",
    affectedPortal: "technical",
    affectedMetrics: ["headerHeightB", "proofHeaderHash", "proofStateRoot", "routeReverse"],
    failureRecovery: "Burn voucher or settle seized voucher first so a reverse packet exists.",
  },
  updateReverseClient: {
    runningTitle: "Import Bank B Header on Bank A",
    currentAction: "Submitting a Besu light-client update so Bank A trusts the reverse packet height.",
    expectedVisibleChange: "Bank A trusted height updates and reverse proof becomes executable.",
    nextAfterSuccess: "Verify reverse proof and unlock aBANK on Bank A.",
    affectedPortal: "technical",
    affectedMetrics: ["trustedBOnA", "proofTrustedHeight", "proofLightClientStatus", "routeReverse"],
    failureRecovery: "Fetch or retry the Bank B header, then import the header again.",
  },
  proveReverseUnlock: {
    runningTitle: "Verify Reverse Proof and Unlock aBANK",
    currentAction: "Submitting the reverse storage proof so Bank A unlocks origin collateral.",
    expectedVisibleChange: "Reverse proof status completes and the origin balance or settlement status updates.",
    nextAfterSuccess: "Review the completed borrower closeout or liquidation settlement evidence.",
    affectedPortal: "technical",
    affectedMetrics: ["proofVerificationResult", "proofReceiptStatus", "riskSettlementStatus", "routeReverse"],
    failureRecovery: "Fetch or import the Bank B header first if the reverse proof height is not trusted yet.",
  },
  simulatePriceShock: {
    runningTitle: "Simulate Collateral Price Drop",
    currentAction: "Submitting a governed demo oracle update for the voucher collateral price.",
    expectedVisibleChange: "Oracle price, health factor, and liquidation eligibility update in Risk Admin.",
    nextAfterSuccess: "Execute Liquidation if the account is now below the liquidation threshold.",
    affectedPortal: "risk",
    affectedMetrics: ["riskOracleCollateralPrice", "riskCurrentPriceInline", "riskHealthFactor", "riskHealthAfterShock", "riskLiquidatableState"],
    failureRecovery: "Choose a positive price, usually below the current collateral price, then retry.",
  },
  executeLiquidation: {
    runningTitle: "Execute Liquidation",
    currentAction: "The authorized liquidator confirms repay allowance if needed, repays debt, seizes voucher collateral, and records reserves or bad debt.",
    expectedVisibleChange: "Debt, collateral, reserves, bad debt, seized voucher, and settlement status update.",
    nextAfterSuccess: "Settle the seized voucher through the reverse proof path.",
    affectedPortal: "risk",
    affectedMetrics: ["riskDebt", "riskAfterDebt", "riskAfterCollateral", "riskAfterReserves", "riskAfterBadDebt", "riskSettlementSeizedVoucher", "riskSettlementStatus"],
    failureRecovery: "Run the oracle shock first and use an amount within the displayed close-factor maximum.",
  },
  settleSeizedVoucher: {
    runningTitle: "Settle Seized Voucher",
    currentAction: "Burning the liquidator's seized voucher and writing the settlement packet for Bank A.",
    expectedVisibleChange: "Settlement packet appears and status changes to reverse proof pending.",
    nextAfterSuccess: "Verify reverse proof and unlock aBANK for the authorized liquidator on Bank A.",
    affectedPortal: "risk",
    affectedMetrics: ["riskSettlementSeizedVoucher", "riskSettlementPacket", "riskSettlementStatus", "reversePacketId"],
    failureRecovery: "Execute Liquidation first so the authorized liquidator holds seized voucher collateral.",
  },
  replayForward: {
    runningTitle: "Attempt Replay",
    currentAction: "Submitting an already received forward packet proof to demonstrate replay rejection.",
    expectedVisibleChange: "Explicit replay status changes to rejected while the receipt guard remains live.",
    nextAfterSuccess: "Use the proof inspector to review the packet receipt that prevents duplicate execution.",
    affectedPortal: "technical",
    affectedMetrics: ["proofReplayStatus", "replayAttackState", "replayGuardState", "proofReceiptStatus", "forwardConsumedState"],
    failureRecovery: "Receive the forward voucher first so a packet receipt exists to replay against.",
  },
  executeTimeoutRefund: {
    runningTitle: "Execute Timeout Refund",
    currentAction: "Generating a receipt-absence proof for a denied packet and submitting the timeout refund path.",
    expectedVisibleChange: "Timeout proof key, timeout transaction, and refund status appear in Technical / Thesis.",
    nextAfterSuccess: "Review the receipt-absence evidence in the proof inspector.",
    affectedPortal: "technical",
    affectedMetrics: ["proofTimeoutStatus", "proofTimeoutKey", "proofTimeoutTx", "timeoutAbsenceState"],
    failureRecovery: "Retry after the script prepares the denied packet, or run the full risk lifecycle from a clean reset.",
  },
  freezeClient: {
    runningTitle: "Freeze Light Client",
    currentAction: "Submitting conflicting-header evidence to put the Bank B light client into safety mode.",
    expectedVisibleChange: "Light-client status changes to Frozen and evidence hash appears.",
    nextAfterSuccess: "Recover the light client before running normal interchain actions.",
    affectedPortal: "technical",
    affectedMetrics: ["proofLightClientStatus", "proofFreezeEvidence", "statusAOnB", "routeSafety"],
    failureRecovery: "Ensure the client has a trusted Bank A header, then retry the freeze demonstration.",
  },
  recoverClient: {
    runningTitle: "Recover Light Client",
    currentAction: "Submitting a recovery anchor so the frozen/recovering client returns to active demo mode.",
    expectedVisibleChange: "Light-client and recovery status return to Active/Recovered.",
    nextAfterSuccess: "Continue the borrower, risk, or technical flow that was paused by safety mode.",
    affectedPortal: "technical",
    affectedMetrics: ["proofLightClientStatus", "proofRecoveryStatus", "statusAOnB", "routeSafety"],
    failureRecovery: "Wait for a fresh finalized header and retry recovery.",
  },
  fullFlow: {
    runningTitle: "Run Full Scripted Appendix",
    currentAction: "Running the scripted route, proof, borrow, oracle shock, liquidation, timeout, and settlement path.",
    expectedVisibleChange: "Scenario cards, risk metrics, proof lifecycle, and settlement evidence update as the script advances.",
    nextAfterSuccess: "Review Risk Admin and Technical / Thesis evidence for defense discussion.",
    affectedPortal: "scenarios",
    affectedMetrics: ["scenarioLiquidationStatus", "riskSettlementStatus", "proofStatusChip", "portalChangeBanner"],
    failureRecovery: "Use Fresh Reset deliberately before rerunning the scenario if it stopped mid-lifecycle.",
  },
  borrowerCloseout: {
    runningTitle: "Close Position & Return Collateral",
    currentAction: "Running the borrower path from bridge through borrow, repay, withdraw, burn, and reverse unlock.",
    expectedVisibleChange: "Borrower journey, reverse proof status, and source collateral balance move to closeout complete.",
    nextAfterSuccess: "Review the proof inspector for the completed reverse unlock evidence.",
    affectedPortal: "borrower",
    affectedMetrics: ["scenarioRepayStatus", "proofStatusChip", "routeReverse", "workflowStepReturn"],
    failureRecovery: "Use Fresh Reset deliberately before rerunning the closeout scenario if an earlier step already consumed state.",
  },
};
const LOAN_TAB_BY_ACTION = {
  borrow: "borrow",
  repay: "repay",
  withdrawCollateral: "withdraw",
};
const SCENARIO_STATUS_BY_ACTION = {
  borrow: "scenarioHealthyStatus",
  repay: "scenarioRepayStatus",
  withdrawCollateral: "scenarioRepayStatus",
  simulatePriceShock: "scenarioLiquidationStatus",
  executeLiquidation: "scenarioLiquidationStatus",
  settleSeizedVoucher: "scenarioLiquidationStatus",
  replayForward: "scenarioReplayStatus",
  executeTimeoutRefund: "scenarioTimeoutStatus",
  freezeClient: "scenarioFreezeStatus",
  recoverClient: "scenarioFreezeStatus",
  fullFlow: "scenarioLiquidationStatus",
  borrowerCloseout: "scenarioRepayStatus",
};
const READ_ONLY_BUTTON_IDS = new Set([
  "refreshState",
  "openVerificationPanel",
  "openVerificationPanelInline",
  "openDemoTools",
  "openRuntimeOutput",
  "focusMode",
]);
const PROOF_STEP_BY_ACTION = {
  lock: "packet-committed",
  finalizeForwardHeader: "header-fetched",
  finalizeReverseHeader: "header-fetched",
  updateForwardClient: "light-client-updated",
  updateReverseClient: "light-client-updated",
  proveForwardMint: "storage-proof",
  proveReverseUnlock: "packet-verified",
  replayForward: "replay-rejected",
  executeTimeoutRefund: "timeout-refund",
  freezeClient: "client-safety",
  recoverClient: "client-safety",
};
const PROOF_STEP_ORDER = [
  "packet-committed",
  "header-fetched",
  "light-client-updated",
  "storage-proof",
  "packet-verified",
  "receipt-consumed",
  "replay-rejected",
  "timeout-refund",
  "client-safety",
];
const DEFAULT_THESIS_MEANING =
  "Proof-checked collateral representation lets the lending pool accept cross-chain collateral without trusting the relayer as a balance oracle.";
const THESIS_MEANING = {
  finalizeForwardHeader:
    "A source-chain block is selected as the evidence anchor; the relayer can fetch it, but cannot make Bank B accept it without light-client verification.",
  updateForwardClient:
    "Bank B imports a Bank A QBFT header, turning a local source event into a verifiable state root for the destination chain.",
  proveForwardMint:
    "Voucher collateral is minted only after a storage proof matches the packet commitment under the trusted Bank A state root.",
  finalizeReverseHeader:
    "The reverse path starts by anchoring the Bank B packet commitment that will release origin collateral on Bank A.",
  updateReverseClient:
    "Bank A must trust a Bank B header before it can verify the reverse unlock proof.",
  proveReverseUnlock:
    "Origin collateral unlock is contract-verified from a reverse packet proof, not decided by the local script.",
  replayForward:
    "The explicit duplicate-packet attempt is rejected by on-chain receipt state, so replay defense does not depend on an honest relayer.",
  executeTimeoutRefund:
    "A timeout refund is backed by receipt absence under a trusted destination state root.",
  freezeClient:
    "Conflicting-header evidence demonstrates the prototype's safety control for a compromised or inconsistent light-client view.",
  recoverClient:
    "Recovery shows the governed prototype can restore a frozen light client without weakening the proof-checked packet model.",
};
let currentStatus = null;
let currentLoanTab = "borrow";
let actionCardPinned = false;
let selectedWorkflowStep = null;
let currentWorkflowAction = { type: "deploySeed" };
let currentRunningAction = null;
let actionPollTimer = null;
let activeScenarioCard = null;
let highlightedNodes = [];

function guideForAction(action) {
  return ACTION_GUIDE[action] || {
    runningTitle: actionTitle(action),
    currentAction: "Submitting the selected demo action to the local controller.",
    expectedVisibleChange: "The affected balances, proof status, or scenario card will update after confirmation.",
    nextAfterSuccess: "Refresh or continue with the next enabled action in the guided workflow.",
    affectedPortal: "borrower",
    affectedMetrics: [],
    failureRecovery: "Check the runtime output, then retry the action from the current state.",
  };
}

function workflowCtaFromServerNext(nextAction) {
  if (!nextAction?.action) return null;
  if (nextAction.action === "deploySeed") {
    return { type: "deploySeed", label: nextAction.label || "Prepare Demo Session" };
  }
  if (nextAction.action === "refresh") {
    return { type: "refresh", label: nextAction.label || "Refresh state" };
  }
  return {
    type: "action",
    action: nextAction.action,
    label: nextAction.label || actionTitle(nextAction.action),
  };
}

function ctaDebugName(cta) {
  if (!cta) return "none";
  if (cta.type === "action") return `${cta.label || actionTitle(cta.action)} (${cta.action})`;
  return `${cta.label || cta.type} (${cta.type})`;
}

function ctaLabel(cta, fallback = "Continue") {
  if (!cta) return fallback;
  if (cta.label) return cta.label;
  if (cta.type === "action") return actionTitle(cta.action);
  if (cta.type === "deploySeed") return "Prepare Demo Session";
  if (cta.type === "resetSeeded") return "Fresh Reset (slow setup only)";
  if (cta.type === "refresh") return "Refresh state";
  if (cta.type === "return") return "Return to recommendation";
  if (cta.type === "portal") return "Open panel";
  return fallback;
}

function ctaIntent(cta) {
  if (!cta) return "No action";
  if (cta.type === "action") return `Action: ${ctaLabel(cta)}`;
  if (cta.type === "deploySeed" || cta.type === "resetSeeded") return "Setup action";
  if (cta.type === "portal") return "Review panel";
  if (cta.type === "refresh") return "Refresh only";
  if (cta.type === "return") return "Navigation";
  return "Workflow action";
}

function bindPrimaryWorkflowCta(cta) {
  if (!primaryWorkflowCta) return;
  delete primaryWorkflowCta.dataset.ctaType;
  delete primaryWorkflowCta.dataset.ctaAction;
  delete primaryWorkflowCta.dataset.ctaPortal;
  delete primaryWorkflowCta.dataset.ctaLabel;
  if (!cta?.type) return;
  primaryWorkflowCta.dataset.ctaType = cta.type;
  if (cta.action) primaryWorkflowCta.dataset.ctaAction = cta.action;
  if (cta.portal) primaryWorkflowCta.dataset.ctaPortal = cta.portal;
  if (cta.label) primaryWorkflowCta.dataset.ctaLabel = cta.label;
}

function primaryWorkflowCtaBinding() {
  if (!primaryWorkflowCta?.dataset.ctaType) return null;
  const type = primaryWorkflowCta.dataset.ctaType;
  const cta = { type, label: primaryWorkflowCta.dataset.ctaLabel || undefined };
  if (type === "action") cta.action = primaryWorkflowCta.dataset.ctaAction;
  if (type === "portal") cta.portal = primaryWorkflowCta.dataset.ctaPortal;
  return cta;
}

function sameCtaIntent(left, right) {
  if (!left || !right) return false;
  if (left.type !== right.type) return false;
  if (left.type === "action") return left.action === right.action;
  if (left.type === "portal") return left.portal === right.portal;
  return true;
}

function forwardProofStepLabel(action) {
  return FORWARD_PROOF_STEP_LABELS[action] || "Receive Verified Collateral";
}

function reverseProofStepLabel(action) {
  return REVERSE_PROOF_STEP_LABELS[action] || "Verify reverse proof and unlock aBANK on Bank A";
}

function avoidRepeatingCompletedAction(cta, completedAction) {
  return Boolean(
    cta?.type === "action" &&
      cta.action === completedAction &&
      DO_NOT_REPEAT_COMPLETED_ACTIONS.has(completedAction)
  );
}

function rememberNextActionFromPayload(payload) {
  if (!currentRunningAction) return;
  const serverCta = workflowCtaFromServerNext(payload?.nextAction);
  currentRunningAction.serverNextAction = serverCta;
  currentRunningAction.uiNextAction = currentWorkflowAction;
  const serverFallback = avoidRepeatingCompletedAction(serverCta, currentRunningAction.action) ? null : serverCta;
  const uiCta = currentWorkflowAction;
  const uiFallback = avoidRepeatingCompletedAction(uiCta, currentRunningAction.action)
    ? { type: "refresh", label: "Refresh state" }
    : uiCta;
  const uiEligibility = workflowCtaEligibility(uiFallback, currentStatus, { recommended: true });
  const serverEligibility = workflowCtaEligibility(serverFallback, currentStatus, { recommended: true });
  if (serverFallback && serverEligibility.ok) {
    currentRunningAction.nextAction =
      uiFallback && uiEligibility.ok && sameCtaIntent(serverFallback, uiFallback)
        ? { ...serverFallback, label: serverFallback.label || uiFallback.label }
        : serverFallback;
    return;
  }
  currentRunningAction.nextAction = uiFallback && uiEligibility.ok ? uiFallback : { type: "refresh", label: "Refresh state" };
}

function workflowCtaEligibility(cta, status = currentStatus, { recommended = false } = {}) {
  const activeOperation = activeControllerOperation(status);
  if (cta?.type === "action" && activeOperation?.action) {
    return { ok: false, message: controllerBusyMessage(activeOperation, cta.action) };
  }
  if (cta?.type === "action") {
    const amountOverride = recommended && AMOUNT_ACTIONS[cta.action] ? defaultAmountForAction(cta.action, status) : null;
    return actionEligibility(cta.action, status, { amountOverride });
  }
  return { ok: true, message: "" };
}

function activeControllerOperation(status = currentStatus) {
  return status?.controller?.activeOperation || null;
}

function controllerStillRunning(status = currentStatus) {
  return Boolean(activeControllerOperation(status)?.action);
}

function controllerBusyMessage(activeOperation, requestedAction = null) {
  const activeLabel = activeOperation?.label || guideForAction(activeOperation?.action).runningTitle;
  const requestedLabel = requestedAction ? guideForAction(requestedAction).runningTitle : "another action";
  return `${activeLabel} is still running. Wait for it to finish before starting ${requestedLabel}.`;
}

function actionResponseMustSettle(action) {
  return STRICT_VISIBLE_COMPLETION_ACTIONS.has(action);
}

function isReadOnlyControl(button) {
  return (
    READ_ONLY_BUTTON_IDS.has(button.id) ||
    button.matches("[data-drawer-close], .portal-tab, .loan-tab") ||
    button.classList.contains("drawer-backdrop")
  );
}

function isMutationControl(button) {
  return (
    button.matches("[data-action]") ||
    button === deploySeedButton ||
    button === resetSeededButton ||
    resumeSessionButtons.includes(button) ||
    button === primaryWorkflowCta ||
    button === topUpRepayCashButton
  );
}

function setBusy(busy) {
  document.body.classList.toggle("is-busy", busy);
  buttons.forEach((button) => {
    if (!button.dataset.originalText) button.dataset.originalText = button.textContent;
    if (button.dataset.originalTitle == null) button.dataset.originalTitle = button.getAttribute("title") || "";
    const mutationControl = isMutationControl(button);
    const readOnlyControl = isReadOnlyControl(button);
    if (busy) {
      button.disabled = mutationControl && !readOnlyControl;
    } else if (mutationControl || button.disabled) {
      button.disabled = false;
    }
    button.classList.toggle("is-loading", busy && button === currentRunningAction?.button);
    button.classList.toggle("is-waiting", busy && mutationControl && button !== currentRunningAction?.button);
    if (busy && button === currentRunningAction?.button) {
      button.title = currentRunningAction?.guide?.currentAction || "Action is running.";
    } else if (busy && mutationControl && !readOnlyControl) {
      button.title = currentRunningAction
        ? `Waiting for ${currentRunningAction.guide.runningTitle}. ${currentRunningAction.guide.expectedVisibleChange}`
        : "Waiting for the current demo action to finish.";
    } else if (!busy) {
      button.classList.remove("is-loading", "is-waiting");
      button.title = button.dataset.originalTitle || "";
    }
  });
  if (!busy) applyActionAvailability(currentStatus);
}

function setOutput(value) {
  setText("contractOutput", value || "No action output yet.");
}

function safetyLocked(status) {
  return Boolean(status?.security?.frozen || status?.security?.recovering);
}

function applyActionAvailability(status) {
  const locked = safetyLocked(status);
  actionButtons.forEach((button) => {
    const allowed = !locked || SAFETY_MODE_ACTIONS.has(button.dataset.action);
    button.disabled = !allowed;
    button.title = allowed
      ? button.dataset.originalTitle || ""
      : "Safety mode is active. Recover the light client before running interchain actions.";
  });
  updateAmountActionAvailability(status);
  syncWorkflowUi(status);
}

function setDrawerExpanded(id, expanded) {
  if (id === "demoToolsDrawer" && openDemoToolsButton) {
    openDemoToolsButton.setAttribute("aria-expanded", expanded ? "true" : "false");
  }
  if (id === "verificationDrawer") {
    verificationOpenButtons.forEach((button) => button.setAttribute("aria-expanded", expanded ? "true" : "false"));
  }
  if (id === "runtimeOutputDrawer" && openRuntimeOutputButton) {
    openRuntimeOutputButton.setAttribute("aria-expanded", expanded ? "true" : "false");
  }
}

function closeDrawer(id) {
  const drawer = document.getElementById(id);
  if (!drawer) return;
  drawer.classList.remove("is-open");
  drawer.setAttribute("aria-hidden", "true");
  setDrawerExpanded(id, false);
  if (![...drawers].some((node) => node.classList.contains("is-open"))) {
    document.body.classList.remove("has-drawer-open");
  }
}

function openDrawer(id) {
  drawers.forEach((drawer) => {
    const shouldOpen = drawer.id === id;
    drawer.classList.toggle("is-open", shouldOpen);
    drawer.setAttribute("aria-hidden", shouldOpen ? "false" : "true");
    setDrawerExpanded(drawer.id, shouldOpen);
  });
  document.body.classList.toggle("has-drawer-open", true);
}

function numeric(value) {
  const number = Number(String(value ?? "0").replace(/,/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function positive(value) {
  return numeric(value) > POSITION_EPSILON;
}

function clamp(value, min = 0, max = Number.POSITIVE_INFINITY) {
  return Math.min(max, Math.max(min, value));
}

function repayCloseBuffer(amount) {
  const number = numeric(amount);
  if (number <= 0) return 0;
  return Math.max((number * REPAY_CLOSE_BUFFER_BPS) / 10_000, REPAY_CLOSE_MIN_BUFFER);
}

function formatAmount(value, unit = "", options = {}) {
  const number = numeric(value);
  const maximumFractionDigits = options.maximumFractionDigits ?? (number >= 1000 ? 2 : 4);
  const formatted = number.toLocaleString(undefined, {
    minimumFractionDigits: options.minimumFractionDigits ?? 0,
    maximumFractionDigits,
  });
  return `${formatted}${unit ? ` ${unit}` : ""}`;
}

function inputValue(id) {
  const input = document.getElementById(id);
  return numeric(input?.value);
}

function syncAmountFieldState(input) {
  if (!input) return;
  const field = input.closest(".amount-field");
  if (!field) return;
  field.classList.toggle("is-filled", numeric(input.value) > 0);
  field.classList.toggle("is-dirty", input.dataset.dirty === "true");
}

function setActiveActionCard(cardName, { pinned = false } = {}) {
  if (!cardName) return;
  actionCards.forEach((card) => {
    card.classList.toggle("is-active", card.dataset.actionCard === cardName);
  });
  if (pinned) actionCardPinned = true;
}

function suggestActionCard(status) {
  const state = financialState(status);
  const lifecycle = lifecycleState(status);
  const reverse = status?.trace?.reverse || {};
  if (lifecycle.returnStarted || lifecycle.freeVoucher || reverse.commitHeight || reverse.packetId || reverseConsumed(status)) return "redeem";
  if (state.voucher > 0 || state.collateral > 0 || state.debt > 0 || state.bankB > 0) return "loan";
  return "bridge";
}

function setLoanTab(tab) {
  currentLoanTab = tab;
  loanTabButtons.forEach((button) => {
    const active = button.dataset.loanTab === tab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
    button.setAttribute("tabindex", active ? "0" : "-1");
  });
  loanTabPanels.forEach((panel) => {
    const active = panel.dataset.loanPanel === tab;
    panel.classList.toggle("is-active", active);
    panel.hidden = !active;
  });
}

function setActivePortal(portal) {
  const active = ["borrower", "risk", "technical", "scenarios"].includes(portal) ? portal : "borrower";
  document.body.dataset.activePortal = active;
  portalButtons.forEach((button) => {
    const selected = button.dataset.portalTab === active;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-selected", selected ? "true" : "false");
  });
  try {
    sessionStorage.setItem(PORTAL_STORAGE_KEY, active);
  } catch {}
}

function getLinkyVariant(state = {}) {
  if (state.risk || state.blocked || state.error || state.health === "danger") return "risk";
  if (state.success || state.completed) return "success";
  if (state.welcome || state.empty) return "wave";
  return "thinking";
}

function linkyAsset(variant = "head") {
  return LINKY_ASSETS[variant] || LINKY_ASSETS.head;
}

function setLinkyImageVariant(image, variant = "head") {
  if (!image) return;
  const safeVariant = LINKY_ASSETS[variant] ? variant : "head";
  image.dataset.linkyVariant = safeVariant;
  const asset = linkyAsset(safeVariant);
  if (missingLinkyAssets.has(safeVariant)) {
    image.hidden = true;
    image.closest(".linky")?.classList.add("is-fallback");
    return;
  }
  image.closest(".linky")?.classList.remove("is-fallback");
  if (!image.src.endsWith(asset.replace("./", ""))) {
    image.hidden = false;
    image.src = asset;
  }
}

function setupLinkyFallbacks() {
  linkyImages.forEach((image) => {
    const markMissing = () => {
      const variant = image.dataset.linkyVariant || "head";
      missingLinkyAssets.add(variant);
      image.hidden = true;
      image.closest(".linky")?.classList.add("is-fallback");
    };
    image.addEventListener("error", () => {
      markMissing();
    });
    image.addEventListener("load", () => {
      image.hidden = false;
      image.closest(".linky")?.classList.remove("is-fallback");
    });
    if (image.complete && image.naturalWidth === 0) markMissing();
    setLinkyImageVariant(image, image.dataset.linkyVariant || "head");
  });
}

function setPrimaryLinkyVariant(variant = "head") {
  if (!primaryLinky) return;
  const safeVariant = LINKY_ASSETS[variant] ? variant : "head";
  primaryLinky.dataset.variant = safeVariant;
  setLinkyImageVariant(primaryLinkyImage, safeVariant);
}

function setLinkyHelper(key, { variant = "thinking", title = "", copy = "", hidden = false, tone = "" } = {}) {
  const helper = document.getElementById(`${key}LinkyHelper`);
  if (!helper) return;
  helper.hidden = hidden;
  helper.classList.toggle("is-risk", tone === "risk");
  helper.classList.toggle("is-success", tone === "success");
  setText(`${key}LinkyTitle`, title);
  setText(`${key}LinkyCopy`, copy);
  setLinkyImageVariant(helper.querySelector("[data-linky-img]"), variant);
}

function setPortalFeedbackLinky(variant) {
  setLinkyImageVariant(document.getElementById("portalChangeLinkyImage"), variant);
}

function updateLinkyGuides(status = currentStatus) {
  const state = financialState(status);
  const lifecycle = lifecycleState(status);
  const forward = status?.trace?.forward || {};
  const reverse = status?.trace?.reverse || {};
  const proof = status?.proofInspector || {};
  const noBridgeActivity =
    state.deployed &&
    state.escrow <= POSITION_EPSILON &&
    state.voucher <= POSITION_EPSILON &&
    state.collateral <= POSITION_EPSILON &&
    state.debt <= POSITION_EPSILON &&
    !forward.packetId &&
    !forward.commitHeight;

  setLinkyHelper("bridge", {
    variant: "wave",
    title: "No bridge activity yet",
    copy: "Let's begin by locking collateral on Bank A, then receive the voucher proof on Bank B.",
    hidden: !noBridgeActivity,
  });

  const noVoucherCollateral = state.deployed && state.voucher <= POSITION_EPSILON && !lifecycle.collateralWasDeposited;
  setLinkyHelper("deposit", {
    variant: "thinking",
    title: noVoucherCollateral ? "No voucher collateral yet" : "Voucher collateral is ready",
    copy: noVoucherCollateral
      ? "Bridge your asset first; once the proof mints voucher collateral, this deposit step becomes available."
      : "Deposit only the voucher amount you want to make active collateral for borrowing.",
    hidden: false,
  });

  const noProofActivity =
    !forward.packetId &&
    !forward.commitHeight &&
    !reverse.packetId &&
    !reverse.commitHeight &&
    !proof.headerHash &&
    !proof.storageSlot &&
    !proof.proofVerificationResult;
  setLinkyHelper("proof", {
    variant: "thinking",
    title: noProofActivity ? "No proof imported yet" : "Proof path is active",
    copy: noProofActivity
      ? "Lock collateral or burn voucher first; then Linky will point to the trusted header and storage proof path."
      : "The proof inspector is tracking the packet, trusted header, storage proof, and one-time receipt status.",
    hidden: false,
  });

  const burnEligibility = actionEligibility("burn", status);
  let returnVariant = "thinking";
  let returnTone = "";
  let returnTitle = "Closeout sequence";
  let returnCopy = "Repay debt -> withdraw collateral -> burn voucher -> verify reverse proof -> unlock Bank A collateral.";
  if (lifecycle.borrowerReverseComplete || reverseConsumed(status)) {
    returnVariant = "success";
    returnTone = "success";
    returnTitle = "Collateral returned";
    returnCopy = "Reverse proof execution is complete and Bank A collateral has been unlocked.";
  } else if (reversePacketPending(status)) {
    returnTitle = "Reverse proof is ready";
    returnCopy = "Verify the reverse packet proof to unlock Bank A collateral.";
  } else if (state.debt > POSITION_EPSILON) {
    returnVariant = "risk";
    returnTone = "risk";
    returnTitle = "Repay debt first";
    returnCopy = "Repay all debt before returning collateral.";
  } else if (lifecycle.activeCollateral && !burnEligibility.ok) {
    returnVariant = "risk";
    returnTone = "risk";
    returnTitle = "Withdraw before burning";
    returnCopy = "Withdraw collateral from the lending pool before burning voucher.";
  } else if (lifecycle.freeVoucher || state.voucher > POSITION_EPSILON) {
    returnTitle = "Burn voucher next";
    returnCopy = "Your voucher is free on Bank B. Burn it to commit the reverse unlock packet.";
  }
  setLinkyHelper("return", {
    variant: returnVariant,
    tone: returnTone,
    title: returnTitle,
    copy: returnCopy,
  });
}

function setPrimaryGuideVisible(visible) {
  const guide = document.getElementById("primaryActionGuide");
  if (guide) guide.hidden = !visible;
}

function fallbackStage(action, elapsedSeconds = 0) {
  if (elapsedSeconds < 1) return "Preparing context";
  if (["proveForwardMint", "proveReverseUnlock", "replayForward", "executeTimeoutRefund"].includes(action)) {
    if (elapsedSeconds < 4) return "Importing trusted header";
    if (elapsedSeconds < 10) return "Generating storage proof";
    return "Waiting for proof transaction confirmation";
  }
  if (["finalizeForwardHeader", "finalizeReverseHeader"].includes(action)) return "Reading finalized Besu header";
  if (["updateForwardClient", "updateReverseClient", "recoverClient"].includes(action)) return "Importing trusted header";
  if (["fullFlow", "borrowerCloseout"].includes(action)) {
    if (elapsedSeconds < 5) return "Preparing scripted lifecycle";
    if (elapsedSeconds < 15) return "Submitting transactions";
    if (elapsedSeconds < 30) return "Generating proofs and refreshing state";
    return "Waiting for long-running confirmations";
  }
  if (elapsedSeconds < 5) return "Submitting transaction";
  return "Waiting for transaction confirmation";
}

function renderPrimaryGuide(actionState) {
  const guide = actionState?.guide;
  if (!guide) {
    setPrimaryGuideVisible(false);
    return;
  }
  const nextCta = actionState.phase === "success" ? actionState.nextAction || currentWorkflowAction : null;
  const nextCopy = nextCta?.label ? `Next: ${nextCta.label}.` : guide.nextAfterSuccess;
  const prefix =
    actionState.phase === "failed"
      ? "Failed"
      : actionState.phase === "warning"
        ? "Needs reset"
        : actionState.phase === "success" && nextCta?.label
          ? "Next"
          : actionState.phase === "success"
            ? "Completed"
          : "Processing";
  const controller = actionState.controller;
  const elapsed =
    actionState.completedElapsedSeconds ??
    controller?.elapsedSeconds ??
    (actionState.startedAtMs ? Math.max(0, Math.round((Date.now() - actionState.startedAtMs) / 1000)) : 0);
  let stage = controller?.stage || fallbackStage(actionState.action, elapsed);
  if (actionState.phase === "success") stage = "Rendering visible changes";
  if (actionState.phase === "warning") stage = "Reuse readiness check did not confirm runtime";
  if (actionState.phase === "failed") stage = "Stopped before visible state changed";
  const controllerStatus =
    actionState.phase === "running"
      ? controller?.stage
        ? "Active"
        : "Waiting"
      : actionState.phase === "success"
        ? "Complete"
        : actionState.phase === "warning"
          ? "Review"
          : "Stopped";
  const failureMessage = actionState.error?.userMessage || actionState.error?.message || null;
  const guideNode = document.getElementById("primaryActionGuide");
  if (guideNode) guideNode.dataset.phase = actionState.phase;
  setPrimaryLinkyVariant(
    actionState.phase === "running"
      ? "thinking"
      : actionState.phase === "success"
        ? "success"
        : actionState.phase === "failed" || actionState.phase === "warning"
          ? "risk"
          : "head"
  );
  setPrimaryGuideVisible(true);
  setText("primaryActionTitle", `${prefix}: ${actionState.phase === "success" && nextCta?.label ? nextCta.label : guide.runningTitle}`);
  setText("primaryActionState", `State: ${controllerStatus}`);
  setText(
    "primaryActionIntent",
    actionState.phase === "success" && nextCta?.label ? ctaIntent(nextCta) : `Action: ${guide.runningTitle}`
  );
  setText(
    "primaryActionDescription",
    actionState.phase === "running"
      ? "The live action card tracks the controller while read-only demo panels remain available."
      : actionState.phase === "success" && nextCta?.label
        ? `${guide.runningTitle} completed. The button below submits the next on-chain action; it does not repeat the completed one.`
        : actionState.phase === "success"
          ? "Completed action remains visible so the state change is easy to explain."
        : actionState.phase === "warning"
          ? "The controller did not modify protocol state and is asking for a deliberate reset."
          : failureMessage || "Review the recovery instruction before retrying."
  );
  setText("primaryGuideMode", prefix);
  setText("primaryGuideProcessing", actionState.phase === "success" && nextCta?.label ? nextCta.label : guide.runningTitle);
  setText("primaryGuideStage", stage);
  setText("primaryGuideElapsed", controllerStatus);
  setText(
    "primaryGuideCurrent",
    actionState.phase === "success" && nextCta?.label
      ? `Ready to run ${nextCta.label}. Last completed: ${guide.runningTitle}.`
      : guide.currentAction
  );
  setText(
    "primaryGuideExpected",
    actionState.phase === "success" && nextCta?.label
      ? "The next action will show its own live progress and visible state change after you start it."
      : guide.expectedVisibleChange
  );
  setText(
    "primaryGuideNext",
    actionState.phase === "failed" || actionState.phase === "warning"
      ? failureMessage || guide.failureRecovery
      : nextCopy
  );
  const controllerCopy =
    controller?.label
      ? `Controller: ${controller.label} / ${stage}.`
      : actionState.phase === "running"
        ? "Waiting for transaction confirmation, proof generation, or refreshed dashboard state."
        : actionState.phase === "failed" || actionState.phase === "warning"
          ? failureMessage || "Action stopped before the expected state change completed."
          : nextCta?.label
            ? `Action completed; next recommendation is ${nextCta.label}.`
            : "Action completed; visible state has been refreshed.";
  setText("primaryGuideController", controllerCopy);
  setText(
    "primaryActionHint",
    actionState.phase === "failed" || actionState.phase === "warning" ? failureMessage || guide.failureRecovery : nextCopy
  );
  if (primaryWorkflowCta) {
    if (actionState.phase === "success" && nextCta?.type === "action") {
      primeRecommendedAmount(nextCta.action, currentStatus, { force: true });
    }
    bindPrimaryWorkflowCta(actionState.phase === "success" ? nextCta : null);
    const nextValidation = nextCta ? workflowCtaEligibility(nextCta, currentStatus, { recommended: true }) : { ok: true, message: "" };
    primaryWorkflowCta.disabled = actionState.phase === "running" || (actionState.phase === "success" && !nextValidation.ok);
    primaryWorkflowCta.title = actionState.phase === "success" && !nextValidation.ok ? nextValidation.message : "";
    primaryWorkflowCta.dataset.state = actionState.phase === "success" && !nextValidation.ok ? "blocked" : actionState.phase;
    primaryWorkflowCta.textContent =
      actionState.phase === "running"
        ? guide.runningTitle
        : actionState.phase === "failed" || actionState.phase === "warning"
          ? "Review recovery step"
          : nextCta?.label
            ? `Run ${nextCta.label}`
            : "Continue";
  }
}

function clearPrimaryGuide() {
  currentRunningAction = null;
  setPrimaryGuideVisible(false);
  syncWorkflowUi(currentStatus);
}

function setInputValue(id, value, { force = false } = {}) {
  const input = document.getElementById(id);
  if (!input || (!force && input.dataset.dirty === "true")) return;
  const nextValue = clamp(numeric(value)).toFixed(4).replace(/\.?0+$/, "");
  input.value = nextValue === "" ? "0" : nextValue;
  input.dataset.dirty = "false";
  syncAmountFieldState(input);
}

function financialState(status) {
  const balances = status?.balances || {};
  const market = status?.market || {};
  const collateral = numeric(balances.poolCollateral);
  const debt = numeric(balances.poolDebt);
  const maxBorrow = numeric(market.maxBorrow);
  const liquidationThresholdValue = numeric(market.liquidationThresholdValue || status?.risk?.position?.liquidationThresholdValue);
  const withdrawable =
    collateral <= 0
      ? 0
      : debt <= 0
        ? collateral
        : maxBorrow > 0
          ? clamp(collateral - (collateral * debt) / maxBorrow, 0, collateral)
          : 0;
  return {
    deployed: Boolean(status?.deployed),
    bankA: numeric(balances.bankA),
    bankB: numeric(balances.bankB),
    escrow: numeric(balances.escrow),
    voucher: numeric(balances.voucher),
    collateral,
    debt,
    poolCash: numeric(balances.poolCash),
    maxBorrow,
    liquidationThresholdValue,
    availableBorrow: numeric(market.availableToBorrow),
    withdrawable,
  };
}

function projectedHealth(liquidationThresholdValue, debt) {
  if (debt <= 0) return { label: "No debt", status: "Safe", percent: null };
  const percent = liquidationThresholdValue > 0 ? (liquidationThresholdValue / debt) * 100 : 0;
  const label = `${percent >= 10 ? percent.toFixed(1) : percent.toFixed(2)}%`;
  if (percent >= 150) return { label, status: "Safe", percent };
  if (percent >= 120) return { label, status: "Watch", percent };
  if (percent >= 100) return { label, status: "Danger", percent };
  return { label, status: "Liquidatable", percent };
}

function projectedMaxBorrowForCollateral(status, nextCollateral) {
  const state = financialState(status);
  const collateral = numeric(nextCollateral);
  if (collateral <= 0) return 0;
  if (state.collateral > POSITION_EPSILON && state.maxBorrow > 0) {
    return (state.maxBorrow * collateral) / state.collateral;
  }
  const risk = status?.risk || {};
  const collateralPrice = numeric(risk.oracle?.collateralPrice ?? status?.market?.voucherPrice);
  const debtPrice = numeric(risk.oracle?.debtPrice ?? status?.market?.debtPrice) || 1;
  const haircut = numeric(risk.policy?.collateralHaircutBps) || 10_000;
  const collateralFactor = numeric(risk.policy?.collateralFactorBps) || 0;
  if (collateralPrice <= 0 || debtPrice <= 0 || collateralFactor <= 0) return 0;
  const collateralValue = collateral * collateralPrice * (haircut / 10_000);
  return (collateralValue * (collateralFactor / 10_000)) / debtPrice;
}

function healthForShockPrice(status, shockPrice) {
  const state = financialState(status);
  const risk = status?.risk || {};
  if (state.debt <= 0) return { label: "No debt", status: "Safe", percent: null };
  const debtPrice = numeric(risk.oracle?.debtPrice) || 1;
  const liquidationThreshold = numeric(risk.policy?.liquidationThresholdBps) || numeric(risk.policy?.collateralFactorBps) || 0;
  const haircut = numeric(risk.policy?.collateralHaircutBps) || 10_000;
  const collateralValue = state.collateral * shockPrice * (haircut / 10_000);
  const permittedDebtValue = collateralValue * (liquidationThreshold / 10_000);
  const debtValue = state.debt * debtPrice;
  const healthBps = debtValue > 0 ? (permittedDebtValue / debtValue) * 10_000 : Number.MAX_SAFE_INTEGER;
  return healthFromBps(String(Math.floor(healthBps)));
}

function heightAtLeast(value, minimum) {
  if (value == null || minimum == null) return false;
  try {
    return BigInt(value) >= BigInt(minimum);
  } catch {
    return false;
  }
}

function healthFromStatus(status) {
  const raw = String(status?.market?.healthFactorBps ?? "");
  return healthFromBps(raw);
}

function liquidationReady(status) {
  const health = healthFromStatus(status);
  return Boolean(
    status?.risk?.position?.liquidatable ||
      status?.risk?.liquidationPreview?.executable ||
      (health.percent != null && health.percent < 100)
  );
}

function healthFromBps(rawValue) {
  const raw = String(rawValue ?? "");
  if (!raw || raw === String(2n ** 256n - 1n)) return { label: "No debt", status: "Safe", percent: null };
  const percent = Number(raw) / 100;
  if (!Number.isFinite(percent)) return { label: "-", status: "Waiting", percent: null };
  if (percent >= 150) return { label: `${percent.toFixed(1)}%`, status: "Safe", percent };
  if (percent >= 120) return { label: `${percent.toFixed(1)}%`, status: "Watch", percent };
  if (percent >= 100) return { label: `${percent.toFixed(1)}%`, status: "Danger", percent };
  return { label: `${percent.toFixed(1)}%`, status: "Liquidatable", percent };
}

function bridgeProofAction(status) {
  const forward = status?.trace?.forward || {};
  const progress = status?.progress || {};
  const headerReady = heightAtLeast(forward.finalizedHeight, forward.commitHeight);
  const trustReady =
    heightAtLeast(progress.trustedAOnB, forward.commitHeight) ||
    heightAtLeast(forward.trustedHeight, forward.commitHeight);
  if (!headerReady && !trustReady) return "finalizeForwardHeader";
  return trustReady ? "proveForwardMint" : "updateForwardClient";
}

function securityHas(status, key) {
  return Object.prototype.hasOwnProperty.call(status?.security || {}, key);
}

function forwardReceiptConsumed(status) {
  return Boolean(
    status?.security?.forwardConsumed ||
      status?.trace?.forward?.receiveTxHash
  );
}

function forwardConsumed(status) {
  if (forwardReceiptConsumed(status)) return true;
  return !forwardPacketPending(status) && (positive(status?.balances?.voucher) || positive(status?.balances?.poolCollateral));
}

function reverseConsumed(status) {
  return Boolean(
    status?.security?.reverseConsumed ||
      status?.trace?.reverse?.receiveTxHash ||
      status?.risk?.settlement?.unlocked ||
      status?.trace?.liquidatorSettlement?.unlockTxHash
  );
}

function reverseProofAction(status) {
  const reverse = status?.trace?.reverse || {};
  const progress = status?.progress || {};
  if (!reverse.packetId && !reverse.commitHeight) return "burn";
  if (reverseConsumed(status)) return null;
  const headerReady = heightAtLeast(reverse.finalizedHeight, reverse.commitHeight);
  const trustReady =
    heightAtLeast(progress.trustedBOnA, reverse.commitHeight) ||
    heightAtLeast(reverse.trustedHeight, reverse.commitHeight);
  if (!headerReady && !trustReady) return "finalizeReverseHeader";
  return trustReady ? "proveReverseUnlock" : "updateReverseClient";
}

function routeReady(status) {
  const trace = status?.trace || {};
  return Boolean(
    trace.handshake?.ready ||
      trace.handshake?.sourceRouteOpen ||
      trace.handshake?.destinationRouteOpen ||
      trace.forward?.commitHeight ||
      trace.forward?.packetId ||
      numeric(status?.progress?.packetSequenceA) > 0
  );
}

function lifecycleState(status) {
  const state = financialState(status);
  const trace = status?.trace || {};
  const lending = trace.lending || {};
  const traceRisk = trace.risk || {};
  const reverse = trace.reverse || {};
  const settlement = status?.risk?.settlement || {};
  const afterLiquidation = status?.risk?.afterLiquidation || {};
  const freeVoucher = positive(state.voucher);
  const activeCollateral = positive(state.collateral);
  const activeDebt = positive(state.debt);
  const debtWasOpened = Boolean(
    lending.borrowed ||
      traceRisk.borrowed ||
      traceRisk.debtBeforeRepay ||
      traceRisk.repayTxHash ||
      traceRisk.repaid ||
      traceRisk.liquidationTxHash ||
      traceRisk.debtBeforeLiquidation ||
      activeDebt
  );
  const collateralWasDeposited = Boolean(
    lending.collateralDeposited ||
      traceRisk.collateralDeposited ||
      traceRisk.collateralBeforeWithdrawal ||
      traceRisk.withdrawTxHash ||
      activeCollateral ||
      debtWasOpened
  );
  const borrowerCollateralWithdrawn = Boolean(
    lending.collateralWithdrawn ||
      traceRisk.collateralWithdrawn ||
      traceRisk.withdrawTxHash ||
      (debtWasOpened && collateralWasDeposited && !activeCollateral)
  );
  const settlementTrace = trace.liquidatorSettlement || {};
  const settlementPacketId = settlement.packetId || settlementTrace.packetId;
  const settlementMatchesReverse = Boolean(settlementPacketId && settlementPacketId === reverse.packetId);
  const reverseStarted = Boolean(reverse.packetId || reverse.commitHeight || reverse.sourceTxHash);
  const settlementStarted = Boolean(
    settlementMatchesReverse &&
      (settlement.started ||
        settlementTrace.packetId ||
        settlementTrace.burnTxHash ||
        reverse.settlementMode === "authorized-liquidator")
  );
  const settlementUnlocked = Boolean(settlementMatchesReverse && (settlement.unlocked || settlementTrace.unlockTxHash));
  const borrowerReverseStarted = reverseStarted && !settlementStarted;
  const borrowerReverseComplete = Boolean(borrowerReverseStarted && reverseConsumed(status));
  const liquidationExecuted = Boolean(afterLiquidation.executed || traceRisk.liquidationTxHash || lending.liquidated);
  const settlementVoucher = positive(settlement.seizedVoucherBalance || status?.balances?.liquidatorVoucher);

  return {
    debtWasOpened,
    collateralWasDeposited,
    borrowerCollateralWithdrawn,
    activeDebt,
    activeCollateral,
    freeVoucher,
    reverseStarted,
    borrowerReverseStarted,
    borrowerReverseComplete,
    liquidationExecuted,
    settlementStarted,
    settlementUnlocked,
    settlementVoucher,
    returnStarted: borrowerReverseStarted || settlementStarted,
    returnComplete: borrowerReverseComplete || settlementUnlocked,
  };
}

function setWorkflowStepStatus(id, state, text) {
  const node = document.getElementById(id);
  if (!node) return;
  node.classList.toggle("is-done", state === "done");
  node.classList.toggle("is-active", state === "active");
  node.classList.toggle("is-locked", state === "locked");
  let strong = node.querySelector("strong");
  if (!strong) {
    node.innerHTML = "";
    strong = document.createElement("strong");
    node.appendChild(strong);
  }
  strong.textContent = text;
}

function repayFundingShortfall(status = currentStatus) {
  const state = financialState(status);
  const target = state.debt > POSITION_EPSILON ? state.debt + repayCloseBuffer(state.debt) : 0;
  return Math.max(0, target - state.bankB);
}

function workflowStepsForStatus(status) {
  const state = financialState(status);
  const lifecycle = lifecycleState(status);
  const forwardPending = forwardPacketPending(status);
  const reversePending = reversePacketPending(status);
  const routeOpen = routeReady(status);
  const forwardDelivered =
    !forwardPending &&
    (forwardConsumed(status) ||
      state.voucher > POSITION_EPSILON ||
      state.collateral > POSITION_EPSILON ||
      state.debt > POSITION_EPSILON ||
      lifecycle.returnStarted ||
      lifecycle.liquidationExecuted);
  const debtClosedAfterBorrow = lifecycle.debtWasOpened && !lifecycle.activeDebt;

  return {
    connect: {
      complete: state.deployed,
      unlocked: true,
      label: state.deployed ? "Ready" : "Start here",
    },
    bridge: {
      complete: forwardDelivered,
      unlocked: state.deployed,
      label: forwardDelivered ? "Done" : forwardPending ? "Proof pending" : routeOpen ? "Route ready" : state.deployed ? "Establish route" : "Waiting",
    },
    activate: {
      complete: lifecycle.collateralWasDeposited || lifecycle.returnStarted || lifecycle.liquidationExecuted,
      unlocked: lifecycle.freeVoucher || lifecycle.activeCollateral || lifecycle.activeDebt || lifecycle.returnStarted,
      label:
        lifecycle.collateralWasDeposited || lifecycle.returnStarted
          ? "Deposited"
          : lifecycle.freeVoucher
            ? "Ready"
            : "Waiting",
    },
    borrow: {
      complete: lifecycle.debtWasOpened || lifecycle.liquidationExecuted,
      unlocked: lifecycle.activeCollateral || lifecycle.activeDebt || lifecycle.debtWasOpened,
      label: lifecycle.debtWasOpened ? "Borrowed" : lifecycle.activeCollateral ? "Ready" : "Waiting",
    },
    manage: {
      complete: lifecycle.borrowerCollateralWithdrawn || lifecycle.returnStarted || lifecycle.liquidationExecuted,
      unlocked: lifecycle.activeDebt || lifecycle.activeCollateral || lifecycle.debtWasOpened || lifecycle.liquidationExecuted,
      label: lifecycle.activeDebt
        ? "Debt open"
        : lifecycle.borrowerCollateralWithdrawn
          ? "Withdrawn"
          : debtClosedAfterBorrow && lifecycle.activeCollateral
            ? "Closeout ready"
            : lifecycle.activeCollateral
              ? "Optional"
              : lifecycle.liquidationExecuted
                ? "Risk path"
                : "Waiting",
    },
    return: {
      complete: lifecycle.returnComplete,
      unlocked:
        lifecycle.returnStarted ||
        lifecycle.freeVoucher ||
        lifecycle.settlementVoucher ||
        lifecycle.liquidationExecuted ||
        debtClosedAfterBorrow,
      label: lifecycle.returnComplete
        ? "Done"
        : lifecycle.liquidationExecuted
          ? "Review"
          : reversePending
            ? "Proof pending"
            : lifecycle.settlementVoucher
              ? "Settle"
              : lifecycle.borrowerCollateralWithdrawn && lifecycle.freeVoucher
                ? "Burn ready"
                : debtClosedAfterBorrow && lifecycle.activeCollateral
                  ? "Withdraw first"
                  : "Waiting",
    },
  };
}

function workflowRecommendation(status) {
  const state = financialState(status);
  const lifecycle = lifecycleState(status);
  const health = healthFromStatus(status);
  const routeOpen = routeReady(status);
  const forwardPending = forwardPacketPending(status);
  const reverseAction = reverseProofAction(status);
  const reversePending = reversePacketPending(status);
  const elevatedRisk = lifecycle.activeDebt && ["Watch", "Danger", "Liquidatable"].includes(health.status);

  if (!state.deployed) {
    return {
      step: "connect",
      title: "Prepare demo session",
      status: "Start here",
      summary: "Confirm the local Besu runtime before collateral transfer and borrowing actions.",
      cta: { type: "deploySeed", label: "Prepare Demo Session" },
      description: "Reuse a valid seeded runtime when available. Fresh Reset remains a separate deliberate reset control.",
      hint: "No transfer, borrow, repay, or proof action runs until the account is prepared.",
      risk: "waiting",
    };
  }

  if (safetyLocked(status)) {
    return {
      step: "manage",
      title: "Recover account safety",
      status: "Safety mode",
      summary: "Safety controls are active. Recover before changing collateral or debt.",
      cta: { type: "action", action: "recoverClient", label: "Recover Account" },
      description: "The only recommended protocol action is recovery while the light-client safety state is active.",
      hint: "Collateral, bridge, and lending actions stay disabled until recovery finishes.",
      risk: "risk",
    };
  }

  if (lifecycle.liquidationExecuted) {
    return {
      step: "return",
      title: "Show technical evidence",
      status: "Liquidation executed",
      summary: "The main customer-facing demo is complete.",
      cta: { type: "portal", portal: "technical", label: "Show Technical Evidence" },
      description: "Open the proof panel to review packet proof, trusted height, state root, receipt replay guard, and risk evidence.",
      hint: "Advanced settlement and recovery controls remain outside the primary live flow.",
      risk: "risk",
    };
  }

  if (lifecycle.borrowerReverseComplete) {
    return {
      step: "return",
      title: "Collateral returned",
      status: "Complete",
      summary: "The borrower closeout path has completed.",
      cta: { type: "portal", portal: "technical", label: "Review Proof" },
      description: "Inspect the proof and packet evidence behind the completed reverse unlock.",
      hint: "The account can start another borrow cycle, but the current guided closeout is complete.",
      risk: "safe",
    };
  }

  if (lifecycle.borrowerReverseStarted || reversePending) {
    const action = reverseAction || "proveReverseUnlock";
    return {
      step: "return",
      title: "Complete collateral release",
      status: "Proof pending",
      summary: "A reverse packet exists and needs proof verification.",
      cta: { type: "action", action, label: reverseProofStepLabel(action) },
      description: "Run the next reverse proof sub-step only; it will not repeat the burn action.",
      hint: "The reverse path is ordered as header fetch, light-client import, then proof unlock.",
      risk: "waiting",
    };
  }

  if (lifecycle.borrowerCollateralWithdrawn && lifecycle.freeVoucher) {
    return {
      step: "return",
      title: "Return collateral to Bank A",
      status: "Burn ready",
      summary: "Voucher collateral is free in the Bank B wallet.",
      cta: { type: "action", action: "burn", label: "Burn voucher and start Bank A unlock" },
      description: "Burn the free voucher and commit the reverse packet for source-bank unlock.",
      hint: `${formatAmount(state.voucher, "vA")} free voucher available to return.`,
      risk: "safe",
    };
  }

  if (forwardPending) {
    const action = bridgeProofAction(status);
    return {
      step: "bridge",
      title: "Bridge in progress",
      status: "Proof pending",
      summary: "The forward packet exists and is waiting for its next proof sub-step.",
      cta: { type: "action", action, label: forwardProofStepLabel(action) },
      description: "Run only the next bridge proof sub-step so voucher collateral becomes visible on Bank B.",
      hint: "The bridge path is ordered as header fetch, light-client import, then proof mint.",
      risk: "waiting",
    };
  }

  if (lifecycle.freeVoucher && !lifecycle.activeCollateral && !lifecycle.activeDebt) {
    const returning = lifecycle.borrowerCollateralWithdrawn || lifecycle.debtWasOpened;
    return returning
      ? {
          step: "return",
          title: "Return collateral to Bank A",
          status: "Burn ready",
          summary: "Debt is closed and voucher collateral is free.",
          cta: { type: "action", action: "burn", label: "Burn voucher and start Bank A unlock" },
          description: "Burn the voucher before running the reverse proof unlock.",
          hint: `${formatAmount(state.voucher, "vA")} free voucher available to return.`,
          risk: "safe",
        }
      : {
          step: "activate",
          title: "Activate collateral",
          status: "Deposit ready",
          summary: "Voucher collateral is ready to become lending collateral.",
          cta: { type: "action", action: "depositCollateral", label: "Deposit Collateral" },
          description: "Deposit the free voucher into the lending pool to unlock borrowing power.",
          hint: `${formatAmount(state.voucher, "vA")} available to deposit.`,
          risk: "safe",
        };
  }

  if (lifecycle.activeDebt) {
    const canLiquidate = liquidationReady(status);
    return {
      step: "manage",
      title: canLiquidate ? "Execute liquidation" : "Simulate collateral price drop",
      status: canLiquidate ? "Liquidatable" : "Debt open",
      summary: canLiquidate
        ? "The account is below the liquidation threshold."
        : "Debt is open. The live demo now moves to the governed oracle price-drop scenario.",
      cta: canLiquidate
        ? { type: "action", action: "executeLiquidation", label: "Execute Liquidation" }
        : { type: "action", action: "simulatePriceShock", label: "Simulate Collateral Price Drop" },
      description: canLiquidate
        ? "Run liquidation through the lending pool, which still checks health factor and liquidator authorization on-chain."
        : "Apply the demo price shock before liquidation so the health-factor rule becomes visible.",
      hint: canLiquidate ? `${health.label} health factor.` : `${formatAmount(state.debt, "bCASH")} debt outstanding.`,
      risk: canLiquidate || elevatedRisk ? "risk" : "safe",
    };
  }

  if (lifecycle.activeCollateral && lifecycle.debtWasOpened) {
    return {
      step: "return",
      title: "Withdraw collateral to close",
      status: "Debt closed",
      summary: "Debt is closed and collateral is still active in the lending pool.",
      cta: { type: "action", action: "withdrawCollateral", label: "Withdraw collateral to return" },
      description: "Withdraw active collateral first; after it is free in your Bank B wallet, burn it and run the reverse proof.",
      hint: `${formatAmount(state.withdrawable, "vA")} withdrawable.`,
      risk: "safe",
    };
  }

  if (lifecycle.activeCollateral) {
    if (state.availableBorrow > POSITION_EPSILON) {
      return {
        step: "borrow",
        title: "Borrow against collateral",
        status: "Borrow ready",
        summary: "Collateral is active and no debt is open.",
        cta: { type: "action", action: "borrow", label: "Borrow Cash" },
        description: "Borrow within the displayed policy and liquidity limit.",
        hint: `${formatAmount(state.availableBorrow, "bCASH")} available to borrow.`,
        risk: "safe",
      };
    }
    if (state.voucher > POSITION_EPSILON) {
      return {
        step: "activate",
        title: "Deposit remaining voucher",
        status: "Top-up ready",
        summary: "Free voucher collateral is available while collateral is already active.",
        cta: { type: "action", action: "depositCollateral", label: "Deposit more voucher collateral" },
        description: "Deposit the remaining free voucher before borrowing or returning collateral.",
        hint: `${formatAmount(state.voucher, "vA")} free voucher available.`,
        risk: "safe",
      };
    }
    return {
      step: "manage",
      title: "Active collateral is idle",
      status: "No debt",
      summary: "Collateral is active, but no borrowing power is currently available.",
      cta: { type: "refresh", label: "Refresh state" },
      description: "Refresh the dashboard before choosing a manual collateral action.",
      hint: `${formatAmount(state.withdrawable, "vA")} withdrawable if you want to use the separate withdraw button.`,
      risk: "safe",
      mode: "activeIdlePosition",
    };
  }

  return {
    step: "bridge",
    title: routeOpen ? "Transfer Collateral to Bank B" : "Establish Bank Route",
    status: routeOpen ? "Route ready" : "Route not open",
    summary: "No Bank B collateral is active yet.",
    cta: {
      type: "action",
      action: routeOpen ? "lock" : "openRoute",
      label: routeOpen ? "Transfer Collateral to Bank B" : "Establish Bank Route",
    },
    description: routeOpen ? "Choose an amount and lock aBANK into Bank A escrow." : "Open the permissioned route before locking collateral.",
    hint: `${formatAmount(state.bankA, "aBANK")} available on Bank A.`,
    risk: "safe",
  };
}

function workflowModel(status) {
  const recommendation = workflowRecommendation(status);
  return {
    ...recommendation,
    steps: workflowStepsForStatus(status),
  };
}

function hasForwardPacket(status) {
  const forward = status?.trace?.forward || {};
  return Boolean(forward.packetId || forward.commitHeight || forward.sourceTxHash);
}

function forwardPacketPending(status) {
  if (!hasForwardPacket(status)) return false;
  return !forwardReceiptConsumed(status);
}

function hasReversePacket(status) {
  const reverse = status?.trace?.reverse || {};
  const settlement = status?.risk?.settlement || {};
  return Boolean(reverse.packetId || reverse.commitHeight || reverse.sourceTxHash || settlement.packetId || settlement.burnTxHash);
}

function reversePacketPending(status) {
  const settlement = status?.risk?.settlement || {};
  if (!hasReversePacket(status)) return false;
  return !reverseConsumed(status) && !settlement.unlocked;
}

function closeoutWithdrawEligibility(status, baseEligibility) {
  const state = financialState(status);
  const lifecycle = lifecycleState(status);
  if (!state.deployed) return baseEligibility;
  if (state.debt > POSITION_EPSILON) return { ok: false, message: "Repay all debt first." };
  if (!lifecycle.activeCollateral) {
    return { ok: false, message: "There is no active collateral to withdraw for return." };
  }
  if (!baseEligibility.ok) return baseEligibility;
  return { ok: true, message: "Withdraw collateral to start or continue the return path." };
}

function actionEligibility(action, status = currentStatus, validationOptions = {}) {
  if (!action) return { ok: true, message: "" };
  const state = financialState(status);
  const locked = safetyLocked(status);
  const lifecycle = lifecycleState(status);
  const forward = status?.trace?.forward || {};
  const reverse = status?.trace?.reverse || {};
  const settlement = status?.risk?.settlement || {};
  const validation = AMOUNT_ACTIONS[action] ? validateAmountAction(action, status, validationOptions) : { ok: true, message: "" };
  const disabled = (message) => ({ ok: false, message });
  const enabled = (message = "") => ({ ok: true, message });

  if (!state.deployed && action !== "recoverClient") {
    return disabled("Run Prepare Demo Session before actions. Use Fresh Reset only if the deployment is stale or corrupted.");
  }
  if (locked && !SAFETY_MODE_ACTIONS.has(action)) {
    return disabled("Safety mode is active. Recover the light client before running interchain actions.");
  }

  if (action === "borrow") {
    if (state.collateral <= POSITION_EPSILON) return disabled("Deposit Collateral before borrowing.");
    if (state.availableBorrow <= POSITION_EPSILON) {
      return disabled(
        "Borrow is not ready because available borrow is 0. Possible reasons: stale oracle, missing price, collateral not reflected yet, or market state not refreshed."
      );
    }
    if (state.poolCash <= POSITION_EPSILON) return disabled("The lending pool has no cash available to lend.");
  }

  if (AMOUNT_ACTIONS[action] && !validation.ok) return validation;

  switch (action) {
    case "openRoute":
      return routeReady(status)
        ? disabled("The Bank A to Bank B route is already open; lock collateral when you are ready.")
        : enabled("Open the permissioned route before locking collateral.");
    case "lock":
      if (!routeReady(status)) return disabled("Open the Bank A to Bank B route before locking collateral.");
      if (forwardPacketPending(status)) return disabled("A forward packet is still pending. Receive the voucher before bridging more collateral.");
      if (state.bankA <= POSITION_EPSILON) return disabled("No Bank A aBANK balance is available to bridge.");
      return enabled("Lock source collateral and create a forward packet.");
    case "finalizeForwardHeader":
      if (!hasForwardPacket(status)) return disabled("Lock collateral first so there is a forward packet height to fetch.");
      if (!forwardPacketPending(status)) return disabled("The latest forward packet has already been received.");
      return heightAtLeast(forward.finalizedHeight, forward.commitHeight)
        ? disabled("The Bank A header is already fetched for the latest forward packet.")
        : enabled("Fetch the Bank A header for the pending forward packet.");
    case "updateForwardClient":
      if (!hasForwardPacket(status)) return disabled("Lock collateral first so Bank B has a packet height to trust.");
      if (!forwardPacketPending(status)) return disabled("The latest forward packet has already been verified.");
      if (heightAtLeast(status?.progress?.trustedAOnB, forward.commitHeight) || heightAtLeast(forward.trustedHeight, forward.commitHeight)) {
        return disabled("Bank B already trusts the needed Bank A height.");
      }
      return enabled("Import the Bank A header into Bank B's light client.");
    case "proveForwardMint":
      if (!hasForwardPacket(status)) return disabled("Lock collateral first to create a forward packet.");
      return forwardPacketPending(status)
        ? enabled("Verify the pending packet and mint voucher collateral once.")
        : disabled("No pending forward packet needs voucher verification.");
    case "depositCollateral":
      return state.voucher > POSITION_EPSILON
        ? enabled("Deposit free voucher collateral into the lending pool.")
        : disabled("Receive Verified Collateral first, or withdraw collateral back to your wallet before depositing.");
    case "borrow":
      return enabled("Borrow within the displayed available limit.");
    case "repay":
      if (state.debt <= POSITION_EPSILON) return disabled("There is no active debt to repay.");
      return validation.ok ? enabled("Repay part or all of the active debt.") : validation;
    case "topUpRepayCash": {
      const target = state.debt > 0 ? state.debt + repayCloseBuffer(state.debt) : 0;
      const shortfall = Math.max(0, target - state.bankB);
      if (state.debt <= POSITION_EPSILON) return disabled("Open debt first; no demo repayment cash is needed.");
      return shortfall > POSITION_EPSILON
        ? enabled("Mint demo bCASH to model the borrower reacquiring cash for repayment.")
        : disabled("The borrower already has enough bCASH for the repayment path.");
    }
    case "withdrawCollateral":
      if (state.collateral <= POSITION_EPSILON) return disabled("There is no deposited collateral to withdraw.");
      return state.withdrawable > POSITION_EPSILON ? enabled("Withdraw only collateral that keeps the position healthy.") : disabled("No safe withdrawal room is available.");
    case "burn": {
      if (state.debt > POSITION_EPSILON) return disabled("Repay all debt first.");
      if (reversePacketPending(status)) return disabled("A reverse packet is already pending. Verify the reverse proof next.");
      const fullReturnAmount = state.voucher + state.collateral;
      if (lifecycle.activeCollateral && state.voucher + POSITION_EPSILON < fullReturnAmount) {
        return disabled("Withdraw collateral from the lending pool first.");
      }
      if (state.voucher <= POSITION_EPSILON) return disabled("Withdraw or receive voucher collateral before burning it for return.");
      return enabled("Burn free voucher and start Bank A unlock.");
    }
    case "finalizeReverseHeader":
      if (!hasReversePacket(status)) return disabled("Burn voucher or settle seized voucher first so a reverse packet exists.");
      if (!reversePacketPending(status)) return disabled("The reverse packet has already been verified.");
      return heightAtLeast(reverse.finalizedHeight, reverse.commitHeight)
        ? disabled("The Bank B header is already fetched for the reverse packet.")
        : enabled("Fetch the Bank B header for the reverse proof.");
    case "updateReverseClient":
      if (!hasReversePacket(status)) return disabled("Burn voucher or settle seized voucher first so Bank A has a packet height to trust.");
      if (!reversePacketPending(status)) return disabled("The reverse packet has already been verified.");
      if (heightAtLeast(status?.progress?.trustedBOnA, reverse.commitHeight) || heightAtLeast(reverse.trustedHeight, reverse.commitHeight)) {
        return disabled("Bank A already trusts the needed Bank B height.");
      }
      return enabled("Import the Bank B header into Bank A's light client.");
    case "proveReverseUnlock":
      if (!hasReversePacket(status)) return disabled("Burn voucher or settle seized voucher first so a reverse packet exists.");
      return reversePacketPending(status)
        ? enabled("Verify the reverse proof and unlock origin collateral.")
        : disabled("No pending reverse packet needs unlock verification.");
    case "settleSeizedVoucher":
      if (numeric(settlement.seizedVoucherBalance || status?.balances?.liquidatorVoucher) <= POSITION_EPSILON) {
        return disabled("Run liquidation first so the authorized liquidator receives voucher collateral.");
      }
      return settlement.started ? disabled("Settlement packet already exists. Complete the reverse proof.") : enabled("Settle seized voucher through the reverse route.");
    case "simulatePriceShock":
      return enabled("Update the governed demo oracle price.");
    case "executeLiquidation":
      return validation.ok ? enabled("Execute authorized liquidation at the current oracle price.") : validation;
    case "replayForward":
      if (!status?.security?.receiptReplayGuardLive && !status?.security?.forwardConsumed) {
        return disabled("Receive the forward packet first so a packet receipt exists to test.");
      }
      return status?.security?.explicitReplayAttackRejected
        ? disabled("The explicit replay attack has already been rejected.")
        : enabled("Attempt a duplicate packet proof and show the contract rejecting it.");
    case "executeTimeoutRefund":
      return enabled("Run the timeout absence proof path for the denied packet.");
    case "freezeClient":
      return status?.security?.frozen ? disabled("The light client is already frozen.") : enabled("Submit conflicting evidence to demonstrate safety controls.");
    case "recoverClient":
      return status?.security?.frozen || status?.security?.recovering
        ? enabled("Recover the light client from the controlled safety mode.")
        : disabled("The light client is active; there is no frozen client to recover.");
    case "fullFlow":
    case "riskLifecycle":
    case "borrowerCloseout":
      return enabled("Run the scripted appendix flow using the current deployed runtime.");
    default:
      return enabled();
  }
}

function postActionReadinessNote(action, status = currentStatus) {
  if (action !== "depositCollateral") return "";
  const state = financialState(status);
  if (state.collateral <= POSITION_EPSILON) return "";
  const borrowEligibility = actionEligibility("borrow", status, {
    amountOverride: defaultAmountForAction("borrow", status),
  });
  return borrowEligibility.ok ? "" : borrowEligibility.message;
}

function actionCompletionSnapshot(action, status = currentStatus) {
  const state = financialState(status);
  return {
    action,
    bankA: state.bankA,
    escrow: state.escrow,
    voucher: state.voucher,
    collateral: state.collateral,
    debt: state.debt,
    bankB: state.bankB,
    forwardConsumed: forwardConsumed(status),
    reverseConsumed: reverseConsumed(status),
    forwardTrusted: numeric(status?.progress?.trustedAOnB || status?.trace?.forward?.trustedHeight),
    reverseTrusted: numeric(status?.progress?.trustedBOnA || status?.trace?.reverse?.trustedHeight),
  };
}

function movedUp(afterValue, beforeValue) {
  return numeric(afterValue) > numeric(beforeValue) + POSITION_EPSILON;
}

function movedDown(afterValue, beforeValue) {
  return numeric(afterValue) < numeric(beforeValue) - POSITION_EPSILON;
}

function freshSeededBaseline(status = currentStatus) {
  const state = financialState(status);
  return Boolean(
    status?.deployed &&
      state.bankA > POSITION_EPSILON &&
      state.poolCash > POSITION_EPSILON &&
      state.escrow <= POSITION_EPSILON &&
      state.voucher <= POSITION_EPSILON &&
      state.collateral <= POSITION_EPSILON &&
      state.debt <= POSITION_EPSILON &&
      !hasForwardPacket(status) &&
      !hasReversePacket(status)
  );
}

function actionReachedExpectedState(action, status = currentStatus, before = null) {
  const state = financialState(status);
  const lifecycle = lifecycleState(status);
  const forward = status?.trace?.forward || {};
  const reverse = status?.trace?.reverse || {};
  const traceRisk = status?.trace?.risk || {};
  const settlement = status?.risk?.settlement || {};
  switch (action) {
    case "deploySeed":
      return Boolean(status?.deployed && numeric(status?.balances?.bankA) > POSITION_EPSILON && numeric(status?.balances?.poolCash) > POSITION_EPSILON);
    case "resetSeeded":
      return freshSeededBaseline(status);
    case "openRoute":
      return routeReady(status);
    case "lock":
      if (before) return hasForwardPacket(status) && (movedUp(state.escrow, before.escrow) || movedDown(state.bankA, before.bankA));
      return hasForwardPacket(status);
    case "finalizeForwardHeader":
      return hasForwardPacket(status) && heightAtLeast(forward.finalizedHeight, forward.commitHeight);
    case "updateForwardClient":
      return hasForwardPacket(status) && (heightAtLeast(status?.progress?.trustedAOnB, forward.commitHeight) || heightAtLeast(forward.trustedHeight, forward.commitHeight));
    case "proveForwardMint":
      if (before) return forwardConsumed(status) || movedUp(state.voucher, before.voucher) || movedUp(state.collateral, before.collateral);
      return Boolean(status?.security?.forwardConsumed || state.voucher > POSITION_EPSILON || state.collateral > POSITION_EPSILON);
    case "depositCollateral":
      if (before) return movedUp(state.collateral, before.collateral) || movedDown(state.voucher, before.voucher);
      return state.collateral > POSITION_EPSILON;
    case "borrow":
      if (before) return movedUp(state.debt, before.debt) || movedUp(state.bankB, before.bankB);
      return state.debt > POSITION_EPSILON;
    case "topUpRepayCash":
      if (before) return movedUp(state.bankB, before.bankB) || state.bankB >= state.debt;
      return state.debt > POSITION_EPSILON && state.bankB >= state.debt;
    case "repay":
      if (before) return movedDown(state.debt, before.debt) || (before.debt > POSITION_EPSILON && state.debt <= POSITION_EPSILON);
      return state.debt <= POSITION_EPSILON || Boolean(traceRisk.repayTxHash || traceRisk.repaid);
    case "withdrawCollateral":
      if (traceRisk.withdrawTxHash || traceRisk.collateralWithdrawn || lifecycle.borrowerCollateralWithdrawn) return true;
      if (before) return movedDown(state.collateral, before.collateral) || movedUp(state.voucher, before.voucher);
      return Boolean(traceRisk.withdrawTxHash || traceRisk.collateralWithdrawn || lifecycle.borrowerCollateralWithdrawn);
    case "burn":
      if (before) return hasReversePacket(status) && movedDown(state.voucher, before.voucher);
      return hasReversePacket(status);
    case "finalizeReverseHeader":
      return hasReversePacket(status) && heightAtLeast(reverse.finalizedHeight, reverse.commitHeight);
    case "updateReverseClient":
      return hasReversePacket(status) && (heightAtLeast(status?.progress?.trustedBOnA, reverse.commitHeight) || heightAtLeast(reverse.trustedHeight, reverse.commitHeight));
    case "proveReverseUnlock":
      if (before) return reverseConsumed(status) && !before.reverseConsumed;
      return reverseConsumed(status);
    case "simulatePriceShock":
      return Boolean(traceRisk.priceShockTxHash || traceRisk.shockedVoucherPriceE18);
    case "executeLiquidation":
      return Boolean(status?.risk?.afterLiquidation?.executed || traceRisk.liquidationTxHash);
    case "settleSeizedVoucher":
      return Boolean(settlement.started || settlement.packetId || hasReversePacket(status));
    case "borrowerCloseout":
      return Boolean(status?.trace?.scenario?.mode === "borrower-closeout" && status?.trace?.scenario?.completed);
    default:
      return false;
  }
}

function syncWorkflowUi(status = currentStatus) {
  const model = workflowModel(status);
  const selectedStep = selectedWorkflowStep && model.steps[selectedWorkflowStep] ? selectedWorkflowStep : model.step;
  const reviewingPastStep = selectedStep !== model.step;
  const recommendedAction = model.cta?.type === "action" ? model.cta.action : null;
  currentWorkflowAction = reviewingPastStep
    ? { type: "return", label: "Return to recommendation" }
    : model.cta;

  document.body.dataset.workflowStep = selectedStep;
  document.body.dataset.workflowRisk = model.risk;
  document.body.dataset.workflowAction = recommendedAction || model.cta?.type || "none";
  setText("workflowPanelTitle", reviewingPastStep ? "Review journey area" : model.title);
  setText("workflowPanelStatus", reviewingPastStep ? "Review" : model.status);
  setText("primaryActionState", reviewingPastStep ? `Viewing: ${WORKFLOW_STEP_TITLES[selectedStep] || selectedStep}` : `State: ${model.status}`);
  setText("primaryActionIntent", reviewingPastStep ? "Action: return to current recommendation" : ctaIntent(model.cta));
  if (currentRunningAction) {
    renderPrimaryGuide(currentRunningAction);
  } else {
    setPrimaryLinkyVariant(
      getLinkyVariant({
        risk: model.risk === "risk",
        success: model.status === "Complete" || model.status === "Settled",
        welcome: model.step === "connect",
      })
    );
    setPrimaryGuideVisible(false);
    setText("primaryActionTitle", reviewingPastStep ? "Continue workflow" : model.title);
    setText("primaryActionDescription", reviewingPastStep ? "The journey map is for orientation. Use any enabled action button when prerequisites are met." : model.description);
    setText("primaryActionHint", reviewingPastStep ? "Return to Linky's recommendation or keep inspecting the dashboard controls." : model.hint);
  }
  if (primaryWorkflowCta && !currentRunningAction) {
    const primaryValidation =
      currentWorkflowAction?.type === "action"
        ? workflowCtaEligibility(currentWorkflowAction, status, { recommended: true })
        : { ok: true, message: "" };
    primaryWorkflowCta.textContent = ctaLabel(currentWorkflowAction);
    bindPrimaryWorkflowCta(currentWorkflowAction);
    primaryWorkflowCta.disabled = document.body.classList.contains("is-busy") || !primaryValidation.ok;
    primaryWorkflowCta.title = primaryValidation.ok ? "" : primaryValidation.message;
    primaryWorkflowCta.dataset.state = primaryValidation.ok ? "ready" : "blocked";
    primaryWorkflowCta.classList.toggle("button-danger", model.risk === "risk" && !reviewingPastStep);
    primaryWorkflowCta.classList.toggle("button-primary", model.risk !== "risk" || reviewingPastStep);
  }

  for (const button of workflowStepButtons) {
    const step = button.dataset.workflowStep;
    const stepState = model.steps[step] || {};
    const current = step === selectedStep;
    button.classList.toggle("is-current", current);
    button.classList.toggle("is-complete", Boolean(stepState.complete));
    button.classList.toggle("is-locked", !stepState.unlocked);
    button.disabled = false;
    button.title = stepState.unlocked
      ? "Review this part of the borrower journey."
      : "This part is not ready yet, but you can still inspect its controls and prerequisites.";
    button.setAttribute("aria-current", current ? "step" : "false");
  }

  setWorkflowStepStatus("workflowStepConnect", model.steps.connect.complete ? "done" : "active", model.steps.connect.label);
  setWorkflowStepStatus(
    "visualEscrowState",
    model.steps.bridge.complete ? "done" : model.step === "bridge" ? "active" : model.steps.bridge.unlocked ? "" : "locked",
    model.steps.bridge.label
  );
  setWorkflowStepStatus(
    "workflowStepActivate",
    model.steps.activate.complete ? "done" : model.step === "activate" ? "active" : model.steps.activate.unlocked ? "" : "locked",
    model.steps.activate.label
  );
  setWorkflowStepStatus(
    "visualCreditState",
    model.steps.borrow.complete ? "done" : model.step === "borrow" ? "active" : model.steps.borrow.unlocked ? "" : "locked",
    model.steps.borrow.label
  );
  setWorkflowStepStatus(
    "workflowStepManage",
    model.step === "manage" ? "active" : model.steps.manage.unlocked ? "" : "locked",
    model.steps.manage.label
  );
  setWorkflowStepStatus(
    "workflowStepReturn",
    model.steps.return.complete ? "done" : model.step === "return" ? "active" : model.steps.return.unlocked ? "" : "locked",
    model.steps.return.label
  );

  workflowPanels.forEach((panel) => {
    const panels = String(panel.dataset.workflowPanel || "").split(/\s+/);
    const active = panels.includes(selectedStep);
    const connectOnly = panels.includes("connect");
    const showPanel = connectOnly ? !model.steps.connect.complete || active : true;
    panel.classList.toggle("is-active", active);
    panel.hidden = !showPanel;
  });

  const busy = document.body.classList.contains("is-busy");
  for (const button of actionButtons) {
    const action = button.dataset.action;
    let eligibility = actionEligibility(action, status);
    if (button.dataset.closeoutWithdraw === "true") {
      eligibility = closeoutWithdrawEligibility(status, eligibility);
    }
    button.classList.toggle("is-current-action", action === recommendedAction && !reviewingPastStep);
    if (button.hidden && button.id !== "topUpRepayCashButton") button.hidden = false;
    button.disabled = busy || !eligibility.ok;
    button.dataset.actionState = busy ? "busy" : eligibility.ok ? "ready" : "blocked";
    button.setAttribute("aria-disabled", button.disabled ? "true" : "false");
    button.title = busy
      ? "Another transaction/proof action is running. Read-only panels remain available."
      : eligibility.ok
        ? eligibility.message || button.dataset.originalTitle || ""
        : eligibility.message;
  }

  if (topUpRepayCashButton) {
    const topUpEligibility = actionEligibility("topUpRepayCash", status);
    const topUpRecommended = recommendedAction === "topUpRepayCash" && !reviewingPastStep;
    topUpRepayCashButton.classList.toggle("is-current-action", topUpRecommended);
    topUpRepayCashButton.dataset.actionState = busy ? "busy" : topUpEligibility.ok ? "ready" : "blocked";
    topUpRepayCashButton.setAttribute("aria-disabled", topUpRepayCashButton.disabled ? "true" : "false");
    if (!busy && topUpRecommended) {
      topUpRepayCashButton.title = topUpEligibility.ok
        ? topUpEligibility.message || topUpRepayCashButton.dataset.originalTitle || ""
        : topUpEligibility.message;
    }
  }

  deploySeedButton?.toggleAttribute("hidden", false);
  if (!reviewingPastStep && model.cta?.action && LOAN_TAB_BY_ACTION[model.cta.action]) {
    setLoanTab(LOAN_TAB_BY_ACTION[model.cta.action]);
  } else if (model.step === "manage" && currentLoanTab === "borrow") {
    setLoanTab("repay");
  }
  setActiveActionCard(
    selectedStep === "activate"
      ? "activate"
      : selectedStep === "manage" || selectedStep === "borrow"
        ? "loan"
        : selectedStep === "return"
          ? "redeem"
          : selectedStep
  );
}

function setRiskBadge(id, health) {
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = health.status;
  node.classList.toggle("is-safe", health.status === "Safe");
  node.classList.toggle("is-watch", health.status === "Watch");
  node.classList.toggle("is-risk", health.status === "Danger" || health.status === "Liquidatable");
}

function textIncludes(value, ...needles) {
  const text = String(value || "").toLowerCase();
  return needles.some((needle) => text.includes(needle));
}

function proofDoneSteps(status) {
  const proof = status?.proofInspector || {};
  const trace = status?.trace || {};
  const forward = trace.forward || {};
  const reverse = trace.reverse || {};
  const progress = status?.progress || {};
  const security = status?.security || {};
  const steps = new Set();

  if (forward.commitHeight || forward.packetId || reverse.commitHeight || reverse.packetId || numeric(progress.packetSequenceA) > 0) {
    steps.add("packet-committed");
  }
  if (
    heightAtLeast(forward.finalizedHeight, forward.commitHeight) ||
    heightAtLeast(reverse.finalizedHeight, reverse.commitHeight) ||
    proof.headerHash ||
    proof.stateRoot
  ) {
    steps.add("header-fetched");
  }
  if (numeric(progress.trustedAOnB) > 0 || numeric(progress.trustedBOnA) > 0 || proof.trustedHeight) {
    steps.add("light-client-updated");
  }
  if (proof.storageSlot || proof.proofKey || proof.timeoutStorageKey || forward.proofMode || reverse.proofMode) {
    steps.add("storage-proof");
  }
  if (
    forwardConsumed(status) ||
    reverseConsumed(status) ||
    textIncludes(proof.proofVerificationResult, "verified", "executed", "accepted")
  ) {
    steps.add("packet-verified");
  }
  if (
    security.receiptReplayGuardLive ||
    security.forwardConsumed ||
    security.reverseConsumed ||
    textIncludes(proof.receiptStatus, "consumed", "received", "executed")
  ) {
    steps.add("receipt-consumed");
  }
  if (security.explicitReplayAttackRejected || textIncludes(proof.explicitReplayStatus, "reject")) {
    steps.add("replay-rejected");
  }
  if (
    security.timeoutAbsence ||
    security.deniedTimedOut ||
    proof.timeoutRefundObserved ||
    textIncludes(proof.timeoutStatus, "refund", "timed out", "verified")
  ) {
    steps.add("timeout-refund");
  }
  if (security.frozen || security.recovering || trace.misbehaviour?.frozen || trace.misbehaviour?.recovered || proof.recoveryStatus) {
    steps.add("client-safety");
  }
  return steps;
}

function activeProofStepForAction(action, stage = "") {
  const lowerStage = String(stage || "").toLowerCase();
  if (action === "proveForwardMint" || action === "proveReverseUnlock") {
    if (lowerStage.includes("header") || lowerStage.includes("trusted")) return "light-client-updated";
    if (lowerStage.includes("storage") || lowerStage.includes("proof")) return "storage-proof";
    if (lowerStage.includes("confirmation") || lowerStage.includes("transaction") || lowerStage.includes("refresh")) {
      return "packet-verified";
    }
  }
  if (action === "fullFlow" || action === "borrowerCloseout") {
    if (lowerStage.includes("proof")) return "storage-proof";
    if (lowerStage.includes("refresh")) return "packet-verified";
  }
  return PROOF_STEP_BY_ACTION[action] || null;
}

function updateProofLifecycle(status = currentStatus, actionState = currentRunningAction) {
  const doneSteps = proofDoneSteps(status);
  const stage = actionState?.controller?.stage || fallbackStage(actionState?.action, 0);
  const activeStep = actionState?.phase === "running" ? activeProofStepForAction(actionState.action, stage) : null;
  const completedStep = actionState?.phase === "success" ? PROOF_STEP_BY_ACTION[actionState.action] : null;
  const nodesByStep = new Map([...document.querySelectorAll("[data-proof-step]")].map((node) => [node.dataset.proofStep, node]));

  for (const step of PROOF_STEP_ORDER) {
    const node = nodesByStep.get(step);
    if (!node) continue;
    const done = doneSteps.has(step) || step === completedStep;
    node.classList.toggle("is-done", done);
    node.classList.toggle("is-active", step === activeStep);
    node.classList.toggle("is-pending", !done && step !== activeStep);
    if (step === completedStep) {
      node.classList.add("is-success-flash");
      window.setTimeout(() => node.classList.remove("is-success-flash"), 1800);
    }
  }

  const thesisMeaning =
    actionState?.action && THESIS_MEANING[actionState.action]
      ? THESIS_MEANING[actionState.action]
      : DEFAULT_THESIS_MEANING;
  setText("proofThesisMeaning", thesisMeaning);
}

function setValidation(id, message = "", severity = "") {
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = message;
  node.classList.toggle("is-warning", severity === "warning");
  node.classList.toggle("is-error", severity === "error");
}

function setScenarioAmountSummary(id, message, severity = "") {
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = message;
  node.classList.toggle("is-error", severity === "error");
  node.classList.toggle("is-warning", severity === "warning");
}

function setScenarioCardValidation(button, message) {
  const card = scenarioCardForButton(button);
  if (!card) return;
  setScenarioCardState(card, "failed", "Needs Input");
  const summary = card.querySelector(".scenario-amount-summary");
  if (summary) {
    summary.textContent = message;
    summary.classList.add("is-error");
    summary.classList.remove("is-warning");
  }
}

function metricShell(node) {
  return node?.closest("article, .metric-grid div, .shock-grid div, .scenario-card, .activity-timeline article") || node;
}

function clearActionHighlights() {
  for (const node of highlightedNodes) {
    node.classList.remove("is-action-focus", "is-success-flash");
  }
  highlightedNodes = [];
}

function highlightNodeIds(ids = [], mode = "running") {
  clearActionHighlights();
  const nodes = ids
    .map((id) => document.getElementById(id))
    .filter(Boolean)
    .flatMap((node) => [node, metricShell(node)].filter(Boolean));
  highlightedNodes = [...new Set(nodes)];
  for (const node of highlightedNodes) {
    node.classList.add(mode === "success" ? "is-success-flash" : "is-action-focus");
  }
  if (mode === "success") {
    window.setTimeout(() => {
      for (const node of highlightedNodes) node.classList.remove("is-success-flash");
    }, 1800);
  }
}

function scenarioCardForButton(button) {
  return button?.closest(".scenario-card") || null;
}

function scenarioCardForAction(action) {
  const status = document.getElementById(SCENARIO_STATUS_BY_ACTION[action]);
  return status?.closest(".scenario-card") || null;
}

function setScenarioCardState(card, state, label) {
  if (!card) return;
  card.classList.remove("is-running", "is-success", "is-failed");
  if (state) card.classList.add(`is-${state}`);
  const chip = card.querySelector(".status-chip");
  if (chip) {
    chip.textContent = label || (state === "running" ? "Running" : state === "success" ? "Success" : state === "failed" ? "Failed" : "Waiting");
    chip.classList.remove("is-safe", "is-watch", "is-risk", "is-pending", "is-verified", "is-frozen");
    chip.classList.add(state === "failed" ? "is-risk" : state === "success" ? "is-verified" : "is-pending");
  }
}

function validateAmountAction(action, status = currentStatus, { amountOverride = null } = {}) {
  const state = financialState(status);
  const risk = status?.risk || {};
  const inputId = AMOUNT_ACTIONS[action]?.inputId;
  const amount = amountOverride == null ? (inputId ? inputValue(inputId) : 0) : numeric(amountOverride);
  if (!AMOUNT_ACTIONS[action]) return { ok: true, amount };
  if (!state.deployed) return { ok: false, amount, message: "Prepare the demo account before submitting." };
  if (action === "depositCollateral" && state.voucher <= 0) {
    return { ok: false, amount, message: "There is no free voucher collateral to deposit." };
  }
  if (amount <= 0) return { ok: false, amount, message: "Enter an amount greater than zero." };

  if (action === "simulatePriceShock") {
    const currentPrice = numeric(risk.oracle?.collateralPrice);
    if (currentPrice > 0 && amount >= currentPrice) {
      return { ok: true, amount, message: "This is an oracle update, not a downside shock.", severity: "warning" };
    }
    return { ok: true, amount, message: "Oracle shock is ready." };
  }

  if (action === "executeLiquidation") {
    const maxRepay = numeric(risk.liquidationPreview?.repayAmount);
    if (!risk.position?.liquidatable) return { ok: false, amount, message: "The account is not liquidatable at the current oracle price." };
    if (maxRepay <= 0) return { ok: false, amount, message: "No debt is available for liquidation." };
    if (amount > maxRepay) return { ok: false, amount, message: "Amount exceeds the liquidation close factor." };
    return { ok: true, amount, message: "Liquidation is ready." };
  }

  if (action === "lock") {
    if (amount > state.bankA) return { ok: false, amount, message: "Amount exceeds your source-bank balance." };
    return { ok: true, amount, message: "Ready to bridge collateral." };
  }

  if (action === "depositCollateral") {
    if (state.voucher <= 0) return { ok: false, amount, message: "There is no free voucher collateral to deposit." };
    if (amount > state.voucher) return { ok: false, amount, message: "Amount exceeds your free voucher balance." };
    return { ok: true, amount, message: "Deposit amount is available in your Bank B wallet." };
  }

  if (action === "borrow") {
    if (state.collateral <= 0) return { ok: false, amount, message: "Activate collateral before borrowing." };
    if (amount > state.availableBorrow) return { ok: false, amount, message: "Amount exceeds available borrowing power." };
    if (amount > state.poolCash) return { ok: false, amount, message: "Amount exceeds available market liquidity." };
    const projected = projectedHealth(state.liquidationThresholdValue, state.debt + amount);
    if (projected.status === "Danger") {
      return { ok: true, amount, message: "Borrow is allowed, but health factor will be close to liquidation.", severity: "warning" };
    }
    return { ok: true, amount, message: "Borrow amount is within current risk limits." };
  }

  if (action === "repay") {
    if (state.debt <= 0) return { ok: false, amount, message: "There is no outstanding debt to repay." };
    if (amount <= 0) return { ok: false, amount, message: "Enter an amount greater than zero." };
    if (amount > state.debt) return { ok: false, amount, message: "Amount is greater than outstanding debt." };
    const closeBuffer = repayCloseBuffer(state.debt);
    const closeDebt = state.debt - amount <= closeBuffer;
    const requiredBalance = closeDebt ? state.debt : amount;
    if (requiredBalance > state.bankB) {
      const shortfall = Math.max(0, requiredBalance - state.bankB);
      return {
        ok: false,
        amount,
        message: `You need ${formatAmount(shortfall, "bCASH")} more to repay this amount.`,
      };
    }
    return { ok: true, amount, message: "Repayment is ready." };
  }

  if (action === "withdrawCollateral") {
    if (state.collateral <= 0) return { ok: false, amount, message: "There is no deposited collateral to withdraw." };
    if (amount > state.collateral) return { ok: false, amount, message: "Amount exceeds deposited collateral." };
    if (amount > state.withdrawable) return { ok: false, amount, message: "Withdrawal would make the position unhealthy." };
    const remainingCollateral = Math.max(0, state.collateral - amount);
    const projectedThreshold =
      state.collateral > 0 ? (state.liquidationThresholdValue * remainingCollateral) / state.collateral : 0;
    const projected = projectedHealth(projectedThreshold, state.debt);
    if (projected.status === "Danger") {
      return { ok: true, amount, message: "Withdrawal is allowed, but health factor will be close to liquidation.", severity: "warning" };
    }
    return { ok: true, amount, message: "Withdrawal keeps your account within current limits." };
  }

  return { ok: true, amount };
}

function defaultAmountForAction(action, status = currentStatus) {
  const state = financialState(status);
  if (action === "lock") return Math.min(state.bankA, inputValue("bridgeAmount") || state.bankA);
  if (action === "depositCollateral") return state.voucher;
  if (action === "borrow") return state.availableBorrow;
  if (action === "repay") return Math.min(state.debt, state.bankB);
  if (action === "withdrawCollateral") return state.withdrawable;
  return 0;
}

function primeRecommendedAmount(action, status = currentStatus, { force = false } = {}) {
  const config = AMOUNT_ACTIONS[action];
  if (!config) return;
  const input = document.getElementById(config.inputId);
  if (!input || (!force && numeric(input.value) > POSITION_EPSILON)) return;
  const fallback = defaultAmountForAction(action, status);
  if (fallback > POSITION_EPSILON) {
    setInputValue(config.inputId, fallback, { force: true });
  }
}

function updateAmountActionAvailability(status) {
  const locked = safetyLocked(status);
  const busy = document.body.classList.contains("is-busy");
  for (const button of actionButtons) {
    const action = button.dataset.action;
    if (!AMOUNT_ACTIONS[action]) continue;
    const safetyAllowed = !locked || SAFETY_MODE_ACTIONS.has(action);
    const validation = validateAmountAction(action, status);
    button.disabled = busy || !safetyAllowed || !validation.ok;
    button.title = busy
      ? "Another transaction/proof action is running. Read-only panels remain available."
      : safetyAllowed
      ? validation.ok
        ? ""
        : validation.message
      : "Safety mode is active. Recover the light client before running interchain actions.";
  }
  const settlement = status?.risk?.settlement || {};
  const settlementVoucher = numeric(settlement.seizedVoucherBalance);
  for (const button of actionButtons.filter((node) => node.dataset.action === "settleSeizedVoucher")) {
    const allowed = !locked && settlementVoucher > 0 && !settlement.started;
    button.disabled = busy || !allowed;
    button.title = busy
      ? "Another transaction/proof action is running. Read-only panels remain available."
      : locked
      ? "Safety mode is active. Recover the light client before settling seized collateral."
      : settlement.started
        ? "Settlement packet already exists. Complete the settlement proof."
        : settlementVoucher > 0
          ? ""
          : "Run liquidation first so the authorized liquidator receives voucher collateral.";
  }
}

function refreshTransactionUi(status, { forceDefaults = false } = {}) {
  const state = financialState(status);
  const risk = status?.risk || {};
  const suggestedBridge = status?.trace?.forward?.amount || status?.amount || Math.min(state.bankA, 100);
  setInputValue("bridgeAmount", suggestedBridge, { force: forceDefaults });
  setInputValue("depositAmount", state.voucher, { force: forceDefaults });
  setInputValue("borrowAmount", state.availableBorrow, { force: forceDefaults });
  setInputValue("repayAmount", state.debt, { force: forceDefaults });
  setInputValue("withdrawAmount", state.withdrawable, { force: forceDefaults });
  setInputValue("shockPrice", risk.shockPreview?.collateralPrice ?? 0.5, { force: forceDefaults });
  setInputValue("liquidationRepayAmount", risk.liquidationPreview?.repayAmount ?? 0, { force: forceDefaults });

  setText("bridgeSourceBalance", status?.deployed ? formatAmount(state.bankA, "aBANK") : "-");
  setText("borrowMaxInline", status?.deployed ? formatAmount(state.availableBorrow, "bCASH") : "-");
  setText("repayDebtInline", status?.deployed ? formatAmount(state.debt, "bCASH") : "-");
  setText("withdrawableInline", status?.deployed ? formatAmount(state.withdrawable, "vA") : "-");
  setText(
    "depositCollateralHint",
    state.voucher > 0
      ? `${formatAmount(state.voucher, "vA")} free voucher available to deposit.`
      : state.collateral > 0
        ? `${formatAmount(state.collateral, "vA")} active as collateral.`
        : "Waiting for transferred collateral."
  );

  const bridgeAmount = inputValue("bridgeAmount");
  setText("bridgePreviewAmount", formatAmount(bridgeAmount, "aBANK"));
  setText("bridgePreviewVoucher", formatAmount(state.voucher + bridgeAmount, "vA"));
  setText(
    "bridgePreviewNote",
    bridgeAmount > 0
      ? "After verification, this collateral can be activated for borrowing."
      : "Verification makes transferred collateral usable for borrowing."
  );

  const depositAmount = inputValue("depositAmount");
  const projectedDepositCollateral = state.collateral + depositAmount;
  const projectedDepositMaxBorrow = projectedMaxBorrowForCollateral(status, projectedDepositCollateral);
  const projectedDepositAvailable = Math.min(Math.max(0, projectedDepositMaxBorrow - state.debt), state.poolCash);
  setText("depositDecisionAmount", formatAmount(depositAmount, "vA"));
  setText("depositProjectedCollateral", formatAmount(projectedDepositCollateral, "vA"));
  setText("depositProjectedAvailable", formatAmount(projectedDepositAvailable, "bCASH"));

  const borrowAmount = inputValue("borrowAmount");
  const projectedBorrowDebt = state.debt + borrowAmount;
  const borrowHealth =
    borrowAmount > 0 ? projectedHealth(state.liquidationThresholdValue, projectedBorrowDebt) : { label: "-", status: "Waiting" };
  setText("borrowDecisionAmount", formatAmount(borrowAmount, "bCASH"));
  setText("borrowProjectedDebt", formatAmount(projectedBorrowDebt, "bCASH"));
  setText("borrowProjectedAvailable", formatAmount(Math.max(0, state.maxBorrow - projectedBorrowDebt), "bCASH"));
  setText("borrowProjectedHealth", borrowHealth.label);
  setRiskBadge("borrowRiskBadge", borrowHealth);

  const repayAmount = inputValue("repayAmount");
  const projectedRepayDebt = Math.max(0, state.debt - repayAmount);
  const repayHealth =
    repayAmount > 0 ? projectedHealth(state.liquidationThresholdValue, projectedRepayDebt) : { label: "-", status: "Waiting" };
  const repayableNow = Math.min(state.debt, state.bankB);
  const repayFundingTarget = state.debt > 0 ? state.debt + repayCloseBuffer(state.debt) : 0;
  const repayShortfall = Math.max(0, repayFundingTarget - state.bankB);
  const needsDemoCash = state.deployed && state.debt > 0 && repayShortfall > 0.000001;
  setText("repayDemoCashBalance", status?.deployed ? formatAmount(state.bankB, "bCASH") : "-");
  setText("repayableNow", status?.deployed ? formatAmount(repayableNow, "bCASH") : "-");
  setText("repayShortfall", status?.deployed ? formatAmount(repayShortfall, "bCASH") : "-");
  setText(
    "repayFundingCopy",
    !status?.deployed
      ? "Prepare the demo account before managing repayment."
      : state.debt <= 0
        ? "No active debt is open, so repayment is not needed."
        : needsDemoCash
          ? `Demo account is short by ${formatAmount(repayShortfall, "bCASH")}. Add demo bCASH plus a small interest buffer to close the debt cleanly.`
          : "The demo account has enough bCASH plus a small interest buffer for the selected repayment flow."
  );
  if (topUpRepayCashButton) {
    topUpRepayCashButton.hidden = !needsDemoCash;
    topUpRepayCashButton.disabled = document.body.classList.contains("is-busy");
    topUpRepayCashButton.title = needsDemoCash
      ? `Adds ${formatAmount(repayShortfall, "bCASH")} for demo repayment, including a close-debt buffer.`
      : "";
  }
  setText("repayDecisionAmount", formatAmount(repayAmount, "bCASH"));
  setText("repayProjectedDebt", formatAmount(projectedRepayDebt, "bCASH"));
  setText("repayProjectedHealth", repayHealth.label);

  const withdrawAmount = inputValue("withdrawAmount");
  const remainingCollateral = Math.max(0, state.collateral - withdrawAmount);
  const projectedWithdrawMax = state.collateral > 0 ? (state.maxBorrow * remainingCollateral) / state.collateral : 0;
  const projectedWithdrawThreshold =
    state.collateral > 0 ? (state.liquidationThresholdValue * remainingCollateral) / state.collateral : 0;
  const withdrawHealth =
    withdrawAmount > 0 ? projectedHealth(projectedWithdrawThreshold, state.debt) : { label: "-", status: "Waiting" };
  setText("withdrawDecisionAmount", formatAmount(withdrawAmount, "vA"));
  setText("withdrawProjectedCollateral", formatAmount(remainingCollateral, "vA"));
  setText("withdrawProjectedHealth", withdrawHealth.label);
  setRiskBadge("withdrawRiskBadge", withdrawHealth);

  const shockPrice = inputValue("shockPrice");
  const currentCollateralPrice = numeric(risk.oracle?.collateralPrice);
  const currentHealth = healthFromStatus(status);
  const shockedHealth = status?.deployed ? healthForShockPrice(status, shockPrice) : { label: "-", status: "Waiting" };
  setText("riskCurrentPriceInline", status?.deployed ? formatAmount(currentCollateralPrice, "bCASH/vA") : "-");
  setText("riskHealthBeforeShock", currentHealth.label);
  setText("riskHealthAfterShock", shockedHealth.label);
  setRiskBadge("riskShockBadge", shockedHealth);

  const liquidationAmount = inputValue("liquidationRepayAmount");
  setText("liquidationMaxRepayInline", status?.deployed ? formatAmount(risk.liquidationPreview?.repayAmount, "bCASH") : "-");
  const liquidationExecuted = Boolean(risk.afterLiquidation?.executed);
  const settlement = risk.settlement || {};
  const settlementStarted = Boolean(settlement.started);
  const liquidatableAfterSelectedShock = shockedHealth.percent != null && shockedHealth.percent < 100;
  setText(
    "scenarioHealthyBefore",
    status?.deployed
      ? `${formatAmount(state.collateral, "vA")} collateral / ${formatAmount(state.availableBorrow, "bCASH")} available`
      : "Needs demo account"
  );
  setText("scenarioHealthyAction", `Borrow ${formatAmount(borrowAmount, "bCASH")}`);
  setText("scenarioHealthyAfter", `Debt ${formatAmount(projectedBorrowDebt, "bCASH")} / health ${borrowHealth.label}`);
  setText(
    "scenarioRepayBefore",
    status?.deployed
      ? `${formatAmount(state.debt, "bCASH")} debt / ${formatAmount(state.collateral, "vA")} collateral`
      : "Needs demo account"
  );
  setText("scenarioRepayAction", `Repay ${formatAmount(repayAmount, "bCASH")}; withdraw ${formatAmount(withdrawAmount, "vA")}`);
  setText(
    "scenarioRepayAfter",
    `Debt ${formatAmount(projectedRepayDebt, "bCASH")} / collateral ${formatAmount(remainingCollateral, "vA")} / health ${withdrawHealth.label}`
  );
  setText(
    "scenarioLiquidationBefore",
    status?.deployed ? `Oracle ${formatAmount(currentCollateralPrice, "bCASH/vA")} / health ${currentHealth.label}` : "Needs demo account"
  );
  setText("scenarioLiquidationAction", `Shock to ${formatAmount(shockPrice, "bCASH/vA")}; repay ${formatAmount(liquidationAmount, "bCASH")}`);
  setText(
    "scenarioLiquidationAfter",
    settlementStarted
      ? `Settlement ${settlement.unlocked ? "unlocked" : "pending"} / ${formatAmount(settlement.seizedVoucherBalance, "vA")} vA`
      : liquidationExecuted
        ? `Debt ${formatAmount(risk.afterLiquidation?.debt, "bCASH")} / collateral ${formatAmount(risk.afterLiquidation?.collateral, "vA")}`
        : `Health ${shockedHealth.label}; liquidatable ${liquidatableAfterSelectedShock || risk.shockPreview?.liquidatable ? "yes" : "no"}`
  );

  const borrowValidation = validateAmountAction("borrow", status);
  setScenarioAmountSummary(
    "scenarioHealthyAmountSummary",
    borrowValidation.ok
      ? `Uses ${formatAmount(borrowAmount, "bCASH")} from Borrower Portal borrow amount. Expected: debt ${formatAmount(projectedBorrowDebt, "bCASH")}; health ${borrowHealth.label}.`
      : `Needs input before this scenario can run: ${borrowValidation.message} Source: Borrower Portal borrow amount.`,
    borrowValidation.ok ? borrowValidation.severity || "" : "error"
  );

  const repayValidation = validateAmountAction("repay", status);
  const withdrawValidation = validateAmountAction("withdrawCollateral", status);
  const repaySummarySeverity =
    !repayValidation.ok && !withdrawValidation.ok
      ? "error"
      : !repayValidation.ok || !withdrawValidation.ok
        ? "warning"
        : repayValidation.severity || withdrawValidation.severity || "";
  setScenarioAmountSummary(
    "scenarioRepayAmountSummary",
    [
      `Repay uses ${formatAmount(repayAmount, "bCASH")} and withdraw uses ${formatAmount(withdrawAmount, "vA")} from Borrower Portal controls.`,
      `Expected: debt ${formatAmount(projectedRepayDebt, "bCASH")}; collateral ${formatAmount(remainingCollateral, "vA")}.`,
      !repayValidation.ok ? `Repay blocked: ${repayValidation.message}` : "",
      !withdrawValidation.ok ? `Withdraw blocked: ${withdrawValidation.message}` : "",
    ]
      .filter(Boolean)
      .join(" "),
    repaySummarySeverity
  );

  const shockValidation = validateAmountAction("simulatePriceShock", status);
  const liquidationValidation = validateAmountAction("executeLiquidation", status);
  const liquidationSummarySeverity = !shockValidation.ok ? "error" : !liquidationValidation.ok ? "warning" : shockValidation.severity || "";
  setScenarioAmountSummary(
    "scenarioLiquidationAmountSummary",
    [
      `Shock uses ${formatAmount(shockPrice, "bCASH/vA")} and liquidation repay uses ${formatAmount(liquidationAmount, "bCASH")} from Risk Admin controls.`,
      `Expected: health ${shockedHealth.label}; liquidatable ${liquidatableAfterSelectedShock || risk.shockPreview?.liquidatable ? "yes" : "no"}.`,
      !shockValidation.ok ? `Shock blocked: ${shockValidation.message}` : "",
      shockValidation.ok && !liquidationValidation.ok ? `Liquidation after shock may need an oracle update first: ${liquidationValidation.message}` : "",
    ]
      .filter(Boolean)
      .join(" "),
    liquidationSummarySeverity
  );

  for (const [action, field] of Object.entries({
    lock: "bridgeValidation",
    depositCollateral: "depositValidation",
    borrow: "borrowValidation",
    repay: "repayValidation",
    withdrawCollateral: "withdrawValidation",
    simulatePriceShock: "shockValidation",
    executeLiquidation: "liquidationValidation",
  })) {
    const validation = validateAmountAction(action, status);
    const touched = document.getElementById(AMOUNT_ACTIONS[action]?.inputId)?.dataset.dirty === "true";
    const unhealthyWithdrawal =
      action === "withdrawCollateral" && withdrawAmount > 0 && ["Danger", "Liquidatable"].includes(withdrawHealth.status);
    setValidation(
      field,
      validation.message || (unhealthyWithdrawal ? "Projected health is at risk after withdrawal." : ""),
      validation.severity || (validation.ok && unhealthyWithdrawal ? "warning" : validation.ok || !touched ? "" : "error")
    );
  }

  const burnEligibility = actionEligibility("burn", status);
  setValidation("burnValidation", burnEligibility.message, burnEligibility.ok ? "" : "error");
  updateLinkyGuides(status);

  updateAmountActionAvailability(status);
  if (!actionCardPinned) setActiveActionCard(suggestActionCard(status));
  updateProofLifecycle(status, currentRunningAction);
  syncWorkflowUi(status);
}

function setFocusMode(enabled) {
  document.body.classList.toggle("is-focus-mode", enabled);
  focusModeButton?.setAttribute("aria-pressed", enabled ? "true" : "false");
  if (focusModeButton) focusModeButton.textContent = enabled ? "Exit Focus" : "Focus Mode";
  try {
    sessionStorage.setItem(FOCUS_MODE_STORAGE_KEY, enabled ? "true" : "false");
  } catch {}
}

function formatClock(isoString) {
  if (!isoString) return "Just now";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "Just now";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    day: "2-digit",
    month: "short",
  }).format(date);
}

function snapshotStatus(status) {
  if (!status?.deployed) return {};
  const statusAOnB =
    status.progress?.statusAOnBName || CLIENT_STATUS[Number(status.progress?.statusAOnB)] || status.progress?.statusAOnB;
  const statusBOnA =
    status.progress?.statusBOnAName || CLIENT_STATUS[Number(status.progress?.statusBOnA)] || status.progress?.statusBOnA;
  const misbehaviour = status.trace?.misbehaviour || {};
  const timeoutAbsence = status.security?.timeoutAbsence || status.security?.nonMembership;
  return {
    packetSequenceA: status.progress?.packetSequenceA,
    headerHeightA: status.progress?.headerHeightA,
    trustedAOnB: status.progress?.trustedAOnB,
    voucherBalance: status.balances?.voucher,
    liquidatorVoucher: status.balances?.liquidatorVoucher,
    liquidatorOrigin: status.balances?.liquidatorOrigin,
    bankBBalance: status.balances?.bankB,
    poolCollateral: status.balances?.poolCollateral,
    poolDebt: status.balances?.poolDebt,
    totalBorrows: status.market?.totalBorrows,
    reserves: status.market?.totalReserves,
    badDebt: status.market?.totalBadDebt,
    borrowRate: status.market?.borrowRateBps,
    utilization: status.market?.utilizationRateBps,
    oracleFresh: status.market?.oracleFresh ? "fresh" : "stale/missing",
    escrowBalance: status.balances?.escrow,
    packetSequenceB: status.progress?.packetSequenceB,
    headerHeightB: status.progress?.headerHeightB,
    trustedBOnA: status.progress?.trustedBOnA,
    forwardPacketId: status.trace?.forward?.packetId,
    reversePacketId: status.trace?.reverse?.packetId,
    settlementPacketId: status.risk?.settlement?.packetId,
    settlementUnlocked: status.risk?.settlement?.unlocked ? "unlocked" : status.risk?.settlement?.started ? "pending proof" : null,
    safetyState: status.security?.frozen
      ? "Frozen"
      : status.security?.recovering
        ? "Recovering"
        : `${statusAOnB}/${statusBOnA}`,
    receiptReplayGuardLive: status.security?.receiptReplayGuardLive ? "live" : "pending",
    explicitReplayAttackRejected: status.security?.explicitReplayAttackRejected
      ? `rejected${status.security?.replayProofHeight ? ` @ ${status.security.replayProofHeight}` : ""}`
      : "not tested",
    timeoutAbsence: timeoutAbsence ? `seq ${timeoutAbsence.absentSequence || "-"}` : null,
    timeoutRefund: timeoutAbsence?.refundObserved
      ? `refunded ${timeoutAbsence.packetId ? timeoutAbsence.packetId.slice(0, 10) : ""}`
      : null,
    misbehaviour: misbehaviour.frozen
      ? `frozen ${misbehaviour.height || "-"}`
      : misbehaviour.recovered
        ? `recovered ${misbehaviour.recoveredAtHeight || "-"}`
        : null,
  };
}

const FACT_LABELS = {
  packetSequenceA: "Bank A packet sequence",
  headerHeightA: "Bank A header height",
  trustedAOnB: "Bank B imported Bank A header",
  voucherBalance: "Voucher balance",
  liquidatorVoucher: "Liquidator voucher balance",
  liquidatorOrigin: "Liquidator origin balance",
  bankBBalance: "Demo account bCASH",
  poolCollateral: "Pool collateral",
  poolDebt: "Pool debt",
  totalBorrows: "Accrued total borrows",
  reserves: "Pool reserves",
  badDebt: "Bad debt",
  borrowRate: "Borrow APR bps",
  utilization: "Utilization bps",
  oracleFresh: "Oracle freshness",
  escrowBalance: "Escrowed aBANK",
  packetSequenceB: "Bank B packet sequence",
  headerHeightB: "Bank B header height",
  trustedBOnA: "Bank A imported Bank B header",
  forwardPacketId: "Forward packet id",
  reversePacketId: "Reverse packet id",
  settlementPacketId: "Settlement packet id",
  settlementUnlocked: "Seized-voucher settlement",
  safetyState: "Light-client safety state",
  receiptReplayGuardLive: "Replay guard",
  explicitReplayAttackRejected: "Replay attack test",
  timeoutAbsence: "Receipt absence timeout proof",
  timeoutRefund: "Timeout refund",
  misbehaviour: "Conflicting-header evidence",
};

const FACT_ELEMENT_IDS = {
  packetSequenceA: ["packetSequenceA", "routeEscrow"],
  headerHeightA: ["headerHeightA", "routeHeader"],
  trustedAOnB: ["trustedAOnB", "routeClient", "proofTrustedHeight"],
  voucherBalance: ["voucherBalance", "proofReceiptStatus"],
  liquidatorVoucher: ["riskSettlementSeizedVoucher"],
  liquidatorOrigin: ["riskSettlementOriginBalance"],
  bankBBalance: ["bankBBalance"],
  poolCollateral: ["poolCollateral", "riskCollateralValue", "riskAfterCollateral"],
  poolDebt: ["poolDebt", "currentDebtHero", "riskDebt", "riskAfterDebt"],
  totalBorrows: ["totalBorrows", "riskTotalDebt"],
  reserves: ["totalReserves", "riskTotalReserves", "riskAfterReserves"],
  badDebt: ["totalBadDebt", "riskTotalBadDebt", "riskAfterBadDebt"],
  borrowRate: ["borrowRate"],
  utilization: ["utilizationBps", "riskUtilization"],
  oracleFresh: ["oracleFresh", "riskOracleLabel"],
  escrowBalance: ["escrowBalance"],
  packetSequenceB: ["packetSequenceB", "routeReverse"],
  headerHeightB: ["headerHeightB"],
  trustedBOnA: ["trustedBOnA"],
  forwardPacketId: ["forwardPacketId", "proofPacketId"],
  reversePacketId: ["reversePacketId", "proofPacketId"],
  settlementPacketId: ["riskSettlementPacket", "proofPacketId"],
  settlementUnlocked: ["riskSettlementStatus"],
  safetyState: ["proofLightClientStatus", "statusAOnB", "statusBOnA", "routeSafety"],
  receiptReplayGuardLive: ["proofReplayStatus", "replayGuardState"],
  explicitReplayAttackRejected: ["proofReplayStatus", "replayAttackState"],
  timeoutAbsence: ["proofTimeoutStatus", "proofTimeoutKey", "timeoutAbsenceState"],
  timeoutRefund: ["proofTimeoutTx", "proofTimeoutStatus"],
  misbehaviour: ["proofFreezeEvidence", "misbehaviourState"],
};

function collectChanges(before, after) {
  const previous = before || {};
  const next = after || {};
  return Object.keys(FACT_LABELS)
    .filter((key) => previous[key] !== next[key] && next[key] != null && next[key] !== "")
    .slice(0, 6)
    .map((key) => ({
      key,
      label: FACT_LABELS[key],
      value: `${previous[key] == null ? "set" : previous[key]} -> ${next[key]}`,
    }));
}

function actionTitle(action) {
  const titles = {
    openRoute: "Establish Bank Route",
    lock: "Transfer Collateral to Bank B",
    finalizeForwardHeader: "Checked source-bank confirmation",
    updateForwardClient: "Confirmed collateral transfer",
    proveForwardMint: "Receive Verified Collateral",
    depositCollateral: "Deposit Collateral",
    borrow: "Borrow Cash",
    repay: "Repay Loan",
    topUpRepayCash: "Added demo bCASH",
    withdrawCollateral: "Withdrew collateral",
    simulatePriceShock: "Simulate Collateral Price Drop",
    executeLiquidation: "Execute Liquidation",
    settleSeizedVoucher: "Started seized-voucher settlement",
    burn: "Started collateral return",
    finalizeReverseHeader: "Checked return confirmation",
    updateReverseClient: "Confirmed collateral return",
    proveReverseUnlock: "Completed source-bank release",
    freezeClient: "Entered safety mode",
    recoverClient: "Recovered account safety",
    replayForward: "Tested duplicate protection",
    executeTimeoutRefund: "Executed timeout refund",
    verifyTimeoutAbsence: "Marked legacy timeout explanation",
    fullFlow: "Completed risk/liquidation lifecycle",
    borrowerCloseout: "Closed position and returned collateral",
    deploySeed: "Prepared demo session",
    resetSeeded: "Fresh Reset (slow setup only)",
    resumeSession: "Resumed runtime session",
    refresh: "Refreshed account state",
  };
  return titles[action] || action;
}

function renderPortalChanges(action, activity, guide = guideForAction(action)) {
  const banner = document.getElementById("portalChangeBanner");
  const list = document.getElementById("portalChangeList");
  if (!banner || !list || !activity) return;
  banner.hidden = false;
  banner.classList.remove("is-failed", "is-warning");
  banner.classList.add("is-visible");
  setPortalFeedbackLinky("success");
  setText("portalChangeScope", `Visible changes / ${guide.affectedPortal}`);
  setText("portalChangeTitle", guide.runningTitle || activity.title);
  setText("portalChangeSummary", guide.nextAfterSuccess || activity.summary || guide.expectedVisibleChange);
  list.innerHTML = "";
  const changes = activity.changes?.length
    ? activity.changes.slice(0, 3)
    : [{ label: "Expected result", value: guide.expectedVisibleChange }];
  for (const change of changes) {
    const li = document.createElement("li");
    if (change.label) {
      const strong = document.createElement("strong");
      strong.textContent = change.label;
      li.appendChild(strong);
    }
    li.appendChild(document.createTextNode(change.value));
    list.appendChild(li);
  }
}

function renderPortalWarning(action, message, guide = guideForAction(action)) {
  const banner = document.getElementById("portalChangeBanner");
  const list = document.getElementById("portalChangeList");
  if (!banner || !list) return;
  banner.hidden = false;
  banner.classList.remove("is-failed");
  banner.classList.add("is-visible", "is-warning");
  setPortalFeedbackLinky("risk");
  setText("portalChangeScope", `Setup check / ${guide.affectedPortal}`);
  setText("portalChangeTitle", `${guide.runningTitle} needs attention`);
  setText("portalChangeSummary", message || "The existing runtime was not confirmed ready.");
  list.innerHTML = "";
  const li = document.createElement("li");
  li.textContent = guide.failureRecovery;
  list.appendChild(li);
}

function renderPortalFailure(action, error, guide = guideForAction(action)) {
  const banner = document.getElementById("portalChangeBanner");
  const list = document.getElementById("portalChangeList");
  if (!banner || !list) return;
  banner.hidden = false;
  banner.classList.remove("is-warning");
  banner.classList.add("is-visible", "is-failed");
  setPortalFeedbackLinky("risk");
  setText("portalChangeScope", `Recovery / ${guide.affectedPortal}`);
  setText("portalChangeTitle", `${guide.runningTitle} failed`);
  setText("portalChangeSummary", error?.userMessage || error?.message || "The action failed before the expected visible change completed.");
  list.innerHTML = "";
  const li = document.createElement("li");
  li.textContent = guide.failureRecovery;
  list.appendChild(li);
  const output = error?.payload?.output || error?.payload?.message || "";
  if (output && !output.includes(li.textContent)) {
    const detail = document.createElement("li");
    detail.textContent = output.split("\n").filter(Boolean).slice(0, 3).join(" ");
    list.appendChild(detail);
  }
}

function pushActivity(action, summary, nextStatus) {
  const changes = collectChanges(snapshotStatus(currentStatus), snapshotStatus(nextStatus));
  const activity = {
    title: actionTitle(action),
    summary,
    time: new Date().toISOString(),
    timeLabel: formatClock(new Date().toISOString()),
    changes,
  };
  renderPortalChanges(action, activity);
  const changedIds = changes.flatMap((change) => FACT_ELEMENT_IDS[change.key] || []);
  highlightNodeIds([...new Set([...changedIds, ...(guideForAction(action).affectedMetrics || [])])], "success");
  return activity;
}

function pushWarningActivity(action, summary, nextStatus) {
  const activity = {
    title: `${actionTitle(action)} needs attention`,
    summary,
    time: new Date().toISOString(),
    timeLabel: formatClock(new Date().toISOString()),
    changes: [{ value: "No protocol state was modified." }],
  };
  renderPortalWarning(action, summary);
  highlightNodeIds(guideForAction(action).affectedMetrics || [], "running");
  return activity;
}

function pushFailedActivity(action, error) {
  const summary = error?.userMessage || error?.message || "The action failed before any contract state changed.";
  const activity = {
    title: `${actionTitle(action)} failed`,
    summary,
    time: new Date().toISOString(),
    timeLabel: formatClock(new Date().toISOString()),
    changes: [{ value: "No state change was committed." }],
  };
  renderPortalFailure(action, error);
  return activity;
}

function isTransientStatusRead(status) {
  return Boolean(status?.statusReadTimedOut || (status?.transient && status?.label === "Status read timeout"));
}

function statusWithPreservedVisibleState(status) {
  if (!isTransientStatusRead(status) || !currentStatus?.deployed) return status;
  return {
    ...currentStatus,
    controller: status.controller || currentStatus.controller,
    transient: true,
    statusReadTimedOut: true,
    label: status.label || currentStatus.label,
    message: status.message || currentStatus.message,
  };
}

function recoverCompletedActionFromStatus(action, status, message, output, { forceDefaults = false, beforeState = currentRunningAction?.beforeCompletionState } = {}) {
  if (!status || !actionReachedExpectedState(action, status, beforeState)) return false;
  if (controllerStillRunning(status)) return false;
  renderStatus(status);
  refreshTransactionUi(status, { forceDefaults });
  pushActivity(action, message || `${guideForAction(action).runningTitle} completed.`, status);
  currentStatus = status;
  selectedWorkflowStep = null;
  syncWorkflowUi(currentStatus);
  if (currentRunningAction) currentRunningAction.nextAction = currentWorkflowAction;
  completeActionUi(action, true);
  setText("lastMessage", message || `${guideForAction(action).runningTitle} completed.`);
  setOutput(output || `[controller] ${guideForAction(action).runningTitle} completed and visible state was refreshed.`);
  return true;
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    const error = new Error([payload.error, payload.output].filter(Boolean).join("\n\n"));
    error.statusCode = response.status;
    error.payload = payload;
    error.userMessage = payload.message || payload.error;
    throw error;
  }
  return payload;
}

async function refreshStatus() {
  const status = await requestJson("/api/status");
  const visibleStatus = statusWithPreservedVisibleState(status);
  currentStatus = visibleStatus;
  renderStatus(visibleStatus);
  syncControllerOperationFromStatus(visibleStatus);
  applyActionAvailability(visibleStatus);
  refreshTransactionUi(visibleStatus);
  return visibleStatus;
}

function updateRunningController(status) {
  if (!currentRunningAction) return;
  const visibleStatus = statusWithPreservedVisibleState(status);
  const transientStatusRead = isTransientStatusRead(status);
  currentRunningAction.controller = visibleStatus?.controller?.activeOperation || null;
  const elapsed = currentRunningAction.controller?.elapsedSeconds ?? Math.round((Date.now() - currentRunningAction.startedAtMs) / 1000);
  if (!transientStatusRead && visibleStatus?.deployed === false && currentRunningAction.phase === "running") {
    const error = new Error(
      visibleStatus.message ||
        "The cached deployment is not present on the running chains. Prepare the demo session again before continuing."
    );
    error.userMessage = error.message;
    completeActionUi(currentRunningAction.action, false, error);
    setBusy(false);
    setText("lastMessage", error.message);
    setOutput(error.message);
    return;
  }
  const action = currentRunningAction.action;
  if (
    currentRunningAction.awaitingActionResponse &&
    actionResponseMustSettle(action) &&
    currentRunningAction.phase === "running"
  ) {
    setText(
      "lastMessage",
      `${currentRunningAction.guide.runningTitle} is still waiting for the controller response. The UI will not advance from a polling-only intermediate state.`
    );
    renderPrimaryGuide(currentRunningAction);
    updateProofLifecycle(visibleStatus || currentStatus, currentRunningAction);
    return;
  }
  if (action === "resetSeeded" && currentRunningAction.controller && currentRunningAction.phase === "running") {
    setText("lastMessage", "Fresh Reset is still redeploying and reseeding the clean baseline.");
    renderPrimaryGuide(currentRunningAction);
    updateProofLifecycle(visibleStatus || currentStatus, currentRunningAction);
    return;
  }
  if (!transientStatusRead && recoverCompletedActionFromStatus(action, visibleStatus, `${currentRunningAction.guide.runningTitle} completed.`)) {
    setBusy(false);
    return;
  }
  if (transientStatusRead && currentRunningAction.phase === "running") {
    setText(
      "lastMessage",
      `${currentRunningAction.guide.runningTitle} is still running. Status refresh timed out, so the UI is keeping the last visible state and waiting for the controller response.`
    );
    renderPrimaryGuide(currentRunningAction);
    updateProofLifecycle(visibleStatus || currentStatus, currentRunningAction);
    return;
  }
  if (!currentRunningAction.controller && currentRunningAction.phase === "running") {
    if (recoverCompletedActionFromStatus(action, visibleStatus, `${currentRunningAction.guide.runningTitle} completed.`)) {
      setBusy(false);
      return;
    }
    setText(
      "lastMessage",
      `${currentRunningAction.guide.runningTitle} is finalizing. Waiting for the controller response or a visible state change.`
    );
    renderPrimaryGuide(currentRunningAction);
    return;
  }
  renderPrimaryGuide(currentRunningAction);
  updateProofLifecycle(visibleStatus || currentStatus, currentRunningAction);
  const label = currentRunningAction.controller?.label || currentRunningAction.guide.runningTitle;
  setText("lastMessage", `Running ${label}. Waiting for tx confirmation, proof generation, or status refresh if needed.`);
}

function stopActionPolling() {
  if (actionPollTimer) window.clearInterval(actionPollTimer);
  actionPollTimer = null;
}

function startActionPolling() {
  stopActionPolling();
  actionPollTimer = window.setInterval(async () => {
    if (!currentRunningAction || currentRunningAction.phase !== "running") return;
    try {
      const status = await requestJson("/api/status");
      const visibleStatus = statusWithPreservedVisibleState(status);
      currentStatus = visibleStatus;
      renderStatus(visibleStatus);
      setScenarioCardState(activeScenarioCard, "running", "Running");
      updateRunningController(visibleStatus);
    } catch (error) {
      setText("primaryGuideController", `Status refresh is waiting: ${error.message}`);
    }
  }, 1500);
}

function keepActionOpenForVisibleState(action, status, message, output) {
  if (!currentRunningAction || !STRICT_VISIBLE_COMPLETION_ACTIONS.has(action)) return false;
  if (
    !isTransientStatusRead(status) &&
    actionReachedExpectedState(action, status, currentRunningAction.beforeCompletionState) &&
    !controllerStillRunning(status)
  ) {
    return false;
  }
  currentStatus = statusWithPreservedVisibleState(status);
  renderStatus(currentStatus);
  refreshTransactionUi(currentStatus, { forceDefaults: true });
  setText(
    "lastMessage",
    controllerStillRunning(currentStatus)
      ? `${guideForAction(action).runningTitle} reached a visible state change. Waiting for the controller to finish before enabling the next action.`
      : message || `${guideForAction(action).runningTitle} was submitted. Waiting for the visible dashboard state to catch up.`
  );
  setOutput(
    output ||
      (controllerStillRunning(currentStatus)
        ? `[controller] Visible state changed for ${guideForAction(action).runningTitle}; waiting for the active controller to clear.`
        : `[controller] Waiting for refreshed visible state after ${guideForAction(action).runningTitle}.`)
  );
  renderPrimaryGuide(currentRunningAction);
  startActionPolling();
  return true;
}

function beginActionUi(action, button = null) {
  if (currentRunningAction?.phase === "running") {
    renderPrimaryGuide(currentRunningAction);
    setText(
      "lastMessage",
      `${currentRunningAction.guide.runningTitle} is already running. Wait for it to finish before starting another action.`
    );
    return false;
  }
  const guide = guideForAction(action);
  currentRunningAction = {
    action,
    guide,
    button,
    phase: "running",
    startedAtMs: Date.now(),
    controller: null,
    awaitingActionResponse: false,
    beforeCompletionState: actionCompletionSnapshot(action, currentStatus),
  };
  activeScenarioCard = scenarioCardForButton(button) || (button?.closest(".portal-scenarios") ? scenarioCardForAction(action) : null);
  setScenarioCardState(activeScenarioCard, "running", "Running");
  document.body.dataset.runningAction = action;
  document.body.dataset.actionPortal = guide.affectedPortal;
  setText("lastMessage", `Running ${guide.runningTitle}. Waiting for tx confirmation, proof generation, or status refresh if needed.`);
  setOutput(`${guide.currentAction}\n\nExpected visible change: ${guide.expectedVisibleChange}\nNext after success: ${guide.nextAfterSuccess}`);
  renderPrimaryGuide(currentRunningAction);
  highlightNodeIds(guide.affectedMetrics, "running");
  updateProofLifecycle(currentStatus, currentRunningAction);
  setBusy(true);
  startActionPolling();
  return true;
}

function attachToControllerOperation(activeOperation, button = null) {
  if (!activeOperation?.action) return false;
  const action = activeOperation.action;
  const guide = guideForAction(action);
  const elapsedSeconds = Number(activeOperation.elapsedSeconds || 0);
  currentRunningAction = {
    action,
    guide,
    button,
    phase: "running",
    startedAtMs: Date.now() - Math.max(0, elapsedSeconds) * 1000,
    controller: activeOperation,
    awaitingActionResponse: false,
    beforeCompletionState: actionCompletionSnapshot(action, currentStatus),
  };
  activeScenarioCard = scenarioCardForButton(button) || scenarioCardForAction(action);
  setScenarioCardState(activeScenarioCard, "running", "Running");
  document.body.dataset.runningAction = action;
  document.body.dataset.actionPortal = guide.affectedPortal;
  setText(
    "lastMessage",
    `${activeOperation.label || guide.runningTitle} is already running. Waiting for it to finish.`
  );
  setOutput(`[controller] ${activeOperation.label || guide.runningTitle} is already running. Wait for completion.`);
  renderPrimaryGuide(currentRunningAction);
  updateProofLifecycle(currentStatus, currentRunningAction);
  setBusy(true);
  startActionPolling();
  return true;
}

function syncControllerOperationFromStatus(status, button = null) {
  const activeOperation = status?.controller?.activeOperation;
  if (!activeOperation?.action) return false;
  if (currentRunningAction?.phase === "running" && currentRunningAction.action === activeOperation.action) {
    currentRunningAction.controller = activeOperation;
    renderPrimaryGuide(currentRunningAction);
    updateProofLifecycle(status || currentStatus, currentRunningAction);
    setBusy(true);
    if (!actionPollTimer) startActionPolling();
    return true;
  }
  return attachToControllerOperation(activeOperation, button);
}

function attachBusyController(error, button = null) {
  if (error?.statusCode !== 409) return false;
  const activeOperation = error.payload?.controller?.activeOperation;
  return syncControllerOperationFromStatus({ controller: { activeOperation } }, button);
}

function completeActionUi(action, ok, error = null, phaseOverride = null) {
  stopActionPolling();
  if (!currentRunningAction || currentRunningAction.action !== action) return;
  const phase = phaseOverride || (ok ? "success" : "failed");
  currentRunningAction.completedAtMs = Date.now();
  currentRunningAction.completedElapsedSeconds =
    currentRunningAction.controller?.elapsedSeconds ??
    Math.max(0, Math.round((currentRunningAction.completedAtMs - currentRunningAction.startedAtMs) / 1000));
  currentRunningAction.phase = phase;
  currentRunningAction.error = error;
  currentRunningAction.controller = null;
  renderPrimaryGuide(currentRunningAction);
  updateProofLifecycle(currentStatus, currentRunningAction);
  setScenarioCardState(
    activeScenarioCard,
    phase === "warning" ? "failed" : ok ? "success" : "failed",
    phase === "warning" ? "Needs Reset" : ok ? "Success" : "Failed"
  );
  if (phase === "warning") {
    renderPortalWarning(action, error?.userMessage || error?.message, currentRunningAction.guide);
    highlightNodeIds(currentRunningAction.guide.affectedMetrics, "running");
  } else if (!ok) {
    renderPortalFailure(action, error, currentRunningAction.guide);
    highlightNodeIds(currentRunningAction.guide.affectedMetrics, "running");
  }
  delete document.body.dataset.runningAction;
  delete document.body.dataset.actionPortal;
}

async function runDeploySeed(button = deploySeedButton) {
  if (!beginActionUi("deploySeed", button)) return;
  if (currentRunningAction?.action === "deploySeed") currentRunningAction.awaitingActionResponse = true;
  let attachedBusyController = false;
  try {
    const payload = await requestJson("/api/deploy-seed", { method: "POST" });
    if (currentRunningAction?.action === "deploySeed") currentRunningAction.awaitingActionResponse = false;
    const status = statusWithPreservedVisibleState(payload.status);
    actionCardPinned = false;
    setLoanTab("borrow");
    renderStatus(status);
    refreshTransactionUi(status, { forceDefaults: true });
    currentStatus = status;
    selectedWorkflowStep = null;
    syncWorkflowUi(currentStatus);
    if (payload.ready) {
      pushActivity("deploySeed", payload.message || "The interchain lending runtime is confirmed for live demo actions.", status);
      rememberNextActionFromPayload(payload);
      completeActionUi("deploySeed", true);
      setText("lastMessage", payload.message || "Demo runtime confirmed ready.");
    } else {
      const warning = new Error(payload.message || "Existing runtime config was not confirmed ready.");
      setText("deploymentStatus", "Setup check failed");
      pushWarningActivity("deploySeed", warning.message, status);
      completeActionUi("deploySeed", false, warning, "warning");
      setText("lastMessage", warning.message);
    }
    setOutput(payload.output);
  } catch (error) {
    if (currentRunningAction?.action === "deploySeed") currentRunningAction.awaitingActionResponse = false;
    if (attachBusyController(error, button)) {
      attachedBusyController = true;
      return;
    }
    completeActionUi("deploySeed", false, error);
    setText("lastMessage", error.statusCode === 409 ? "Controller is busy." : "Prepare Demo Session failed.");
    setOutput(error.message);
    pushFailedActivity("deploySeed", error);
  } finally {
    if (!attachedBusyController) setBusy(false);
  }
}

async function runResetSeeded(button = resetSeededButton) {
  if (!beginActionUi("resetSeeded", button)) return;
  if (currentRunningAction?.action === "resetSeeded") currentRunningAction.awaitingActionResponse = true;
  let attachedBusyController = false;
  try {
    const payload = await requestJson("/api/reset-seeded", { method: "POST" });
    if (currentRunningAction?.action === "resetSeeded") currentRunningAction.awaitingActionResponse = false;
    const status = statusWithPreservedVisibleState(payload.status);
    actionCardPinned = false;
    setLoanTab("borrow");
    renderStatus(status);
    refreshTransactionUi(status, { forceDefaults: true });
    pushActivity("resetSeeded", "A fresh interchain lending runtime was deployed and seeded for a clean demo baseline.", status);
    currentStatus = status;
    selectedWorkflowStep = null;
    syncWorkflowUi(currentStatus);
    rememberNextActionFromPayload(payload);
    completeActionUi("resetSeeded", true);
    setText("lastMessage", "Fresh reset complete.");
    setOutput(payload.output);
  } catch (error) {
    if (currentRunningAction?.action === "resetSeeded") currentRunningAction.awaitingActionResponse = false;
    if (attachBusyController(error, button)) {
      attachedBusyController = true;
      return;
    }
    if (isTransientStatusRead(error.payload?.status)) {
      const status = statusWithPreservedVisibleState(error.payload.status);
      keepActionOpenForVisibleState(
        "resetSeeded",
        status,
        "Fresh Reset was submitted. Keeping the reset card open while the clean seeded state becomes visible.",
        error.payload?.output || error.message
      );
      attachedBusyController = true;
      return;
    }
    if (
      !isTransientStatusRead(error.payload?.status) &&
      recoverCompletedActionFromStatus("resetSeeded", error.payload?.status, error.payload?.message, error.payload?.output, { forceDefaults: true })
    ) {
      return;
    }
    completeActionUi("resetSeeded", false, error);
    setText("lastMessage", error.statusCode === 409 ? "Controller is busy." : "Fresh Reset failed.");
    setOutput(error.message);
    pushFailedActivity("resetSeeded", error);
  } finally {
    if (!attachedBusyController) setBusy(false);
  }
}

async function runResumeSession(button = resumeSessionButtons[0]) {
  if (!beginActionUi("resumeSession", button)) return;
  if (currentRunningAction?.action === "resumeSession") currentRunningAction.awaitingActionResponse = true;
  let attachedBusyController = false;
  try {
    const payload = await requestJson("/api/resume-session", { method: "POST" });
    if (currentRunningAction?.action === "resumeSession") currentRunningAction.awaitingActionResponse = false;
    const status = statusWithPreservedVisibleState(payload.status);
    actionCardPinned = false;
    renderStatus(status);
    refreshTransactionUi(status, { forceDefaults: false });
    currentStatus = status;
    selectedWorkflowStep = null;
    syncWorkflowUi(currentStatus);
    pushActivity("resumeSession", payload.message || "Runtime session resumed and proof anchors refreshed.", status);
    rememberNextActionFromPayload(payload);
    completeActionUi("resumeSession", true);
    setText("lastMessage", payload.message || "Resume Session complete.");
    setOutput(payload.output);
  } catch (error) {
    if (currentRunningAction?.action === "resumeSession") currentRunningAction.awaitingActionResponse = false;
    if (attachBusyController(error, button)) {
      attachedBusyController = true;
      return;
    }
    completeActionUi("resumeSession", false, error);
    setText(
      "lastMessage",
      error.statusCode === 409 ? error.userMessage || "Resume Session needs slow setup recovery." : "Resume Session failed."
    );
    setOutput(error.message);
    pushFailedActivity("resumeSession", error);
  } finally {
    if (!attachedBusyController) setBusy(false);
  }
}

function amountPayloadForAction(action, button = null) {
  const config = AMOUNT_ACTIONS[action];
  if (!config) return {};
  if (button === primaryWorkflowCta) {
    primeRecommendedAmount(action, currentStatus, { force: true });
  }
  const validation = validateAmountAction(action);
  if (!validation.ok) {
    setValidation(
      {
        lock: "bridgeValidation",
        depositCollateral: "depositValidation",
        borrow: "borrowValidation",
        repay: "repayValidation",
        withdrawCollateral: "withdrawValidation",
        simulatePriceShock: "shockValidation",
        executeLiquidation: "liquidationValidation",
      }[action],
      validation.message,
      "error"
    );
    setScenarioCardValidation(button, validation.message);
    throw new Error(validation.message);
  }
  return { amount: String(validation.amount) };
}

async function runAction(action, { button = null, workflowRequestLog = "" } = {}) {
  if (LOAN_TAB_BY_ACTION[action]) setLoanTab(LOAN_TAB_BY_ACTION[action]);
  const actionCard = button?.closest("[data-action-card]")?.dataset.actionCard || ACTION_CARD_BY_ACTION[action] || suggestActionCard(currentStatus);
  setActiveActionCard(actionCard, { pinned: true });
  let requestBody;
  try {
    requestBody = { action, ...amountPayloadForAction(action, button) };
  } catch (error) {
    setText("lastMessage", error.message);
    return;
  }
  const title = actionTitle(action);
  if (!beginActionUi(action, button)) return;
  if (workflowRequestLog && currentRunningAction?.action === action) {
    currentRunningAction.workflowRequestLog = workflowRequestLog;
  }
  if (currentRunningAction?.action === action) {
    currentRunningAction.awaitingActionResponse = true;
  }
  const runningOutput = [
    workflowRequestLog,
    guideForAction(action).currentAction,
    requestBody.amount ? `Amount: ${requestBody.amount} ${AMOUNT_ACTIONS[action]?.unit || ""}` : null,
    `Expected visible change: ${guideForAction(action).expectedVisibleChange}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  setOutput(runningOutput);
  let attachedBusyController = false;
  try {
    const payload = await requestJson("/api/action", {
      method: "POST",
      body: JSON.stringify(requestBody),
    });
    if (currentRunningAction?.action === action) {
      currentRunningAction.awaitingActionResponse = false;
    }
    const status = statusWithPreservedVisibleState(payload.status);
    renderStatus(status);
    refreshTransactionUi(status, { forceDefaults: true });
    currentStatus = status;
    selectedWorkflowStep = null;
    syncWorkflowUi(currentStatus);
    if (
      keepActionOpenForVisibleState(
        action,
        status,
        `${title} submitted. Waiting for Linky's recommendation to update from the refreshed on-chain state.`,
        payload.output || payload.message
      )
    ) {
      attachedBusyController = true;
      return;
    }
    pushActivity(action, payload.message, status);
    rememberNextActionFromPayload(payload);
    completeActionUi(action, true);
    setText("lastMessage", payload.message);
    const readinessNote = postActionReadinessNote(action, status);
    const workflowOutcomeLog = [
      currentRunningAction?.workflowRequestLog,
      `[controller] Server nextAction: ${ctaDebugName(currentRunningAction?.serverNextAction)}.`,
      `[controller] Final UI nextAction: ${ctaDebugName(currentRunningAction?.nextAction)}.`,
      readinessNote ? `[controller] ${readinessNote}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    setOutput([payload.output || payload.message, workflowOutcomeLog].filter(Boolean).join("\n\n"));
  } catch (error) {
    if (currentRunningAction?.action === action) {
      currentRunningAction.awaitingActionResponse = false;
    }
    if (attachBusyController(error, button)) {
      attachedBusyController = true;
      return;
    }
    if (isTransientStatusRead(error.payload?.status)) {
      const status = statusWithPreservedVisibleState(error.payload.status);
      keepActionOpenForVisibleState(
        action,
        status,
        `${title} submitted, but the final status refresh timed out. Keeping the action open while the UI waits for visible state.`,
        error.payload?.output || error.message
      );
      attachedBusyController = true;
      return;
    }
    if (
      !isTransientStatusRead(error.payload?.status) &&
      recoverCompletedActionFromStatus(action, error.payload?.status, error.payload?.message, error.payload?.output, { forceDefaults: true })
    ) {
      return;
    }
    completeActionUi(action, false, error);
    const staleCache = String(error.payload?.error || error.message || "").includes("Cached deployment is no longer valid");
    setText("lastMessage", error.statusCode === 409 && !staleCache ? "Controller is busy." : error.payload?.error || `${title} failed.`);
    setOutput(error.message);
    pushFailedActivity(action, error);
  } finally {
    if (!attachedBusyController) setBusy(false);
  }
}

async function runActionButton(button) {
  const action = button?.dataset?.action;
  if (!action) return;
  if (button.disabled) {
    setText("lastMessage", button.title || `${actionTitle(action)} is not ready.`);
    return;
  }
  if (currentRunningAction && currentRunningAction.phase !== "running") {
    clearPrimaryGuide();
  }
  try {
    await refreshStatus();
  } catch (error) {
    setText("lastMessage", `Could not refresh before ${actionTitle(action)}: ${error.message}`);
    setOutput(error.message);
    return;
  }
  const activeOperation = activeControllerOperation(currentStatus);
  if (activeOperation?.action) {
    const message = controllerBusyMessage(activeOperation, action);
    setText("lastMessage", message);
    setOutput(
      `[controller] Direct action blocked after refresh: ${actionTitle(action)} (${action}).\n` +
        `[controller] Active controller action: ${activeOperation.label || activeOperation.action} (${activeOperation.action}).\n` +
        "[controller] No alternate action was submitted automatically."
    );
    return;
  }
  const eligibility = actionEligibility(action, currentStatus);
  if (!eligibility.ok) {
    setText("lastMessage", `${actionTitle(action)} is not ready: ${eligibility.message}`);
    setOutput(`[controller] Direct action blocked after refresh: ${actionTitle(action)} (${action}).\n[controller] ${eligibility.message}`);
    return;
  }
  const workflowRequestLog = [
    `[controller] Direct action button: ${actionTitle(action)} (${action}).`,
    `[controller] Refreshed eligibility: eligible${eligibility.message ? ` - ${eligibility.message}` : ""}.`,
  ].join("\n");
  await runAction(action, { button, workflowRequestLog });
}

async function executeWorkflowCta(cta, button = primaryWorkflowCta) {
  if (!cta) return;
  if (cta?.type === "return") {
    selectedWorkflowStep = null;
    syncWorkflowUi(currentStatus);
    return;
  }
  if (cta?.type === "portal") {
    setActivePortal(cta.portal);
    return;
  }
  if (cta?.type === "refresh") {
    currentStatus = await refreshStatus();
    syncWorkflowUi(currentStatus);
    return;
  }
  if (cta?.type === "deploySeed") {
    await runDeploySeed(button);
    return;
  }
  if (cta?.type === "resetSeeded") {
    await runResetSeeded(button);
    return;
  }
  if (cta?.type === "action" && cta.action) {
    const refreshed = await refreshStatus();
    currentStatus = refreshed;
    syncWorkflowUi(currentStatus);
    const actionToRun = cta.action;
    const activeOperation = activeControllerOperation(currentStatus);
    if (activeOperation?.action) {
      const message = controllerBusyMessage(activeOperation, actionToRun);
      setText("lastMessage", message);
      setOutput(
        `[controller] Refreshed state before running ${cta.label || actionTitle(actionToRun)}, but another controller action is still active.\n` +
          `[controller] Requested CTA action: ${cta.label || actionTitle(actionToRun)} (${actionToRun}).\n` +
          `[controller] Active controller action: ${activeOperation.label || activeOperation.action} (${activeOperation.action}).\n` +
          `[controller] No alternate action was submitted automatically.`
      );
      return;
    }
    primeRecommendedAmount(actionToRun, currentStatus, { force: true });
    const requestedEligibility = actionEligibility(actionToRun, currentStatus);
    const requestedLabel = cta.label || actionTitle(actionToRun);
    if (!requestedEligibility.ok) {
      setText(
        "lastMessage",
        `${requestedLabel} is not ready after refresh: ${requestedEligibility.message}`
      );
      setOutput(
        `[controller] Refreshed state before running ${requestedLabel}, but the requested action is not currently eligible.\n` +
          `[controller] Requested CTA action: ${requestedLabel} (${actionToRun}).\n` +
          `[controller] Refreshed eligibility: not eligible - ${requestedEligibility.message}\n` +
          `[controller] No alternate action was submitted automatically.`
      );
      return;
    }
    const workflowRequestLog = [
      `[controller] Requested CTA action: ${requestedLabel} (${actionToRun}).`,
      `[controller] Refreshed eligibility: eligible${requestedEligibility.message ? ` - ${requestedEligibility.message}` : ""}.`,
      `[controller] Action actually submitted: ${actionToRun}.`,
    ].join("\n");
    await runAction(actionToRun, { button, workflowRequestLog });
  }
}

async function runPrimaryWorkflowAction() {
  const boundCta = primaryWorkflowCtaBinding();
  if (currentRunningAction && currentRunningAction.phase !== "running") {
    const nextCta = currentRunningAction.phase === "success" ? boundCta || currentRunningAction.nextAction || currentWorkflowAction : null;
    clearPrimaryGuide();
    if (nextCta) await executeWorkflowCta(nextCta, primaryWorkflowCta);
    return;
  }
  await executeWorkflowCta(boundCta || currentWorkflowAction, primaryWorkflowCta);
}

primaryWorkflowCta?.addEventListener("click", runPrimaryWorkflowAction);
deploySeedButton?.addEventListener("click", () => runDeploySeed(deploySeedButton));
resetSeededButton?.addEventListener("click", () => runResetSeeded(resetSeededButton));
resumeSessionButtons.forEach((button) => {
  button.addEventListener("click", () => runResumeSession(button));
});
topUpRepayCashButton?.addEventListener("click", () => {
  setLoanTab("repay");
  setActiveActionCard("loan", { pinned: true });
  selectedWorkflowStep = "manage";
  runAction("topUpRepayCash", { button: topUpRepayCashButton });
});
focusModeButton?.addEventListener("click", () => {
  setFocusMode(!document.body.classList.contains("is-focus-mode"));
});
openDemoToolsButton?.addEventListener("click", () => openDrawer("demoToolsDrawer"));
openRuntimeOutputButton?.addEventListener("click", () => openDrawer("runtimeOutputDrawer"));
verificationOpenButtons.forEach((button) => {
  button.addEventListener("click", () => openDrawer("verificationDrawer"));
});
drawerCloseButtons.forEach((button) => {
  button.addEventListener("click", () => closeDrawer(button.dataset.drawerClose));
});
refreshButton?.addEventListener("click", async () => {
  const actionInFlight = currentRunningAction?.phase === "running";
  if (!actionInFlight) setBusy(true);
  try {
    const status = await refreshStatus();
    currentStatus = status;
    if (actionInFlight) {
      updateRunningController(status);
      setText("lastMessage", "State refreshed while the current action continues.");
    } else {
      pushActivity("refresh", "The UI re-read contract state and refreshed the current protocol snapshot.", status);
      setText("lastMessage", status.deployed ? "State refreshed." : status.message);
    }
  } catch (error) {
    setText("lastMessage", "Refresh failed.");
    setOutput(error.message);
    if (!actionInFlight) pushFailedActivity("refresh", error);
  } finally {
    setBusy(actionInFlight);
  }
});

actionButtons.forEach((button) => {
  button.addEventListener("click", () => runActionButton(button));
});

workflowStepButtons.forEach((button) => {
  button.addEventListener("click", () => {
    selectedWorkflowStep = button.dataset.workflowStep;
    syncWorkflowUi(currentStatus);
  });
});

loanTabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setLoanTab(button.dataset.loanTab);
    setActiveActionCard("loan", { pinned: true });
    const lifecycle = lifecycleState(currentStatus);
    selectedWorkflowStep = lifecycle.debtWasOpened || button.dataset.loanTab !== "borrow" ? "manage" : "borrow";
    syncWorkflowUi(currentStatus);
  });
});

portalButtons.forEach((button) => {
  button.addEventListener("click", () => setActivePortal(button.dataset.portalTab));
});

actionCards.forEach((card) => {
  card.addEventListener("click", () => setActiveActionCard(card.dataset.actionCard, { pinned: true }));
  card.addEventListener("focusin", () => setActiveActionCard(card.dataset.actionCard, { pinned: true }));
});

amountInputs.forEach((input) => {
  input.dataset.dirty = "false";
  syncAmountFieldState(input);
  input.addEventListener("focus", () => {
    input.closest(".amount-field")?.classList.add("is-active");
  });
  input.addEventListener("blur", () => {
    input.closest(".amount-field")?.classList.remove("is-active");
    syncAmountFieldState(input);
  });
  input.addEventListener("focus", () => {
    if (input.id === "borrowAmount") setLoanTab("borrow");
    if (input.id === "repayAmount") setLoanTab("repay");
    if (input.id === "withdrawAmount") setLoanTab("withdraw");
    setActiveActionCard(input.id === "bridgeAmount" ? "bridge" : input.id === "depositAmount" ? "activate" : "loan", { pinned: true });
  });
  input.addEventListener("input", () => {
    input.dataset.dirty = "true";
    syncAmountFieldState(input);
    refreshTransactionUi(currentStatus);
  });
});

amountFillButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const target = document.getElementById(button.dataset.fillTarget);
    if (!target) return;
    const state = financialState(currentStatus);
    const values = {
      borrowAvailable: state.availableBorrow,
      debt: Math.min(state.debt, state.bankB),
      voucher: state.voucher,
      withdrawable: state.withdrawable,
      shockTarget: numeric(currentStatus?.risk?.shockPreview?.collateralPrice),
      maxLiquidationRepay: numeric(currentStatus?.risk?.liquidationPreview?.repayAmount),
    };
    if (target.id === "borrowAmount") setLoanTab("borrow");
    if (target.id === "repayAmount") setLoanTab("repay");
    if (target.id === "withdrawAmount") setLoanTab("withdraw");
    setActiveActionCard(target.id === "bridgeAmount" ? "bridge" : target.id === "depositAmount" ? "activate" : "loan", { pinned: true });
    target.value = clamp(values[button.dataset.fillSource] ?? 0).toFixed(4).replace(/\.?0+$/, "") || "0";
    target.dataset.dirty = "true";
    syncAmountFieldState(target);
    refreshTransactionUi(currentStatus);
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  drawers.forEach((drawer) => {
    if (drawer.classList.contains("is-open")) closeDrawer(drawer.id);
  });
});

try {
  setFocusMode(sessionStorage.getItem(FOCUS_MODE_STORAGE_KEY) === "true");
} catch {
  setFocusMode(false);
}

try {
  setActivePortal(sessionStorage.getItem(PORTAL_STORAGE_KEY) || "borrower");
} catch {
  setActivePortal("borrower");
}

setLoanTab(currentLoanTab);
setActiveActionCard("bridge");
setupLinkyFallbacks();
setPrimaryLinkyVariant("wave");

refreshStatus()
  .then((status) => {
    currentStatus = status;
    applyActionAvailability(status);
  })
  .catch((error) => {
  markControllerOffline();
  setText("lastMessage", "Could not load local demo state.");
  setOutput(error.message);
  renderRoadmap();
  });
