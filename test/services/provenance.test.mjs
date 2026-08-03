import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  assertRepositoryProvenanceStable,
  collectRepositoryProvenance,
} from "../../scripts/verification/provenance.mjs";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const WRITABLE_TEMP_ROOT = process.platform === "win32" ? tmpdir() : "/tmp";
const execFileAsync = promisify(execFile);

test("Git command errors and invalid object ids fail provenance collection", async (t) => {
  const root = await temporaryRepository(t);

  for (const failedGitCommand of ["rev-parse", "status"]) {
    await assert.rejects(
      collect(root, commandRunner({ failedGitCommand })),
      new RegExp(`Git ${failedGitCommand === "rev-parse" ? "commit" : "status"} lookup failed`),
    );
  }

  await assert.rejects(
    collect(root, commandRunner({ commit: "" })),
    /invalid or empty object id/,
  );
  await assert.rejects(
    collect(root, commandRunner({ commit: "not-a-git-object-id" })),
    /invalid or empty object id/,
  );
});

test("clean and dirty Git states are explicit and status-bound", async (t) => {
  const root = await temporaryRepository(t);
  const clean = await collect(root, commandRunner());
  const dirty = await collect(root, commandRunner({ status: " M README.md\n?? untracked.txt\n" }));

  assert.equal(clean.git.commit, COMMIT_A);
  assert.equal(clean.git.dirty, false);
  assert.equal(clean.git.changedFileCount, 0);
  assert.match(clean.git.statusSha256, /^[0-9a-f]{64}$/);
  assert.match(clean.git.indexFlagsSha256, /^[0-9a-f]{64}$/);
  assert.equal(clean.formalEvidenceEligible, true);

  assert.equal(dirty.git.dirty, true);
  assert.equal(dirty.git.changedFileCount, 2);
  assert.notEqual(dirty.git.statusSha256, clean.git.statusSha256);
  assert.equal(dirty.formalEvidenceEligible, false);
});

test("source provenance rejects file and directory symlinks instead of following them", async (t) => {
  const root = await temporaryRepository(t);
  await writeFile(join(root, "outside.txt"), "must not be followed\n", "utf8");
  await unlink(join(root, "README.md"));
  try {
    await symlink("outside.txt", join(root, "README.md"));
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
      t.skip(`symbolic links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  await assert.rejects(collect(root, commandRunner()), /refuses symbolic link/);

  await unlink(join(root, "README.md"));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "entry.txt"), "source\n", "utf8");
  try {
    await symlink("source", join(root, "linked-source"), "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
      t.skip(`directory symbolic links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(
    collectRepositoryProvenance({}, {
      root,
      sourceInputs: ["linked-source"],
      runCommand: commandRunner(),
    }),
    /refuses symbolic link/,
  );
});

test("stable provenance ignores capture time but accepts no protected-field drift", async (t) => {
  const root = await temporaryRepository(t);
  const initial = await collect(root, commandRunner());
  const final = structuredClone(initial);
  final.capturedAt = new Date(Date.now() + 1_000).toISOString();

  assert.equal(assertRepositoryProvenanceStable(initial, final), true);

  const cases = [
    {
      name: "Git commit",
      mutate(snapshot) { snapshot.git.commit = COMMIT_B; },
    },
    {
      name: "source-tree checksum",
      mutate(snapshot) { snapshot.sourceTreeSha256 = "c".repeat(64); },
    },
    {
      name: "package-lock checksum",
      mutate(snapshot) { snapshot.packageLockSha256 = "d".repeat(64); },
    },
    {
      name: "Git dirty state",
      mutate(snapshot) {
        snapshot.git.dirty = true;
        snapshot.git.changedFileCount = 1;
        snapshot.git.statusSha256 = "e".repeat(64);
        snapshot.formalEvidenceEligible = false;
      },
    },
  ];

  for (const entry of cases) {
    const changed = structuredClone(final);
    entry.mutate(changed);
    assert.throws(
      () => assertRepositoryProvenanceStable(initial, changed),
      new RegExp(entry.name),
    );
  }
});

test("begin/end collection detects a source edit even when injected Git status is unchanged", async (t) => {
  const root = await temporaryRepository(t);
  const runner = commandRunner();
  const initial = await collect(root, runner);
  await writeFile(join(root, "README.md"), "changed during evidence execution\n", "utf8");
  const final = await collect(root, runner);

  assert.notEqual(initial.sourceTreeSha256, final.sourceTreeSha256);
  assert.throws(
    () => assertRepositoryProvenanceStable(initial, final),
    /source-tree checksum/,
  );
});

test("stability validator rejects malformed or internally contradictory snapshots", async (t) => {
  const root = await temporaryRepository(t);
  const valid = await collect(root, commandRunner());
  assert.throws(() => assertRepositoryProvenanceStable(undefined, valid), /initial.*missing or malformed/);

  const contradictory = structuredClone(valid);
  contradictory.git.dirty = true;
  assert.throws(
    () => assertRepositoryProvenanceStable(valid, contradictory),
    /eligibility contradicts.*dirty state/,
  );
});

test("real Git assume-unchanged and skip-worktree flags cannot hide a source edit", async (t) => {
  const root = await temporaryRepository(t);
  const git = (...args) => execFileAsync("git", args, { cwd: root, env: process.env });
  await git("init");
  await git("config", "user.email", "evidence-test@example.invalid");
  await git("config", "user.name", "Evidence Test");
  await git("add", "README.md", "package-lock.json");
  await git("commit", "-m", "fixture");

  await git("update-index", "--assume-unchanged", "README.md");
  await writeFile(join(root, "README.md"), "hidden assume-unchanged edit\n", "utf8");
  await assert.rejects(
    collectRepositoryProvenance(process.env, { root, sourceInputs: ["README.md", "package-lock.json"] }),
    /assume-unchanged or skip-worktree/,
  );

  await git("update-index", "--no-assume-unchanged", "README.md");
  await writeFile(join(root, "README.md"), "source\n", "utf8");
  await git("update-index", "--skip-worktree", "README.md");
  await writeFile(join(root, "README.md"), "hidden skip-worktree edit\n", "utf8");
  await assert.rejects(
    collectRepositoryProvenance(process.env, { root, sourceInputs: ["README.md", "package-lock.json"] }),
    /assume-unchanged or skip-worktree/,
  );
});

async function temporaryRepository(t) {
  const root = await mkdtemp(join(WRITABLE_TEMP_ROOT, "institutional-provenance-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "README.md"), "source\n", "utf8");
  await writeFile(join(root, "package-lock.json"), "{}\n", "utf8");
  return root;
}

function collect(root, runCommand) {
  return collectRepositoryProvenance({}, {
    root,
    sourceInputs: ["README.md", "package-lock.json"],
    runCommand,
  });
}

function commandRunner({ commit = COMMIT_A, status = "", indexFlags = "H README.md", failedGitCommand = null } = {}) {
  return async (command, args) => {
    if (command === "git" && args[0] === failedGitCommand) {
      return { ok: false, stdout: "", stderr: "simulated Git failure", code: 128 };
    }
    if (command === "git" && args[0] === "rev-parse") return { ok: true, stdout: `${commit}\n` };
    if (command === "git" && args[0] === "status") return { ok: true, stdout: status };
    if (command === "git" && args[0] === "ls-files") return { ok: true, stdout: indexFlags };
    if (command === "git" && args[0] === "diff") return { ok: true, stdout: "" };
    if (command === "docker") return { ok: true, stdout: "Docker version test\n" };
    return { ok: true, stdout: "10.0.0\n" };
  };
}
