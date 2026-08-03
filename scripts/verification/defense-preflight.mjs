import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyDefenseEvidence } from "../ops/demo/readiness.mjs";
import { formalEvidencePayload } from "../ui/evidence.mjs";
import { writeJsonAtomic } from "../../services/shared/json-file.mjs";
import { inspectBrowserRuntime } from "./browser-runtime-preflight.mjs";

export const DEFENSE_PREFLIGHT_VERSION = "institutional-defense-preflight-v1";
const REPORT_PATH = resolve(process.cwd(), ".runtime/verification/defense-preflight.json");

export function buildDefensePreflightReport({ browser, docker, compose, evidence }) {
  const repository = evidence?.repository || evidence?.provenance || {};
  const repositoryCommit = repository.commit || repository.currentCommit || null;
  const repositoryDirty = repository.dirty ?? repository.currentDirty ?? null;
  const evidenceCheck = classifyDefenseEvidence(evidence || {});
  const checks = [
    {
      id: "repository-clean",
      status: repositoryCommit && repositoryDirty === false ? "passed" : "failed",
      detail: !repositoryCommit
        ? "Git source provenance is unavailable"
        : repositoryDirty === false
          ? `clean commit ${String(repositoryCommit).slice(0, 8)}`
          : "current source has uncommitted changes",
      remediation: "Review and commit the final source before generating defense evidence.",
    },
    {
      id: "browser-runtime",
      status: browser?.status === "passed" ? "passed" : "failed",
      detail: browser?.status === "passed"
        ? "Playwright Chromium launches with all linked libraries"
        : browser?.missingLibraries?.length > 0
          ? `missing: ${browser.missingLibraries.join(", ")}`
          : "Chromium preflight did not pass",
      remediation: "Run 'npx playwright install --with-deps chromium' with package-manager privileges.",
    },
    {
      id: "docker-daemon",
      status: docker?.ok ? "passed" : "failed",
      detail: docker?.ok ? docker.output : docker?.output || "Docker daemon is unavailable",
      remediation: "Start Docker Desktop and enable WSL integration for this distribution.",
    },
    {
      id: "docker-compose",
      status: compose?.ok ? "passed" : "failed",
      detail: compose?.ok ? compose.output : compose?.output || "Docker Compose is unavailable",
      remediation: "Install or enable Docker Compose v2 for the active Docker context.",
    },
    {
      id: "current-live-evidence",
      status: evidenceCheck.status === "pass" ? "passed" : "failed",
      detail: evidenceCheck.detail,
      remediation: "On a clean commit run 'npm run institutional:evidence' and then verify it.",
    },
  ];
  return {
    version: DEFENSE_PREFLIGHT_VERSION,
    status: checks.every((check) => check.status === "passed") ? "ready" : "not-ready",
    evidenceEligible: false,
    checks,
    blockers: checks
      .filter((check) => check.status !== "passed")
      .map(({ id, detail, remediation }) => ({ id, detail, remediation })),
  };
}

export async function collectDefensePreflight() {
  // Git provenance collection executes several commands against the complete
  // source tree. Keep it isolated from Chromium startup so a resource-heavy
  // browser launch cannot turn a valid dirty/clean result into "unavailable".
  const evidence = await formalEvidencePayload();
  const [browser, docker, compose] = await Promise.all([
    inspectBrowserRuntime(),
    commandOutput("docker", ["version", "--format", "server={{.Server.Version}}"]),
    commandOutput("docker", ["compose", "version", "--short"]),
  ]);
  return buildDefensePreflightReport({ browser, docker, compose, evidence });
}

async function main() {
  const report = {
    ...(await collectDefensePreflight()),
    observedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(REPORT_PATH, report);
  for (const check of report.checks) {
    console.log(`[${check.status.toUpperCase()}] ${check.id}: ${check.detail}`);
  }
  if (report.status !== "ready") {
    console.error(`[defense:preflight] NOT READY (${report.blockers.length} blocker(s)); report=${REPORT_PATH}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[defense:preflight] READY report=${REPORT_PATH}`);
}

function commandOutput(command, args) {
  return new Promise((resolveOutput) => {
    const child = spawn(command, args, { cwd: process.cwd(), shell: false });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += chunk; });
    child.stderr?.on("data", (chunk) => { output += chunk; });
    child.once("error", (error) => resolveOutput({ ok: false, output: error.message }));
    child.once("exit", (code) => resolveOutput({
      ok: code === 0,
      output: output.trim().slice(0, 2_000),
    }));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
