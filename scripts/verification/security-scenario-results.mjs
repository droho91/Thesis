import { createHash } from "node:crypto";

const RESULT_COUNT_FIELDS = Object.freeze(["passed", "failed", "skipped", "todo"]);
const HARDHAT_RESULT_FIELDS = new Set([...RESULT_COUNT_FIELDS, "failureOutput"]);

export const SECURITY_REPORT_VERSION = "institutional-security-scenarios-v2";
export const SECURITY_EXECUTOR_KIND = "hardhat-task-result";
export const SECURITY_EXECUTOR_TASK = "test solidity";
export const SECURITY_EXECUTOR_SELECTION = "one source file and one escaped, anchored test signature per invocation";
export const SECURITY_RESULT_SCHEMA = "hardhat-solidity-task-counts-v1";
export const SECURITY_MAX_INFRASTRUCTURE_RETRIES = 4;
export const SECURITY_COMPILATION_TASK = "compile";
export const SECURITY_COMPILATION_MODE = "full-force-contracts-and-tests";

export function exactTestPattern(testSignature) {
  requireNonEmptyString(testSignature, "test signature");
  return `^${testSignature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

export function validateScenarioManifest(scenarios) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new Error("Security scenario manifest must be a non-empty array.");
  }

  const ids = new Set();
  const names = new Set();
  const identities = new Set();
  for (const [index, scenario] of scenarios.entries()) {
    if (scenario === null || typeof scenario !== "object" || Array.isArray(scenario)) {
      throw new Error(`Security scenario at index ${index} must be an object.`);
    }
    for (const field of ["id", "title", "test", "signature", "control", "source"]) {
      requireNonEmptyString(scenario[field], `scenario ${index} ${field}`);
    }
    if (!scenario.signature.startsWith(`${scenario.test}(`) || !scenario.signature.endsWith(")")) {
      throw new Error(
        `Security scenario '${scenario.id}' signature '${scenario.signature}' `
        + `does not belong to test '${scenario.test}'.`,
      );
    }
    if (ids.has(scenario.id)) {
      throw new Error(`Duplicate security scenario id '${scenario.id}'.`);
    }
    if (names.has(scenario.test)) {
      throw new Error(`Duplicate security scenario test name '${scenario.test}'.`);
    }
    const identity = scenarioIdentity(scenario);
    if (identities.has(identity)) {
      throw new Error(`Duplicate security scenario test identity '${formatIdentity(scenario)}'.`);
    }
    ids.add(scenario.id);
    names.add(scenario.test);
    identities.add(identity);
  }

  return scenarios;
}

export function normalizeHardhatTaskResult(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Hardhat returned a non-object Solidity test result.");
  }

  if (Object.hasOwn(value, "success") || Object.hasOwn(value, "value")) {
    const envelopeFields = Object.keys(value).filter((field) => field !== "success" && field !== "value");
    if (envelopeFields.length > 0 || value.success !== true) {
      throw new Error("Hardhat returned an unsuccessful or malformed Solidity task envelope.");
    }
    const payload = value.value;
    if (
      payload === null
      || typeof payload !== "object"
      || Array.isArray(payload)
      || payload.summary === null
      || typeof payload.summary !== "object"
      || Array.isArray(payload.summary)
      || !Array.isArray(payload.suiteResults)
    ) {
      throw new Error("Hardhat returned a malformed Solidity task payload.");
    }
    value = payload.summary;
  }

  const unexpectedFields = Object.keys(value).filter((field) => !HARDHAT_RESULT_FIELDS.has(field));
  if (unexpectedFields.length > 0) {
    throw new Error(`Hardhat returned unexpected Solidity result field(s): ${unexpectedFields.join(", ")}.`);
  }
  if (value.failureOutput !== undefined && typeof value.failureOutput !== "string") {
    throw new Error("Hardhat returned an invalid Solidity failure output.");
  }

  const result = {};
  for (const field of RESULT_COUNT_FIELDS) {
    const count = value[field];
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Hardhat returned an invalid '${field}' count.`);
    }
    result[field] = count;
  }
  return result;
}

