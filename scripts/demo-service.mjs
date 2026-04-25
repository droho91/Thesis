import { access, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { loadArtifact, normalizeRuntime } from "./besu-runtime.mjs";
import { loadRuntimeConfig, providerForChain, RUNTIME_CONFIG_PATH } from "./interchain-config.mjs";
import { readDemoStatus, readTrace } from "./demo-read-model.mjs";

// Demo service layer: wraps runtime command execution and composes payloads consumed by the HTTP API.
const configPath = RUNTIME_CONFIG_PATH;
const traceJsonPath = resolve(process.cwd(), "demo", "latest-run.json");
const traceJsPath = resolve(process.cwd(), "demo", "latest-run.js");
const npm = "npm";
const node = process.execPath;
const DEFAULT_TIMEOUT_MS = Number(process.env.DEMO_SERVICE_TIMEOUT_MS || 300000);
const FAST_READY_TIMEOUT_MS = Number(process.env.DEMO_FAST_READY_TIMEOUT_MS || 5000);
const STATUS_READ_TIMEOUT_MS = Number(process.env.DEMO_STATUS_READ_TIMEOUT_MS || 8000);
let activeOperation = null;

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
    deploySeed: "Prepare / Reuse",
    resetSeeded: "Fresh Reset",
    fullFlow: "Run Full Flow",
    runFlow: "Run Flow",
    openRoute: "Open connection and channel",
    lock: "Lock canonical asset",
    finalizeForwardHeader: "Read Bank A Besu header",
    updateForwardClient: "Import Bank A header on Bank B",
    proveForwardMint: "Verify forward packet proof",
    replayForward: "Replay forward packet",
    depositCollateral: "Deposit collateral",
    borrow: "Borrow",
    repay: "Repay",
    topUpRepayCash: "Get demo bCASH",
    withdrawCollateral: "Withdraw collateral",
    burn: "Burn voucher",
    finalizeReverseHeader: "Read Bank B Besu header",
    updateReverseClient: "Import Bank B header on Bank A",
    proveReverseUnlock: "Verify reverse packet proof",
    freezeClient: "Freeze light client",
    recoverClient: "Recover light client",
    verifyTimeoutAbsence: "Verify timeout absence",
  };
  return labels[action] || `demo action ${action || "unknown"}`;
}

function publicActiveOperation() {
  if (!activeOperation) return null;
  return {
    id: activeOperation.id,
    action: activeOperation.action,
    label: activeOperation.label,
    startedAt: activeOperation.startedAt,
    elapsedSeconds: Math.max(0, Math.round((Date.now() - activeOperation.startedAtMs) / 1000)),
  };
}

