import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PROCESS_LOCK_VERSION,
  ProcessLockHeldError,
  ProcessLockOwnershipError,
  acquireProcessLock,
  withProcessLock,
} from "../../scripts/verification/process-lock.mjs";

const WRITABLE_TEMP_ROOT = process.platform === "win32" ? tmpdir() : "/tmp";

async function fixture(t) {
  const root = await mkdtemp(join(WRITABLE_TEMP_ROOT, "institutional-process-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, lockPath: join(root, "evidence.lock") };
}

async function assertMissing(path) {
  await assert.rejects(access(path), (error) => error?.code === "ENOENT");
}

test("exclusive creation permits exactly one concurrent lock owner", async (t) => {
  const { lockPath } = await fixture(t);
  const attempts = await Promise.allSettled(Array.from(
    { length: 9 },
    (_, index) => acquireProcessLock(lockPath, { label: `runner-${index}` }),
  ));
  const acquired = attempts.filter(({ status }) => status === "fulfilled");
  const rejected = attempts.filter(({ status }) => status === "rejected");
  assert.equal(acquired.length, 1);
  assert.equal(rejected.length, 8);
  for (const attempt of rejected) {
    assert.equal(attempt.reason instanceof ProcessLockHeldError, true);
    assert.equal(attempt.reason.code, "INSTITUTIONAL_PROCESS_LOCK_HELD");
    if (attempt.reason.owner !== undefined) {
      assert.equal("token" in attempt.reason.owner, false);
    }
  }

  const winner = acquired[0].value;
  await assert.rejects(
    acquireProcessLock(lockPath, { label: "late-competitor" }),
    (error) => error instanceof ProcessLockHeldError
      && error.owner.label === winner.owner.label
      && !("token" in error.owner),
  );

  await winner.release();
  await assertMissing(lockPath);

  const successor = await acquireProcessLock(lockPath, { label: "successor" });
  await successor.release();
  await assertMissing(lockPath);
});

test("withProcessLock releases after success and after operation failure", async (t) => {
  const { lockPath } = await fixture(t);
  const result = await withProcessLock(lockPath, async (lock) => {
    assert.equal(lock.owner.version, PROCESS_LOCK_VERSION);
    await assert.rejects(acquireProcessLock(lockPath), ProcessLockHeldError);
    return "completed";
  });
  assert.equal(result, "completed");
  await assertMissing(lockPath);

  await assert.rejects(
    withProcessLock(lockPath, async () => {
      throw new Error("operation failed");
    }),
    /operation failed/,
  );
  await assertMissing(lockPath);
});

test("release refuses a tampered ownership token and preserves the lock", async (t) => {
  const { lockPath } = await fixture(t);
  const lock = await acquireProcessLock(lockPath, { metadata: { artifact: "security.json" } });
  const original = JSON.parse(await readFile(lockPath, "utf8"));
  await writeFile(lockPath, `${JSON.stringify({ ...original, token: "0".repeat(64) }, null, 2)}\n`, "utf8");

  await assert.rejects(
    lock.release(),
    (error) => error instanceof ProcessLockOwnershipError
      && error.code === "INSTITUTIONAL_PROCESS_LOCK_OWNERSHIP"
      && /ownership token does not match/.test(error.message),
  );
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).token, "0".repeat(64));

  await writeFile(lockPath, `${JSON.stringify(original, null, 2)}\n`, "utf8");
  await lock.release();
  await assertMissing(lockPath);
});

test("release is idempotent only after a verified successful release", async (t) => {
  const { lockPath } = await fixture(t);
  const lock = await acquireProcessLock(lockPath);

  await lock.release();
  await lock.release();
  await assertMissing(lockPath);
});
