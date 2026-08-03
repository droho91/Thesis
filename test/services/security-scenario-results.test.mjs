import assert from "node:assert/strict";
import test from "node:test";
import {
  SECURITY_COMPILATION_MODE,
  SECURITY_COMPILATION_TASK,
  SECURITY_EXECUTOR_KIND,
  SECURITY_EXECUTOR_SELECTION,
  SECURITY_EXECUTOR_TASK,
  SECURITY_REPORT_VERSION,
  SECURITY_RESULT_SCHEMA,
  exactTestPattern,
  normalizeHardhatTaskResult,
  sha256Json,
  validateScenarioExecutions,
  validateScenarioManifest,
  validateSecurityScenarioReport,
} from "../../scripts/verification/security-scenario-results.mjs";

const scenarios = Object.freeze([
  Object.freeze({
    id: "SEC-01",
    title: "First control",
    test: "testFirstScenario",
    signature: "testFirstScenario()",
    control: "The first control is enforced.",
    source: "test/security/First.t.sol",
  }),
  Object.freeze({
    id: "SEC-02",
    title: "Second control",
    test: "testSecondScenario",
    signature: "testSecondScenario(uint96)",
    control: "The second control is enforced.",
    source: "test/security/Second.t.sol",
  }),
]);

function passingExecution(scenario) {
  return {
    id: scenario.id,
    source: scenario.source,
    test: scenario.test,
    signature: scenario.signature,
    result: { passed: 1, failed: 0, skipped: 0, todo: 0 },
  };
}

test("accepts one exact structured Hardhat pass for every declared scenario", () => {
  const executions = scenarios.map(passingExecution);

  assert.deepEqual(validateScenarioExecutions(scenarios, executions), {
    expected: 2,
    executed: 2,
    passed: 2,
  });
  assert.throws(
    () => validateScenarioExecutions(scenarios, [
      { ...executions[0], infrastructureRetries: 5 },
      executions[1],
    ]),
    /infrastructure retry count is invalid/,
  );
});

test("escapes and anchors exact test signatures before giving them to Hardhat", () => {
  assert.equal(exactTestPattern("testRisk(uint96)"), "^testRisk\\(uint96\\)$");
});

test("rejects duplicate manifest ids and duplicate test names", () => {
  assert.throws(
    () => validateScenarioManifest([scenarios[0], { ...scenarios[1], id: scenarios[0].id }]),
    /Duplicate security scenario id 'SEC-01'/,
  );
  assert.throws(
    () => validateScenarioManifest([
      scenarios[0],
      { ...scenarios[1], test: scenarios[0].test, signature: scenarios[0].signature },
    ]),
    /Duplicate security scenario test name 'testFirstScenario'/,
  );
});

test("rejects missing, duplicate, and unexpected execution records", () => {
  assert.throws(
    () => validateScenarioExecutions(scenarios, [passingExecution(scenarios[0])]),
    /missing execution 'SEC-02'/,
  );
  assert.throws(
    () => validateScenarioExecutions(scenarios, [
      passingExecution(scenarios[0]),
      passingExecution(scenarios[0]),
      passingExecution(scenarios[1]),
    ]),
    /duplicate execution for 'SEC-01'/,
  );
  assert.throws(
    () => validateScenarioExecutions(scenarios, [
      ...scenarios.map(passingExecution),
      { ...passingExecution(scenarios[1]), id: "SEC-99" },
    ]),
    /unexpected execution 'SEC-99'/,
  );
});

test("rejects a result attached to the wrong source or test name", () => {
  const executions = scenarios.map(passingExecution);
  executions[1].test = "testDifferentScenario";

  assert.throws(
    () => validateScenarioExecutions(scenarios, executions),
    /identity mismatch for 'SEC-02'/,
  );
});

test("rejects failures, skipped tests, and non-exclusive selectors", () => {
  for (const result of [
    { passed: 0, failed: 1, skipped: 0, todo: 0 },
    { passed: 0, failed: 0, skipped: 1, todo: 0 },
    { passed: 0, failed: 0, skipped: 0, todo: 1 },
    { passed: 2, failed: 0, skipped: 0, todo: 0 },
  ]) {
    const executions = scenarios.map(passingExecution);
    executions[0].result = result;
    assert.throws(
      () => validateScenarioExecutions(scenarios, executions),
      /Security scenario result validation failed/,
    );
  }
});

