import { access, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { normalizeRuntime } from "./ibc-lite-common.mjs";
import { V2_CONFIG_PATH } from "./ibc-v2-config.mjs";
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

async function deployAndSeed() {
  const scripts = await runtimeScripts();
  const compile = await runCommand(scripts.compile.command, scripts.compile.args);
  const deploy = await runCommand(scripts.deploy.command, scripts.deploy.args);
  const seed = await runCommand(scripts.seed.command, scripts.seed.args);
  const freshTrace = {
    version: "v2",
    generatedAt: new Date().toISOString(),
    latestOperation: {
      phase: "seeded",
      label: "Prepared v2 runtime and demo balances",
      summary: "Contracts are deployed and policy/oracle/risk seed state is ready for the proof-checked v2 demo flow.",
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
        status: await readDemoStatus(),
      },
    };
  }

  const { runDemoAction } = await import("./ibc-lite-demo-actions.mjs");
  const result = await runDemoAction(action);
  return {
    statusCode: 200,
    body: result,
  };
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
  };
}

export async function tracePayload() {
  return { trace: await readTrace() };
}

export async function statusPayload() {
  return readDemoStatus();
}

export async function deploySeedPayload() {
  const output = await deployAndSeed();
  return {
    ok: true,
    output,
    trace: await readTrace(),
    status: await readDemoStatus(),
  };
}

export async function runFlowPayload() {
  const result = await runFlowStrict();
  return {
    statusCode: result.ok ? 200 : 500,
    body: {
      ...result,
      trace: await readTrace(),
    },
  };
}
