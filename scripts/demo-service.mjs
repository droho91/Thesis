import { access, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { loadArtifact, normalizeRuntime } from "./besu-runtime.mjs";
import { loadRuntimeConfig, providerForChain, saveRuntimeConfig, RUNTIME_CONFIG_PATH } from "./interchain-config.mjs";
import { readDemoStatus, readTrace } from "./demo-read-model.mjs";
import {
  DEMO_MAX_TIMEOUT_HEADER_GAP,
  applyDemoAmountOverrides,
  chainId,
  currentRouteStatus,
  getCurrentPhase,
  handshakeTrace,
  loadContext,
  prepareStepContext,
  robustCurrentRouteStatus,
  trustRemoteHeaderAt,
  writeTracePatch,
} from "./demo/context.mjs";
import { runDemoStep } from "./demo/dispatcher.mjs";

// Demo service layer: wraps runtime command execution and composes payloads consumed by the HTTP API.
const configPath = RUNTIME_CONFIG_PATH;
const traceJsonPath = resolve(process.cwd(), "demo", "latest-run.json");
const traceJsPath = resolve(process.cwd(), "demo", "latest-run.js");
const npm = "npm";
const node = process.execPath;
const DEFAULT_TIMEOUT_MS = Number(process.env.DEMO_SERVICE_TIMEOUT_MS || 600000);
const FAST_READY_TIMEOUT_MS = Number(process.env.DEMO_FAST_READY_TIMEOUT_MS || 5000);
const STATUS_READ_TIMEOUT_MS = Number(process.env.DEMO_STATUS_READ_TIMEOUT_MS || 8000);
const HEALTH_GRACE_RETRY_MS = Number(process.env.DEMO_HEALTH_GRACE_RETRY_MS || 20000);
const CODE_READ_RETRIES = Math.max(1, Number(process.env.DEMO_CODE_READ_RETRIES || 6));
const CODE_READ_RETRY_DELAY_MS = Number(process.env.DEMO_CODE_READ_RETRY_DELAY_MS || 500);
const LIGHT_CLIENT_HEARTBEAT_INTERVAL_MS = Number(process.env.DEMO_LIGHT_CLIENT_HEARTBEAT_INTERVAL_MS || 25000);
const LIGHT_CLIENT_HEARTBEAT_MAX_HEADERS = BigInt(process.env.DEMO_LIGHT_CLIENT_HEARTBEAT_MAX_HEADERS || "12");
const HEARTBEAT_IDLE_TIMEOUT_MS = Number(process.env.DEMO_HEARTBEAT_IDLE_TIMEOUT_MS || 300000);
const RESUME_SESSION_MAX_HEADER_GAP = BigInt(process.env.DEMO_RESUME_MAX_HEADER_GAP || DEMO_MAX_TIMEOUT_HEADER_GAP.toString());
const RESUME_SESSION_MAX_HEADERS = BigInt(process.env.DEMO_RESUME_MAX_HEADERS || "12");
const RESUME_SESSION_TIMEOUT_MS = Number(process.env.DEMO_RESUME_TIMEOUT_MS || 60000);
const REPAY_CLOSE_BUFFER_BPS = 1;
const REPAY_CLOSE_MIN_BUFFER = 0.01;
const VISIBLE_STATE_RETRY_MS = Number(process.env.DEMO_VISIBLE_STATE_RETRY_MS || 15000);
const PREPARED_CONTEXT_HEALTH_TTL_MS = Number(process.env.DEMO_PREPARED_CONTEXT_HEALTH_TTL_MS || "30000");
let activeOperation = null;
let preparedContextCache = null;
let runtimeReadyConfirmed = false;
let heartbeatRunning = false;
let lastHeartbeatSkipMessage = null;

const CRITICAL_DEPLOYMENT_CONTRACTS = Object.freeze([
  ["A", "lightClient"],
  ["A", "connectionKeeper"],
  ["A", "channelKeeper"],
  ["A", "packetHandler"],
  ["A", "packetStore"],
  ["A", "policyEngine"],
  ["A", "canonicalToken"],
  ["A", "escrowVault"],
  ["A", "transferApp"],
  ["B", "lightClient"],
  ["B", "connectionKeeper"],
  ["B", "channelKeeper"],
  ["B", "packetHandler"],
  ["B", "packetStore"],
  ["B", "policyEngine"],
  ["B", "voucherToken"],
  ["B", "debtToken"],
  ["B", "oracle"],
  ["B", "lendingPool"],
  ["B", "transferApp"],
]);

async function expectedArtifactFingerprint() {
  const artifacts = {
    lightClient: await loadArtifact("clients/BesuLightClient.sol", "BesuLightClient"),
    connectionKeeper: await loadArtifact("core/IBCConnectionKeeper.sol", "IBCConnectionKeeper"),
    channelKeeper: await loadArtifact("core/IBCChannelKeeper.sol", "IBCChannelKeeper"),
    packetHandler: await loadArtifact("core/IBCPacketHandler.sol", "IBCPacketHandler"),
    packetStore: await loadArtifact("core/IBCPacketStore.sol", "IBCPacketStore"),
    bankToken: await loadArtifact("apps/BankToken.sol", "BankToken"),
    policy: await loadArtifact("apps/BankPolicyEngine.sol", "BankPolicyEngine"),
    oracle: await loadArtifact("apps/ManualAssetOracle.sol", "ManualAssetOracle"),
    escrow: await loadArtifact("apps/PolicyControlledEscrowVault.sol", "PolicyControlledEscrowVault"),
    voucher: await loadArtifact("apps/PolicyControlledVoucherToken.sol", "PolicyControlledVoucherToken"),
    lendingPool: await loadArtifact("apps/PolicyControlledLendingPool.sol", "PolicyControlledLendingPool"),
    transferApp: await loadArtifact("apps/PolicyControlledTransferApp.sol", "PolicyControlledTransferApp"),
  };
  const names = [
    "lightClient",
    "connectionKeeper",
    "channelKeeper",
    "packetHandler",
    "packetStore",
    "bankToken",
    "policy",
    "oracle",
    "escrow",
    "voucher",
    "lendingPool",
    "transferApp",
  ];
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32[]"],
      [names.map((name) => ethers.keccak256(artifacts[name].deployedBytecode || artifacts[name].bytecode || "0x"))]
    )
  );
}

function operationLabel(action) {
  const labels = {
    deploySeed: "Prepare Demo Session",
    resetSeeded: "Fresh Reset (slow setup only)",
    resumeSession: "Resume Session",
    fullFlow: "Run Risk/Liquidation Lifecycle",
    borrowerCloseout: "Close Position & Return Collateral",
    runFlow: "Run Flow",
    openRoute: "Establish Bank Route",
    lock: "Transfer Collateral to Bank B",
    finalizeForwardHeader: "Read Bank A Besu header",
    updateForwardClient: "Import Bank A header on Bank B",
    proveForwardMint: "Receive Verified Collateral",
    replayForward: "Replay forward packet",
    depositCollateral: "Deposit Collateral",
    borrow: "Borrow Cash",
    repay: "Repay Loan",
    topUpRepayCash: "Get demo bCASH",
    withdrawCollateral: "Withdraw collateral",
    simulatePriceShock: "Simulate Collateral Price Drop",
    executeLiquidation: "Execute Liquidation",
    settleSeizedVoucher: "Settle seized voucher",
    burn: "Burn voucher",
    finalizeReverseHeader: "Read Bank B Besu header",
    updateReverseClient: "Import Bank B header on Bank A",
    proveReverseUnlock: "Verify reverse packet proof",
    freezeClient: "Freeze light client",
    recoverClient: "Recover light client",
    executeTimeoutRefund: "Execute Timeout Refund",
    verifyTimeoutAbsence: "Legacy timeout explanation marker",
  };
  return labels[action] || `demo action ${action || "unknown"}`;
}

