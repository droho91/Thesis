import assert from "node:assert/strict";
import test from "node:test";
import {
  compactAmount,
  evidenceAppliesToCurrentSource,
  evidenceReportPassed,
  evidenceSourceStateLabel,
  evidenceStepLabel,
  formatBps,
  formatDurationMs,
  formatInteger,
  formatTimestamp,
  shortHash,
  titleCase,
} from "../../demo/ui-presentation.js";

test("generic UI formatters preserve established labels", () => {
  assert.equal(compactAmount("1234567.123456789"), "1,234,567.1234…");
  assert.equal(formatBps("8250"), "82.5");
  assert.equal(formatInteger(12345.67), "12,346");
  assert.equal(formatInteger(Number.POSITIVE_INFINITY), "-");
  assert.equal(formatTimestamp(), "-");
  assert.equal(formatTimestamp("not-a-date"), "not-a-date");
  assert.match(formatTimestamp("2026-01-02T03:04:05.000Z"), /2026/);
  assert.equal(formatDurationMs(1234), "1.23s");
  assert.equal(formatDurationMs(0), "-");
  assert.equal(shortHash("0x123456789012345678901234"), "0x12345678…901234");
  assert.equal(shortHash("short"), "short");
  assert.equal(titleCase("timelock-enforced"), "Timelock Enforced");
});

test("evidence presentation distinguishes report status from source applicability", () => {
  const currentPass = { available: true, reportStatus: "passed", applicableToCurrentSource: true };
  assert.equal(evidenceReportPassed(currentPass), true);
  assert.equal(evidenceAppliesToCurrentSource(currentPass), true);
  assert.equal(evidenceStepLabel(currentPass), "Current pass");
  assert.equal(evidenceSourceStateLabel(currentPass), "Current source matched");

  const recorded = {
    available: true,
    status: "passed",
    applicableToCurrentSource: false,
    applicabilityReason: "commit-mismatch",
  };
  assert.equal(evidenceReportPassed(recorded), true);
  assert.equal(evidenceStepLabel(recorded), "Recorded");
  assert.equal(evidenceSourceStateLabel(recorded), "Current commit differs");

  assert.equal(evidenceStepLabel({ available: true, status: "failed" }), "Review");
  assert.equal(evidenceStepLabel({ available: false }), "Missing");
  assert.equal(
    evidenceAppliesToCurrentSource({ provenance: { sourceMatches: true } }),
    true,
  );
});

test("evidence source-state wording covers every recorded mismatch reason", () => {
  assert.equal(
    evidenceSourceStateLabel({ applicabilityReason: "current-source-dirty" }),
    "Current source has uncommitted changes",
  );
  assert.equal(
    evidenceSourceStateLabel({ applicabilityReason: "recorded-source-dirty" }),
    "Recorded source was not clean",
  );
  assert.equal(
    evidenceSourceStateLabel({ applicabilityReason: "source-state-unknown" }),
    "Current source state is unknown",
  );
  assert.equal(evidenceSourceStateLabel({}), "Current source is not verified");
});
