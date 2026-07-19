const LENDING_MODES = Object.freeze({
  deposit: {
    label: "Voucher amount",
    unit: "vA",
    limitLabel: "Available voucher",
    limit: (status) => amount(status?.balances?.voucherAvailable),
    button: "Activate collateral",
    icon: "archive",
  },
  borrow: {
    label: "Credit amount",
    unit: "bCASH",
    limitLabel: "Available credit",
    limit: (status) => amount(status?.risk?.availableBorrow),
    button: "Borrow from Bank B",
    icon: "banknote",
  },
  repay: {
    label: "Repayment amount",
    unit: "bCASH",
    limitLabel: "Repayable from wallet",
    limit: (status) => Math.min(amount(status?.balances?.outstandingDebt), amount(status?.balances?.creditAvailable)),
    button: "Repay credit",
    icon: "hand-coins",
  },
  withdraw: {
    label: "Collateral amount",
    unit: "vA",
    limitLabel: "Withdrawable collateral",
    limit: (status) => amount(status?.balances?.outstandingDebt) > 0 ? 0 : amount(status?.balances?.activeCollateral),
    button: "Withdraw collateral",
    icon: "download",
  },
});

const SMALL_BALANCE_THRESHOLD = 0.01;
const STAGE_ORDER = ["prepare", "transfer", "lend", "manage", "return", "review"];
const ACTION_TAB = Object.freeze({
  bridge: "transfer",
  deposit: "lending",
  borrow: "lending",
  repay: "lending",
  repayAll: "lending",
  withdraw: "lending",
  return: "return",
});
const LINKY_IMAGES = Object.freeze({
  guide: "/assets/linky/generated/states/linky-guide.png",
  processing: "/assets/linky/generated/states/linky-processing.png",
  success: "/assets/linky/generated/states/linky-success.png",
  caution: "/assets/linky/generated/states/linky-caution.png",
  neutral: "/assets/linky/generated/states/linky-neutral.png",
});

let currentStatus = null;
let currentTab = "transfer";
let lendingMode = "deposit";
let busyAction = null;
let refreshTimer = null;

initialize();

async function initialize() {
  window.lucide?.createIcons();
  bindNavigation();
  bindForms();
  bindControls();
  openTab(new URLSearchParams(window.location.search).get("tab") || "transfer");
  await refreshStatus({ announceError: true });
  scheduleRefresh();
}

function bindNavigation() {
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => openTab(button.dataset.tab));
  });
  document.querySelectorAll("[data-tab-target]").forEach((button) => {
    button.addEventListener("click", () => openTab(button.dataset.tabTarget));
  });
  document.querySelectorAll("[data-lending-mode]").forEach((button) => {
    button.addEventListener("click", () => setLendingMode(button.dataset.lendingMode, { primeAmount: true }));
  });
}

function bindForms() {
  document.querySelectorAll("[data-operation-form]").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const action = form === element("lendingForm") ? lendingSubmissionAction() : form.dataset.operationForm;
      const input = form.querySelector("input[name='amount']");
      await submitAction(action, input?.value, form);
    });
  });
  document.querySelectorAll(".amount-input input").forEach((input) => {
    input.addEventListener("input", () => {
      input.dataset.dirty = "true";
      renderAvailability();
    });
  });
}

function bindControls() {
  element("refreshButton").addEventListener("click", () => refreshStatus({ announceError: true }));
  element("lendingMaxButton").addEventListener("click", () => {
    setInputAmount(element("lendingAmount"), LENDING_MODES[lendingMode].limit(currentStatus), true);
    renderAvailability();
  });
  document.querySelectorAll("[data-fill]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = element(button.dataset.input);
      setInputAmount(input, amount(currentStatus?.balances?.[button.dataset.fill]), true);
      renderAvailability();
    });
  });
  element("linkyAction").addEventListener("click", () => {
    const action = element("linkyAction").dataset.action;
    if (action) selectAction(action);
  });
  element("copyEvidenceButton").addEventListener("click", copyLatestEvidence);
}

