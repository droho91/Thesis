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
const ACTIVITY_STORAGE_KEY = "interchain-lending-latest-activity";
const FOCUS_MODE_STORAGE_KEY = "interchain-lending-focus-mode";
const CLIENT_STATUS = ["Uninitialized", "Active", "Frozen", "Recovering"];
const SAFETY_MODE_ACTIONS = new Set(["recoverClient", "topUpRepayCash"]);
const AMOUNT_ACTIONS = {
  lock: { inputId: "bridgeAmount", unit: "aBANK" },
  borrow: { inputId: "borrowAmount", unit: "bCASH" },
  repay: { inputId: "repayAmount", unit: "bCASH" },
  withdrawCollateral: { inputId: "withdrawAmount", unit: "vA" },
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
  burn: "redeem",
  finalizeReverseHeader: "redeem",
  updateReverseClient: "redeem",
  proveReverseUnlock: "redeem",
};
const LOAN_TAB_BY_ACTION = {
  borrow: "borrow",
  repay: "repay",
  withdrawCollateral: "withdraw",
};
let currentStatus = null;
let currentLoanTab = "borrow";
let actionCardPinned = false;
let selectedWorkflowStep = null;
let currentWorkflowAction = { type: "deploySeed" };

function setBusy(busy) {
  document.body.classList.toggle("is-busy", busy);
  buttons.forEach((button) => {
    button.disabled = busy;
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

function clamp(value, min = 0, max = Number.POSITIVE_INFINITY) {
  return Math.min(max, Math.max(min, value));
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
  const reverse = status?.trace?.reverse || {};
  if (reverse.commitHeight || reverse.packetId || reverse.receiveTxHash) return "redeem";
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
    availableBorrow: numeric(market.availableToBorrow),
    withdrawable,
  };
}

function projectedHealth(maxBorrow, debt) {
  if (debt <= 0) return { label: "No debt", status: "Safe", percent: null };
  const percent = maxBorrow > 0 ? (maxBorrow / debt) * 100 : 0;
  const label = `${percent >= 10 ? percent.toFixed(1) : percent.toFixed(2)}%`;
  if (percent >= 150) return { label, status: "Safe", percent };
  if (percent >= 110) return { label, status: "Watch", percent };
  return { label, status: "At Risk", percent };
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
  if (!raw || raw === String(2n ** 256n - 1n)) return { label: "No debt", status: "Safe", percent: null };
  const percent = Number(raw) / 100;
  if (!Number.isFinite(percent)) return { label: "-", status: "Waiting", percent: null };
  if (percent >= 150) return { label: `${percent.toFixed(1)}%`, status: "Safe", percent };
  if (percent >= 110) return { label: `${percent.toFixed(1)}%`, status: "Watch", percent };
  return { label: `${percent.toFixed(1)}%`, status: "At Risk", percent };
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
  const forward = status?.trace?.forward || {};
  const health = healthFromStatus(status);
  const deployed = state.deployed;
  const bridgeStarted =
    state.escrow > 0 ||
    Boolean(forward.commitHeight || forward.packetId || forward.receiveTxHash) ||
    state.voucher > 0 ||
    state.collateral > 0 ||
    state.debt > 0;
  const voucherReady = state.voucher > 0;
  const collateralActive = state.collateral > 0;
  const debtActive = state.debt > 0;
  const elevatedRisk = debtActive && (health.status === "At Risk" || health.status === "Watch");
  const locked = safetyLocked(status);

  const steps = {
    connect: { complete: deployed, unlocked: true, label: deployed ? "Connected" : "Prepare account" },
    bridge: {
      complete: voucherReady || collateralActive || debtActive,
      unlocked: deployed,
      label: voucherReady || collateralActive || debtActive ? "Complete" : bridgeStarted ? "In progress" : "Ready",
    },
    activate: {
      complete: collateralActive || debtActive,
      unlocked: voucherReady || collateralActive || debtActive,
      label: collateralActive || debtActive ? "Active" : voucherReady ? "Ready" : "Locked",
    },
    borrow: {
      complete: debtActive,
      unlocked: collateralActive || debtActive,
      label: debtActive ? "Debt active" : collateralActive ? "Ready" : "Locked",
    },
    manage: {
      complete: false,
      unlocked: debtActive,
      label: debtActive ? (elevatedRisk ? "Needs attention" : "Active") : "Locked",
    },
  };

  if (!deployed) {
    return {
      step: "connect",
      title: "Connect your account",
      status: "Start here",
      summary: "Connect your account to unlock collateral transfer and borrowing actions.",
      cta: { type: "deploySeed", label: "Connect Wallet" },
      description: "Prepare the borrower account before moving collateral.",
      hint: "Later steps stay locked until your account is ready.",
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

  if (!bridgeStarted && !voucherReady && !collateralActive && !debtActive) {
    return {
      step: "bridge",
      title: "Bridge collateral",
      status: "Ready",
      summary: "Move source-bank collateral into this lending account to begin borrowing.",
      cta: {
        type: "action",
        action: routeReady(status) ? "lock" : "openRoute",
        label: "Bridge Collateral",
      },
      description: routeReady(status)
        ? "Choose an amount and transfer collateral into the account."
        : "Prepare the route and start the collateral transfer.",
      hint: `${formatAmount(state.bankA, "aBANK")} available on Bank A.`,
      steps,
      risk: "safe",
    };
  }

  if (bridgeStarted && !voucherReady && !collateralActive && !debtActive) {
    return {
      step: "bridge",
      title: "Bridge in progress",
      status: "In progress",
      summary: "Your collateral transfer is being verified. Continue once to make it usable for borrowing.",
      cta: { type: "action", action: bridgeProofAction(status), label: "Continue Bridge" },
      description: "Complete verification so the transferred collateral becomes available.",
      hint: "This may take more than one confirmation step depending on the current bridge state.",
      steps,
      risk: "waiting",
    };
  }

  if (voucherReady && !collateralActive && !debtActive) {
    return {
      step: "activate",
      title: "Activate collateral",
      status: "Ready",
      summary: "Your collateral is available. Activate it to unlock borrowing power.",
      cta: { type: "action", action: "depositCollateral", label: "Use as Collateral" },
      description: "Deposit available collateral into the lending account.",
      hint: `${formatAmount(state.voucher, "vA")} available to activate.`,
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
    title: elevatedRisk ? "Reduce position risk" : "Manage position",
    status: elevatedRisk ? health.status : "Debt active",
    summary: elevatedRisk
      ? "Your health factor needs attention. Repaying debt is the clearest way to improve safety."
      : "Your loan is active. Repay, monitor safety, or withdraw only if the position remains healthy.",
    cta: {
      type: "action",
      action: elevatedRisk ? "repay" : manageAction,
      label: elevatedRisk ? "Reduce Risk" : currentLoanTab === "withdraw" ? "Withdraw Collateral" : "Repay Debt",
    },
    description: elevatedRisk ? "Repay debt to improve your health factor." : "Use the selected action to manage your open loan.",
    hint: `${formatAmount(state.debt, "bCASH")} debt outstanding.`,
    steps,
    risk: elevatedRisk ? "risk" : "safe",
  };
}

function actionAllowedByWorkflow(action, model) {
  if (!action) return true;
  if (model.cta?.action === action) return true;
  if (isTechnicalAction(action)) return true;
  return action === "fullFlow" || action === "burn" || action === "proveReverseUnlock";
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
  setText("primaryActionTitle", reviewingPastStep ? "Continue workflow" : model.title);
  setText("primaryActionDescription", reviewingPastStep ? "Return to the recommended next step to continue." : model.description);
  setText("primaryActionHint", reviewingPastStep ? "Completed steps are available for review only." : model.hint);
  if (primaryWorkflowCta) {
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
    if (!allowed && !button.closest(".surface-drawer")) {
      button.disabled = true;
      button.title = "Complete the current step before using this action.";
    }
  }

  deploySeedButton?.toggleAttribute("hidden", true);
  if (model.step === "manage" && currentLoanTab === "borrow") setLoanTab(model.risk === "risk" ? "repay" : "repay");
  setActiveActionCard(selectedStep === "activate" ? "activate" : selectedStep === "manage" || selectedStep === "borrow" ? "loan" : selectedStep);
}

function setRiskBadge(id, health) {
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = health.status;
  node.classList.toggle("is-safe", health.status === "Safe");
  node.classList.toggle("is-watch", health.status === "Watch");
  node.classList.toggle("is-risk", health.status === "At Risk");
}

function setValidation(id, message = "", severity = "") {
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = message;
  node.classList.toggle("is-warning", severity === "warning");
  node.classList.toggle("is-error", severity === "error");
}

function validateAmountAction(action, status = currentStatus) {
  const state = financialState(status);
  const inputId = AMOUNT_ACTIONS[action]?.inputId;
  const amount = inputId ? inputValue(inputId) : 0;
  if (!AMOUNT_ACTIONS[action]) return { ok: true, amount };
  if (!state.deployed) return { ok: false, amount, message: "Connect your wallet before submitting." };
  if (amount <= 0) return { ok: false, amount, message: "Enter an amount greater than zero." };

  if (action === "lock") {
    if (amount > state.bankA) return { ok: false, amount, message: "Amount exceeds your source-bank balance." };
    return { ok: true, amount, message: "Ready to bridge collateral." };
  }

  if (action === "borrow") {
    if (state.collateral <= 0) return { ok: false, amount, message: "Activate collateral before borrowing." };
    if (amount > state.availableBorrow) return { ok: false, amount, message: "Amount exceeds available borrowing power." };
    if (amount > state.poolCash) return { ok: false, amount, message: "Amount exceeds available market liquidity." };
    return { ok: true, amount, message: "Borrow amount is within current risk limits." };
  }

  if (action === "repay") {
    if (state.debt <= 0) return { ok: false, amount, message: "There is no outstanding debt to repay." };
    if (amount > state.debt) return { ok: false, amount, message: "Amount is greater than outstanding debt." };
    if (amount > state.bankB) {
      const shortfall = Math.max(0, amount - state.bankB);
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
}

function refreshTransactionUi(status, { forceDefaults = false } = {}) {
  const state = financialState(status);
  const suggestedBridge = status?.trace?.forward?.amount || status?.amount || Math.min(state.bankA, 100);
  setInputValue("bridgeAmount", suggestedBridge, { force: forceDefaults });
  setInputValue("borrowAmount", state.availableBorrow, { force: forceDefaults });
  setInputValue("repayAmount", state.debt, { force: forceDefaults });
  setInputValue("withdrawAmount", state.withdrawable, { force: forceDefaults });

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
  const borrowHealth = borrowAmount > 0 ? projectedHealth(state.maxBorrow, projectedBorrowDebt) : { label: "-", status: "Waiting" };
  setText("borrowDecisionAmount", formatAmount(borrowAmount, "bCASH"));
  setText("borrowProjectedDebt", formatAmount(projectedBorrowDebt, "bCASH"));
  setText("borrowProjectedAvailable", formatAmount(Math.max(0, state.maxBorrow - projectedBorrowDebt), "bCASH"));
  setText("borrowProjectedHealth", borrowHealth.label);
  setRiskBadge("borrowRiskBadge", borrowHealth);

  const repayAmount = inputValue("repayAmount");
  const projectedRepayDebt = Math.max(0, state.debt - repayAmount);
  const repayHealth = repayAmount > 0 ? projectedHealth(state.maxBorrow, projectedRepayDebt) : { label: "-", status: "Waiting" };
  const repayableNow = Math.min(state.debt, state.bankB);
  const repayShortfall = Math.max(0, state.debt - state.bankB);
  const needsDemoCash = state.deployed && state.debt > 0 && repayShortfall > 0.000001;
  setText("repayWalletBalance", status?.deployed ? formatAmount(state.bankB, "bCASH") : "-");
  setText("repayableNow", status?.deployed ? formatAmount(repayableNow, "bCASH") : "-");
  setText("repayShortfall", status?.deployed ? formatAmount(repayShortfall, "bCASH") : "-");
  setText(
    "repayFundingCopy",
    !status?.deployed
      ? "Connect your account before managing repayment."
      : state.debt <= 0
        ? "No active debt is open, so repayment is not needed."
        : needsDemoCash
          ? `Demo wallet is short by ${formatAmount(repayShortfall, "bCASH")}. Add demo bCASH to close the debt cleanly.`
          : "Your wallet has enough bCASH for the selected repayment flow."
  );
  if (topUpRepayCashButton) {
    topUpRepayCashButton.hidden = !needsDemoCash;
    topUpRepayCashButton.disabled = document.body.classList.contains("is-busy");
    topUpRepayCashButton.title = needsDemoCash ? `Adds ${formatAmount(repayShortfall, "bCASH")} for demo repayment.` : "";
  }
  setText("repayDecisionAmount", formatAmount(repayAmount, "bCASH"));
  setText("repayProjectedDebt", formatAmount(projectedRepayDebt, "bCASH"));
  setText("repayProjectedHealth", repayHealth.label);

  const withdrawAmount = inputValue("withdrawAmount");
  const remainingCollateral = Math.max(0, state.collateral - withdrawAmount);
  const projectedWithdrawMax = state.collateral > 0 ? (state.maxBorrow * remainingCollateral) / state.collateral : 0;
  const withdrawHealth =
    withdrawAmount > 0 ? projectedHealth(projectedWithdrawMax, state.debt) : { label: "-", status: "Waiting" };
  setText("withdrawDecisionAmount", formatAmount(withdrawAmount, "vA"));
  setText("withdrawProjectedCollateral", formatAmount(remainingCollateral, "vA"));
  setText("withdrawProjectedHealth", withdrawHealth.label);
  setRiskBadge("withdrawRiskBadge", withdrawHealth);

  for (const [action, field] of Object.entries({
    lock: "bridgeValidation",
    borrow: "borrowValidation",
    repay: "repayValidation",
    withdrawCollateral: "withdrawValidation",
  })) {
    const validation = validateAmountAction(action, status);
    const touched = document.getElementById(AMOUNT_ACTIONS[action]?.inputId)?.dataset.dirty === "true";
    const unhealthyWithdrawal = action === "withdrawCollateral" && withdrawAmount > 0 && withdrawHealth.status === "At Risk";
    setValidation(
      field,
      validation.message || (unhealthyWithdrawal ? "Projected health is at risk after withdrawal." : ""),
      validation.ok && unhealthyWithdrawal ? "warning" : validation.ok || !touched ? "" : "error"
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
    safetyState: status.security?.frozen
      ? "Frozen"
      : status.security?.recovering
        ? "Recovering"
        : `${statusAOnB}/${statusBOnA}`,
    replayBlocked: status.security?.replayBlocked
      ? `blocked${status.security?.replayProofHeight ? ` @ ${status.security.replayProofHeight}` : ""}`
      : "pending",
    timeoutAbsence: timeoutAbsence ? `seq ${timeoutAbsence.absentSequence || "-"}` : null,
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
  bankBBalance: "Wallet bCASH",
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
  safetyState: "Light-client safety state",
  replayBlocked: "Replay protection",
  timeoutAbsence: "Timeout absence proof",
  misbehaviour: "Conflicting-header evidence",
};

function collectChanges(before, after) {
  const previous = before || {};
  const next = after || {};
  return Object.keys(FACT_LABELS)
    .filter((key) => previous[key] !== next[key] && next[key] != null && next[key] !== "")
    .slice(0, 6)
    .map((key) => ({
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
    burn: "Started collateral return",
    finalizeReverseHeader: "Checked return confirmation",
    updateReverseClient: "Confirmed collateral return",
    proveReverseUnlock: "Completed source-bank release",
    freezeClient: "Entered safety mode",
    recoverClient: "Recovered account safety",
    replayForward: "Tested duplicate protection",
    verifyTimeoutAbsence: "Checked timeout protection",
    fullFlow: "Completed cross-chain lending flow",
    deploySeed: "Connected account",
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
  const activity = {
    title: actionTitle(action),
    summary,
    time: new Date().toISOString(),
    timeLabel: formatClock(new Date().toISOString()),
    changes: collectChanges(snapshotStatus(currentStatus), snapshotStatus(nextStatus)),
  };
  persistActivity(activity);
  renderLatestActivity(activity);
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

async function runDeploySeed() {
  setBusy(true);
  setText("lastMessage", "Preparing demo runtime...");
  setOutput(
    "Checking whether the interchain lending stack is already deployed and seeded. If it is ready, this skips the slow setup path."
  );
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
    setText("lastMessage", "Demo runtime ready.");
    setOutput(payload.output);
  } catch (error) {
    setText("lastMessage", error.statusCode === 409 ? "Controller is busy." : "Prepare / Reuse failed.");
    setOutput(error.message);
    pushFailedActivity("deploySeed", error);
  } finally {
    setBusy(false);
  }
}

async function runResetSeeded() {
  setBusy(true);
  setText("lastMessage", "Running fresh reset to seeded baseline...");
  setOutput(
    "Creating a fresh interchain lending deployment, seeding policy/oracle/risk state, and clearing the demo trace. Run this before the live demo window."
  );
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
    setText("lastMessage", "Fresh reset complete.");
    setOutput(payload.output);
  } catch (error) {
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
      }[action],
      validation.message,
      "error"
    );
    throw new Error(validation.message);
  }
  return { amount: String(validation.amount) };
}

async function runAction(action) {
  if (LOAN_TAB_BY_ACTION[action]) setLoanTab(LOAN_TAB_BY_ACTION[action]);
  setActiveActionCard(ACTION_CARD_BY_ACTION[action] || suggestActionCard(currentStatus), { pinned: true });
  let requestBody;
  try {
    requestBody = { action, ...amountPayloadForAction(action) };
  } catch (error) {
    setText("lastMessage", error.message);
    return;
  }
  setBusy(true);
  const title = actionTitle(action);
  setText("lastMessage", `Running ${title}...`);
  setOutput(
    requestBody.amount
      ? `Calling action: ${title}\nAmount: ${requestBody.amount} ${AMOUNT_ACTIONS[action]?.unit || ""}`
      : `Calling action: ${title}`
  );
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
    setText("lastMessage", payload.message);
    setOutput(payload.message);
  } catch (error) {
    setText("lastMessage", error.statusCode === 409 ? "Controller is busy." : `${title} failed.`);
    setOutput(error.message);
    pushFailedActivity(action, error);
  } finally {
    setBusy(false);
  }
}

async function runPrimaryWorkflowAction() {
  if (currentWorkflowAction?.type === "return") {
    selectedWorkflowStep = null;
    syncWorkflowUi(currentStatus);
    return;
  }
  if (currentWorkflowAction?.type === "deploySeed") {
    await runDeploySeed();
    return;
  }
  if (currentWorkflowAction?.type === "action" && currentWorkflowAction.action) {
    await runAction(currentWorkflowAction.action);
  }
}

primaryWorkflowCta?.addEventListener("click", runPrimaryWorkflowAction);
deploySeedButton?.addEventListener("click", runDeploySeed);
resetSeededButton?.addEventListener("click", runResetSeeded);
topUpRepayCashButton?.addEventListener("click", () => {
  setLoanTab("repay");
  setActiveActionCard("loan", { pinned: true });
  selectedWorkflowStep = "manage";
  runAction("topUpRepayCash");
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
  button.addEventListener("click", () => runAction(button.dataset.action));
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
    selectedWorkflowStep = financialState(currentStatus).debt > 0 ? "manage" : "borrow";
    syncWorkflowUi(currentStatus);
  });
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
