import { compactTokenAmount, formatBasisPoints } from "./token-amount.js";

export function compactAmount(value) {
  return compactTokenAmount(value ?? "0");
}

export function formatInteger(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "-";
}

export function formatBps(value) {
  return formatBasisPoints(value);
}

export function formatTimestamp(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-GB", { hour12: false });
}

export function formatDurationMs(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "-";
  return `${(milliseconds / 1000).toFixed(2)}s`;
}

export function evidenceStepLabel(evidence) {
  if (!evidence?.available) return "Missing";
  if (!evidenceReportPassed(evidence)) return "Review";
  return evidenceAppliesToCurrentSource(evidence) ? "Current pass" : "Recorded";
}

export function evidenceReportPassed(evidence) {
  return (evidence?.reportStatus || evidence?.status) === "passed";
}

export function evidenceAppliesToCurrentSource(evidence) {
  return evidence?.applicableToCurrentSource ?? evidence?.provenance?.sourceMatches === true;
}

export function evidenceSourceStateLabel(evidence) {
  if (evidenceAppliesToCurrentSource(evidence)) return "Current source matched";
  const labels = {
    "commit-mismatch": "Current commit differs",
    "current-source-dirty": "Current source has uncommitted changes",
    "recorded-source-dirty": "Recorded source was not clean",
    "source-state-unknown": "Current source state is unknown",
  };
  return labels[evidence?.applicabilityReason] || "Current source is not verified";
}

export function shortHash(value) {
  return typeof value === "string" && value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

export function titleCase(value) {
  return String(value || "-")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
