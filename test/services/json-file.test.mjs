import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readJson,
  readJsonIfExists,
  writeJsonAtomic,
} from "../../services/shared/json-file.mjs";

test("shared JSON file helpers round-trip data and distinguish a missing file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "institutional-json-file-"));
  const path = join(directory, "nested", "state.json");
  t.after(() => rm(directory, { recursive: true, force: true }));

  assert.equal(await readJsonIfExists(path), null);
  await writeJsonAtomic(path, { version: "json-file-test-v1", value: 1 });
  assert.deepEqual(await readJson(path), { version: "json-file-test-v1", value: 1 });

  await writeJsonAtomic(path, { version: "json-file-test-v1", value: 2 });
  assert.deepEqual(await readJsonIfExists(path), { version: "json-file-test-v1", value: 2 });
  assert.equal((await readFile(path, "utf8")).endsWith("\n"), true);
});

test("shared JSON writes honor explicit file mode and reject invalid modes", async (t) => {
  const permissionAwareTempRoot = process.platform === "win32" ? tmpdir() : "/tmp";
  const directory = await mkdtemp(join(permissionAwareTempRoot, "institutional-json-mode-"));
  const path = join(directory, "secret.json");
  t.after(() => rm(directory, { recursive: true, force: true }));

  await writeJsonAtomic(path, { secret: true }, { mode: 0o600 });
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(writeJsonAtomic(path, {}, { mode: 0o1000 }), /JSON file mode/);
});

test("shared JSON reads surface malformed content instead of treating it as missing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "institutional-json-invalid-"));
  const path = join(directory, "invalid.json");
  t.after(() => rm(directory, { recursive: true, force: true }));

  await writeJsonAtomic(path, { valid: true });
  const text = await readFile(path, "utf8");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(path, `${text}{`, "utf8"));
  await assert.rejects(readJsonIfExists(path), SyntaxError);
});
