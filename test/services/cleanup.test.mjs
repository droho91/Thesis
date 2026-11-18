import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "thesis-clean-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts/ops"), { recursive: true });
  await mkdir(join(root, ".runtime"));
  const script = join(root, "scripts/ops/clean.mjs");
  await copyFile(new URL("../../scripts/ops/clean.mjs", import.meta.url), script);
  return { root, script };
}

test("cleanup removes scratch outputs and preserves deployment, keys and transaction state", async (t) => {
  const { root, script } = await fixture(t);
  await mkdir(join(root, "tmp"));
  await writeFile(join(root, "tmp/preview.png"), "disposable");
  await writeFile(join(root, ".runtime/screenshot.png"), "disposable");
  const retained = ["institutional-deployment.json", "institutional-attestor-secrets.json", "action-journal.json"];
  for (const name of retained) await writeFile(join(root, ".runtime", name), "retain");
  await run(process.execPath, [script]);
  await assert.rejects(access(join(root, "tmp")), { code: "ENOENT" });
  await assert.rejects(access(join(root, ".runtime/screenshot.png")), { code: "ENOENT" });
  for (const name of retained) assert.equal(await readFile(join(root, ".runtime", name), "utf8"), "retain");
});

test("cleanup refuses a cache redirected outside the workspace", async (t) => {
  const { root, script } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "thesis-clean-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(join(outside, "test-artifacts"));
  await writeFile(join(outside, "test-artifacts/keep.txt"), "retain");
  await symlink(outside, join(root, "cache"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(run(process.execPath, [script]), /outside workspace/);
  assert.equal(await readFile(join(outside, "test-artifacts/keep.txt"), "utf8"), "retain");
});
