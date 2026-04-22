import { markControllerOffline, renderLatestActivity, renderRoadmap, renderStatus, setText } from "./demo-status-view.js";

const buttons = [...document.querySelectorAll("button")];
const actionButtons = [...document.querySelectorAll("[data-action]")];
const deploySeedButton = document.getElementById("deploySeed");
const resetSeededButton = document.getElementById("resetSeeded");
const refreshButton = document.getElementById("refreshState");
const focusModeButton = document.getElementById("focusMode");
const ACTIVITY_STORAGE_KEY = "interchain-lending-latest-activity";
const FOCUS_MODE_STORAGE_KEY = "interchain-lending-focus-mode";
const CLIENT_STATUS = ["Uninitialized", "Active", "Frozen", "Recovering"];
const SAFETY_MODE_ACTIONS = new Set(["recoverClient"]);
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

async function runAction(action) {
  setBusy(true);
  const title = actionTitle(action);
  setText("lastMessage", `Running ${title}...`);
  setOutput(`Calling action: ${title}`);
  try {
    const payload = await requestJson("/api/action", {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    renderStatus(payload.status);
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