const FORWARD_PROOF_STEP_LABELS = {
  finalizeForwardHeader: "1/3 Fetch Bank A header",
  updateForwardClient: "2/3 Import Bank A header on Bank B",
  proveForwardMint: "Receive Verified Collateral",
};
const REVERSE_PROOF_STEP_LABELS = {
  finalizeReverseHeader: "1/3 Fetch Bank B header",
  updateReverseClient: "2/3 Import Bank B header on Bank A",
  proveReverseUnlock: "3/3 Verify proof and unlock aBANK",
};

function forwardProofStepLabel(action) {
  return FORWARD_PROOF_STEP_LABELS[action] || "Receive Verified Collateral";
}

function reverseProofStepLabel(action) {
  return REVERSE_PROOF_STEP_LABELS[action] || "Verify reverse proof and unlock aBANK on Bank A";
}

function publicActiveOperation() {
  if (!activeOperation) return null;
  const phase = getCurrentPhase();
  const phaseMatchesAction = phaseBelongsToAction(activeOperation.action, phase);
  const phaseStage = phaseMatchesAction ? stageFromDemoPhase(phase) : null;
  return {
    id: activeOperation.id,
    action: activeOperation.action,
    label: activeOperation.label,
    stage: phaseStage || activeOperation.stage,
    phase: phaseMatchesAction ? phase : null,
    startedAt: activeOperation.startedAt,
    elapsedSeconds: Math.max(0, Math.round((Date.now() - activeOperation.startedAtMs) / 1000)),
  };
}

function phaseBelongsToAction(action, phase) {
  if (!phase) return false;
  if (action === "openRoute") return phase.startsWith("step-open-route");
  if (action === "lock") return phase.startsWith("step-lock");
  if (action === "finalizeForwardHeader") return phase === "step-finalizeForwardHeader";
  if (action === "updateForwardClient") return phase === "step-updateForwardClient";
  if (action === "proveForwardMint" || action === "replayForward") return phase.startsWith("step-prove-forward");
  if (action === "depositCollateral") return phase === "step-deposit-collateral";
  if (action === "borrow") return phase === "step-borrow";
  if (action === "repay") return phase === "step-repay";
  if (action === "topUpRepayCash") return phase === "step-top-up-repay-cash";
  if (action === "withdrawCollateral") return phase === "step-withdraw-collateral";
  if (action === "settleSeizedVoucher") return phase === "step-settle-seized-voucher";
  if (action === "burn") return phase === "step-burn";
  if (action === "finalizeReverseHeader") return phase === "step-finalizeReverseHeader";
  if (action === "updateReverseClient") return phase === "step-updateReverseClient";
  if (action === "proveReverseUnlock") return phase === "step-prove-reverse";
  if (action === "simulatePriceShock") return phase === "step-price-shock";
  if (action === "executeLiquidation") return phase === "step-liquidation";
  if (action === "freezeClient") return phase === "step-freeze-client";
  if (action === "recoverClient") return phase === "step-recover-client";
  if (action === "borrowerCloseout") return phase.startsWith("borrower-closeout");
  if (action === "fullFlow" || action === "riskLifecycle") return !phase.startsWith("step-");
  return false;
}

function controllerState() {
  return {
    busy: activeOperation !== null,
    activeOperation: publicActiveOperation(),
  };
}

function idleControllerState() {
  return {
    busy: false,
    activeOperation: null,
  };
}

function statusWithIdleController(status) {
  return {
    ...(status || {}),
    controller: idleControllerState(),
  };
}

