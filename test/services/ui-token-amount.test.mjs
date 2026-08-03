import assert from "node:assert/strict";
import test from "node:test";
import {
  TOKEN_SCALE,
  compactTokenAmount,
  formatBasisPoints,
  formatTokenRatio,
  formatTokenUnits,
  minTokenAmount,
  normalizeTokenAmount,
  parseTokenUnits,
  tokenRatioMeterPercent,
  tryTokenUnits,
} from "../../demo/token-amount.js";

test("token amounts round-trip all 18 decimals without Number coercion", () => {
  const exact = "9007199254740993.123456789012345678";
  const units = parseTokenUnits(exact);
  assert.equal(units, 9007199254740993123456789012345678n);
  assert.equal(formatTokenUnits(units), exact);
  assert.equal(normalizeTokenAmount("0009007199254740993.123456789012345678"), exact);
  assert.equal(parseTokenUnits("0.000000000000000001"), 1n);
  assert.equal(tryTokenUnits("1.0000000000000000001"), null);
});

test("limits and presentation remain exact at wei boundaries", () => {
  assert.equal(minTokenAmount("1.000000000000000001", "1.000000000000000002"), "1.000000000000000001");
  assert.equal(compactTokenAmount("0.000000000000000001"), "<0.0001");
  assert.equal(compactTokenAmount("1234567.123456789"), "1,234,567.1234…");
  assert.equal(formatBasisPoints("8250"), "82.5");
});

test("health ratio rendering uses scaled integers", () => {
  assert.equal(formatTokenRatio("1.23456789"), "1.23");
  assert.equal(tokenRatioMeterPercent("0.999999999999999999"), 18);
  assert.equal(tokenRatioMeterPercent("1.249999999999999999"), 38);
  assert.equal(tokenRatioMeterPercent("1.5"), 66);
  assert.equal(tokenRatioMeterPercent(formatTokenUnits(TOKEN_SCALE * 100n)), 100);
});
