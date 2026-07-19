import { randomUUID } from "node:crypto";
import { errorSummary, PermanentRelayError, RelayDeferredError, retryDelayMs } from "./retry.mjs";

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
    this.#journal = journal;
    this.#lanes = new Map(lanes.map((lane) => [lane.id, lane]));
    this.#workerId = workerId;
    this.#clock = clock;
    this.#logger = logger;
    this.#leaseMs = leaseMs;
    this.#batchSize = batchSize;
    this.#retryOptions = retry;
  }

  async tick() {
    await this.scan();
    const runnable = this.#journal.runnable(this.#batchSize);
    for (const candidate of runnable) {
      await this.#process(candidate.messageId);
    }
    return { observed: this.#journal.snapshot().jobs, processed: runnable.length };
  }

  async scan() {
    for (const lane of this.#lanes.values()) {
      const fromBlock = this.#journal.cursor(lane.id, lane.startBlock - 1) + 1;
      const result = await lane.workflow.scan(fromBlock);
      for (const event of result.events) await this.#journal.observe(lane.id, event);
      if (result.scannedTo >= fromBlock - 1) await this.#journal.advanceCursor(lane.id, result.scannedTo);
    }
  }

  async run({ signal, pollIntervalMs = 1_000 } = {}) {
    while (!signal?.aborted) {
      await this.tick();
      await sleep(pollIntervalMs, signal);
    }
  }

  async #process(messageId) {
    const job = await this.#journal.claim(messageId, this.#workerId, this.#leaseMs);
    if (!job) return;
    const lane = this.#lanes.get(job.laneId);
    if (!lane) {
      await this.#journal.recordFailure(messageId, this.#workerId, { message: "Unknown relay lane" }, {
        delayMs: 0,
        permanent: true,
      });
      return;
    }

    try {
      const outcome = await lane.workflow.step(job);
      if (!outcome?.state) throw new Error("Relay workflow returned no state");
      await this.#journal.transition(
        messageId,
        this.#workerId,
        outcome.state,
        outcome.patch || {},
        outcome.deferMs || 0,
      );
      this.#logger.info?.(`[relay] ${job.laneId} ${messageId} ${job.state} -> ${outcome.state}`);
    } catch (error) {
      if (error instanceof RelayDeferredError) {
        await this.#journal.transition(messageId, this.#workerId, job.state, {}, error.delayMs);
        return;
      }
      const permanent = error instanceof PermanentRelayError;
      const attempt = job.attempts + 1;
      const delayMs = permanent ? 0 : retryDelayMs(attempt, this.#retryOptions);
      await this.#journal.recordFailure(messageId, this.#workerId, errorSummary(error), { delayMs, permanent });
      this.#logger.error?.(`[relay] ${job.laneId} ${messageId}: ${error?.message || error}`);
    }
  }
}

function sleep(milliseconds, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}
