import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { AtomicJsonStore } from "../../services/shared/atomic-json-store.mjs";
import { ProcessLockHeldError } from "../../services/shared/process-lock.mjs";
import { RelayJournal } from "../../services/institutional-relay/relay-journal.mjs";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const RELAY_JOURNAL_MODULE = pathToFileURL(resolve(TEST_DIRECTORY, "../../services/institutional-relay/relay-journal.mjs")).href;

function storeOptions() {
  return {
    create: () => ({ version: "atomic-store-test-v1", value: 0 }),
    validate(state) {
      if (state?.version !== "atomic-store-test-v1" || !Number.isSafeInteger(state.value)) {
        throw new Error("Invalid atomic store test state");
      }
    },
  };
}

test("AtomicJsonStore fails closed for a second owner and can reopen after explicit close", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atomic-json-store-"));
  const path = join(directory, "journal.json");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await AtomicJsonStore.open(path, storeOptions());

  await assert.rejects(
    AtomicJsonStore.open(path, storeOptions()),
    (error) => error instanceof ProcessLockHeldError && error.code === "INSTITUTIONAL_PROCESS_LOCK_HELD",
  );
  await first.close();

  const reopened = await AtomicJsonStore.open(path, storeOptions());
  await reopened.mutate((state) => { state.value = 1; });
  assert.equal(reopened.snapshot().value, 1);
  await reopened.close();
  await assert.rejects(async () => reopened.snapshot(), /is closed/);
});

test("a separate process cannot open the same relay journal while its owner is alive", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "relay-journal-process-lock-"));
  const path = join(directory, "relay-journal.json");
  const journal = await RelayJournal.open(path);
  t.after(async () => {
    await journal.close();
    await rm(directory, { recursive: true, force: true });
  });

  const source = `
    import { RelayJournal } from ${JSON.stringify(RELAY_JOURNAL_MODULE)};
    try {
      const journal = await RelayJournal.open(${JSON.stringify(path)});
      await journal.close();
      console.log("UNEXPECTED_OPEN");
      process.exitCode = 2;
    } catch (error) {
      console.log(error?.code || error?.name || "UNKNOWN_ERROR");
      process.exitCode = error?.code === "INSTITUTIONAL_PROCESS_LOCK_HELD" ? 0 : 3;
    }
  `;
  const result = await runNode(source);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /INSTITUTIONAL_PROCESS_LOCK_HELD/);
  assert.doesNotMatch(result.stdout, /UNEXPECTED_OPEN/);
});

test("AtomicJsonStore close refuses a replaced ownership token and preserves the lock", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atomic-json-store-owner-"));
  const path = join(directory, "journal.json");
  const lockPath = `${path}.lock`;
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await AtomicJsonStore.open(path, storeOptions());
  const owner = JSON.parse(await readFile(lockPath, "utf8"));
  await writeFile(lockPath, `${JSON.stringify({ ...owner, token: "00".repeat(32) }, null, 2)}\n`, "utf8");

  await assert.rejects(store.close(), /ownership token does not match/);
  await access(lockPath);
  await writeFile(lockPath, `${JSON.stringify(owner, null, 2)}\n`, "utf8");
  await store.close();
  await assert.rejects(async () => store.snapshot(), /is closed/);
});

test("canonical journal paths share one lock and symbolic-link store files are rejected", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atomic-json-store-alias-"));
  const realDirectory = join(directory, "real");
  const aliasDirectory = join(directory, "alias");
  const path = join(realDirectory, "journal.json");
  await mkdir(realDirectory);
  await symlink(realDirectory, aliasDirectory, "dir");
  t.after(() => rm(directory, { recursive: true, force: true }));

  const store = await AtomicJsonStore.open(path, storeOptions());
  await assert.rejects(
    AtomicJsonStore.open(join(aliasDirectory, "journal.json"), storeOptions()),
    (error) => error instanceof ProcessLockHeldError,
  );
  await store.close();

  const fileAlias = join(realDirectory, "journal-alias.json");
  await symlink(path, fileAlias);
  await assert.rejects(
    AtomicJsonStore.open(fileAlias, storeOptions()),
    /must be a regular file, not a symbolic link/,
  );
});

function runNode(source) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}
