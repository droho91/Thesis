import { markControllerOffline, renderRoadmap, renderStatus, setText } from "./demo-status-view.js";

const buttons = [...document.querySelectorAll("button")];
const actionButtons = [...document.querySelectorAll("[data-action]")];
const deploySeedButton = document.getElementById("deploySeed");
const refreshButton = document.getElementById("refreshState");

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
  markControllerOffline();
  setText("lastMessage", "Could not load local demo state.");
  setOutput(error.message);
  renderRoadmap();
});