export function validateScenarioExecutions(scenarios, executions) {
  validateScenarioManifest(scenarios);
  if (!Array.isArray(executions)) {
    throw new Error("Security scenario executions must be an array.");
  }

  const expectedById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const observedIds = new Set();
  const observedIdentities = new Set();
  const issues = [];

  for (const [index, execution] of executions.entries()) {
    if (execution === null || typeof execution !== "object" || Array.isArray(execution)) {
      issues.push(`execution[${index}] is not an object`);
      continue;
    }

    const id = execution.id;
    if (typeof id !== "string" || id.length === 0) {
      issues.push(`execution[${index}] has no scenario id`);
      continue;
    }
    if (observedIds.has(id)) {
      issues.push(`duplicate execution for '${id}'`);
      continue;
    }
    observedIds.add(id);

    const expected = expectedById.get(id);
    if (expected === undefined) {
      issues.push(`unexpected execution '${id}'`);
      continue;
    }
    if (
      execution.source !== expected.source
      || execution.test !== expected.test
      || execution.signature !== expected.signature
    ) {
      issues.push(
        `identity mismatch for '${id}': expected '${formatIdentity(expected)}', `
        + `received '${formatIdentity(execution)}'`,
      );
      continue;
    }

    const identity = scenarioIdentity(execution);
    if (observedIdentities.has(identity)) {
      issues.push(`duplicate executed test identity '${formatIdentity(execution)}'`);
      continue;
    }
    observedIdentities.add(identity);

    if (
      execution.infrastructureRetries !== undefined
      && (
        !Number.isSafeInteger(execution.infrastructureRetries)
        || execution.infrastructureRetries < 0
        || execution.infrastructureRetries > SECURITY_MAX_INFRASTRUCTURE_RETRIES
      )
    ) {
      issues.push(`${id}: infrastructure retry count is invalid`);
      continue;
    }

    let result;
    try {
      result = normalizeHardhatTaskResult(execution.result);
    } catch (error) {
      issues.push(`${id}: ${error.message}`);
      continue;
    }
    const executedCount = result.passed + result.failed + result.skipped + result.todo;
    if (executedCount !== 1) {
      issues.push(`${id}: exact selector executed ${executedCount} tests instead of 1`);
    }
    if (result.passed !== 1 || result.failed !== 0 || result.skipped !== 0 || result.todo !== 0) {
      issues.push(
        `${id}: expected passed=1, failed=0, skipped=0, todo=0; `
        + `received passed=${result.passed}, failed=${result.failed}, `
        + `skipped=${result.skipped}, todo=${result.todo}`,
      );
    }
  }

  for (const scenario of scenarios) {
    if (!observedIds.has(scenario.id)) {
      issues.push(`missing execution '${scenario.id}'`);
    }
  }

  if (issues.length > 0) {
    throw new Error(`Security scenario result validation failed: ${issues.join("; ")}`);
  }

  return {
    expected: scenarios.length,
    executed: executions.length,
    passed: executions.length,
  };
}

