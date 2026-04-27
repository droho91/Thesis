import {
  LIQUIDATION_REPAY,
  LIQUIDATION_REPAY_CONFIGURED,
  SHOCKED_VOUCHER_PRICE_E18,
  ensureRiskSeeded,
  previewField,
  setPhase,
  txOptions,
  txStep,
  units,
} from "../context.mjs";
import { writeTracePatch } from "../trace-writer.mjs";

export async function simulatePriceShockStep({ config, ctx }) {
  setPhase("step-price-shock");
  await ensureRiskSeeded(config, ctx);
  const healthBeforeShock = await ctx.B.lendingPoolAdmin.healthFactorBps(ctx.destinationUserAddress);
  await txStep("step shock voucher oracle price", () =>
    ctx.B.oracle.setPrice(config.chains.B.voucherToken, SHOCKED_VOUCHER_PRICE_E18, txOptions())
  );
  const [healthAfterShock, liquidatableAfterShock, maxLiquidationRepay, liquidationPreview] = await Promise.all([
    ctx.B.lendingPoolAdmin.healthFactorBps(ctx.destinationUserAddress),
    ctx.B.lendingPoolAdmin.isLiquidatable(ctx.destinationUserAddress),
    ctx.B.lendingPoolAdmin.maxLiquidationRepay(ctx.destinationUserAddress),
    (async () => {
      const repay = await ctx.B.lendingPoolAdmin.maxLiquidationRepay(ctx.destinationUserAddress);
      return ctx.B.lendingPoolAdmin.previewLiquidation(ctx.destinationUserAddress, repay);
    })(),
  ]);
  const previewSeized = previewField(liquidationPreview, "seizedCollateral", 2);
  return writeTracePatch(
    config,
    ctx,
    {
      risk: {
        shockedVoucherPriceE18: SHOCKED_VOUCHER_PRICE_E18.toString(),
        healthBeforeShockBps: healthBeforeShock.toString(),
        healthAfterShockBps: healthAfterShock.toString(),
        liquidatableAfterShock,
        maxLiquidationRepay: units(maxLiquidationRepay),
        seizedCollateralPreview: units(previewSeized),
      },
    },
    {
      phase: "price-shocked",
      label: "Simulated governed oracle price shock",
      summary:
        `Voucher collateral price is now ${units(SHOCKED_VOUCHER_PRICE_E18)} bCASH; ` +
        `position is ${liquidatableAfterShock ? "liquidatable" : "not liquidatable"}.`,
    }
  );
}

export async function executeLiquidationStep({ config, ctx }) {
  setPhase("step-liquidation");
  const liquidatable = await ctx.B.lendingPoolAdmin.isLiquidatable(ctx.destinationUserAddress);
  if (!liquidatable) {
    throw new Error("Position is not liquidatable at the current oracle price. Run Simulate Oracle Shock first.");
  }

  const [debtBefore, collateralBefore, maxLiquidationRepay, reservesBefore, badDebtBefore] = await Promise.all([
    ctx.B.lendingPoolAdmin.debtBalance(ctx.destinationUserAddress),
    ctx.B.lendingPoolAdmin.collateralBalance(ctx.destinationUserAddress),
    ctx.B.lendingPoolAdmin.maxLiquidationRepay(ctx.destinationUserAddress),
    ctx.B.lendingPoolAdmin.totalReserves(),
    ctx.B.lendingPoolAdmin.totalBadDebt(),
  ]);
  const requestedRepayAmount = LIQUIDATION_REPAY_CONFIGURED ? LIQUIDATION_REPAY : maxLiquidationRepay;
  const liquidationPreview = await ctx.B.lendingPoolAdmin.previewLiquidation(ctx.destinationUserAddress, requestedRepayAmount);
  const repayAmount = previewField(liquidationPreview, "actualRepayAmount", 1);
  if (repayAmount === 0n) throw new Error("No debt is available for liquidation.");
  const previewSeized = previewField(liquidationPreview, "seizedCollateral", 2);
  const liquidatorBalance = await ctx.B.debtAdmin.balanceOf(ctx.liquidatorAddress);
  if (liquidatorBalance < repayAmount) {
    await txStep("step fund liquidator repay balance", () =>
      ctx.B.debtAdmin.mint(ctx.liquidatorAddress, repayAmount - liquidatorBalance, txOptions())
    );
  }
  await txStep("step approve liquidation repay", () =>
    ctx.B.debtLiquidator.approve(config.chains.B.lendingPool, repayAmount, txOptions())
  );
  const liquidationReceipt = await txStep("step liquidate unhealthy position", () =>
    ctx.B.lendingPoolLiquidator.liquidate(ctx.destinationUserAddress, requestedRepayAmount, txOptions())
  );
  const [debtAfter, collateralAfter, reservesAfter, badDebtAfter, liquidatorVoucherBalance] = await Promise.all([
    ctx.B.lendingPoolAdmin.debtBalance(ctx.destinationUserAddress),
    ctx.B.lendingPoolAdmin.collateralBalance(ctx.destinationUserAddress),
    ctx.B.lendingPoolAdmin.totalReserves(),
    ctx.B.lendingPoolAdmin.totalBadDebt(),
    ctx.B.voucherAdmin.balanceOf(ctx.liquidatorAddress),
  ]);
  const badDebtWrittenOff = debtBefore > repayAmount + debtAfter ? debtBefore - repayAmount - debtAfter : 0n;
  const reservesUsed = reservesBefore > reservesAfter ? reservesBefore - reservesAfter : 0n;
  const supplierLoss = badDebtAfter > badDebtBefore ? badDebtAfter - badDebtBefore : 0n;

  return writeTracePatch(
    config,
    ctx,
    {
      risk: {
        liquidationRepaid: units(repayAmount),
        liquidationRequestedRepay: units(requestedRepayAmount),
        liquidationTxHash: liquidationReceipt.hash,
        seizedCollateral: units(previewSeized),
        collateralBeforeLiquidation: units(collateralBefore),
        debtBeforeLiquidation: units(debtBefore),
        debtAfterLiquidation: units(debtAfter),
        collateralAfterLiquidation: units(collateralAfter),
        reservesAfterLiquidation: units(reservesAfter),
        badDebtAfterLiquidation: units(badDebtAfter),
        badDebtWrittenOff: units(badDebtWrittenOff),
        reservesUsed: units(reservesUsed),
        supplierLoss: units(supplierLoss),
        liquidatorVoucherBalance: units(liquidatorVoucherBalance),
      },
    },
    {
      phase: "liquidated",
      label: "Executed authorized liquidation",
      summary:
        `Liquidator repaid ${units(repayAmount)} bCASH and seized ${units(previewSeized)} vA; ` +
        `remaining debt is ${units(debtAfter)} bCASH.`,
    }
  );
}
