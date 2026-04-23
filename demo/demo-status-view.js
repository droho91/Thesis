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
      proofReadiness: 0,
      nextActionTitle: "Prepare Runtime",
      nextActionHint: "Start from a live seeded baseline.",
      packetLabel: "seq -",
      proofMode: "waiting",
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

  const proofReadiness =
    12 +
    (escrowed ? 18 : 0) +
    (headerFinalized ? 18 : 0) +
    (trusted ? 24 : 0) +
    (proven ? 28 : 0);

  let nextActionTitle = "Lock aBANK";
  let nextActionHint = "Write the forward packet and put source collateral in escrow.";
  if (!escrowed) {
    nextActionTitle = "Lock aBANK";
    nextActionHint = "Create the collateral packet on Bank A.";
  } else if (!headerFinalized) {
    nextActionTitle = "Read Bank A Header";
    nextActionHint = "Capture the finalized source header for Bank B.";
  } else if (!trusted) {
    nextActionTitle = "Import Header on Bank B";
    nextActionHint = "Move the source trust anchor into the destination chain.";
  } else if (!proven) {
    nextActionTitle = "Verify Proof + Mint";
    nextActionHint = "Accept the packet proof and mint the voucher.";
  } else if (!collateralized) {
    nextActionTitle = "Deposit Voucher";
    nextActionHint = "Turn the proven voucher into pool collateral.";
  } else if (!borrowed) {
    nextActionTitle = "Borrow bCASH";
    nextActionHint = "Draw credit against the verified collateral.";
  } else if (numeric(balances.poolDebt) > 0) {
    nextActionTitle = "Repay bCASH";
    nextActionHint = "Close the active debt before withdrawing collateral.";
  } else if (!reverseStarted) {
    nextActionTitle = "Burn Voucher";
    nextActionHint = "Start the reverse packet and unlock source value.";
  } else {
    nextActionTitle = "Verify Proof + Unlock";
    nextActionHint = "Complete the return proof path on Bank A.";
  }
  if (safety) {
    nextActionTitle = security.recovering ? "Recover Light Client" : "Recover or inspect evidence";
    nextActionHint = "Resolve the frozen or recovering trust state before normal flow resumes.";
  }

  return {
    stage,
    stageLabel: stageLabels[stage],
    proofReadiness: clamp(proofReadiness),
    nextActionTitle,
    nextActionHint,
    packetLabel: `seq ${progress.packetSequenceA ?? "-"}`,
    proofMode: forward.proofMode ? `${forward.proofMode} proof` : "waiting",
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
  const map = document.getElementById("capitalMap");
  if (map) map.dataset.stage = model.stage;
  document.body.dataset.demoStage = model.stage;

  setText("flowStageBadge", model.stageLabel);
  setText("visualBankABalance", status?.deployed ? `${balances.bankA ?? "-"} aBANK` : "-");
  setText("visualBankBBalance", status?.deployed ? `${balances.bankB ?? "-"} bCASH` : "-");
  setText("visualPacketLabel", model.packetLabel);
  setText("visualProofMode", model.proofMode);

  setFlowCheck("visualEscrowState", model.escrowed ? "done" : model.stage === "ready" ? "active" : "", model.escrowText);
  setFlowCheck("visualTrustState", model.trusted ? "done" : model.escrowed ? "active" : "", model.trustText);
  setFlowCheck(
    "visualCreditState",
    model.borrowed || model.collateralized ? "done" : model.proven ? "active" : "",
    model.creditText
  );

  setText("proofReadinessText", `${Math.round(model.proofReadiness)}%`);
  setMeter("proofReadinessBar", model.proofReadiness);

  const collateral = numeric(balances.poolCollateral);
  const debt = numeric(balances.poolDebt);
  const market = status?.market || {};
  const liquidity = numeric(balances.poolLiquidity);
  const collateralRatio = debt > 0 ? (collateral / debt) * 100 : collateral > 0 ? 100 : 0;
  const utilization = market.utilizationRateBps != null ? Number(market.utilizationRateBps) / 100 : debt + liquidity > 0 ? (debt / (debt + liquidity)) * 100 : 0;
  const healthFactor = market.healthFactorBps && market.healthFactorBps !== String(2n ** 256n - 1n)
    ? Number(market.healthFactorBps) / 100
    : null;

  setText(
    "collateralHealthText",
    debt > 0 && healthFactor != null ? `${healthFactor.toFixed(1)}% HF` : debt > 0 ? `${Math.round(collateralRatio)}%` : collateral > 0 ? "covered" : status?.deployed ? "idle" : "-"
  );
  setMeter("collateralHealthBar", debt > 0 && healthFactor != null ? healthFactor / 2 : debt > 0 ? collateralRatio / 2 : collateral > 0 ? 100 : 0);
  setText("creditUtilText", status?.deployed ? `${utilization >= 10 ? utilization.toFixed(0) : utilization.toFixed(1)}%` : "-");
  setMeter("creditUtilBar", utilization);
  setText("nextActionTitle", model.nextActionTitle);
  setText("nextActionHint", model.nextActionHint);
}

