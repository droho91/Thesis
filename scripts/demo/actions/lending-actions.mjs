import {
  BORROW_AMOUNT,
  BORROW_AMOUNT_CONFIGURED,
  FORWARD_AMOUNT,
  REPAY_AMOUNT,
  WITHDRAW_AMOUNT,
  amountFromTrace,
  ensureRiskSeeded,
  readExistingTrace,
  repayCloseBuffer,
  repayCloseTarget,
  setPhase,
  txOptions,
  txStep,
  units,
} from "../context.mjs";
import { writeTracePatch } from "../trace-writer.mjs";

export async function depositCollateralStep({ config, ctx }) {
  setPhase("step-deposit-collateral");
  await ensureRiskSeeded(config, ctx);
  const trace = await readExistingTrace();
  const desiredCollateral = amountFromTrace(trace.forward, FORWARD_AMOUNT);
  const balance = await ctx.B.voucherAdmin.balanceOf(ctx.destinationUserAddress);
  if (balance < desiredCollateral) throw new Error("Bank B user needs a proven voucher before depositing collateral.");
  const currentCollateral = await ctx.B.lendingPoolAdmin.collateralBalance(ctx.destinationUserAddress);
  if (currentCollateral < desiredCollateral) {
    const depositAmount = desiredCollateral - currentCollateral;
    await txStep("step approve voucher collateral", () =>
      ctx.B.voucherUser.approve(config.chains.B.lendingPool, depositAmount, txOptions())
    );
    await txStep("step deposit collateral", () =>
      ctx.B.lendingPoolUser.depositCollateral(depositAmount, txOptions())
    );
  }
  const collateral = await ctx.B.lendingPoolAdmin.collateralBalance(ctx.destinationUserAddress);
  return writeTracePatch(
    config,
    ctx,
    { risk: { collateralDeposited: units(collateral) } },
    {
      phase: "collateral-deposited",
      label: "Deposited proven voucher collateral",
      summary: `Bank B lending pool now holds ${units(collateral)} vA as collateral.`,
    }
  );
}

export async function borrowStep({ config, ctx }) {
  setPhase("step-borrow");
  await ensureRiskSeeded(config, ctx);
  const debt = await ctx.B.lendingPoolAdmin.debtBalance(ctx.destinationUserAddress);
  const borrowDelta = BORROW_AMOUNT_CONFIGURED ? BORROW_AMOUNT : BORROW_AMOUNT > debt ? BORROW_AMOUNT - debt : 0n;
  if (borrowDelta > 0n) {
    const availableBeforeBorrow = await ctx.B.lendingPoolAdmin.availableToBorrow(ctx.destinationUserAddress);
    if (availableBeforeBorrow < borrowDelta) {
      const collateral = await ctx.B.lendingPoolAdmin.collateralBalance(ctx.destinationUserAddress);
      throw new Error(
        `BORROW_LIMIT: available ${units(availableBeforeBorrow)} bCASH, need ${units(borrowDelta)}; ` +
          `collateral=${units(collateral)} vA, existingDebt=${units(debt)} bCASH.`
      );
    }
    await txStep("step borrow debt asset", () => ctx.B.lendingPoolUser.borrow(borrowDelta, txOptions()));
  }
  const debtAfterBorrow = await ctx.B.lendingPoolAdmin.debtBalance(ctx.destinationUserAddress);
  const healthBeforeShock = await ctx.B.lendingPoolAdmin.healthFactorBps(ctx.destinationUserAddress);
  const maxBorrowBefore = await ctx.B.lendingPoolAdmin.maxBorrow(ctx.destinationUserAddress);
  return writeTracePatch(
    config,
    ctx,
    {
      risk: {
        borrowed: units(debtAfterBorrow),
        maxBorrowBefore: units(maxBorrowBefore),
        healthBeforeShockBps: healthBeforeShock.toString(),
      },
    },
    {
      phase: "borrowed",
      label: "Borrowed bCASH against proven collateral",
      summary: `Borrowed position is ${units(debtAfterBorrow)} bCASH.`,
    }
  );
}

