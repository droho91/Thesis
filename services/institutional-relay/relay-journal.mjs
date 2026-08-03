import { AtomicJsonStore } from "../shared/atomic-json-store.mjs";

export const RELAY_JOURNAL_VERSION = "institutional-relay-journal-v1";
export const TERMINAL_STATES = new Set(["completed", "timed_out", "failed_permanent"]);
const RELAY_STATES = new Set([
  "observed",
  "source_checkpointed",
  "received",
  "destination_checkpointed",
  "completed",
  "timeout_checkpointed",
  "timed_out",
  "failed_permanent",
]);
const RESERVED_PATCH_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "messageId",
  "laneId",
  "state",
  "sourceTxHash",
  "sourceBlockNumber",
  "attempts",
  "nextAttemptAt",
  "lease",
  "fencingToken",
  "lastError",
  "createdAt",
  "updatedAt",
  "history",
]);

export class RelayLeaseLostError extends Error {
  constructor(messageId, workerId, fencingToken, reason) {
    super(`Relay job ${messageId} lease ${String(fencingToken)} is not owned by ${workerId}: ${reason}`);
    this.name = "RelayLeaseLostError";
    this.code = "INSTITUTIONAL_RELAY_LEASE_LOST";
    this.messageId = messageId;
    this.workerId = workerId;
    this.fencingToken = fencingToken;
  }
}

function nowIso(now) {
  return new Date(now).toISOString();
}

function validateJournal(state) {
  if (state?.version !== RELAY_JOURNAL_VERSION) throw new Error("Unsupported relay journal version");
  if (!isPlainObject(state.cursors)) throw new Error("Relay journal cursors are missing");
  if (!isPlainObject(state.jobs)) throw new Error("Relay journal jobs are missing");
  for (const [laneId, cursor] of Object.entries(state.cursors)) {
    if (laneId.length === 0 || !Number.isSafeInteger(cursor) || cursor < 0) {
      throw new Error(`Relay journal cursor for ${laneId || "<empty>"} is invalid`);
    }
  }
  for (const [messageId, job] of Object.entries(state.jobs)) validateJob(messageId, job);
}

export class RelayJournal {
  #store;
  #clock;

  constructor(store, clock) {
    this.#store = store;
    this.#clock = clock;
  }

  static async open(path, { clock = Date.now } = {}) {
    const timestamp = clock();
    const store = await AtomicJsonStore.open(path, {
      create: () => ({
        version: RELAY_JOURNAL_VERSION,
        createdAt: nowIso(timestamp),
        updatedAt: nowIso(timestamp),
        cursors: {},
        jobs: {},
      }),
      validate: validateJournal,
    });
    return new RelayJournal(store, clock);
  }

  snapshot() {
    return this.#store.snapshot();
  }

  close() {
    return this.#store.close();
  }