async function refreshStatus({ announceError = false } = {}) {
  const refreshButton = element("refreshButton");
  refreshButton.classList.add("is-spinning");
  try {
    const status = await requestJson("/api/status", { timeoutMs: 15_000 });
    currentStatus = status;
    renderStatus(status);
  } catch (error) {
    renderRuntimeFailure(error.message);
    if (announceError) toast(error.message, "error");
  } finally {
    refreshButton.classList.remove("is-spinning");
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await refreshStatus();
    scheduleRefresh();
  }, busyAction || currentStatus?.controller?.busy ? 1_500 : 5_000);
}

async function submitAction(action, requestedAmount, form) {
  if (busyAction || currentStatus?.controller?.busy) {
    return setFormMessage(form, "Another institutional operation is still settling.", "error");
  }
  const validation = validateAction(action, requestedAmount);
  if (!validation.ok) return setFormMessage(form, validation.message, "error");

  busyAction = action;
  setBusy(true, action);
  setFormMessage(form, operationProgressCopy(action));
  renderLinkyProcessing(action);
  const requestId = actionRequestId(action);
  try {
    const payload = await requestJson("/api/action", {
      method: "POST",
      body: JSON.stringify({ action, amount: validation.value, requestId }),
      timeoutMs: 240_000,
    });
    clearActionRequestId(action);
    currentStatus = payload.status;
    setFormMessage(form, `${operationName(action)} completed on-chain.`, "success");
    toast(`${operationName(action)} completed`, "success");
    renderStatus(currentStatus);
    if (["bridge", "return"].includes(action)) openTab(action === "bridge" ? "lending" : "evidence");
  } catch (error) {
    if (!requestOutcomeUncertain(error)) clearActionRequestId(action);
    setFormMessage(form, error.message, "error");
    toast(error.message, "error");
    await refreshStatus();
  } finally {
    busyAction = null;
    setBusy(false);
    renderAvailability();
    scheduleRefresh();
  }
}

function renderStatus(status) {
  renderRuntime(status);
  if (!status?.ready) {
    renderUnavailable(status);
    return;
  }
  renderOverview(status);
  renderRoute(status);
  renderLending(status);
  renderSettlement(status);
  renderEvidence(status);
  renderJourney(status);
  renderLinky(status);
  renderAvailability();
  primeEmptyInputs(status);
}

function renderRuntime(status) {
  const runtime = element("runtimeStatus");
  runtime.classList.toggle("is-ready", Boolean(status?.ready));
  runtime.classList.toggle("is-error", !status?.ready);
  runtime.lastChild.textContent = status?.ready ? " Operational" : " Runtime unavailable";
}

function renderUnavailable(status) {
  setText("overviewCopy", status?.message || "Institutional runtime is not available.");
  element("linkyAction").hidden = true;
  renderLinkyState({
    image: "caution",
    title: "Institutional runtime needs attention",
    copy: status?.message || "Run the preparation command before opening operations.",
  });
  document.querySelectorAll("form .primary-button").forEach((button) => { button.disabled = true; });
}

function renderRuntimeFailure(message) {
  renderRuntime({ ready: false });
  setText("overviewCopy", message);
  renderLinkyState({ image: "caution", title: "Connection interrupted", copy: message });
}

function renderOverview(status) {
  const health = healthPresentation(status);
  setText("canonicalBalance", compactAmount(status.balances.canonicalAvailable));
  setText("collateralBalance", compactAmount(status.balances.activeCollateral));
  setText("debtBalance", compactAmount(status.balances.outstandingDebt));
  setText("healthFactor", health.value);
  setText("healthLabel", health.label);
  setText(
    "overviewCopy",
    `Bank A block ${formatInteger(status.chains.A.blockNumber)} and Bank B block ${formatInteger(status.chains.B.blockNumber)} are serving the governed collateral lane.`,
  );
}

function renderRoute(status) {
  setText("routeCanonical", `${compactAmount(status.balances.canonicalAvailable)} aBANK`);
  setText("routeVoucher", `${compactAmount(status.balances.voucherAvailable)} vA`);
  setText("bridgeAvailable", `${compactAmount(status.balances.canonicalAvailable)} aBANK`);
  setText("relayRouteStatus", status.relay.online ? `${status.relay.activeAttestors} attestors online` : "Relay offline");
  setText("finalityDepth", `${status.topology?.finalityDepth || 2} blocks`);
  setText("attestorQuorum", `${status.topology.attestorThreshold} of ${status.topology.configuredAttestors}`);
}