export async function repayStep({ config, ctx }) {
  setPhase("step-repay");
  const debt = await ctx.B.lendingPoolAdmin.debtBalance(ctx.destinationUserAddress);
  let repayAmount = 0n;
  let requestedRepayAmount = 0n;
  let actualPayment = 0n;
  let closeBuffer = 0n;
  let repayTxHash = null;
  if (debt > 0n) {
    requestedRepayAmount = REPAY_AMOUNT ?? debt;
    closeBuffer = repayCloseBuffer(debt);
    const closeDebt = REPAY_AMOUNT == null || requestedRepayAmount >= debt || debt - requestedRepayAmount <= closeBuffer;
    repayAmount = closeDebt ? debt + closeBuffer : requestedRepayAmount;
    if (!closeDebt && repayAmount > debt) {
      throw new Error(`REPAY_LIMIT: outstanding debt is ${units(debt)} bCASH, requested ${units(repayAmount)}.`);
    }
    const debtBalance = await ctx.B.debtAdmin.balanceOf(ctx.destinationUserAddress);
    const requiredBalance = closeDebt ? debt : repayAmount;
    if (debtBalance < requiredBalance) throw new Error("Destination user does not have enough bCASH to repay the requested amount.");
    const debtUser = ctx.B.debtAdmin.connect(ctx.destinationUser);
    await txStep("step approve debt repayment", () => debtUser.approve(config.chains.B.lendingPool, repayAmount, txOptions()));
    const repayReceipt = await txStep("step repay debt", () => ctx.B.lendingPoolUser.repay(repayAmount, txOptions()));
    repayTxHash = repayReceipt.hash;
    const debtBalanceAfter = await ctx.B.debtAdmin.balanceOf(ctx.destinationUserAddress);
    actualPayment = debtBalance > debtBalanceAfter ? debtBalance - debtBalanceAfter : 0n;
  }
  const remainingDebt = await ctx.B.lendingPoolAdmin.debtBalance(ctx.destinationUserAddress);
  return writeTracePatch(
    config,
    ctx,
    {
      risk: {
        repaid: REPAY_AMOUNT != null || remainingDebt === 0n,
        debtBeforeRepay: units(debt),
        repayRequestedAmount: units(requestedRepayAmount),
        repayCloseBuffer: units(closeBuffer),
        repayAmount: units(actualPayment),
        debtAfterRepay: units(remainingDebt),
        repayTxHash,
      },
    },
    {
      phase: "repaid",
      label: "Repaid bCASH debt",
      summary: `Repaid bCASH debt; remaining debt is ${units(remainingDebt)} bCASH.`,
    }
  );
}

export async function topUpRepayCashStep({ config, ctx }) {
  setPhase("step-top-up-repay-cash");
  const debt = await ctx.B.lendingPoolAdmin.debtBalance(ctx.destinationUserAddress);
  if (debt === 0n) {
    throw new Error("There is no active debt to fund for repayment.");
  }
  const debtBalance = await ctx.B.debtAdmin.balanceOf(ctx.destinationUserAddress);
  const targetBalance = repayCloseTarget(debt);
  if (debtBalance < targetBalance) {
    await txStep("step mint demo repayment cash", () =>
      ctx.B.debtAdmin.mint(ctx.destinationUserAddress, targetBalance - debtBalance, txOptions())
    );
  }
  const updatedBalance = await ctx.B.debtAdmin.balanceOf(ctx.destinationUserAddress);
  return writeTracePatch(
    config,
    ctx,
    {
      risk: {
        demoRepayCashTarget: units(targetBalance),
        demoRepayCashBuffer: units(targetBalance - debt),
        demoRepayCashFunded: units(updatedBalance),
        demoRepayCashShortfall: units(updatedBalance >= targetBalance ? 0n : targetBalance - updatedBalance),
      },
    },
    {
      phase: "repay-cash-funded",
      label: "Added demo bCASH for repayment",
      summary:
        `Demo account now has ${units(updatedBalance)} bCASH available for repayment, ` +
        `including a ${units(targetBalance - debt)} bCASH close-debt buffer.`,
    }
  );
}

export async function withdrawCollateralStep({ config, ctx }) {
  setPhase("step-withdraw-collateral");
  const collateral = await ctx.B.lendingPoolAdmin.collateralBalance(ctx.destinationUserAddress);
  let withdrawAmount = 0n;
  let withdrawTxHash = null;
  if (collateral > 0n) {
    withdrawAmount = WITHDRAW_AMOUNT ?? collateral;
    if (withdrawAmount > collateral) {
      throw new Error(`WITHDRAW_LIMIT: deposited collateral is ${units(collateral)} vA, requested ${units(withdrawAmount)}.`);
    }
    const withdrawReceipt = await txStep("step withdraw collateral", () =>
      ctx.B.lendingPoolUser.withdrawCollateral(withdrawAmount, txOptions())
    );
    withdrawTxHash = withdrawReceipt.hash;
  }
  const remainingCollateral = await ctx.B.lendingPoolAdmin.collateralBalance(ctx.destinationUserAddress);
  return writeTracePatch(
    config,
    ctx,
    {
      risk: {
        collateralWithdrawn: WITHDRAW_AMOUNT != null || remainingCollateral === 0n,
        completed: remainingCollateral === 0n,
        collateralBeforeWithdrawal: units(collateral),
        withdrawAmount: units(withdrawAmount),
        collateralAfterWithdrawal: units(remainingCollateral),
        withdrawTxHash,
      },
    },
    {
      phase: "collateral-withdrawn",
      label: "Withdrew voucher collateral",
      summary: `Withdrew voucher collateral; ${units(remainingCollateral)} vA remains deposited.`,
    }
  );
}
