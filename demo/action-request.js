const FINAL_OPERATION_STATES = new Set(["completed", "failed"]);
const RECOVERABLE_OPERATION_STATES = new Set([
  "prepared",
  "signed",
  "broadcasting",
  "submitted",
  "uncertain",
]);

export class ActionRequestIntentConflictError extends Error {
  constructor(existing) {
    super(`An unresolved ${existing.action} request already exists for exactly ${existing.amount}`);
    this.name = "ActionRequestIntentConflictError";
    this.code = "ACTION_REQUEST_INTENT_CONFLICT";
    this.existing = structuredClone(existing);
  }
}

export function createActionRequestStore({
  getStorage = () => null,
  randomId,
  keyPrefix = "institutional-request:",
} = {}) {
  if (typeof getStorage !== "function" || typeof randomId !== "function") {
    throw new TypeError("Action request ID storage requires getStorage and randomId functions");
  }
  const volatileIntents = new Map();

  return Object.freeze({
    get(action, amount) {
      const requested = requireRequestedIntent(action, amount);
      const key = `${keyPrefix}${action}`;
      const volatileIntent = volatileIntents.get(action);
      let storage = null;
      let persistedIntent = null;
      try {
        storage = getStorage();
        persistedIntent = parsePersistedIntent(storage?.getItem(key));
      } catch {
        // Volatile intent handling below remains authoritative when browser
        // storage is disabled or unavailable.
      }
      const existing = persistedIntent || volatileIntent;
      if (existing) {
        assertSameIntent(existing, requested);
        volatileIntents.set(action, existing);
        return structuredClone(existing);
      }

      const created = requireIntent({ ...requested, requestId: requireGeneratedId(randomId()) });
      // Retain the complete intent before a storage write that may throw.
      volatileIntents.set(action, created);
      try {
        storage?.setItem(key, JSON.stringify(created));
      } catch {
        // The complete intent is already retained in memory.
      }
      return structuredClone(created);
    },
    clear(action) {
      volatileIntents.delete(action);
      try {
        getStorage()?.removeItem(`${keyPrefix}${action}`);
      } catch {
        // The in-memory entry is still cleared even when storage is disabled.
      }
    },
  });
}

export function requestOutcomeUncertain(error) {
  const operationStatus = error?.payload?.operation?.status;
  if (FINAL_OPERATION_STATES.has(operationStatus)) return false;
  if (RECOVERABLE_OPERATION_STATES.has(operationStatus)) return true;
  if (error?.outcomeUncertain === true) return true;

  // A missing HTTP status means the browser did not receive a conclusive
  // response. Server errors and conflicts may likewise occur after staging or
  // broadcast, so retain the same idempotency key until runtime reconciliation.
  if (error?.statusCode == null || error.statusCode === 409 || error.statusCode >= 500) return true;
  return /timed out|already submitted|already uncertain|incomplete action result/i.test(error?.message || "");
}

function validRequestId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(value);
}

function validAction(value) {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{1,31}$/.test(value);
}

function normalizeAmount(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,18})?$/.test(text)) throw new Error("Action request amount is invalid");
  const [whole, fraction = ""] = text.split(".");
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "");
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction ? `${normalizedWhole}.${normalizedFraction}` : normalizedWhole;
}

function requireRequestedIntent(action, amount) {
  if (!validAction(action)) throw new Error("Action request action is invalid");
  return Object.freeze({ action, amount: normalizeAmount(amount) });
}

function requireIntent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Action request intent is invalid");
  const requestId = requireGeneratedId(value.requestId);
  if (!validAction(value.action)) throw new Error("Action request action is invalid");
  return Object.freeze({ requestId, action: value.action, amount: normalizeAmount(value.amount) });
}

function parsePersistedIntent(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return requireIntent(JSON.parse(value));
  } catch {
    // Legacy ID-only entries and malformed values were never bound to an
    // exact amount, so they cannot be reused for a financial retry.
    return null;
  }
}

function assertSameIntent(existing, requested) {
  if (existing.action !== requested.action || existing.amount !== requested.amount) {
    throw new ActionRequestIntentConflictError(existing);
  }
}

function requireGeneratedId(value) {
  if (!validRequestId(value)) throw new Error("Generated action request ID is invalid");
  return value;
}
