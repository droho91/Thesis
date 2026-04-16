const buttons = [...document.querySelectorAll("button")];
const actionButtons = [...document.querySelectorAll("[data-action]")];
const deploySeedButton = document.getElementById("deploySeed");
const refreshButton = document.getElementById("refreshState");
const deploymentStatus = document.getElementById("deploymentStatus");

const CLIENT_STATUS = ["Uninitialized", "Active", "Frozen", "Recovering"];

function setText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = value ?? "-";
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

function setBusy(busy) {
  document.body.classList.toggle("is-busy", busy);
  buttons.forEach((button) => {
    button.disabled = busy;
  });
}

function setOutput(value) {
  setText("contractOutput", value || "No action output yet.");
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error([payload.error, payload.output].filter(Boolean).join("\n\n"));
  }
  return payload;
}

function setRoute(id, state, text) {
  const node = document.getElementById(id);
  if (!node) return;
  node.classList.toggle("is-done", state === "done");
  node.classList.toggle("is-active", state === "active");
  setText(`${id}Text`, text);
}

function renderRoadmap(status) {
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
          ? "compatibility path"
          : "legacy proof"
        : "executed once";
  setRoute(
    "routeProof",
    proven ? "done" : trusted ? "active" : "",
    proven ? proofLabel : "waiting"
  );
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

function renderStatus(status) {
  if (!status?.deployed) {
    const runtime = status?.runtime || {};
    setText(
      "deploymentStatus",
      status?.label || (runtime.besuFirst ? "Besu runtime waiting" : "Legacy runtime waiting")
    );
    deploymentStatus?.classList.remove("is-live");
    deploymentStatus?.classList.add("is-offline");
    setText(
      "lastMessage",
      status?.message || (runtime.besuFirst ? "Start the Besu bank chains." : "Start both local chains.")
    );
    renderRoadmap();
    return;
  }

  deploymentStatus?.classList.add("is-live");
  deploymentStatus?.classList.remove("is-offline");
  const runtime = status.runtime || {};
  setText(
    "deploymentStatus",
    runtime.besuFirst
      ? `Besu runtime active${runtime.proofPolicy === "storage-required" ? " / storage proof required" : ""}`
      : "Legacy dev runtime active"
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
  setText("trustedPacketRootA", compact(trustedA.executionStateRoot && trustedA.executionStateRoot !== "0x0000000000000000000000000000000000000000000000000000000000000000" ? trustedA.executionStateRoot : trustedA.stateRoot));
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

async function refreshStatus() {
  const status = await requestJson("/api/status");
  renderStatus(status);
  return status;
}

async function runDeploySeed() {
  setBusy(true);
  setText("lastMessage", "Deploying contracts and seeding balances...");
  setOutput("Running deploy and seed from the UI controller...");
  try {
    const payload = await requestJson("/api/deploy-seed", { method: "POST" });
    renderStatus(payload.status);
    setText("lastMessage", "Deployment and seed complete.");
    setOutput(payload.output);
  } catch (error) {
    setText("lastMessage", "Deploy + Seed failed.");
    setOutput(error.message);
  } finally {
    setBusy(false);
  }
}

async function runAction(action) {
  setBusy(true);
  setText("lastMessage", `Running ${action}...`);
  setOutput(`Calling action: ${action}`);
  try {
    const payload = await requestJson("/api/action", {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    renderStatus(payload.status);
    setText("lastMessage", payload.message);
    setOutput(payload.message);
  } catch (error) {
    setText("lastMessage", `${action} failed.`);
    setOutput(error.message);
  } finally {
    setBusy(false);
  }
}

deploySeedButton?.addEventListener("click", runDeploySeed);
refreshButton?.addEventListener("click", async () => {
  setBusy(true);
  try {
    const status = await refreshStatus();
    setText("lastMessage", status.deployed ? "State refreshed." : status.message);
  } catch (error) {
    setText("lastMessage", "Refresh failed.");
    setOutput(error.message);
  } finally {
    setBusy(false);
  }
});

actionButtons.forEach((button) => {
  button.addEventListener("click", () => runAction(button.dataset.action));
});

refreshStatus().catch((error) => {
  setText("deploymentStatus", "Controller offline");
  deploymentStatus?.classList.remove("is-live");
  deploymentStatus?.classList.add("is-offline");
  setText("lastMessage", "Could not load local demo state.");
  setOutput(error.message);
  renderRoadmap();
});