export function validateSecurityScenarioReport(
  report,
  expectedScenarios,
  { sourceSha256ByPath, hardhatVersion } = {},
) {
  validateScenarioManifest(expectedScenarios);
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("Security scenario report must be an object.");
  }
  if (report.version !== SECURITY_REPORT_VERSION) {
    throw new Error(`Unsupported security scenario report version '${String(report.version)}'.`);
  }
  if (report.status !== "passed") {
    throw new Error(`Security scenario report status must be 'passed', received '${String(report.status)}'.`);
  }
  if (report.executor === null || typeof report.executor !== "object" || Array.isArray(report.executor)) {
    throw new Error("Security scenario report has no structured executor metadata.");
  }
  if (report.executor.kind !== SECURITY_EXECUTOR_KIND) {
    throw new Error(`Unsupported security scenario executor '${String(report.executor.kind)}'.`);
  }
  if (report.executor.task !== SECURITY_EXECUTOR_TASK) {
    throw new Error(`Unsupported security scenario task '${String(report.executor.task)}'.`);
  }
  if (report.executor.selection !== SECURITY_EXECUTOR_SELECTION) {
    throw new Error("Security scenario executor does not declare exact-signature selection.");
  }
  if (report.executor.resultSchema !== SECURITY_RESULT_SCHEMA) {
    throw new Error(`Unsupported security scenario result schema '${String(report.executor.resultSchema)}'.`);
  }
  if (
    report.executor.compilation?.task !== SECURITY_COMPILATION_TASK
    || report.executor.compilation?.mode !== SECURITY_COMPILATION_MODE
    || report.executor.compilation?.force !== true
  ) {
    throw new Error("Security scenario report does not prove a full forced compilation.");
  }
  if (
    report.executor.compilation.infrastructureRetries !== undefined
    && (
      !Number.isSafeInteger(report.executor.compilation.infrastructureRetries)
      || report.executor.compilation.infrastructureRetries < 0
      || report.executor.compilation.infrastructureRetries > SECURITY_MAX_INFRASTRUCTURE_RETRIES
    )
  ) {
    throw new Error("Security scenario compilation infrastructure retry count is invalid.");
  }
  requireNonEmptyString(report.executor.toolVersion, "Hardhat tool version");
  if (hardhatVersion !== undefined && report.executor.toolVersion !== hardhatVersion) {
    throw new Error(
      `Security scenario tool version '${report.executor.toolVersion}' `
      + `does not match expected Hardhat '${hardhatVersion}'.`,
    );
  }
  if (!Array.isArray(report.scenarios)) {
    throw new Error("Security scenario report has no scenario array.");
  }

  const expectedById = new Map(expectedScenarios.map((scenario) => [scenario.id, scenario]));
  const executions = [];
  for (const [index, scenario] of report.scenarios.entries()) {
    if (scenario === null || typeof scenario !== "object" || Array.isArray(scenario)) {
      throw new Error(`Reported security scenario at index ${index} must be an object.`);
    }
    const expected = expectedById.get(scenario.id);
    if (expected === undefined) {
      throw new Error(`Unexpected reported security scenario '${String(scenario.id)}'.`);
    }
    for (const field of ["title", "test", "signature", "control", "source"]) {
      if (scenario[field] !== expected[field]) {
        throw new Error(`Reported security scenario '${scenario.id}' has a mismatched '${field}'.`);
      }
    }
    if (scenario.status !== "passed") {
      throw new Error(`Reported security scenario '${scenario.id}' is not passed.`);
    }
    if (typeof scenario.sourceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(scenario.sourceSha256)) {
      throw new Error(`Reported security scenario '${scenario.id}' has an invalid source hash.`);
    }
    const expectedSourceHash = lookupExpectedSourceHash(sourceSha256ByPath, expected.source);
    if (expectedSourceHash !== undefined && scenario.sourceSha256 !== expectedSourceHash) {
      throw new Error(`Reported security scenario '${scenario.id}' source hash does not match current source.`);
    }
    if (scenario.execution === null || typeof scenario.execution !== "object") {
      throw new Error(`Reported security scenario '${scenario.id}' has no structured execution.`);
    }
    const expectedPattern = exactTestPattern(expected.signature);
    if (
      scenario.execution.selector === null
      || typeof scenario.execution.selector !== "object"
      || !Array.isArray(scenario.execution.selector.testFiles)
      || scenario.execution.selector.testFiles.length !== 1
      || scenario.execution.selector.testFiles[0] !== expected.source
      || scenario.execution.selector.grep !== expectedPattern
    ) {
      throw new Error(`Reported security scenario '${scenario.id}' has a non-exact selector.`);
    }
    executions.push(scenario.execution);
  }

  const summary = validateScenarioExecutions(expectedScenarios, executions);
  if (!sameSummary(report.executor.summary, summary)) {
    throw new Error("Security scenario executor summary does not match structured executions.");
  }
  const expectedResultsHash = sha256Json(executions);
  if (report.executor.structuredResultsSha256 !== expectedResultsHash) {
    throw new Error("Security scenario structured result hash does not match its executions.");
  }
  return summary;
}

export function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function scenarioIdentity({ source, signature }) {
  return `${source}\u0000${signature}`;
}

function formatIdentity({ source, signature, test }) {
  return `${String(source)}#${String(signature ?? test)}`;
}

function sameSummary(left, right) {
  return left !== null
    && typeof left === "object"
    && !Array.isArray(left)
    && left.expected === right.expected
    && left.executed === right.executed
    && left.passed === right.passed;
}

function lookupExpectedSourceHash(sourceSha256ByPath, source) {
  if (sourceSha256ByPath === undefined) return undefined;
  const value = sourceSha256ByPath instanceof Map
    ? sourceSha256ByPath.get(source)
    : sourceSha256ByPath?.[source];
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`No valid expected source hash was provided for '${source}'.`);
  }
  return value;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Expected ${label} to be a non-empty string.`);
  }
}
