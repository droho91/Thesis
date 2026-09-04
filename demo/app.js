import {
  createActionRequestStore,
  requestOutcomeUncertain,
} from "./action-request.js";
import {
  LENDING_MODES,
  healthPresentation,
  isSmallBalance,
  lendingSubmissionAction,
  tokenUnits,
  validateAction,
} from "./lending-domain.js";
import {
  compactAmount,
  evidenceSourceStateLabel,
  evidenceStepLabel,
  evidenceVerdictPresentation,
  formatBps,
  formatDurationMs,
  formatInteger,
  formatTimestamp,
  shortHash,
  titleCase,
} from "./ui-presentation.js";
import {
  ACTION_TAB,
  STAGE_ORDER,
  actionIcon,
  actionStage,
  operationName,
  operationProgressCopy,
} from "./workflow-presentation.js";
import {
  minTokenAmount,
  normalizeTokenAmount,
} from "./token-amount.js";
import { nextTabIndex } from "./tab-keyboard.js";

const LINKY_IMAGES = Object.freeze({
  guide: "/assets/linky/generated/states/linky-guide.png",
  processing: "/assets/linky/generated/states/linky-processing.png",
  success: "/assets/linky/generated/states/linky-success.png",
  caution: "/assets/linky/generated/states/linky-caution.png",
  neutral: "/assets/linky/generated/states/linky-neutral.png",
  identityScan: "/assets/linky/generated/moments/linky-identity-scan.png",
  finalityWatch: "/assets/linky/generated/moments/linky-finality-watch.png",
  quorumCollect: "/assets/linky/generated/moments/linky-quorum-collect.png",
  proofInspect: "/assets/linky/generated/moments/linky-proof-inspect.png",
  voucherDeliver: "/assets/linky/generated/moments/linky-voucher-deliver.png",
  collateralDeposit: "/assets/linky/generated/moments/linky-collateral-deposit.png",
  creditGuide: "/assets/linky/generated/moments/linky-credit-guide.png",
  debtRepay: "/assets/linky/generated/moments/linky-debt-repay.png",
  collateralWithdraw: "/assets/linky/generated/moments/linky-collateral-withdraw.png",
  settlementUnlock: "/assets/linky/generated/moments/linky-settlement-unlock.png",
  evidenceAudit: "/assets/linky/generated/moments/linky-evidence-audit.png",
});
const LINKY_SLOTS = Object.freeze({
  identity: "linkyIdentityImage",
  transfer: "linkyTransferImage",
  lending: "linkyLendingImage",
  settlement: "linkySettlementImage",
  evidence: "linkyEvidenceImage",
});

const RUNTIME_STATUS_FIELDS = Object.freeze([
  "identityAStatus",
  "identityBStatus",
  "identityGovernance",
  "identityQuorum",
]);
const STATUS_TONE_CLASSES = Object.freeze([
  "is-verified",
  "is-review",
  "is-warning",
  "is-error",
  "is-ready",
]);
const EVIDENCE_REFRESH_INTERVAL_MS = 30_000;

let currentStatus = null;
let currentEvidence = null;
let currentTab = "identity";
let lendingMode = "deposit";
let busyAction = null;
let refreshTimer = null;
let evidenceRefreshedAt = 0;
let csrfToken = null;
let csrfBootstrapPromise = null;
const disclosureHideTimers = new WeakMap();
const actionRequests = createActionRequestStore({
  getStorage: () => window.sessionStorage,
  randomId: () => window.crypto?.randomUUID?.() || `request-${Date.now()}-${Math.random().toString(16).slice(2)}`,
});

initialize();

async function initialize() {
  window.lucide?.createIcons();
  bindNavigation();
  bindForms();
  bindControls();
  bindStatusControls();
  openTab(new URLSearchParams(window.location.search).get("tab") || "identity");
  await Promise.all([
    refreshStatus({ announceError: true }),
    refreshFormalEvidence(),
    csrfTokenForAction().catch((error) => {
      toast(`Action security unavailable: ${error.message}`, "error");
      return null;
    }),
  ]);
  scheduleRefresh();
}

function bindNavigation() {
  const workflowTablist = document.querySelector(".journey[role='tablist']");
  bindRovingTablist(workflowTablist, ".journey-step[role='tab']", activateWorkflowTab);
  const lendingTablist = document.querySelector(".segmented-control[role='tablist']");
  bindRovingTablist(lendingTablist, "[data-lending-mode][role='tab']", activateLendingTab);

  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => openTab(button.dataset.tab, { focusTab: true }));
  });
  document.querySelectorAll("[data-tab-target]:not([role='tab'])").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.lendingModeTarget) {
        setLendingMode(button.dataset.lendingModeTarget, { primeAmount: true });
      }
      openTab(button.dataset.tabTarget, { focusTab: true });
    });
  });
}

function bindRovingTablist(tablist, tabSelector, activate) {
  if (!tablist) return;
  tablist.querySelectorAll(tabSelector).forEach((tab) => {
    tab.addEventListener("click", () => activate(tab));
  });
  tablist.addEventListener("keydown", (event) => {
    const current = event.target.closest?.(tabSelector);
    if (!current || !tablist.contains(current)) return;
    const tabs = [...tablist.querySelectorAll(tabSelector)].filter((tab) => !tab.disabled);
    const currentIndex = tabs.indexOf(current);
    if (currentIndex < 0) return;
    const targetIndex = nextTabIndex(event.key, currentIndex, tabs.length);
    if (targetIndex == null) return;
    event.preventDefault();
    activate(tabs[targetIndex], { focus: true });
  });
}

function activateWorkflowTab(tab, { focus = false } = {}) {
  if (tab.disabled) return;
  if (tab.dataset.lendingModeTarget) {
    setLendingMode(tab.dataset.lendingModeTarget, { primeAmount: true });
  }
  openTab(tab.dataset.tabTarget);
  if (focus) tab.focus({ preventScroll: true });
}

