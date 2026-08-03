import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { acquireProcessLock } from "./process-lock.mjs";
import { writeJsonAtomic } from "./json-file.mjs";

function clone(value) {
  return structuredClone(value);
}

export class AtomicJsonStore {
  #path;
  #state;
  #queue = Promise.resolve();
  #validate;
  #lock;
  #lifecycle = "open";
  #closePromise = null;

  constructor(path, state, validate, lock) {
    this.#path = resolve(path);
    this.#state = state;
    this.#validate = validate;
    this.#lock = lock;
  }

  static async open(path, { create, validate }) {
    const requestedPath = resolve(path);
    await mkdir(dirname(requestedPath), { recursive: true });
    const absolutePath = join(await realpath(dirname(requestedPath)), basename(requestedPath));
    await assertRegularStoreTarget(absolutePath);
    const lock = await acquireProcessLock(`${absolutePath}.lock`, {
      label: "atomic-json-store",
      metadata: { storePath: absolutePath },
    });
    try {
      await assertRegularStoreTarget(absolutePath);
      let state;
      try {
        state = JSON.parse(await readFile(absolutePath, "utf8"));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        state = await create();
        validate(state);
        await writeJsonAtomic(absolutePath, state);
      }
      validate(state);
      return new AtomicJsonStore(absolutePath, state, validate, lock);
    } catch (openError) {
      try {
        await lock.release();
      } catch (releaseError) {
        throw new AggregateError(
          [openError, releaseError],
          `Atomic JSON store '${absolutePath}' failed to open and release its lock.`,
        );
      }
      throw openError;
    }
  }

  get path() {
    return this.#path;
  }

  snapshot() {
    this.#requireOpen();
    return clone(this.#state);
  }

  async mutate(mutator) {
    this.#requireOpen();
    const operation = this.#queue.then(async () => {
      const draft = clone(this.#state);
      const result = await mutator(draft);
      this.#validate(draft);
      await writeJsonAtomic(this.#path, draft);
      this.#state = draft;
      return result;
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }

  close() {
    if (this.#lifecycle === "closed") return Promise.resolve();
    if (this.#closePromise) return this.#closePromise;
    if (!["open", "close-failed"].includes(this.#lifecycle)) {
      return Promise.reject(new Error(`Atomic JSON store '${this.#path}' is ${this.#lifecycle}.`));
    }

    this.#lifecycle = "closing";
    this.#closePromise = this.#queue.then(async () => {
      await this.#lock.release();
      this.#lifecycle = "closed";
    }).catch((error) => {
      this.#lifecycle = "close-failed";
      this.#closePromise = null;
      throw error;
    });
    return this.#closePromise;
  }

  #requireOpen() {
    if (this.#lifecycle !== "open") {
      throw new Error(`Atomic JSON store '${this.#path}' is ${this.#lifecycle}.`);
    }
  }
}

async function assertRegularStoreTarget(path) {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Atomic JSON store '${path}' must be a regular file, not a symbolic link or special file.`);
    }
    if (stats.nlink > 1) {
      throw new Error(`Atomic JSON store '${path}' must not have multiple hard links.`);
    }
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}
