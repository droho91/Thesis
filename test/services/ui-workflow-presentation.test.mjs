import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTION_TAB,
  STAGE_ORDER,
  actionIcon,
  actionStage,
  operationName,
  operationProgressCopy,
  recommendationFor,
} from "../../demo/workflow-presentation.js";

function workflowStatus(nextAction, balances = {}, risk = {}) {
  return {
    workflow: { nextAction },
    balances: {
      outstandingDebt: "0",
      creditAvailable: "0",
      ...balances,
    },
    risk: { availableBorrow: "12.34567", ...risk },
  };
}

test("workflow metadata maps operations to stable navigation and labels", () => {
  assert.deepEqual(STAGE_ORDER, ["prepare", "transfer", "lend", "manage", "return", "review"]);
  assert.equal(ACTION_TAB.repayAll, "lending");
  assert.equal(actionStage("bridge"), "transfer");
  assert.equal(actionStage("deposit"), "lend");
  assert.equal(actionStage("repayAll"), "manage");
  assert.equal(actionStage("return"), "return");
  assert.equal(actionStage("unknown"), "review");
  assert.equal(actionIcon("withdraw"), "download");
  assert.equal(actionIcon("unknown"), "circle-check");
  assert.equal(operationName("repayAll"), "Complete debt repayment");
  assert.equal(operationName("unknown"), "Institutional operation");
  assert.equal(
    operationProgressCopy("bridge"),
    "Waiting for the configured checkpoint delay, attestor quorum and cross-chain acknowledgement.",
  );
  assert.equal(operationProgressCopy("borrow"), "Submitting the policy-checked Bank B transaction.");
});

test("workflow recommendations preserve contextual calls to action", () => {
  assert.equal(recommendationFor(workflowStatus("bridge")).action, "bridge");
  assert.equal(recommendationFor(workflowStatus("deposit")).button, "Open lending");
  assert.equal(
    recommendationFor(workflowStatus("borrow")).copy,
    "12.3456… bCASH remains within policy and liquidity limits.",
  );
  assert.equal(recommendationFor(workflowStatus("withdraw")).image, "guide");
  assert.equal(recommendationFor(workflowStatus("return")).image, "success");

  const regularRepay = recommendationFor(workflowStatus("repay", {
    outstandingDebt: "5",
    creditAvailable: "5",
  }));
  assert.equal(regularRepay.action, "repay");
  assert.equal(regularRepay.copy, "5 bCASH remains outstanding on Bank B.");

  const exactRepay = recommendationFor(workflowStatus("repay", {
    outstandingDebt: "0.009",
    creditAvailable: "0.01",
  }));
  assert.equal(exactRepay.action, "repayAll");
  assert.equal(exactRepay.button, "Repay full balance");

  const neutral = recommendationFor(workflowStatus(undefined));
  assert.equal(neutral.image, "neutral");
  assert.equal(neutral.action, "evidence");
});
