import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

export async function readJsonIfExists(path) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeJsonAtomic(path, value, { mode = 0o600 } = {}) {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw new RangeError("JSON file mode must be an integer between 0o000 and 0o777");
  }

  const target = resolve(path);
  const parentDirectory = dirname(target);
  await mkdir(parentDirectory, { recursive: true });
  const temporaryPath = `${target}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`;
  let handle;
  let temporaryCreated = false;
  let renamed = false;
  try {
    handle = await open(temporaryPath, "wx", mode);
    temporaryCreated = true;
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, target);
    renamed = true;
    await syncDirectory(parentDirectory);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (temporaryCreated && !renamed) await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!directorySyncUnsupported(error)) throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function directorySyncUnsupported(error) {
  if (["EINVAL", "ENOTSUP"].includes(error?.code)) return true;
  return process.platform === "win32" && ["EACCES", "EISDIR", "EPERM"].includes(error?.code);
}
