const steps = [
  {
    title: "Escrow on Bank A",
    text: "The source app locks canonical tokens before any remote state exists. This is application state, not trust state.",
    artifact: "none yet",
    relayer: "transport only",
    replay: "not reached",
    client: "Active",
    trusted: "None",
    execution: "Waiting",
  },
  {
    title: "Write packet commitment",
    text: "The packet leaf is appended to canonical source state. Later proofs must use this exact leaf.",
    artifact: "packet leaf",
    relayer: "cannot edit packet",
    replay: "packet id formed",
    client: "Active",
    trusted: "None",
    execution: "Waiting",
  },
  {
    title: "Commit source checkpoint",
    text: "The source checkpoint binds packet root, sequence range, validator epoch, parent hash, and source anchors.",
    artifact: "source checkpoint",
    relayer: "can request commit",
    replay: "packet id unchanged",
    client: "Active",
    trusted: "None",
    execution: "Waiting",
  },
  {
    title: "Update remote client",
    text: "Bank B accepts the checkpoint only with enough Bank A validator signatures over the exact hash.",
    artifact: "client message",
    relayer: "submits signatures",
    replay: "not executed",
    client: "Active",
    trusted: "Checkpoint #1",
    execution: "Waiting",
  },
  {
    title: "Verify membership proof",
    text: "The packet leaf is proven against the trusted packet root stored in the remote client.",
    artifact: "Merkle proof",
    relayer: "submits proof",
    replay: "checked before app call",
    client: "Active",
    trusted: "Checkpoint #1",
    execution: "Proof valid",
  },
  {
    title: "Mint voucher once",
    text: "The packet handler consumes the packet id, then the app mints the voucher. A replay fails before minting.",
    artifact: "consumed packet",
    relayer: "no special trust",
    replay: "consumed",
    client: "Active",
    trusted: "Checkpoint #1",
    execution: "Voucher minted",
  },
];

let activeStep = 0;
const nodes = [...document.querySelectorAll(".step")];

function setText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

function render() {
  const step = steps[activeStep];
  nodes.forEach((node, index) => {
    node.classList.toggle("is-active", index === activeStep);
    node.classList.toggle("is-done", index < activeStep);
  });
  setText("detailTitle", step.title);
  setText("detailText", step.text);
  setText("artifactValue", step.artifact);
  setText("relayerValue", step.relayer);
  setText("replayValue", step.replay);
  setText("clientState", step.client);
  setText("trustedState", step.trusted);
  setText("executionState", step.execution);
}

nodes.forEach((node) => {
  node.addEventListener("click", () => {
    activeStep = Number(node.dataset.step);
    render();
  });
});

document.getElementById("prevStep")?.addEventListener("click", () => {
  activeStep = Math.max(0, activeStep - 1);
  render();
});

document.getElementById("nextStep")?.addEventListener("click", () => {
  activeStep = Math.min(steps.length - 1, activeStep + 1);
  render();
});

document.getElementById("freezeClient")?.addEventListener("click", () => {
  setText("clientState", "Frozen");
  setText("trustedState", "Conflicting checkpoint");
  setText("executionState", "Blocked");
  setText("detailTitle", "Conflict freeze");
  setText(
    "detailText",
    "A different validator-certified checkpoint for the same source sequence stores misbehaviour evidence and blocks membership verification."
  );
  setText("artifactValue", "IBCMisbehaviour.Evidence");
  setText("relayerValue", "can reveal conflict");
  setText("replayValue", "execution disabled");
});

document.getElementById("recoverClient")?.addEventListener("click", () => {
  setText("clientState", "Active");
  setText("trustedState", "Successor epoch");
  setText("executionState", "Waiting");
  setText("detailTitle", "Recovery");
  setText(
    "detailText",
    "Recovery starts explicitly, then the client returns to active only after importing a certified successor validator epoch."
  );
  setText("artifactValue", "validator epoch #2");
  setText("relayerValue", "transports epoch");
  setText("replayValue", "packet ids still consumed once");
});

render();
