import { ethers } from "ethers";
import { AtomicJsonStore } from "./shared/atomic-json-store.mjs";

export const ACTION_JOURNAL_VERSION = "institutional-action-journal-v3";
const ACTION_JOURNAL_VERSION_V1 = "institutional-action-journal-v1";
const ACTION_JOURNAL_VERSION_V2 = "institutional-action-journal-v2";
const SUPPORTED_ACTION_JOURNAL_VERSIONS = new Set([
  ACTION_JOURNAL_VERSION,
  ACTION_JOURNAL_VERSION_V1,
  ACTION_JOURNAL_VERSION_V2,
]);
const OUTBOX_VERSION = "institutional-transaction-outbox-v1";
const FINAL_STATES = new Set(["completed", "failed"]);
const TRANSACTION_PERSISTENCE = Object.freeze({
  PENDING: "pending",
  DURABLE_OUTBOX: "durable-outbox",
  LEGACY_HASH_ONLY: "legacy-hash-only",
});
const OPERATION_STATES = new Set([
  "prepared",
  "signed",
  "broadcasting",
  "submitted",
  "uncertain",
  "completed",
  "failed",
]);
const OUTBOX_STATES = new Set(["signed", "broadcasting", "submitted", "uncertain", "completed", "failed"]);
const RESERVED_REQUEST_IDS = new Set(["__proto__", "constructor", "prototype"]);

export class UnresolvedActionConflictError extends Error {
  constructor(operation) {
    super(`Unresolved financial action ${operation.requestId} must be reconciled before starting another request`);
    this.name = "UnresolvedActionConflictError";
    this.code = "INSTITUTIONAL_ACTION_IN_PROGRESS";
    this.blockingOperation = structuredClone(operation);
  }
}

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function migratedTransactionPersistence(operation, previousVersion) {
  if (operation.outbox) return TRANSACTION_PERSISTENCE.DURABLE_OUTBOX;
  if (previousVersion === ACTION_JOURNAL_VERSION_V1) {
    return TRANSACTION_PERSISTENCE.LEGACY_HASH_ONLY;
  }
  return ["prepared", "failed"].includes(operation.status)
    ? TRANSACTION_PERSISTENCE.PENDING
    : TRANSACTION_PERSISTENCE.LEGACY_HASH_ONLY;
}