function renderLending(status) {
  const risk = status.risk;
  setText("voucherBalance", compactAmount(status.balances.voucherAvailable));
  setText("activeCollateral", compactAmount(status.balances.activeCollateral));
  setText("availableBorrow", compactAmount(risk.availableBorrow));
  setText("creditBalance", compactAmount(status.balances.creditAvailable));
  setText("collateralValue", `${compactAmount(risk.collateralValue)} bCASH`);
  setText("liquidationValue", `${compactAmount(risk.liquidationThresholdValue)} bCASH`);
  setText("collateralFactor", `${formatBps(risk.collateralFactorBps)}%`);
  setText("poolLiquidity", `${compactAmount(status.balances.poolLiquidity)} bCASH`);

  const health = healthPresentation(status);
  setText("riskHealthLabel", health.longLabel);
  const fill = element("riskMeterFill");
  fill.style.width = `${100 - health.meter}%`;
}

function renderSettlement(status) {
  setText("returnVoucherBalance", `${compactAmount(status.balances.voucherAvailable)} vA`);
  setText("returnCanonicalBalance", `${compactAmount(status.balances.canonicalAvailable)} aBANK`);
  setText("returnAvailable", `${compactAmount(status.balances.voucherAvailable)} vA`);
  const debt = amount(status.balances.outstandingDebt);
  const collateral = amount(status.balances.activeCollateral);
  if (debt > 0) {
    setText("settlementGuardTitle", "Outstanding credit remains");
    setText(
      "settlementGuardCopy",
      isDustDebt(status) ? "Settle the small remaining balance before withdrawing and returning collateral." : "Repay Bank B credit before withdrawing and returning collateral.",
    );
  } else if (collateral > 0) {
    setText("settlementGuardTitle", "Collateral is still active");
    setText("settlementGuardCopy", "Withdraw voucher collateral from the lending pool before settlement.");
  } else {
    setText("settlementGuardTitle", "Position is clear");
    setText("settlementGuardCopy", "Free voucher can be burned and released from Bank A custody.");
  }
}

function renderEvidence(status) {
  const topology = status.topology;
  setText("validatorEvidence", `${topology.validatorsPerChain || "-"} validators per chain`);
  setText("faultEvidence", topology.toleratedFaultsPerChain > 0 ? `${topology.toleratedFaultsPerChain} crash fault tolerated` : "Fault tolerance not evidenced");
  setText("quorumEvidence", `${topology.attestorThreshold}-of-${topology.configuredAttestors}`);
  setText("attestorEvidence", `${status.relay.activeAttestors} local attestor services online`);
  setText("governanceEvidence", titleCase(status.governance.mode));
  setText("governanceDelay", `${status.governance.delaySeconds.A}s minimum delay`);
  setText("relayEvidence", `${status.relay.completedMessages} completed`);
  setText("pendingEvidence", `${status.relay.pendingMessages} pending messages`);
  setText("chainAId", status.chains.A.chainId);
  setText("chainABlock", formatInteger(status.chains.A.blockNumber));
  setText("trustedBHeight", formatInteger(status.chains.A.trustedRemoteHeight));
  setText("chainBId", status.chains.B.chainId);
  setText("chainBBlock", formatInteger(status.chains.B.blockNumber));
  setText("trustedAHeight", formatInteger(status.chains.B.trustedRemoteHeight));
  renderActivity(status.activity?.history || []);
}

function renderActivity(history) {
  const table = element("activityTable");
  table.replaceChildren();
  setText("activityCount", `${history.length} recorded`);
  if (!history.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No institutional operation has been submitted from this workspace.";
    table.append(empty);
    return;
  }
  history.slice(0, 8).forEach((entry) => {
    const row = document.createElement("div");
    row.className = "activity-row";
    const icon = document.createElement("i");
    icon.dataset.lucide = actionIcon(entry.action);
    const identity = document.createElement("div");
    const title = document.createElement("b");
    title.textContent = entry.label || operationName(entry.action);
    const time = document.createElement("small");
    time.textContent = formatTimestamp(entry.finishedAt || entry.startedAt);
    identity.append(title, time);
    const lane = document.createElement("span");
    lane.textContent = entry.lane || "Bank B";
    const transaction = document.createElement("span");
    transaction.textContent = shortHash(entry.messageId || entry.sourceTransaction || "-");
    transaction.title = entry.messageId || entry.sourceTransaction || "";
    const state = document.createElement("span");
    const failed = ["failed", "uncertain"].includes(entry.status);
    state.className = `activity-status${failed ? " is-failed" : ""}`;
    state.textContent = ({ pending: "Pending", submitted: "Submitted", uncertain: "Review", failed: "Failed" })[entry.status] || "Completed";
    row.append(icon, identity, lane, transaction, state);
    table.append(row);
  });
  window.lucide?.createIcons();
}