function activateLendingTab(tab, { focus = false } = {}) {
  if (tab.disabled) return;
  setLendingMode(tab.dataset.lendingMode, { primeAmount: true });
  if (focus) tab.focus({ preventScroll: true });
}

function bindForms() {
  document.querySelectorAll("[data-operation-form]").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const action = form === element("lendingForm")
        ? lendingSubmissionAction(lendingMode, currentStatus)
        : form.dataset.operationForm;
      const input = form.querySelector("input[name='amount']");
      await submitAction(action, input?.value, form);
    });
  });
  document.querySelectorAll(".amount-input input").forEach((input) => {
    input.addEventListener("input", () => {
      input.dataset.dirty = "true";
      if (input.getAttribute("aria-invalid") === "true") {
        setFormMessage(input.closest("form"), "");
      }
      renderAvailability();
    });
  });
}

function bindControls() {
  element("refreshButton").addEventListener("click", () => Promise.all([
    refreshStatus({ announceError: true }),
    refreshFormalEvidence({ announceError: true }),
  ]));
  element("lendingMaxButton").addEventListener("click", () => {
    setInputAmount(element("lendingAmount"), LENDING_MODES[lendingMode].limit(currentStatus), true);
    renderAvailability();
  });
  document.querySelectorAll("[data-fill]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = element(button.dataset.input);
      setInputAmount(input, currentStatus?.balances?.[button.dataset.fill] || "0", true);
      renderAvailability();
    });
  });
  element("copyEvidenceButton").addEventListener("click", copyLatestEvidence);
}

function bindStatusControls() {
  const runtimeButton = element("runtimeStatus");
  const runtimeControl = runtimeButton.closest(".runtime-status-control");
  runtimeButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = !runtimeControl.classList.contains("is-open");
    setRuntimePopoverOpen(open, { focus: open });
  });
  document.querySelectorAll("[data-status-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const card = button.closest(".readiness-card");
      const open = !card.classList.contains("is-status-open");
      closeStatusDetails({ except: open ? button : null });
      setStatusDetailOpen(button, open);
    });
  });
  document.addEventListener("click", (event) => {
    if (!runtimeControl.contains(event.target)) {
      setRuntimePopoverOpen(false);
    }
    if (!event.target.closest?.(".readiness-card")) closeStatusDetails();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const focusedDisclosure = document.activeElement?.matches?.("[aria-expanded='true']")
      ? document.activeElement
      : null;
    const expandedStatus = document.querySelector("[data-status-toggle][aria-expanded='true']");
    const runtimeWasOpen = runtimeButton.getAttribute("aria-expanded") === "true";
    setRuntimePopoverOpen(false);
    closeStatusDetails();
    const restoreTarget = focusedDisclosure
      || expandedStatus
      || (runtimeWasOpen ? runtimeButton : null);
    restoreTarget?.focus({ preventScroll: true });
  });
}

function setRuntimePopoverOpen(open, { focus = false } = {}) {
  const button = element("runtimeStatus");
  const control = button.closest(".runtime-status-control");
  const popover = element("runtimePopover");
  button.setAttribute("aria-expanded", String(open));
  setDisclosureVisibility(popover, open, 250);
  control.classList.toggle("is-open", open);
  if (open && focus) popover.focus({ preventScroll: true });
}

function setStatusDetailOpen(button, open) {
  const card = button.closest(".readiness-card");
  const detail = element(button.getAttribute("aria-controls"));
  button.setAttribute("aria-expanded", String(open));
  setDisclosureVisibility(detail, open, 320);
  card.classList.toggle("is-status-open", open);
}

function closeStatusDetails({ except = null } = {}) {
  document.querySelectorAll("[data-status-toggle][aria-expanded='true']").forEach((button) => {
    if (button !== except) setStatusDetailOpen(button, false);
  });
}

function setDisclosureVisibility(disclosure, visible, transitionMs) {
  if (!disclosure) return;
  const pendingHide = disclosureHideTimers.get(disclosure);
  if (pendingHide) clearTimeout(pendingHide);
  disclosureHideTimers.delete(disclosure);
  disclosure.toggleAttribute("inert", !visible);
  if (visible) {
    disclosure.hidden = false;
    return;
  }
  const timer = setTimeout(() => {
    disclosure.hidden = true;
    disclosureHideTimers.delete(disclosure);
  }, transitionMs);
  disclosureHideTimers.set(disclosure, timer);
}

async function refreshStatus({ announceError = false } = {}) {
  const refreshButton = element("refreshButton");
  refreshButton.classList.add("is-spinning");
  refreshButton.setAttribute("aria-busy", "true");
  setSemanticDisabled(refreshButton, true);
  try {
    const status = await requestJson("/api/status", { timeoutMs: 15_000 });
    currentStatus = status;
    renderStatus(status);
  } catch (error) {
    currentStatus = null;
    renderRuntimeFailure(error.message);
    if (announceError) toast(error.message, "error");
  } finally {
    refreshButton.classList.remove("is-spinning");
    refreshButton.setAttribute("aria-busy", "false");
    setSemanticDisabled(refreshButton, false);
  }
}

async function refreshFormalEvidence({ announceError = false } = {}) {
  try {
    currentEvidence = await requestJson("/api/evidence", { timeoutMs: 10_000 });
    renderFormalEvidence(currentEvidence);
  } catch (error) {
    currentEvidence = { available: false, status: "unavailable", message: error.message };
    renderFormalEvidence(currentEvidence);
    if (announceError) toast(`Evidence report: ${error.message}`, "error");
  } finally {
    evidenceRefreshedAt = Date.now();
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    const evidenceDue = currentTab === "evidence"
      && Date.now() - evidenceRefreshedAt >= EVIDENCE_REFRESH_INTERVAL_MS;
    await Promise.all([
      refreshStatus(),
      evidenceDue ? refreshFormalEvidence() : Promise.resolve(),
    ]);
    scheduleRefresh();
  }, busyAction || currentStatus?.controller?.busy ? 1_500 : 5_000);
}

