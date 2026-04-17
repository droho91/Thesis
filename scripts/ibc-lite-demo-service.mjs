import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { normalizeRuntime } from "./ibc-lite-common.mjs";
import { readDemoStatus, readTrace } from "./ibc-lite-demo-read-model.mjs";

// Demo service layer: wraps runtime command execution and composes payloads consumed by the HTTP API.
const configPath = resolve(process.cwd(), ".ibc-lite.local.json");
const npm = "npm";

function runEnv() {
  const temp = process.env.TMPDIR || process.env.TEMP || process.env.TMP || "/tmp";
  return {
    ...process.env,
    TMPDIR: temp,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || resolve(temp, ".cache"),
  };
}

function runCommand(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: runEnv(),
      shell: process.platform === "win32",
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      rejectRun(new Error(`${command} ${args.join(" ")} could not start: ${error.message}`));
    });
    child.on("close", (code) => {
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
  return { deploy: "deploy:ibc-lite", seed: "seed:ibc-lite", flow: "demo:flow", runtime };
}

async function deployAndSeed() {
  const scripts = await runtimeScripts();
  const deploy = await runCommand(npm, ["run", scripts.deploy]);
  const seed = await runCommand(npm, ["run", scripts.seed]);
  return `${deploy}\n${seed}`;
}

async function runFlowStrict() {
  let output = "";

  if (!(await hasDeploymentConfig())) {
    return {
      ok: false,
      output: "[controller] No .ibc-lite.local.json found. Press Deploy + Seed before running the flow.\n",
      error: "No local deployment config.",
    };
  }

  try {
    const scripts = await runtimeScripts();
    output += await runCommand(npm, ["run", scripts.flow]);
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
