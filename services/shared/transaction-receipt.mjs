const DEFAULT_TIMEOUT_MS = 120_000;

export function createTransactionWaiter({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  timeoutMessage = defaultTimeoutMessage,
  failureMessage = defaultFailureMessage,
} = {}) {
  validateOptions(timeoutMs, timeoutMessage, failureMessage);
  return (transaction, label = "Transaction") => waitForSuccessfulTransaction(transaction, {
    label,
    timeoutMs,
    timeoutMessage,
    failureMessage,
  });
}

export async function waitForSuccessfulTransaction(transaction, {
  label = "Transaction",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  timeoutMessage = defaultTimeoutMessage,
  failureMessage = defaultFailureMessage,
} = {}) {
  validateOptions(timeoutMs, timeoutMessage, failureMessage);
  if (!transaction || typeof transaction.wait !== "function") {
    throw new TypeError("Transaction must expose wait()");
  }

  const details = Object.freeze({
    label: String(label),
    hash: transaction.hash,
    timeoutMs,
  });
  let timer;
  try {
    const receipt = await Promise.race([
      transaction.wait(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage(details))), timeoutMs);
      }),
    ]);
    if (!receipt || receipt.status !== 1) throw new Error(failureMessage(details));
    return receipt;
  } finally {
    clearTimeout(timer);
  }
}

function validateOptions(timeoutMs, timeoutMessage, failureMessage) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError("Transaction timeout must be a positive safe timer interval");
  }
  if (typeof timeoutMessage !== "function" || typeof failureMessage !== "function") {
    throw new TypeError("Transaction receipt messages must be functions");
  }
}

function defaultTimeoutMessage({ label, hash, timeoutMs }) {
  return `${label} timed out after ${timeoutMs}ms; tx=${hash}`;
}

function defaultFailureMessage({ label, hash }) {
  return `${label} failed; tx=${hash}`;
}
