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
  if (!evidenceValidatorCurrent(evidence)) return "Restart UI";
  if (!evidenceReportPassed(evidence)) return "Review";
  return evidenceAppliesToCurrentSource(evidence) ? "Current pass" : "Recorded";
}

export function evidenceReportPassed(evidence) {
  return (evidence?.reportStatus || evidence?.status) === "passed";
}

export function evidenceAppliesToCurrentSource(evidence) {
  return evidence?.applicableToCurrentSource ?? evidence?.provenance?.sourceMatches === true;
}

export function evidenceValidatorCurrent(evidence) {
  return evidence?.validatorRuntime?.sourceMatchesCurrent === true;
}

export function evidenceVerdictPresentation(evidence) {
  if (!evidenceValidatorCurrent(evidence)) {
    return {
      currentPass: false,
      tone: "warning",
      label: "UI VALIDATOR RESTART REQUIRED",
      title: "Restart the UI to load the current evidence policy",
      copy: "The UI server was loaded from an earlier source revision. Restart npm run demo:ui before interpreting these reports.",
    };
  }
  if (!evidenceReportPassed(evidence)) {
    const failedGates = evidence?.validation?.failedGates || [];
    return {
      currentPass: false,
      tone: "error",
      label: "VALIDATION GATES FAILED",
      title: "One or more evidence gates require attention",
      copy: failedGates.length > 0
        ? `Failed checks: ${failedGates.map(titleCase).join(", ")}.`
        : "Review the recorded validation reports before using this build for a defense.",
    };
  }
  if (!evidenceAppliesToCurrentSource(evidence)) {
    return {
      currentPass: false,
      tone: "warning",
      label: "RECORDED VALIDATION — CURRENT SOURCE NOT VERIFIED",
      title: "Evidence passed only for the recorded source",
      copy: "The recorded run passed, but it is not a current pass for this source. Refresh validation evidence after reviewing and committing the source.",
    };
  }
  return {
    currentPass: true,
    tone: "ready",
    label: "REPRODUCIBLE VALIDATION PASSED",
    title: "Evidence matches the current reviewed source",
    copy: "An isolated two-chain run tested quorum behavior, recovery and lending invariants, and measured settlement latency.",
  };
}

export function evidenceSourceStateLabel(evidence) {
  if (!evidenceValidatorCurrent(evidence)) return "Restart UI to load the current validator";
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
