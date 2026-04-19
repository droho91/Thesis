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

function statusName(value) {
  return CLIENT_STATUS[Number(value)] || String(value ?? "-");
}

function setRoute(id, state, text) {
  const node = document.getElementById(id);
  if (!node) return;
  node.classList.toggle("is-done", state === "done");
  node.classList.toggle("is-active", state === "active");
  setText(`${id}Text`, text);
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
  const escrowed = positive(balances.escrow) || positive(progress.packetSequenceA);
  const headerFinalized = positive(progress.headerHeightA);
  const trusted = positive(progress.trustedAOnB);
  const proven = Boolean(trace.forward?.packetId) || positive(balances.voucher);
  const forwardProofMode = trace.forward?.proofMode;
  const lending = trace.lending || {};
  const lendingStarted =
    Boolean(lending.collateralDeposited || lending.borrowed || lending.repaid || lending.collateralWithdrawn || lending.completed) ||
    positive(balances.poolCollateral) ||
    positive(balances.poolDebt) ||
    positive(balances.bankB);
  const lendingComplete = Boolean(lending.completed || lending.collateralWithdrawn);
  const reverseWritten = positive(progress.packetSequenceB);
  const reverseTrusted = positive(progress.trustedBOnA);
  const unlocked = Boolean(trace.reverse?.packetId);
  const frozen = Number(progress.statusAOnB) === 2;
  const recovering = Number(progress.statusAOnB) === 3;
  const recovered = Boolean(trace.misbehaviour?.recovered);

  setRoute("routeEscrow", escrowed ? "done" : "active", escrowed ? "packet written" : "ready");
  setRoute("routeHeader", headerFinalized ? "done" : escrowed ? "active" : "", headerFinalized ? "header sealed" : "waiting");
  setRoute("routeClient", trusted ? "done" : headerFinalized ? "active" : "", trusted ? "trusted remote" : "waiting");
  const proofLabel =
    forwardProofMode === "storage"
      ? "storage proof"
      : forwardProofMode === "merkle"
        ? runtime.besuFirst
          ? "unexpected compatibility path"
          : "compatibility proof"
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
    unlocked ? "unescrowed" : reverseTrusted ? "trusted" : reverseWritten ? "packet written" : "waiting"
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
    setText(
      "deploymentStatus",
      status?.label || (runtime.besuFirst ? "Besu runtime waiting" : "Compatibility runtime waiting")
    );
    deploymentStatus?.classList.remove("is-live");
    deploymentStatus?.classList.add("is-offline");
    setText(
      "lastMessage",
      status?.message || (runtime.besuFirst ? "Start the Besu bank chains." : "Start the internal compatibility stack.")
    );
    renderRoadmap();
    return;
  }

  deploymentStatus?.classList.add("is-live");
  deploymentStatus?.classList.remove("is-offline");
  const runtime = status.runtime || {};
  setText(
    "deploymentStatus",
    status.stackVersion === "v2"
      ? "Besu v2 runtime active / native header + storage proof path"
      : runtime.besuFirst
      ? `Besu runtime active${runtime.proofPolicy === "storage-required" ? " / storage proof required" : ""}`
      : "Compatibility runtime active"
  );
  setText("bankABalance", `${status.balances.bankA} aBANK`);
  setText("escrowBalance", `${status.balances.escrow} aBANK`);
  setText("voucherBalance", `${status.balances.voucher} vA`);
  setText("bankBBalance", `${status.balances.bankB} bCASH`);
  setText("poolCollateral", `${status.balances.poolCollateral} vA`);
  setText("poolDebt", `${status.balances.poolDebt} bCASH`);
  setText("poolLiquidity", `${status.balances.poolLiquidity} bCASH`);
  setText("statusAOnB", statusName(status.progress.statusAOnB));
  setText("statusBOnA", statusName(status.progress.statusBOnA));

  const forward = status.trace?.forward || {};
  const reverse = status.trace?.reverse || {};
  const misbehaviour = status.trace?.misbehaviour || {};
  const trustedA = status.trust?.aOnB || {};
  const security = status.security || {};
  const safetyState = security.frozen
    ? "Frozen"
    : security.recovering
      ? "Recovering"
      : `${statusName(status.progress.statusAOnB)} / ${statusName(status.progress.statusBOnA)}`;

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
  setText("replayBlockedState", security.replayBlocked ? "blocked" : "pending");
  setText(
    "nonMembershipState",
    security.nonMembership
      ? `seq ${security.nonMembership.absentSequence}`
      : security.nonMembershipImplemented
        ? "ready"
        : "-"
  );
  setText("safetyState", safetyState);
  setText("forwardPacketId", compact(forward.packetId));
  setText("reversePacketId", compact(reverse.packetId));
  setText(
    "misbehaviourState",
    misbehaviour.recovered ? `recovered epoch ${misbehaviour.epochId}` : misbehaviour.frozen ? `frozen seq ${misbehaviour.sequence}` : "none"
  );
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
  setText("deploymentStatus", "Controller offline");
  deploymentStatus?.classList.remove("is-live");
  deploymentStatus?.classList.add("is-offline");
}
