import assert from "node:assert/strict";
import test from "node:test";
import {
  LENDING_MODES,
  canRepaySmallBalance,
  healthPresentation,
  isSmallBalance,
  lendingSubmissionAction,
  tokenUnits,
  validateAction,
} from "../../demo/lending-domain.js";

function status({ laneReady = true, balances = {}, risk = {} } = {}) {
  return {
    laneReady,
    balances: {
      canonicalAvailable: "100",
      voucherAvailable: "40",
      activeCollateral: "20",
      outstandingDebt: "10",
      creditAvailable: "7",
      ...balances,
    },
    risk: {
      availableBorrow: "12",
      healthFactor: "1.5",
      accrualCatchUpRequired: false,
      accountDefaulted: false,
      borrowPaused: false,
      collateralWithdrawalPaused: false,
      ...risk,
    },
  };
}

test("lending modes derive exact on-chain limits", () => {
  const current = status();
  assert.equal(LENDING_MODES.deposit.limit(current), "40");
  assert.equal(LENDING_MODES.borrow.limit(current), "12");
  assert.equal(LENDING_MODES.repay.limit(current), "7");
  assert.equal(LENDING_MODES.withdraw.limit(current), "0");
  assert.equal(
    LENDING_MODES.withdraw.limit(status({ balances: { outstandingDebt: "0" } })),
    "20",
  );
  assert.equal(Object.isFrozen(LENDING_MODES), true);
  assert.equal(Object.isFrozen(LENDING_MODES.deposit), true);
});

test("small balances select exact repayment without floating-point tolerance", () => {
  const repayable = status({
    balances: { outstandingDebt: "0.009999999999999999", creditAvailable: "0.01" },
  });
  assert.equal(isSmallBalance(repayable), true);
  assert.equal(canRepaySmallBalance(repayable), true);
  assert.equal(lendingSubmissionAction("repay", repayable), "repayAll");

  const threshold = status({ balances: { outstandingDebt: "0.01", creditAvailable: "1" } });
  assert.equal(isSmallBalance(threshold), false);
  assert.equal(lendingSubmissionAction("repay", threshold), "repay");

  const insufficient = status({ balances: { outstandingDebt: "0.009", creditAvailable: "0.008" } });
  assert.equal(canRepaySmallBalance(insufficient), false);
  assert.equal(lendingSubmissionAction("repay", insufficient), "repay");
  assert.equal(tokenUnits("0.000000000000000001"), 1n);
  assert.equal(tokenUnits("invalid"), 0n);
});

test("action validation preserves all governance and policy guards", () => {
  assert.deepEqual(validateAction("bridge", "1", status({ laneReady: false })), {
    ok: false,
    value: null,
    message: "Institutional lane is not ready.",
  });
  assert.equal(
    validateAction("deposit", "1", status({ risk: { accrualCatchUpRequired: true } })).message,
    "Interest accrual must be caught up by the keeper before lending actions continue.",
  );
  assert.equal(
    validateAction("borrow", "1", status({ risk: { accountDefaulted: true } })).message,
    "Borrowing is frozen after default until governed credit resolution.",
  );
  assert.equal(
    validateAction("borrow", "1", status({ risk: { borrowPaused: true } })).message,
    "New borrowing is paused by risk governance.",
  );
  assert.equal(
    validateAction("withdraw", "1", status({ risk: { collateralWithdrawalPaused: true } })).message,
    "Collateral withdrawal is paused by risk governance.",
  );
});

test("action validation uses exact 18-decimal amounts and on-chain limits", () => {
  const current = status({ balances: { outstandingDebt: "0", activeCollateral: "20" } });
  assert.deepEqual(validateAction("bridge", "0001.000000000000000001", current), {
    ok: true,
    value: "1.000000000000000001",
    message: "",
  });
  assert.equal(
    validateAction("bridge", "1.0000000000000000001", current).message,
    "Enter a decimal amount with at most 18 decimal places.",
  );
  assert.equal(validateAction("bridge", "0", current).message, "Enter an amount greater than zero.");
  assert.equal(
    validateAction("borrow", "12.000000000000000001", current).message,
    "Amount exceeds the available on-chain limit.",
  );
  assert.equal(validateAction("withdraw", "20", current).ok, true);
});

test("debt and collateral block withdrawal and settlement with precise guidance", () => {
  const regularDebt = status({ balances: { outstandingDebt: "10" } });
  assert.equal(
    validateAction("withdraw", "1", regularDebt).message,
    "Repay outstanding debt before withdrawing collateral.",
  );
  assert.equal(
    validateAction("return", "1", regularDebt).message,
    "Repay outstanding debt before settlement.",
  );

  const smallDebt = status({ balances: { outstandingDebt: "0.009" } });
  assert.equal(
    validateAction("withdraw", "1", smallDebt).message,
    "Repay the small remaining balance before withdrawing collateral.",
  );
  assert.equal(
    validateAction("return", "1", smallDebt).message,
    "Repay the small remaining balance before settlement.",
  );

  const activeCollateral = status({ balances: { outstandingDebt: "0", activeCollateral: "1" } });
  assert.equal(
    validateAction("return", "1", activeCollateral).message,
    "Withdraw lending collateral before settlement.",
  );
});

test("exact small-balance repayment returns the complete recorded debt", () => {
  const aboveThreshold = status({ balances: { outstandingDebt: "0.01", creditAvailable: "1" } });
  assert.equal(
    validateAction("repayAll", "", aboveThreshold).message,
    "The remaining debt is above the exact small-balance repayment threshold.",
  );

  const insufficient = status({ balances: { outstandingDebt: "0.009", creditAvailable: "0.008" } });
  assert.equal(
    validateAction("repayAll", "", insufficient).message,
    "Wallet bCASH balance is insufficient to repay the complete debt.",
  );

  const repayable = status({ balances: { outstandingDebt: "0.0090", creditAvailable: "0.01" } });
  assert.deepEqual(validateAction("repayAll", "", repayable), {
    ok: true,
    value: "0.0090",
    message: "",
  });
});

test("health presentation covers no-debt, danger, caution and healthy states", () => {
  assert.deepEqual(
    healthPresentation(status({ balances: { outstandingDebt: "0" } })),
    { value: "∞", label: "No debt", longLabel: "No active debt", meter: 100, tone: "safe" },
  );
  assert.deepEqual(
    healthPresentation(status({ risk: { healthFactor: "0.99" } })),
    { value: "0.99", label: "Liquidatable", longLabel: "Below threshold", meter: 18, tone: "danger" },
  );
  assert.deepEqual(
    healthPresentation(status({ risk: { healthFactor: "1.249" } })),
    { value: "1.24", label: "Watch", longLabel: "Close to threshold", meter: 38, tone: "caution" },
  );
  assert.deepEqual(
    healthPresentation(status({ risk: { healthFactor: "1.5" } })),
    { value: "1.50", label: "Healthy", longLabel: "Healthy position", meter: 66, tone: "safe" },
  );
});
