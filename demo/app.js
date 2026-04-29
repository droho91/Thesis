import { markControllerOffline, renderLatestActivity, renderRoadmap, renderStatus, setText } from "./demo-status-view.js";

const buttons = [...document.querySelectorAll("button")];
const actionButtons = [...document.querySelectorAll("[data-action]")];
const deploySeedButton = document.getElementById("deploySeed");
const resetSeededButton = document.getElementById("resetSeeded");
const refreshButton = document.getElementById("refreshState");
const focusModeButton = document.getElementById("focusMode");
const openDemoToolsButton = document.getElementById("openDemoTools");
const openRuntimeOutputButton = document.getElementById("openRuntimeOutput");
const topUpRepayCashButton = document.getElementById("topUpRepayCashButton");
const primaryWorkflowCta = document.getElementById("primaryWorkflowCta");
const workflowPanelTitle = document.getElementById("workflowPanelTitle");
const workflowPanelStatus = document.getElementById("workflowPanelStatus");
const workflowSummaryCopy = document.getElementById("workflowSummaryCopy");
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
const ACTIVITY_STORAGE_KEY = "interchain-lending-latest-activity";
const FOCUS_MODE_STORAGE_KEY = "interchain-lending-focus-mode";
const PORTAL_STORAGE_KEY = "interchain-lending-active-portal";
const CLIENT_STATUS = ["Uninitialized", "Active", "Frozen", "Recovering"];
const SAFETY_MODE_ACTIONS = new Set(["recoverClient", "topUpRepayCash", "simulatePriceShock", "executeLiquidation"]);
const REPAY_CLOSE_BUFFER_BPS = 1;
const REPAY_CLOSE_MIN_BUFFER = 0.01;
const POSITION_EPSILON = 0.000001;
const AMOUNT_ACTIONS = {
  lock: { inputId: "bridgeAmount", unit: "aBANK" },
  borrow: { inputId: "borrowAmount", unit: "bCASH" },
  repay: { inputId: "repayAmount", unit: "bCASH" },
  withdrawCollateral: { inputId: "withdrawAmount", unit: "vA" },
  simulatePriceShock: { inputId: "shockPrice", unit: "bCASH/vA" },
  executeLiquidation: { inputId: "liquidationRepayAmount", unit: "bCASH" },
};
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
const ACTION_GUIDE = {
  deploySeed: {
    runningTitle: "Prepare Demo Account",
    currentAction: "Checking for an existing seeded Besu/QBFT runtime, then preparing contracts only if needed.",
    expectedVisibleChange: "The account moves to Ready, balances fill in, and borrower actions unlock.",
    nextAfterSuccess: "Open the Bank A to Bank B route, then lock aBANK collateral.",
    affectedPortal: "borrower",
    affectedMetrics: ["deploymentStatus", "bankABalance", "workflowStepConnect"],
    failureRecovery: "Start the local Besu runtime, then use Fresh Reset only if the saved deployment is stale.",
  },
  resetSeeded: {
    runningTitle: "Fresh Reset",
    currentAction: "Deliberately redeploying and reseeding the permissioned prototype baseline.",
    expectedVisibleChange: "Balances, policy, oracle, liquidity, and latest trace return to the clean seeded state.",
    nextAfterSuccess: "Begin the guided borrower flow from Open Bank A to Bank B Route.",
    affectedPortal: "borrower",
    affectedMetrics: ["deploymentStatus", "bankABalance", "bankBBalance", "poolLiquidity"],
    failureRecovery: "Check the runtime output, then rerun Fresh Reset before the live demo window.",
  },
  openRoute: {
    runningTitle: "Open Bank A to Bank B Route",
    currentAction: "Opening or reusing the proof-checked connection and channel between the two permissioned banks.",
    expectedVisibleChange: "The route timeline marks the channel ready and the bridge step remains ready for collateral.",
    nextAfterSuccess: "Lock aBANK on Bank A to create the forward packet.",
    affectedPortal: "borrower",
    affectedMetrics: ["routeEscrow", "routeHeader", "visualEscrowState", "deploymentStatus"],
    failureRecovery: "Retry the route step; use Fresh Reset only if the handshake was interrupted in an incompatible state.",
  },
  lock: {
    runningTitle: "Lock aBANK on Bank A",
    currentAction: "Submitting the source-chain escrow transaction and writing the forward packet commitment.",
    expectedVisibleChange: "Locked collateral and the Bank A packet sequence update after transaction confirmation.",
    nextAfterSuccess: "Receive voucher collateral on Bank B by verifying the forward proof.",
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
    runningTitle: "Receive Voucher on Bank B",
    currentAction: "Importing the needed Bank A header if needed, generating a storage proof, and submitting the receive proof on Bank B.",
    expectedVisibleChange: "Voucher balance appears on Bank B and packet receipt/proof status changes to verified.",
    nextAfterSuccess: "Deposit the voucher as collateral in the Bank B lending pool.",
    affectedPortal: "borrower",
    affectedMetrics: ["voucherBalance", "proofVerificationResult", "proofReceiptStatus", "routeProof"],
    failureRecovery: "If proof state is unavailable, wait for a fresh block and retry the receive-voucher action.",
  },
  depositCollateral: {
    runningTitle: "Deposit Voucher Collateral",
    currentAction: "Approving the voucher and depositing it into the Bank B lending pool.",
    expectedVisibleChange: "Pool collateral increases and available borrowing power becomes visible.",
    nextAfterSuccess: "Borrow bCASH within the displayed available limit.",
    affectedPortal: "borrower",
    affectedMetrics: ["poolCollateral", "availableBorrowHero", "riskCollateralValue", "workflowStepActivate"],
    failureRecovery: "Receive voucher collateral first, then retry the deposit.",
  },
  borrow: {
    runningTitle: "Borrow bCASH",
    currentAction: "Submitting a borrow transaction bounded by policy, liquidity, and oracle valuation.",
    expectedVisibleChange: "Current debt and Bank B bCASH balance increase; health factor decreases but remains visible.",
    nextAfterSuccess: "Repay debt, withdraw safe collateral, or monitor health in Risk Admin.",
    affectedPortal: "borrower",
    affectedMetrics: ["currentDebtHero", "bankBBalance", "poolDebt", "healthFactorHero", "scenarioHealthyStatus"],
    failureRecovery: "Use an amount within available borrowing power and market liquidity.",
  },
  repay: {
    runningTitle: "Repay Debt",
    currentAction: "Approving bCASH and reducing the borrower debt balance.",
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
    nextAfterSuccess: "Repay bCASH debt from the borrower portal.",
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
    runningTitle: "Simulate Oracle Shock",
    currentAction: "Submitting a governed demo oracle update for the voucher collateral price.",
    expectedVisibleChange: "Oracle price, health factor, and liquidation eligibility update in Risk Admin.",
    nextAfterSuccess: "Execute liquidation if the account is now below the liquidation threshold.",
    affectedPortal: "risk",
    affectedMetrics: ["riskOracleCollateralPrice", "riskCurrentPriceInline", "riskHealthFactor", "riskHealthAfterShock", "riskLiquidatableState"],
    failureRecovery: "Choose a positive price, usually below the current collateral price, then retry.",
  },
  executeLiquidation: {
    runningTitle: "Execute Liquidation",
    currentAction: "The authorized liquidator repays debt, seizes voucher collateral, and records reserves or bad debt.",
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
    failureRecovery: "Execute liquidation first so the authorized liquidator holds seized voucher collateral.",
  },
  replayForward: {
    runningTitle: "Attempt Replay",
    currentAction: "Submitting an already received forward packet proof to demonstrate replay rejection.",
    expectedVisibleChange: "Replay protection changes to blocked while the original receipt remains consumed once.",
    nextAfterSuccess: "Use the proof inspector to review the packet receipt that prevents duplicate execution.",
    affectedPortal: "technical",
    affectedMetrics: ["proofReplayStatus", "replayBlockedState", "proofReceiptStatus", "forwardConsumedState"],
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
    runningTitle: "Run Risk/Liquidation Lifecycle",
    currentAction: "Running the scripted route, proof, borrow, oracle shock, liquidation, timeout, and settlement path.",
    expectedVisibleChange: "Scenario cards, risk metrics, proof lifecycle, and settlement evidence update as the script advances.",
    nextAfterSuccess: "Review Risk Admin and Technical / Thesis evidence for defense discussion.",
    affectedPortal: "scenarios",
    affectedMetrics: ["scenarioLiquidationStatus", "riskSettlementStatus", "proofStatusChip", "portalChangeBanner"],
    failureRecovery: "Use Fresh Reset deliberately before rerunning the scenario if it stopped mid-lifecycle.",
  },
  borrowerCloseout: {
    runningTitle: "Run Borrower Closeout Lifecycle",
    currentAction: "Running the borrower path from bridge through borrow, repay, withdraw, burn, and reverse unlock.",
    expectedVisibleChange: "Borrower journey, reverse proof status, and source collateral balance move to closeout complete.",
    nextAfterSuccess: "Review the proof inspector for the completed reverse unlock evidence.",
    affectedPortal: "scenarios",
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

function setBusy(busy) {
  document.body.classList.toggle("is-busy", busy);
  buttons.forEach((button) => {
    if (!button.dataset.originalText) button.dataset.originalText = button.textContent;
    button.disabled = busy;
    button.classList.toggle("is-loading", busy && button === currentRunningAction?.button);
    button.classList.toggle("is-waiting", busy && button !== currentRunningAction?.button);
    if (busy && button === currentRunningAction?.button) {
      button.textContent = "Running...";
      button.title = currentRunningAction?.guide?.currentAction || "Action is running.";
    } else if (busy) {
      button.title = currentRunningAction
        ? `Waiting for ${currentRunningAction.guide.runningTitle}. ${currentRunningAction.guide.expectedVisibleChange}`
        : "Waiting for the current demo action to finish.";
    } else {
      button.textContent = button.dataset.originalText;
      button.classList.remove("is-loading", "is-waiting");
      if (!button.dataset.action) button.title = "";
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

function isTechnicalAction(action) {
  return [
    "finalizeForwardHeader",
    "updateForwardClient",
    "finalizeReverseHeader",
    "updateReverseClient",
    "freezeClient",
    "recoverClient",
    "replayForward",
    "executeTimeoutRefund",
    "verifyTimeoutAbsence",
  ].includes(action);
}

function applyActionAvailability(status) {
  const locked = safetyLocked(status);
  actionButtons.forEach((button) => {
    const allowed = !locked || SAFETY_MODE_ACTIONS.has(button.dataset.action);
    button.disabled = !allowed;
    button.title = allowed
      ? ""
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
  if (lifecycle.returnStarted || lifecycle.freeVoucher || reverse.commitHeight || reverse.packetId || reverse.receiveTxHash) return "redeem";
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

function setPrimaryGuideVisible(visible) {
  const guide = document.getElementById("primaryActionGuide");
  if (guide) guide.hidden = !visible;
}

function renderPrimaryGuide(actionState) {
  const guide = actionState?.guide;
  if (!guide) {
    setPrimaryGuideVisible(false);
    return;
  }
  const prefix =
    actionState.phase === "failed"
      ? "Failed"
      : actionState.phase === "success"
        ? "Completed"
        : "Running";
  setPrimaryGuideVisible(true);
  setText("primaryActionTitle", `${prefix}: ${guide.runningTitle}`);
  setText("primaryActionDescription", guide.currentAction);
  setText("primaryGuideCurrent", guide.currentAction);
  setText("primaryGuideExpected", guide.expectedVisibleChange);
  setText("primaryGuideNext", actionState.phase === "failed" ? guide.failureRecovery : guide.nextAfterSuccess);
  const elapsed = actionState.startedAtMs ? Math.max(0, Math.round((Date.now() - actionState.startedAtMs) / 1000)) : 0;
  const controller = actionState.controller;
  const controllerCopy =
    controller?.label
      ? `Controller: ${controller.label} / ${controller.elapsedSeconds ?? elapsed}s elapsed.`
      : actionState.phase === "running"
        ? `Controller submitted / ${elapsed}s elapsed. Waiting for tx confirmation, proof generation, or status refresh.`
        : actionState.phase === "failed"
          ? "Action stopped before the expected state change completed."
          : "Action completed; visible state has been refreshed.";
  setText("primaryGuideController", controllerCopy);
  setText("primaryActionHint", actionState.phase === "failed" ? guide.failureRecovery : guide.nextAfterSuccess);
  if (primaryWorkflowCta) {
    primaryWorkflowCta.disabled = actionState.phase === "running";
    primaryWorkflowCta.textContent = actionState.phase === "failed" ? "Review Recovery Step" : guide.runningTitle;
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
  if (!forward.finalizedHeight && !forward.trustedHeight) return "finalizeForwardHeader";
  const trustReady =
    Boolean(forward.trustedHeight) ||
    heightAtLeast(progress.trustedAOnB, forward.commitHeight) ||
    heightAtLeast(forward.trustedHeight, forward.commitHeight);
  return trustReady ? "proveForwardMint" : "updateForwardClient";
}

function reverseProofAction(status) {
  const reverse = status?.trace?.reverse || {};
  const progress = status?.progress || {};
  if (!reverse.packetId && !reverse.commitHeight) return "burn";
  if (reverse.receiveTxHash || status?.security?.reverseConsumed) return null;
  if (!reverse.finalizedHeight && !reverse.trustedHeight) return "finalizeReverseHeader";
  const trustReady =
    Boolean(reverse.trustedHeight) ||
    heightAtLeast(progress.trustedBOnA, reverse.commitHeight) ||
    heightAtLeast(reverse.trustedHeight, reverse.commitHeight);
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
  const reverseStarted = Boolean(reverse.packetId || reverse.commitHeight || reverse.sourceTxHash);
  const settlementStarted = Boolean(
    settlement.started ||
      settlementTrace.packetId ||
      settlementTrace.burnTxHash ||
      reverse.settlementMode === "authorized-liquidator"
  );
  const settlementUnlocked = Boolean(settlement.unlocked || settlementTrace.unlockTxHash);
  const borrowerReverseStarted = reverseStarted && !settlementStarted;
  const borrowerReverseComplete = Boolean(borrowerReverseStarted && (reverse.receiveTxHash || status?.security?.reverseConsumed));
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

function workflowModel(status) {
  const state = financialState(status);
  const lifecycle = lifecycleState(status);
  const forward = status?.trace?.forward || {};
  const health = healthFromStatus(status);
  const deployed = state.deployed;
  const bridgeStarted =
    state.escrow > 0 ||
    Boolean(forward.commitHeight || forward.packetId || forward.receiveTxHash) ||
    state.voucher > 0 ||
    state.collateral > 0 ||
    state.debt > 0 ||
    lifecycle.returnStarted ||
    lifecycle.liquidationExecuted;
  const voucherReady = state.voucher > 0;
  const collateralActive = lifecycle.activeCollateral;
  const debtActive = lifecycle.activeDebt;
  const elevatedRisk = debtActive && ["Watch", "Danger", "Liquidatable"].includes(health.status);
  const locked = safetyLocked(status);
  const reverseAction = reverseProofAction(status);

  const steps = {
    connect: { complete: deployed, unlocked: true, label: deployed ? "Ready" : "Prepare account" },
    bridge: {
      complete: voucherReady || collateralActive || debtActive,
      unlocked: deployed,
      label: voucherReady || collateralActive || debtActive ? "Complete" : bridgeStarted ? "In progress" : "Ready",
    },
    activate: {
      complete: lifecycle.collateralWasDeposited || lifecycle.returnStarted || lifecycle.liquidationExecuted,
      unlocked: voucherReady || collateralActive || debtActive || lifecycle.returnStarted,
      label: lifecycle.collateralWasDeposited || lifecycle.returnStarted ? "Active" : voucherReady ? "Ready" : "Locked",
    },
    borrow: {
      complete: lifecycle.debtWasOpened || lifecycle.liquidationExecuted,
      unlocked: collateralActive || debtActive || lifecycle.debtWasOpened,
      label: lifecycle.debtWasOpened ? "Used" : collateralActive ? "Ready" : "Locked",
    },
    manage: {
      complete: lifecycle.borrowerCollateralWithdrawn || lifecycle.liquidationExecuted,
      unlocked: debtActive || (lifecycle.debtWasOpened && collateralActive) || lifecycle.liquidationExecuted,
      label: debtActive
        ? elevatedRisk
          ? "Needs attention"
          : "Active"
        : lifecycle.borrowerCollateralWithdrawn
          ? "Withdrawn"
          : lifecycle.debtWasOpened && collateralActive
            ? "Ready"
            : lifecycle.liquidationExecuted
              ? "Risk path"
              : "Locked",
    },
    return: {
      complete: lifecycle.returnComplete,
      unlocked:
        lifecycle.freeVoucher ||
        lifecycle.returnStarted ||
        lifecycle.settlementVoucher ||
        lifecycle.liquidationExecuted ||
        lifecycle.borrowerCollateralWithdrawn,
      label: lifecycle.returnComplete
        ? "Complete"
        : lifecycle.returnStarted
          ? "Proof pending"
          : lifecycle.settlementVoucher
            ? "Settle"
            : lifecycle.freeVoucher
              ? "Ready"
              : "Locked",
    },
  };

  if (!deployed) {
    return {
      step: "connect",
      title: "Prepare demo account",
      status: "Start here",
      summary: "Prepare the local Besu runtime and demo borrower before collateral transfer and borrowing actions.",
      cta: { type: "deploySeed", label: "Prepare Demo Account" },
      description: "Prepare the borrower account and reuse an existing seeded runtime when available.",
      hint: "Later steps stay locked until the demo account is ready.",
      steps,
      risk: "waiting",
    };
  }

  if (locked) {
    return {
      step: "manage",
      title: "Recover account safety",
      status: "Safety mode",
      summary: "Safety controls are active. Recover the account before continuing lending actions.",
      cta: { type: "action", action: "recoverClient", label: "Recover Account" },
      description: "Resolve the safety state before making position changes.",
      hint: "Collateral and borrowing actions are paused while recovery is active.",
      steps,
      risk: "risk",
    };
  }

  if (lifecycle.liquidationExecuted) {
    if (lifecycle.settlementVoucher && !lifecycle.settlementStarted) {
      return {
        step: "return",
        title: "Settle seized collateral",
        status: "Liquidation executed",
        summary: "The authorized liquidator now holds seized voucher collateral. Settle it through the reverse bridge route.",
        cta: { type: "action", action: "settleSeizedVoucher", label: "Settle Seized Voucher" },
        description: "Burn the seized voucher and commit a settlement packet for the origin collateral.",
        hint: `${formatAmount(status?.risk?.settlement?.seizedVoucherBalance || status?.balances?.liquidatorVoucher, "vA")} held by the authorized liquidator.`,
        steps,
        risk: "risk",
      };
    }
    if (lifecycle.settlementStarted && !lifecycle.settlementUnlocked) {
      return {
        step: "return",
        title: "Complete liquidator settlement",
        status: "Proof pending",
        summary: "The settlement packet exists on Bank B. Complete the reverse proof so Bank A releases origin collateral.",
        cta: { type: "action", action: reverseAction || "proveReverseUnlock", label: "Verify reverse proof and unlock aBANK on Bank A" },
        description: "Import the needed Bank B header if necessary, then verify the reverse packet proof and unlock origin collateral.",
        hint: "This remains script-assisted for proof generation, while the contracts verify packet execution.",
        steps,
        risk: "risk",
      };
    }
    return {
      step: "return",
      title: "Risk settlement complete",
      status: lifecycle.settlementUnlocked ? "Settled" : "Liquidation path",
      summary: "The liquidation branch has reached settlement. Use Risk Admin to inspect remaining debt, bad debt, reserves, and origin unlock status.",
      cta: { type: "portal", portal: "risk", label: "Review Risk Admin" },
      description: "Review the liquidation accounting and seized-voucher settlement evidence.",
      hint: lifecycle.settlementUnlocked ? "Origin collateral for the liquidator has been unlocked on Bank A." : "No seized voucher is waiting for settlement.",
      steps,
      risk: "risk",
    };
  }

  if (!bridgeStarted && !voucherReady && !collateralActive && !debtActive) {
    return {
      step: "bridge",
      title: "Bridge collateral",
      status: "Ready",
      summary: "Move source-bank collateral into this lending account to begin borrowing.",
      cta: {
        type: "action",
        action: routeReady(status) ? "lock" : "openRoute",
        label: routeReady(status) ? "Lock aBANK on Bank A" : "Open Bank A to Bank B route",
      },
      description: routeReady(status)
        ? "Choose an amount and lock aBANK into Bank A escrow."
        : "Open the permissioned route before locking collateral.",
      hint: `${formatAmount(state.bankA, "aBANK")} available on Bank A.`,
      steps,
      risk: "safe",
    };
  }

  if (bridgeStarted && !voucherReady && !collateralActive && !debtActive && !lifecycle.returnStarted) {
    return {
      step: "bridge",
      title: "Bridge in progress",
      status: "In progress",
      summary: "Your collateral transfer is being checked. Continue once to make it usable for borrowing.",
      cta: { type: "action", action: bridgeProofAction(status), label: "Receive voucher collateral on Bank B" },
      description: "Verify the forward packet proof so the transferred collateral becomes a Bank B voucher.",
      hint: "The controller may import a header or generate a storage proof before the voucher appears.",
      steps,
      risk: "waiting",
    };
  }

  if (lifecycle.debtWasOpened && !debtActive && collateralActive) {
    return {
      step: "manage",
      title: "Withdraw collateral",
      status: "Debt closed",
      summary: "Debt is closed. The next borrower-side step is to withdraw voucher collateral from the lending pool.",
      cta: { type: "action", action: "withdrawCollateral", label: "Withdraw Collateral" },
      description: "Release deposited voucher collateral back to your Bank B wallet before returning it to Bank A.",
      hint: `${formatAmount(state.withdrawable, "vA")} currently withdrawable.`,
      steps,
      risk: "safe",
    };
  }

  if (lifecycle.borrowerCollateralWithdrawn && lifecycle.freeVoucher && !lifecycle.borrowerReverseStarted) {
    return {
      step: "return",
      title: "Return collateral to Bank A",
      status: "Ready",
      summary: "Your voucher collateral is back in the Bank B wallet. Burn it and commit a reverse packet for source-bank unlock.",
      cta: { type: "action", action: "burn", label: "Burn voucher and start Bank A unlock" },
      description: "Burn voucher collateral on Bank B and create the reverse settlement packet.",
      hint: `${formatAmount(state.voucher, "vA")} free voucher available to return.`,
      steps,
      risk: "safe",
    };
  }

  if (voucherReady && !collateralActive && !debtActive && !lifecycle.borrowerCollateralWithdrawn && !lifecycle.debtWasOpened) {
    return {
      step: "activate",
      title: "Activate collateral",
      status: "Ready",
      summary: "Your collateral is available. Activate it to unlock borrowing power.",
      cta: { type: "action", action: "depositCollateral", label: "Deposit voucher collateral" },
      description: "Deposit available collateral into the lending account.",
      hint: `${formatAmount(state.voucher, "vA")} available to activate.`,
      steps,
      risk: "safe",
    };
  }

  if (lifecycle.borrowerReverseStarted && !lifecycle.borrowerReverseComplete) {
    return {
      step: "return",
      title: "Complete collateral release",
      status: "Proof pending",
      summary: "The reverse packet has been committed. Complete proof verification so Bank A unlocks the origin collateral.",
      cta: { type: "action", action: reverseAction || "proveReverseUnlock", label: "Verify reverse proof and unlock aBANK on Bank A" },
      description: "Import the needed Bank B header if necessary, then verify the reverse packet proof and release origin collateral.",
      hint: "Header relay and proof generation are script-assisted; unlock execution is contract-verified.",
      steps,
      risk: "safe",
    };
  }

  if (lifecycle.borrowerReverseComplete) {
    return {
      step: "return",
      title: "Collateral returned",
      status: "Complete",
      summary: "The borrower closeout path is complete: debt repaid, collateral withdrawn, voucher burned, and origin collateral unlocked.",
      cta: { type: "portal", portal: "technical", label: "Review Proof" },
      description: "Inspect the proof and packet evidence behind the completed return path.",
      hint: "The account can start another borrow cycle, but the guided closeout lifecycle is complete.",
      steps,
      risk: "safe",
    };
  }

  if (collateralActive && !debtActive) {
    return {
      step: "borrow",
      title: "Borrow stablecoin",
      status: "Ready",
      summary: "Collateral is active. Borrow within your available limit while keeping a healthy buffer.",
      cta: { type: "action", action: "borrow", label: "Borrow bCASH" },
      description: "Choose an amount within your current borrowing power.",
      hint: `${formatAmount(state.availableBorrow, "bCASH")} available to borrow.`,
      steps,
      risk: "safe",
    };
  }

  const manageAction = currentLoanTab === "withdraw" ? "withdrawCollateral" : "repay";
  return {
    step: "manage",
    title: elevatedRisk ? "Repay debt to improve health" : "Repay debt or withdraw safe collateral",
    status: elevatedRisk ? health.status : "Debt active",
    summary: elevatedRisk
      ? "Your health factor needs attention. Repaying debt is the clearest way to improve safety."
      : "Your loan is active. Repay, monitor safety, or withdraw only if the position remains healthy.",
    cta: {
      type: "action",
      action: elevatedRisk ? "repay" : manageAction,
      label: elevatedRisk ? "Repay debt to improve health" : currentLoanTab === "withdraw" ? "Withdraw safe collateral" : "Repay bCASH debt",
    },
    description: elevatedRisk ? "Repay bCASH to improve your health factor." : "Choose repay to reduce debt or withdraw only the amount that keeps health safe.",
    hint: `${formatAmount(state.debt, "bCASH")} debt outstanding.`,
    steps,
    risk: elevatedRisk ? "risk" : "safe",
  };
}

function actionAllowedByWorkflow(action, model) {
  if (!action) return true;
  if (model.cta?.action === action) return true;
  if (isTechnicalAction(action)) return true;
  return action === "fullFlow" || action === "burn" || action === "settleSeizedVoucher" || action === "proveReverseUnlock";
}

function syncWorkflowUi(status = currentStatus) {
  const model = workflowModel(status);
  const selectedStep = selectedWorkflowStep && model.steps[selectedWorkflowStep]?.unlocked ? selectedWorkflowStep : model.step;
  const reviewingPastStep = selectedStep !== model.step;
  currentWorkflowAction = reviewingPastStep
    ? { type: "return", label: "Return to Next Step" }
    : model.cta;

  document.body.dataset.workflowStep = selectedStep;
  document.body.dataset.workflowRisk = model.risk;
  setText("workflowPanelTitle", reviewingPastStep ? "Review previous step" : model.title);
  setText("workflowPanelStatus", reviewingPastStep ? "Review" : model.status);
  setText("workflowSummaryCopy", model.summary);
  if (currentRunningAction) {
    renderPrimaryGuide(currentRunningAction);
  } else {
    setPrimaryGuideVisible(false);
    setText("primaryActionTitle", reviewingPastStep ? "Continue workflow" : model.title);
    setText("primaryActionDescription", reviewingPastStep ? "Return to the recommended next step to continue." : model.description);
    setText("primaryActionHint", reviewingPastStep ? "Completed steps are available for review only." : model.hint);
  }
  if (primaryWorkflowCta && !currentRunningAction) {
    const primaryValidation =
      currentWorkflowAction?.type === "action" && AMOUNT_ACTIONS[currentWorkflowAction.action]
        ? validateAmountAction(currentWorkflowAction.action, status)
        : { ok: true, message: "" };
    primaryWorkflowCta.textContent = currentWorkflowAction?.label || "Continue";
    primaryWorkflowCta.disabled = document.body.classList.contains("is-busy") || !primaryValidation.ok;
    primaryWorkflowCta.title = primaryValidation.ok ? "" : primaryValidation.message;
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
    button.disabled = !stepState.unlocked;
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
    panel.classList.toggle("is-active", active);
    panel.hidden = !active;
  });

  for (const button of actionButtons) {
    const action = button.dataset.action;
    const inMainWorkflow = Boolean(button.closest(".workflow-main"));
    const allowed = actionAllowedByWorkflow(action, model);
    button.classList.toggle("is-current-action", action === currentWorkflowAction?.action);
    if (inMainWorkflow) {
      button.hidden = true;
    }
    if (
      !allowed &&
      !button.closest(".surface-drawer") &&
      !button.closest(".portal-risk") &&
      !button.closest(".portal-technical") &&
      !button.closest(".portal-scenarios")
    ) {
      button.disabled = true;
      button.title = "Complete the current step before using this action.";
    }
  }

  deploySeedButton?.toggleAttribute("hidden", true);
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

function setValidation(id, message = "", severity = "") {
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = message;
  node.classList.toggle("is-warning", severity === "warning");
  node.classList.toggle("is-error", severity === "error");
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

function validateAmountAction(action, status = currentStatus) {
  const state = financialState(status);
  const risk = status?.risk || {};
  const inputId = AMOUNT_ACTIONS[action]?.inputId;
  const amount = inputId ? inputValue(inputId) : 0;
  if (!AMOUNT_ACTIONS[action]) return { ok: true, amount };
  if (!state.deployed) return { ok: false, amount, message: "Prepare the demo account before submitting." };
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

function updateAmountActionAvailability(status) {
  const locked = safetyLocked(status);
  for (const button of actionButtons) {
    const action = button.dataset.action;
    if (!AMOUNT_ACTIONS[action]) continue;
    const safetyAllowed = !locked || SAFETY_MODE_ACTIONS.has(action);
    const validation = validateAmountAction(action, status);
    button.disabled = !safetyAllowed || !validation.ok;
    button.title = safetyAllowed
      ? validation.ok
        ? ""
        : validation.message
      : "Safety mode is active. Recover the light client before running interchain actions.";
  }
  const settlement = status?.risk?.settlement || {};
  const settlementVoucher = numeric(settlement.seizedVoucherBalance);
  for (const button of actionButtons.filter((node) => node.dataset.action === "settleSeizedVoucher")) {
    const allowed = !locked && settlementVoucher > 0 && !settlement.started;
    button.disabled = !allowed;
    button.title = locked
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
      ? `${formatAmount(state.voucher, "vA")} available to activate.`
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

  for (const [action, field] of Object.entries({
    lock: "bridgeValidation",
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

  updateAmountActionAvailability(status);
  if (!actionCardPinned) setActiveActionCard(suggestActionCard(status));
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
    replayBlocked: status.security?.replayBlocked
      ? `blocked${status.security?.replayProofHeight ? ` @ ${status.security.replayProofHeight}` : ""}`
      : "pending",
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
  replayBlocked: "Replay protection",
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
  replayBlocked: ["proofReplayStatus", "replayBlockedState"],
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
    openRoute: "Prepared collateral route",
    lock: "Started collateral transfer",
    finalizeForwardHeader: "Checked source-bank confirmation",
    updateForwardClient: "Confirmed collateral transfer",
    proveForwardMint: "Made collateral available",
    depositCollateral: "Activated collateral",
    borrow: "Borrowed bCASH",
    repay: "Repaid debt",
    topUpRepayCash: "Added demo bCASH",
    withdrawCollateral: "Withdrew collateral",
    simulatePriceShock: "Simulated oracle shock",
    executeLiquidation: "Executed liquidation",
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
    borrowerCloseout: "Completed borrower closeout lifecycle",
    deploySeed: "Prepared demo account",
    resetSeeded: "Reset account baseline",
    refresh: "Refreshed account state",
  };
  return titles[action] || action;
}

function persistActivity(activity) {
  try {
    sessionStorage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify(activity));
  } catch {}
}

function loadPersistedActivity() {
  try {
    const raw = sessionStorage.getItem(ACTIVITY_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function renderPortalChanges(action, activity, guide = guideForAction(action)) {
  const banner = document.getElementById("portalChangeBanner");
  const list = document.getElementById("portalChangeList");
  if (!banner || !list || !activity) return;
  banner.hidden = false;
  banner.classList.remove("is-failed");
  banner.classList.add("is-visible");
  setText("portalChangeScope", `What changed / ${guide.affectedPortal}`);
  setText("portalChangeTitle", activity.title);
  setText("portalChangeSummary", activity.summary || guide.expectedVisibleChange);
  list.innerHTML = "";
  const changes = activity.changes?.length ? activity.changes : [{ value: guide.expectedVisibleChange }];
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

function renderPortalFailure(action, error, guide = guideForAction(action)) {
  const banner = document.getElementById("portalChangeBanner");
  const list = document.getElementById("portalChangeList");
  if (!banner || !list) return;
  banner.hidden = false;
  banner.classList.add("is-visible", "is-failed");
  setText("portalChangeScope", `Recovery / ${guide.affectedPortal}`);
  setText("portalChangeTitle", `${guide.runningTitle} failed`);
  setText("portalChangeSummary", error?.message || "The action failed before the expected visible change completed.");
  list.innerHTML = "";
  const li = document.createElement("li");
  li.textContent = guide.failureRecovery;
  list.appendChild(li);
}

function activityFromStatus(status) {
  const operation = status?.trace?.latestOperation;
  if (!operation) return null;
  return {
    title: operation.label || "Latest demo operation",
    summary: operation.summary || "The latest trace was loaded from the local demo run output.",
    time: status.trace?.generatedAt,
    timeLabel: formatClock(status.trace?.generatedAt),
    changes: [{ value: operation.phase ? `phase: ${operation.phase}` : "Trace loaded from the latest demo run." }],
  };
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
  persistActivity(activity);
  renderLatestActivity(activity);
  renderPortalChanges(action, activity);
  const changedIds = changes.flatMap((change) => FACT_ELEMENT_IDS[change.key] || []);
  highlightNodeIds([...new Set([...changedIds, ...(guideForAction(action).affectedMetrics || [])])], "success");
  return activity;
}

function pushFailedActivity(action, error) {
  const summary = error?.message || "The action failed before any contract state changed.";
  const activity = {
    title: `${actionTitle(action)} failed`,
    summary,
    time: new Date().toISOString(),
    timeLabel: formatClock(new Date().toISOString()),
    changes: [{ value: "No state change was committed." }],
  };
  persistActivity(activity);
  renderLatestActivity(activity);
  renderPortalFailure(action, error);
  return activity;
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
    throw error;
  }
  return payload;
}

async function refreshStatus() {
  const status = await requestJson("/api/status");
  renderStatus(status);
  applyActionAvailability(status);
  refreshTransactionUi(status);
  return status;
}

function updateRunningController(status) {
  if (!currentRunningAction) return;
  currentRunningAction.controller = status?.controller?.activeOperation || null;
  renderPrimaryGuide(currentRunningAction);
  const label = currentRunningAction.controller?.label || currentRunningAction.guide.runningTitle;
  const elapsed = currentRunningAction.controller?.elapsedSeconds ?? Math.round((Date.now() - currentRunningAction.startedAtMs) / 1000);
  setText("lastMessage", `Running ${label} for ${elapsed}s. Waiting for tx confirmation, proof generation, or status refresh if needed.`);
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
      currentStatus = status;
      renderStatus(status);
      setScenarioCardState(activeScenarioCard, "running", "Running");
      updateRunningController(status);
    } catch (error) {
      setText("primaryGuideController", `Status refresh is waiting: ${error.message}`);
    }
  }, 1500);
}

function beginActionUi(action, button = null) {
  const guide = guideForAction(action);
  currentRunningAction = {
    action,
    guide,
    button,
    phase: "running",
    startedAtMs: Date.now(),
    controller: null,
  };
  activeScenarioCard = scenarioCardForButton(button) || (button?.closest(".portal-scenarios") ? scenarioCardForAction(action) : null);
  setScenarioCardState(activeScenarioCard, "running", "Running");
  document.body.dataset.runningAction = action;
  document.body.dataset.actionPortal = guide.affectedPortal;
  setText("lastMessage", `Running ${guide.runningTitle}. Waiting for tx confirmation, proof generation, or status refresh if needed.`);
  setOutput(`${guide.currentAction}\n\nExpected visible change: ${guide.expectedVisibleChange}\nNext after success: ${guide.nextAfterSuccess}`);
  renderPrimaryGuide(currentRunningAction);
  highlightNodeIds(guide.affectedMetrics, "running");
  setBusy(true);
  startActionPolling();
}

function completeActionUi(action, ok, error = null) {
  stopActionPolling();
  if (!currentRunningAction || currentRunningAction.action !== action) return;
  currentRunningAction.phase = ok ? "success" : "failed";
  currentRunningAction.controller = null;
  renderPrimaryGuide(currentRunningAction);
  setScenarioCardState(activeScenarioCard, ok ? "success" : "failed", ok ? "Success" : "Failed");
  if (!ok) {
    renderPortalFailure(action, error, currentRunningAction.guide);
    highlightNodeIds(currentRunningAction.guide.affectedMetrics, "running");
  } else {
    window.setTimeout(() => {
      if (currentRunningAction?.action === action && currentRunningAction.phase === "success") {
        clearPrimaryGuide();
      }
    }, 3500);
  }
  delete document.body.dataset.runningAction;
  delete document.body.dataset.actionPortal;
}

async function runDeploySeed(button = deploySeedButton) {
  beginActionUi("deploySeed", button);
  try {
    const payload = await requestJson("/api/deploy-seed", { method: "POST" });
    actionCardPinned = false;
    setLoanTab("borrow");
    renderStatus(payload.status);
    refreshTransactionUi(payload.status, { forceDefaults: true });
    pushActivity("deploySeed", "The interchain lending runtime is ready for live demo actions.", payload.status);
    currentStatus = payload.status;
    selectedWorkflowStep = null;
    syncWorkflowUi(currentStatus);
    completeActionUi("deploySeed", true);
    setText("lastMessage", "Demo runtime ready.");
    setOutput(payload.output);
  } catch (error) {
    completeActionUi("deploySeed", false, error);
    setText("lastMessage", error.statusCode === 409 ? "Controller is busy." : "Prepare Demo Account failed.");
    setOutput(error.message);
    pushFailedActivity("deploySeed", error);
  } finally {
    setBusy(false);
  }
}

async function runResetSeeded() {
  beginActionUi("resetSeeded", resetSeededButton);
  try {
    const payload = await requestJson("/api/reset-seeded", { method: "POST" });
    actionCardPinned = false;
    setLoanTab("borrow");
    renderStatus(payload.status);
    refreshTransactionUi(payload.status, { forceDefaults: true });
    pushActivity("resetSeeded", "A fresh interchain lending runtime was deployed and seeded for a clean demo baseline.", payload.status);
    currentStatus = payload.status;
    selectedWorkflowStep = null;
    syncWorkflowUi(currentStatus);
    completeActionUi("resetSeeded", true);
    setText("lastMessage", "Fresh reset complete.");
    setOutput(payload.output);
  } catch (error) {
    completeActionUi("resetSeeded", false, error);
    setText("lastMessage", error.statusCode === 409 ? "Controller is busy." : "Fresh Reset failed.");
    setOutput(error.message);
    pushFailedActivity("resetSeeded", error);
  } finally {
    setBusy(false);
  }
}

function amountPayloadForAction(action) {
  const config = AMOUNT_ACTIONS[action];
  if (!config) return {};
  const validation = validateAmountAction(action);
  if (!validation.ok) {
    setValidation(
      {
        lock: "bridgeValidation",
        borrow: "borrowValidation",
        repay: "repayValidation",
        withdrawCollateral: "withdrawValidation",
        simulatePriceShock: "shockValidation",
        executeLiquidation: "liquidationValidation",
      }[action],
      validation.message,
      "error"
    );
    throw new Error(validation.message);
  }
  return { amount: String(validation.amount) };
}

async function runAction(action, { button = null } = {}) {
  if (LOAN_TAB_BY_ACTION[action]) setLoanTab(LOAN_TAB_BY_ACTION[action]);
  setActiveActionCard(ACTION_CARD_BY_ACTION[action] || suggestActionCard(currentStatus), { pinned: true });
  let requestBody;
  try {
    requestBody = { action, ...amountPayloadForAction(action) };
  } catch (error) {
    setText("lastMessage", error.message);
    return;
  }
  const title = actionTitle(action);
  beginActionUi(action, button);
  if (requestBody.amount) {
    setOutput(
      `${guideForAction(action).currentAction}\n\nAmount: ${requestBody.amount} ${AMOUNT_ACTIONS[action]?.unit || ""}\nExpected visible change: ${guideForAction(action).expectedVisibleChange}`
    );
  }
  try {
    const payload = await requestJson("/api/action", {
      method: "POST",
      body: JSON.stringify(requestBody),
    });
    renderStatus(payload.status);
    refreshTransactionUi(payload.status, { forceDefaults: true });
    pushActivity(action, payload.message, payload.status);
    currentStatus = payload.status;
    selectedWorkflowStep = null;
    syncWorkflowUi(currentStatus);
    completeActionUi(action, true);
    setText("lastMessage", payload.message);
    setOutput(payload.output || payload.message);
  } catch (error) {
    completeActionUi(action, false, error);
    setText("lastMessage", error.statusCode === 409 ? "Controller is busy." : `${title} failed.`);
    setOutput(error.message);
    pushFailedActivity(action, error);
  } finally {
    setBusy(false);
  }
}

async function runPrimaryWorkflowAction() {
  if (currentRunningAction && currentRunningAction.phase !== "running") {
    clearPrimaryGuide();
    return;
  }
  if (currentWorkflowAction?.type === "return") {
    selectedWorkflowStep = null;
    syncWorkflowUi(currentStatus);
    return;
  }
  if (currentWorkflowAction?.type === "portal") {
    setActivePortal(currentWorkflowAction.portal);
    return;
  }
  if (currentWorkflowAction?.type === "deploySeed") {
    await runDeploySeed(primaryWorkflowCta);
    return;
  }
  if (currentWorkflowAction?.type === "action" && currentWorkflowAction.action) {
    await runAction(currentWorkflowAction.action, { button: primaryWorkflowCta });
  }
}

primaryWorkflowCta?.addEventListener("click", runPrimaryWorkflowAction);
deploySeedButton?.addEventListener("click", () => runDeploySeed(deploySeedButton));
resetSeededButton?.addEventListener("click", runResetSeeded);
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
  if (currentRunningAction && currentRunningAction.phase !== "running") clearPrimaryGuide();
  setBusy(true);
  try {
    const status = await refreshStatus();
    pushActivity("refresh", "The UI re-read contract state and refreshed the current protocol snapshot.", status);
    currentStatus = status;
    setText("lastMessage", status.deployed ? "State refreshed." : status.message);
  } catch (error) {
    setText("lastMessage", "Refresh failed.");
    setOutput(error.message);
    pushFailedActivity("refresh", error);
  } finally {
    setBusy(false);
  }
});

actionButtons.forEach((button) => {
  button.addEventListener("click", () => runAction(button.dataset.action, { button }));
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
    setActiveActionCard(input.id === "bridgeAmount" ? "bridge" : "loan", { pinned: true });
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
      withdrawable: state.withdrawable,
      shockTarget: numeric(currentStatus?.risk?.shockPreview?.collateralPrice),
      maxLiquidationRepay: numeric(currentStatus?.risk?.liquidationPreview?.repayAmount),
    };
    if (target.id === "borrowAmount") setLoanTab("borrow");
    if (target.id === "repayAmount") setLoanTab("repay");
    if (target.id === "withdrawAmount") setLoanTab("withdraw");
    setActiveActionCard(target.id === "bridgeAmount" ? "bridge" : "loan", { pinned: true });
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
renderLatestActivity(loadPersistedActivity());

refreshStatus()
  .then((status) => {
    currentStatus = status;
    applyActionAvailability(status);
    if (!loadPersistedActivity()) {
      renderLatestActivity(activityFromStatus(status));
    }
  })
  .catch((error) => {
  markControllerOffline();
  setText("lastMessage", "Could not load local demo state.");
  setOutput(error.message);
  renderRoadmap();
  });
