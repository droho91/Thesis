export const STAGE_ORDER = Object.freeze(["prepare", "transfer", "lend", "manage", "return", "review"]);
const ACTION_ICONS = Object.freeze({
  bridge: "arrow-right",
  deposit: "lock-keyhole",
  borrow: "banknote",
  repay: "hand-coins",
  repayAll: "circle-dollar-sign",
  withdraw: "arrow-up-right",
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