function validateJournal(state) {
  if (!SUPPORTED_ACTION_JOURNAL_VERSIONS.has(state?.version)) {
    throw new Error("Unsupported action journal version");
  }
  if (!state.operations || typeof state.operations !== "object" || Array.isArray(state.operations)) {
    throw new Error("Action journal operations are missing");
  }
  if (!Array.isArray(state.order)) throw new Error("Action journal order is missing");
  const orderedIds = new Set(state.order);
  if (orderedIds.size !== state.order.length) throw new Error("Action journal order contains duplicates");
  const operationKeys = Object.keys(state.operations);
  if (operationKeys.length !== state.order.length || operationKeys.some((requestId) => !orderedIds.has(requestId))) {
    throw new Error("Action journal operation keys do not exactly match its order");
  }
  for (const requestId of state.order) {
    const operation = Object.hasOwn(state.operations, requestId) ? state.operations[requestId] : null;
    if (!operation || operation.requestId !== requestId) {
      throw new Error(`Action journal operation ${requestId} is missing or mismatched`);
    }
    validateOperation(operation);
    validatePersistedOperation(operation, state.version);
  }
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
    try {
      if (store.snapshot().version !== ACTION_JOURNAL_VERSION) {
        await store.mutate((state) => {
          const previousVersion = state.version;
          state.version = ACTION_JOURNAL_VERSION;
          for (const operation of Object.values(state.operations)) {
            operation.outbox ??= null;
            operation.transactionPersistence = migratedTransactionPersistence(operation, previousVersion);
            if (!["failed", "uncertain"].includes(operation.status)) operation.error = null;
            if (operation.status !== "completed") operation.result = null;
          }
          state.updatedAt = nowIso(clock);
        });
      }
    } catch (migrationError) {
      try {
        await store.close();
      } catch (closeError) {
        throw new AggregateError(
          [migrationError, closeError],
          "Action journal migration failed and its process lock could not be released",
        );
      }
      throw migrationError;
    }
    return new InstitutionalActionJournal(store, clock);
  }

  close() {
    return this.#store.close();
  }

  snapshot() {
    return this.#store.snapshot();
  }

  get(requestId) {
    const operations = this.#store.snapshot().operations;
    return Object.hasOwn(operations, requestId) ? operations[requestId] : null;
  }

  unresolved() {
    const snapshot = this.#store.snapshot();
    return snapshot.order
      .map((requestId) => snapshot.operations[requestId])
      .filter((operation) => operation && !FINAL_STATES.has(operation.status))
      .map((operation) => structuredClone(operation));
  }

  async prepare(operation) {
    validateOperation(operation);
    return this.#store.mutate((state) => {
      const existing = Object.hasOwn(state.operations, operation.requestId)
        ? state.operations[operation.requestId]
        : null;
      if (existing) {
        if (!sameBusinessIntent(existing, operation)) {
          throw new Error(`Idempotency key ${operation.requestId} was already used for a different action intent`);
        }
        return { created: false, operation: structuredClone(existing) };
      }

      const unresolved = state.order
        .map((requestId) => state.operations[requestId])
        .find((candidate) => candidate && !FINAL_STATES.has(candidate.status));
      if (unresolved) throw new UnresolvedActionConflictError(unresolved);

      const timestamp = nowIso(this.#clock);
      const entry = {
        ...operation,
        status: "prepared",
        sourceTransaction: null,
        outbox: null,
        transactionPersistence: TRANSACTION_PERSISTENCE.PENDING,
        result: null,
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        history: [{ status: "prepared", at: timestamp }],
      };
      state.operations[operation.requestId] = entry;
      state.order = [operation.requestId, ...state.order.filter((id) => id !== operation.requestId)];
      state.updatedAt = timestamp;
      return { created: true, operation: structuredClone(entry) };
    });
  }

  async stageSignedTransaction(requestId, signedTransaction, patch = {}) {
    const normalized = normalizeSignedTransaction(signedTransaction);
    return this.#store.mutate((state) => {
      const operation = requireOperation(state, requestId);
      if (operation.outbox) {
        if (sameSignedTransaction(operation.outbox, normalized)) {
          return { created: false, operation: structuredClone(operation), outbox: structuredClone(operation.outbox) };
        }
        throw new Error(`Request ${requestId} already owns a different signed transaction outbox`);
      }
      if (operation.status !== "prepared") {
        throw new Error(`Request ${requestId} cannot stage a transaction from status ${operation.status}`);
      }

      const conflict = Object.values(state.operations).find((candidate) => (
        candidate.requestId !== requestId
        && candidate.outbox
        && !FINAL_STATES.has(candidate.status)
        && candidate.outbox.chainId === normalized.chainId
        && sameAddress(candidate.outbox.signer, normalized.signer)
      ));
      if (conflict) {
        throw new Error(
          `Signer ${normalized.signer} on chain ${normalized.chainId} has unresolved request ${conflict.requestId}`,
        );
      }

      const timestamp = nowIso(this.#clock);
      operation.outbox = {
        version: OUTBOX_VERSION,
        requestId: operation.requestId,
        action: operation.action,
        amount: operation.amount,
        lane: operation.lane,
        intentHash: transactionIntentHash(operation, normalized),
        ...normalized,
        status: "signed",
        broadcastAttempts: 0,
        lastBroadcastAttemptAt: null,
        submittedAt: null,
        lastError: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      operation.transactionPersistence = TRANSACTION_PERSISTENCE.DURABLE_OUTBOX;
      Object.assign(operation, safeOperationPatch(patch), {
        status: "signed",
        sourceTransaction: normalized.transactionHash,
        error: null,
        updatedAt: timestamp,
      });
      appendHistory(operation, { status: "signed", at: timestamp });
      state.updatedAt = timestamp;
      return { created: true, operation: structuredClone(operation), outbox: structuredClone(operation.outbox) };
    });
  }

  async broadcasting(requestId, patch = {}) {
    return this.#store.mutate((state) => {
      const operation = requireOperation(state, requestId);
      if (!operation.outbox) throw new Error(`Request ${requestId} has no signed transaction outbox`);
      if (FINAL_STATES.has(operation.status)) {
        throw new Error(`Final action ${requestId} cannot transition to broadcasting`);
      }
      const timestamp = nowIso(this.#clock);
      operation.outbox.status = "broadcasting";
      operation.outbox.broadcastAttempts += 1;
      operation.outbox.lastBroadcastAttemptAt = timestamp;
      operation.outbox.lastError = null;
      operation.outbox.updatedAt = timestamp;
      Object.assign(operation, safeOperationPatch(patch), {
        status: "broadcasting",
        sourceTransaction: operation.outbox.transactionHash,
        error: null,
        updatedAt: timestamp,
      });
      appendHistory(operation, {
        status: "broadcasting",
        at: timestamp,
        attempt: operation.outbox.broadcastAttempts,
      });
      state.updatedAt = timestamp;
      return structuredClone(operation);
    });
  }

  async submitted(requestId, sourceTransaction, patch = {}) {
    requireTransactionHash(sourceTransaction, "Submitted transaction hash is invalid");
    return this.#transition(requestId, "submitted", {
      ...safeOperationPatch(patch),
      sourceTransaction,
      error: null,
    }, (operation, timestamp) => {
      if (!operation.outbox) return;
      if (operation.outbox.transactionHash.toLowerCase() !== sourceTransaction.toLowerCase()) {
        throw new Error(`Submitted transaction hash does not match request ${requestId} outbox`);
      }
      operation.outbox.status = "submitted";
      operation.outbox.submittedAt ??= timestamp;
      operation.outbox.lastError = null;
      operation.outbox.updatedAt = timestamp;
    });
  }

  async complete(requestId, result) {
    return this.#transition(requestId, "completed", { result, error: null }, (operation, timestamp) => {
      if (operation.outbox) {
        operation.outbox.status = "completed";
        operation.outbox.updatedAt = timestamp;
      }
    });
  }

  async fail(requestId, error, { uncertain = false, sourceTransaction = null } = {}) {
    if (sourceTransaction != null) requireTransactionHash(sourceTransaction, "Failed transaction hash is invalid");
    const message = String(error?.message || error);
    const status = uncertain ? "uncertain" : "failed";
    return this.#transition(requestId, status, {
      error: message,
      ...(sourceTransaction == null ? {} : { sourceTransaction }),
    }, (operation, timestamp) => {
      if (operation.outbox) {
        operation.outbox.status = status;
        operation.outbox.lastError = message;
        operation.outbox.updatedAt = timestamp;
      }
    });
  }

  async #transition(requestId, status, patch, update) {
    return this.#store.mutate((state) => {
      const operation = requireOperation(state, requestId);
      if (FINAL_STATES.has(operation.status)) {
        if (operation.status === status) return structuredClone(operation);
        throw new Error(`Final action ${requestId} cannot transition to ${status}`);
      }
      assertOperationTransition(operation, status);

      const timestamp = nowIso(this.#clock);
      update?.(operation, timestamp);
      const statusChanged = operation.status !== status;
      Object.assign(operation, patch, { status, updatedAt: timestamp });
      if (statusChanged) appendHistory(operation, { status, at: timestamp });
      state.updatedAt = timestamp;
      return structuredClone(operation);
    });
  }
}

