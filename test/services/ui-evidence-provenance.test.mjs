import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateEvidenceValidatorRuntime,
  repositoryStateForEvidence,
} from "../../scripts/ui/evidence.mjs";

test("evidence validator runtime detects a commit loaded before the current source", () => {
  const runtime = evaluateEvidenceValidatorRuntime({
    loadedRepository: { commit: "1".repeat(40), dirty: false },
    currentRepository: { commit: "2".repeat(40), dirty: false },
    loadedAt: "2026-09-04T10:00:00.000Z",
  });
  assert.equal(runtime.sourceMatchesCurrent, false);
  assert.equal(runtime.reason, "commit-mismatch");
  assert.equal(runtime.loadedCommitShort, "11111111");
  assert.equal(runtime.currentCommitShort, "22222222");
});

test("evidence validator runtime passes only a clean, unchanged source revision", () => {
  const commit = "a".repeat(40);
  assert.equal(evaluateEvidenceValidatorRuntime({
    loadedRepository: { commit, dirty: false },
    currentRepository: { commit, dirty: false },
  }).sourceMatchesCurrent, true);
  assert.equal(evaluateEvidenceValidatorRuntime({
    loadedRepository: { commit, dirty: true },
    currentRepository: { commit, dirty: false },
  }).reason, "validator-loaded-from-dirty-source");
  assert.equal(evaluateEvidenceValidatorRuntime({
    loadedRepository: { commit, dirty: false },
    currentRepository: { commit, dirty: true },
  }).reason, "current-source-dirty");
});

test("evidence repository lookup strips benign Git presentation variables without losing provenance", async () => {
  const calls = [];
  const outputs = new Map([
    ["git rev-parse HEAD", "1".repeat(40)],
    ["git status --porcelain=v1 --untracked-files=all", " M README.md"],
    ["git ls-files -v", "H README.md"],
    ["git diff --no-ext-diff --name-only HEAD --", "README.md"],
  ]);
  const result = await repositoryStateForEvidence(
    { PATH: "/usr/bin", GIT_PAGER: "cat" },
    {
      runCommand: async (command, args, environment) => {
        calls.push(environment);
        return outputs.get([command, ...args].join(" ")) ?? null;
      },
    },
  );
  assert.equal(result.commit, "1".repeat(40));
  assert.equal(result.dirty, true);
  assert.equal(result.provenanceEnvironmentSafe, true);
  assert.equal(calls.every((environment) => environment.GIT_PAGER === undefined), true);
});

test("evidence repository lookup rejects provenance-altering Git variables before subprocesses", async () => {
  let called = false;
  const result = await repositoryStateForEvidence(
    { GIT_DIR: "/tmp/untrusted" },
    { runCommand: async () => { called = true; return null; } },
  );
  assert.equal(called, false);
  assert.deepEqual(result, {
    commit: null,
    dirty: null,
    changedFileCount: null,
    provenanceEnvironmentSafe: false,
    gitIndexSafe: null,
  });
});
