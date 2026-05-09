import { pathToFileURL } from "node:url";
import {
  DEMO_APPROVAL_ALLOWANCE,
  DENIED_AMOUNT,
  FORWARD_AMOUNT,
  approveIfNeeded,
  ensureRiskSeeded,
  openOrReuseHandshake,
  prepareStepContext,
  robustCurrentRouteStatus,
  setPhase,
  units,
} from "./demo/context.mjs";

// Warm-up prepares only reusable demo state: configuration, route readiness, and ERC-20 allowances.
// It deliberately does not deposit collateral, borrow, shock prices, liquidate, or mint voucher collateral.
export async function warmupDemoSession() {
  setPhase("warmup-prepare-context");
  const prepared = await prepareStepContext();
  const { config, ctx } = prepared;

  console.log("[warmup] Ensuring risk, oracle, lending, and policy configuration is seeded.");
  setPhase("warmup-risk-seed");
  await ensureRiskSeeded(config, ctx);

  console.log("[warmup] Opening or reusing the Bank A <-> Bank B proof-checked route.");
  setPhase("warmup-open-route");
  await openOrReuseHandshake(config, ctx);
  const routeStatus = await robustCurrentRouteStatus(config, ctx);
  if (!routeStatus.ready) {
    throw new Error("Warm-up could not confirm the Bank A <-> Bank B route is open.");
  }

  console.log("[warmup] Preparing demo token allowances.");
  setPhase("warmup-approvals");
  await approveIfNeeded(
    ctx.A.canonicalTokenUser,
    ctx.sourceUserAddress,
    config.chains.A.escrowVault,
    FORWARD_AMOUNT + DENIED_AMOUNT,
    "warmup approve source escrow"
  );
  await approveIfNeeded(
    ctx.B.voucherUser,
    ctx.destinationUserAddress,
    config.chains.B.lendingPool,
    DEMO_APPROVAL_ALLOWANCE,
    "warmup approve voucher collateral"
  );
  await approveIfNeeded(
    ctx.B.debtAdmin.connect(ctx.destinationUser),
    ctx.destinationUserAddress,
    config.chains.B.lendingPool,
    DEMO_APPROVAL_ALLOWANCE,
    "warmup approve debt repayment"
  );
  await approveIfNeeded(
    ctx.B.debtLiquidator,
    ctx.liquidatorAddress,
    config.chains.B.lendingPool,
    DEMO_APPROVAL_ALLOWANCE,
    "warmup approve liquidation repay"
  );

  console.log(
    `[warmup] Demo session is warmed up. Route is open and allowances are ready up to ${units(DEMO_APPROVAL_ALLOWANCE)} tokens.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  warmupDemoSession()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
