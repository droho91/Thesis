import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const lcovPath = path.join(repositoryRoot, "coverage", "lcov.info");
const hardhatCli = path.join(repositoryRoot, "node_modules", "hardhat", "dist", "src", "cli.js");
const coverageConfig = path.join(repositoryRoot, "hardhat.coverage.config.js");

const GLOBAL_MINIMUM = 90;
const EVERY_FILE_MINIMUM = 50;
const MINIMUM_REPORTED_FILES = 20;
const CRITICAL_FILE_MINIMUMS = new Map([
  ["contracts/apps/BankPolicyEngine.sol", 90],
  ["contracts/apps/InstitutionalCollateralApp.sol", 95],
  ["contracts/apps/InstitutionalRestitutionVault.sol", 95],
  ["contracts/apps/PolicyControlledLendingPool.sol", 90],
  ["contracts/gateway/InstitutionalCheckpointClient.sol", 95],
  ["contracts/gateway/InstitutionalCrossChainGateway.sol", 95],
  ["contracts/gateway/InstitutionalEVMProofBoundary.sol", 80],
  ["contracts/gateway/InstitutionalEVMProofVerifier.sol", 100],
  ["contracts/libs/HexPrefixLib.sol", 95],
  ["contracts/libs/MerklePatriciaProofLib.sol", 80],
  ["contracts/libs/RLPDecodeLib.sol", 70],
]);

function fail(message) {
  throw new Error(`Solidity coverage gate: ${message}`);
}

async function modificationTime(filename) {
  try {
    return (await stat(filename)).mtimeMs;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function generateCoverage() {
  const previousModificationTime = await modificationTime(lcovPath);
  const exit = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [hardhatCli, "--coverage", "--config", coverageConfig, "test", "solidity"],
      { cwd: repositoryRoot, env: process.env, stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  if (exit.signal !== null) fail(`Hardhat coverage terminated by signal ${exit.signal}`);
  if (exit.code !== 0) fail(`Hardhat coverage exited with code ${exit.code}`);

  const currentModificationTime = await modificationTime(lcovPath);
  if (currentModificationTime === undefined) fail("coverage/lcov.info was not produced");
  if (previousModificationTime !== undefined && currentModificationTime <= previousModificationTime) {
    fail("coverage/lcov.info was not refreshed by this run");
  }
}

function parseNonNegativeInteger(raw, label) {
  if (!/^(0|[1-9]\d*)$/.test(raw)) fail(`${label} is not a non-negative integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) fail(`${label} exceeds the safe integer range`);
  return value;
}

function oneField(lines, prefix, source) {
  const matches = lines.filter((line) => line.startsWith(prefix));
  if (matches.length !== 1) fail(`${source} must contain exactly one ${prefix.slice(0, -1)} field`);
  return matches[0].slice(prefix.length);
}

function normalizeSource(rawSource) {
  const source = rawSource.replaceAll("\\", "/");
  if (!source.startsWith("contracts/") || source.includes("../") || path.isAbsolute(rawSource)) {
    fail(`unexpected source path ${JSON.stringify(rawSource)}`);
  }
  if (source.startsWith("contracts/test/")) fail(`test helper leaked into coverage: ${source}`);
  return source;
}

export function parseLcov(rawReport) {
  if (!rawReport.endsWith("\n")) fail("LCOV report is truncated (missing final newline)");
  const records = rawReport
    .split("end_of_record\n")
    .map((record) => record.trim())
    .filter(Boolean);
  if (records.length === 0) fail("LCOV report has no records");

  const files = new Map();
  for (const record of records) {
    const lines = record.split(/\r?\n/).filter((line) => line !== "TN:");
    const source = normalizeSource(oneField(lines, "SF:", "LCOV record"));
    if (files.has(source)) fail(`duplicate LCOV record for ${source}`);

    const found = parseNonNegativeInteger(oneField(lines, "LF:", source), `${source} LF`);
    const reportedHits = parseNonNegativeInteger(oneField(lines, "LH:", source), `${source} LH`);
    const dataLines = lines.filter((line) => line.startsWith("DA:"));
    const seenLineNumbers = new Set();
    let computedHits = 0;

    for (const dataLine of dataLines) {
      const match = /^DA:(\d+),(\d+)$/.exec(dataLine);
      if (match === null) fail(`${source} contains malformed DA data: ${dataLine}`);
      const lineNumber = parseNonNegativeInteger(match[1], `${source} DA line`);
      const executionCount = parseNonNegativeInteger(match[2], `${source}:${lineNumber} execution count`);
      if (lineNumber === 0 || seenLineNumbers.has(lineNumber)) {
        fail(`${source} contains an invalid or duplicate DA line ${lineNumber}`);
      }
      seenLineNumbers.add(lineNumber);
      if (executionCount > 0) computedHits++;
    }

    if (found === 0) fail(`${source} reports zero instrumented lines`);
    if (dataLines.length !== found) fail(`${source} DA count ${dataLines.length} does not match LF ${found}`);
    if (computedHits !== reportedHits) {
      fail(`${source} computed hits ${computedHits} do not match LH ${reportedHits}`);
    }
    if (reportedHits > found) fail(`${source} reports more hit lines than found lines`);

    files.set(source, { found, hits: reportedHits, percent: (reportedHits * 100) / found });
  }

  return files;
}

export function enforceThresholds(files) {
  const violations = [];
  if (files.size < MINIMUM_REPORTED_FILES) {
    violations.push(`only ${files.size} source files reported; expected at least ${MINIMUM_REPORTED_FILES}`);
  }

  let totalFound = 0;
  let totalHits = 0;
  for (const [source, coverage] of files) {
    totalFound += coverage.found;
    totalHits += coverage.hits;
    if (coverage.percent < EVERY_FILE_MINIMUM) {
      violations.push(`${source}: ${coverage.percent.toFixed(2)}% < per-file floor ${EVERY_FILE_MINIMUM}%`);
    }
  }

  const globalPercent = (totalHits * 100) / totalFound;
  if (globalPercent < GLOBAL_MINIMUM) {
    violations.push(`global: ${globalPercent.toFixed(2)}% < ${GLOBAL_MINIMUM}%`);
  }

  for (const [source, minimum] of CRITICAL_FILE_MINIMUMS) {
    const coverage = files.get(source);
    if (coverage === undefined) {
      violations.push(`${source}: missing from report`);
    } else if (coverage.percent < minimum) {
      violations.push(`${source}: ${coverage.percent.toFixed(2)}% < critical floor ${minimum}%`);
    }
  }

  if (violations.length > 0) fail(`threshold violations:\n- ${violations.join("\n- ")}`);

  console.log(
    `Solidity coverage gate passed: ${totalHits}/${totalFound} lines (${globalPercent.toFixed(2)}%), `
      + `${files.size} files, critical floors satisfied.`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check-only") || args.filter((arg) => arg === "--check-only").length > 1) {
    fail("usage: node scripts/verification/solidity-coverage-gate.mjs [--check-only]");
  }

  if (!args.includes("--check-only")) await generateCoverage();

  let report;
  try {
    report = await readFile(lcovPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") fail("coverage/lcov.info is missing");
    throw error;
  }
  enforceThresholds(parseLcov(report));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