async function submitAction(action, requestedAmount, form) {
  if (busyAction || currentStatus?.controller?.busy) {
    return setFormMessage(form, "Another institutional operation is still settling.", "error");
  }
  const validation = validateAction(action, requestedAmount, currentStatus);
  if (!validation.ok) return setFormMessage(form, validation.message, "error");

  let request;
  try {
    request = actionRequests.get(action, validation.value);
  } catch (error) {
    return setFormMessage(form, error.message, "error");
  }

  busyAction = action;
  let focusTabAfterCompletion = false;
  setBusy(true, action);
  setFormMessage(form, operationProgressCopy(action));
  renderLinkyProcessing(action);
  try {
    const payload = await requestActionJson(request);
    clearActionRequest(action);
    currentStatus = payload.status;
    setFormMessage(form, `${operationName(action)} completed on-chain.`, "success");
    toast(`${operationName(action)} completed`, "success");
    renderStatus(currentStatus);
    if (["bridge", "return"].includes(action)) {
      openTab(action === "bridge" ? "lending" : "evidence");
      focusTabAfterCompletion = true;
    }
  } catch (error) {
    if (!requestOutcomeUncertain(error)) clearActionRequest(action);
    setFormMessage(form, error.message, "error");
    toast(error.message, "error");
    await refreshStatus();
  } finally {
    busyAction = null;
    setBusy(false);
    renderAvailability();
    if (focusTabAfterCompletion) syncWorkflowTabState()?.focus({ preventScroll: true });
    scheduleRefresh();
  }
}

function renderStatus(status) {
  renderRuntime(status);
  if (!status?.runtimeReadable) {
    renderUnavailable(status);
    return;
  }
  renderOverview(status);
  renderIdentity(status);
  renderRoute(status);
  renderLending(status);
  renderSettlement(status);
  renderEvidence(status);
  renderJourney(status);
  renderOperationProgress(status);
  renderLinky(status);
  renderAvailability();
  primeEmptyInputs(status);
}

function renderRuntime(status) {
  const runtime = element("runtimeStatus");
  runtime.classList.toggle("is-ready", Boolean(status?.laneReady));
  runtime.classList.toggle("is-error", !status?.runtimeReadable);
  setText("runtimeStatusLabel", status?.laneReady ? "Lane ready" : status?.runtimeReadable ? "Lane review" : "Runtime unavailable");
  setText("runtimePopoverState", status?.runtimeReadable ? "Runtime snapshot available" : "Attention required");
  const runtimeReadable = Boolean(status?.runtimeReadable);
  setText("runtimeChainSummary", runtimeReadable
    ? status.chainsProgressing ? "Progressing" : "Progress check pending"
    : "Runtime is not readable");
  setText("runtimeChainA", `A #${formatInteger(status?.chains?.A?.blockNumber)}`);
  setText("runtimeChainB", `B #${formatInteger(status?.chains?.B?.blockNumber)}`);
  setText("runtimeQuorumSummary", runtimeReadable
    ? status.attestorQuorumReady ? "Quorum ready" : "Quorum unavailable"
    : "Checkpoint services unavailable");
  setText("runtimeAttestorCount", `${status?.relay?.activeAttestors || 0}/${status?.topology?.configuredAttestors || "-"} attestors`);
  setText("runtimeRelayState", `Relay ${status?.relayerHealthy ? "healthy" : "review"}`);
  ["runtimeChainA", "runtimeChainB", "runtimeAttestorCount", "runtimeRelayState"].forEach((id) => {
    element(id).hidden = !runtimeReadable;
  });
  setText("runtimeGeneratedAt", status?.generatedAt ? formatTimestamp(status.generatedAt) : "Waiting");
}

function renderUnavailable(status) {
  clearRuntimeSnapshot();
  renderOverviewMessage(status?.message || "Institutional runtime is not available.");
  const readiness = element("readinessVerdict");
  readiness?.classList.add("is-review");
  const readinessPill = element("readinessPill");
  if (readinessPill?.lastChild) readinessPill.lastChild.textContent = "Unavailable";
  setText("readinessTitle", "Runtime unavailable");
  setText("readinessCopy", status?.message || "Run the preparation command before opening operations.");
  renderUnavailableLinkyMoments();
  document.querySelectorAll("form .primary-button").forEach((button) => setSemanticDisabled(button, true));
  renderAvailability();
}

function renderRuntimeFailure(message) {
  const unavailable = { ready: false, laneReady: false, runtimeReadable: false, message };
  renderRuntime(unavailable);
  clearRuntimeSnapshot();
  renderOverviewMessage(message);
  renderUnavailableLinkyMoments();
  document.querySelectorAll("form .primary-button").forEach((button) => setSemanticDisabled(button, true));
  renderAvailability();
}

function renderOverview(status) {
  const health = healthPresentation(status);
  setText("canonicalBalance", compactAmount(status.balances.canonicalAvailable));
  setText("collateralBalance", compactAmount(status.balances.activeCollateral));
  setText("debtBalance", compactAmount(status.balances.outstandingDebt));
  setText("healthFactor", health.value);
  setText("healthLabel", health.label);
  setText("overviewChainABlock", `#${formatInteger(status.chains.A.blockNumber)}`);
  setText("overviewChainBBlock", `#${formatInteger(status.chains.B.blockNumber)}`);
  element("overviewMessage").hidden = true;
  element("overviewChainHeights").hidden = false;
}

function renderOverviewMessage(message) {
  setText("overviewMessage", message);
  element("overviewMessage").hidden = false;
  element("overviewChainHeights").hidden = true;
}