function controllerBusyError(requestedAction) {
  const active = publicActiveOperation();
  const requestedLabel = operationLabel(requestedAction);
  const activeLabel = active?.label || "another demo action";
  const message = `${activeLabel} is already running. Wait for it to finish before starting ${requestedLabel}.`;
  const error = new Error(message);
  error.statusCode = 409;
  error.payload = {
    ok: false,
    error: message,
    output: `[controller] ${message}`,
    controller: controllerState(),
  };
  return error;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function contractCodeReadError(error) {
  return [
    error?.code,
    error?.shortMessage,
    error?.info?.error?.message,
    error?.message,
  ]
    .filter(Boolean)
    .join(" | ");
}

async function readContractCodeWithRetry(provider, address, label) {
  let lastProblem = "RPC returned invalid/null contract code";
  for (let attempt = 1; attempt <= CODE_READ_RETRIES; attempt++) {
    try {
      const code = await provider.getCode(ethers.getAddress(address), "latest");
      if (typeof code === "string") return { code };
      lastProblem = `RPC returned ${code === null ? "null" : typeof code} contract code`;
    } catch (error) {
      lastProblem = contractCodeReadError(error) || error.message;
    }
    if (attempt < CODE_READ_RETRIES) {
      await sleep(CODE_READ_RETRY_DELAY_MS * attempt);
    }
  }
  return { code: null, error: `${label}: ${lastProblem}` };
}

async function waitForHeartbeatIdle() {
  const deadline = Date.now() + HEARTBEAT_IDLE_TIMEOUT_MS;
  if (heartbeatRunning) setActiveOperationStage("Waiting for light-client heartbeat");
  while (heartbeatRunning && Date.now() < deadline) {
    await sleep(500);
  }
  if (heartbeatRunning) {
    const message =
      `Light-client heartbeat is still refreshing proof anchors after ${Math.round(HEARTBEAT_IDLE_TIMEOUT_MS / 1000)}s. ` +
      "Wait for the current refresh to finish, or restart the demo UI if the controller is stuck.";
    const error = new Error(message);
    error.statusCode = 503;
    error.demoSafeMessage = message;
    error.payload = {
      ok: false,
      error: message,
      output: `[controller] ${message}`,
      controller: controllerState(),
    };
    throw error;
  }
}

function actionCanRunDuringHeartbeat(action) {
  return action === "finalizeForwardHeader" || action === "finalizeReverseHeader";
}

function proofReadinessGapError(label, trustedHeight, latestHeight, maxGap) {
  const message =
    `${label} latest source height ${latestHeight.toString()} is too far ahead of trusted height ${trustedHeight.toString()} ` +
    `(gap ${(latestHeight - trustedHeight).toString()}, limit ${maxGap.toString()}). ` +
    "Resume Session will not catch up that many headers during a live click. Keep the demo service running so the light-client heartbeat can keep proof anchors warm; if the chain was reset with besu:down -v, run npm run deploy and npm run seed once.";
  const error = new Error(message);
  error.statusCode = 409;
  error.demoSafeMessage = message;
  return error;
}

function invalidatePreparedContext() {
  preparedContextCache = null;
}

function staleCachedDeploymentError(reason) {
  const message =
    "Cached deployment is no longer valid on the currently running Besu chains. Run Prepare Demo Session, or run npm run deploy and npm run seed after besu:down -v.";
  const error = new Error(message);
  error.statusCode = 409;
  error.demoSafeMessage = message;
  error.healthReason = reason;
  return error;
}

function warnHeartbeatSkip(message) {
  if (message === lastHeartbeatSkipMessage) return;
  lastHeartbeatSkipMessage = message;
  console.warn(`[heartbeat] proof anchor refresh skipped: ${message}`);
}

async function assertOnChainDeploymentHealth(config, timeoutMs = FAST_READY_TIMEOUT_MS) {
  const missingFields = CRITICAL_DEPLOYMENT_CONTRACTS
    .filter(([chainKey, field]) => !config.chains?.[chainKey]?.[field])
    .map(([chainKey, field]) => `${chainKey}.${field}`);
  for (const chainKey of ["A", "B"]) {
    if (config.chains?.[chainKey]?.chainId == null) missingFields.push(`${chainKey}.chainId`);
  }
  if (missingFields.length > 0) {
    throw new Error(`runtime config is missing critical fields: ${missingFields.join(", ")}`);
  }

  const providerByChain = {
    A: providerForChain(config, "A"),
    B: providerForChain(config, "B"),
  };
  const codeRequests = CRITICAL_DEPLOYMENT_CONTRACTS.map(([chainKey, field]) => {
    const address = config.chains[chainKey][field];
    if (!ethers.isAddress(address)) {
      return Promise.resolve({ chainKey, field, address, code: "0x", invalid: true });
    }
    return readContractCodeWithRetry(providerByChain[chainKey], address, `${chainKey}.${field}`).then((result) => ({
      chainKey,
      field,
      address,
      code: result.code,
      invalid: result.code == null,
      error: result.error,
    }));
  });
  const [networkA, networkB, ...codeChecks] = await withTimeout(
    Promise.all([providerByChain.A.getNetwork(), providerByChain.B.getNetwork(), ...codeRequests]),
    timeoutMs,
    "on-chain cached deployment health check"
  );

  const chainMismatches = [
    ["A", networkA.chainId],
    ["B", networkB.chainId],
  ].flatMap(([chainKey, actual]) => {
    const expected = BigInt(config.chains[chainKey].chainId);
    return BigInt(actual) === expected ? [] : [`${chainKey}.chainId expected ${expected.toString()} got ${actual.toString()}`];
  });
  const missingCode = codeChecks
    .filter((check) => check.invalid || check.code == null || check.code === "0x")
    .map((check) => `${check.chainKey}.${check.field}=${check.address ?? "missing"}${check.error ? ` (${check.error})` : ""}`);
  const problems = [...chainMismatches, ...missingCode];
  if (problems.length > 0) {
    throw new Error(problems.join("; "));
  }
}

async function probeOnChainDeploymentHealth(config, timeoutMs = FAST_READY_TIMEOUT_MS) {
  try {
    await assertOnChainDeploymentHealth(config, timeoutMs);
    return { ready: true, reason: "Configured deployment code and chain ids are present on-chain." };
  } catch (error) {
    return { ready: false, reason: error.message };
  }
}

async function probeOnChainDeploymentHealthWithGrace(config, { timeoutMs = FAST_READY_TIMEOUT_MS, graceMs = HEALTH_GRACE_RETRY_MS } = {}) {
  const deadline = Date.now() + graceMs;
  let health = await probeOnChainDeploymentHealth(config, timeoutMs);
  while (!health.ready && Date.now() < deadline) {
    setActiveOperationStage("Waiting for Besu RPC readiness");
    await sleep(1000);
    health = await probeOnChainDeploymentHealth(config, timeoutMs);
  }
  return health;
}

function setActiveOperationStage(stage) {
  if (activeOperation) activeOperation.stage = stage;
}

function actionExecutionStage(action) {
  if (action === "fullFlow" || action === "borrowerCloseout") return "Running scripted lifecycle";
  if (action === "openRoute") return "Opening proof-checked route";
  if (action === "finalizeForwardHeader" || action === "finalizeReverseHeader") return "Reading finalized Besu header";
  if (action === "updateForwardClient" || action === "updateReverseClient" || action === "recoverClient") {
    return "Importing trusted header";
  }
  if (
    action === "proveForwardMint" ||
    action === "proveReverseUnlock" ||
    action === "replayForward" ||
    action === "executeTimeoutRefund"
  ) {
    return "Generating storage proof";
  }
  if (action === "freezeClient") return "Submitting conflicting-header evidence";
  return "Submitting transaction";
}

function stageFromDemoPhase(phase) {
  const stages = {
    "step-open-route-check": "Checking existing connection and channel",
    "step-open-route-connection-init": "Submitting Bank A connection init",
    "step-open-route-connection-source-proof": "Generating Bank A connection proof",
    "step-open-route-connection-try": "Submitting Bank B connection try",
    "step-open-route-connection-destination-proof": "Generating Bank B connection proof",
    "step-open-route-connection-ack": "Submitting Bank A connection acknowledgement",
    "step-open-route-connection-source-open-proof": "Generating Bank A open-connection proof",
    "step-open-route-connection-confirm": "Submitting Bank B connection confirmation",
    "step-open-route-channel-init": "Submitting Bank A channel init",
    "step-open-route-channel-source-proof": "Generating Bank A channel proof",
    "step-open-route-channel-try": "Submitting Bank B channel try",
    "step-open-route-channel-destination-proof": "Generating Bank B channel proof",
    "step-open-route-channel-ack": "Submitting Bank A channel acknowledgement",
    "step-open-route-channel-source-open-proof": "Generating Bank A open-channel proof",
    "step-open-route-channel-confirm": "Submitting Bank B channel confirmation",
    "step-open-route-status": "Reading final route readiness",
    "step-prove-forward-check-route": "Checking route and packet commitment",
    "step-prove-forward-packet-proof-anchor": "Trusting Bank A proof header",
    "step-prove-forward-packet-proof-build": "Generating Bank A packet storage proof",
    "step-prove-forward-receive-tx": "Submitting voucher mint proof transaction",
    "step-prove-forward-ack-proof-anchor": "Trusting Bank B acknowledgement header",
    "step-prove-forward-ack-proof-build": "Generating acknowledgement storage proof",
    "step-prove-forward-ack-tx": "Submitting acknowledgement proof transaction",
    "step-prove-forward-refresh": "Reading refreshed voucher state",
  };
  return stages[phase] || null;
}

async function runtimeConfigFingerprint() {
  const config = await loadRuntimeConfig();
  return JSON.stringify({
    build: config.build,
    participants: config.participants,
    seed: config.seed,
    status: {
      deployed: Boolean(config.status?.deployed),
      seeded: Boolean(config.status?.seeded),
    },
    chains: {
      A: config.chains?.A,
      B: config.chains?.B,
    },
  });
}

async function preparedContextForUiAction() {
  setActiveOperationStage("Preparing context");
  const fingerprint = await runtimeConfigFingerprint();
  if (preparedContextCache?.fingerprint === fingerprint) {
    if (Date.now() - (preparedContextCache.checkedAtMs || 0) < PREPARED_CONTEXT_HEALTH_TTL_MS) {
      return preparedContextCache.prepared;
    }
    setActiveOperationStage("Checking cached deployment");
    const health = await probeOnChainDeploymentHealthWithGrace(preparedContextCache.prepared.config);
    if (!health.ready) {
      runtimeReadyConfirmed = false;
      invalidatePreparedContext();
      throw staleCachedDeploymentError(health.reason);
    }
    preparedContextCache.checkedAtMs = Date.now();
    return preparedContextCache.prepared;
  }

  const semanticConfigChanged = Boolean(preparedContextCache && preparedContextCache.fingerprint !== fingerprint);
  const useCachedPrepare = runtimeReadyConfirmed && !semanticConfigChanged;
  const prepared = await prepareStepContext({
    validateSeedOnly: true,
    skipRuntimeReady: useCachedPrepare,
    skipDeploymentCode: useCachedPrepare,
  });
  if (useCachedPrepare) {
    setActiveOperationStage("Checking prepared deployment");
    const health = await probeOnChainDeploymentHealthWithGrace(prepared.config);
    if (!health.ready) {
      runtimeReadyConfirmed = false;
      invalidatePreparedContext();
      throw staleCachedDeploymentError(health.reason);
    }
  }
  runtimeReadyConfirmed = true;
  preparedContextCache = { fingerprint, prepared, checkedAtMs: Date.now() };
  return prepared;
}

async function withControllerLock(action, run) {
  if (activeOperation) throw controllerBusyError(action);

  activeOperation = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    action,
    label: operationLabel(action),
    stage: !actionCanRunDuringHeartbeat(action) && heartbeatRunning ? "Waiting for light-client heartbeat" : "Preparing controller",
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
  };

  try {
    if (!actionCanRunDuringHeartbeat(action)) await waitForHeartbeatIdle();
    return await run();
  } finally {
    activeOperation = null;
  }
}

