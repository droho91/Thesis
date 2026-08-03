import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");
const SOURCE_ROOTS = ["scripts", "services", "demo"];
const COMPATIBILITY_ONLY_KEYS = new Set([
  "DEMO_BESU_VALIDATOR_COUNT",
  "TX_SEND_RETRIES",
]);

test(".env.example contains only live variables and documents every non-compatibility source key", async () => {
  const example = await readFile(join(ROOT, ".env.example"), "utf8");
  const exampleKeys = parseEnvironmentKeys(example);
  const sourceKeys = new Set();
  for (const directory of SOURCE_ROOTS) {
    for (const path of await sourceFiles(join(ROOT, directory))) {
      const source = await readFile(path, "utf8");
      for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) sourceKeys.add(match[1]);
    }
  }

  assert.deepEqual(
    [...exampleKeys].filter((key) => !sourceKeys.has(key)),
    [],
    ".env.example contains keys that production source no longer reads",
  );
  assert.deepEqual(
    [...sourceKeys].filter((key) => !exampleKeys.has(key) && !COMPATIBILITY_ONLY_KEYS.has(key)).sort(),
    [],
    "production environment keys are missing from .env.example",
  );
});

test(".env.example has unique assignments and excludes removed prototype controls", async () => {
  const example = await readFile(join(ROOT, ".env.example"), "utf8");
  const assignments = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]);
  assert.equal(new Set(assignments).size, assignments.length, "duplicate .env.example assignment");
  for (const removed of [
    "DEMO_FORWARD_AMOUNT",
    "DEMO_PACKET_TIMEOUT_HEIGHT",
    "DEMO_LIGHT_CLIENT_HEARTBEAT",
    "DEMO_PREPARED_CONTEXT_HEALTH_TTL_MS",
  ]) {
    assert.equal(assignments.includes(removed), false, `${removed} must remain removed`);
  }
});

function parseEnvironmentKeys(source) {
  return new Set([...source.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]));
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await sourceFiles(path));
    else if ([".js", ".mjs"].includes(extname(entry.name))) paths.push(path);
  }
  return paths;
}
