import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { mkdtemp, mkdir, writeFile, readFile, access, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertUiStopped, resetDemoState } from "../../scripts/ops/demo/reset-state.mjs";

test("demo reset refuses to run while the UI port is listening", async t => {
  const server = createServer(socket => socket.end());
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(assertUiStopped(server.address().port), /Stop the demo UI/);
});

test("demo reset removes old journals and deployment while preserving keys and code", async t => {
  const root = await mkdtemp(join(tmpdir(), "thesis-reset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".runtime/institutional-demo"), { recursive: true });
  await writeFile(join(root, ".runtime/institutional-demo/journal.json"), "old");
  await writeFile(join(root, ".runtime/institutional-deployment.json"), "old");
  await writeFile(join(root, ".runtime/institutional-attestor-secrets.json"), "keep");
  await resetDemoState(root, { check: async () => {}, log() {} });
  await assert.rejects(access(join(root, ".runtime/institutional-demo")), { code: "ENOENT" });
  await assert.rejects(access(join(root, ".runtime/institutional-deployment.json")), { code: "ENOENT" });
  assert.equal(await readFile(join(root, ".runtime/institutional-attestor-secrets.json"), "utf8"), "keep");
});

test("demo reset validates all paths before deleting through a redirected runtime", async t => {
  const root = await mkdtemp(join(tmpdir(), "thesis-reset-root-"));
  const outside = await mkdtemp(join(tmpdir(), "thesis-reset-outside-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  await writeFile(join(outside, "institutional-deployment.json"), "keep");
  await symlink(outside, join(root, ".runtime"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(resetDemoState(root, { check: async () => {}, log() {} }), /outside the workspace/);
  assert.equal(await readFile(join(outside, "institutional-deployment.json"), "utf8"), "keep");
});