function runEnv(overrides = {}) {
  const temp = process.env.TMPDIR || process.env.TEMP || process.env.TMP || "/tmp";
  return {
    ...process.env,
    USE_BESU_KEYS: process.env.USE_BESU_KEYS || "true",
    RUNTIME_MODE: process.env.RUNTIME_MODE || "besu",
    PROOF_POLICY: process.env.PROOF_POLICY || "storage-required",
    CHAIN_A_RPC: process.env.CHAIN_A_RPC || "http://127.0.0.1:8545",
    CHAIN_B_RPC: process.env.CHAIN_B_RPC || "http://127.0.0.1:9545",
    TMPDIR: temp,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || resolve(temp, ".cache"),
    ...overrides,
  };
}

function runCommand(command, args, { timeoutMs = DEFAULT_TIMEOUT_MS, env = {} } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const useShell = process.platform === "win32" && command === npm;
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: runEnv(env),
      shell: useShell,
      windowsHide: true,
    });
    let output = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      child.kill();
      rejectRun(
        new Error(`${command} ${args.join(" ")} timed out after ${Math.round(timeoutMs / 1000)}s\n${output}`)
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      finished = true;
      clearTimeout(timer);
      rejectRun(new Error(`${command} ${args.join(" ")} could not start: ${error.message}`));
    });
    child.on("close", (code) => {
      finished = true;
      clearTimeout(timer);
      if (code === 0) return resolveRun(output);
      rejectRun(new Error(`${command} ${args.join(" ")} failed with exit code ${code}\n${output}`));
    });
  });
}

function normalizeAmountInput(value) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(text)) {
    throw new Error("Amount must be a non-negative decimal with up to 18 decimals.");
  }
  if (ethers.parseUnits(text, 18) <= 0n) {
    throw new Error("Amount must be greater than zero.");
  }
  return text;
}

function normalizeActionRequest(request) {
  if (typeof request === "string") return { action: request, amount: null };
  return {
    action: String(request?.action || ""),
    amount: normalizeAmountInput(request?.amount),
  };
}

function actionAmountEnv(request) {
  if (!request.amount) return {};
  if (request.action === "lock") return { DEMO_FORWARD_AMOUNT: request.amount };
  if (request.action === "depositCollateral") return { DEMO_DEPOSIT_AMOUNT: request.amount };
  if (request.action === "borrow") return { DEMO_BORROW_AMOUNT: request.amount };
  if (request.action === "repay") return { DEMO_REPAY_AMOUNT: request.amount };
  if (request.action === "withdrawCollateral") return { DEMO_WITHDRAW_AMOUNT: request.amount };
  if (request.action === "simulatePriceShock") return { DEMO_SHOCKED_VOUCHER_PRICE: request.amount };
  if (request.action === "executeLiquidation") return { DEMO_LIQUIDATION_REPAY: request.amount };
  return {};
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolveTimeout, rejectTimeout) => {
    const timer = setTimeout(() => {
      rejectTimeout(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolveTimeout(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectTimeout(error);
      }
    );
  });
}

async function rpcSnapshot(config) {
  const providerA = providerForChain(config, "A");
  const providerB = providerForChain(config, "B");
  const [networkA, networkB, latestA, latestB] = await withTimeout(
    Promise.all([providerA.getNetwork(), providerB.getNetwork(), providerA.getBlockNumber(), providerB.getBlockNumber()]),
    FAST_READY_TIMEOUT_MS,
    "Besu RPC health check"
  );
  return {
    providerA,
    providerB,
    latestA: BigInt(latestA),
    latestB: BigInt(latestB),
    chainA: networkA.chainId.toString(),
    chainB: networkB.chainId.toString(),
  };
}

async function refreshOneProofAnchor({
  label,
  lightClient,
  provider,
  sourceChainId,
  latestHeight,
  maxGap,
  maxHeaders = null,
}) {
  const trustedHeight = BigInt(await lightClient.latestTrustedHeight(sourceChainId));
  const latest = BigInt(latestHeight);
  if (latest <= trustedHeight) {
    return { label, changed: false, trustedHeight, targetHeight: trustedHeight, latestHeight: latest, reason: "already current" };
  }

  const gap = latest - trustedHeight;
  if (trustedHeight !== 0n && gap > maxGap) {
    throw proofReadinessGapError(label, trustedHeight, latest, maxGap);
  }

  const targetHeight = maxHeaders == null ? latest : trustedHeight + (gap > maxHeaders ? maxHeaders : gap);
  const trusted = await trustRemoteHeaderAt({
    lightClient,
    provider,
    sourceChainId,
    targetHeight,
    validatorEpoch: 1n,
  });
  return {
    label,
    changed: true,
    trustedHeight: BigInt(trusted.headerUpdate.height),
    targetHeight,
    latestHeight: latest,
    reason: targetHeight < latest ? "bounded heartbeat update" : "refreshed to latest",
  };
}

async function refreshProofAnchors({ config, ctx, latestA, latestB, maxGap, maxHeaders = null }) {
  const sourceChainId = chainId(config, "A");
  const destinationChainId = chainId(config, "B");
  const route = await currentRouteStatus(config, ctx);
  if (!route.ready) {
    return {
      route,
      updates: [],
      skipped: "Route is not open yet; light-client proof anchors will refresh after Establish Bank Route.",
    };
  }

  const updates = [];
  updates.push(
    await refreshOneProofAnchor({
      label: "Bank A on Bank B",
      lightClient: ctx.B.lightClient,
      provider: ctx.providerA,
      sourceChainId,
      latestHeight: latestA,
      maxGap,
      maxHeaders,
    })
  );
  updates.push(
    await refreshOneProofAnchor({
      label: "Bank B on Bank A",
      lightClient: ctx.A.lightClient,
      provider: ctx.providerB,
      sourceChainId: destinationChainId,
      latestHeight: latestB,
      maxGap,
      maxHeaders,
    })
  );
  return { route, updates };
}

