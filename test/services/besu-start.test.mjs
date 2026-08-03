import assert from "node:assert/strict";
import test from "node:test";

import {
  isTransientComposeWorkingDirectoryError,
  runComposeWithCwdRetry,
} from "../../scripts/ops/besu/start.mjs";

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
