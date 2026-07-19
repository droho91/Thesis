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

export function retryDelayMs(attempt, {
  baseMs = 1_000,
  maxMs = 60_000,
  jitterRatio = 0.15,
  random = Math.random,
} = {}) {
  const exponent = Math.max(0, Number(attempt) - 1);
  const withoutJitter = Math.min(maxMs, baseMs * (2 ** exponent));
  const jitter = withoutJitter * jitterRatio * ((random() * 2) - 1);
  return Math.max(0, Math.round(withoutJitter + jitter));
}

export function errorSummary(error) {
  return {
    name: error?.name || "Error",
    message: error?.shortMessage || error?.message || String(error),
    code: error?.code == null ? null : String(error.code),
  };
}