function statusNumber(value) {
  const number = Number(String(value ?? "0").replace(/,/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function statusPositive(value) {
  return statusNumber(value) > 0.000001;
}

function statusHeightAtLeast(value, minimum) {
  if (value == null || minimum == null) return false;
  try {
    return BigInt(value) >= BigInt(minimum);
  } catch {
    return false;
  }
}

function repayCloseBuffer(amount) {
  const number = statusNumber(amount);
  if (number <= 0) return 0;
  return Math.max((number * REPAY_CLOSE_BUFFER_BPS) / 10_000, REPAY_CLOSE_MIN_BUFFER);
}

function repayFundingShortfallFromStatus(status) {
  const balances = status?.balances || {};
  const debt = statusNumber(balances.poolDebt);
  const target = debt > 0 ? debt + repayCloseBuffer(debt) : 0;
  return Math.max(0, target - statusNumber(balances.bankB));
}

function visibleStateReached(action, status, before = null) {
  if (!status) return false;
  const balances = status.balances || {};
  const beforeBalances = before?.balances || {};
  const number = (value) => statusNumber(value);
  const movedUp = (after, old) => number(after) > number(old) + 0.000001;
  const movedDown = (after, old) => number(after) < number(old) - 0.000001;
  const forward = status.trace?.forward || {};
  const reverse = status.trace?.reverse || {};
  const traceRisk = status.trace?.risk || {};
  switch (action) {
    case "lock":
      return Boolean(
        (forward.packetId || forward.commitHeight) &&
          (!before || movedUp(balances.escrow, beforeBalances.escrow) || movedDown(balances.bankA, beforeBalances.bankA))
      );
    case "proveForwardMint":
      return Boolean(
        status.security?.forwardConsumed ||
          forward.receiveTxHash ||
          (!before || movedUp(balances.voucher, beforeBalances.voucher) || movedUp(balances.poolCollateral, beforeBalances.poolCollateral))
      );
    case "depositCollateral":
      if (before) {
        return movedUp(balances.poolCollateral, beforeBalances.poolCollateral) || movedDown(balances.voucher, beforeBalances.voucher);
      }
      return statusPositive(balances.poolCollateral) || Boolean(traceRisk.collateralDeposited);
    case "borrow":
      return Boolean(!before || movedUp(balances.poolDebt, beforeBalances.poolDebt) || movedUp(balances.bankB, beforeBalances.bankB));
    case "repay":
      return Boolean(!before || movedDown(balances.poolDebt, beforeBalances.poolDebt));
    case "withdrawCollateral":
      return Boolean(
        traceRisk.withdrawTxHash ||
          traceRisk.collateralWithdrawn ||
          !before ||
          movedDown(balances.poolCollateral, beforeBalances.poolCollateral) ||
          movedUp(balances.voucher, beforeBalances.voucher)
      );
    case "burn":
      return Boolean(
        reverse.packetId ||
          reverse.commitHeight ||
          (!before || movedDown(balances.voucher, beforeBalances.voucher))
      );
    case "topUpRepayCash":
      return Boolean(!before || movedUp(balances.bankB, beforeBalances.bankB));
    default:
      return true;
  }
}

async function readDemoStatusAfterVisibleChange(action, beforeStatus) {
  const deadline = Date.now() + VISIBLE_STATE_RETRY_MS;
  let status = await readDemoStatusForPayload();
  while (
    (!visibleStateReached(action, status, beforeStatus) || !finalActionStatusReady(action, status)) &&
    Date.now() < deadline
  ) {
    setActiveOperationStage("Waiting for visible dashboard state");
    await sleep(750);
    status = await readDemoStatusForPayload();
  }
  return status;
}

function finalActionStatusReady(action, status) {
  if (action !== "depositCollateral") return true;
  return nextValidActionFromStatus(status).action !== "depositCollateral";
}

function lendingLifecycleFromStatus(status) {
  const balances = status?.balances || {};
  const trace = status?.trace || {};
  const lending = trace.lending || {};
  const risk = trace.risk || {};
  const reverse = trace.reverse || {};
  const settlement = status?.risk?.settlement || {};
  const afterLiquidation = status?.risk?.afterLiquidation || {};
  const settlementTrace = trace.liquidatorSettlement || {};
  const activeCollateral = statusPositive(balances.poolCollateral);
  const activeDebt = statusPositive(balances.poolDebt);
  const freeVoucher = statusPositive(balances.voucher);
  const debtWasOpened = Boolean(
    lending.borrowed ||
      risk.borrowed ||
      risk.debtBeforeRepay ||
      risk.repayTxHash ||
      risk.repaid ||
      risk.liquidationTxHash ||
      risk.debtBeforeLiquidation ||
      activeDebt
  );
  const collateralWasDeposited = Boolean(
    lending.collateralDeposited ||
      risk.collateralDeposited ||
      risk.collateralBeforeWithdrawal ||
      risk.withdrawTxHash ||
      activeCollateral ||
      debtWasOpened
  );
  const borrowerCollateralWithdrawn = Boolean(
    lending.collateralWithdrawn ||
      risk.collateralWithdrawn ||
      risk.withdrawTxHash ||
      (debtWasOpened && collateralWasDeposited && !activeCollateral)
  );
  const reverseStarted = Boolean(reverse.packetId || reverse.commitHeight || reverse.sourceTxHash);
  const settlementPacketId = settlement.packetId || settlementTrace.packetId;
  const settlementMatchesReverse = Boolean(settlementPacketId && settlementPacketId === reverse.packetId);
  const settlementStarted = Boolean(
    settlementMatchesReverse &&
      (settlement.started ||
        settlementTrace.packetId ||
        settlementTrace.burnTxHash ||
        reverse.settlementMode === "authorized-liquidator")
  );
  const settlementUnlocked = Boolean(settlementMatchesReverse && (settlement.unlocked || settlementTrace.unlockTxHash));
  const borrowerReverseStarted = reverseStarted && !settlementStarted;
  const borrowerReverseComplete = Boolean(borrowerReverseStarted && (status.security?.reverseConsumed || reverse.receiveTxHash));
  const liquidationExecuted = Boolean(afterLiquidation.executed || risk.liquidationTxHash || lending.liquidated);
  const settlementVoucher = statusPositive(settlement.seizedVoucherBalance || balances.liquidatorVoucher);
  return {
    activeCollateral,
    activeDebt,
    freeVoucher,
    debtWasOpened,
    borrowerCollateralWithdrawn,
    borrowerReverseStarted,
    borrowerReverseComplete,
    liquidationExecuted,
    settlementStarted,
    settlementUnlocked,
    settlementVoucher,
  };
}

function forwardProofActionFromStatus(status) {
  const forward = status?.trace?.forward || {};
  const progress = status?.progress || {};
  const headerReady = statusHeightAtLeast(forward.finalizedHeight, forward.commitHeight);
  const trustReady =
    statusHeightAtLeast(progress.trustedAOnB, forward.commitHeight) ||
    statusHeightAtLeast(forward.trustedHeight, forward.commitHeight);
  if (!headerReady && !trustReady) return "finalizeForwardHeader";
  return trustReady ? "proveForwardMint" : "updateForwardClient";
}

function reverseProofActionFromStatus(status) {
  const reverse = status?.trace?.reverse || {};
  const progress = status?.progress || {};
  const headerReady = statusHeightAtLeast(reverse.finalizedHeight, reverse.commitHeight);
  const trustReady =
    statusHeightAtLeast(progress.trustedBOnA, reverse.commitHeight) ||
    statusHeightAtLeast(reverse.trustedHeight, reverse.commitHeight);
  if (!headerReady && !trustReady) return "finalizeReverseHeader";
  return trustReady ? "proveReverseUnlock" : "updateReverseClient";
}

function nextValidActionFromStatus(status) {
  if (!status?.deployed) return { action: "deploySeed", label: "Prepare Demo Session" };
  if (status.security?.frozen || status.security?.recovering) return { action: "recoverClient", label: "Recover Account" };
  const trace = status.trace || {};
  const balances = status.balances || {};
  const market = status.market || {};
  const lifecycle = lendingLifecycleFromStatus(status);
  const forward = trace.forward || {};
  const reverse = trace.reverse || {};
  const forwardDelivered =
    Boolean(status.security?.forwardConsumed) ||
    Boolean(forward.receiveTxHash);
  const forwardPending = Boolean(forward.packetId || forward.commitHeight) && !forwardDelivered;
  const reverseDelivered =
    Boolean(status.security?.reverseConsumed) ||
    Boolean(reverse.receiveTxHash) ||
    Boolean(status.risk?.settlement?.unlocked) ||
    Boolean(trace.liquidatorSettlement?.unlockTxHash);
  const reversePending = Boolean(reverse.packetId || reverse.commitHeight) && !reverseDelivered;

  if (lifecycle.liquidationExecuted) {
    if (lifecycle.settlementVoucher && !lifecycle.settlementStarted) {
      return { action: "settleSeizedVoucher", label: "Settle Seized Voucher" };
    }
    if (lifecycle.settlementStarted && !lifecycle.settlementUnlocked) {
      const action = reversePending ? reverseProofActionFromStatus(status) : "proveReverseUnlock";
      return { action, label: reverseProofStepLabel(action) };
    }
    return { action: "refresh", label: "Refresh state" };
  }

  if (lifecycle.borrowerReverseComplete) return { action: "refresh", label: "Refresh state" };

  if (lifecycle.borrowerReverseStarted || reversePending) {
    const action = reverseProofActionFromStatus(status);
    return { action, label: reverseProofStepLabel(action) };
  }

  if (lifecycle.borrowerCollateralWithdrawn && lifecycle.freeVoucher) {
    return { action: "burn", label: "Burn voucher and start Bank A unlock" };
  }

  if (forwardPending) {
    const action = forwardProofActionFromStatus(status);
    return { action, label: forwardProofStepLabel(action) };
  }

  if (lifecycle.freeVoucher && !lifecycle.activeDebt && !lifecycle.activeCollateral) {
    return lifecycle.debtWasOpened
      ? { action: "burn", label: "Burn voucher and start Bank A unlock" }
      : { action: "depositCollateral", label: "Deposit Collateral" };
  }

  if (lifecycle.activeDebt) {
    if (repayFundingShortfallFromStatus(status) > 0.000001) {
      return { action: "topUpRepayCash", label: "Add demo bCASH for repayment" };
    }
    return { action: "repay", label: "Repay Loan" };
  }

  if (lifecycle.activeCollateral && lifecycle.debtWasOpened) {
    return { action: "withdrawCollateral", label: "Withdraw collateral to return" };
  }

  if (lifecycle.activeCollateral && statusNumber(market.availableToBorrow) > 0) {
    return { action: "borrow", label: "Borrow Cash" };
  }

  if (lifecycle.freeVoucher && !lifecycle.activeDebt) {
    return { action: "depositCollateral", label: "Deposit Collateral" };
  }

  if (!trace.handshake?.ready && !trace.handshake?.sourceRouteOpen && !trace.handshake?.destinationRouteOpen) {
    return { action: "openRoute", label: "Establish Bank Route" };
  }

  if (statusNumber(balances.bankA) > 0) return { action: "lock", label: "Transfer Collateral to Bank B" };
  return { action: "refresh", label: "Refresh state" };
}

function nextActionPayload(status) {
  return nextValidActionFromStatus(status || {});
}

async function readDemoStatusForPayload() {
  try {
    return await withTimeout(readDemoStatus(), STATUS_READ_TIMEOUT_MS, "read demo status");
  } catch (error) {
    const timedOut = /timed out/i.test(error.message || "");
    return {
      ready: false,
      transient: true,
      statusReadTimedOut: timedOut,
      statusReadFailed: !timedOut,
      stackVersion: "besu-light-client",
      label: timedOut ? "Status read timeout" : "Status read failed",
      message: error.message,
      controller: controllerState(),
    };
  }
}

async function reusableSeededDeploymentReady() {
  const config = await loadRuntimeConfig().catch(() => null);
  if (!config?.status?.deployed || !config?.status?.seeded || !config.participants) {
    return { ready: false, reason: "No seeded runtime config is available." };
  }

  if (config.build?.storageWordRlp !== "canonical-trimmed-v1") {
    return {
      ready: false,
      reason: "Seeded runtime config was created before the canonical storage-proof RLP fix. Use Fresh Reset once.",
    };
  }
  const expectedFingerprint = await expectedArtifactFingerprint();
  if (config.build?.artifactFingerprint !== expectedFingerprint) {
    return {
      ready: false,
      reason: "Seeded runtime config was created with different contract artifacts. Use Fresh Reset once.",
    };
  }

  const health = await probeOnChainDeploymentHealth(config);
  if (!health.ready) return health;
  return { ready: true, reason: "Existing interchain lending deployment is already deployed, seeded, and present on-chain." };
}

async function maybeCompileForDemoReset(scripts) {
  if (process.env.DEMO_RESET_COMPILE === "true") {
    return runCommand(scripts.compile.command, scripts.compile.args);
  }

  try {
    await expectedArtifactFingerprint();
    return "[controller] Skipped compile for demo reset; using current Hardhat artifacts.";
  } catch (error) {
    return [
      "[controller] Current Hardhat artifacts are missing or unreadable; compiling before reset.",
      await runCommand(scripts.compile.command, scripts.compile.args),
    ].join("\n");
  }
}

export async function hasDeploymentConfig() {
  try {
    await access(configPath);
    return true;
  } catch {
    return false;
  }
}

export async function runtimeScripts() {
  const runtime = normalizeRuntime();
  if (!runtime.besuFirst) {
    throw new Error("Demo service only supports the canonical Besu-first runtime.");
  }
  return {
    compile: { command: npm, args: ["run", "compile"] },
    deploy: { command: node, args: ["scripts/deploy-lending-demo.mjs"] },
    seed: { command: node, args: ["scripts/seed-lending-demo.mjs"] },
    flow: { command: node, args: ["scripts/run-lending-demo.mjs"] },
    runtime,
  };
}

async function deployAndSeed({ reset = false } = {}) {
  if (!reset) {
    setActiveOperationStage("Checking seeded runtime");
    const reusableReady = await reusableSeededDeploymentReady();
    if (reusableReady.ready) {
      runtimeReadyConfirmed = true;
      invalidatePreparedContext();
      return {
        ready: true,
        mode: "confirmed-existing",
        message: "Existing seeded runtime confirmed ready and reused. No clean reset was performed.",
        output: [
          `[controller] ${reusableReady.reason}`,
          "[controller] Reused current on-chain state; oracle, liquidation, balances, and previous demo actions were not reset.",
          "[controller] Use Fresh Reset for a clean redeploy and seeded baseline.",
        ].join("\n"),
      };
    }
    if (await hasDeploymentConfig()) {
      runtimeReadyConfirmed = false;
      invalidatePreparedContext();
      return {
        ready: false,
        warning: true,
        mode: "reuse-probe-failed",
        message: "Existing runtime config was not confirmed ready. Run Fresh Reset before the live demo.",
        output: [
          "[controller] Existing runtime config is not confirmed ready for reuse.",
          `[controller] ${reusableReady.reason}`,
          "[controller] Skipped automatic redeploy because Prepare Demo Session only reuses confirmed seeded deployments.",
          "[controller] Use Fresh Reset before the demo window if you need a clean deployment.",
        ].join("\n"),
      };
    }
  }

  runtimeReadyConfirmed = false;
  invalidatePreparedContext();
  const scripts = await runtimeScripts();
  setActiveOperationStage("Checking artifacts");
  const compile = await maybeCompileForDemoReset(scripts);
  setActiveOperationStage("Deploying contracts");
  const deploy = await runCommand(scripts.deploy.command, scripts.deploy.args);
  setActiveOperationStage("Seeding policy and liquidity");
  const seed = await runCommand(scripts.seed.command, scripts.seed.args);
  runtimeReadyConfirmed = true;
  invalidatePreparedContext();
  const freshTrace = {
    version: "interchain-lending",
    generatedAt: new Date().toISOString(),
    latestOperation: {
      phase: "seeded",
      label: reset ? "Reset interchain lending runtime to seeded baseline" : "Prepared interchain lending runtime and demo balances",
      summary: reset
        ? "A fresh interchain lending deployment was created and seeded so the demo is back at the post-seed baseline."
        : "Contracts are deployed and policy/oracle/risk seed state is ready for the storage-proof lending flow.",
    },
  };
  await writeFile(traceJsonPath, `${JSON.stringify(freshTrace, null, 2)}\n`);
  await writeFile(traceJsPath, `window.InterchainLendingLatestRun = ${JSON.stringify(freshTrace, null, 2)};\n`);
  return {
    ready: true,
    mode: reset ? "fresh-reset" : "fresh-deploy",
    message: reset ? "Fresh reset completed and seeded." : "Fresh deployment and seed completed.",
    output: `${compile}\n${deploy}\n${seed}`,
  };
}

async function runFlowStrict() {
  if (!(await hasDeploymentConfig())) {
    return {
      ok: false,
      output: "[controller] No .interchain-lending.local.json found. Press Prepare Demo Session or Fresh Reset before running the flow.\n",
      error: "No local deployment config.",
    };
  }

  try {
    return await runDemoActionInProcess("fullFlow");
  } catch (error) {
    let output = "";
    output += "\n[controller] Flow failed. No automatic redeploy or retry was performed.\n";
    error.phase = typeof error?.phase === "string" && error.phase.length > 0 ? error.phase : getCurrentPhase();
    output += [error.capturedOutput, `run-lending-demo failed during phase: ${error.phase}`, error.stack || error.message]
      .filter(Boolean)
      .join("\n");
    return {
      ok: false,
      output,
      error: "Contract flow failed. Inspect the failed path, then redeploy/seed manually if needed.",
    };
  }
}

async function captureDemoOutput(run) {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const lines = [];
  const stringify = (value) => {
    try {
      return JSON.stringify(value, (_, nested) => (typeof nested === "bigint" ? nested.toString() : nested));
    } catch {
      return String(value);
    }
  };
  const capture = (level) => (...args) => {
    const line = args
      .map((arg) => (typeof arg === "string" ? arg : arg instanceof Error ? arg.stack || arg.message : stringify(arg)))
      .join(" ");
    lines.push(level === "log" ? line : `[${level}] ${line}`);
    original[level](...args);
  };
  console.log = capture("log");
  console.warn = capture("warn");
  console.error = capture("error");
  try {
    const value = await run();
    return { value, output: lines.join("\n") };
  } catch (error) {
    error.capturedOutput = lines.join("\n");
    throw error;
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

async function runDemoActionInProcess(action, env = {}) {
  applyDemoAmountOverrides(env);
  const useCachedContext = action !== "fullFlow" && action !== "riskLifecycle" && action !== "borrowerCloseout";
  const prepared = useCachedContext ? await preparedContextForUiAction() : null;
  setActiveOperationStage(actionExecutionStage(action));
  const result = await captureDemoOutput(() =>
    useCachedContext ? runDemoStep(action, { prepared }) : runDemoStep(action)
  );
  setActiveOperationStage("Reading refreshed state");
  return {
    ok: true,
    output: result.output || `[controller] Completed ${operationLabel(action)} in process.`,
    trace: result.value,
  };
}

async function recoverOpenRouteCompletion(error) {
  const config = await loadRuntimeConfig();
  const ctx = await loadContext(config);
  const routeStatus = await robustCurrentRouteStatus(config, ctx, { repair: false });
  if (!routeStatus.ready) return null;

  config.status = {
    ...(config.status || {}),
    proofCheckedHandshakeOpened: true,
  };
  await saveRuntimeConfig(config);

  const trace = await writeTracePatch(
    config,
    ctx,
    {
      handshake: {
        ...handshakeTrace(config, { reused: true, recoveredAfterError: true }, { reused: true, recoveredAfterError: true }),
        ready: true,
        degraded: routeStatus.degraded || false,
        readError: routeStatus.readError,
        sourceRouteOpen: routeStatus.sourceRouteOpen,
        destinationRouteOpen: routeStatus.destinationRouteOpen,
      },
    },
    {
      phase: "route-ready",
      label: "Recovered opened IBC connection and channel",
      summary:
        routeStatus.degraded
          ? `Route is open; final status read remains degraded because Besu returned: ${routeStatus.readError}.`
          : `Connection ${routeStatus.connection.sourceStateName}/${routeStatus.connection.destinationStateName}, ` +
            `channel ${routeStatus.channel.sourceStateName}/${routeStatus.channel.destinationStateName}.`,
    }
  );

  return {
    ok: true,
    recovered: true,
    output: [
      error.capturedOutput,
      "[controller] Establish Bank Route reached the expected on-chain state.",
      `[controller] Recovered the UI trace after a finalization/read error: ${error.shortMessage || error.message}`,
    ]
      .filter(Boolean)
      .join("\n"),
    trace,
  };
}

export async function runActionPayload(actionRequest) {
  let request;
  try {
    request = normalizeActionRequest(actionRequest);
  } catch (error) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        output: `[controller] ${error.message}`,
        error: error.message,
        message: error.message,
        trace: await readTrace(),
        status: await readDemoStatusForPayload(),
      },
    };
  }

  const { action } = request;
  return withControllerLock(action, async () => {
    if (!(await hasDeploymentConfig())) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          output: "[controller] No .interchain-lending.local.json found. Press Prepare Demo Session or Fresh Reset before running demo actions.\n",
          error: "No local deployment config.",
          message: "No local deployment config.",
          trace: await readTrace(),
          status: await readDemoStatusForPayload(),
        },
      };
    }

    const env = actionAmountEnv(request);
    const beforeStatus = await readDemoStatusForPayload();
    let result;
    try {
      result = action === "fullFlow" ? await runFlowStrict() : await runDemoActionInProcess(action, env);
    } catch (error) {
      error.phase = typeof error?.phase === "string" && error.phase.length > 0 ? error.phase : getCurrentPhase();
      result = action === "openRoute" ? await recoverOpenRouteCompletion(error).catch(() => null) : null;
      if (!result) {
        const safeMessage = error.demoSafeMessage || `Demo action ${action} failed.`;
        result = {
          ok: false,
          statusCode: error.statusCode || 500,
          output: [
            error.capturedOutput,
            `run-lending-demo failed during phase: ${error.phase}`,
            error.healthReason ? `[controller] ${error.healthReason}` : null,
            error.stack || error.message,
          ].filter(Boolean).join("\n"),
          error: safeMessage,
        };
      }
    }

    const status = result.ok ? await readDemoStatusAfterVisibleChange(action, beforeStatus) : await readDemoStatusForPayload();
    const responseStatus = statusWithIdleController(status);
    const trace = await readTrace();
    return {
      statusCode: result.ok ? 200 : result.statusCode || 500,
      body: {
        ...result,
        message:
          result.ok && action === "fullFlow"
            ? "Completed the storage-proof cross-chain lending flow."
            : result.ok && action === "borrowerCloseout"
              ? "Closed the position and returned collateral."
            : result.ok
              ? `Completed demo action: ${operationLabel(action)}${request.amount ? ` (${request.amount}).` : "."}`
              : result.error,
        trace,
        status: responseStatus,
        nextAction: nextActionPayload(responseStatus),
      },
    };
  });
}

