import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  afterLiquidationState,
  healthFactorFor,
  resolveShockPreviewPriceE18,
  riskPolicySnapshot,
} from "./demo-read-model.mjs";

const e18 = (value) => ethers.parseUnits(value, 18);

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
  collateralFactorBps: 8_000n,
});
assert.equal(customShockHealth.toString(), "2700", "custom 0.3 shock health preview should be 27%");

const beforeLiquidation = afterLiquidationState({
  traceRisk: {},
  liveDebt: e18("80"),
  liveCollateral: e18("100"),
  liveReserves: 0n,
  liveBadDebt: 0n,
});
assert.equal(beforeLiquidation.executed, false, "after-liquidation state should be hidden before tx hash");
assert.equal(beforeLiquidation.debt, null, "debt after liquidation should not show before liquidation");

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
  collateralFactorBps: 8_000n,
  collateralHaircutBps: 9_000n,
  liquidationCloseFactorBps: 5_000n,
  liquidationBonusBps: 500n,
});
assert.equal(policy.collateralFactorBps, "8000", "collateral factor should stay exposed as max LTV");
assert.equal(policy.liquidationHealthFactorTriggerBps, "10000", "liquidation trigger should be HF < 100%");

console.log("demo read-model checks passed");
