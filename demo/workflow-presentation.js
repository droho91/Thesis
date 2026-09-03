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
    bridge: {
      image: "guide",
      title: "Transfer to Bank B",
      copy: "Lock aBANK and issue proof-backed vA.",
      explanation: "Bank A escrows aBANK. Bank B issues vA only after finality, attestor quorum and proof verification.",
      action: "bridge",
      button: "Open transfer",
    },
    deposit: {
      image: "guide",
      title: "Activate collateral",
      copy: "Deposit available vA into lending.",
      explanation: "Only proof-issued vA can enter the Bank B lending position.",
      action: "deposit",
      button: "Open lending",
    },
    borrow: {
      image: "guide",
      title: "Borrow bCASH",
      copy: `${compactAmount(status.risk.availableBorrow)} bCASH available.`,
      explanation: "The recommendation remains within collateral, credit and pool-liquidity limits.",
      action: "borrow",
      button: "Open borrowing",
    },
    repay: canRepaySmallBalance(status)
      ? {
          image: "caution",
          title: "Clear remaining debt",
          copy: "Repay the exact accrued balance.",
          explanation: "The exact accrued balance clears residual debt without leaving an unusable remainder.",
          action: "repayAll",
          button: "Repay full balance",
        }
      : {
          image: "caution",
          title: "Repay debt",
          copy: `${compactAmount(status.balances.outstandingDebt)} bCASH outstanding.`,
          explanation: "Reducing outstanding debt improves the position's health and available capacity.",
          action: "repay",
          button: "Open repayment",
        },
    withdraw: {
      image: "guide",
      title: "Withdraw collateral",
      copy: "Debt is clear and collateral is available.",
      explanation: "Withdrawal is available because no debt blocks collateral release.",
      action: "withdraw",
      button: "Open withdrawal",
    },
    return: {
      image: "success",
      title: "Settle on Bank A",
      copy: "Burn vA and release aBANK.",
      explanation: "Bank B burns vA before Bank A releases the corresponding escrowed aBANK.",
      action: "return",
      button: "Open settlement",
    },
  };
  return recommendations[next] || {
    image: "neutral",
    title: "Review evidence",
    copy: "Runtime state is synchronized.",
    explanation: "The evidence view records provenance, security checks and measured settlement results.",
    action: "evidence",
    button: "Open evidence",
  };
}
