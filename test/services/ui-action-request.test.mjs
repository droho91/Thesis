import assert from "node:assert/strict";
import test from "node:test";
import {
  ActionRequestIntentConflictError,
  createActionRequestStore,
  requestOutcomeUncertain,
} from "../../demo/action-request.js";

test("ambiguous runtime and transport failures retain the action idempotency key", () => {
  for (const error of [
    { statusCode: 500, payload: { operation: { status: "uncertain" } } },
    { statusCode: 409, payload: { operation: { status: "submitted" } } },
    { statusCode: 500, payload: { operation: { status: "broadcasting" } } },
    { message: "Failed to fetch" },
    { outcomeUncertain: true, statusCode: 200 },
  ]) {
    assert.equal(requestOutcomeUncertain(error), true);
  }
});

test("conclusive failures and pre-runtime request rejection may clear the key", () => {
  assert.equal(requestOutcomeUncertain({
    statusCode: 500,
    payload: { operation: { status: "failed" } },
  }), false);
  assert.equal(requestOutcomeUncertain({
    statusCode: 200,
    payload: { operation: { status: "completed" } },
  }), false);
  assert.equal(requestOutcomeUncertain({ statusCode: 403, code: "CSRF_TOKEN_INVALID" }), false);
  assert.equal(requestOutcomeUncertain({ statusCode: 400, message: "Invalid amount" }), false);
});

test("disabled browser storage still retains one request ID until a definite outcome", () => {
  let sequence = 0;
  const requests = createActionRequestStore({
    getStorage() { throw new Error("sessionStorage disabled"); },
    randomId: () => `request-memory-${++sequence}`,
  });

  const first = requests.get("borrow", "1.000000000000000001");
  assert.deepEqual(requests.get("borrow", "1.000000000000000001"), first);
  assert.equal(sequence, 1);
  requests.clear("borrow");
  assert.notEqual(requests.get("borrow", "1.000000000000000001").requestId, first.requestId);
  assert.equal(sequence, 2);
});

test("a storage write failure falls back to the complete intent already retained in memory", () => {
  let sequence = 0;
  const storage = {
    getItem() { return null; },
    setItem() { throw new Error("quota unavailable"); },
    removeItem() {},
  };
  const requests = createActionRequestStore({
    getStorage: () => storage,
    randomId: () => `request-quota-${++sequence}`,
  });

  const intent = { requestId: "request-quota-1", action: "deposit", amount: "10.25" };
  assert.deepEqual(requests.get("deposit", "10.2500"), intent);
  assert.deepEqual(requests.get("deposit", "10.25"), intent);
  assert.equal(sequence, 1);
});

test("an uncertain request is bound to its exact action and 18-decimal amount", () => {
  const values = new Map();
  const storage = {
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
  const requests = createActionRequestStore({
    getStorage: () => storage,
    randomId: () => "request-exact-intent",
  });

  const intent = requests.get("repay", "0.000000000000000001");
  assert.deepEqual(JSON.parse(values.get("institutional-request:repay")), intent);
  assert.deepEqual(requests.get("repay", "0.000000000000000001"), intent);
  assert.throws(
    () => requests.get("repay", "0.000000000000000002"),
    (error) => error instanceof ActionRequestIntentConflictError
      && error.existing.requestId === intent.requestId,
  );
});

test("full repayment retries retain one intent when the accrued debt quote changes", () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key),
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  let sequence = 0;
  const options = { getStorage: () => storage, randomId: () => `request-full-repay-${++sequence}` };
  const first = createActionRequestStore(options).get("repayAll", "100");
  const reloaded = createActionRequestStore(options);
  assert.deepEqual(reloaded.get("repayAll", "100.0001"), first);
  assert.equal(sequence, 1);
  reloaded.clear("repayAll");
  assert.notEqual(reloaded.get("repayAll", "10").requestId, first.requestId);
});

test("status reconciliation clears only the matching finalized request", () => {
  for (const persistent of [false, true]) {
    const values = new Map();
    const storage = {
      getItem: key => values.get(key),
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key),
    };
    let sequence = 0;
    const options = { getStorage: () => persistent ? storage : null, randomId: () => `request-reconcile-${++sequence}` };
    const firstStore = createActionRequestStore(options);
    const first = firstStore.get("repayAll", "100");
    const requests = persistent ? createActionRequestStore(options) : firstStore;
    requests.reconcile([
      null,
      { action: "repayAll", amount: "100", status: "completed" },
      { requestId: "", action: "repayAll", status: "completed" },
      { ...first, status: "uncertain" },
      { ...first, status: "submitted" },
      { ...first, requestId: "request-unrelated-0001", status: "completed" },
      { ...first, action: "borrow", status: "completed" },
    ]);
    assert.deepEqual(requests.get("repayAll", "100.0001"), first);
    requests.reconcile([{ ...first, status: "completed" }]);
    assert.notEqual(requests.get("repayAll", "200").requestId, first.requestId);
  }
});

test("a failed request releases its finite amount only after matching status confirmation", () => {
  let sequence = 0;
  const requests = createActionRequestStore({ randomId: () => `request-final-failure-${++sequence}` });
  const first = requests.get("repay", "5");
  assert.throws(() => requests.get("repay", "6"), ActionRequestIntentConflictError);
  requests.reconcile([{ ...first, status: "failed" }]);
  const next = requests.get("repay", "6");
  assert.notEqual(next.requestId, first.requestId);
  assert.equal(next.amount, "6");
});
