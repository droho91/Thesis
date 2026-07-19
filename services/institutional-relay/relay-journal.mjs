import { AtomicJsonStore } from "../shared/atomic-json-store.mjs";

export const RELAY_JOURNAL_VERSION = "institutional-relay-journal-v1";
export const TERMINAL_STATES = new Set(["completed", "timed_out", "failed_permanent"]);

function nowIso(now) {
  return new Date(now).toISOString();
}

function validateJournal(state) {
  if (state?.version !== RELAY_JOURNAL_VERSION) throw new Error("Unsupported relay journal version");
  if (!state.cursors || typeof state.cursors !== "object") throw new Error("Relay journal cursors are missing");
  if (!state.jobs || typeof state.jobs !== "object") throw new Error("Relay journal jobs are missing");
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
    return this.#store.mutate((state) => {
      const timestamp = this.#clock();
      const job = state.jobs[messageId];
      if (!job || TERMINAL_STATES.has(job.state)) return null;
      if (job.lease && Number(job.lease.expiresAt) > timestamp && job.lease.workerId !== workerId) return null;
      job.lease = { workerId, expiresAt: timestamp + leaseMs };
      job.updatedAt = nowIso(timestamp);
      state.updatedAt = job.updatedAt;
      return structuredClone(job);
    });
  }

  async transition(messageId, workerId, nextState, patch = {}, deferMs = 0) {
    return this.#store.mutate((state) => {
      const timestamp = this.#clock();
      const job = state.jobs[messageId];
      requireLease(job, workerId, timestamp);
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

  async recordFailure(messageId, workerId, error, { delayMs, permanent = false }) {
    return this.#store.mutate((state) => {
      const timestamp = this.#clock();
      const job = state.jobs[messageId];
      requireLease(job, workerId, timestamp);
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

function requireLease(job, workerId, timestamp) {
  if (!job) throw new Error("Relay job does not exist");
  if (!job.lease || job.lease.workerId !== workerId || Number(job.lease.expiresAt) < timestamp) {
    throw new Error(`Relay job ${job.messageId} lease is not owned by ${workerId}`);
  }
}
