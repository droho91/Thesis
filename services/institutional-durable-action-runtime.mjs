import { ethers } from "ethers";

const DEFAULT_TRANSACTION_TIMEOUT_MS = positiveMilliseconds(
  process.env.INSTITUTIONAL_TX_TIMEOUT_MS || 90_000,
  "INSTITUTIONAL_TX_TIMEOUT_MS",
);

const durableExecutionQueues = new WeakMap();

export class ActiveExecutionTracker {
  #active = new Set();

  track(execution) {
    const promise = Promise.resolve(execution);
    this.#active.add(promise);
    promise.then(
      () => this.#active.delete(promise),
      () => this.#active.delete(promise),
    );
    return promise;
  }

  get size() {
    return this.#active.size;
  }

  async waitForIdle() {
    while (this.#active.size > 0) {
      await Promise.allSettled([...this.#active]);
    }
  }
}

export async function recoverUnresolvedActionJournal({ actionJournal, executeAction, onError = null }) {
  if (!actionJournal || typeof actionJournal.unresolved !== "function") {
    throw new TypeError("Action recovery requires a journal with unresolved()");
  }
  if (typeof executeAction !== "function") throw new TypeError("Action recovery requires an executeAction function");
  const recovered = [];
  for (const operation of [...actionJournal.unresolved()].reverse()) {
    try {
      const result = await executeAction({
        requestId: operation.requestId,
        action: operation.action,
        amount: operation.amount,
      });
      recovered.push({ requestId: operation.requestId, ok: true, result });
    } catch (error) {
      recovered.push({ requestId: operation.requestId, ok: false, error });
      if (typeof onError === "function") {
        try {
          await onError(error, structuredClone(operation));
        } catch {
          // Recovery diagnostics are a projection and cannot alter journal state.
        }
      }
      break;
    }
  }
  return recovered;
}

export function executeDurableTransaction(options) {
  const actionJournal = options?.actionJournal;
  if (!actionJournal || typeof actionJournal.get !== "function") {
    return Promise.reject(new TypeError("A durable action journal is required"));
  }
  const previous = durableExecutionQueues.get(actionJournal) || Promise.resolve();
  const operation = previous.then(async () => {
    try {
      return await executeDurableTransactionOnce(options);
    } catch (error) {
      const outcomeCertain = Boolean(error?.outcomeCertain || Number(error?.receipt?.status ?? -1) === 0);
      if (outcomeCertain) {
        error.outcomeCertain = true;
        const current = actionJournal.get(options.requestId);
        if (current?.outbox && !["completed", "failed"].includes(current.status)) {
          try {
            await actionJournal.fail(options.requestId, error, {
              sourceTransaction: current.outbox.transactionHash,
            });
          } catch (journalError) {
            const aggregate = new AggregateError(
              [error, journalError],
              `Transaction ${current.outbox.transactionHash} failed and its journal could not record the definite outcome`,
            );
            aggregate.outcomeCertain = true;
            aggregate.receipt = error.receipt;
            throw aggregate;
          }
        }
      }
      throw error;
    }
  });
  durableExecutionQueues.set(actionJournal, operation.then(() => undefined, () => undefined));
  return operation;
}

async function executeDurableTransactionOnce({
  actionJournal,
  requestId,
  signer,
  transactionRequest = null,
  label = "institutional transaction",
  patch = {},
  hooks = {},
  faults = {},
  onHookError = null,
  timeoutMs = DEFAULT_TRANSACTION_TIMEOUT_MS,
}) {
  if (!signer?.provider || typeof signer.signTransaction !== "function") {
    throw new TypeError(`${label} requires a signer connected to a provider`);
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`${label} timeout must be a positive safe integer`);
  }
  let operation = actionJournal.get(requestId);
  if (!operation) throw new Error(`Action journal entry ${requestId} does not exist`);
  if (["completed", "failed"].includes(operation.status)) {
    throw new Error(`Final action ${requestId} cannot execute a transaction`);
  }

  let outbox = operation.outbox;
  if (!outbox) {
    if (!transactionRequest || typeof transactionRequest !== "object" || Array.isArray(transactionRequest)) {
      throw new Error(`Request ${requestId} has no transaction request or recoverable outbox`);
    }
    const rawTransaction = await signDurableTransaction(signer, transactionRequest);
    const staged = await actionJournal.stageSignedTransaction(requestId, { rawTransaction }, patch);
    outbox = staged.outbox;
    if (staged.created) {
      await invokeBestEffortHook(
        hooks.afterPersist,
        [structuredClone(outbox), structuredClone(staged.operation)],
        onHookError,
      );
      await faults.afterPersist?.(structuredClone(outbox), structuredClone(staged.operation));
    }
  }

  await assertOutboxExecutionContext(outbox, signer, label);
  let known = await findKnownTransaction(signer.provider, outbox.transactionHash);
  if (known.receipt) {
    outbox = await markOutboxSubmitted(actionJournal, requestId, outbox.transactionHash, patch, hooks, onHookError);
    return assertSuccessfulReceipt(known.receipt, outbox.transactionHash, label);
  }
  if (known.transaction) {
    assertTransactionHash(known.transaction, outbox.transactionHash, `${label} pending transaction`);
    outbox = await markOutboxSubmitted(actionJournal, requestId, outbox.transactionHash, patch, hooks, onHookError);
    return waitForDurableReceipt(signer.provider, outbox.transactionHash, label, timeoutMs);
  }

  operation = await actionJournal.broadcasting(requestId, patch);
  outbox = operation.outbox;
  await invokeBestEffortHook(
    hooks.onBroadcasting,
    [structuredClone(outbox), structuredClone(operation)],
    onHookError,
  );
  let transaction;
  try {
    transaction = await signer.provider.broadcastTransaction(outbox.rawTransaction);
  } catch (broadcastError) {
    try {
      known = await findKnownTransaction(signer.provider, outbox.transactionHash);
    } catch (reconciliationError) {
      throw new AggregateError(
        [broadcastError, reconciliationError],
        `${label} broadcast failed and its exact hash could not be reconciled`,
      );
    }
    if (known.receipt) {
      outbox = await markOutboxSubmitted(
        actionJournal,
        requestId,
        outbox.transactionHash,
        patch,
        hooks,
        onHookError,
      );
      return assertSuccessfulReceipt(known.receipt, outbox.transactionHash, label);
    }
    if (known.transaction) {
      assertTransactionHash(known.transaction, outbox.transactionHash, `${label} recovered transaction`);
      outbox = await markOutboxSubmitted(
        actionJournal,
        requestId,
        outbox.transactionHash,
        patch,
        hooks,
        onHookError,
      );
      return waitForDurableReceipt(signer.provider, outbox.transactionHash, label, timeoutMs);
    }
    throw broadcastError;
  }

  assertTransactionHash(transaction, outbox.transactionHash, `${label} broadcast response`);
  await invokeBestEffortHook(hooks.afterBroadcast, [structuredClone(outbox), transaction], onHookError);
  await faults.afterBroadcast?.(structuredClone(outbox), transaction);
  outbox = await markOutboxSubmitted(
    actionJournal,
    requestId,
    outbox.transactionHash,
    patch,
    hooks,
    onHookError,
  );
  return waitForDurableReceipt(signer.provider, outbox.transactionHash, label, timeoutMs);
}

async function signDurableTransaction(signer, transactionRequest) {
  const signerAddress = ethers.getAddress(await signer.getAddress());
  const network = await signer.provider.getNetwork();
  const chainId = BigInt(network.chainId);
  if (chainId <= 0n) throw new Error("Durable transaction provider chainId must be positive");
  const nonce = await durableNetworkNonce(signer.provider, signerAddress);
  const request = {
    ...transactionRequest,
    chainId,
    nonce,
    from: signerAddress,
  };
  if (request.gasPrice == null && request.maxFeePerGas == null && request.maxPriorityFeePerGas == null) {
    request.type ??= 0;
    request.gasPrice = 0n;
  }
  const populated = await signer.populateTransaction(request);
  const rawTransaction = await signer.signTransaction(populated);
  const signed = ethers.Transaction.from(rawTransaction);
  if (
    !signed.isSigned()
    || !signed.from
    || ethers.getAddress(signed.from) !== signerAddress
    || signed.chainId !== chainId
    || signed.nonce !== nonce
  ) {
    throw new Error("Signer changed the durable transaction identity while signing");
  }
  if (populated.to != null && (!signed.to || ethers.getAddress(signed.to) !== ethers.getAddress(populated.to))) {
    throw new Error("Signer changed the durable transaction destination while signing");
  }
  if (signed.data.toLowerCase() !== String(populated.data || "0x").toLowerCase()) {
    throw new Error("Signer changed the durable transaction calldata while signing");
  }
  if (signed.value !== BigInt(populated.value ?? 0)) {
    throw new Error("Signer changed the durable transaction value while signing");
  }
  return rawTransaction;
}

async function durableNetworkNonce(provider, address) {
  const readers = [
    () => provider.getTransactionCount(address, "latest"),
    () => provider.getTransactionCount(address, "pending"),
  ];
  if (typeof provider.send === "function") {
    readers.push(
      () => provider.send("eth_getTransactionCount", [address, "latest"]),
      () => provider.send("eth_getTransactionCount", [address, "pending"]),
    );
  }
  const results = await Promise.allSettled(readers.map((read) => Promise.resolve().then(read)));
  const nonces = results
    .filter((result) => result.status === "fulfilled")
    .map((result) => BigInt(result.value));
  if (nonces.length === 0) {
    throw new AggregateError(
      results.map((result) => result.reason).filter(Boolean),
      `Could not read the latest or pending nonce for ${address}`,
    );
  }
  const nonce = nonces.reduce((highest, candidate) => candidate > highest ? candidate : highest, 0n);
  if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Network nonce for ${address} exceeds safe integer range`);
  return Number(nonce);
}

async function assertOutboxExecutionContext(outbox, signer, label) {
  const [signerAddress, network] = await Promise.all([signer.getAddress(), signer.provider.getNetwork()]);
  if (ethers.getAddress(signerAddress) !== ethers.getAddress(outbox.signer)) {
    throw new Error(`${label} outbox signer does not match the active signer`);
  }
  if (BigInt(network.chainId).toString() !== outbox.chainId) {
    throw new Error(`${label} outbox chain does not match the active provider`);
  }
}

async function findKnownTransaction(provider, transactionHash) {
  const receipt = await provider.getTransactionReceipt(transactionHash);
  if (receipt) return { receipt, transaction: null };
  const transaction = await provider.getTransaction(transactionHash);
  return { receipt: null, transaction };
}

async function markOutboxSubmitted(actionJournal, requestId, transactionHash, patch, hooks, onHookError) {
  const operation = await actionJournal.submitted(requestId, transactionHash, patch);
  await invokeBestEffortHook(
    hooks.onSubmitted,
    [structuredClone(operation.outbox), structuredClone(operation)],
    onHookError,
  );
  return operation.outbox;
}

async function invokeBestEffortHook(hook, arguments_, onHookError) {
  if (typeof hook !== "function") return;
  try {
    await hook(...arguments_);
  } catch (error) {
    if (typeof onHookError !== "function") return;
    try {
      await onHookError(error);
    } catch {
      // Observability failures must never change the durable transaction outcome.
    }
  }
}

async function waitForDurableReceipt(provider, transactionHash, label, timeoutMs) {
  const receipt = await provider.waitForTransaction(transactionHash, 1, timeoutMs);
  if (!receipt) throw new Error(`${label} timed out; tx=${transactionHash}`);
  return assertSuccessfulReceipt(receipt, transactionHash, label);
}

function assertTransactionHash(transaction, expectedHash, label) {
  const actualHash = transaction?.hash || transaction?.transactionHash;
  if (!/^0x[0-9a-fA-F]{64}$/.test(actualHash || "") || actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error(`${label} hash does not match the durable transaction outbox`);
  }
}

function assertSuccessfulReceipt(receipt, expectedHash, label) {
  assertTransactionHash(receipt, expectedHash, `${label} receipt`);
  if (Number(receipt.status) !== 1) {
    const error = certainError(`${label} reverted on-chain; tx=${expectedHash}`);
    error.receipt = receipt;
    throw error;
  }
  return receipt;
}

export function transactionOutcomeIsUncertain(error, sourceTransaction) {
  return Boolean(
    sourceTransaction
    && !error?.outcomeCertain
    && Number(error?.receipt?.status ?? -1) !== 0
  );
}

function certainError(message) {
  const error = new Error(message);
  error.outcomeCertain = true;
  return error;
}

function positiveMilliseconds(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) {
    throw new RangeError(`${label} must be an integer between 1 and 2147483647 milliseconds`);
  }
  return parsed;
}
