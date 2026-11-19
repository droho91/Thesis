import assert from "node:assert/strict";
import test from "node:test";
import {
  STAGE_ORDER,
  actionIcon,
  actionStage,
  operationName,
  operationProgressCopy,
} from "../../demo/workflow-presentation.js";

test("workflow metadata maps operations to stable navigation and labels", () => {
  assert.deepEqual(STAGE_ORDER, ["prepare", "transfer", "lend", "manage", "return", "review"]);
  assert.equal(actionStage("bridge"), "transfer");
  assert.equal(actionStage("deposit"), "lend");
  assert.equal(actionStage("repayAll"), "manage");
  assert.equal(actionStage("return"), "return");
  assert.equal(actionStage("unknown"), "review");
  assert.equal(actionIcon("withdraw"), "arrow-up-right");
  assert.equal(actionIcon("unknown"), "circle-check");
  assert.equal(operationName("repayAll"), "Complete debt repayment");
  assert.equal(operationName("unknown"), "Institutional operation");
  assert.equal(
    operationProgressCopy("bridge"),
    "Waiting for the configured checkpoint delay, attestor quorum and cross-chain acknowledgement.",
  );
  assert.equal(operationProgressCopy("borrow"), "Submitting the policy-checked Bank B transaction.");
});