function renderJourney(status) {
  const stage = status.workflow?.stage === "processing"
    ? actionStage(status.controller?.activeOperation?.action || busyAction)
    : status.workflow?.stage || "prepare";
  const activeIndex = Math.max(0, STAGE_ORDER.indexOf(stage));
  const history = status.activity?.history || [];
  const hasAction = (action) => history.some((entry) => entry.action === action && entry.status === "completed");
  const transferObserved = hasAction("bridge") || amount(status.balances.escrowed) > 0 || amount(status.balances.voucherAvailable) > 0 || amount(status.balances.activeCollateral) > 0;
  const lendingObserved = hasAction("deposit") || amount(status.balances.activeCollateral) > 0 || amount(status.balances.outstandingDebt) > 0;
  setText("identityStepStatus", status.participants.identity.A.active && status.participants.identity.B.active ? "Verified" : "Review");
  setText("transferStepStatus", transferObserved ? "Settled" : stage === "transfer" ? "Ready" : "Waiting");
  setText("lendingStepStatus", lendingObserved ? "Active" : stage === "lend" ? "Ready" : "Waiting");
  setText("positionStepStatus", amount(status.balances.outstandingDebt) > 0 ? "Open" : hasAction("borrow") ? "Repaid" : "Waiting");
  setText("returnStepStatus", hasAction("return") ? "Settled" : stage === "return" ? "Ready" : "Waiting");
  setText("evidenceStepStatus", "Live");

  document.querySelectorAll(".journey-step").forEach((step, index) => {
    step.classList.toggle("is-active", index === activeIndex);
    step.classList.toggle("is-complete", index < activeIndex || (index === 0 && status.participants.identity.A.active && status.participants.identity.B.active));
  });
}

function renderLinky(status) {
  if (busyAction || status.controller?.activeOperation) return renderLinkyProcessing(busyAction || status.controller.activeOperation.action);
  const recommendation = recommendationFor(status);
  renderLinkyState(recommendation);
  setText("linkyIdentity", status.participants.identity.A.active && status.participants.identity.B.active ? "Verified" : "Review");
  setText("linkyRelay", status.relay.online ? `${status.relay.activeAttestors} online` : "Offline");
  setText("linkyGovernance", titleCase(status.governance.mode));
  const actionButton = element("linkyAction");
  if (recommendation.action) {
    actionButton.hidden = false;
    actionButton.dataset.action = recommendation.action;
    actionButton.querySelector("span").textContent = recommendation.button;
  } else {
    actionButton.hidden = true;
    delete actionButton.dataset.action;
  }
}

function recommendationFor(status) {
  const next = status.workflow?.nextAction;
  const recommendations = {
    bridge: { image: "guide", title: "Transfer collateral to Bank B", copy: "Canonical aBANK is available for governed cross-chain custody.", action: "bridge", button: "Open transfer" },
    deposit: { image: "guide", title: "Activate received collateral", copy: "Verified voucher is available on Bank B and can enter the lending position.", action: "deposit", button: "Open lending" },
    borrow: { image: "guide", title: "Credit capacity is available", copy: `${compactAmount(status.risk.availableBorrow)} bCASH remains within policy and liquidity limits.`, action: "borrow", button: "Open borrowing" },
    repay: canRepaySmallBalance(status)
      ? { image: "caution", title: "Repay exact remaining balance", copy: "A small accrued bCASH balance remains and will be collected in full.", action: "repayAll", button: "Repay full balance" }
      : { image: "caution", title: "Manage outstanding credit", copy: `${compactAmount(status.balances.outstandingDebt)} bCASH remains outstanding on Bank B.`, action: "repay", button: "Open repayment" },
    withdraw: { image: "guide", title: "Release active collateral", copy: "The credit position is clear and collateral can leave the lending pool.", action: "withdraw", button: "Open withdrawal" },
    return: { image: "success", title: "Settle collateral on Bank A", copy: "Free voucher can now be burned for canonical custody release.", action: "return", button: "Open settlement" },
  };
  return recommendations[next] || { image: "neutral", title: "Institutional state is synchronized", copy: "Review runtime evidence and recent transaction identifiers.", action: "evidence", button: "Open evidence" };
}

