export const TOKEN_DECIMALS = 18;
export const TOKEN_SCALE = 10n ** BigInt(TOKEN_DECIMALS);

const DECIMAL_PATTERN = /^\d+(?:\.\d{0,18})?$/;

export function parseTokenUnits(value) {
  const text = String(value ?? "").trim();
  if (!DECIMAL_PATTERN.test(text)) {
    throw new TypeError("Token amount must be an unsigned decimal with at most 18 decimal places");
  }
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * TOKEN_SCALE + BigInt(fraction.padEnd(TOKEN_DECIMALS, "0") || "0");
}

export function formatTokenUnits(value) {
  const units = BigInt(value);
  if (units < 0n) throw new RangeError("Token units cannot be negative");
  const whole = units / TOKEN_SCALE;
  const fraction = (units % TOKEN_SCALE).toString().padStart(TOKEN_DECIMALS, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function normalizeTokenAmount(value) {
  return formatTokenUnits(parseTokenUnits(value));
}

export function tryTokenUnits(value) {
  try {
    return parseTokenUnits(value);
  } catch {
    return null;
  }
}

export function minTokenAmount(...values) {
  const parsed = values.map(parseTokenUnits);
  return formatTokenUnits(parsed.reduce((minimum, candidate) => candidate < minimum ? candidate : minimum));
}

export function compactTokenAmount(value, { maximumFractionDigits = 4 } = {}) {
  if (!Number.isSafeInteger(maximumFractionDigits) || maximumFractionDigits < 0 || maximumFractionDigits > 18) {
    throw new RangeError("maximumFractionDigits must be an integer between 0 and 18");
  }
  const units = tryTokenUnits(value);
  if (units == null) return "-";
  if (units === 0n) return "0";

  const whole = units / TOKEN_SCALE;
  const remainder = units % TOKEN_SCALE;
  const groupedWhole = groupInteger(whole.toString());
  if (remainder === 0n || maximumFractionDigits === 0) return groupedWhole;

  const fullFraction = remainder.toString().padStart(TOKEN_DECIMALS, "0");
  const visible = fullFraction.slice(0, maximumFractionDigits).replace(/0+$/, "");
  const hiddenNonZero = /[1-9]/.test(fullFraction.slice(maximumFractionDigits));
  if (!visible && hiddenNonZero) return `<0.${"0".repeat(Math.max(0, maximumFractionDigits - 1))}1`;
  return `${groupedWhole}.${visible}${hiddenNonZero ? "…" : ""}`;
}

export function formatBasisPoints(value) {
  let basisPoints;
  try {
    basisPoints = BigInt(String(value ?? "0"));
  } catch {
    return "-";
  }
  if (basisPoints < 0n) return "-";
  const whole = basisPoints / 100n;
  const fraction = (basisPoints % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function formatTokenRatio(value, fractionDigits = 2) {
  const units = tryTokenUnits(value);
  if (units == null) return "-";
  const whole = units / TOKEN_SCALE;
  if (fractionDigits === 0) return whole.toString();
  const fraction = (units % TOKEN_SCALE)
    .toString()
    .padStart(TOKEN_DECIMALS, "0")
    .slice(0, fractionDigits)
    .padEnd(fractionDigits, "0");
  return `${whole}.${fraction}`;
}

export function tokenRatioMeterPercent(value) {
  const units = tryTokenUnits(value);
  if (units == null || units < TOKEN_SCALE) return 18;
  if (units < TOKEN_SCALE * 5n / 4n) return 38;
  const calculated = 52n + (units - TOKEN_SCALE) * 28n / TOKEN_SCALE;
  return Number(calculated > 100n ? 100n : calculated);
}

function groupInteger(value) {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