function validateOperation(operation) {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(operation?.requestId || "")) throw new Error("Invalid idempotency key");
  if (RESERVED_REQUEST_IDS.has(operation.requestId)) throw new Error("Invalid reserved idempotency key");
  if (!operation.action || !operation.label || !operation.lane) throw new Error("Action journal operation is incomplete");
  if (!/^\d+(\.\d+)?$/.test(operation.amount || "")) throw new Error("Action journal amount is invalid");
}

function validatePersistedOperation(operation, journalVersion) {
  if (!OPERATION_STATES.has(operation.status)) {
    throw new Error(`Invalid action journal status for ${operation.requestId}`);
  }
  if (!Array.isArray(operation.history) || operation.history.length === 0) {
    throw new Error(`Action journal history is missing for ${operation.requestId}`);
  }
  for (const entry of operation.history) {
    if (!OPERATION_STATES.has(entry?.status) || !isIsoTimestamp(entry.at)) {
      throw new Error(`Action journal history is invalid for ${operation.requestId}`);
    }
  }
  if (operation.history.at(-1).status !== operation.status) {
    throw new Error(`Action journal status does not match its history for ${operation.requestId}`);
  }
  if (!isIsoTimestamp(operation.createdAt) || !isIsoTimestamp(operation.updatedAt)) {
    throw new Error(`Action journal timestamps are invalid for ${operation.requestId}`);
  }
  if (operation.sourceTransaction != null) {
    requireTransactionHash(operation.sourceTransaction, `Action journal transaction hash is invalid for ${operation.requestId}`);
  }
  if (operation.status === "prepared" && operation.sourceTransaction != null) {
    throw new Error(`Prepared action ${operation.requestId} cannot have a source transaction`);
  }
  if (operation.status === "completed") {
    if (!operation.result || typeof operation.result !== "object" || Array.isArray(operation.result) || operation.error != null) {
      throw new Error(`Completed action ${operation.requestId} has an invalid result`);
    }
  } else if (["failed", "uncertain"].includes(operation.status)) {
    if (typeof operation.error !== "string" || operation.error.length === 0 || operation.result != null) {
      throw new Error(`Failed or uncertain action ${operation.requestId} has an invalid error state`);
    }
  } else if (
    journalVersion !== ACTION_JOURNAL_VERSION_V1
    && (operation.result != null || operation.error != null)
  ) {
    throw new Error(`Pending action ${operation.requestId} has unexpected terminal data`);
  }
  if (journalVersion === ACTION_JOURNAL_VERSION) {
    if (!Object.values(TRANSACTION_PERSISTENCE).includes(operation.transactionPersistence)) {
      throw new Error(`Action journal transaction persistence is invalid for ${operation.requestId}`);
    }
  }
  if (operation.outbox == null) {
    if (["signed", "broadcasting"].includes(operation.status)) {
      throw new Error(`Action ${operation.requestId} in ${operation.status} state has no transaction outbox`);
    }
    if (journalVersion === ACTION_JOURNAL_VERSION_V1 && Object.hasOwn(operation, "outbox")) {
      throw new Error(`Legacy action ${operation.requestId} unexpectedly contains an outbox field`);
    }
    if (journalVersion === ACTION_JOURNAL_VERSION) {
      if (operation.transactionPersistence === TRANSACTION_PERSISTENCE.DURABLE_OUTBOX) {
        throw new Error(`Durable action ${operation.requestId} has no transaction outbox`);
      }
      if (
        operation.transactionPersistence === TRANSACTION_PERSISTENCE.PENDING
        && !["prepared", "failed"].includes(operation.status)
      ) {
        throw new Error(`Fresh action ${operation.requestId} bypassed its durable transaction outbox`);
      }
      if (
        operation.transactionPersistence === TRANSACTION_PERSISTENCE.LEGACY_HASH_ONLY
        && ["submitted", "uncertain"].includes(operation.status)
        && !operation.sourceTransaction
      ) {
        throw new Error(`Legacy action ${operation.requestId} has no transaction hash`);
      }
    }
    return;
  }
  if (
    journalVersion === ACTION_JOURNAL_VERSION
    && operation.transactionPersistence !== TRANSACTION_PERSISTENCE.DURABLE_OUTBOX
  ) {
    throw new Error(`Action ${operation.requestId} has an outbox without durable persistence provenance`);
  }
  validatePersistedOutbox(operation.outbox, operation);
  if (operation.status !== operation.outbox.status) {
    throw new Error(`Action and transaction outbox status mismatch for ${operation.requestId}`);
  }
  if (!operation.sourceTransaction || operation.sourceTransaction.toLowerCase() !== operation.outbox.transactionHash.toLowerCase()) {
    throw new Error(`Action and transaction outbox hash mismatch for ${operation.requestId}`);
  }
}

