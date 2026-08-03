import assert from "node:assert/strict";
import test from "node:test";
import {
  buildValidatorAvailabilityEvidence,
  collectValidatorAvailabilityEvidence,
  VALIDATOR_AVAILABILITY_REPORT_VERSION,
  VALIDATOR_AVAILABILITY_TEST_MODEL,
} from "../../scripts/verification/institutional-integration/validator-availability-evidence.mjs";

const scaffold = {
  validatorCount: 4,
  byzantineFaultTolerance: 1,
  dockerImage: "hyperledger/besu:test",
};
const faultReport = {
  version: VALIDATOR_AVAILABILITY_REPORT_VERSION,
  status: "passed",
  testModel: VALIDATOR_AVAILABILITY_TEST_MODEL,
  validatorCount: 4,
  toleratedFaults: 1,
  validatorUnavailable: [{ network: "chainA", validator: "0x01" }],
  duringUnavailability: [{ network: "chainA", blockNumber: 12 }],
  afterRecovery: [{ network: "chainA", blockNumber: 14 }],
};

test("validator evidence preserves the integration environment schema for a current report", () => {
  const result = buildValidatorAvailabilityEvidence({
    scaffold,
    faultReport,
    faultReportPath: "/evidence/qbft.json",
  });

  assert.deepEqual(result, {
    validatorTopology: {
      validatorCountPerChain: 4,
      toleratedFaults: 1,
      dockerImage: "hyperledger/besu:test",
    },
    validatorAvailabilityTest: {
      status: "passed",
      report: "/evidence/qbft.json",
      unavailableValidators: faultReport.validatorUnavailable,
      duringUnavailability: faultReport.duringUnavailability,
      afterRecovery: faultReport.afterRecovery,
    },
  });
});

test("validator evidence rejects stale, incomplete, or topology-unbound reports", () => {
  const mutations = [
    { version: "besu-qbft-validator-availability-report-v1" },
    { status: "failed" },
    { testModel: "Byzantine behavior injected" },
    { validatorCount: 3 },
    { toleratedFaults: 0 },
    { validatorUnavailable: undefined },
    { duringUnavailability: undefined },
    { afterRecovery: undefined },
  ];

  for (const mutation of mutations) {
    const result = buildValidatorAvailabilityEvidence({
      scaffold,
      faultReport: { ...faultReport, ...mutation },
      faultReportPath: "/evidence/qbft.json",
    });
    assert.equal(result.validatorAvailabilityTest.status, "not-run");
    assert.match(result.validatorAvailabilityTest.reason, /validator-availability test/);
  }
});

test("validator evidence does not claim fault tolerance for a sub-quorum topology", () => {
  const result = buildValidatorAvailabilityEvidence({
    scaffold: { ...scaffold, validatorCount: 3 },
    faultReport: { ...faultReport, validatorCount: 3 },
    faultReportPath: "/evidence/qbft.json",
  });

  assert.deepEqual(result.validatorTopology, {
    validatorCountPerChain: 3,
    toleratedFaults: 1,
    dockerImage: "hyperledger/besu:test",
  });
  assert.equal(result.validatorAvailabilityTest.status, "not-run");
  assert.match(result.validatorAvailabilityTest.reason, /fewer than four validators/);
});

test("missing optional evidence degrades to explicit conservative defaults", () => {
  const result = buildValidatorAvailabilityEvidence({
    scaffold: null,
    faultReport: null,
    faultReportPath: "/evidence/qbft.json",
  });

  assert.deepEqual(result, {
    validatorTopology: {
      validatorCountPerChain: 1,
      toleratedFaults: 0,
      dockerImage: "unknown",
    },
    validatorAvailabilityTest: {
      status: "not-run",
      reason: "The active profile has fewer than four validators and cannot evidence QBFT fault tolerance.",
    },
  });
});

test("malformed topology and report-path boundaries fail closed", () => {
  for (const malformedScaffold of [
    [],
    { ...scaffold, validatorCount: "4" },
    { ...scaffold, validatorCount: 0 },
    { ...scaffold, byzantineFaultTolerance: -1 },
    { ...scaffold, byzantineFaultTolerance: 4 },
    { ...scaffold, dockerImage: "" },
  ]) {
    assert.throws(
      () => buildValidatorAvailabilityEvidence({
        scaffold: malformedScaffold,
        faultReport,
        faultReportPath: "/evidence/qbft.json",
      }),
      /Besu scaffold/,
    );
  }
  assert.throws(
    () => buildValidatorAvailabilityEvidence({ scaffold, faultReport, faultReportPath: "" }),
    /report path/,
  );
});

test("collector resolves integration paths and delegates parsing through an injectable boundary", async () => {
  const reads = [];
  const byPath = new Map([
    ["/workspace/custom-network/scaffold.json", scaffold],
    ["/workspace/reports/qbft.json", faultReport],
  ]);
  const result = await collectValidatorAvailabilityEvidence({
    cwd: "/workspace",
    environment: {
      BESU_NETWORK_ROOT: "custom-network",
      BESU_QBFT_FAULT_REPORT_PATH: "reports/qbft.json",
    },
    readOptionalJson: async (path) => {
      reads.push(path);
      return byPath.get(path) ?? null;
    },
  });

  assert.deepEqual(reads.sort(), [
    "/workspace/custom-network/scaffold.json",
    "/workspace/reports/qbft.json",
  ]);
  assert.equal(result.validatorAvailabilityTest.status, "passed");
  assert.equal(result.validatorAvailabilityTest.report, "/workspace/reports/qbft.json");
});
