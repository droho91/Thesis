import { prepareStepContext, requireDemoSafetyModeAllows } from "./context.mjs";
import { openRouteStep } from "./actions/route-actions.mjs";
import {
  finalizeForwardHeaderStep,
  lockStep,
  proveForwardMintStep,
  replayForwardStep,
  updateForwardClientStep,
} from "./actions/forward-bridge-actions.mjs";
import {
  borrowStep,
  depositCollateralStep,
  repayStep,
  topUpRepayCashStep,
  withdrawCollateralStep,
} from "./actions/lending-actions.mjs";
import { executeLiquidationStep, simulatePriceShockStep } from "./actions/liquidation-actions.mjs";
import {
  burnStep,
  finalizeReverseHeaderStep,
  proveReverseUnlockStep,
  settleSeizedVoucherStep,
  updateReverseClientStep,
} from "./actions/reverse-bridge-actions.mjs";
import { executeTimeoutRefundStep, verifyTimeoutAbsenceStep } from "./actions/timeout-actions.mjs";
import { freezeClientStep, recoverClientStep } from "./actions/safety-actions.mjs";
import { runBorrowerCloseoutScenario } from "./scenarios/borrower-closeout.mjs";
import { runRiskScenario } from "./scenarios/risk-lifecycle.mjs";

const ACTIONS = new Map([
  ["openRoute", openRouteStep],
  ["lock", lockStep],
  ["finalizeForwardHeader", finalizeForwardHeaderStep],
  ["updateForwardClient", updateForwardClientStep],
  ["proveForwardMint", proveForwardMintStep],
  ["replayForward", replayForwardStep],
  ["depositCollateral", depositCollateralStep],
  ["borrow", borrowStep],
  ["repay", repayStep],
  ["topUpRepayCash", topUpRepayCashStep],
  ["withdrawCollateral", withdrawCollateralStep],
  ["simulatePriceShock", simulatePriceShockStep],
  ["executeLiquidation", executeLiquidationStep],
  ["settleSeizedVoucher", settleSeizedVoucherStep],
  ["burn", burnStep],
  ["finalizeReverseHeader", finalizeReverseHeaderStep],
  ["updateReverseClient", updateReverseClientStep],
  ["proveReverseUnlock", proveReverseUnlockStep],
  ["executeTimeoutRefund", executeTimeoutRefundStep],
  ["verifyTimeoutAbsence", verifyTimeoutAbsenceStep],
  ["freezeClient", freezeClientStep],
  ["recoverClient", recoverClientStep],
]);

export const KNOWN_ACTIONS = Object.freeze([
  "fullFlow",
  "riskLifecycle",
  "borrowerCloseout",
  ...ACTIONS.keys(),
]);

export async function runDemoStep(action, options = {}) {
  const scenarioAction = action === "fullFlow" || action === "riskLifecycle" || action === "borrowerCloseout";
  const handler = ACTIONS.get(action);
  if (!scenarioAction && !handler) {
    throw new Error(`Unknown demo action: ${action}. Known actions: ${KNOWN_ACTIONS.join(", ")}`);
  }

  const prepared = options.prepared ?? await prepareStepContext();
  const { ctx, sourceChainId } = prepared;
  await requireDemoSafetyModeAllows(action, ctx, sourceChainId);

  if (action === "fullFlow") {
    return runRiskScenario();
  }

  if (action === "riskLifecycle") {
    return runRiskScenario();
  }

  if (action === "borrowerCloseout") {
    return runBorrowerCloseoutScenario(runDemoStep);
  }

  return handler(prepared);
}

export function scenarioEntrypoint(scenario) {
  const normalized = String(scenario || "risk").toLowerCase();
  if (["borrower", "borrower-closeout", "closeout"].includes(normalized)) {
    return () => runBorrowerCloseoutScenario(runDemoStep);
  }
  if (["risk", "risk-liquidation", "liquidation"].includes(normalized)) return runRiskScenario;
  throw new Error(`Unknown demo scenario: ${scenario}. Expected risk or borrower.`);
}

export function helpText() {
  return [
    "Usage: node scripts/run-lending-demo.mjs [--scenario risk|borrower] [--step <action>]",
    "",
    "Scenarios:",
    "  risk      Full risk/liquidation lifecycle",
    "  borrower  Borrower closeout lifecycle",
    "",
    `Actions: ${KNOWN_ACTIONS.join(", ")}`,
  ].join("\n");
}
