import { readdir, rm, lstat, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, relative, isAbsolute } from "node:path";

const root = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
// Only disposable outputs. Never clear chain databases, keys, deployments or
// transaction journals: these are required to resume the running demo safely.
const disposable = ["tmp", "coverage", "cache/test-artifacts", "playwright-report",
  "test-results", "blob-report", ".runtime/playwright-results", ".runtime/playwright-deps",
  ".runtime/discarded-assets", ".runtime/service-review.log", ".runtime/final-tests.log", ".runtime/security-review.log"];

for (const target of disposable) await removeOutput(target);
for (const entry of await readdir(resolve(root, ".runtime"), { withFileTypes: true }).catch((error) => {
  if (error.code === "ENOENT") return [];
  throw error;
})) {
  if (entry.isFile() && entry.name.endsWith(".png")) await removeOutput(`.runtime/${entry.name}`);
}

async function removeOutput(target) {
  const path = resolve(root, target);
  const local = relative(root, path);
  if (!local || local.startsWith("..") || isAbsolute(local)) throw new Error("Unsafe cleanup path");
  const info = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return;
  if (info.isSymbolicLink()) throw new Error(`Refusing linked output: ${target}`);
  const canonical = relative(root, await realpath(path));
  if (!canonical || canonical.startsWith("..") || isAbsolute(canonical)) {
    throw new Error(`Refusing output outside workspace: ${target}`);
  }
  await rm(path, { recursive: info.isDirectory(), force: true });
  console.log(`[clean] ${target}`);
}