function renderIdentity(status) {
  const identityA = status.participants?.identity?.A;
  const identityB = status.participants?.identity?.B;
  const identitiesReady = Boolean(status.identitiesEligible);
  const governanceReady = Boolean(status.governanceEnforced);
  const quorumReady = Boolean(status.attestorQuorumReady);
  const ready = Boolean(status.laneReady);
  const readiness = element("readinessVerdict");
  readiness.classList.toggle("is-review", !ready);
  const pill = element("readinessPill");
  pill.classList.toggle("is-warning", !ready);
  pill.lastChild.textContent = ready ? "Ready" : "Review";
  setText("readinessTitle", ready ? "Ready to transfer" : "Review required");
  setText(
    "readinessCopy",
    ready
      ? "Participants and required controls are ready."
      : status.message || "Open the affected check below.",
  );
  setText("identityAStatus", identityA?.active ? "Active" : titleCase(identityA?.label || "review"));
  setText("identityBStatus", identityB?.active ? "Active" : titleCase(identityB?.label || "review"));
  setStatusTone("identityAStatus", identityA?.active);
  setStatusTone("identityBStatus", identityB?.active);
  setText("identityAAccount", shortHash(status.participants?.sourceCustomer || "-"));
  setText("identityBAccount", shortHash(status.participants?.destinationCustomer || "-"));
  setText("identityGovernance", governanceReady ? "Enforced" : "Review");
  setStatusTone("identityGovernance", governanceReady);
  setText(
    "identityGovernanceDelay",
    `${status.governance?.delaySeconds?.A || "-"}s Bank A · ${status.governance?.delaySeconds?.B || "-"}s Bank B`,
  );
  setText(
    "identityQuorum",
    `${status.relay?.activeAttestors || 0} active · ${status.topology?.attestorThreshold || "-"} required`,
  );
  setStatusTone("identityQuorum", quorumReady);
  setText(
    "identityValidatorTopology",
    `${status.topology?.validatorsPerChain || "-"} validators per chain · ${status.topology?.toleratedFaultsPerChain || 0} unavailable-validator tolerance`,
  );
  renderLinkyMoment("identity", ready ? "identityScan" : "caution");
}

function setStatusTone(id, verified) {
  const button = element(id)?.closest(".status-button");
  if (!button) return;
  button.classList.remove(...STATUS_TONE_CLASSES);
  button.classList.add(verified ? "is-verified" : "is-review");
}

function renderRoute(status) {
  setText("routeCanonical", `${compactAmount(status.balances.canonicalAvailable)} aBANK`);
  setText("routeVoucher", `${compactAmount(status.balances.voucherAvailable)} vA`);
  setText("bridgeAvailable", `${compactAmount(status.balances.canonicalAvailable)} aBANK`);
  setText(
    "relayRouteStatus",
    status.relayerHealthy && status.attestorQuorumReady
      ? `Relay healthy · ${status.relay.activeAttestors} attestors listening`
      : "Relay or attestor quorum requires review",
  );
  setText("finalityDepth", `${status.topology?.finalityDepth || 2} blocks after inclusion`);
  setText("attestorQuorum", `${status.topology.attestorThreshold} of ${status.topology.configuredAttestors}`);
}

function renderOperationProgress(status) {
  const pipeline = element("transferPipeline");
  if (!pipeline) return;
  const steps = [...pipeline.querySelectorAll("[data-proof-step]")];
  steps.forEach((step) => step.classList.remove("is-active", "is-complete"));

  const active = status.controller?.activeOperation;
  const latest = status.activity?.latest;
  const latestJob = status.relay?.latestJob;
  if (!active || active.action !== "bridge") {
    pipeline.classList.remove("is-processing");
    if (latest?.action === "bridge" && latest.status === "completed") {
      steps.forEach((step) => step.classList.add("is-complete"));
      pipeline.setAttribute("aria-label", "Transfer proof pipeline completed");
      renderLinkyMoment("transfer", "voucherDeliver");
      setTransferLinkyProgress(100, { visible: true, complete: true });
    } else {
      pipeline.setAttribute("aria-label", "Transfer proof pipeline idle");
      renderLinkyMoment("transfer", "finalityWatch");
      setTransferLinkyProgress(0, { visible: false });
    }
    return;
  }

  pipeline.classList.add("is-processing");
  const relayState = latestJob?.messageId === active.messageId ? latestJob.state : null;
  let activeIndex = active.sourceTransaction ? 1 : 0;
  if (relayState === "source_checkpointed") activeIndex = 2;
  if (["received", "destination_checkpointed"].includes(relayState)) activeIndex = 3;
  if (relayState === "completed") activeIndex = steps.length;
  steps.forEach((step, index) => {
    step.classList.toggle("is-complete", index < activeIndex || activeIndex === steps.length);
    step.classList.toggle("is-active", index === activeIndex && activeIndex < steps.length);
  });
  const progressCopy = {
    preflight: "Running institutional preflight",
    prepared: "Preparing governed transfer",
    "source-confirmation": "Confirming Bank A source transaction",
    "attestor-quorum": relayState ? `Relay state: ${titleCase(relayState)}` : "Collecting checkpoint quorum",
    "reconciling-transaction": "Reconciling source transaction",
    "reconciling-relay": relayState ? `Relay state: ${titleCase(relayState)}` : "Reconciling relay result",
  };
  const progress = progressCopy[active.stage] || titleCase(active.stage);
  setText("relayRouteStatus", progress);
  pipeline.setAttribute("aria-label", `Transfer proof pipeline: ${progress}`);
  const pose = ["finalityWatch", "quorumCollect", "proofInspect", "voucherDeliver"][Math.min(activeIndex, 3)];
  renderLinkyMoment("transfer", pose, { processing: activeIndex < steps.length });
  setTransferLinkyProgress(
    activeIndex === steps.length ? 100 : Math.min(88, 13 + (activeIndex * 25)),
    { visible: true, complete: activeIndex === steps.length },
  );
}