export async function healthPayload() {
  const scripts = await runtimeScripts();
  return {
    ok: true,
    platform: process.platform,
    cwd: process.cwd(),
    runtime: scripts.runtime,
    hasDeploymentConfig: await hasDeploymentConfig(),
    trace: await readTrace(),
    controller: controllerState(),
  };
}

export async function tracePayload() {
  return { trace: await readTrace() };
}

export async function statusPayload() {
  return {
    ...(await readDemoStatusForPayload()),
    controller: controllerState(),
  };
}

export async function deploySeedPayload() {
  return withControllerLock("deploySeed", async () => {
    const result = await deployAndSeed();
    setActiveOperationStage("Reading refreshed state");
    const status = statusWithIdleController(await readDemoStatusForPayload());
    return {
      ok: true,
      ready: result.ready,
      warning: Boolean(result.warning),
      mode: result.mode,
      message: result.message,
      output: result.output,
      trace: await readTrace(),
      status,
      nextAction: nextActionPayload(status),
    };
  });
}

export async function resetSeededPayload() {
  return withControllerLock("resetSeeded", async () => {
    const result = await deployAndSeed({ reset: true });
    setActiveOperationStage("Reading refreshed state");
    const status = statusWithIdleController(await readDemoStatusForPayload());
    return {
      ok: true,
      ready: result.ready,
      mode: result.mode,
      message: result.message,
      output: result.output,
      trace: await readTrace(),
      status,
      nextAction: nextActionPayload(status),
    };
  });
}