function renderLinkyProcessing(action) {
  const active = currentStatus?.controller?.activeOperation;
  renderLinkyState({
    image: "processing",
    title: operationName(action || active?.action),
    copy: active?.stage ? `Current stage: ${titleCase(active.stage)}.` : operationProgressCopy(action),
  });
  element("linkyAction").hidden = true;
}

function renderLinkyState({ image, title, copy }) {
  element("linkyImage").src = LINKY_IMAGES[image] || LINKY_IMAGES.neutral;
  setText("linkyTitle", title);
  setText("linkyCopy", copy);
}

function renderAvailability() {
  if (!currentStatus?.ready) return;
  const bridge = validateAction("bridge", element("bridgeAmount").value);
  const settlement = validateAction("return", element("returnAmount").value);
  const lending = validateAction(lendingSubmissionAction(), element("lendingAmount").value);
  updateSubmit(document.querySelector("[data-operation-form='bridge'] .primary-button"), bridge);
  updateSubmit(document.querySelector("[data-operation-form='return'] .primary-button"), settlement);
  updateSubmit(element("lendingSubmit"), lending);
}

function updateSubmit(button, validation) {
  if (!button) return;
  button.disabled = Boolean(busyAction || currentStatus?.controller?.busy || !validation.ok);
  button.title = validation.ok ? "" : validation.message;
}

function validateAction(action, rawValue) {
  if (!currentStatus?.ready) return invalid("Institutional runtime is not ready.");
  if (action === "repayAll") {
    if (!isSmallBalance(currentStatus)) return invalid("The remaining credit is above the exact small-balance repayment threshold.");
    if (!canRepaySmallBalance(currentStatus)) return invalid("Wallet bCASH balance is insufficient to repay the complete debt.");
    return { ok: true, value: currentStatus.balances.outstandingDebt, message: "" };
  }
  const value = amount(rawValue);
  if (!(value > 0)) return invalid("Enter an amount greater than zero.");
  const debt = amount(currentStatus.balances.outstandingDebt);
  const collateral = amount(currentStatus.balances.activeCollateral);
  const limits = {
    bridge: amount(currentStatus.balances.canonicalAvailable),
    deposit: amount(currentStatus.balances.voucherAvailable),
    borrow: amount(currentStatus.risk.availableBorrow),
    repay: Math.min(debt, amount(currentStatus.balances.creditAvailable)),
    withdraw: debt > 0 ? 0 : collateral,
    return: debt > 0 || collateral > 0 ? 0 : amount(currentStatus.balances.voucherAvailable),
  };
  if (action === "withdraw" && debt > 0) {
    return invalid(isSmallBalance(currentStatus) ? "Repay the small remaining balance before withdrawing collateral." : "Repay outstanding credit before withdrawing collateral.");
  }
  if (action === "return" && debt > 0) {
    return invalid(isSmallBalance(currentStatus) ? "Repay the small remaining balance before settlement." : "Repay outstanding credit before settlement.");
  }
  if (action === "return" && collateral > 0) return invalid("Withdraw lending collateral before settlement.");
  if (value > (limits[action] || 0) + 0.0000001) return invalid("Amount exceeds the available on-chain limit.");
  return { ok: true, value: normalizeDecimal(rawValue), message: "" };
}