function setTransferLinkyProgress(value, { visible, complete = false }) {
  const progress = element("linkyTransferProgress");
  if (!progress) return;
  const normalized = Math.max(0, Math.min(100, value));
  progress.hidden = !visible;
  progress.setAttribute("aria-valuenow", String(normalized));
  progress.classList.toggle("is-complete", complete);
  progress.querySelector("span").style.width = `${normalized}%`;
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
  setText("originationPrincipal", `${compactAmount(risk.originationPrincipalDebt)} bCASH`);
  setText(
    "accrualState",
    risk.accrualCatchUpRequired ? `Catch-up required (${risk.accrualBatchesRequired} batches)` : "Current for actions",
  );
  setText("creditStatus", risk.accountDefaulted ? "Defaulted — borrowing frozen" : "Eligible");

  const health = healthPresentation(status);
  setText("riskHealthLabel", health.longLabel);
  const fill = element("riskMeterFill");
  fill.style.width = `${100 - health.meter}%`;
  const meter = fill.closest(".meter-track");
  meter.style.setProperty("--health-position", `${Math.min(99, Math.max(1, health.meter))}%`);
  meter.dataset.tone = health.tone;
  renderLendingLinkyMoment();
}

function renderLendingLinkyMoment() {
  const pose = {
    deposit: "collateralDeposit",
    borrow: "creditGuide",
    repay: "debtRepay",
    withdraw: "collateralWithdraw",
  }[lendingMode] || "creditGuide";
  renderLinkyMoment("lending", pose, {
    processing: ["deposit", "borrow", "repay", "repayAll", "withdraw"].includes(busyAction),
  });
}

function renderSettlement(status) {
  setText("returnVoucherBalance", `${compactAmount(status.balances.voucherAvailable)} vA`);
  setText("returnCanonicalBalance", `${compactAmount(status.balances.canonicalAvailable)} aBANK`);
  setText("returnAvailable", `${compactAmount(status.balances.voucherAvailable)} vA`);
  const debt = tokenUnits(status.balances.outstandingDebt);
  const collateral = tokenUnits(status.balances.activeCollateral);
  const guard = element("settlementGuardTitle")?.closest(".settlement-guard");
  guard?.classList.toggle("is-ready", debt === 0n && collateral === 0n);
  if (debt > 0) {
    renderLinkyMoment("settlement", "debtRepay");
    setText("settlementGuardTitle", "Outstanding debt remains");
    setText(
      "settlementGuardCopy",
      isSmallBalance(status) ? "Settle the small remaining balance before withdrawing and returning collateral." : "Repay Bank B debt before withdrawing and returning collateral.",
    );
  } else if (collateral > 0) {
    renderLinkyMoment("settlement", "collateralWithdraw");
    setText("settlementGuardTitle", "Collateral is still active");
    setText("settlementGuardCopy", "Withdraw voucher collateral from the lending pool before settlement.");
  } else {
    renderLinkyMoment("settlement", "settlementUnlock", { processing: busyAction === "return" });
    setText("settlementGuardTitle", "Position is clear");
    setText("settlementGuardCopy", "Free voucher can be burned and released from Bank A custody.");
  }
}

function renderEvidence(status) {
  const topology = status.topology;
  setText("validatorEvidence", `${topology.validatorsPerChain || "-"} validators per chain`);
  setText(
    "faultEvidence",
    topology.toleratedFaultsPerChain > 0
      ? `Configured for ${topology.toleratedFaultsPerChain} unavailable validator`
      : "No validator-unavailability tolerance configured",
  );
  setText("quorumEvidence", `${topology.attestorThreshold}-of-${topology.configuredAttestors}`);
  setText("attestorEvidence", `${status.relay.activeAttestors} local attestor endpoints listening`);
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
  renderFormalEvidence(currentEvidence);
  renderActivity(status.activity?.history || []);
}

function renderFormalEvidence(evidence) {
  const verdict = element("evidenceVerdict");
  verdict.classList.remove("is-warning", "is-error");
  if (!evidence?.available) {
    renderLinkyMoment("evidence", "caution");
    verdict.classList.add("is-warning");
    setText("evidenceVerdictLabel", "VALIDATION EVIDENCE NOT AVAILABLE");
    setText("evidenceVerdictTitle", "Generate an isolated evidence run");
    setText("evidenceVerdictCopy", evidence?.message || "Run npm run institutional:evidence before the defense.");
    setText("evidenceSourceState", "No recorded source");
    setText("evidenceCommit", "-");
    setText("evidenceGeneratedAt", "-");
    setText("benchmarkSamples", "-");
    setText("proofAckP95", "-");
    setText("proofAckTarget", "target -");
    setText("endToEndP95", "-");
    setText("securityControlCount", "-");
    setText("integrationEvidenceCount", "Not available");
    setText("securityEvidenceCount", "Not available");
    renderEvidenceEntries("integrationEvidenceList", [], "No integration evidence is available.");
    renderEvidenceEntries("securityEvidenceList", [], "No security evidence is available.");
    setText("evidenceStepStatus", "Missing");
    return;
  }

  const presentation = evidenceVerdictPresentation(evidence);
  renderLinkyMoment("evidence", presentation.currentPass ? "evidenceAudit" : "caution");
  if (presentation.tone === "warning") verdict.classList.add("is-warning");
  else if (presentation.tone === "error") verdict.classList.add("is-error");
  setText("evidenceVerdictLabel", presentation.label);
  setText("evidenceVerdictTitle", presentation.title);
  setText("evidenceVerdictCopy", presentation.copy);
  setText("evidenceSourceState", evidenceSourceStateLabel(evidence));
  setText("evidenceCommit", evidence.provenance?.recordedCommitShort || "-");
  setText("evidenceGeneratedAt", evidence.generatedAt ? formatTimestamp(evidence.generatedAt) : "-");

  const benchmark = evidence.benchmark || {};
  setText("benchmarkSamples", formatInteger(benchmark.sampleCount));
  setText("proofAckP95", formatDurationMs(benchmark.postSourceInclusionToCompletionP95Ms));
  setText("proofAckTarget", `target < ${formatDurationMs(benchmark.targetP95Ms)}`);
  setText("endToEndP95", formatDurationMs(benchmark.endToEndP95Ms));
  setText("securityControlCount", `${evidence.security?.passed || 0}/${evidence.security?.total || 0}`);
  setText("integrationEvidenceCount", `${evidence.integration?.passed || 0}/${evidence.integration?.total || 0} passed`);
  setText("securityEvidenceCount", `${evidence.security?.passed || 0}/${evidence.security?.total || 0} passed`);
  renderIntegrationEvidence(evidence.integration?.tests || []);
  renderSecurityEvidence(evidence.security?.scenarios || []);
  setText("evidenceStepStatus", evidenceStepLabel(evidence));
}