function controllerState() {
  return {
    busy: activeOperation !== null,
    activeOperation: publicActiveOperation(),
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

async function withControllerLock(action, run) {
  if (activeOperation) throw controllerBusyError(action);

  activeOperation = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    action,
    label: operationLabel(action),
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
  };

  try {
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
  if (request.action === "borrow") return { DEMO_BORROW_AMOUNT: request.amount };
  if (request.action === "repay") return { DEMO_REPAY_AMOUNT: request.amount };
  if (request.action === "withdrawCollateral") return { DEMO_WITHDRAW_AMOUNT: request.amount };
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

async function readDemoStatusForPayload() {
  try {
    return await withTimeout(readDemoStatus(), STATUS_READ_TIMEOUT_MS, "read demo status");
  } catch (error) {
    return {
      ready: false,
      deployed: false,
      stackVersion: "besu-light-client",
      label: "Status read timeout",
      message: error.message,
      controller: controllerState(),
    };
  }
}

async function fastSeededDeploymentReady() {
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

  const required = [
    ["A", "lightClient"],
    ["A", "packetHandler"],
    ["A", "packetStore"],
    ["A", "transferApp"],
    ["B", "lightClient"],
    ["B", "packetHandler"],
    ["B", "packetStore"],
    ["B", "transferApp"],
    ["B", "lendingPool"],
  ];
  const missingFields = required
    .filter(([chainKey, field]) => !config.chains?.[chainKey]?.[field])
    .map(([chainKey, field]) => `${chainKey}.${field}`);
  if (missingFields.length > 0) {
    return { ready: false, reason: `Seeded runtime config is missing: ${missingFields.join(", ")}.` };
  }

  try {
    const providerA = providerForChain(config, "A");
    const providerB = providerForChain(config, "B");
    const codeChecks = await withTimeout(
      Promise.all([
        providerA.getCode(config.chains.A.lightClient),
        providerA.getCode(config.chains.A.packetHandler),
        providerA.getCode(config.chains.A.transferApp),
        providerB.getCode(config.chains.B.lightClient),
        providerB.getCode(config.chains.B.packetHandler),
        providerB.getCode(config.chains.B.transferApp),
        providerB.getCode(config.chains.B.lendingPool),
      ]),
      FAST_READY_TIMEOUT_MS,
      "fast interchain lending deployment probe"
    );
    if (codeChecks.some((code) => code === "0x")) {
      return { ready: false, reason: "Seeded runtime config points at one or more addresses with no code." };
    }
    return { ready: true, reason: "Existing interchain lending deployment is already deployed and seeded." };
  } catch (error) {
    return { ready: false, reason: error.message };
  }
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
    const fastReady = await fastSeededDeploymentReady();
    if (fastReady.ready) {
      return [
        `[controller] ${fastReady.reason}`,
        "[controller] Skipped compile/deploy/seed; use Fresh Reset for a clean redeploy.",
      ].join("\n");
    }
    if (await hasDeploymentConfig()) {
      return [
        "[controller] Existing runtime config is not confirmed ready by the fast probe.",
        `[controller] ${fastReady.reason}`,
        "[controller] Skipped automatic redeploy to keep Prepare / Reuse fast.",
        "[controller] Use Fresh Reset before the demo window if you need a clean deployment.",
      ].join("\n");
    }
  }

  const scripts = await runtimeScripts();
  const compile = await maybeCompileForDemoReset(scripts);
  const deploy = await runCommand(scripts.deploy.command, scripts.deploy.args);
  const seed = await runCommand(scripts.seed.command, scripts.seed.args);
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
  return `${compile}\n${deploy}\n${seed}`;
}

async function runFlowStrict() {
  let output = "";

  if (!(await hasDeploymentConfig())) {
    return {
      ok: false,
      output: "[controller] No .interchain-lending.local.json found. Press Prepare / Reuse or Fresh Reset before running the flow.\n",
      error: "No local deployment config.",
    };
  }

  try {
    const scripts = await runtimeScripts();
    output += await runCommand(scripts.flow.command, scripts.flow.args);
    return { ok: true, output };
  } catch (error) {
    output += "\n[controller] Flow failed. No automatic redeploy or retry was performed.\n";
    output += error.message;
    return {
      ok: false,
      output,
      error: "Contract flow failed. Inspect the failed path, then redeploy/seed manually if needed.",
    };
  }
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
          output: "[controller] No .interchain-lending.local.json found. Press Prepare / Reuse or Fresh Reset before running demo actions.\n",
          error: "No local deployment config.",
          message: "No local deployment config.",
          trace: await readTrace(),
          status: await readDemoStatusForPayload(),
        },
      };
    }

    const scripts = await runtimeScripts();
    const env = actionAmountEnv(request);
    const result =
      action === "fullFlow"
        ? await runFlowStrict()
        : await (async () => {
            try {
              const output = await runCommand(scripts.flow.command, [...scripts.flow.args, "--step", action], { env });
              return { ok: true, output };
            } catch (error) {
              return { ok: false, output: error.message, error: `Demo action ${action} failed.` };
            }
          })();

    return {
      statusCode: result.ok ? 200 : 500,
      body: {
        ...result,
        message:
          result.ok && action === "fullFlow"
            ? "Completed the storage-proof cross-chain lending flow."
            : result.ok
              ? `Completed demo action: ${operationLabel(action)}${request.amount ? ` (${request.amount}).` : "."}`
              : result.error,
        trace: await readTrace(),
        status: await readDemoStatusForPayload(),
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
    const output = await deployAndSeed();
    return {
      ok: true,
      output,
      trace: await readTrace(),
      status: await readDemoStatusForPayload(),
    };
  });
}

export async function resetSeededPayload() {
  return withControllerLock("resetSeeded", async () => {
    const output = await deployAndSeed({ reset: true });
    return {
      ok: true,
      output,
      trace: await readTrace(),
      status: await readDemoStatusForPayload(),
    };
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