function assertOperationTransition(operation, nextStatus) {
  const currentStatus = operation.status;
  if (nextStatus === "failed") return;

  if (nextStatus === "uncertain") {
    if (
      operation.transactionPersistence === TRANSACTION_PERSISTENCE.DURABLE_OUTBOX
      || operation.transactionPersistence === TRANSACTION_PERSISTENCE.LEGACY_HASH_ONLY
    ) return;
    throw new Error(`Action ${operation.requestId} cannot become uncertain before a transaction is persisted`);
  }

  if (nextStatus === "submitted") {
    const durableTransition = operation.transactionPersistence === TRANSACTION_PERSISTENCE.DURABLE_OUTBOX
      && ["signed", "broadcasting", "submitted", "uncertain"].includes(currentStatus);
    const legacyTransition = operation.transactionPersistence === TRANSACTION_PERSISTENCE.LEGACY_HASH_ONLY
      && ["submitted", "uncertain"].includes(currentStatus);
    if (durableTransition || legacyTransition) return;
    throw new Error(`Action ${operation.requestId} must stage a durable transaction before submission`);
  }

  if (nextStatus === "completed") {
    if (currentStatus === "submitted") return;
    throw new Error(`Action ${operation.requestId} cannot complete from status ${currentStatus}`);
  }

  throw new Error(`Action ${operation.requestId} cannot transition from ${currentStatus} to ${nextStatus}`);
}

