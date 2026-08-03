export class PermanentRelayError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "PermanentRelayError";
  }
}

export class RelayDeferredError extends Error {
  constructor(message, delayMs = 1_000, options = {}) {
    super(message, options);
    this.name = "RelayDeferredError";
    this.delayMs = delayMs;
  }
}

const RETRY_OPTION_KEYS = new Set(["baseMs", "maxMs", "jitterRatio", "random"]);
const MAX_TIMER_MS = 2_147_483_647;

export function normalizeRetryOptions(options = {}) {
  if (
    options === null
    || typeof options !== "object"
    || Array.isArray(options)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(options))
  ) {
    throw new TypeError("Relay retry options must be an object");
  }
  const unknownKeys = Object.keys(options).filter((key) => !RETRY_OPTION_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new TypeError(`Unknown relay retry option(s): ${unknownKeys.join(", ")}`);
  }

  const baseMs = options.baseMs ?? 1_000;
  const maxMs = options.maxMs ?? 60_000;
  const jitterRatio = options.jitterRatio ?? 0.15;
  const random = options.random ?? Math.random;
  requirePositiveTimer(baseMs, "baseMs");
  requirePositiveTimer(maxMs, "maxMs");
  if (maxMs < baseMs) throw new RangeError("Relay retry maxMs must be greater than or equal to baseMs");
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new RangeError("Relay retry jitterRatio must be between 0 and 1");
  }
  if (typeof random !== "function") throw new TypeError("Relay retry random must be a function");
  return Object.freeze({ baseMs, maxMs, jitterRatio, random });
}

export function retryDelayMs(attempt, options = {}) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError("Relay retry attempt must be a positive safe integer");
  }
  const { baseMs, maxMs, jitterRatio, random } = normalizeRetryOptions(options);
  const randomValue = random();
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) {
    throw new RangeError("Relay retry random() must return a number in [0, 1)");
  }
  const exponent = attempt - 1;
  const withoutJitter = Math.min(maxMs, baseMs * (2 ** exponent));
  const jitter = withoutJitter * jitterRatio * ((randomValue * 2) - 1);
  return Math.max(1, Math.round(withoutJitter + jitter));
}

export function errorSummary(error) {
  return {
    name: error?.name || "Error",
    message: error?.shortMessage || error?.message || String(error),
    code: error?.code == null ? null : String(error.code),
  };
}

function requirePositiveTimer(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_MS) {
    throw new RangeError(`Relay retry ${label} must be an integer between 1 and ${MAX_TIMER_MS}`);
  }
}
