import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { exactTestPattern } from "./security-scenario-results.mjs";

export const MUTATION_REPORT_VERSION = "institutional-mutation-smoke-v1";
export const MUTATION_SCORE_THRESHOLD_PERCENT = 100;

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, "../..");
const SANDBOX_PREFIX = "thesis-mutation-smoke-";
const REPORT_PATH = resolve(PROJECT_ROOT, ".runtime/verification/mutation-smoke.json");

export const MUTANTS = Object.freeze([
  Object.freeze({
    id: "MUT-MPT-ROOT-REFERENCE",
    property: "A proof node must remain cryptographically bound to its expected trie reference.",
    source: "contracts/libs/MerklePatriciaProofLib.sol",
    needle: "return keccak256(node) == bytes32(expectedNodeRef);",
    replacement: "return keccak256(node) != bytes32(expectedNodeRef);",
    testSource: "test/gateway/MerklePatriciaProofAssurance.t.sol",
    testSignature: "testHashedBranchCorpusMatchesIndependentReference()",
  }),
  Object.freeze({
    id: "MUT-GATEWAY-REPLAY-RECEIPT",
    property: "A successful destination callback must persist a receipt before external execution returns.",
    source: "contracts/gateway/InstitutionalCrossChainGateway.sol",
    needle: "_storeWord(InstitutionalGatewaySlots.receipt(messageId), bytes32(uint256(1)));",
    replacement: "_storeWord(InstitutionalGatewaySlots.receipt(messageId), bytes32(0));",
    testSource: "test/gateway/InstitutionalCrossChainGateway.t.sol",
    testSignature: "testReceiveRejectsReplayAndForgedCommitment()",
  }),
  Object.freeze({
    id: "MUT-CHECKPOINT-RECOVERY-FLOOR",
    property: "A checkpoint below the recovery authorization floor must not authorize a proof.",
    source: "contracts/gateway/InstitutionalEVMProofBoundary.sol",
    needle: "proof.checkpointHeight < checkpointClient.checkpointAuthorizationFloor(proof.sourceChainId)",
    replacement: "proof.checkpointHeight > checkpointClient.checkpointAuthorizationFloor(proof.sourceChainId)",
    testSource: "test/gateway/InstitutionalCheckpointClient.t.sol",
    testSignature: "testRecoveryRejectsOldProofButAcceptsRecoveryProofAndPreservesAuditData()",
  }),
  Object.freeze({
    id: "MUT-LIQUIDATION-RISK-BOUNDARY",
    property: "The aggregate liquidation-risk boundary must accept equality and reject values above it.",
    source: "contracts/apps/LendingPoolMath.sol",
    needle: "haircutBps * thresholdBps * (BPS + bonusBps) <= BPS * BPS * BPS",
    replacement: "haircutBps * thresholdBps * (BPS + bonusBps) < BPS * BPS * BPS",
    testSource: "test/apps/LendingValuation.t.sol",
    testSignature: "testLiquidationConfigurationEnforcesAggregateRiskInvariant()",
  }),
]);

export function validateMutationManifest(mutants = MUTANTS) {
  if (!Array.isArray(mutants) || mutants.length === 0) {
    throw new Error("Mutation manifest must be a non-empty array.");
  }

  const ids = new Set();
  for (const [index, mutant] of mutants.entries()) {
    if (mutant === null || typeof mutant !== "object" || Array.isArray(mutant)) {
      throw new Error(`Mutation manifest entry ${index} must be an object.`);
    }
    for (const field of ["id", "property", "source", "needle", "replacement", "testSource", "testSignature"]) {
      if (typeof mutant[field] !== "string" || mutant[field].length === 0) {
        throw new Error(`Mutation manifest entry ${index} has no non-empty '${field}'.`);
      }
    }
    if (ids.has(mutant.id)) throw new Error(`Duplicate mutation id '${mutant.id}'.`);
    if (mutant.needle === mutant.replacement) {
      throw new Error(`Mutation '${mutant.id}' does not change its source.`);
    }
    if (!mutant.source.startsWith("contracts/") || !mutant.source.endsWith(".sol")) {
      throw new Error(`Mutation '${mutant.id}' must target one Solidity contract source.`);
    }
    if (!mutant.testSource.startsWith("test/") || !mutant.testSource.endsWith(".t.sol")) {
      throw new Error(`Mutation '${mutant.id}' must select one Solidity test source.`);
    }
    if (!/^test[A-Za-z0-9_]+\([^)]*\)$/.test(mutant.testSignature)) {
      throw new Error(`Mutation '${mutant.id}' has an invalid exact test signature.`);
    }
    ids.add(mutant.id);
  }
  return mutants;
}

