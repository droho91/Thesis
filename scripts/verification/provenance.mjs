import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

const SOURCE_INPUTS = [
  ".github",
  "config",
  "contracts",
  "demo",
  "docs",
  "scripts",
  "services",
  "test",
  "README.md",
  "DEMO_FLOW.md",
  "PROJECT_MAP.md",
  "TECHNICAL_ACADEMIC_AUDIT.md",
  "hardhat.config.js",
  "package.json",
  "package-lock.json",
];

export async function collectRepositoryProvenance() {
  const [commit, statusOutput, npmVersion, dockerVersion, sourceTree, lockfileSha256] = await Promise.all([
    commandOutput("git", ["rev-parse", "HEAD"]),
    commandOutput("git", ["status", "--porcelain=v1", "--untracked-files=all"]),
    commandOutput(npmCommand(), ["--version"]),
    commandOutput("docker", ["--version"]),
    sourceTreeDigest(),
    sha256File(resolve(process.cwd(), "package-lock.json")),
  ]);
  const changedFiles = statusOutput ? statusOutput.split(/\r?\n/).filter(Boolean) : [];
  return {
    capturedAt: new Date().toISOString(),
    git: {
      commit: commit || null,
      dirty: changedFiles.length > 0,
      changedFileCount: changedFiles.length,
    },
    sourceTreeSha256: sourceTree.sha256,
    sourceFileCount: sourceTree.fileCount,
    packageLockSha256: lockfileSha256,
    tools: {
      node: process.version,
      npm: npmVersion || "unknown",
      docker: dockerVersion || "unavailable",
      platform: `${process.platform}/${process.arch}`,
    },
    formalEvidenceEligible: changedFiles.length === 0,
  };
}

export async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function sourceTreeDigest() {
  const files = [];
  for (const input of SOURCE_INPUTS) await collectFiles(resolve(process.cwd(), input), files);
  files.sort((left, right) => left.localeCompare(right));
  const hash = createHash("sha256");
  for (const file of files) {
    const path = relative(process.cwd(), file).replaceAll("\\", "/");
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return { sha256: hash.digest("hex"), fileCount: files.length };
}

async function collectFiles(path, output) {
  let details;
  try {
    details = await stat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (details.isFile()) {
    output.push(path);
    return;
  }
  if (!details.isDirectory()) return;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) await collectFiles(resolve(path, entry.name), output);
}

function commandOutput(command, args) {
  return new Promise((resolveOutput) => {
    const child = spawn(command, args, { cwd: process.cwd(), env: process.env, shell: false });
    let stdout = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.once("error", () => resolveOutput(""));
    child.once("exit", (code) => resolveOutput(code === 0 ? stdout.trim() : ""));
  });
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
