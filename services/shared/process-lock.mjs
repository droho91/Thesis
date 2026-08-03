import { randomBytes } from "node:crypto";
import { open, lstat, mkdir, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";

export const PROCESS_LOCK_VERSION = "institutional-process-lock-v1";

export class ProcessLockHeldError extends Error {
  constructor(lockPath, owner, options = {}) {
    const ownerSummary = owner === undefined
      ? "owner metadata is unavailable"
      : `pid=${String(owner.pid)}, host=${String(owner.hostname)}, createdAt=${String(owner.createdAt)}`;
    super(`Process lock '${lockPath}' is already held (${ownerSummary}).`, options);
    this.name = "ProcessLockHeldError";
    this.code = "INSTITUTIONAL_PROCESS_LOCK_HELD";
    this.lockPath = lockPath;
    this.owner = owner;
  }
}

export class ProcessLockOwnershipError extends Error {
  constructor(lockPath, reason, options = {}) {
    super(`Refusing to release process lock '${lockPath}': ${reason}.`, options);
    this.name = "ProcessLockOwnershipError";
    this.code = "INSTITUTIONAL_PROCESS_LOCK_OWNERSHIP";
    this.lockPath = lockPath;
  }
}

export async function acquireProcessLock(
  requestedPath,
  {
    label = "institutional-evidence-runner",
    metadata = {},
  } = {},
) {
  requireNonEmptyString(requestedPath, "process lock path");
  requireNonEmptyString(label, "process lock label");
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError("Process lock metadata must be an object.");
  }

  const lockPath = resolve(requestedPath);
  const owner = Object.freeze({
    version: PROCESS_LOCK_VERSION,
    token: randomBytes(32).toString("hex"),
    pid: process.pid,
    parentPid: process.ppid,
    hostname: hostname(),
    createdAt: new Date().toISOString(),
    label,
    metadata,
  });
  const serializedOwner = `${JSON.stringify(owner, null, 2)}\n`;

  await mkdir(dirname(lockPath), { recursive: true });
  let fileHandle;
  try {
    fileHandle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    throw new ProcessLockHeldError(lockPath, await readPublicOwner(lockPath), { cause: error });
  }

  let acquiredStat;
  try {
    await fileHandle.writeFile(serializedOwner, "utf8");
    await fileHandle.sync();
    acquiredStat = await fileHandle.stat();
  } catch (error) {
    // An incompletely initialized lock remains fail-closed. Removing it here
    // could unlink a path that another actor replaced after creation.
    await fileHandle.close().catch(() => {});
    throw new Error(`Could not initialize process lock '${lockPath}'.`, { cause: error });
  }

  let state = "held";

  return Object.freeze({
    lockPath,
    owner,
    async release() {
      if (state === "released") return;
      if (state !== "held") {
        throw new ProcessLockOwnershipError(lockPath, "the local lock handle is no longer releasable");
      }

      await assertOwnedPath(lockPath, owner.token, acquiredStat);
      state = "releasing";
      await fileHandle.close();
      try {
        // Re-check after closing the descriptor for cross-platform deletion.
        await assertOwnedPath(lockPath, owner.token, acquiredStat);
        await unlink(lockPath);
        state = "released";
      } catch (error) {
        state = "unreleasable";
        if (error instanceof ProcessLockOwnershipError) throw error;
        throw new ProcessLockOwnershipError(lockPath, "the owned lock could not be removed", { cause: error });
      }
    },
  });
}

export async function withProcessLock(lockPath, operation, options = {}) {
  if (typeof operation !== "function") {
    throw new TypeError("Process lock operation must be a function.");
  }

  const lock = await acquireProcessLock(lockPath, options);
  let operationResult;
  let operationError;
  let operationFailed = false;
  try {
    operationResult = await operation(lock);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  try {
    await lock.release();
  } catch (releaseError) {
    if (operationFailed) {
      throw new AggregateError(
        [operationError, releaseError],
        `Process lock operation and release both failed for '${lock.lockPath}'.`,
      );
    }
    throw releaseError;
  }

  if (operationFailed) throw operationError;
  return operationResult;
}

async function assertOwnedPath(lockPath, expectedToken, acquiredStat) {
  let currentStat;
  let record;
  try {
    [currentStat, record] = await Promise.all([
      lstat(lockPath),
      readLockRecord(lockPath),
    ]);
  } catch (error) {
    throw new ProcessLockOwnershipError(lockPath, "the lock path is missing or unreadable", { cause: error });
  }

  if (!currentStat.isFile() || currentStat.isSymbolicLink()) {
    throw new ProcessLockOwnershipError(lockPath, "the lock path is no longer a regular file");
  }
  if (currentStat.dev !== acquiredStat.dev || currentStat.ino !== acquiredStat.ino) {
    throw new ProcessLockOwnershipError(lockPath, "the lock file identity changed");
  }
  if (record.version !== PROCESS_LOCK_VERSION || record.token !== expectedToken) {
    throw new ProcessLockOwnershipError(lockPath, "the ownership token does not match");
  }
}

async function readLockRecord(lockPath) {
  const parsed = JSON.parse(await readFile(lockPath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Process lock record is not an object.");
  }
  return parsed;
}

async function readPublicOwner(lockPath) {
  try {
    const record = await readLockRecord(lockPath);
    return {
      version: record.version,
      pid: record.pid,
      parentPid: record.parentPid,
      hostname: record.hostname,
      createdAt: record.createdAt,
      label: record.label,
      metadata: record.metadata,
    };
  } catch {
    return undefined;
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`Expected ${label} to be a non-empty string.`);
  }
}
