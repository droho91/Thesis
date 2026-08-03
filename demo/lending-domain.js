import {
  TOKEN_SCALE,
  formatTokenRatio,
  minTokenAmount,
  normalizeTokenAmount,
  parseTokenUnits,
  tokenRatioMeterPercent,
  tryTokenUnits,
} from "./token-amount.js";

const SMALL_BALANCE_THRESHOLD = parseTokenUnits("0.01");
const LENDING_ACTIONS = Object.freeze(["deposit", "borrow", "repay", "repayAll", "withdraw"]);

export const LENDING_MODES = Object.freeze({
  deposit: Object.freeze({
    label: "Voucher amount",
    unit: "vA",
    limitLabel: "Available voucher",
    limit: (status) => status?.balances?.voucherAvailable || "0",
    button: "Activate collateral",
    icon: "archive",
  }),
  borrow: Object.freeze({
    label: "Borrow amount",
    unit: "bCASH",
    limitLabel: "Borrowing capacity",
    limit: (status) => status?.risk?.availableBorrow || "0",
    button: "Borrow from Bank B",
    icon: "banknote",
  }),
  repay: Object.freeze({
    label: "Repayment amount",
    unit: "bCASH",
    limitLabel: "Repayable from wallet",
    limit: (status) => minTokenAmount(
      status?.balances?.outstandingDebt || "0",
      status?.balances?.creditAvailable || "0",
    ),
    button: "Repay debt",
    icon: "hand-coins",
  }),
  withdraw: Object.freeze({
    label: "Collateral amount",
    unit: "vA",
    limitLabel: "Withdrawable collateral",
    limit: (status) => tokenUnits(status?.balances?.outstandingDebt) > 0n
      ? "0"
      : status?.balances?.activeCollateral || "0",
    button: "Withdraw collateral",
    icon: "download",
  }),
});

export function tokenUnits(value) {
  return tryTokenUnits(value ?? "0") ?? 0n;
}

export function isSmallBalance(status) {
  const debt = tokenUnits(status?.balances?.outstandingDebt);
  return debt > 0n && debt < SMALL_BALANCE_THRESHOLD;
}

export function canRepaySmallBalance(status) {
  return isSmallBalance(status)
    && tokenUnits(status?.balances?.creditAvailable) >= tokenUnits(status?.balances?.outstandingDebt);
}

export function lendingSubmissionAction(mode, status) {
  return mode === "repay" && canRepaySmallBalance(status) ? "repayAll" : mode;
}

export function validateAction(action, rawValue, status) {
  if (!status?.laneReady) return invalid("Institutional lane is not ready.");
  if (LENDING_ACTIONS.includes(action) && status.risk.accrualCatchUpRequired) {
    return invalid("Interest accrual must be caught up by the keeper before lending actions continue.");
  }
  if (action === "borrow" && status.risk.accountDefaulted) {
    return invalid("Borrowing is frozen after default until governed credit resolution.");
  }
  if (action === "borrow" && status.risk.borrowPaused) {
    return invalid("New borrowing is paused by risk governance.");
  }
  if (action === "withdraw" && status.risk.collateralWithdrawalPaused) {
    return invalid("Collateral withdrawal is paused by risk governance.");
  }
  if (action === "repayAll") {
    if (!isSmallBalance(status)) return invalid("The remaining debt is above the exact small-balance repayment threshold.");
    if (!canRepaySmallBalance(status)) return invalid("Wallet bCASH balance is insufficient to repay the complete debt.");
    return { ok: true, value: status.balances.outstandingDebt, message: "" };
  }

  const value = tryTokenUnits(rawValue);
  if (value == null) return invalid("Enter a decimal amount with at most 18 decimal places.");
  if (value <= 0n) return invalid("Enter an amount greater than zero.");

  const debt = tokenUnits(status.balances.outstandingDebt);
  const collateral = tokenUnits(status.balances.activeCollateral);
  const limits = {
    bridge: tokenUnits(status.balances.canonicalAvailable),
    deposit: tokenUnits(status.balances.voucherAvailable),
    borrow: tokenUnits(status.risk.availableBorrow),
    repay: minimumUnits(debt, tokenUnits(status.balances.creditAvailable)),
    withdraw: debt > 0n ? 0n : collateral,
    return: debt > 0n || collateral > 0n ? 0n : tokenUnits(status.balances.voucherAvailable),
  };

  if (action === "withdraw" && debt > 0n) {
    return invalid(isSmallBalance(status) ? "Repay the small remaining balance before withdrawing collateral." : "Repay outstanding debt before withdrawing collateral.");
  }
  if (action === "return" && debt > 0n) {
    return invalid(isSmallBalance(status) ? "Repay the small remaining balance before settlement." : "Repay outstanding debt before settlement.");
  }
  if (action === "return" && collateral > 0n) return invalid("Withdraw lending collateral before settlement.");
  if (value > (limits[action] || 0n)) return invalid("Amount exceeds the available on-chain limit.");
  return { ok: true, value: normalizeTokenAmount(rawValue), message: "" };
}

export function healthPresentation(status) {
  const debt = tokenUnits(status?.balances?.outstandingDebt);
  if (debt === 0n) {
    return { value: "∞", label: "No debt", longLabel: "No active debt", meter: 100, tone: "safe" };
  }

  const factor = tokenUnits(status?.risk?.healthFactor);
  if (factor < TOKEN_SCALE) {
    return { value: formatTokenRatio(status?.risk?.healthFactor), label: "Liquidatable", longLabel: "Below threshold", meter: 18, tone: "danger" };
  }
  if (factor < TOKEN_SCALE * 5n / 4n) {
    return { value: formatTokenRatio(status?.risk?.healthFactor), label: "Watch", longLabel: "Close to threshold", meter: 38, tone: "caution" };
  }
  return {
    value: formatTokenRatio(status?.risk?.healthFactor),
    label: "Healthy",
    longLabel: "Healthy position",
    meter: tokenRatioMeterPercent(status?.risk?.healthFactor),
    tone: "safe",
  };
}

function minimumUnits(left, right) {
  return left < right ? left : right;
}

function invalid(message) {
  return { ok: false, value: null, message };
}