function validatePersistedOutbox(outbox, operation) {
  if (outbox.version !== OUTBOX_VERSION) throw new Error(`Unsupported transaction outbox for ${operation.requestId}`);
  if (!OUTBOX_STATES.has(outbox.status)) throw new Error(`Invalid transaction outbox status for ${operation.requestId}`);
  if (!Number.isSafeInteger(outbox.broadcastAttempts) || outbox.broadcastAttempts < 0) {
    throw new Error(`Invalid transaction outbox attempt count for ${operation.requestId}`);
  }
  const normalized = normalizeSignedTransaction(outbox);
  if (!sameSignedTransaction(outbox, normalized)) throw new Error(`Transaction outbox mismatch for ${operation.requestId}`);
  for (const field of ["requestId", "action", "amount", "lane"]) {
    if (outbox[field] !== operation[field]) throw new Error(`Transaction outbox ${field} mismatch for ${operation.requestId}`);
  }
  if (outbox.intentHash !== transactionIntentHash(operation, normalized)) {
    throw new Error(`Transaction outbox intent hash mismatch for ${operation.requestId}`);
  }
  if (
    operation.status === "completed"
    && (
      typeof operation.result?.sourceTransaction !== "string"
      || operation.result.sourceTransaction.toLowerCase() !== outbox.transactionHash.toLowerCase()
    )
  ) {
    throw new Error(`Completed action result hash does not match its transaction outbox for ${operation.requestId}`);
  }
}

function normalizeSignedTransaction(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Signed transaction outbox is missing");
  }
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(value.rawTransaction || "")) {
    throw new Error("Signed transaction outbox raw transaction is invalid");
  }
  let transaction;
  try {
    transaction = ethers.Transaction.from(value.rawTransaction);
  } catch (error) {
    throw new Error("Signed transaction outbox cannot be decoded", { cause: error });
  }
  if (!transaction.isSigned() || !transaction.hash || !transaction.from || !transaction.to) {
    throw new Error("Signed transaction outbox must contain a signed contract call");
  }
  if (transaction.chainId <= 0n) throw new Error("Signed transaction outbox chainId must be positive");
  if (transaction.value !== 0n) throw new Error("Signed transaction outbox must not transfer native value");
  const normalized = {
    chainId: transaction.chainId.toString(),
    signer: ethers.getAddress(transaction.from),
    nonce: transaction.nonce.toString(),
    to: ethers.getAddress(transaction.to),
    dataHash: ethers.keccak256(transaction.data),
    rawTransaction: transaction.serialized,
    transactionHash: transaction.hash,
  };
  for (const field of ["chainId", "nonce", "dataHash", "rawTransaction", "transactionHash"]) {
    if (value[field] != null && String(value[field]).toLowerCase() !== normalized[field].toLowerCase()) {
      throw new Error(`Signed transaction outbox ${field} does not match raw transaction`);
    }
  }
  for (const field of ["signer", "to"]) {
    if (value[field] != null && !sameAddress(value[field], normalized[field])) {
      throw new Error(`Signed transaction outbox ${field} does not match raw transaction`);
    }
  }
  return normalized;
}

function transactionIntentHash(operation, transaction) {
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({
    requestId: operation.requestId,
    action: operation.action,
    amount: operation.amount,
    lane: operation.lane,
    chainId: transaction.chainId,
    signer: transaction.signer,
    nonce: transaction.nonce,
    to: transaction.to,
    dataHash: transaction.dataHash,
  })));
}

function sameBusinessIntent(left, right) {
  return left.action === right.action && left.amount === right.amount && left.lane === right.lane;
}

function sameSignedTransaction(left, right) {
  return left.chainId === right.chainId
    && left.nonce === right.nonce
    && sameAddress(left.signer, right.signer)
    && sameAddress(left.to, right.to)
    && left.dataHash.toLowerCase() === right.dataHash.toLowerCase()
    && left.rawTransaction.toLowerCase() === right.rawTransaction.toLowerCase()
    && left.transactionHash.toLowerCase() === right.transactionHash.toLowerCase();
}

function sameAddress(left, right) {
  try {
    return ethers.getAddress(left) === ethers.getAddress(right);
  } catch {
    return false;
  }
}

function safeOperationPatch(patch) {
  const result = {};
  for (const field of ["stage", "messageId", "clientReference", "sourceBlock"]) {
    if (patch[field] !== undefined) result[field] = patch[field];
  }
  return result;
}

function requireOperation(state, requestId) {
  const operation = Object.hasOwn(state.operations, requestId) ? state.operations[requestId] : null;
  if (!operation) throw new Error(`Action journal entry ${requestId} does not exist`);
  return operation;
}

function requireTransactionHash(value, message) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value || "")) throw new Error(message);
}

function appendHistory(operation, entry) {
  operation.history.push(entry);
  operation.history = operation.history.slice(-16);
}

function isIsoTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