export function renderRoadmap(status) {
  if (!status?.deployed) {
    setRoute("routeEscrow", "active", "deploy first");
    setRoute("routeHeader", "", "waiting");
    setRoute("routeClient", "", "waiting");
    setRoute("routeProof", "", "waiting");
    setRoute("routeLending", "", "waiting");
    setRoute("routeReverse", "", "waiting");
    setRoute("routeSafety", "", "available");
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
  const lendingComplete = Boolean(lending.completed || lending.collateralWithdrawn);
  const reverseWritten = present(reverse.commitHeight) || present(reverse.packetId);
  const reverseTrusted =
    present(reverse.commitHeight) &&
    (heightAtLeast(reverse.trustedHeight, reverse.commitHeight) ||
      heightAtLeast(progress.trustedBOnA, reverse.commitHeight));
  const unlocked = Boolean(reverse.receiveTxHash || reverse.proofMode || reverse.finalSourceBalance);
  const frozen = Number(progress.statusAOnB) === 2 || Number(progress.statusBOnA) === 2;
  const recovering = Number(progress.statusAOnB) === 3 || Number(progress.statusBOnA) === 3;
  const recovered = Boolean(trace.misbehaviour?.recovered);

  setRoute("routeEscrow", escrowed ? "done" : "active", escrowed ? "packet written" : "ready");
  setRoute("routeHeader", headerFinalized ? "done" : escrowed ? "active" : "", headerFinalized ? "header read" : "waiting");
  setRoute("routeClient", trusted ? "done" : headerFinalized ? "active" : "", trusted ? "header imported" : "waiting");
  const proofLabel =
    forwardProofMode === "storage"
      ? "storage proof"
      : forwardProofMode === "merkle"
        ? runtime.besuFirst
          ? "fallback proof"
          : "fallback proof"
        : "executed once";
  setRoute("routeProof", proven ? "done" : trusted ? "active" : "", proven ? proofLabel : "waiting");
  setRoute(
    "routeLending",
    lendingComplete ? "done" : lendingStarted ? "active" : proven ? "active" : "",
    lendingComplete
      ? "collateral released"
      : lending.repaid
        ? "debt repaid"
        : lending.borrowed
          ? "borrowed"
          : lendingStarted
            ? "collateralized"
            : proven
              ? "ready"
              : "waiting"
  );
  setRoute(
    "routeReverse",
    unlocked ? "done" : reverseTrusted || reverseWritten ? "active" : "",
    unlocked ? "unlocked" : reverseTrusted ? "header imported" : reverseWritten ? "packet written" : "waiting"
  );
  setRoute(
    "routeSafety",
    frozen || recovering ? "active" : recovered ? "done" : "",
    frozen ? "frozen" : recovering ? "recovering" : recovered ? "recovered" : "available"
  );
}

export function renderStatus(status) {
  if (!status?.deployed) {
    const runtime = status?.runtime || {};
    renderVisualStatus(status);
    setText(
      "deploymentStatus",
      status?.label || (runtime.besuFirst ? "Besu runtime waiting" : "Local runtime waiting")
    );
    deploymentStatus?.classList.remove("is-live");
    deploymentStatus?.classList.add("is-offline");
    setText("heroBorrowPower", "-");
    setText("heroDebtPreview", "-");
    setText("heroHealthPreview", "-");
    setText("heroRiskPreview", "Waiting");
    setText("heroPoolCashPreview", "-");
    setText("heroOraclePreview", "-");
    setText("heroRuntimePreview", runtime.besuFirst ? "Besu required" : "Local runtime");
    setText("borrowPreviewHealth", "-");
    setText("borrowPreviewLiquidity", "-");
    setText(
      "lastMessage",
      status?.message || (runtime.besuFirst ? "Start the Besu bank chains." : "Start the local runtime.")
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
      ? `Controller busy / ${activeOperation.label}`
      : status.stackVersion === "besu-light-client"
      ? "Besu runtime active / light-client header + storage proof path"
      : runtime.besuFirst
      ? `Besu runtime active${runtime.proofPolicy === "storage-required" ? " / storage proof required" : ""}`
      : "Local runtime active"
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
  setText("utilizationHero", bpsToPercent(status.market?.utilizationRateBps));
  setText("reservesHero", `${status.market?.totalReserves ?? "-"} bCASH`);
  setText("oracleFreshHero", status.market?.oracleFresh ? "fresh" : "stale");
  setText("operatorMode", status.runtime?.proofPolicy === "storage-required" ? "Storage proof required" : "Demo mode");
  const collateralValue = marketValue(status.balances.poolCollateral, status.market?.voucherPrice);
  const health = healthLabel(status.market?.healthFactorBps);
  setText("collateralValueHero", `${compactAmount(collateralValue)} bCASH`);
  setText("collateralAssetHero", `${status.balances.poolCollateral} vA collateral`);
  setText("currentDebtHero", `${status.balances.poolDebt} bCASH`);
  setText("availableBorrowHero", `${status.market?.availableToBorrow ?? "-"} bCASH`);
  setText("maxBorrowHero", `Max borrow ${status.market?.maxBorrow ?? "-"} bCASH`);
  setText("healthFactorHero", health.label);
  setText("riskBadge", health.status);
  setText("heroBorrowPower", `${status.market?.availableToBorrow ?? "-"} bCASH`);
  setText("heroDebtPreview", `${status.balances.poolDebt} bCASH`);
  setText("heroHealthPreview", health.label);
  setText("heroRiskPreview", health.status);
  setText("heroPoolCashPreview", `${status.balances.poolCash} bCASH`);
  setText(
    "heroOraclePreview",
    status.market?.oracleFresh
      ? `Fresh ${status.market.voucherPriceAgeSeconds}s`
      : `Stale ${status.market?.voucherPriceAgeSeconds ?? "-"}s`
  );
  setText("heroRuntimePreview", status.runtime?.proofPolicy === "storage-required" ? "Storage proof" : "Demo mode");
  setText("riskStatusText", health.status);
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
  renderRoadmap(status);
}

export function renderLatestActivity(activity) {
  if (!activity) {
    setText("latestActionTitle", "Waiting for the first action");
    setText("latestActionTime", "No recent operation");
    setText(
      "latestActionSummary",
      "Use the controls below to move the protocol forward. The UI will summarize the last successful action and the state changes it caused."
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
  setText("deploymentStatus", "Controller offline");
  deploymentStatus?.classList.remove("is-live");
  deploymentStatus?.classList.add("is-offline");
}
