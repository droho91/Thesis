import assert from "node:assert/strict";
import test from "node:test";

import { buildDefensePreflightReport } from "../../scripts/verification/defense-preflight.mjs";

const passingInput = Object.freeze({
  browser: { status: "passed", missingLibraries: [] },
  docker: { ok: true, output: "server=27.0.0" },
  compose: { ok: true, output: "2.29.0" },
  evidence: {
    available: true,
    status: "passed",
    reportStatus: "passed",
    applicableToCurrentSource: true,
    repository: { commit: "1".repeat(40), dirty: false },
    security: { passed: 14, total: 14 },
    benchmark: { sampleCount: 100 },
    integrity: { verifiedReports: 4, expectedReports: 4 },
    provenance: { recordedCommitShort: "11111111" },
    liveClients: { status: "passed", validated: ["Besu"], acceptedProofObservations: 4 },
  },
});

test("defense preflight is ready only when every observed prerequisite passes", () => {
  const report = buildDefensePreflightReport(passingInput);
  assert.equal(report.status, "ready");
  assert.deepEqual(report.blockers, []);
});

test("defense preflight reports actionable independent blockers", () => {
  const report = buildDefensePreflightReport({
    ...passingInput,
    browser: { status: "failed", missingLibraries: ["libnspr4.so"] },
    docker: { ok: false, output: "daemon unavailable" },
    evidence: {
      ...passingInput.evidence,
      status: "stale",
      applicableToCurrentSource: false,
      repository: { commit: "1".repeat(40), dirty: true },
      applicabilityReason: "current-source-dirty",
    },
  });
  assert.equal(report.status, "not-ready");
  assert.deepEqual(
    report.blockers.map((blocker) => blocker.id),
    ["repository-clean", "browser-runtime", "docker-daemon", "current-live-evidence"],
  );
  assert.equal(report.blockers.every((blocker) => blocker.remediation.length > 0), true);
});

test("defense preflight fails closed when provenance and evidence are absent", () => {
  const report = buildDefensePreflightReport({
    browser: { status: "passed", missingLibraries: [] },
    docker: { ok: true, output: "server=27.0.0" },
    compose: { ok: true, output: "2.29.0" },
    evidence: { available: false, message: "missing" },
  });
  assert.equal(report.status, "not-ready");
  assert.equal(report.blockers.some((blocker) => blocker.id === "repository-clean"), true);
  assert.equal(report.blockers.some((blocker) => blocker.id === "current-live-evidence"), true);
});
