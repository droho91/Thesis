import {
  OUT_JS_PATH,
  OUT_JSON_PATH,
  compact,
  prepareStepContext,
  saveRuntimeConfig,
  setPhase,
  units,
} from "../context.mjs";
import { writeTracePatch } from "../trace-writer.mjs";

export async function runBorrowerCloseoutScenario(runStep) {
  setPhase("borrower-closeout-prepare");
  const prepared = await prepareStepContext();
  const { config, ctx } = prepared;
  const steps = [
    "openRoute",
    "lock",
    "finalizeForwardHeader",
    "updateForwardClient",
    "proveForwardMint",
    "depositCollateral",
    "borrow",
    "topUpRepayCash",
    "repay",
    "withdrawCollateral",
    "burn",
    "finalizeReverseHeader",
    "updateReverseClient",
    "proveReverseUnlock",
  ];

  let trace = null;
  for (const step of steps) {
    try {
      trace = await runStep(step, { prepared });
    } catch (error) {
      error.message = `Borrower closeout scenario failed at ${step}: ${error.message}`;
      throw error;
    }
  }

  setPhase("borrower-closeout-final-state");
  const [remainingDebt, remainingCollateral, userVoucher, sourceBalance, escrowed] = await Promise.all([
    ctx.B.lendingPoolAdmin.debtBalance(ctx.destinationUserAddress),
    ctx.B.lendingPoolAdmin.collateralBalance(ctx.destinationUserAddress),
    ctx.B.voucherAdmin.balanceOf(ctx.destinationUserAddress),
    ctx.A.canonicalTokenAdmin.balanceOf(ctx.sourceUserAddress),
    ctx.A.escrow.totalEscrowed(),
  ]);

  trace = await writeTracePatch(
    config,
    ctx,
    {
      scenario: {
        mode: "borrower-closeout",
        description:
          "Borrower lifecycle: bridge collateral, borrow, repay, withdraw voucher collateral, burn voucher, and unlock origin collateral.",
        completed: remainingDebt === 0n && remainingCollateral === 0n,
      },
      risk: {
        completed: remainingDebt === 0n && remainingCollateral === 0n,
        debtAfterRepay: units(remainingDebt),
        collateralAfterWithdrawal: units(remainingCollateral),
      },
      reverse: {
        finalSourceBalance: units(sourceBalance),
        finalEscrowed: units(escrowed),
      },
    },
    {
      phase: "borrower-closeout-complete",
      label: "Completed borrower closeout lifecycle",
      summary:
        `Borrower repaid debt, withdrew collateral, burned ${trace?.reverse?.amount || units(userVoucher)} vA, ` +
        "and completed the reverse proof for Bank A unlock.",
    }
  );

  config.status = {
    ...(config.status || {}),
    proofCheckedHandshakeOpened: true,
    lastDemoRunAt: trace.generatedAt,
    lastDemoScenario: "borrower-closeout",
  };
  config.latestTrace = {
    json: OUT_JSON_PATH,
    js: OUT_JS_PATH,
  };
  await saveRuntimeConfig(config);

  console.log("=== Borrower closeout flow ===");
  console.log(`[borrower] debt=${units(remainingDebt)} bCASH, deposited collateral=${units(remainingCollateral)} vA`);
  console.log(`[reverse] packet ${compact(trace.reverse?.packetId)} unlocked source balance ${units(sourceBalance)} aBANK`);
  console.log(`[ui] wrote demo trace to ${OUT_JSON_PATH}`);
  return trace;
}