function renderIntegrationEvidence(tests) {
  const list = element("integrationEvidenceList");
  list.replaceChildren();
  if (!tests.length) return renderEvidenceEntries("integrationEvidenceList", [], "No integration evidence is available.");
  tests.forEach((test) => {
    const item = document.createElement("div");
    item.className = `integration-evidence-item${test.status === "passed" ? " is-passed" : " is-failed"}`;
    const icon = document.createElement("i");
    icon.dataset.lucide = test.status === "passed" ? "circle-check" : "circle-alert";
    const copy = document.createElement("div");
    const title = document.createElement("b");
    title.textContent = test.title;
    const detail = document.createElement("small");
    detail.textContent = test.status === "passed" ? "Recorded as passed in isolated runtime" : "Requires review";
    copy.append(title, detail);
    item.append(icon, copy);
    list.append(item);
  });
  window.lucide?.createIcons();
}

function renderSecurityEvidence(scenarios) {
  const list = element("securityEvidenceList");
  list.replaceChildren();
  if (!scenarios.length) return renderEvidenceEntries("securityEvidenceList", [], "No security evidence is available.");
  scenarios.forEach((scenario) => {
    const item = document.createElement("article");
    item.className = `security-evidence-item${scenario.status === "passed" ? " is-passed" : " is-failed"}`;
    const heading = document.createElement("div");
    const id = document.createElement("span");
    id.textContent = scenario.id;
    const title = document.createElement("b");
    title.textContent = scenario.title;
    const state = document.createElement("strong");
    state.textContent = scenario.status === "passed" ? "Passed" : "Review";
    heading.append(id, title, state);
    const control = document.createElement("p");
    control.textContent = scenario.control;
    item.append(heading, control);
    list.append(item);
  });
}

function renderEvidenceEntries(id, entries, emptyCopy) {
  const list = element(id);
  list.replaceChildren();
  if (entries.length) return;
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = emptyCopy;
  list.append(empty);
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
  const recommendedIndex = Math.max(0, STAGE_ORDER.indexOf(stage));
  const history = status.activity?.history || [];
  const hasAction = (action) => history.some((entry) => entry.action === action && entry.status === "completed");
  const transferObserved = hasAction("bridge") || tokenUnits(status.balances.escrowed) > 0n || tokenUnits(status.balances.voucherAvailable) > 0n || tokenUnits(status.balances.activeCollateral) > 0n;
  const lendingObserved = hasAction("deposit") || tokenUnits(status.balances.activeCollateral) > 0n || tokenUnits(status.balances.outstandingDebt) > 0n;
  setText("identityStepStatus", status.participants.identity.A.active && status.participants.identity.B.active ? "Active" : "Review");
  setText("transferStepStatus", transferObserved ? "Settled" : stage === "transfer" ? "Ready" : "Waiting");
  setText("lendingStepStatus", lendingObserved ? "Active" : stage === "lend" ? "Ready" : "Waiting");
  setText("positionStepStatus", tokenUnits(status.balances.outstandingDebt) > 0n ? "Open" : hasAction("borrow") ? "Repaid" : "Waiting");
  setText("returnStepStatus", hasAction("return") ? "Settled" : stage === "return" ? "Ready" : "Waiting");
  setText("evidenceStepStatus", evidenceStepLabel(currentEvidence));

  const viewingStage = stageForCurrentView();
  document.querySelectorAll(".journey-step").forEach((step, index) => {
    const active = step.dataset.stage === viewingStage;
    step.classList.toggle("is-active", active);
    step.classList.toggle("is-recommended", index === recommendedIndex);
    step.classList.toggle("is-complete", index < recommendedIndex || (index === 0 && status.participants.identity.A.active && status.participants.identity.B.active));
    if (active) step.setAttribute("aria-current", "step");
    else step.removeAttribute("aria-current");
  });
}

function renderLinky() {
  hydrateVisibleLinkyMoments();
}

function renderLinkyProcessing(action) {
  const moment = {
    bridge: ["transfer", "finalityWatch"],
    deposit: ["lending", "collateralDeposit"],
    borrow: ["lending", "creditGuide"],
    repay: ["lending", "debtRepay"],
    repayAll: ["lending", "debtRepay"],
    withdraw: ["lending", "collateralWithdraw"],
    return: ["settlement", "settlementUnlock"],
  }[action];
  if (moment) renderLinkyMoment(moment[0], moment[1], { processing: true });
}

function renderUnavailableLinkyMoments() {
  Object.keys(LINKY_SLOTS).forEach((slot) => renderLinkyMoment(slot, "caution"));
  hydrateVisibleLinkyMoments();
}

function renderLinkyMoment(slot, pose, { processing = false } = {}) {
  const image = element(LINKY_SLOTS[slot]);
  if (!image) return;
  image.dataset.linkySrc = LINKY_IMAGES[pose] || LINKY_IMAGES.neutral;
  image.closest(".linky-moment")?.classList.toggle("is-processing", processing);
  if (!image.closest("[data-panel]")?.hidden) hydrateLinkyImage(image);
}

function hydrateVisibleLinkyMoments() {
  document.querySelectorAll("[data-panel]:not([hidden]) [data-linky-image]").forEach(hydrateLinkyImage);
}

