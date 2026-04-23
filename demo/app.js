import { markControllerOffline, renderLatestActivity, renderRoadmap, renderStatus, setText } from "./demo-status-view.js";

const buttons = [...document.querySelectorAll("button")];
const actionButtons = [...document.querySelectorAll("[data-action]")];
const deploySeedButton = document.getElementById("deploySeed");
const resetSeededButton = document.getElementById("resetSeeded");
const refreshButton = document.getElementById("refreshState");
const focusModeButton = document.getElementById("focusMode");
const amountInputs = [...document.querySelectorAll(".amount-field input")];
const amountFillButtons = [...document.querySelectorAll("[data-fill-target]")];
const ACTIVITY_STORAGE_KEY = "interchain-lending-latest-activity";
const FOCUS_MODE_STORAGE_KEY = "interchain-lending-focus-mode";
const CLIENT_STATUS = ["Uninitialized", "Active", "Frozen", "Recovering"];
const SAFETY_MODE_ACTIONS = new Set(["recoverClient"]);
const AMOUNT_ACTIONS = {
  lock: { inputId: "bridgeAmount", unit: "aBANK" },
  borrow: { inputId: "borrowAmount", unit: "bCASH" },
  repay: { inputId: "repayAmount", unit: "bCASH" },
  withdrawCollateral: { inputId: "withdrawAmount", unit: "vA" },
};
let currentStatus = null;

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

function setInputValue(id, value, { force = false } = {}) {
  const input = document.getElementById(id);
  if (!input || (!force && input.dataset.dirty === "true")) return;
  const nextValue = clamp(numeric(value)).toFixed(4).replace(/\.?0+$/, "");
  input.value = nextValue === "" ? "0" : nextValue;
  input.dataset.dirty = "false";
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
  if (!state.deployed) return { ok: false, amount, message: "Prepare the runtime before submitting transactions." };
  if (amount <= 0) return { ok: false, amount, message: "Enter an amount greater than zero." };

  if (action === "lock") {
    if (amount > state.bankA) return { ok: false, amount, message: "Amount exceeds the Bank A balance." };
    return { ok: true, amount, message: "Ready to lock collateral on Bank A." };
  }

  if (action === "borrow") {
    if (state.collateral <= 0) return { ok: false, amount, message: "Deposit voucher collateral before borrowing." };
    if (amount > state.availableBorrow) return { ok: false, amount, message: "Amount exceeds available borrowing power." };
    if (amount > state.poolCash) return { ok: false, amount, message: "Amount exceeds current pool cash." };
    return { ok: true, amount, message: "Borrow request is inside current risk limits." };
  }

  if (action === "repay") {
    if (state.debt <= 0) return { ok: false, amount, message: "There is no outstanding debt to repay." };
    if (amount > state.debt) return { ok: false, amount, message: "Amount is greater than outstanding debt." };
    if (amount > state.bankB) return { ok: false, amount, message: "Amount exceeds the borrower bCASH balance." };
    return { ok: true, amount, message: "Repayment can be submitted." };
  }

  if (action === "withdrawCollateral") {
    if (state.collateral <= 0) return { ok: false, amount, message: "There is no deposited collateral to withdraw." };
    if (amount > state.collateral) return { ok: false, amount, message: "Amount exceeds deposited collateral." };
    if (amount > state.withdrawable) return { ok: false, amount, message: "Withdrawal would make the position unhealthy." };
    return { ok: true, amount, message: "Withdrawal keeps the position within current limits." };
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
      ? `${formatAmount(state.voucher, "vA")} voucher balance ready.`
      : state.collateral > 0
        ? `${formatAmount(state.collateral, "vA")} already deposited.`
        : "Waiting for a verified voucher."
  );

  const bridgeAmount = inputValue("bridgeAmount");
  setText("bridgePreviewAmount", formatAmount(bridgeAmount, "aBANK"));
  setText("bridgePreviewVoucher", formatAmount(state.voucher + bridgeAmount, "vA"));
  setText(
    "bridgePreviewNote",
    bridgeAmount > 0
      ? "After proof verification, the voucher is ready for collateral use on Bank B."
      : "Verification will make this collateral usable on Bank B."
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
  bankBBalance: "Borrowed bCASH",
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
    openRoute: "Opened IBC connection and channel",
    lock: "Locked aBANK and committed packet",
    finalizeForwardHeader: "Read Bank A Besu header",
    updateForwardClient: "Imported Bank A header on Bank B",
    proveForwardMint: "Executed forward storage proof",
    depositCollateral: "Deposited voucher collateral",
    borrow: "Borrowed Bank B credit",
    repay: "Repaid Bank B credit",
    withdrawCollateral: "Withdrew voucher collateral",
    burn: "Burned voucher on Bank B",
    finalizeReverseHeader: "Read Bank B Besu header",
    updateReverseClient: "Imported Bank B header on Bank A",
    proveReverseUnlock: "Executed reverse storage proof",
    freezeClient: "Submitted conflicting header",
    recoverClient: "Recovered frozen light client",
    replayForward: "Attempted forward replay",
    verifyTimeoutAbsence: "Verified timeout absence",
    fullFlow: "Completed cross-chain lending flow",
    deploySeed: "Prepared or reused runtime",
    resetSeeded: "Fresh reset to seeded baseline",
    refresh: "Refreshed live state",
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
    renderStatus(payload.status);
    refreshTransactionUi(payload.status, { forceDefaults: true });
    pushActivity("deploySeed", "The interchain lending runtime is ready for live demo actions.", payload.status);
    currentStatus = payload.status;
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
    renderStatus(payload.status);
    refreshTransactionUi(payload.status, { forceDefaults: true });
    pushActivity("resetSeeded", "A fresh interchain lending runtime was deployed and seeded for a clean demo baseline.", payload.status);
    currentStatus = payload.status;
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

deploySeedButton?.addEventListener("click", runDeploySeed);
resetSeededButton?.addEventListener("click", runResetSeeded);
focusModeButton?.addEventListener("click", () => {
  setFocusMode(!document.body.classList.contains("is-focus-mode"));
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

amountInputs.forEach((input) => {
  input.dataset.dirty = "false";
  input.addEventListener("input", () => {
    input.dataset.dirty = "true";
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
    target.value = clamp(values[button.dataset.fillSource] ?? 0).toFixed(4).replace(/\.?0+$/, "") || "0";
    target.dataset.dirty = "true";
    refreshTransactionUi(currentStatus);
  });
});

try {
  setFocusMode(sessionStorage.getItem(FOCUS_MODE_STORAGE_KEY) === "true");
} catch {
  setFocusMode(false);
}

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