function setLendingMode(mode, { primeAmount = false } = {}) {
  if (!LENDING_MODES[mode]) return;
  lendingMode = mode;
  const config = LENDING_MODES[mode];
  const submitAction = mode === "repay" && canRepaySmallBalance(currentStatus) ? "repayAll" : mode;
  document.querySelectorAll("[data-lending-mode]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.lendingMode === mode);
  });
  element("lendingForm").dataset.operationForm = mode;
  setText("lendingAmountLabel", config.label);
  setText("lendingUnit", config.unit);
  setText("lendingLimitLabel", submitAction === "repayAll" ? "Exact outstanding balance" : config.limitLabel);
  setText(
    "lendingLimit",
    `${submitAction === "repayAll" ? compactAmount(currentStatus?.balances?.outstandingDebt) : compactNumber(config.limit(currentStatus))} ${config.unit}`,
  );
  const submit = element("lendingSubmit");
  submit.dataset.action = submitAction;
  submit.innerHTML = `<i data-lucide="${submitAction === "repayAll" ? "circle-dollar-sign" : config.icon}"></i><span>${submitAction === "repayAll" ? "Repay full balance" : config.button}</span>`;
  if (primeAmount) setInputAmount(element("lendingAmount"), config.limit(currentStatus), true);
  setFormMessage(element("lendingForm"), "");
  window.lucide?.createIcons();
  renderAvailability();
}

function primeEmptyInputs(status) {
  const defaults = {
    bridgeAmount: Math.min(1000, amount(status.balances.canonicalAvailable)),
    returnAmount: amount(status.balances.voucherAvailable),
    lendingAmount: LENDING_MODES[lendingMode].limit(status),
  };
  Object.entries(defaults).forEach(([id, value]) => {
    const input = element(id);
    if (input.dataset.dirty !== "true" && (!(amount(input.value) > 0) || id === "lendingAmount")) {
      setInputAmount(input, value, false);
    }
  });
  setLendingMode(lendingMode);
}

function lendingSubmissionAction() {
  return lendingMode === "repay" && canRepaySmallBalance(currentStatus) ? "repayAll" : lendingMode;
}

function isSmallBalance(status) {
  const debt = amount(status?.balances?.outstandingDebt);
  return debt > 0 && debt < SMALL_BALANCE_THRESHOLD;
}

function canRepaySmallBalance(status) {
  return isSmallBalance(status) && amount(status?.balances?.creditAvailable) >= amount(status?.balances?.outstandingDebt);
}

function selectAction(action) {
  if (action === "evidence") return openTab("evidence");
  openTab(ACTION_TAB[action] || "transfer");
  if (action === "repayAll") setLendingMode("repay", { primeAmount: true });
  if (LENDING_MODES[action]) setLendingMode(action, { primeAmount: true });
  const input = action === "bridge" ? element("bridgeAmount") : action === "return" ? element("returnAmount") : element("lendingAmount");
  input?.focus();
}

function openTab(tab) {
  if (!["transfer", "lending", "return", "evidence"].includes(tab)) return;
  currentTab = tab;
  document.querySelectorAll("[data-tab]").forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll("[data-panel]").forEach((panel) => {
    const active = panel.dataset.panel === tab;
    panel.classList.toggle("is-active", active);
    panel.hidden = !active;
  });
}

function setBusy(busy, action = null) {
  document.body.classList.toggle("is-busy", busy);
  document.querySelectorAll("form .primary-button").forEach((button) => {
    button.disabled = busy || button.disabled;
    button.classList.toggle("is-busy", busy && button.dataset.action === action);
  });
}

async function copyLatestEvidence() {
  const latest = currentStatus?.activity?.latest;
  const value = latest?.messageId || latest?.sourceTransaction;
  if (!value) return toast("No transaction identifier is available yet", "error");
  try {
    await navigator.clipboard.writeText(value);
    toast("Latest evidence identifier copied", "success");
  } catch {
    toast(value, "success");
  }
}

function healthPresentation(status) {
  const debt = amount(status?.balances?.outstandingDebt);
  if (debt <= 0) return { value: "∞", label: "No debt", longLabel: "No active debt", meter: 100 };
  const factor = amount(status?.risk?.healthFactor);
  if (factor < 1) return { value: factor.toFixed(2), label: "Liquidatable", longLabel: "Below threshold", meter: 18 };
  if (factor < 1.25) return { value: factor.toFixed(2), label: "Watch", longLabel: "Close to threshold", meter: 38 };
  return { value: factor.toFixed(2), label: "Healthy", longLabel: "Healthy position", meter: Math.min(100, 52 + (factor - 1) * 28) };
}

