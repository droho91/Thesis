import { randomUUID } from "node:crypto";
import { RelayLeaseLostError } from "./relay-journal.mjs";
import {
  errorSummary,
  normalizeRetryOptions,
  PermanentRelayError,
  RelayDeferredError,
  retryDelayMs,
} from "./retry.mjs";

export class InstitutionalRelayEngine {
  #journal;
  #lanes;
  #workerId;
  #clock;
  #logger;
  #leaseMs;
  #batchSize;
  #retryOptions;

  constructor({
    journal,
    lanes,
    workerId = `relay-${randomUUID()}`,
    clock = Date.now,
    logger = console,
    leaseMs = 30_000,
    batchSize = 10,
    retry = {},
  }) {
    if (!Array.isArray(lanes) || lanes.length === 0) {
      throw new TypeError("Institutional relay engine requires at least one lane");
    }
    const laneIds = new Set();
    for (const lane of lanes) {
      if (typeof lane?.id !== "string" || lane.id.length === 0 || laneIds.has(lane.id)) {
        throw new TypeError(`Relay lane id is missing or duplicated: ${String(lane?.id)}`);
      }
      if (typeof lane.workflow?.scan !== "function" || typeof lane.workflow?.step !== "function") {
        throw new TypeError(`Relay lane ${lane.id} workflow must implement scan() and step()`);
      }
      laneIds.add(lane.id);
    }
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 3 || leaseMs > 2_147_483_647) {
      throw new RangeError("Relay leaseMs must be an integer between 3 and 2147483647");
    }
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
      throw new RangeError("Relay batchSize must be a positive safe integer");
    }
    this.#journal = journal;
    this.#lanes = new Map(lanes.map((lane) => [lane.id, lane]));
    this.#workerId = workerId;
    this.#clock = clock;
    this.#logger = logger;
    this.#leaseMs = leaseMs;
    this.#batchSize = batchSize;
    this.#retryOptions = normalizeRetryOptions(retry);
  }

  async tick({ signal } = {}) {
    signal?.throwIfAborted?.();
    const scanErrors = await this.scan({ signal });
    const runnable = this.#journal.runnable(this.#batchSize);
    for (const candidate of runnable) {
      await this.#process(candidate.messageId);
    }
    return { observed: this.#journal.snapshot().jobs, processed: runnable.length, scanErrors };
  }

  async scan({ signal } = {}) {
    const errors = [];
    for (const lane of this.#lanes.values()) {
      signal?.throwIfAborted?.();
      try {
        const fromBlock = this.#journal.cursor(lane.id, lane.startBlock - 1) + 1;
        const result = await lane.workflow.scan(fromBlock, { signal });
        if (!result || !Array.isArray(result.events) || !Number.isSafeInteger(result.scannedTo)) {
          throw new RelayInvariantError(`Relay lane ${lane.id} scan returned an invalid result`);
        }
        for (const event of result.events) await this.#journal.observe(lane.id, event);
        if (result.scannedTo >= fromBlock - 1) await this.#journal.advanceCursor(lane.id, result.scannedTo);
      } catch (error) {
        if (signal?.aborted) throw error;
        if (isNonRetryableError(error)) throw error;
        const summary = errorSummary(error);
        errors.push({ laneId: lane.id, error: summary });
        this.#logger.error?.(`[relay] ${lane.id} scan: ${summary.message}`);
      }
    }
    return errors;
  }

  async run({ signal, pollIntervalMs = 1_000 } = {}) {
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 2_147_483_647) {
      throw new RangeError("Relay pollIntervalMs must be an integer between 1 and 2147483647");
    }
    let consecutiveScanFailures = 0;
    while (!signal?.aborted) {
      let result;
      try {
        result = await this.tick({ signal });
      } catch (error) {
        if (signal?.aborted) return;
        throw error;
      }
      if (signal?.aborted) return;
      consecutiveScanFailures = result.scanErrors.length > 0 ? consecutiveScanFailures + 1 : 0;
      const delayMs = consecutiveScanFailures > 0
        ? retryDelayMs(consecutiveScanFailures, this.#retryOptions)
        : pollIntervalMs;
      await sleep(delayMs, signal);
    }
  }

  async #process(messageId) {
    const job = await this.#journal.claim(messageId, this.#workerId, this.#leaseMs);
    if (!job) return;
    const fencingToken = job.lease.fencingToken;
    const lane = this.#lanes.get(job.laneId);
    if (!lane) {
      await this.#recordFailureOrAbandon(job, fencingToken, new PermanentRelayError("Unknown relay lane"));
      return;
    }

    const heartbeat = startLeaseHeartbeat({
      journal: this.#journal,
      messageId,
      workerId: this.#workerId,
      fencingToken,
      leaseMs: this.#leaseMs,
    });
    let outcome;
    let workflowError;
    try {
      outcome = await lane.workflow.step(job);
      if (!outcome?.state) throw new TypeError("Relay workflow returned no state");
    } catch (error) {
      workflowError = error;
    }

    const renewalError = await heartbeat.stop();
    if (renewalError) {
      this.#logLeaseAbandoned(job, renewalError);
      return;
    }

    if (workflowError) {
      if (workflowError instanceof RelayDeferredError) {
        try {
          await this.#journal.transition(
            messageId,
            this.#workerId,
            fencingToken,
            job.state,
            {},
            workflowError.delayMs,
          );
        } catch (error) {
          if (error instanceof RelayLeaseLostError) {
            this.#logLeaseAbandoned(job, error);
            return;
          }
          throw error;
        }
        return;
      }
      await this.#recordFailureOrAbandon(job, fencingToken, workflowError);
      return;
    }

    try {
      await this.#journal.transition(
        messageId,
        this.#workerId,
        fencingToken,
        outcome.state,
        outcome.patch || {},
        outcome.deferMs || 0,
      );
      this.#logger.info?.(`[relay] ${job.laneId} ${messageId} ${job.state} -> ${outcome.state}`);
    } catch (error) {
      if (error instanceof RelayLeaseLostError) {
        this.#logLeaseAbandoned(job, error);
        return;
      }
      throw error;
    }
  }

  async #recordFailureOrAbandon(job, fencingToken, error) {
    const permanent = error instanceof PermanentRelayError;
    const attempt = job.attempts + 1;
    const delayMs = permanent ? 0 : retryDelayMs(attempt, this.#retryOptions);
    try {
      await this.#journal.recordFailure(
        job.messageId,
        this.#workerId,
        fencingToken,
        errorSummary(error),
        { delayMs, permanent },
      );
      this.#logger.error?.(`[relay] ${job.laneId} ${job.messageId}: ${error?.message || error}`);
    } catch (journalError) {
      if (journalError instanceof RelayLeaseLostError) {
        this.#logLeaseAbandoned(job, journalError);
        return;
      }
      throw journalError;
    }
  }

  #logLeaseAbandoned(job, error) {
    const log = this.#logger.warn || this.#logger.error;
    log?.call(this.#logger, `[relay] ${job.laneId} ${job.messageId}: lease lost; stale result abandoned (${error?.message || error})`);
  }
}

function startLeaseHeartbeat({ journal, messageId, workerId, fencingToken, leaseMs }) {
  const intervalMs = Math.max(1, Math.floor(leaseMs / 3));
  let stopped = false;
  let timer = null;
  let pending = null;
  let renewalError = null;

  const schedule = () => {
    if (stopped || renewalError) return;
    timer = setTimeout(() => {
      if (stopped) return;
      pending = journal.renewLease(messageId, workerId, fencingToken, leaseMs)
        .catch((error) => {
          renewalError = error;
        })
        .finally(() => {
          pending = null;
          schedule();
        });
    }, intervalMs);
  };
  schedule();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (pending) await pending;
      return renewalError;
    },
  };
}

function isNonRetryableError(error) {
  return error instanceof PermanentRelayError
    || error instanceof RelayInvariantError
    || error instanceof RangeError
    || error instanceof ReferenceError
    || error instanceof SyntaxError
    || error?.code === "INVALID_ARGUMENT"
    || error?.code === "UNSUPPORTED_OPERATION";
}

class RelayInvariantError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "RelayInvariantError";
    this.code = "INSTITUTIONAL_RELAY_INVARIANT";
  }
}

function sleep(milliseconds, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
