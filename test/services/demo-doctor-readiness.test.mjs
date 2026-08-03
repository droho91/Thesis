import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyDefenseEvidence,
  readinessVerdict,
} from "../../scripts/ops/demo/readiness.mjs";

const currentPassingEvidence = Object.freeze({
  available: true,
  status: "passed",
  reportStatus: "passed",
  applicableToCurrentSource: true,
  applicabilityReason: "matched",
  security: { passed: 6, total: 6 },
  benchmark: { sampleCount: 100 },
  liveClients: { status: "passed", validated: ["Besu"], acceptedProofObservations: 4 },
  integrity: { verifiedReports: 4, expectedReports: 4 },
  provenance: { recordedCommitShort: "12345678", sourceMatches: true },
});

test("doctor accepts a passing report only when it applies to the current source", () => {
  const check = classifyDefenseEvidence(currentPassingEvidence);
  assert.equal(check.status, "pass");
  assert.deepEqual(readinessVerdict([check]), {
    ready: true,
    exitCode: 0,
    level: "log",
    message: "[demo:doctor] READY FOR DEFENSE",
  });
});

for (const [name, applicabilityReason] of [
  ["commit mismatch", "commit-mismatch"],
  ["dirty current source", "current-source-dirty"],
  ["repository lookup failure", "source-state-unknown"],
]) {
  test(`doctor fails a historical pass on ${name}`, () => {
    const check = classifyDefenseEvidence({
      ...currentPassingEvidence,
      status: "stale",
      applicableToCurrentSource: false,
      applicabilityReason,
    });
    assert.equal(check.status, "fail");
    assert.match(check.detail, new RegExp(applicabilityReason));

    const verdict = readinessVerdict([check]);
    assert.equal(verdict.ready, false);
    assert.equal(verdict.exitCode, 1);
    assert.match(verdict.message, /NOT READY/);
  });
}

test("doctor fails a current-source report when a component gate failed", () => {
  const check = classifyDefenseEvidence({
    ...currentPassingEvidence,
    status: "failed",
    reportStatus: "failed",
  });
  assert.equal(check.status, "fail");
  assert.equal(readinessVerdict([check]).exitCode, 1);
});

test("doctor rejects a current report without live-client production-proof observations", () => {
  const check = classifyDefenseEvidence({
    ...currentPassingEvidence,
    liveClients: { status: "unknown", validated: [], acceptedProofObservations: 0 },
  });
  assert.equal(check.status, "fail");
  assert.match(check.detail, /live-client production-proof/);
});

test("doctor supports the legacy sourceMatches field without accepting unknown provenance", () => {
  const { applicableToCurrentSource: _applicable, ...legacyEvidence } = currentPassingEvidence;
  assert.equal(classifyDefenseEvidence(legacyEvidence).status, "pass");
  assert.equal(classifyDefenseEvidence({
    ...legacyEvidence,
    provenance: { ...legacyEvidence.provenance, sourceMatches: false },
  }).status, "fail");
  assert.equal(classifyDefenseEvidence({
    ...legacyEvidence,
    provenance: { ...legacyEvidence.provenance, sourceMatches: null },
  }).status, "fail");
});
