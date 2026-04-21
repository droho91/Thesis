import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function serializeError(error) {
  return {
    shortMessage: error?.shortMessage || null,
    reason: error?.reason || null,
    message: error?.message || String(error),
    stack: typeof error?.stack === "string" ? error.stack : null,
  };
}

export function defaultVerificationHints(error) {
  const message = error?.message || error?.shortMessage || "";
  return /fetch failed|ECONNREFUSED|network error|socket hang up|timeout/i.test(message)
    ? [
        "Besu RPC may not be reachable from the current runtime.",
        "Check that the local Besu stack is up and that http://127.0.0.1:8545 and http://127.0.0.1:9545 are reachable from this shell.",
      ]
    : [];
}

export async function writeVerificationReport(outFile, report) {
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`);
}

export async function writeVerificationFailureReport(outFile, error, { phase = "unknown", hints } = {}) {
  const report = {
    status: "failed",
    generatedAt: new Date().toISOString(),
    phase,
    error: serializeError(error),
    hints: Array.isArray(hints) ? hints : defaultVerificationHints(error),
  };
  await writeVerificationReport(outFile, report);
  return report;
}
