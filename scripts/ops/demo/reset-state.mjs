import { createConnection } from "node:net";
import { lstat, realpath, rm } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const targets = [
  ".runtime/institutional-deployment.json",
  ".runtime/institutional-demo-state.json",
  ".runtime/institutional-demo",
  ".runtime/institutional-integration",
  ".runtime/institutional-integration-report.json",
  ".runtime/evidence",
];

export async function assertUiStopped(port = Number(process.env.DEMO_UI_PORT || 5173)) {
  await new Promise((resolveCheck, rejectCheck) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      rejectCheck(new Error("Stop the demo UI before resetting chain and transaction state."));
    });
    socket.once("error", error => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolveCheck();
      else rejectCheck(error);
    });
    socket.setTimeout(2000, () => {
      socket.destroy();
      rejectCheck(new Error("Could not verify that the demo UI is stopped."));
    });
  });
}

export async function resetDemoState(workspaceRoot = root, { check = assertUiStopped, log = console.log } = {}) {
  await check();
  const canonicalRoot = await realpath(workspaceRoot);
  const validated = [];
  for (const target of targets) {
    const path = resolve(canonicalRoot, target);
    const info = await lstat(path).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) continue;
    const local = relative(canonicalRoot, await realpath(path));
    if (info.isSymbolicLink() || !local || local.startsWith("..") || isAbsolute(local)) {
      throw new Error(`Refusing reset target outside the workspace or through a link: ${target}`);
    }
    validated.push({ path, info, target });
  }
  for (const { path, info, target } of validated) {
    await rm(path, { recursive: info.isDirectory(), force: true });
    log(`[demo:reset] removed ${target}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (process.argv.includes("--check") ? assertUiStopped() : resetDemoState()).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
