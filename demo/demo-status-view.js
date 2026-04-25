const CLIENT_STATUS = ["Uninitialized", "Active", "Frozen", "Recovering"];
const deploymentStatus = document.getElementById("deploymentStatus");

// Browser-side render layer: paints roadmap, trust, and safety state without owning fetch/orchestration logic.
export function setText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = value ?? "-";
}

function setList(id, items) {
  const node = document.getElementById(id);
  if (!node) return;
  node.innerHTML = "";
  for (const item of items) {
    const li = document.createElement("li");
    if (item.label) {
      const strong = document.createElement("strong");
      strong.textContent = item.label;
      li.appendChild(strong);
    }
    li.appendChild(document.createTextNode(item.value));
    node.appendChild(li);
  }
}

function compact(value) {
  if (!value) return "-";
  return value.length > 22 ? `${value.slice(0, 12)}...${value.slice(-8)}` : value;
}

function positive(value) {
  return Number(value || "0") > 0;
}

function present(value) {
  return value != null && value !== "";
}

function numeric(value) {
  const number = Number(String(value ?? "0").replace(/,/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function bpsToPercent(value) {
  const number = Number(value ?? 0) / 100;
  if (!Number.isFinite(number)) return "-";
  return `${number >= 10 ? number.toFixed(1) : number.toFixed(2)}%`;
}

function compactAmount(value, suffix = "") {
  const number = numeric(value);
  if (!Number.isFinite(number)) return "-";
  const formatted = number >= 1000 ? number.toLocaleString(undefined, { maximumFractionDigits: 2 }) : number.toFixed(number >= 10 ? 2 : 4);
  return `${formatted}${suffix}`;
}

function marketValue(amount, price) {
  return numeric(amount) * numeric(price);
}

function healthLabel(healthFactorBps) {
  const raw = String(healthFactorBps ?? "");
  if (!raw || raw === String(2n ** 256n - 1n)) {
    return { label: "No debt", status: "Safe", percent: null };
  }
  const percent = Number(raw) / 100;
  if (!Number.isFinite(percent)) return { label: "-", status: "Waiting", percent: null };
  if (percent >= 150) return { label: `${percent.toFixed(1)}%`, status: "Safe", percent };
  if (percent >= 110) return { label: `${percent.toFixed(1)}%`, status: "Watch", percent };
  return { label: `${percent.toFixed(1)}%`, status: "At Risk", percent };
}

function positionRiskGuidance(status, health) {
  const balances = status?.balances || {};
  const security = status?.security || {};
  const debt = numeric(balances.poolDebt);
  const activeCollateral = numeric(balances.poolCollateral);
  const voucher = numeric(balances.voucher);
  const escrow = numeric(balances.escrow);

  if (security.frozen || security.recovering) {
    return {
      focus: "Recover account",
      copy: "Safety controls are active, so position changes should wait until the account is recovered.",
      action: "Recover the account before borrowing, withdrawing, or returning collateral.",
    };
  }
  if (debt > 0 && health.status === "At Risk") {
    return {
      focus: "Reduce risk",
      copy: "Your open loan is close to the safety boundary and needs attention before any new withdrawal.",
      action: "Repay debt or add collateral to reduce liquidation risk.",
    };
  }
  if (debt > 0 && health.status === "Watch") {
    return {
      focus: "Improve buffer",
      copy: "Your loan is active with a thinner safety buffer than ideal.",
      action: "Repay part of the debt before taking on more exposure.",
    };
  }
  if (debt > 0) {
    return {
      focus: "Monitor loan",
      copy: "Your loan is active and currently inside the healthy range.",
      action: "Monitor safety, repay when ready, or withdraw only if health remains strong.",
    };
  }
  if (activeCollateral > 0) {
    return {
      focus: "Borrow ready",
      copy: "Collateral is active and no debt is open yet.",
      action: "Borrow within your limit when you are ready.",
    };
  }
  if (voucher > 0) {
    return {
      focus: "Activate collateral",
      copy: "Verified collateral is available, but it is not supporting borrowing yet.",
      action: "Use the verified collateral to activate your borrowing power.",
    };
  }
  if (escrow > 0) {
    return {
      focus: "Verify transfer",
      copy: "Your transfer has started and is waiting for verification to finish.",
      action: "Continue the bridge flow once verification is ready.",
    };
  }
  return {
    focus: "Start position",
    copy: "No active loan yet. The next meaningful move is to bring collateral into this account.",
    action: "Bridge collateral to unlock borrowing power.",
  };
}

function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

function heightAtLeast(value, minimum) {
  if (!present(value) || !present(minimum)) return false;
  try {
    return BigInt(value) >= BigInt(minimum);
  } catch {
    return false;
  }
}

function statusName(value) {
  return CLIENT_STATUS[Number(value)] || String(value ?? "-");
}

function progressStatusName(progress, key) {
  return progress?.[`${key}Name`] || statusName(progress?.[key]);
}

function clientPairLabel(progress) {
  return `${progressStatusName(progress, "statusAOnB")} / ${progressStatusName(progress, "statusBOnA")}`;
}

function evidenceLabel(misbehaviour, security) {
  const liveEvidence = security?.evidenceAOnB || security?.evidenceBOnA;
  if (security?.frozen && liveEvidence) {
    return `frozen height ${liveEvidence.height} / ${compact(liveEvidence.evidenceHash)}`;
  }
  if (misbehaviour?.frozen) {
    return `frozen height ${misbehaviour.height || "-"} / ${compact(misbehaviour.evidenceHash)}`;
  }
  if (misbehaviour?.recovered) {
    const recoveredAt = misbehaviour.recoveredAtHeight || "-";
    const previous = misbehaviour.previousEvidenceHeight || misbehaviour.height || "-";
    return `recovered height ${recoveredAt} / prior ${previous}`;
  }
  return "none";
}

function setRoute(id, state, text) {
  const node = document.getElementById(id);
  if (!node) return;
  node.classList.toggle("is-done", state === "done");
  node.classList.toggle("is-active", state === "active");
  setText(`${id}Text`, text);
}

function setMeter(id, value) {
  const node = document.getElementById(id);
  if (node) node.style.setProperty("--value", `${clamp(value)}%`);
}

function setFlowCheck(id, state, text) {
  const node = document.getElementById(id);
  if (!node) return;
  node.classList.toggle("is-done", state === "done");
  node.classList.toggle("is-active", state === "active");
  const value = node.querySelector("strong");
  if (value) value.textContent = text;
}

function buildVisualModel(status) {
  if (!status?.deployed) {
    return {
      stage: "offline",
      stageLabel: "Runtime offline",
      escrowText: "waiting",
      trustText: "waiting",
      creditText: "waiting",
    };
  }

  const progress = status.progress || {};
  const balances = status.balances || {};
  const trace = status.trace || {};
  const security = status.security || {};
  const forward = trace.forward || {};
  const reverse = trace.reverse || {};
  const lending = trace.risk || trace.lending || {};
  const escrowed =
    present(forward.commitHeight) ||
    present(forward.packetId) ||
    numeric(progress.packetSequenceA) > 0 ||
    numeric(balances.escrow) > 0;
  const headerFinalized = present(forward.finalizedHeight) || present(forward.trustedHeight);
  const trusted =
    numeric(progress.trustedAOnB) > 0 ||
    present(status.trust?.aOnB?.consensusHash) ||
    (present(forward.commitHeight) &&
      (heightAtLeast(forward.trustedHeight, forward.commitHeight) ||
        heightAtLeast(progress.trustedAOnB, forward.commitHeight)));
  const proven =
    Boolean(forward.receiveTxHash || security.forwardConsumed) ||
    numeric(balances.voucher) > 0 ||
    numeric(balances.poolCollateral) > 0;
  const collateralized = Boolean(lending.collateralDeposited) || numeric(balances.poolCollateral) > 0;
  const borrowed = Boolean(lending.borrowed) || numeric(balances.poolDebt) > 0 || numeric(balances.bankB) > 0;
  const reverseStarted = present(reverse.commitHeight) || present(reverse.packetId) || Boolean(reverse.receiveTxHash);
  const safety = Boolean(security.frozen || security.recovering || trace.misbehaviour?.frozen);

  let stage = "ready";
  if (safety) stage = "safety";
  else if (reverseStarted) stage = "reverse";
  else if (borrowed) stage = "borrowed";
  else if (collateralized) stage = "lending";
  else if (proven) stage = "proof";
  else if (trusted) stage = "trust";
  else if (escrowed) stage = "escrow";

  const stageLabels = {
    ready: "Ready",
    escrow: "Escrow locked",
    trust: "Trust imported",
    proof: "Proof accepted",
    lending: "Collateral active",
    borrowed: "Credit live",
    reverse: "Return path",
    safety: "Safety mode",
  };

  return {
    stage,
    stageLabel: stageLabels[stage],
    escrowText: escrowed ? `${balances.escrow ?? "0.0"} aBANK` : "waiting",
    trustText: trusted ? `header ${progress.trustedAOnB ?? "-"}` : headerFinalized ? "ready" : "waiting",
    creditText: borrowed
      ? `${balances.poolDebt ?? "0.0"} debt`
      : collateralized
        ? "collateral active"
        : proven
          ? "ready"
          : "waiting",
    escrowed,
    trusted,
    proven,
    collateralized,
    borrowed,
  };
}

function renderVisualStatus(status) {
  const model = buildVisualModel(status);
  const balances = status?.balances || {};
  document.body.dataset.demoStage = model.stage;

  setFlowCheck("visualEscrowState", model.escrowed ? "done" : model.stage === "ready" ? "active" : "", model.escrowText);
  setFlowCheck("visualTrustState", model.trusted ? "done" : model.escrowed ? "active" : "", model.trustText);
  setFlowCheck(
    "visualCreditState",
    model.borrowed || model.collateralized ? "done" : model.proven ? "active" : "",
    model.creditText
  );

  const collateral = numeric(balances.poolCollateral);
  const debt = numeric(balances.poolDebt);
  const market = status?.market || {};
  const collateralRatio = debt > 0 ? (collateral / debt) * 100 : collateral > 0 ? 100 : 0;
  const healthFactor = market.healthFactorBps && market.healthFactorBps !== String(2n ** 256n - 1n)
    ? Number(market.healthFactorBps) / 100
    : null;

  setMeter("collateralHealthBar", debt > 0 && healthFactor != null ? healthFactor / 2 : debt > 0 ? collateralRatio / 2 : collateral > 0 ? 100 : 0);
}

export function renderRoadmap(status) {
  if (!status?.deployed) {
    setRoute("routeEscrow", "active", "Ready for collateral bridge");
    setRoute("routeHeader", "", "waiting");
    setRoute("routeClient", "", "waiting");
    setRoute("routeProof", "", "waiting");
    setRoute("routeLending", "", "Waiting for lending action");
    setRoute("routeReverse", "", "waiting");
    setRoute("routeSafety", "", "Monitoring ready");
    return;
  }

  const progress = status.progress || {};
  const balances = status.balances || {};
  const trace = status.trace || {};
  const runtime = status.runtime || {};
  const security = status.security || {};
  const forward = trace.forward || {};
  const reverse = trace.reverse || {};
  const escrowed = present(forward.commitHeight) || present(forward.packetId) || positive(balances.escrow);
  const headerFinalized = present(forward.finalizedHeight) || present(forward.trustedHeight);
  const trusted =
    present(forward.commitHeight) &&
    (heightAtLeast(forward.trustedHeight, forward.commitHeight) ||
      heightAtLeast(progress.trustedAOnB, forward.commitHeight));
  const proven = Boolean(forward.receiveTxHash || forward.proofMode || security.forwardConsumed) || positive(balances.voucher);
  const forwardProofMode = trace.forward?.proofMode;
  const lending = trace.risk || trace.lending || {};
  const lendingStarted =
    Boolean(lending.collateralDeposited || lending.borrowed || lending.repaid || lending.collateralWithdrawn || lending.completed) ||
    positive(balances.poolCollateral) ||
    positive(balances.poolDebt) ||
    positive(balances.bankB);
  const lendingComplete = Boolean(lending.completed || (lending.collateralWithdrawn && !positive(balances.poolCollateral)));
  const reverseWritten = present(reverse.commitHeight) || present(reverse.packetId);
  const reverseTrusted =
    present(reverse.commitHeight) &&
    (heightAtLeast(reverse.trustedHeight, reverse.commitHeight) ||
      heightAtLeast(progress.trustedBOnA, reverse.commitHeight));
  const unlocked = Boolean(reverse.receiveTxHash || reverse.proofMode || reverse.finalSourceBalance);
  const frozen = Number(progress.statusAOnB) === 2 || Number(progress.statusBOnA) === 2;
  const recovering = Number(progress.statusAOnB) === 3 || Number(progress.statusBOnA) === 3;
  const recovered = Boolean(trace.misbehaviour?.recovered);

  setRoute(
    "routeEscrow",
    escrowed ? "done" : "active",
    escrowed ? `${balances.escrow ?? "0.0"} aBANK secured in escrow` : "Ready to bridge collateral"
  );
  setRoute(
    "routeHeader",
    headerFinalized ? "done" : escrowed ? "active" : "",
    headerFinalized ? "Source header captured for proof verification" : "Waiting for source proof capture"
  );
  setRoute(
    "routeClient",
    trusted ? "done" : headerFinalized ? "active" : "",
    trusted ? `Bank B synced trust at header ${progress.trustedAOnB ?? "-"}` : "Waiting for trust sync on Bank B"
  );
  const proofLabel =
    forwardProofMode === "storage"
      ? "Storage proof verified for voucher mint"
      : forwardProofMode === "merkle"
        ? runtime.besuFirst
          ? "Fallback proof verified"
          : "Fallback proof verified"
        : "Voucher pending verification";
  setRoute("routeProof", proven ? "done" : trusted ? "active" : "", proven ? proofLabel : "Waiting for voucher proof");
  setRoute(
    "routeLending",
    lendingComplete ? "done" : lendingStarted ? "active" : proven ? "active" : "",
    lendingComplete
      ? "Position settled and collateral released"
      : lending.collateralWithdrawn
        ? `${balances.poolCollateral ?? "0.0"} vA remains posted`
        : lending.repaid
        ? "Repayment submitted on Bank B"
        : lending.borrowed
          ? "Borrow action completed on Bank B"
          : lendingStarted
            ? "Voucher deposited as live collateral"
            : proven
              ? "Voucher ready for collateral use"
              : "Waiting for lending action"
  );
  setRoute(
    "routeReverse",
    unlocked ? "done" : reverseTrusted || reverseWritten ? "active" : "",
    unlocked
      ? "Canonical collateral unlocked on Bank A"
      : reverseTrusted
        ? "Bank A synced trust for redemption"
        : reverseWritten
          ? "Redemption submitted for verification"
          : "Ready when redemption is needed"
  );
  setRoute(
    "routeSafety",
    frozen || recovering ? "active" : recovered ? "done" : "",
    frozen ? "Safety controls engaged" : recovering ? "Recovery in progress" : recovered ? "Safety state recovered" : "Monitoring ready"
  );
}

export function renderStatus(status) {
  if (!status?.deployed) {
    const runtime = status?.runtime || {};
    renderVisualStatus(status);
    setText(
      "deploymentStatus",
      status?.label || (runtime.besuFirst ? "System waiting" : "Local system waiting")
    );
    deploymentStatus?.classList.remove("is-live");
    deploymentStatus?.classList.add("is-offline");
    setText("borrowPreviewHealth", "-");
    setText("borrowPreviewLiquidity", "-");
    setText("riskStatusText", "Connect account");
    setText("positionRiskCopy", "Connect your account first; later lending actions stay locked until the route is ready.");
    setText("positionRiskAction", "Connect Wallet to begin.");
    setText("verificationSummaryStatus", "Pending");
    setText("verificationSummaryOracle", "Waiting");
    setText("verificationSummaryClient", "Waiting");
    setText("verificationSummaryRisk", "Waiting");
    setText(
      "lastMessage",
      status?.message || (runtime.besuFirst ? "Start the bank network." : "Start the local system.")
    );
    renderRoadmap();
    return;
  }

  renderVisualStatus(status);
  deploymentStatus?.classList.add("is-live");
  deploymentStatus?.classList.remove("is-offline");
  const runtime = status.runtime || {};
  const activeOperation = status.controller?.activeOperation;
  setText(
    "deploymentStatus",
    activeOperation
      ? `Processing / ${activeOperation.label}`
      : status.stackVersion === "besu-light-client"
      ? "Account connected / verified route ready"
      : runtime.besuFirst
      ? "Account connected / bank network ready"
      : "Account connected"
  );
  setText("bankABalance", `${status.balances.bankA} aBANK`);
  setText("escrowBalance", `${status.balances.escrow} aBANK`);
  setText("voucherBalance", `${status.balances.voucher} vA`);
  setText("bankBBalance", `${status.balances.bankB} bCASH`);
  setText("poolCollateral", `${status.balances.poolCollateral} vA`);
  setText("poolDebt", `${status.balances.poolDebt} bCASH`);
  setText("poolLiquidity", `${status.balances.poolLiquidity} bCASH`);
  setText("poolCash", `${status.balances.poolCash} bCASH`);
  setText("supplierLiquidity", `${status.market?.supplierLiquidity ?? "-"} bCASH`);
  setText("supplierShares", `${status.market?.supplierShares ?? "-"} shares`);
  setText("totalLiquidityShares", `${status.market?.totalLiquidityShares ?? "-"} shares`);
  setText("totalBorrows", `${status.market?.totalBorrows ?? "-"} bCASH`);
  setText("borrowerDebtShares", `${status.market?.borrowerDebtShares ?? "-"} shares`);
  setText("totalDebtShares", `${status.market?.totalDebtShares ?? "-"} shares`);
  setText("totalReserves", `${status.market?.totalReserves ?? "-"} bCASH`);
  setText("totalBadDebt", `${status.market?.totalBadDebt ?? "-"} bCASH`);
  setText("borrowIndex", status.market?.borrowIndex ?? "-");
  setText("exchangeRate", status.market?.exchangeRate ?? "-");
  setText("borrowRate", bpsToPercent(status.market?.borrowRateBps));
  setText("utilizationBps", bpsToPercent(status.market?.utilizationRateBps));
  setText("borrowRateHero", bpsToPercent(status.market?.borrowRateBps));
  setText("operatorMode", status.runtime?.proofPolicy === "storage-required" ? "Verified route" : "Guided mode");
  const collateralValue = marketValue(status.balances.poolCollateral, status.market?.voucherPrice);
  const health = healthLabel(status.market?.healthFactorBps);
  setText("collateralValueHero", `${compactAmount(collateralValue)} bCASH`);
  setText("collateralAssetHero", `${status.balances.poolCollateral} vA collateral`);
  setText("currentDebtHero", `${status.balances.poolDebt} bCASH`);
  setText("availableBorrowHero", `${status.market?.availableToBorrow ?? "-"} bCASH`);
  setText("maxBorrowHero", `Max borrow ${status.market?.maxBorrow ?? "-"} bCASH`);
  setText("healthFactorHero", health.label);
  setText("riskBadge", health.status);
  const riskGuidance = positionRiskGuidance(status, health);
  setText("riskStatusText", riskGuidance.focus);
  setText("positionRiskCopy", riskGuidance.copy);
  setText("positionRiskAction", riskGuidance.action);
  setText("maxBorrow", `${status.market?.maxBorrow ?? "-"} bCASH`);
  setText("availableBorrow", `${status.market?.availableToBorrow ?? "-"} bCASH`);
  setText("borrowPreviewHealth", health.label === "No debt" ? "Safe" : health.label);
  setText("borrowPreviewLiquidity", `${status.balances.poolCash} bCASH`);
  setText(
    "oracleFresh",
    status.market?.oracleFresh
      ? `fresh / ${status.market.voucherPriceAgeSeconds}s`
      : `stale / ${status.market?.voucherPriceAgeSeconds ?? "-"}s`
  );
  setText("voucherOracle", `${compactAmount(status.market?.voucherPrice)} bCASH`);
  setText("debtOracle", `${compactAmount(status.market?.debtPrice)} bCASH`);
  setText("statusAOnB", progressStatusName(status.progress, "statusAOnB"));
  setText("statusBOnA", progressStatusName(status.progress, "statusBOnA"));

  const forward = status.trace?.forward || {};
  const reverse = status.trace?.reverse || {};
  const misbehaviour = status.trace?.misbehaviour || {};
  const trustedA = status.trust?.aOnB || {};
  const security = status.security || {};
  const safetyState = security.frozen
    ? `Frozen / ${clientPairLabel(status.progress)}`
    : security.recovering
      ? `Recovering / ${clientPairLabel(status.progress)}`
      : clientPairLabel(status.progress);
  const trustSummary =
    numeric(status.progress?.trustedAOnB) > 0 || security.forwardConsumed || numeric(status.balances.voucher) > 0
      ? "Synced"
      : "Pending";
  const riskSummary = security.frozen ? "Safety Mode" : security.recovering ? "Recovering" : "Monitored";

  setText("packetSequenceA", status.progress.packetSequenceA);
  setText("headerHeightA", status.progress.headerHeightA);
  setText("trustedAOnB", status.progress.trustedAOnB);
  setText("trustedEpochAOnB", trustedA.validatorEpochId || status.progress.activeEpochAOnB);
  setText(
    "trustedPacketRootA",
    compact(
      trustedA.executionStateRoot && trustedA.executionStateRoot !== "0x0000000000000000000000000000000000000000000000000000000000000000"
        ? trustedA.executionStateRoot
        : trustedA.stateRoot
    )
  );
  setText("trustedConsensusAOnB", compact(trustedA.consensusHash));
  setText(
    "trustedSourceBlockAOnB",
    trustedA.sourceBlockNumber ? `${trustedA.sourceBlockNumber} / ${compact(trustedA.sourceBlockHash)}` : "-"
  );
  setText("trustedPacketRangeA", trustedA.packetRange || "-");
  setText("packetSequenceB", status.progress.packetSequenceB);
  setText("headerHeightB", status.progress.headerHeightB);
  setText("trustedBOnA", status.progress.trustedBOnA);
  setText("forwardConsumedState", security.forwardConsumed ? "yes" : "no");
  setText(
    "replayBlockedState",
    security.replayBlocked
      ? `blocked${security.replayProofHeight ? ` @ ${security.replayProofHeight}` : ""}`
      : "pending"
  );
  const timeoutAbsence = security.timeoutAbsence || security.nonMembership;
  setText(
    "timeoutAbsenceState",
    timeoutAbsence
      ? `seq ${timeoutAbsence.absentSequence || "-"}`
      : security.timeoutAbsenceImplemented || security.nonMembershipImplemented
        ? "ready"
        : "-"
  );
  setText("safetyState", safetyState);
  setText("forwardPacketId", compact(forward.packetId));
  setText("reversePacketId", compact(reverse.packetId));
  setText("misbehaviourState", evidenceLabel(misbehaviour, security));
  setText("verificationSummaryStatus", security.forwardConsumed || numeric(status.balances.voucher) > 0 ? "Verified" : "Pending");
  setText("verificationSummaryOracle", status.market?.oracleFresh ? "Fresh" : "Stale");
  setText("verificationSummaryClient", trustSummary);
  setText("verificationSummaryRisk", riskSummary);
  renderRoadmap(status);
}

export function renderLatestActivity(activity) {
  if (!activity) {
    setText("latestActionTitle", "Waiting for the first action");
    setText("latestActionTime", "No recent operation");
    setText(
      "latestActionSummary",
      "Submit a transaction and this panel will summarize the latest position change."
    );
    setList("latestActionChanges", [{ value: "Nothing has changed yet." }]);
    return;
  }

  setText("latestActionTitle", activity.title);
  setText("latestActionTime", activity.timeLabel || "Just now");
  setText("latestActionSummary", activity.summary);
  setList(
    "latestActionChanges",
    activity.changes?.length
      ? activity.changes
      : [{ value: "The action completed, but there was no material state change to summarize." }]
  );
}

export function markControllerOffline() {
  renderVisualStatus(null);
  setText("deploymentStatus", "Service offline");
  setText("riskStatusText", "Offline");
  setText("positionRiskCopy", "The local service is offline, so live account safety cannot be evaluated yet.");
  setText("positionRiskAction", "Start the service before taking lending actions.");
  setText("verificationSummaryStatus", "Pending");
  setText("verificationSummaryOracle", "Waiting");
  setText("verificationSummaryClient", "Waiting");
  setText("verificationSummaryRisk", "Waiting");
  deploymentStatus?.classList.remove("is-live");
  deploymentStatus?.classList.add("is-offline");
}
