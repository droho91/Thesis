import { access, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { loadArtifact, normalizeRuntime } from "./ibc-lite-common.mjs";
import { loadV2Config, providerForV2, V2_CONFIG_PATH } from "./ibc-v2-config.mjs";
import { readDemoStatus, readTrace } from "./ibc-lite-demo-read-model.mjs";

// Demo service layer: wraps runtime command execution and composes payloads consumed by the HTTP API.
const configPath = V2_CONFIG_PATH;
const traceV2JsonPath = resolve(process.cwd(), "demo", "latest-v2-run.json");
const traceV2JsPath = resolve(process.cwd(), "demo", "latest-v2-run.js");
const traceJsonPath = resolve(process.cwd(), "demo", "latest-run.json");
const traceJsPath = resolve(process.cwd(), "demo", "latest-run.js");
const npm = "npm";
const node = process.execPath;
const DEFAULT_TIMEOUT_MS = Number(process.env.DEMO_SERVICE_TIMEOUT_MS || 300000);
const FAST_READY_TIMEOUT_MS = Number(process.env.DEMO_FAST_READY_TIMEOUT_MS || 5000);
const STATUS_READ_TIMEOUT_MS = Number(process.env.DEMO_STATUS_READ_TIMEOUT_MS || 8000);
let activeOperation = null;

async function expectedV2ArtifactFingerprint() {
  const artifacts = {
    lightClient: await loadArtifact("v2/clients/BesuLightClient.sol", "BesuLightClient"),
    connectionKeeper: await loadArtifact("v2/core/IBCConnectionKeeperV2.sol", "IBCConnectionKeeperV2"),
    channelKeeper: await loadArtifact("v2/core/IBCChannelKeeperV2.sol", "IBCChannelKeeperV2"),
    packetHandler: await loadArtifact("v2/core/IBCPacketHandlerV2.sol", "IBCPacketHandlerV2"),
    packetStore: await loadArtifact("v2/core/IBCPacketStoreV2.sol", "IBCPacketStoreV2"),
    bankToken: await loadArtifact("apps/BankToken.sol", "BankToken"),
    policy: await loadArtifact("v2/apps/BankPolicyEngineV2.sol", "BankPolicyEngineV2"),
    oracle: await loadArtifact("v2/apps/ManualAssetOracleV2.sol", "ManualAssetOracleV2"),
    escrow: await loadArtifact("v2/apps/PolicyControlledEscrowVaultV2.sol", "PolicyControlledEscrowVaultV2"),
    voucher: await loadArtifact("v2/apps/PolicyControlledVoucherTokenV2.sol", "PolicyControlledVoucherTokenV2"),
    lendingPool: await loadArtifact("v2/apps/PolicyControlledLendingPoolV2.sol", "PolicyControlledLendingPoolV2"),
    transferApp: await loadArtifact("v2/apps/PolicyControlledTransferAppV2.sol", "PolicyControlledTransferAppV2"),
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
    deploySeed: "Deploy + Seed",
    resetSeeded: "Reset to Seeded",
    fullFlow: "Run Full Flow",
    runFlow: "Run Flow",
    lock: "Lock canonical asset",
    finalizeForwardHeader: "Read Bank A packet header",
    updateForwardClient: "Trust Bank A on Bank B",
    proveForwardMint: "Prove forward mint",
    replayForward: "Replay forward packet",
    depositCollateral: "Deposit collateral",
    borrow: "Borrow",
    repay: "Repay",
    withdrawCollateral: "Withdraw collateral",
    burn: "Burn voucher",
    finalizeReverseHeader: "Read Bank B packet header",
    updateReverseClient: "Trust Bank B on Bank A",
    proveReverseUnlock: "Prove reverse unlock",
    freezeClient: "Freeze client",
    recoverClient: "Recover client",
    checkNonMembership: "Check non-membership",
  };
  return labels[action] || `v2 action ${action || "unknown"}`;
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
  const activeLabel = active?.label || "another v2 action";
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

function runEnv() {
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
  };
}

function runCommand(command, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const useShell = process.platform === "win32" && command === npm;
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: runEnv(),
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
      stackVersion: "v2",
      label: "Status read timeout",
      message: error.message,
      controller: controllerState(),
    };
  }
}

