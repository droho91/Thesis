import assert from "node:assert/strict";
import test from "node:test";
import {
  createTransactionWaiter,
  waitForSuccessfulTransaction,
} from "../../services/shared/transaction-receipt.mjs";

test("shared transaction waiter returns only a successful receipt", async () => {
  const transaction = { hash: "0x01", wait: async () => ({ status: 1, blockNumber: 7 }) };
  assert.deepEqual(await waitForSuccessfulTransaction(transaction, { label: "deposit", timeoutMs: 100 }), {
    status: 1,
    blockNumber: 7,
  });

  await assert.rejects(
    waitForSuccessfulTransaction({ hash: "0x02", wait: async () => ({ status: 0 }) }, {
      label: "borrow",
      timeoutMs: 100,
    }),
    /borrow failed; tx=0x02/,
  );
});

test("shared transaction waiter has bounded timeout and injectable stable wording", async () => {
  const waitForReceipt = createTransactionWaiter({
    timeoutMs: 5,
    timeoutMessage: ({ label, hash }) => `${label} timeout:${hash}`,
    failureMessage: ({ label, hash }) => `${label} failure:${hash}`,
  });
  await assert.rejects(
    waitForReceipt({ hash: "0x03", wait: () => new Promise(() => {}) }, "relay"),
    /relay timeout:0x03/,
  );
});

test("shared transaction waiter rejects malformed transaction and timer configuration", async () => {
  assert.throws(() => createTransactionWaiter({ timeoutMs: 0 }), /positive safe timer interval/);
  await assert.rejects(
    waitForSuccessfulTransaction({}, { timeoutMs: 100 }),
    /Transaction must expose wait/,
  );
});
