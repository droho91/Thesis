import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import { writeJsonAtomic } from "../../services/shared/json-file.mjs";

export const BROWSER_PREFLIGHT_VERSION = "institutional-browser-runtime-preflight-v1";
const REPORT_PATH = resolve(process.cwd(), ".runtime/verification/browser-runtime-preflight.json");

export function parseMissingSharedLibraries(output) {
  if (typeof output !== "string") return [];
  return [...new Set(output
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*([^\s]+)\s*=>\s*not found\s*$/)?.[1])
    .filter(Boolean))]
    .sort();
}

export function evaluateBrowserRuntime({ executablePath, executablePresent, lddOk, missingLibraries }) {
  const checks = [
    {
      id: "chromium-executable",
      status: executablePresent ? "passed" : "failed",
      detail: executablePresent ? executablePath : "Playwright Chromium executable is missing",
    },
  ];
  if (process.platform === "linux") {
    checks.push({
      id: "linux-shared-libraries",
      status: lddOk && missingLibraries.length === 0 ? "passed" : "failed",
      detail: !lddOk
        ? "ldd could not inspect the Chromium executable"
        : missingLibraries.length > 0
          ? `missing: ${missingLibraries.join(", ")}`
          : "all linked shared libraries resolved",
    });
  }
  return {
    status: checks.every((check) => check.status === "passed") ? "passed" : "failed",
    checks,
  };
}

export async function inspectBrowserRuntime({
  executablePath = chromium.executablePath(),
  runCommand = commandOutput,
  launch = () => chromium.launch({ headless: true }),
} = {}) {
  const executablePresent = await access(executablePath).then(() => true).catch(() => false);
  let lddOk = true;
  let missingLibraries = [];
  let lddOutput = "not-applicable";
  if (process.platform === "linux" && executablePresent) {
    const result = await runCommand("ldd", [executablePath]);
    lddOk = result.ok;
    lddOutput = result.output;
    missingLibraries = parseMissingSharedLibraries(result.output);
  }
  const evaluated = evaluateBrowserRuntime({
    executablePath,
    executablePresent,
    lddOk,
    missingLibraries,
  });
  let launchStatus = "not-run";
  let launchError = null;
  if (evaluated.status === "passed") {
    try {
      const browser = await launch();
      await browser.close();
      launchStatus = "passed";
    } catch (error) {
      launchStatus = "failed";
      launchError = error?.message || String(error);
    }
  }
  const checks = [
    ...evaluated.checks,
    {
      id: "chromium-headless-launch",
      status: launchStatus,
      detail: launchStatus === "passed"
        ? "Chromium launched and closed successfully"
        : launchError || "launch skipped because a prerequisite failed",
    },
  ];
  return {
    version: BROWSER_PREFLIGHT_VERSION,
    status: checks.every((check) => check.status === "passed") ? "passed" : "failed",
    evidenceEligible: false,
    platform: `${process.platform}/${process.arch}`,
    executablePath,
    missingLibraries,
    lddOutput,
    checks,
  };
}

async function main() {
  const report = {
    ...(await inspectBrowserRuntime()),
    observedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(REPORT_PATH, report);
  if (report.status !== "passed") {
    const detail = report.missingLibraries.length > 0
      ? `missing Linux libraries: ${report.missingLibraries.join(", ")}`
      : report.checks.find((check) => check.status === "failed")?.detail || "unknown browser failure";
    throw new Error(
      `Browser runtime preflight failed (${detail}). `
      + "On Ubuntu/WSL run 'npx playwright install --with-deps chromium' with package-manager privileges.",
    );
  }
  console.log(`[browser:preflight] PASS report=${REPORT_PATH}`);
}

function commandOutput(command, args) {
  return new Promise((resolveOutput) => {
    const child = spawn(command, args, { cwd: process.cwd(), shell: false });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += chunk; });
    child.stderr?.on("data", (chunk) => { output += chunk; });
    child.once("error", (error) => resolveOutput({ ok: false, output: error.message }));
    child.once("exit", (code) => resolveOutput({ ok: code === 0, output }));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
