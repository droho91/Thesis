import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ethers } from "ethers";
import {
  afterLiquidationState,
  healthFactorFor,
  normalizeTraceForUi,
  resolveShockPreviewPriceE18,
  riskPolicySnapshot,
} from "./demo-read-model.mjs";

const e18 = (value) => ethers.parseUnits(value, 18);

function actionBlock(source, action) {
  const start = source.indexOf(`if (action === "${action}")`);
  assert.notEqual(start, -1, `${action} action block should exist`);
  const next = source.indexOf("\n  if (action ===", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

const demoRunner = await readFile(resolve(process.cwd(), "scripts", "run-lending-demo.mjs"), "utf8");
const repayBlock = actionBlock(demoRunner, "repay");
assert.match(repayBlock, /debtBeforeRepay/, "repay should record debtBeforeRepay");
assert.match(repayBlock, /debtAfterRepay/, "repay should record debtAfterRepay");
assert.match(repayBlock, /repayAmount/, "repay should record repayAmount");
assert.match(repayBlock, /repayTxHash/, "repay should record repayTxHash");
assert.doesNotMatch(repayBlock, /debtAfterLiquidation/, "repay must not write debtAfterLiquidation");
assert.doesNotMatch(repayBlock, /collateralAfterLiquidation/, "repay must not write collateralAfterLiquidation");
assert.doesNotMatch(repayBlock, /badDebtWrittenOff|reservesUsed|supplierLoss/, "repay must not write liquidation loss fields");

const withdrawBlock = actionBlock(demoRunner, "withdrawCollateral");
assert.match(withdrawBlock, /collateralBeforeWithdrawal/, "withdraw should record collateralBeforeWithdrawal");
assert.match(withdrawBlock, /collateralAfterWithdrawal/, "withdraw should record collateralAfterWithdrawal");
assert.match(withdrawBlock, /withdrawAmount/, "withdraw should record withdrawAmount");
assert.match(withdrawBlock, /withdrawTxHash/, "withdraw should record withdrawTxHash");
assert.doesNotMatch(withdrawBlock, /debtAfterLiquidation/, "withdraw must not write debtAfterLiquidation");
assert.doesNotMatch(withdrawBlock, /collateralAfterLiquidation/, "withdraw must not write collateralAfterLiquidation");
assert.doesNotMatch(withdrawBlock, /badDebtWrittenOff|reservesUsed|supplierLoss/, "withdraw must not write liquidation loss fields");

const demoHtml = await readFile(resolve(process.cwd(), "demo", "index.html"), "utf8");
const proofInspectorHeadings = demoHtml.match(/<h2>Proof inspector<\/h2>/g) || [];
assert.equal(proofInspectorHeadings.length, 1, "Proof inspector heading should appear exactly once");
assert.match(demoHtml, /data-workflow-step="return"/, "borrower workflow should expose an explicit return/settle step");
assert.match(demoHtml, /data-workflow-panel="return redeem"/, "redeem panel should be reachable from the return/settle step");

assert.match(demoRunner, /runBorrowerCloseoutScenario/, "demo runner should include a borrower closeout lifecycle");
assert.match(demoRunner, /--scenario/, "demo runner should support explicit scenario selection");

const traceShock = resolveShockPreviewPriceE18({
  traceRisk: { shockedVoucherPriceE18: e18("0.3").toString() },
  currentCollateralPrice: e18("2"),
  initialCollateralPrice: e18("2").toString(),
  envShockPrice: "0.5",
});
assert.equal(traceShock, e18("0.3"), "trace risk shock price must override parent process default");

const liveOracleShock = resolveShockPreviewPriceE18({
  traceRisk: {},
  currentCollateralPrice: e18("0.3"),
  initialCollateralPrice: e18("2").toString(),
  envShockPrice: "0.5",
});
assert.equal(liveOracleShock, e18("0.3"), "shocked oracle price must be used when trace is missing");

const envShock = resolveShockPreviewPriceE18({
  traceRisk: {},
  currentCollateralPrice: e18("2"),
  initialCollateralPrice: e18("2").toString(),
  envShockPrice: "0.4",
});
assert.equal(envShock, e18("0.4"), "env shock price should be used before default fallback");

const defaultShock = resolveShockPreviewPriceE18({
  traceRisk: {},
  currentCollateralPrice: e18("2"),
  initialCollateralPrice: e18("2").toString(),
});
assert.equal(defaultShock, e18("0.5"), "default shock price should remain 0.5");

const customShockHealth = healthFactorFor({
  collateral: e18("100"),
  debt: e18("80"),
  collateralPrice: e18("0.3"),
  debtPrice: e18("1"),
  haircutBps: 9_000n,
  collateralFactorBps: 7_000n,
  liquidationThresholdBps: 8_000n,
});
assert.equal(customShockHealth.toString(), "2700", "custom 0.3 shock health preview should be 27%");

const separatedRiskHealth = healthFactorFor({
  collateral: e18("100"),
  debt: e18("70"),
  collateralPrice: e18("1"),
  debtPrice: e18("1"),
  haircutBps: 10_000n,
  collateralFactorBps: 7_000n,
  liquidationThresholdBps: 8_000n,
});
assert.equal(separatedRiskHealth.toString(), "11428", "health factor should use liquidation threshold, not borrow factor");

const beforeLiquidation = afterLiquidationState({
  traceRisk: {},
  liveDebt: e18("80"),
  liveCollateral: e18("100"),
  liveReserves: 0n,
  liveBadDebt: 0n,
});
assert.equal(beforeLiquidation.executed, false, "after-liquidation state should be hidden before tx hash");
assert.equal(beforeLiquidation.debt, null, "debt after liquidation should not show before liquidation");

const beforeLiquidationAfterRepay = afterLiquidationState({
  traceRisk: { debtAfterRepay: "40.0" },
  liveDebt: e18("40"),
  liveCollateral: e18("100"),
  liveReserves: 0n,
  liveBadDebt: 0n,
});
assert.equal(beforeLiquidationAfterRepay.executed, false, "repay trace should not reveal after-liquidation state");
assert.equal(beforeLiquidationAfterRepay.debt, null, "repay trace should not populate after-liquidation debt");

const beforeLiquidationWithSnapshotFields = afterLiquidationState({
  traceRisk: {
    debtAfterLiquidation: "40.0",
    collateralAfterLiquidation: "16.0",
  },
  liveDebt: e18("40"),
  liveCollateral: e18("16"),
  liveReserves: 0n,
  liveBadDebt: 0n,
});
assert.equal(beforeLiquidationWithSnapshotFields.executed, false, "after-liquidation state should require liquidation evidence");
assert.equal(beforeLiquidationWithSnapshotFields.debt, null, "snapshot fields alone should stay hidden before liquidation evidence");

const repayOnlyTrace = normalizeTraceForUi({
  risk: {
    borrowed: "80.0",
    debtAfterRepay: "40.0",
  },
});
assert.equal(repayOnlyTrace.lending.liquidated, false, "debtAfterRepay alone must not mark lending as liquidated");
assert.equal(repayOnlyTrace.lending.debt, "40.0", "normalized lending debt should use repay-specific debt");

const staleLiquidationFieldTrace = normalizeTraceForUi({
  risk: {
    borrowed: "80.0",
    debtAfterLiquidation: "40.0",
  },
});
assert.equal(
  staleLiquidationFieldTrace.lending.liquidated,
  false,
  "debtAfterLiquidation alone must not mark lending as liquidated"
);

const liquidatedTrace = normalizeTraceForUi({
  risk: {
    borrowed: "80.0",
    liquidationTxHash: "0xabc",
    debtAfterLiquidation: "40.0",
  },
});
assert.equal(liquidatedTrace.lending.liquidated, true, "liquidation tx hash should mark lending as liquidated");

const reverseSettlementTrace = normalizeTraceForUi({
  reverse: {
    packetId: "0xsettlement",
    proofMode: "storage",
  },
  denied: {
    packetId: "0xdenied",
  },
});
assert.equal(reverseSettlementTrace.reverse.packetId, "0xsettlement", "reverse settlement packet should not be overwritten by denied timeout packet");
assert.equal(reverseSettlementTrace.reverse.proofMode, "storage", "reverse settlement proof mode should be preserved");

const afterLiquidation = afterLiquidationState({
  traceRisk: {
    liquidationTxHash: "0xabc",
    debtBeforeLiquidation: "80.0",
    collateralBeforeLiquidation: "100.0",
    debtAfterLiquidation: "40.0",
    collateralAfterLiquidation: "16.0",
    badDebtWrittenOff: "0.0",
    reservesUsed: "0.0",
    supplierLoss: "0.0",
  },
  liveDebt: e18("40"),
  liveCollateral: e18("16"),
  liveReserves: 0n,
  liveBadDebt: 0n,
});
assert.equal(afterLiquidation.executed, true, "after-liquidation state should appear after tx hash exists");
assert.equal(afterLiquidation.debt, "40.0");
assert.equal(afterLiquidation.collateral, "16.0");

const policy = riskPolicySnapshot({
  collateralFactorBps: 7_000n,
  liquidationThresholdBps: 8_000n,
  collateralHaircutBps: 9_000n,
  liquidationCloseFactorBps: 5_000n,
  liquidationBonusBps: 500n,
});
assert.equal(policy.collateralFactorBps, "7000", "collateral factor should stay exposed as max LTV");
assert.equal(policy.liquidationThresholdBps, "8000", "liquidation threshold should be exposed separately");
assert.equal(policy.liquidationHealthFactorTriggerBps, "10000", "liquidation trigger should be HF < 100%");

console.log("demo read-model checks passed");
