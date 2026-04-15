const buttons = [...document.querySelectorAll("button")];
const actionButtons = [...document.querySelectorAll("[data-action]")];
const deploySeedButton = document.getElementById("deploySeed");
const refreshButton = document.getElementById("refreshState");
const deploymentStatus = document.getElementById("deploymentStatus");

const CLIENT_STATUS = ["Uninitialized", "Active", "Frozen", "Expired", "Recovering"];

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
    setRoute("routeCheckpoint", "", "waiting");
    setRoute("routeClient", "", "waiting");
    setRoute("routeProof", "", "waiting");
    setRoute("routeReverse", "", "waiting");
    setRoute("routeSafety", "", "available");
    return;
  }

  const progress = status.progress || {};
  const balances = status.balances || {};
  const trace = status.trace || {};
  const escrowed = positive(balances.escrow) || positive(progress.packetSequenceA);
  const checkpointed = positive(progress.checkpointSequenceA);
  const trusted = positive(progress.trustedAOnB);
  const proven = Boolean(trace.forward?.packetId) || positive(balances.voucher);
  const reverseWritten = positive(progress.packetSequenceB);
  const reverseTrusted = positive(progress.trustedBOnA);
  const unlocked = Boolean(trace.reverse?.packetId);
  const frozen = Number(progress.statusAOnB) === 2;
  const recovered = Boolean(trace.misbehaviour?.recovered);

  setRoute("routeEscrow", escrowed ? "done" : "active", escrowed ? "packet written" : "ready");
  setRoute("routeCheckpoint", checkpointed ? "done" : escrowed ? "active" : "", checkpointed ? "source certified" : "waiting");
  setRoute("routeClient", trusted ? "done" : checkpointed ? "active" : "", trusted ? "trusted remote" : "waiting");
  setRoute("routeProof", proven ? "done" : trusted ? "active" : "", proven ? "executed once" : "waiting");
  setRoute(
    "routeReverse",
    unlocked ? "done" : reverseTrusted || reverseWritten ? "active" : "",
    unlocked ? "unescrowed" : reverseTrusted ? "trusted" : reverseWritten ? "packet written" : "waiting"
  );
  setRoute("routeSafety", frozen ? "active" : recovered ? "done" : "", frozen ? "frozen" : recovered ? "recovered" : "available");
}

function renderStatus(status) {
  if (!status?.deployed) {
    setText("deploymentStatus", status?.label || "Not deployed");
    deploymentStatus?.classList.remove("is-live");
    deploymentStatus?.classList.add("is-offline");
    setText("lastMessage", status?.message || "Start both local chains.");
    renderRoadmap();
    return;
  }

  deploymentStatus?.classList.add("is-live");
  deploymentStatus?.classList.remove("is-offline");
  setText("deploymentStatus", "Local stack active");
  setText("bankABalance", `${status.balances.bankA} aBANK`);
  setText("escrowBalance", `${status.balances.escrow} aBANK`);
  setText("voucherBalance", `${status.balances.voucher} vA`);
  setText("statusAOnB", statusName(status.progress.statusAOnB));
  setText("statusBOnA", statusName(status.progress.statusBOnA));

  const forward = status.trace?.forward || {};
  const reverse = status.trace?.reverse || {};
  const misbehaviour = status.trace?.misbehaviour || {};
  setText("replayState", forward.packetId || reverse.packetId ? "consumed" : "pending");
  setText("packetSequenceA", status.progress.packetSequenceA);
  setText("checkpointSequenceA", status.progress.checkpointSequenceA);
  setText("trustedAOnB", status.progress.trustedAOnB);
  setText("packetSequenceB", status.progress.packetSequenceB);
  setText("checkpointSequenceB", status.progress.checkpointSequenceB);
  setText("trustedBOnA", status.progress.trustedBOnA);
  setText("forwardPacketId", compact(forward.packetId));
  setText("forwardRoot", compact(forward.packetRoot));
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