function hydrateLinkyImage(image) {
  const nextSource = image.dataset.linkySrc;
  if (!nextSource || image.getAttribute("src") === nextSource) return;
  const loader = new Image();
  loader.onload = () => {
    if (image.dataset.linkySrc !== nextSource) return;
    image.classList.add("is-changing");
    image.src = nextSource;
    requestAnimationFrame(() => image.classList.remove("is-changing"));
  };
  loader.src = nextSource;
}

function renderAvailability() {
  const laneReady = Boolean(currentStatus?.laneReady);
  setSemanticDisabled(element("lendingMaxButton"), !laneReady || Boolean(busyAction));
  document.querySelectorAll("[data-fill]").forEach((button) => {
    setSemanticDisabled(button, !laneReady || Boolean(busyAction));
  });
  if (!laneReady) {
    const blocked = validateAction("bridge", "", currentStatus);
    updateSubmit(document.querySelector("[data-operation-form='bridge'] .primary-button"), blocked);
    updateSubmit(document.querySelector("[data-operation-form='return'] .primary-button"), blocked);
    updateSubmit(element("lendingSubmit"), blocked);
    return;
  }
  const bridge = validateAction("bridge", element("bridgeAmount").value, currentStatus);
  const settlement = validateAction("return", element("returnAmount").value, currentStatus);
  const lending = validateAction(
    lendingSubmissionAction(lendingMode, currentStatus),
    element("lendingAmount").value,
    currentStatus,
  );
  updateSubmit(document.querySelector("[data-operation-form='bridge'] .primary-button"), bridge);
  updateSubmit(document.querySelector("[data-operation-form='return'] .primary-button"), settlement);
  updateSubmit(element("lendingSubmit"), lending);
}

function clearRuntimeSnapshot() {
  const snapshotFields = [
    "canonicalBalance", "collateralBalance", "debtBalance", "healthFactor", "healthLabel",
    "identityAAccount", "identityBAccount", "identityGovernanceDelay", "identityValidatorTopology",
    "routeCanonical", "routeVoucher", "bridgeAvailable", "relayRouteStatus", "finalityDepth",
    "attestorQuorum", "voucherBalance", "activeCollateral", "creditBalance", "availableBorrow",
    "collateralValue", "liquidationValue", "poolLiquidity", "collateralFactor", "originationPrincipal",
    "creditStatus", "returnVoucherBalance", "returnCanonicalBalance", "returnAvailable",
    "chainAId", "chainBId", "chainABlock", "chainBBlock", "trustedAHeight", "trustedBHeight",
    "relayEvidence", "pendingEvidence", "activityCount", "attestorEvidence", "quorumEvidence",
    "governanceEvidence", "governanceDelay", "validatorEvidence", "faultEvidence",
  ];
  snapshotFields.forEach((id) => setText(id, "-"));
  RUNTIME_STATUS_FIELDS.forEach((id) => {
    setText(id, "Unavailable");
    setStatusTone(id, false);
  });
  element("readinessVerdict")?.classList.add("is-review");
  element("readinessPill")?.classList.add("is-warning");
}

function updateSubmit(button, validation) {
  if (!button) return;
  setSemanticDisabled(button, Boolean(busyAction || currentStatus?.controller?.busy || !validation.ok));
  button.title = validation.ok ? "" : validation.message;
}

