import { AtomicJsonStore } from "./shared/atomic-json-store.mjs";

export const ACTION_JOURNAL_VERSION = "institutional-action-journal-v1";
const TERMINAL_STATES = new Set(["completed", "failed", "uncertain"]);
const MAX_OPERATIONS = 200;

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function validateJournal(state) {
  if (state?.version !== ACTION_JOURNAL_VERSION) throw new Error("Unsupported action journal version");
  if (!state.operations || typeof state.operations !== "object") throw new Error("Action journal operations are missing");
  if (!Array.isArray(state.order)) throw new Error("Action journal order is missing");
}

export class InstitutionalActionJournal {
  #store;
  #clock;

  constructor(store, clock) {
    this.#store = store;
    this.#clock = clock;
  }

  static async open(path, { clock = Date.now } = {}) {
    const store = await AtomicJsonStore.open(path, {
      create: () => ({
        version: ACTION_JOURNAL_VERSION,
        createdAt: nowIso(clock),
        updatedAt: nowIso(clock),
        operations: {},
        order: [],
      }),
      validate: validateJournal,
    });
    return new InstitutionalActionJournal(store, clock);
  }

  snapshot() {
    return this.#store.snapshot();
  }

  get(requestId) {
    return this.#store.snapshot().operations[requestId] || null;
  }

  async prepare(operation) {
    validateOperation(operation);
    return this.#store.mutate((state) => {
      const existing = state.operations[operation.requestId];
      if (existing) {
        if (existing.action !== operation.action || existing.amount !== operation.amount) {
          throw new Error(`Idempotency key ${operation.requestId} was already used for a different action`);
        }
        return { created: false, operation: structuredClone(existing) };
      }

      const timestamp = nowIso(this.#clock);
      const entry = {
        ...operation,
        status: "prepared",
        sourceTransaction: null,
        result: null,
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        history: [{ status: "prepared", at: timestamp }],
      };
      state.operations[operation.requestId] = entry;
      state.order = [operation.requestId, ...state.order.filter((id) => id !== operation.requestId)];
      for (const staleId of state.order.slice(MAX_OPERATIONS)) delete state.operations[staleId];
      state.order = state.order.slice(0, MAX_OPERATIONS);
      state.updatedAt = timestamp;
      return { created: true, operation: structuredClone(entry) };
    });
  }

  async submitted(requestId, sourceTransaction, patch = {}) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(sourceTransaction || "")) throw new Error("Submitted transaction hash is invalid");
    return this.#transition(requestId, "submitted", { ...patch, sourceTransaction });
  }

  async complete(requestId, result) {
    return this.#transition(requestId, "completed", { result, error: null });
  }

  async fail(requestId, error, { uncertain = false, sourceTransaction = null } = {}) {
    if (sourceTransaction != null && !/^0x[0-9a-fA-F]{64}$/.test(sourceTransaction)) {
      throw new Error("Failed transaction hash is invalid");
    }
    return this.#transition(requestId, uncertain ? "uncertain" : "failed", {
      error: String(error?.message || error),
      ...(sourceTransaction == null ? {} : { sourceTransaction }),
    });
  }

  async #transition(requestId, status, patch) {
    return this.#store.mutate((state) => {
      const operation = state.operations[requestId];
      if (!operation) throw new Error(`Action journal entry ${requestId} does not exist`);
      if (operation.status === "completed" && status !== "completed") {
        throw new Error(`Completed action ${requestId} cannot transition to ${status}`);
      }
      if (TERMINAL_STATES.has(operation.status) && operation.status === status) return structuredClone(operation);

      const timestamp = nowIso(this.#clock);
      Object.assign(operation, patch, { status, updatedAt: timestamp });
      operation.history.push({ status, at: timestamp });
      operation.history = operation.history.slice(-16);
      state.updatedAt = timestamp;
      return structuredClone(operation);
    });
  }
}

function validateOperation(operation) {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(operation?.requestId || "")) throw new Error("Invalid idempotency key");
  if (!operation.action || !operation.label || !operation.lane) throw new Error("Action journal operation is incomplete");
  if (!/^\d+(\.\d+)?$/.test(operation.amount || "")) throw new Error("Action journal amount is invalid");
}