function actionStage(action) {
  if (action === "bridge") return "transfer";
  if (["deposit", "borrow"].includes(action)) return "lend";
  if (["repay", "repayAll", "withdraw"].includes(action)) return "manage";
  if (action === "return") return "return";
  return "review";
}

function actionIcon(action) {
  return ({ bridge: "arrow-right", deposit: "archive", borrow: "banknote", repay: "hand-coins", repayAll: "circle-dollar-sign", withdraw: "download", return: "rotate-ccw" })[action] || "circle-check";
}

function operationName(action) {
  return ({ bridge: "Collateral transfer", deposit: "Collateral activation", borrow: "Credit draw", repay: "Credit repayment", repayAll: "Complete balance repayment", withdraw: "Collateral withdrawal", return: "Collateral settlement" })[action] || "Institutional operation";
}

function operationProgressCopy(action) {
  return ["bridge", "return"].includes(action)
    ? "Waiting for source finality, attestor quorum and cross-chain acknowledgement."
    : "Submitting the policy-checked Bank B transaction.";
}

function setFormMessage(form, message, tone = "") {
  const key = form === element("lendingForm") ? "lending" : form?.dataset?.operationForm;
  const output = document.querySelector(`[data-message='${key}']`);
  if (!output) return;
  output.textContent = message || "";
  output.classList.toggle("is-error", tone === "error");
  output.classList.toggle("is-success", tone === "success");
}

function toast(message, tone = "success") {
  const item = document.createElement("div");
  item.className = `toast${tone === "error" ? " is-error" : ""}`;
  const icon = document.createElement("i");
  icon.dataset.lucide = tone === "error" ? "circle-alert" : "circle-check";
  const copy = document.createElement("span");
  copy.textContent = message;
  const close = document.createElement("button");
  close.type = "button";
  close.setAttribute("aria-label", "Dismiss notification");
  close.innerHTML = '<i data-lucide="x"></i>';
  close.addEventListener("click", () => item.remove());
  item.append(icon, copy, close);
  element("toastRegion").append(item);
  window.lucide?.createIcons();
  setTimeout(() => item.remove(), 6_000);
}

async function requestJson(path, { timeoutMs = 15_000, ...options } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      ...options,
      headers: { "content-type": "application/json", ...(options.headers || {}) },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `Request failed with HTTP ${response.status}`);
      error.statusCode = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("The institutional operation timed out in the UI.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function actionRequestId(action) {
  const key = `institutional-request:${action}`;
  try {
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const requestId = window.crypto?.randomUUID?.() || `request-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    window.sessionStorage.setItem(key, requestId);
    return requestId;
  } catch {
    return window.crypto?.randomUUID?.() || `request-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function clearActionRequestId(action) {
  try {
    window.sessionStorage.removeItem(`institutional-request:${action}`);
  } catch {
    // Storage can be disabled without preventing on-chain execution.
  }
}

function requestOutcomeUncertain(error) {
  if (error?.statusCode === 409) {
    const status = error?.payload?.operation?.status;
    return status !== "failed" && status !== "completed";
  }
  return /timed out|already submitted|already uncertain/i.test(error?.message || "");
}

function setInputAmount(input, value, dirty) {
  if (!input) return;
  input.value = normalizeDecimal(value);
  input.dataset.dirty = dirty ? "true" : "false";
}

function normalizeDecimal(value) {
  const numeric = amount(value);
  if (!Number.isFinite(numeric)) return "0";
  return numeric.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 8 });
}

function amount(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function compactAmount(value) {
  return compactNumber(amount(value));
}

function compactNumber(value) {
  if (!Number.isFinite(value)) return "-";
  if (value > 0 && value < 0.01) return "<0.01";
  return value.toLocaleString("en-US", { maximumFractionDigits: value >= 100 ? 2 : 4 });
}

function formatInteger(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "-";
}

function formatBps(value) {
  return (amount(value) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatTimestamp(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-GB", { hour12: false });
}

function shortHash(value) {
  return typeof value === "string" && value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

function titleCase(value) {
  return String(value || "-")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function invalid(message) {
  return { ok: false, value: null, message };
}

function setText(id, value) {
  const node = element(id);
  if (node) node.textContent = value == null ? "-" : String(value);
}

function element(id) {
  return document.getElementById(id);
}
