import { canRepaySmallBalance } from "./lending-domain.js";
import { compactAmount } from "./ui-presentation.js";

export const STAGE_ORDER = Object.freeze(["prepare", "transfer", "lend", "manage", "return", "review"]);
export const ACTION_TAB = Object.freeze({
  bridge: "transfer",
  deposit: "lending",
  borrow: "lending",
  repay: "lending",
  repayAll: "lending",
  withdraw: "lending",
  return: "return",
});

const ACTION_ICONS = Object.freeze({
  bridge: "arrow-right",
  deposit: "archive",
  borrow: "banknote",
  repay: "hand-coins",
  repayAll: "circle-dollar-sign",
  withdraw: "download",
  return: "rotate-ccw",
});

const OPERATION_NAMES = Object.freeze({
  bridge: "Collateral lock and voucher issuance",
  deposit: "Collateral activation",
  borrow: "bCASH borrowing",
  repay: "Debt repayment",
  repayAll: "Complete debt repayment",
  withdraw: "Collateral withdrawal",
  return: "Collateral settlement",
});

export function actionStage(action) {
  if (action === "bridge") return "transfer";
  if (["deposit", "borrow"].includes(action)) return "lend";
  if (["repay", "repayAll", "withdraw"].includes(action)) return "manage";
  if (action === "return") return "return";
  return "review";
}

export function actionIcon(action) {
  return ACTION_ICONS[action] || "circle-check";
}

export function operationName(action) {
  return OPERATION_NAMES[action] || "Institutional operation";
}

export function operationProgressCopy(action) {
  return ["bridge", "return"].includes(action)
    ? "Waiting for the configured checkpoint delay, attestor quorum and cross-chain acknowledgement."
    : "Submitting the policy-checked Bank B transaction.";
}

export function recommendationFor(status) {
  const next = status.workflow?.nextAction;
  const recommendations = {
    bridge: { image: "guide", title: "Lock aBANK for voucher issuance", copy: "Canonical aBANK remains in governed escrow on Bank A while Bank B issues vA after proof checks.", action: "bridge", button: "Open transfer" },
    deposit: { image: "guide", title: "Activate received collateral", copy: "Proof-issued vA is available on Bank B and can enter the lending position.", action: "deposit", button: "Open lending" },
    borrow: { image: "guide", title: "Borrowing capacity is available", copy: `${compactAmount(status.risk.availableBorrow)} bCASH remains within policy and liquidity limits.`, action: "borrow", button: "Open borrowing" },
    repay: canRepaySmallBalance(status)
      ? { image: "caution", title: "Repay exact remaining balance", copy: "A small accrued bCASH balance remains and will be collected in full.", action: "repayAll", button: "Repay full balance" }
      : { image: "caution", title: "Manage outstanding debt", copy: `${compactAmount(status.balances.outstandingDebt)} bCASH remains outstanding on Bank B.`, action: "repay", button: "Open repayment" },
    withdraw: { image: "guide", title: "Release active collateral", copy: "The debt position is clear and collateral can leave the lending pool.", action: "withdraw", button: "Open withdrawal" },
    return: { image: "success", title: "Settle collateral on Bank A", copy: "Free voucher can now be burned for canonical custody release.", action: "return", button: "Open settlement" },
  };
  return recommendations[next] || { image: "neutral", title: "Institutional state is synchronized", copy: "Review runtime evidence and recent transaction identifiers.", action: "evidence", button: "Open evidence" };
}
