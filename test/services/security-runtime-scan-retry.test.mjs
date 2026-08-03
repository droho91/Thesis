import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isTransientInstitutionalRuntimeScanRace,
  runHardhatTaskWithRuntimeScanRetry,
} from "../../scripts/verification/security-scenarios.mjs";

const WRITABLE_TEMP_ROOT = process.platform === "win32" ? tmpdir() : "/tmp";

function fileNotFound(path, { code = "ENOENT", name = "FileNotFoundError" } = {}) {
  const cause = Object.assign(new Error(`${code}: missing file`), { code, path });
  const error = new Error(`File ${path} not found`, { cause });
  error.name = name;
  return error;
}

test("runtime scan classifier accepts only exact managed transient files", async (t) => {
  const directory = await mkdtemp(join(WRITABLE_TEMP_ROOT, "security-runtime-scan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const managedRoot = join(directory, ".runtime");
  const runtimeDirectory = join(managedRoot, "institutional-demo", "f2025152-382394A7");
  const outsideDirectory = join(directory, "outside", "f2025152-382394A7");
  await Promise.all([
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(outsideDirectory, { recursive: true }),
  ]);

  const current = join(
    runtimeDirectory,
    `relay-journal.json.7816.${"ab".repeat(16)}.tmp`,
  );
  const legacy = join(
    runtimeDirectory,
    "attestor-0x1111111111111111111111111111111111111111.json.7816.1784740763177.6a1d8f876b29.tmp",
  );
  const activity = join(managedRoot, "institutional-demo-state.json.7816.tmp");
  const currentActivity = join(
    managedRoot,
    `institutional-demo-state.json.7816.${"cd".repeat(16)}.tmp`,
  );

  assert.equal(await isTransientInstitutionalRuntimeScanRace(fileNotFound(current), managedRoot), true);
  assert.equal(await isTransientInstitutionalRuntimeScanRace(fileNotFound(legacy), managedRoot), true);
  assert.equal(await isTransientInstitutionalRuntimeScanRace(fileNotFound(activity), managedRoot), true);
  assert.equal(await isTransientInstitutionalRuntimeScanRace(fileNotFound(currentActivity), managedRoot), true);
  assert.equal(
    await isTransientInstitutionalRuntimeScanRace(
      fileNotFound(join(outsideDirectory, `relay-journal.json.1.${"ab".repeat(16)}.tmp`)),
      managedRoot,
    ),
    false,
  );
  assert.equal(
    await isTransientInstitutionalRuntimeScanRace(
      fileNotFound(join(runtimeDirectory, "MissingContract.sol")),
      managedRoot,
    ),
    false,
  );
  assert.equal(
    await isTransientInstitutionalRuntimeScanRace(fileNotFound(current, { code: "EACCES" }), managedRoot),
    false,
  );
  assert.equal(
    await isTransientInstitutionalRuntimeScanRace(fileNotFound(current, { name: "Error" }), managedRoot),
    false,
  );
});

test("Hardhat task retry is bounded, observable and returns only a successful task result", async () => {
  const transient = new Error("transient managed runtime scan");
  let calls = 0;
  const delays = [];
  const messages = [];
  const outcome = await runHardhatTaskWithRuntimeScanRetry(
    async () => {
      calls += 1;
      if (calls <= 2) throw transient;
      return { passed: 1 };
    },
    {
      classifyError: async (error) => error === transient,
      delay: async (milliseconds) => { delays.push(milliseconds); },
      onRetry: (message) => { messages.push(message); },
    },
  );

  assert.deepEqual(outcome, { result: { passed: 1 }, retries: 2 });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [50, 125]);
  assert.equal(messages.length, 2);
});

test("Hardhat task retry immediately rejects unrelated errors and preserves exhaustion", async () => {
  const unrelated = new Error("missing Solidity source");
  let unrelatedCalls = 0;
  await assert.rejects(
    runHardhatTaskWithRuntimeScanRetry(
      async () => { unrelatedCalls += 1; throw unrelated; },
      {
        classifyError: async () => false,
        delay: async () => assert.fail("unrelated errors must not sleep"),
        onRetry: () => assert.fail("unrelated errors must not log a retry"),
      },
    ),
    (error) => error === unrelated,
  );
  assert.equal(unrelatedCalls, 1);

  const transient = new Error("persistent runtime scan race");
  let transientCalls = 0;
  const delays = [];
  await assert.rejects(
    runHardhatTaskWithRuntimeScanRetry(
      async () => { transientCalls += 1; throw transient; },
      {
        classifyError: async () => true,
        delay: async (milliseconds) => { delays.push(milliseconds); },
        onRetry() {},
      },
    ),
    (error) => error === transient,
  );
  assert.equal(transientCalls, 5);
  assert.deepEqual(delays, [50, 125, 300, 650]);
});
