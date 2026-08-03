import assert from "node:assert/strict";
import test from "node:test";

import {
  enforceThresholds,
  parseLcov,
} from "../../scripts/verification/solidity-coverage-gate.mjs";

const CRITICAL_SOURCES = [
  "contracts/apps/BankPolicyEngine.sol",
  "contracts/apps/InstitutionalCollateralApp.sol",
  "contracts/apps/InstitutionalRestitutionVault.sol",
  "contracts/apps/PolicyControlledLendingPool.sol",
  "contracts/gateway/InstitutionalCheckpointClient.sol",
  "contracts/gateway/InstitutionalCrossChainGateway.sol",
  "contracts/gateway/InstitutionalEVMProofBoundary.sol",
  "contracts/gateway/InstitutionalEVMProofVerifier.sol",
  "contracts/libs/HexPrefixLib.sol",
  "contracts/libs/MerklePatriciaProofLib.sol",
  "contracts/libs/RLPDecodeLib.sol",
];

function lcovRecord(source, { found = 2, hits = found } = {}) {
  const data = Array.from(
    { length: found },
    (_, index) => `DA:${index + 1},${index < hits ? 1 : 0}`,
  ).join("\n");
  return `TN:\nSF:${source}\n${data}\nLH:${hits}\nLF:${found}\nend_of_record\n`;
}

function passingCoverageMap() {
  const sources = [
    ...CRITICAL_SOURCES,
    ...Array.from({ length: 9 }, (_, index) => `contracts/coverage/Dummy${index}.sol`),
  ];
  return new Map(sources.map((source) => [source, { found: 10, hits: 10, percent: 100 }]));
}

test("coverage parser accepts internally consistent LCOV", () => {
  const files = parseLcov(lcovRecord("contracts/apps/Example.sol"));
  assert.deepEqual(files.get("contracts/apps/Example.sol"), { found: 2, hits: 2, percent: 100 });
});

test("coverage parser fails closed on a truncated report", () => {
  assert.throws(
    () => parseLcov(lcovRecord("contracts/apps/Example.sol").trimEnd()),
    /truncated/,
  );
});

test("coverage parser rejects duplicate source records", () => {
  const record = lcovRecord("contracts/apps/Example.sol");
  assert.throws(() => parseLcov(record + record), /duplicate LCOV record/);
});

test("coverage parser rejects malformed or contradictory counters", () => {
  const malformed = lcovRecord("contracts/apps/Example.sol").replace("DA:1,1", "DA:not-a-line,1");
  assert.throws(() => parseLcov(malformed), /malformed DA/);

  const contradictory = lcovRecord("contracts/apps/Example.sol").replace("LH:2", "LH:1");
  assert.throws(() => parseLcov(contradictory), /computed hits 2 do not match LH 1/);
});

test("coverage thresholds require every critical source", () => {
  const coverage = passingCoverageMap();
  coverage.delete("contracts/apps/PolicyControlledLendingPool.sol");
  assert.throws(() => enforceThresholds(coverage), /PolicyControlledLendingPool\.sol: missing/);
});

test("coverage thresholds reject global, per-file, and critical regressions", () => {
  const perFileRegression = passingCoverageMap();
  perFileRegression.set("contracts/coverage/Dummy0.sol", { found: 10, hits: 4, percent: 40 });
  assert.throws(() => enforceThresholds(perFileRegression), /per-file floor 50%/);

  const criticalRegression = passingCoverageMap();
  criticalRegression.set(
    "contracts/gateway/InstitutionalEVMProofBoundary.sol",
    { found: 100, hits: 79, percent: 79 },
  );
  assert.throws(() => enforceThresholds(criticalRegression), /critical floor 80%/);

  const globalRegression = passingCoverageMap();
  for (const source of globalRegression.keys()) {
    globalRegression.set(source, { found: 10, hits: 8, percent: 80 });
  }
  assert.throws(() => enforceThresholds(globalRegression), /global: 80\.00% < 90%/);
});
