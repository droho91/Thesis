import assert from "node:assert/strict";
import test from "node:test";

import {
  isTransientComposeWorkingDirectoryError,
  runComposeWithCwdRetry,
  startupProgressBlocks,
} from "../../scripts/ops/besu/start.mjs";

test("Besu startup accepts one newly finalized QBFT block by default", () => {
  assert.equal(startupProgressBlocks(""), 1);
  assert.equal(startupProgressBlocks("2"), 2);
});

test("Besu startup rejects an invalid progress threshold", () => {
  assert.throws(
    () => startupProgressBlocks("0"),
    /must be an integer between 1 and 100/,
  );
  assert.throws(
    () => startupProgressBlocks("1.5"),
    /must be an integer between 1 and 100/,
  );
});

test("Besu start retries one transient Docker Desktop WSL cwd failure", async () => {
  const calls = [];
  await runComposeWithCwdRetry(["up", "-d", "bank_b_validator_1"], {
    runCommand: async (command, args) => {
      calls.push([command, args]);
      if (calls.length === 1) {
        const error = new Error("docker exited with code 1");
        error.output = 'error in parsing "compose-spec.json": getwd: no such file or directory';
        throw error;
      }
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
});

test("Besu start does not retry unrelated Compose failures", async () => {
  let calls = 0;
  await assert.rejects(
    runComposeWithCwdRetry(["up"], {
      runCommand: async () => {
        calls += 1;
        const error = new Error("docker exited with code 1");
        error.output = "invalid compose project";
        throw error;
      },
    }),
    /docker exited/,
  );
  assert.equal(calls, 1);
});

test("Besu start bounds a repeated transient cwd failure to one retry", async () => {
  let calls = 0;
  const failure = new Error("docker exited with code 1");
  failure.output = "getwd: no such file or directory";
  assert.equal(isTransientComposeWorkingDirectoryError(failure), true);
  await assert.rejects(
    runComposeWithCwdRetry(["up"], {
      runCommand: async () => {
        calls += 1;
        throw failure;
      },
    }),
    /docker exited/,
  );
  assert.equal(calls, 2);
});
