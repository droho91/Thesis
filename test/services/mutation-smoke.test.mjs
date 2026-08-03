import assert from "node:assert/strict";
import test from "node:test";

import {
  MUTANTS,
  applyExactMutation,
  assertBaselineResult,
  assertKilledResult,
  extractTaskSummary,
  validateMutationManifest,
} from "../../scripts/verification/mutation-smoke.mjs";

test("mutation manifest declares unique, exact security mutations", () => {
  assert.equal(validateMutationManifest(), MUTANTS);
  assert.equal(new Set(MUTANTS.map(({ id }) => id)).size, 4);
});

test("exact mutation fails closed for missing or ambiguous source needles", () => {
  const mutant = MUTANTS[0];
  assert.equal(applyExactMutation(`before ${mutant.needle} after`, mutant), `before ${mutant.replacement} after`);
  assert.throws(() => applyExactMutation("no match", mutant), /found 0/);
  assert.throws(() => applyExactMutation(`${mutant.needle}\n${mutant.needle}`, mutant), /found 2/);
});

test("structured task summaries distinguish baseline pass from an attributable kill", () => {
  const mutant = MUTANTS[0];
  const baseline = {
    success: true,
    value: { summary: { passed: 1, failed: 0, skipped: 0, todo: 0 } },
  };
  const killed = {
    success: false,
    error: { summary: { passed: 0, failed: 1, skipped: 0, todo: 0 } },
  };

  assert.deepEqual(assertBaselineResult(mutant, baseline), baseline.value.summary);
  assert.deepEqual(assertKilledResult(mutant, killed), killed.error.summary);
  assert.deepEqual(extractTaskSummary(killed), { success: false, summary: killed.error.summary });
  assert.throws(() => assertKilledResult(mutant, baseline), /survived/);
  assert.throws(
    () => assertKilledResult(mutant, {
      success: false,
      error: { summary: { passed: 0, failed: 0, skipped: 0, todo: 0 } },
    }),
    /did not produce one attributable test failure/,
  );
});