export async function resumeSessionPayload() {
  return withControllerLock("resumeSession", async () => {
    try {
      return await withTimeout((async () => {
        runtimeReadyConfirmed = false;
        invalidatePreparedContext();
        setActiveOperationStage("Reloading runtime config");
        const config = await loadRuntimeConfig();

        setActiveOperationStage("Pinging Besu RPC endpoints");
        const rpc = await rpcSnapshot(config);

        setActiveOperationStage("Checking deployed contract code");
        await assertOnChainDeploymentHealth(config, STATUS_READ_TIMEOUT_MS);

        setActiveOperationStage("Loading runtime contracts");
        const ctx = await loadContext(config);

        setActiveOperationStage("Refreshing proof anchors");
        const proofReadiness = await refreshProofAnchors({
          config,
          ctx,
          latestA: rpc.latestA,
          latestB: rpc.latestB,
          maxGap: RESUME_SESSION_MAX_HEADER_GAP,
          maxHeaders: RESUME_SESSION_MAX_HEADERS,
        });

        runtimeReadyConfirmed = true;
        invalidatePreparedContext();
        setActiveOperationStage("Reading refreshed state");
        const status = statusWithIdleController(await readDemoStatusForPayload());
        const nextAction = nextValidActionFromStatus(status);
        const updates = proofReadiness.updates || [];
        const partial = updates.some((update) => update.targetHeight < update.latestHeight);
        const updateSummary = updates
          .map((update) => `${update.label}: trusted ${update.trustedHeight.toString()} / latest ${update.latestHeight.toString()}`)
          .join("\n");

        return {
          ok: true,
          ready: true,
          partial,
          message: partial
            ? `Resume Session partially refreshed proof anchors. Next valid action: ${nextAction.label}.`
            : `Resume Session complete. Next valid action: ${nextAction.label}.`,
          output: [
            `[controller] Reloaded ${RUNTIME_CONFIG_PATH}.`,
            `[controller] Bank A RPC chain=${rpc.chainA} latest=${rpc.latestA.toString()}.`,
            `[controller] Bank B RPC chain=${rpc.chainB} latest=${rpc.latestB.toString()}.`,
            proofReadiness.skipped ? `[controller] ${proofReadiness.skipped}` : null,
            updateSummary ? `[controller] Proof anchors:\n${updateSummary}` : "[controller] Proof anchors already current.",
            partial
              ? `[controller] Resume is bounded to ${RESUME_SESSION_MAX_HEADERS.toString()} headers per chain per click to avoid a long live-demo catch-up. Keep this service running for heartbeat refresh, or click Resume again if the next action still needs a newer trusted height.`
              : null,
            `[controller] Next valid action: ${nextAction.label} (${nextAction.action}).`,
          ]
            .filter(Boolean)
            .join("\n"),
          nextAction,
          trace: await readTrace(),
          status,
        };
      })(), RESUME_SESSION_TIMEOUT_MS, "Resume Session");
    } catch (error) {
      runtimeReadyConfirmed = false;
      invalidatePreparedContext();
      const status = await readDemoStatusForPayload();
      const nextAction = nextValidActionFromStatus(status);
      const message = error.demoSafeMessage || error.message || "Resume Session failed.";
      return {
        ok: false,
        ready: false,
        statusCode: error.statusCode || 500,
        error: message,
        message,
        output: [
          `[controller] Resume Session failed.`,
          error.healthReason ? `[controller] ${error.healthReason}` : null,
          `[controller] ${message}`,
          status?.deployed === false
            ? "[controller] The saved runtime does not match the currently running chain. If besu:down -v was used, run npm run deploy and npm run seed once before demo:ui."
            : null,
          `[controller] Next safe action: ${nextAction.label} (${nextAction.action}).`,
        ]
          .filter(Boolean)
          .join("\n"),
        nextAction,
        trace: await readTrace(),
        status,
      };
    }
  });
}