export function applyExactMutation(sourceText, mutant) {
  const occurrences = sourceText.split(mutant.needle).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Mutation '${mutant.id}' expected one source match in '${mutant.source}', found ${occurrences}.`,
    );
  }
  return sourceText.replace(mutant.needle, mutant.replacement);
}

export function extractTaskSummary(taskResult) {
  if (
    taskResult === null
    || typeof taskResult !== "object"
    || typeof taskResult.success !== "boolean"
  ) {
    throw new Error("Hardhat returned a malformed Solidity task result envelope.");
  }
  const payload = taskResult.success ? taskResult.value : taskResult.error;
  const summary = payload?.summary;
  if (summary === null || typeof summary !== "object" || Array.isArray(summary)) {
    throw new Error("Hardhat returned no structured Solidity test summary.");
  }
  const normalized = {};
  for (const field of ["passed", "failed", "skipped", "todo"]) {
    if (!Number.isSafeInteger(summary[field]) || summary[field] < 0) {
      throw new Error(`Hardhat returned an invalid '${field}' count.`);
    }
    normalized[field] = summary[field];
  }
  return { success: taskResult.success, summary: normalized };
}

export function assertBaselineResult(mutant, taskResult) {
  const result = extractTaskSummary(taskResult);
  const { passed, failed, skipped, todo } = result.summary;
  if (!result.success || passed !== 1 || failed !== 0 || skipped !== 0 || todo !== 0) {
    throw new Error(
      `Baseline selector for '${mutant.id}' must execute exactly one passing test; `
      + `received success=${result.success}, passed=${passed}, failed=${failed}, skipped=${skipped}, todo=${todo}.`,
    );
  }
  return result.summary;
}

export function assertKilledResult(mutant, taskResult) {
  const result = extractTaskSummary(taskResult);
  const { passed, failed, skipped, todo } = result.summary;
  if (result.success || passed !== 0 || failed !== 1 || skipped !== 0 || todo !== 0) {
    throw new Error(
      `Mutant '${mutant.id}' survived or did not produce one attributable test failure; `
      + `received success=${result.success}, passed=${passed}, failed=${failed}, skipped=${skipped}, todo=${todo}.`,
    );
  }
  return result.summary;
}

async function main() {
  const startedAt = Date.now();
  validateMutationManifest();
  const sourceHashesBefore = await hashManagedSources(PROJECT_ROOT);
  const packageLockSha256 = await sha256(resolve(PROJECT_ROOT, "package-lock.json"));
  const originalCwd = process.cwd();
  let sandbox;
  let report;
  let failure;

  await writeMutationReport({
    version: MUTATION_REPORT_VERSION,
    status: "running",
    assuranceScope: "bounded-security-mutation-smoke",
    evidenceEligible: false,
    packageLockSha256,
    sourceSha256ByPath: Object.fromEntries(sourceHashesBefore),
  });
  try {
    sandbox = await createSandbox();
    process.chdir(sandbox);
    const { default: hre } = await import("hardhat");
    await hre.tasks.getTask(["compile"]).run({ force: true, quiet: true });

    const baseline = [];
    for (const mutant of MUTANTS) {
      const testStartedAt = Date.now();
      const result = await runExactTest(hre, mutant);
      baseline.push({
        id: mutant.id,
        testSource: mutant.testSource,
        testSignature: mutant.testSignature,
        durationMs: Date.now() - testStartedAt,
        result: assertBaselineResult(mutant, result),
      });
    }

    const killed = [];
    for (const mutant of MUTANTS) {
      const sourcePath = resolve(sandbox, mutant.source);
      const originalSource = await readFile(sourcePath, "utf8");
      const mutatedSource = applyExactMutation(originalSource, mutant);
      await writeFile(sourcePath, mutatedSource, "utf8");

      try {
        const mutationStartedAt = Date.now();
        // Compilation failure is an invalid mutant, not a test kill. Incremental
        // compilation is intentional: if Hardhat reused a stale artifact, the
        // unchanged targeted test would pass and the mutant would fail this gate.
        await hre.tasks.getTask(["compile"]).run({ quiet: true });
        const result = await runExactTest(hre, mutant);
        killed.push({
          id: mutant.id,
          property: mutant.property,
          source: mutant.source,
          testSource: mutant.testSource,
          testSignature: mutant.testSignature,
          mutationSha256: sha256Content(`${mutant.needle}\0${mutant.replacement}`),
          mutatedSourceSha256: sha256Content(mutatedSource),
          durationMs: Date.now() - mutationStartedAt,
          result: assertKilledResult(mutant, result),
        });
      } finally {
        await writeFile(sourcePath, originalSource, "utf8");
      }
    }

    const scorePercent = killed.length * 100 / MUTANTS.length;
    if (scorePercent < MUTATION_SCORE_THRESHOLD_PERCENT) {
      throw new Error(
        `Mutation score ${scorePercent.toFixed(2)}% is below ${MUTATION_SCORE_THRESHOLD_PERCENT}%.`,
      );
    }

    const sourceHashesAfter = await hashManagedSources(PROJECT_ROOT);
    assertStableHashes(sourceHashesBefore, sourceHashesAfter);
    report = {
      version: MUTATION_REPORT_VERSION,
      status: "passed",
      assuranceScope: "bounded-security-mutation-smoke",
      evidenceEligible: false,
      tool: { hardhat: hre.versions.hardhat, node: process.version },
      packageLockSha256,
      sourceSha256ByPath: Object.fromEntries(sourceHashesAfter),
      isolation: "ephemeral-copy; repository sources are read-only inputs",
      compilation: "forced clean baseline followed by mutation-aware incremental builds",
      thresholdPercent: MUTATION_SCORE_THRESHOLD_PERCENT,
      scorePercent,
      baseline,
      mutants: killed,
      summary: { total: MUTANTS.length, killed: killed.length, survived: 0, invalid: 0 },
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    failure = error;
  } finally {
    process.chdir(originalCwd);
    if (sandbox !== undefined) {
      try {
        await removeSandbox(sandbox);
      } catch (error) {
        failure ??= error;
      }
    }
  }

  if (failure !== undefined) {
    await writeMutationReport({
      version: MUTATION_REPORT_VERSION,
      status: "failed",
      assuranceScope: "bounded-security-mutation-smoke",
      evidenceEligible: false,
      packageLockSha256,
      sourceSha256ByPath: Object.fromEntries(sourceHashesBefore),
      durationMs: Date.now() - startedAt,
      failure: { name: failure?.name || "Error", message: failure?.message || String(failure) },
    });
    throw failure;
  }

  await writeMutationReport(report);
  console.log(
    `[mutation:smoke] PASS ${report.summary.killed}/${report.summary.total} killed `
    + `(${report.scorePercent.toFixed(0)}%)`,
  );
  console.log(`[mutation:smoke] report=${REPORT_PATH}`);
}

async function runExactTest(hre, mutant) {
  return hre.tasks.getTask(["test", "solidity"]).run({
    testFiles: [mutant.testSource],
    grep: exactTestPattern(mutant.testSignature),
    chainType: "l1",
    noCompile: true,
    testSummaryIndex: 1,
  });
}

async function createSandbox() {
  const sandbox = await mkdtemp(join(tmpdir(), SANDBOX_PREFIX));
  try {
    await Promise.all([
      cp(resolve(PROJECT_ROOT, "contracts"), resolve(sandbox, "contracts"), { recursive: true }),
      cp(resolve(PROJECT_ROOT, "test"), resolve(sandbox, "test"), { recursive: true }),
      cp(resolve(PROJECT_ROOT, "hardhat.config.js"), resolve(sandbox, "hardhat.config.js")),
      cp(resolve(PROJECT_ROOT, "package.json"), resolve(sandbox, "package.json")),
    ]);
    await symlink(await realpath(resolve(PROJECT_ROOT, "node_modules")), resolve(sandbox, "node_modules"), "dir");
    return sandbox;
  } catch (error) {
    await removeSandbox(sandbox).catch(() => {});
    throw error;
  }
}

async function writeMutationReport(report) {
  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function removeSandbox(sandbox) {
  const canonicalTemporaryRoot = await realpath(tmpdir());
  const sandboxParent = await realpath(dirname(sandbox));
  const relativeSandbox = relative(canonicalTemporaryRoot, sandbox);
  if (
    sandboxParent !== canonicalTemporaryRoot
    || !relativeSandbox.startsWith(SANDBOX_PREFIX)
    || relativeSandbox.includes(sep)
  ) {
    throw new Error(`Refusing to remove unexpected mutation sandbox '${sandbox}'.`);
  }
  const stat = await lstat(sandbox);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to remove non-directory mutation sandbox '${sandbox}'.`);
  }
  await rm(sandbox, { recursive: true, force: false });
}

async function hashManagedSources(root) {
  const paths = [...new Set(MUTANTS.flatMap((mutant) => [mutant.source, mutant.testSource]))].sort();
  return new Map(await Promise.all(paths.map(async (path) => [path, await sha256(resolve(root, path))])));
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function sha256Content(content) {
  return createHash("sha256").update(content).digest("hex");
}

function assertStableHashes(before, after) {
  for (const [path, hash] of before) {
    if (after.get(path) !== hash) {
      throw new Error(`Repository source '${path}' changed during isolated mutation execution.`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