function setLendingMode(mode, { primeAmount = false } = {}) {
  if (!LENDING_MODES[mode]) return;
  lendingMode = mode;
  const config = LENDING_MODES[mode];
  const submitAction = lendingSubmissionAction(mode, currentStatus);
  document.querySelectorAll("[data-lending-mode]").forEach((button) => {
    const active = button.dataset.lendingMode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  const activeModeTab = document.querySelector(`[data-lending-mode='${mode}']`);
  element("lendingOperationPanel").setAttribute("aria-labelledby", activeModeTab.id);
  element("lendingForm").dataset.operationForm = mode;
  setText("lendingAmountLabel", config.label);
  setText("lendingUnit", config.unit);
  setText("lendingLimitLabel", submitAction === "repayAll" ? "Exact outstanding balance" : config.limitLabel);
  setText(
    "lendingLimit",
    `${compactAmount(submitAction === "repayAll" ? currentStatus?.balances?.outstandingDebt : config.limit(currentStatus))} ${config.unit}`,
  );
  const submit = element("lendingSubmit");
  submit.dataset.action = submitAction;
  submit.innerHTML = `<i data-lucide="${submitAction === "repayAll" ? "circle-dollar-sign" : config.icon}"></i><span>${submitAction === "repayAll" ? "Repay full balance" : config.button}</span>`;
  if (primeAmount) setInputAmount(element("lendingAmount"), config.limit(currentStatus), true);
  setFormMessage(element("lendingForm"), "");
  window.lucide?.createIcons();
  renderLendingLinkyMoment();
  renderAvailability();
  syncWorkflowTabState();
  if (currentStatus?.runtimeReadable) renderJourney(currentStatus);
}

function primeEmptyInputs(status) {
  const defaults = {
    bridgeAmount: minTokenAmount("1000", status.balances.canonicalAvailable),
    returnAmount: status.balances.voucherAvailable,
    lendingAmount: LENDING_MODES[lendingMode].limit(status),
  };
  Object.entries(defaults).forEach(([id, value]) => {
    const input = element(id);
    if (input.dataset.dirty !== "true" && (!(tokenUnits(input.value) > 0n) || id === "lendingAmount")) {
      setInputAmount(input, value, false);
    }
  });
  setLendingMode(lendingMode);
}

function selectAction(action) {
  if (action === "evidence") return openTab("evidence");
  openTab(ACTION_TAB[action] || "transfer");
  if (action === "repayAll") setLendingMode("repay", { primeAmount: true });
  if (LENDING_MODES[action]) setLendingMode(action, { primeAmount: true });
  const input = action === "bridge" ? element("bridgeAmount") : action === "return" ? element("returnAmount") : element("lendingAmount");
  input?.focus();
}

function openTab(tab, { focusTab = false } = {}) {
  if (!["identity", "transfer", "lending", "return", "evidence"].includes(tab)) return;
  currentTab = tab;
  document.body.dataset.view = tab;
  document.querySelectorAll("[data-panel]").forEach((panel) => {
    const active = panel.dataset.panel === tab;
    panel.classList.toggle("is-active", active);
    panel.hidden = !active;
    panel.toggleAttribute("inert", !active);
  });
  if (tab !== "identity") closeStatusDetails();
  const selectedTab = syncWorkflowTabState();
  if (focusTab) selectedTab?.focus({ preventScroll: true });
  if (currentStatus?.runtimeReadable) renderJourney(currentStatus);
  hydrateVisibleLinkyMoments();
  // Evidence changes far less often than runtime status, but entering this
  // view should never keep an old decision until the user finds Refresh.
  if (tab === "evidence" && currentEvidence !== null) void refreshFormalEvidence();
}

function syncWorkflowTabState() {
  const activeStage = stageForCurrentView();
  let selectedTab = null;
  document.querySelectorAll(".journey-step[role='tab']").forEach((tab) => {
    const active = tab.dataset.stage === activeStage;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active) {
      tab.setAttribute("aria-current", "step");
      selectedTab = tab;
    } else {
      tab.removeAttribute("aria-current");
    }
  });
  const activePanel = document.querySelector(`[data-panel='${currentTab}']`);
  if (activePanel && selectedTab) activePanel.setAttribute("aria-labelledby", selectedTab.id);
  return selectedTab;
}

function stageForCurrentView() {
  if (currentTab === "identity") return "prepare";
  if (currentTab === "transfer") return "transfer";
  if (currentTab === "lending") return ["repay", "withdraw"].includes(lendingMode) ? "manage" : "lend";
  if (currentTab === "return") return "return";
  return "review";
}

function setBusy(busy, action = null) {
  document.body.classList.toggle("is-busy", busy);
  document.querySelectorAll("[data-operation-form]").forEach((form) => {
    form.setAttribute("aria-busy", String(busy));
  });
  document.querySelectorAll(".journey-step, .segment, .text-button, .amount-input input").forEach((control) => {
    setSemanticDisabled(control, busy);
  });
  document.querySelectorAll("form .primary-button").forEach((button) => {
    if (busy) setSemanticDisabled(button, true);
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

function setFormMessage(form, message, tone = "") {
  const key = form === element("lendingForm") ? "lending" : form?.dataset?.operationForm;
  const output = document.querySelector(`[data-message='${key}']`);
  if (!output) return;
  const input = form?.querySelector("input[name='amount']");
  output.setAttribute("role", tone === "error" ? "alert" : "status");
  output.setAttribute("aria-live", tone === "error" ? "assertive" : "polite");
  output.textContent = message || "";
  output.classList.toggle("is-error", tone === "error");
  output.classList.toggle("is-success", tone === "success");
  input?.setAttribute("aria-invalid", String(tone === "error"));
}

function toast(message, tone = "success") {
  const item = document.createElement("div");
  item.className = `toast${tone === "error" ? " is-error" : ""}`;
  item.setAttribute("role", tone === "error" ? "alert" : "status");
  item.setAttribute("aria-live", tone === "error" ? "assertive" : "polite");
  item.setAttribute("aria-atomic", "true");
  const icon = document.createElement("span");
  icon.className = "toast-linky";
  const iconImage = document.createElement("img");
  iconImage.src = tone === "error" ? LINKY_IMAGES.caution : LINKY_IMAGES.success;
  iconImage.alt = "";
  iconImage.width = 38;
  iconImage.height = 38;
  icon.append(iconImage);
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
    const headers = { ...(options.headers || {}) };
    if (options.body != null && !Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) {
      headers["content-type"] = "application/json";
    }
    const response = await fetch(path, {
      ...options,
      credentials: "same-origin",
      headers,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `Request failed with HTTP ${response.status}`);
      error.statusCode = response.status;
      error.code = payload.code;
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

async function requestActionJson(body, retryExpiredSession = true) {
  const token = await csrfTokenForAction();
  let payload;
  try {
    payload = await requestJson("/api/action", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "x-institutional-csrf-token": token },
      timeoutMs: 240_000,
    });
  } catch (error) {
    if (!retryExpiredSession || error.code !== "CSRF_SESSION_INVALID") throw error;
    const refreshedToken = await csrfTokenForAction({ force: true });
    payload = await requestJson("/api/action", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "x-institutional-csrf-token": refreshedToken },
      timeoutMs: 240_000,
    });
  }
  if (payload?.ok !== true || !payload.operation || !payload.status) {
    const error = new Error("The UI server returned an incomplete action result; retry with the same request identifier.");
    error.outcomeUncertain = true;
    throw error;
  }
  return payload;
}

async function csrfTokenForAction({ force = false } = {}) {
  if (force) csrfToken = null;
  if (csrfToken) return csrfToken;
  if (!csrfBootstrapPromise) {
    csrfBootstrapPromise = requestJson("/api/session", { timeoutMs: 10_000 })
      .then((payload) => {
        if (typeof payload.csrfToken !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(payload.csrfToken)) {
          throw new Error("UI server returned an invalid action-security token");
        }
        csrfToken = payload.csrfToken;
        return csrfToken;
      })
      .finally(() => {
        csrfBootstrapPromise = null;
      });
  }
  return csrfBootstrapPromise;
}

function clearActionRequest(action) {
  actionRequests.clear(action);
}

function setInputAmount(input, value, dirty) {
  if (!input) return;
  input.value = normalizeTokenAmount(value);
  input.dataset.dirty = dirty ? "true" : "false";
}

function setSemanticDisabled(control, disabled) {
  if (!control) return;
  control.disabled = Boolean(disabled);
  control.setAttribute("aria-disabled", String(Boolean(disabled)));
}

function setText(id, value) {
  const node = element(id);
  const nextValue = value == null ? "-" : String(value);
  if (node && node.textContent !== nextValue) node.textContent = nextValue;
}

function element(id) {
  return document.getElementById(id);
}
