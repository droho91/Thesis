import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const workflowPath = resolve(process.cwd(), ".github/workflows/ci.yml");

test("hosted Besu job runs clean evidence, verifies it and retains bounded cleanup", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const job = workflow.slice(workflow.indexOf("  live-besu-evidence:"));
  assert.match(job, /name: Live Besu evidence/);
  assert.match(job, /npm run institutional:evidence(?:\s|$)/);
  assert.doesNotMatch(job, /institutional:evidence\s+--\s+--allow-dirty/);
  assert.match(job, /npm run institutional:evidence:verify/);
  assert.match(job, /timeout-minutes: 100/);
  assert.match(job, /timeout --signal=TERM --kill-after=30s 85m\s+npm run institutional:evidence/);
  assert.match(job, /if: always\(\)[\s\S]*down --volumes --remove-orphans/);
  assert.match(job, /path: \.runtime\/evidence\/\*\.json/);
});

test("every external workflow action is pinned to a full commit SHA", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const actions = [...workflow.matchAll(/^\s*- uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  assert.equal(actions.length > 0, true);
  for (const action of actions) assert.match(action, /^[^@]+@[0-9a-f]{40}$/);
});