  cursor(laneId, fallback = 0) {
    return Number(this.#store.snapshot().cursors[laneId] ?? fallback);
  }

  async observe(laneId, event) {
    if (!event?.messageId || !event?.message) throw new Error("Observed event is incomplete");
    return this.#store.mutate((state) => {
      const timestamp = this.#clock();
      const existing = state.jobs[event.messageId];
      if (existing) {
        if (existing.laneId !== laneId || existing.sourceTxHash !== event.sourceTxHash) {
          throw new Error(`Conflicting observation for ${event.messageId}`);
        }
        return false;
      }

      state.jobs[event.messageId] = {
        messageId: event.messageId,
        laneId,
        state: "observed",
        message: event.message,
        sourceTxHash: event.sourceTxHash,
        sourceBlockNumber: Number(event.sourceBlockNumber),
        destinationReceiveBlock: null,
        acknowledgement: null,
        transactions: { source: event.sourceTxHash },
        attempts: 0,
        nextAttemptAt: timestamp,
        lease: null,
        fencingToken: 0,
        lastError: null,
        createdAt: nowIso(timestamp),
        updatedAt: nowIso(timestamp),
        history: [{ state: "observed", at: nowIso(timestamp) }],
      };
      state.updatedAt = nowIso(timestamp);
      return true;
    });
  }

  async advanceCursor(laneId, blockNumber) {
    return this.#store.mutate((state) => {
      const current = Number(state.cursors[laneId] ?? 0);
      if (Number(blockNumber) < current) throw new Error(`Cursor regression for lane ${laneId}`);
      state.cursors[laneId] = Number(blockNumber);
      state.updatedAt = nowIso(this.#clock());
    });
  }

  runnable(limit = 10) {
    const timestamp = this.#clock();
    return Object.values(this.#store.snapshot().jobs)
      .filter((job) => !TERMINAL_STATES.has(job.state))
      .filter((job) => Number(job.nextAttemptAt || 0) <= timestamp)
      .filter((job) => !job.lease || Number(job.lease.expiresAt) <= timestamp)
      .sort((a, b) => a.sourceBlockNumber - b.sourceBlockNumber || a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
  }

  async claim(messageId, workerId, leaseMs) {
    requireWorker(workerId);
    requireLeaseDuration(leaseMs);
    return this.#store.mutate((state) => {
      const timestamp = this.#clock();
      const job = state.jobs[messageId];
      if (!job || TERMINAL_STATES.has(job.state)) return null;
      if (job.lease && Number(job.lease.expiresAt) > timestamp) return null;
      const previousToken = Number(job.fencingToken || 0);
      if (!Number.isSafeInteger(previousToken) || previousToken < 0 || previousToken === Number.MAX_SAFE_INTEGER) {
        throw new Error(`Relay job ${messageId} fencing token is invalid or exhausted`);
      }
      const fencingToken = previousToken + 1;
      job.fencingToken = fencingToken;
      job.lease = { workerId, fencingToken, expiresAt: timestamp + leaseMs };
      job.updatedAt = nowIso(timestamp);
      state.updatedAt = job.updatedAt;
      return structuredClone(job);
    });
  }

  async renewLease(messageId, workerId, fencingToken, leaseMs) {
    requireWorker(workerId);
    requireFencingToken(fencingToken);
    requireLeaseDuration(leaseMs);
    return this.#store.mutate((state) => {
      const timestamp = this.#clock();
      const job = state.jobs[messageId];
      requireLease(job, messageId, workerId, fencingToken, timestamp);
      job.lease.expiresAt = timestamp + leaseMs;
      job.updatedAt = nowIso(timestamp);
      state.updatedAt = job.updatedAt;
      return structuredClone(job.lease);
    });
  }

  async transition(messageId, workerId, fencingToken, nextState, patch = {}, deferMs = 0) {
    requireWorker(workerId);
    requireFencingToken(fencingToken);
    if (!RELAY_STATES.has(nextState)) throw new TypeError(`Unsupported relay transition state ${String(nextState)}`);
    if (!isPlainObject(patch)) {
      throw new TypeError("Relay transition patch must be an object");
    }
    requireJsonSafe(patch, "Relay transition patch");
    const reservedKeys = Object.keys(patch).filter((key) => RESERVED_PATCH_KEYS.has(key));
    if (reservedKeys.length > 0) {
      throw new TypeError(`Relay transition patch cannot overwrite reserved field(s): ${reservedKeys.join(", ")}`);
    }
    requireDelay(deferMs, "deferMs");
    return this.#store.mutate((state) => {
      const timestamp = this.#clock();
      const job = state.jobs[messageId];
      requireLease(job, messageId, workerId, fencingToken, timestamp);
      Object.assign(job, patch);
      job.state = nextState;
      job.attempts = 0;
      job.lastError = null;
      job.nextAttemptAt = timestamp + Math.max(0, deferMs);
      job.lease = null;
      job.updatedAt = nowIso(timestamp);
      job.history.push({ state: nextState, at: job.updatedAt });
      job.history = job.history.slice(-64);
      state.updatedAt = job.updatedAt;
      return structuredClone(job);
    });
  }

  async recordFailure(messageId, workerId, fencingToken, error, { delayMs, permanent = false }) {
    requireWorker(workerId);
    requireFencingToken(fencingToken);
    requireDelay(delayMs, "failure delayMs");
    if (error === null || typeof error !== "object" || typeof error.message !== "string") {
      throw new TypeError("Relay failure summary must contain a message");
    }
    return this.#store.mutate((state) => {
      const timestamp = this.#clock();
      const job = state.jobs[messageId];
      requireLease(job, messageId, workerId, fencingToken, timestamp);
      job.attempts += 1;
      job.lastError = error;
      job.state = permanent ? "failed_permanent" : job.state;
      job.nextAttemptAt = permanent ? timestamp : timestamp + delayMs;
      job.lease = null;
      job.updatedAt = nowIso(timestamp);
      job.history.push({
        state: permanent ? "failed_permanent" : job.state,
        at: job.updatedAt,
        error: error.message,
      });
      job.history = job.history.slice(-64);
      state.updatedAt = job.updatedAt;
      return structuredClone(job);
    });
  }
}