async function fastSeededDeploymentReady() {
  const config = await loadV2Config().catch(() => null);
  if (!config?.status?.deployed || !config?.status?.seeded || !config.participants) {
    return { ready: false, reason: "No seeded v2 config is available." };
  }

  if (config.build?.storageWordRlp !== "canonical-trimmed-v1") {
    return {
      ready: false,
      reason: "Seeded v2 config was created before the canonical storage-proof RLP fix. Use Fresh Reset once.",
    };
  }
  const expectedFingerprint = await expectedV2ArtifactFingerprint();
  if (config.build?.artifactFingerprint !== expectedFingerprint) {
    return {
      ready: false,
      reason: "Seeded v2 config was created with different contract artifacts. Use Fresh Reset once.",
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
    return { ready: false, reason: `Seeded v2 config is missing: ${missingFields.join(", ")}.` };
  }

  try {
    const providerA = providerForV2(config, "A");
    const providerB = providerForV2(config, "B");
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
      "fast v2 deployment probe"
    );
    if (codeChecks.some((code) => code === "0x")) {
      return { ready: false, reason: "Seeded v2 config points at one or more addresses with no code." };
    }
    return { ready: true, reason: "Existing v2 deployment is already deployed and seeded." };
  } catch (error) {
    return { ready: false, reason: error.message };
  }
}

async function maybeCompileForDemoReset(scripts) {
  if (process.env.DEMO_RESET_COMPILE === "true") {
    return runCommand(scripts.compile.command, scripts.compile.args);
  }

  try {
    await expectedV2ArtifactFingerprint();
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
    deploy: { command: node, args: ["scripts/deploy-v2.mjs"] },
    seed: { command: node, args: ["scripts/seed-v2.mjs"] },
    flow: { command: node, args: ["scripts/demo-v2-flow.mjs"] },
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
        "[controller] Existing v2 config is not confirmed ready by the fast probe.",
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
    version: "v2",
    generatedAt: new Date().toISOString(),
    latestOperation: {
      phase: "seeded",
      label: reset ? "Reset v2 runtime to seeded baseline" : "Prepared v2 runtime and demo balances",
      summary: reset
        ? "A fresh v2 deployment was created and seeded so the demo is back at the post-seed baseline."
        : "Contracts are deployed and policy/oracle/risk seed state is ready for the proof-checked v2 demo flow.",
    },
  };
  await writeFile(traceV2JsonPath, `${JSON.stringify(freshTrace, null, 2)}\n`);
  await writeFile(traceV2JsPath, `window.IBCLiteLatestV2Run = ${JSON.stringify(freshTrace, null, 2)};\n`);
  await writeFile(traceJsonPath, `${JSON.stringify(freshTrace, null, 2)}\n`);
  await writeFile(traceJsPath, `window.IBCLiteLatestRun = ${JSON.stringify(freshTrace, null, 2)};\n`);
  return `${compile}\n${deploy}\n${seed}`;
}

async function runFlowStrict() {
  let output = "";

  if (!(await hasDeploymentConfig())) {
    return {
      ok: false,
      output: "[controller] No .ibc-v2.local.json found. Press Deploy + Seed before running the flow.\n",
      error: "No v2 local deployment config.",
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

export async function runActionPayload(action) {
  return withControllerLock(action, async () => {
    if (await hasDeploymentConfig()) {
      const scripts = await runtimeScripts();
      const result =
        action === "fullFlow"
          ? await runFlowStrict()
          : await (async () => {
              try {
                const output = await runCommand(scripts.flow.command, [...scripts.flow.args, "--step", action]);
                return { ok: true, output };
              } catch (error) {
                return { ok: false, output: error.message, error: `V2 action ${action} failed.` };
              }
            })();

      return {
        statusCode: result.ok ? 200 : 500,
        body: {
          ...result,
          message:
            result.ok && action === "fullFlow"
              ? "Completed the v2 proof-checked banking flow."
              : result.ok
                ? `Completed v2 action: ${action}.`
                : result.error,
          trace: await readTrace(),
          status: await readDemoStatusForPayload(),
        },
      };
    }

    const { runDemoAction } = await import("./ibc-lite-demo-actions.mjs");
    const result = await runDemoAction(action);
    return {
      statusCode: 200,
      body: result,
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
