import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function clone(value) {
  return structuredClone(value);
}

export class AtomicJsonStore {
  #path;
  #state;
  #queue = Promise.resolve();
  #validate;

  constructor(path, state, validate) {
    this.#path = resolve(path);
    this.#state = state;
    this.#validate = validate;
  }

  static async open(path, { create, validate }) {
    const absolutePath = resolve(path);
    let state;
    try {
      state = JSON.parse(await readFile(absolutePath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      state = await create();
      validate(state);
      await writeAtomically(absolutePath, state);
    }
    validate(state);
    return new AtomicJsonStore(absolutePath, state, validate);
  }

  get path() {
    return this.#path;
  }

  snapshot() {
    return clone(this.#state);
  }

  async mutate(mutator) {
    const operation = this.#queue.then(async () => {
      const draft = clone(this.#state);
      const result = await mutator(draft);
      this.#validate(draft);
      await writeAtomically(this.#path, draft);
      this.#state = draft;
      return result;
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }
}

async function writeAtomically(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const handle = await open(temporaryPath, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}
