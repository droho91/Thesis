import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { resolveSafeEvidencePaths } from "../../scripts/verification/safe-evidence-paths.mjs";

const WRITABLE_TEMP_ROOT = process.platform === "win32" ? tmpdir() : "/tmp";

async function fixture(t) {
  const root = await mkdtemp(join(WRITABLE_TEMP_ROOT, "safe-evidence-paths-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  await Promise.all([mkdir(workspace), mkdir(home)]);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, workspace, home };
}

test("resolves only the fixed evidence and lock directories inside the workspace", async (t) => {
  const context = await fixture(t);
  const paths = await resolveSafeEvidencePaths({
    workspaceRoot: context.workspace,
    homeDirectory: context.home,
  });

  assert.equal(paths.evidenceRoot, resolve(context.workspace, ".runtime/evidence"));
  assert.equal(paths.lockRoot, resolve(context.workspace, ".runtime/locks"));
  assert.equal(paths.summaryPath, resolve(context.workspace, ".runtime/evidence/runtime-evidence-summary.json"));
  assert.equal(paths.institutionalLockPath, resolve(context.workspace, ".runtime/locks/institutional-evidence.lock"));
});

test("rejects a symlinked runtime ancestor before any managed write", async (t) => {
  const context = await fixture(t);
  const outside = join(context.root, "outside-runtime");
  await mkdir(outside);
  await symlink(outside, join(context.workspace, ".runtime"), "dir");

  await assert.rejects(
    resolveSafeEvidencePaths({ workspaceRoot: context.workspace, homeDirectory: context.home }),
    /symbolic[- ]link/,
  );
});

for (const managedDirectory of ["evidence", "locks"]) {
  test(`rejects a symlinked ${managedDirectory} managed directory`, async (t) => {
    const context = await fixture(t);
    const outside = join(context.root, `outside-${managedDirectory}`);
    await Promise.all([
      mkdir(join(context.workspace, ".runtime"), { recursive: true }),
      mkdir(outside),
    ]);
    await symlink(outside, join(context.workspace, ".runtime", managedDirectory), "dir");

    await assert.rejects(
      resolveSafeEvidencePaths({ workspaceRoot: context.workspace, homeDirectory: context.home }),
      /symbolic[- ]link/,
    );
  });
}