export async function runFlowPayload() {
  return withControllerLock("runFlow", async () => {
    const result = await runFlowStrict();
    return {
      statusCode: result.ok ? 200 : 500,
      body: {
        ...result,
        trace: await readTrace(),
      },
    };
  });
}

async function lightClientHeartbeatTick() {
  if (heartbeatRunning || activeOperation || process.env.DEMO_LIGHT_CLIENT_HEARTBEAT === "false") return;
  heartbeatRunning = true;
  try {
    const config = await loadRuntimeConfig().catch(() => null);
    if (!config?.status?.deployed || !config?.status?.seeded) return;
    const health = await probeOnChainDeploymentHealth(config, STATUS_READ_TIMEOUT_MS);
    if (!health.ready) {
      warnHeartbeatSkip(
        `cached deployment is not present on the running chains (${health.reason}). Run Prepare Demo Session, or npm run deploy && npm run seed after besu:down -v.`
      );
      return;
    }
    const rpc = await rpcSnapshot(config);
    const ctx = await loadContext(config);
    const readiness = await refreshProofAnchors({
      config,
      ctx,
      latestA: rpc.latestA,
      latestB: rpc.latestB,
      maxGap: DEMO_MAX_TIMEOUT_HEADER_GAP,
      maxHeaders: LIGHT_CLIENT_HEARTBEAT_MAX_HEADERS,
    });
    const changed = (readiness.updates || []).filter((update) => update.changed);
    if (changed.length > 0) {
      console.log(
        `[heartbeat] refreshed proof anchors: ${changed
          .map((update) => `${update.label}=${update.trustedHeight.toString()}/${update.latestHeight.toString()}`)
          .join(", ")}`
      );
    }
  } catch (error) {
    warnHeartbeatSkip(error.demoSafeMessage || error.message);
  } finally {
    heartbeatRunning = false;
  }
}

function startLightClientHeartbeat() {
  if (LIGHT_CLIENT_HEARTBEAT_INTERVAL_MS <= 0 || process.env.DEMO_LIGHT_CLIENT_HEARTBEAT === "false") return;
  const timer = setInterval(lightClientHeartbeatTick, LIGHT_CLIENT_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
}

startLightClientHeartbeat();