test("rejects malformed Hardhat counters instead of coercing them", () => {
  assert.throws(
    () => normalizeHardhatTaskResult({ passed: "1", failed: 0, skipped: 0, todo: 0 }),
    /invalid 'passed' count/,
  );
  assert.throws(
    () => normalizeHardhatTaskResult({ passed: 1, failed: -1, skipped: 0, todo: 0 }),
    /invalid 'failed' count/,
  );
  assert.throws(
    () => normalizeHardhatTaskResult({ passed: 1, failed: 0, skipped: 0, todo: 0, cancelled: 0 }),
    /unexpected Solidity result field.*cancelled/,
  );
  assert.throws(
    () => normalizeHardhatTaskResult({ passed: 1, failed: 0, skipped: 0, todo: 0, failureOutput: [] }),
    /invalid Solidity failure output/,
  );
});

test("unwraps the pinned Hardhat Solidity task envelope and rejects malformed envelopes", () => {
  const summary = { passed: 1, failed: 0, skipped: 0, todo: 0, failureOutput: "" };
  assert.deepEqual(normalizeHardhatTaskResult({
    success: true,
    value: { summary, suiteResults: [] },
  }), { passed: 1, failed: 0, skipped: 0, todo: 0 });
  assert.throws(
    () => normalizeHardhatTaskResult({ success: false, value: { summary, suiteResults: [] } }),
    /unsuccessful or malformed Solidity task envelope/,
  );
  assert.throws(
    () => normalizeHardhatTaskResult({ success: true, value: { summary } }),
    /malformed Solidity task payload/,
  );
});

test("validates the complete v2 report and rejects legacy or internally inconsistent evidence", () => {
  const executions = scenarios.map((scenario) => ({
    ...passingExecution(scenario),
    selector: {
      testFiles: [scenario.source],
      grep: exactTestPattern(scenario.signature),
    },
  }));
  const report = {
    version: SECURITY_REPORT_VERSION,
    status: "passed",
    executor: {
      kind: SECURITY_EXECUTOR_KIND,
      task: SECURITY_EXECUTOR_TASK,
      toolVersion: "3.12.0",
      resultSchema: SECURITY_RESULT_SCHEMA,
      selection: SECURITY_EXECUTOR_SELECTION,
      compilation: {
        task: SECURITY_COMPILATION_TASK,
        mode: SECURITY_COMPILATION_MODE,
        force: true,
      },
      summary: { expected: 2, executed: 2, passed: 2 },
      structuredResultsSha256: sha256Json(executions),
    },
    scenarios: scenarios.map((scenario, index) => ({
      ...scenario,
      status: "passed",
      sourceSha256: "a".repeat(64),
      execution: executions[index],
    })),
  };

  const context = {
    hardhatVersion: "3.12.0",
    sourceSha256ByPath: new Map(scenarios.map((scenario) => [scenario.source, "a".repeat(64)])),
  };
  assert.deepEqual(validateSecurityScenarioReport(report, scenarios, context), {
    expected: 2,
    executed: 2,
    passed: 2,
  });
  assert.throws(
    () => validateSecurityScenarioReport(
      { ...report, executor: { ...report.executor, compilation: { ...report.executor.compilation, force: false } } },
      scenarios,
      context,
    ),
    /full forced compilation/,
  );
  assert.throws(
    () => validateSecurityScenarioReport(
      {
        ...report,
        executor: {
          ...report.executor,
          compilation: { ...report.executor.compilation, infrastructureRetries: 5 },
        },
      },
      scenarios,
      context,
    ),
    /compilation infrastructure retry count is invalid/,
  );
  assert.throws(
    () => validateSecurityScenarioReport(
      { ...report, version: "institutional-security-scenarios-v1" },
      scenarios,
      context,
    ),
    /Unsupported security scenario report version/,
  );
  assert.throws(
    () => validateSecurityScenarioReport(
      {
        ...report,
        executor: { ...report.executor, structuredResultsSha256: "0".repeat(64) },
      },
      scenarios,
      context,
    ),
    /structured result hash does not match/,
  );
  assert.throws(
    () => validateSecurityScenarioReport(report, scenarios, {
      ...context,
      sourceSha256ByPath: new Map(scenarios.map((scenario) => [scenario.source, "b".repeat(64)])),
    }),
    /source hash does not match current source/,
  );
  assert.throws(
    () => validateSecurityScenarioReport(report, scenarios, { ...context, hardhatVersion: "3.2.0" }),
    /does not match expected Hardhat '3.2.0'/,
  );
});
