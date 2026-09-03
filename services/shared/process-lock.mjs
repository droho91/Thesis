import { randomBytes } from "node:crypto";
import { link, open, lstat, mkdir, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";

export const PROCESS_LOCK_VERSION = "institutional-process-lock-v1";
const MAX_ACQUIRE_ATTEMPTS = 4;

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
    reclaimOrphaned = false,
    probeProcess = processExists,
    onOrphanReclaimed = defaultOrphanReclaimed,
  } = {},
) {
  requireNonEmptyString(requestedPath, "process lock path");
  requireNonEmptyString(label, "process lock label");
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError("Process lock metadata must be an object.");
  }
  if (typeof reclaimOrphaned !== "boolean") {
    throw new TypeError("Process lock reclaimOrphaned must be a boolean.");
  }
  if (typeof probeProcess !== "function" || typeof onOrphanReclaimed !== "function") {
    throw new TypeError("Process lock recovery hooks must be functions.");
  }

  const lockPath = resolve(requestedPath);
  const owner = Object.freeze({
    version: PROCESS_LOCK_VERSION,
    token: randomBytes(32).toString("hex"),
    pid: process.pid,
    parentPid: process.ppid,
    hostname: hostname(),
    platform: process.platform,
    createdAt: new Date().toISOString(),
    label,
    metadata,
  });
  const serializedOwner = `${JSON.stringify(owner, null, 2)}\n`;
  const candidatePath = publicationCandidatePath(lockPath, owner.token);

  await mkdir(dirname(lockPath), { recursive: true });
  let candidateHandle;
  try {
    // Never publish an empty or partially written owner record. A crash while
    // preparing this private candidate can leave only an unreferenced sibling;
    // contenders cannot mistake it for the public lock path.
    candidateHandle = await open(candidatePath, "wx", 0o600);
    await candidateHandle.writeFile(serializedOwner, "utf8");
    await candidateHandle.sync();
    await candidateHandle.close();
    candidateHandle = undefined;
  } catch (error) {
    await candidateHandle?.close().catch(() => {});
    await unlink(candidatePath).catch(() => {});
    throw new Error(`Could not initialize process lock '${lockPath}'.`, { cause: error });
  }

  let acquiredStat;
  try {
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      try {
        // hard-link creation is an atomic, no-overwrite publication step. The
        // public path therefore appears either absent or fully initialized.
        await link(candidatePath, lockPath);
        // Capture identity from the published name. On Windows, Node may report
        // a different `dev` before and after NTFS hard-link publication even
        // though the file ID is unchanged; comparing the pre-link candidate
        // stat would make every legitimate release fail closed.
        acquiredStat = await lstat(lockPath);
        await assertOwnedPath(lockPath, owner.token, acquiredStat);
        // Cleanup is best-effort: if it is interrupted, observeLock recognizes
        // only this exact sibling/inode pair and can still reclaim a dead owner.
        await unlink(candidatePath).catch(() => {});
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const recovery = reclaimOrphaned
          ? await reclaimConfirmedOrphan(lockPath, { probeProcess })
          : { status: "held", owner: await readPublicOwner(lockPath) };
        if (recovery.status === "reclaimed") {
          onOrphanReclaimed({ lockPath, owner: recovery.owner });
          continue;
        }
        if (recovery.status === "missing") continue;
        throw new ProcessLockHeldError(lockPath, recovery.owner, { cause: error });
      }
    }
    if (!acquiredStat) {
      throw new ProcessLockHeldError(lockPath, await readPublicOwner(lockPath), {
        cause: new Error("process lock acquisition did not converge"),
      });
    }
  } catch (error) {
    await unlink(candidatePath).catch(() => {});
    throw error;
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
      try {
        await unlink(lockPath);
        await unlink(candidatePath).catch(() => {});
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
        `Process lock operation and release both failed for '${lock.lockPath}'. `
          + `Operation: ${errorSummary(operationError)}. Release: ${errorSummary(releaseError)}.`,
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

async function reclaimConfirmedOrphan(lockPath, { probeProcess }) {
  const observed = await observeLock(lockPath);
  if (observed.status !== "present") return observed;
  if (!isLocallyProbeableOwner(observed.record)) {
    return { status: "held", owner: publicOwner(observed.record) };
  }

  let alive;
  try {
    alive = await probeProcess(observed.record.pid);
  } catch {
    alive = true;
  }
  if (alive !== false) return { status: "held", owner: publicOwner(observed.record) };

  const current = await observeLock(lockPath);
  if (current.status !== "present") return current;
  if (!sameObservedLock(observed, current)) {
    return { status: "held", owner: publicOwner(current.record) };
  }

  try {
    await removeExpectedPublicationCandidate(lockPath, current.record, current.stats);
    await unlink(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing" };
    return { status: "held", owner: publicOwner(current.record) };
  }
  return { status: "reclaimed", owner: publicOwner(current.record) };
}

async function removeExpectedPublicationCandidate(lockPath, record, stats) {
  if (stats.nlink !== 2 || typeof record?.token !== "string") return;
  const candidatePath = publicationCandidatePath(lockPath, record.token);
  try {
    const candidateStat = await lstat(candidatePath);
    if (candidateStat.dev === stats.dev && candidateStat.ino === stats.ino) {
      await unlink(candidatePath);
    }
  } catch {
    // The public lock remains authoritative; a missing or unremovable private
    // candidate must not widen which public path can be reclaimed.
  }
}

async function observeLock(lockPath) {
  try {
    const [stats, record] = await Promise.all([lstat(lockPath), readLockRecord(lockPath)]);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return { status: "held", owner: undefined };
    }
    // A crash in the tiny interval between atomic publication and candidate
    // cleanup leaves two links to the same complete record. Accept only that
    // exact, token-derived sibling; arbitrary hard links remain fail-closed.
    if (stats.nlink > 1 && !await isExpectedPublicationLink(lockPath, record, stats)) {
      return { status: "held", owner: undefined };
    }
    return { status: "present", stats, record };
  } catch (error) {
    return error?.code === "ENOENT"
      ? { status: "missing" }
      : { status: "held", owner: undefined };
  }
}

async function isExpectedPublicationLink(lockPath, record, stats) {
  if (stats.nlink !== 2 || typeof record?.token !== "string" || !/^[a-f0-9]{64}$/.test(record.token)) {
    return false;
  }
  try {
    const candidateStat = await lstat(publicationCandidatePath(lockPath, record.token));
    return candidateStat.isFile()
      && !candidateStat.isSymbolicLink()
      && candidateStat.dev === stats.dev
      && candidateStat.ino === stats.ino;
  } catch {
    return false;
  }
}

function publicationCandidatePath(lockPath, token) {
  return `${lockPath}.${token}.candidate`;
}

function isLocallyProbeableOwner(record) {
  return record?.version === PROCESS_LOCK_VERSION
    && typeof record.token === "string"
    && /^[a-f0-9]{64}$/.test(record.token)
    && Number.isSafeInteger(record.pid)
    && record.pid > 0
    && record.hostname === hostname()
    && ownerPlatformMatches(record);
}

function ownerPlatformMatches(record) {
  if (typeof record.platform === "string") return record.platform === process.platform;
  const storePath = record.metadata?.storePath;
  if (typeof storePath !== "string") return false;
  if (/^[a-zA-Z]:[\\/]/.test(storePath)) return process.platform === "win32";
  if (storePath.startsWith("/")) return process.platform !== "win32";
  return false;
}

function sameObservedLock(left, right) {
  return left.stats.dev === right.stats.dev
    && left.stats.ino === right.stats.ino
    && left.record.version === right.record.version
    && left.record.token === right.record.token;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function defaultOrphanReclaimed({ lockPath, owner }) {
  console.warn(
    `[process-lock] Reclaimed orphaned lock '${lockPath}' from dead pid=${owner.pid} on ${owner.hostname}.`,
  );
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
    return publicOwner(await readLockRecord(lockPath));
  } catch {
    return undefined;
  }
}

function publicOwner(record) {
  return {
    version: record.version,
    pid: record.pid,
    parentPid: record.parentPid,
    hostname: record.hostname,
    platform: record.platform,
    createdAt: record.createdAt,
    label: record.label,
    metadata: record.metadata,
  };
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`Expected ${label} to be a non-empty string.`);
  }
}

function errorSummary(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