function requireLease(job, messageId, workerId, fencingToken, timestamp) {
  if (!job) throw new RelayLeaseLostError(messageId, workerId, fencingToken, "the job does not exist");
  if (!job.lease) throw new RelayLeaseLostError(messageId, workerId, fencingToken, "no lease is active");
  if (job.lease.workerId !== workerId) {
    throw new RelayLeaseLostError(messageId, workerId, fencingToken, `owned by ${job.lease.workerId}`);
  }
  if (Number(job.lease.fencingToken) !== fencingToken || Number(job.fencingToken) !== fencingToken) {
    throw new RelayLeaseLostError(messageId, workerId, fencingToken, "the fencing token is stale");
  }
  if (Number(job.lease.expiresAt) <= timestamp) {
    throw new RelayLeaseLostError(messageId, workerId, fencingToken, "the lease expired");
  }
}

function requireWorker(workerId) {
  if (typeof workerId !== "string" || workerId.trim().length === 0) {
    throw new TypeError("Relay workerId must be a non-empty string");
  }
}

function requireFencingToken(fencingToken) {
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
    throw new TypeError("Relay fencing token must be a positive safe integer");
  }
}

function requireLeaseDuration(leaseMs) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 3 || leaseMs > 2_147_483_647) {
    throw new RangeError("Relay leaseMs must be an integer between 3 and 2147483647");
  }
}

function requireDelay(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new RangeError(`Relay ${label} must be an integer between 0 and 2147483647`);
  }
}

function validateJob(messageId, job) {
  if (!isPlainObject(job) || job.messageId !== messageId || !RELAY_STATES.has(job.state)) {
    throw new Error(`Relay journal job ${messageId} is invalid`);
  }
  const hasJobToken = job.fencingToken !== undefined;
  if (hasJobToken && (!Number.isSafeInteger(job.fencingToken) || job.fencingToken < 0)) {
    throw new Error(`Relay journal job ${messageId} fencing token is invalid`);
  }
  if (job.lease == null) return;
  if (
    !isPlainObject(job.lease)
    || typeof job.lease.workerId !== "string"
    || job.lease.workerId.trim().length === 0
    || !Number.isSafeInteger(job.lease.expiresAt)
  ) {
    throw new Error(`Relay journal job ${messageId} lease is invalid`);
  }
  const hasLeaseToken = job.lease.fencingToken !== undefined;
  if (hasJobToken !== hasLeaseToken) {
    throw new Error(`Relay journal job ${messageId} fencing metadata is incomplete`);
  }
  if (hasJobToken && (job.fencingToken < 1 || job.lease.fencingToken !== job.fencingToken)) {
    throw new Error(`Relay journal job ${messageId} lease fencing token does not match`);
  }
}

function requireJsonSafe(value, label, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${label} contains a non-finite number`);
    return;
  }
  if (typeof value !== "object") throw new TypeError(`${label} contains a non-JSON value`);
  if (ancestors.has(value)) throw new TypeError(`${label} contains a circular reference`);
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw new TypeError(`${label} contains a non-plain object`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) requireJsonSafe(entry, label, ancestors);
  } else {
    for (const entry of Object.values(value)) requireJsonSafe(entry, label, ancestors);
  }
  ancestors.delete(value);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
