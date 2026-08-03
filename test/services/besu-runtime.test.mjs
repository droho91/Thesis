import assert from "node:assert/strict";
import { test } from "node:test";
import {
  providerForRpc,
  readContractCode,
  readLatestBlock,
  rpcCall,
  rpcFetchRequest,
  signerForRpc,
  withManagedNonce,
} from "../../scripts/ops/besu/runtime.mjs";

const ADDRESS = "0x0000000000000000000000000000000000000001";

test("contract-code reader retries transient null BytesLike failures", async () => {
  let attempts = 0;
  const provider = {
    async getCode() {
      attempts += 1;
      if (attempts < 3) throw new TypeError("invalid BytesLike value: null");
      return "0x1234";
    },
  };

  const code = await readContractCode(provider, ADDRESS, {
    label: "B.gateway",
    retries: 2,
    intervalMs: 1,
  });

  assert.equal(code, "0x1234");
  assert.equal(attempts, 3);
});

test("contract-code reader reports a stable diagnostic after retry exhaustion", async () => {
  const provider = { getCode: async () => null };

  await assert.rejects(
    readContractCode(provider, ADDRESS, { label: "B.gateway", retries: 1, intervalMs: 1 }),
    /failed to read B\.gateway bytecode after 2 attempts: eth_getCode returned null/,
  );
});

test("latest-block reader retries transient null responses", async () => {
  let attempts = 0;
  const provider = {
    async getBlock() {
      attempts += 1;
      if (attempts < 3) return null;
      return { number: 42, timestamp: 1_800_000_000 };
    },
  };

  const block = await readLatestBlock(provider, {
    label: "voucher price oracle timestamp block",
    retries: 2,
    intervalMs: 1,
  });

  assert.equal(block.number, 42);
  assert.equal(attempts, 3);
});

test("latest-block reader reports a stable diagnostic after retry exhaustion", async () => {
  const provider = { getBlock: async () => null };

  await assert.rejects(
    readLatestBlock(provider, { label: "debt price oracle timestamp block", retries: 1, intervalMs: 1 }),
    /failed to read debt price oracle timestamp block after 2 attempts: eth_getBlockByNumber returned null/,
  );
});

test("raw RPC calls abort a stalled fetch at the configured deadline", async () => {
  let observedSignal;
  const fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
    observedSignal = options.signal;
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  });

  await assert.rejects(
    rpcCall("http://127.0.0.1:1", "eth_chainId", [], { timeoutMs: 10, fetchImpl }),
    /eth_chainId timed out after 10ms/,
  );
  assert.equal(observedSignal.aborted, true);
});

test("raw RPC calls reject invalid timeout configuration before fetch", async () => {
  let called = false;
  await assert.rejects(
    rpcCall("http://127.0.0.1:1", "eth_chainId", [], {
      timeoutMs: 0,
      fetchImpl: async () => {
        called = true;
      },
    }),
    /positive safe integer/,
  );
  assert.equal(called, false);
});

test("ethers RPC providers inherit the bounded HTTP request deadline", () => {
  const request = rpcFetchRequest("http://127.0.0.1:8545", { timeoutMs: 1_234 });
  assert.equal(request.timeout, 1_234);

  const provider = providerForRpc("http://127.0.0.1:8545", { timeoutMs: 2_345 });
  assert.equal(provider._getConnection().timeout, 2_345);
  provider.destroy();
  assert.throws(
    () => providerForRpc("http://127.0.0.1:8545", { timeoutMs: Number.NaN }),
    /positive safe integer/,
  );
});

test("managed nonce is not advanced when broadcast fails before acceptance", async () => {
  let attempts = 0;
  const observedNonces = [];
  const provider = transactionCountProvider(() => 5);
  const signer = {
    provider,
    async getAddress() { return ADDRESS; },
    async sendTransaction(transaction) {
      observedNonces.push(transaction.nonce);
      attempts += 1;
      if (attempts === 1) throw new Error("broadcast rejected");
      return { hash: `0x${"12".repeat(32)}` };
    },
  };
  withManagedNonce(signer, "test-signer");

  await assert.rejects(signer.sendTransaction({ to: ADDRESS }), /broadcast rejected/);
  await signer.sendTransaction({ to: ADDRESS });
  assert.deepEqual(observedNonces, [5, 5]);
});

test("managed nonce serializes concurrent sends and advances only accepted broadcasts", async () => {
  const observedNonces = [];
  const provider = transactionCountProvider(() => 9);
  const signer = {
    provider,
    async getAddress() { return ADDRESS; },
    async sendTransaction(transaction) {
      observedNonces.push(transaction.nonce);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
      return { hash: `0x${String(transaction.nonce).padStart(64, "0")}` };
    },
  };
  withManagedNonce(signer, "serialized-signer");

  await Promise.all([
    signer.sendTransaction({ to: ADDRESS }),
    signer.sendTransaction({ to: ADDRESS }),
    signer.sendTransaction({ to: ADDRESS }),
  ]);
  assert.deepEqual(observedNonces, [9, 10, 11]);
});

test("managed nonce never moves an ambiguous accepted call to a refreshed nonce", async () => {
  let attempts = 0;
  let networkNonce = 5;
  const observedNonces = [];
  const provider = transactionCountProvider(() => networkNonce);
  const signer = {
    provider,
    async getAddress() { return ADDRESS; },
    async sendTransaction(transaction) {
      observedNonces.push(transaction.nonce);
      attempts += 1;
      if (attempts === 1) {
        networkNonce = 6;
        throw new Error("fetch failed after the node accepted the transaction");
      }
      const error = new Error("nonce too low");
      error.code = "NONCE_EXPIRED";
      throw error;
    },
  };
  withManagedNonce(signer, "ambiguous-signer", { sendRetries: 1 });

  await assert.rejects(
    signer.sendTransaction({ to: ADDRESS }),
    (error) => error.code === "NONCE_EXPIRED" && error.outcomeUncertain === true,
  );
  assert.deepEqual(observedNonces, [5, 5]);
  assert.equal(observedNonces.includes(6), false);
});

test("managed nonce rejects an unbounded or malformed send-retry configuration", () => {
  const signer = {
    provider: transactionCountProvider(() => 0),
    async getAddress() { return ADDRESS; },
    async sendTransaction() { return { hash: `0x${"34".repeat(32)}` }; },
  };
  for (const sendRetries of [Number.NaN, -1, 21, 1.5]) {
    assert.throws(
      () => withManagedNonce({ ...signer }, "invalid-retry-signer", { sendRetries }),
      /sendRetries must be an integer between 0 and 20/,
    );
  }
});

test("signer initialization releases its provider when signer construction fails", async () => {
  let destroyCalls = 0;
  const provider = {
    async getSigner() { throw new Error("injected signer construction failure"); },
    destroy() { destroyCalls += 1; },
  };

  await assert.rejects(
    signerForRpc("http://127.0.0.1:18545", "A", 0, {
      createProvider: () => provider,
      localOperatorKeys: false,
    }),
    /injected signer construction failure/,
  );
  assert.equal(destroyCalls, 1);
});

function transactionCountProvider(currentNonce) {
  return {
    async getTransactionCount() { return currentNonce(); },
    async send(method) {
      assert.equal(method, "eth_getTransactionCount");
      return `0x${currentNonce().toString(16)}`;
    },
  };
}
