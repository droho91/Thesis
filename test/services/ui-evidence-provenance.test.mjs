import assert from "node:assert/strict";
import test from "node:test";

import { repositoryStateForEvidence } from "../../scripts/ui/evidence.mjs";

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
