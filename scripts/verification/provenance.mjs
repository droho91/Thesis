import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const SOURCE_INPUTS = Object.freeze([
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
]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

export async function collectRepositoryProvenance(
  environment = process.env,
  {
    runCommand = commandOutput,
    root = process.cwd(),
    sourceInputs = SOURCE_INPUTS,
  } = {},
) {
  const repositoryRoot = resolve(root);
  await assertSafeRepositoryRoot(repositoryRoot);
  const npm = npmInvocation();
  const [
    commitResult,
    statusResult,
    indexFlagsResult,
    headDiffResult,
    npmResult,
    dockerResult,
    sourceTree,
    lockfileSha256,
  ] = await Promise.all([
    invokeCommand(runCommand, "git", ["rev-parse", "HEAD"], environment, repositoryRoot),
    invokeCommand(
      runCommand,
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      environment,
      repositoryRoot,
    ),
    invokeCommand(runCommand, "git", ["ls-files", "-v"], environment, repositoryRoot),
    invokeCommand(
      runCommand,
      "git",
      ["diff", "--no-ext-diff", "--name-only", "HEAD", "--"],
      environment,
      repositoryRoot,
    ),
    invokeCommand(runCommand, npm.command, npm.args, environment, repositoryRoot),
    invokeCommand(runCommand, "docker", ["--version"], environment, repositoryRoot),
    sourceTreeDigest(repositoryRoot, sourceInputs),
    sha256File(resolve(repositoryRoot, "package-lock.json")),
  ]);

  const commit = requireSuccessfulCommand(commitResult, "Git commit lookup").trim();
  if (!GIT_COMMIT_PATTERN.test(commit)) {
    throw new Error("Git commit lookup returned an invalid or empty object id");
  }
  const statusOutput = normalizeGitStatus(requireSuccessfulCommand(statusResult, "Git status lookup"));
  const indexFlagsOutput = normalizeGitStatus(
    requireSuccessfulCommand(indexFlagsResult, "Git index-flag lookup"),
  );
  const unsafeIndexEntries = unsafeGitIndexEntries(indexFlagsOutput);
  if (unsafeIndexEntries.length > 0) {
    throw new Error(
      `Git index uses assume-unchanged or skip-worktree for ${unsafeIndexEntries.length} tracked file(s)`,
    );
  }
  const headDiffOutput = normalizeGitStatus(
    requireSuccessfulCommand(headDiffResult, "Git HEAD diff lookup"),
  );
  if (headDiffOutput && !statusOutput) {
    throw new Error("Git tracked contents differ from HEAD despite the provenance status gate");
  }
  const changedFiles = statusOutput ? statusOutput.split("\n").filter(Boolean) : [];
  const dirty = changedFiles.length > 0;
  return {
    capturedAt: new Date().toISOString(),
    git: {
      commit,
      dirty,
      changedFileCount: changedFiles.length,
      statusSha256: sha256Text(statusOutput),
      indexFlagsSha256: sha256Text(indexFlagsOutput),
    },
    sourceTreeSha256: sourceTree.sha256,
    sourceFileCount: sourceTree.fileCount,
    packageLockSha256: lockfileSha256,
    tools: {
      node: process.version,
      npm: optionalCommandOutput(npmResult, "unknown"),
      docker: optionalCommandOutput(dockerResult, "unavailable"),
      platform: `${process.platform}/${process.arch}`,
    },
    formalEvidenceEligible: !dirty,
  };
}

export function assertRepositoryProvenanceStable(initial, final) {
  assertValidProvenanceSnapshot(initial, "initial");
  assertValidProvenanceSnapshot(final, "final");

  const fields = [
    ["Git commit", initial.git.commit, final.git.commit],
    ["Git dirty state", initial.git.dirty, final.git.dirty],
    ["Git changed-file count", initial.git.changedFileCount, final.git.changedFileCount],
    ["Git status checksum", initial.git.statusSha256, final.git.statusSha256],
    ["Git index-flag checksum", initial.git.indexFlagsSha256, final.git.indexFlagsSha256],
    ["source-tree checksum", initial.sourceTreeSha256, final.sourceTreeSha256],
    ["source-file count", initial.sourceFileCount, final.sourceFileCount],
    ["package-lock checksum", initial.packageLockSha256, final.packageLockSha256],
    ["evidence eligibility", initial.formalEvidenceEligible, final.formalEvidenceEligible],
    ["Node version", initial.tools.node, final.tools.node],
    ["npm version", initial.tools.npm, final.tools.npm],
    ["Docker version", initial.tools.docker, final.tools.docker],
    ["host platform", initial.tools.platform, final.tools.platform],
  ];
  const changed = fields.filter(([, before, after]) => before !== after).map(([name]) => name);
  if (changed.length > 0) {
    throw new Error(`Repository provenance changed during evidence execution: ${changed.join(", ")}`);
  }
  return true;
}

export async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function sourceTreeDigest(root, sourceInputs) {
  if (!Array.isArray(sourceInputs) || sourceInputs.length === 0) {
    throw new Error("Source provenance requires a non-empty source input list");
  }
  const files = [];
  for (const input of sourceInputs) {
    const path = resolveSourceInput(root, input);
    await collectFiles(path, files);
  }
  files.sort(comparePaths);
  const hash = createHash("sha256");
  for (const file of files) {
    const details = await lstat(file);
    if (details.isSymbolicLink()) {
      throw new Error(`Source provenance refuses symbolic link '${relative(root, file)}'`);
    }
    if (!details.isFile()) {
      throw new Error(`Source provenance expected a regular file at '${relative(root, file)}'`);
    }
    const path = relative(root, file).replaceAll("\\", "/");
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
    details = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (details.isSymbolicLink()) {
    throw new Error(`Source provenance refuses symbolic link '${path}'`);
  }
  if (details.isFile()) {
    output.push(path);
    return;
  }
  if (!details.isDirectory()) {
    throw new Error(`Source provenance refuses unsupported filesystem entry '${path}'`);
  }
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) await collectFiles(resolve(path, entry.name), output);
}

function commandOutput(command, args, environment, { cwd = process.cwd() } = {}) {
  return new Promise((resolveOutput) => {
    const child = spawn(command, args, { cwd, env: environment, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => resolveOutput({ ok: false, stdout, stderr, error: error.message }));
    child.once("exit", (code, signal) => resolveOutput({
      ok: code === 0,
      stdout,
      stderr,
      code,
      signal,
    }));
  });
}

async function invokeCommand(runCommand, command, args, environment, cwd) {
  try {
    return normalizeCommandResult(await runCommand(command, args, environment, { cwd }));
  } catch (error) {
    return { ok: false, stdout: "", stderr: "", error: error?.message || String(error) };
  }
}

function normalizeCommandResult(result) {
  if (typeof result === "string") return { ok: true, stdout: result, stderr: "" };
  if (result && typeof result === "object" && typeof result.ok === "boolean") {
    return {
      ...result,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
  }
  return { ok: false, stdout: "", stderr: "", error: "command runner returned a malformed result" };
}

function requireSuccessfulCommand(result, label) {
  if (result.ok) return result.stdout;
  const detail = result.error || result.stderr.trim() || `exit ${result.code ?? result.signal ?? "unknown"}`;
  throw new Error(`${label} failed: ${detail}`);
}

function optionalCommandOutput(result, fallback) {
  if (!result.ok) return fallback;
  return result.stdout.trim() || fallback;
}

function normalizeGitStatus(value) {
  return value.replaceAll("\r\n", "\n").replace(/\n+$/, "");
}

export function unsafeGitIndexEntries(value) {
  if (typeof value !== "string") return ["malformed-index-output"];
  return normalizeGitStatus(value).split("\n").filter((line) => {
    if (!line) return false;
    const tag = line[0];
    return tag === "S" || /^[a-z]$/.test(tag);
  });
}

function resolveSourceInput(root, input) {
  if (typeof input !== "string" || input.length === 0 || isAbsolute(input)) {
    throw new Error("Source provenance inputs must be non-empty repository-relative paths");
  }
  const path = resolve(root, input);
  const pathFromRoot = relative(root, path);
  if (
    isAbsolute(pathFromRoot) ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith("../") ||
    pathFromRoot.startsWith("..\\")
  ) {
    throw new Error(`Source provenance input escapes the repository root: '${input}'`);
  }
  return path;
}

async function assertSafeRepositoryRoot(root) {
  const details = await lstat(root);
  if (details.isSymbolicLink()) {
    throw new Error(`Source provenance refuses symbolic-link repository root '${root}'`);
  }
  if (!details.isDirectory()) {
    throw new Error(`Source provenance repository root is not a directory: '${root}'`);
  }
}

function assertValidProvenanceSnapshot(snapshot, label) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error(`The ${label} repository provenance snapshot is missing or malformed`);
  }
  if (!GIT_COMMIT_PATTERN.test(snapshot.git?.commit || "")) {
    throw new Error(`The ${label} repository provenance has no valid Git commit`);
  }
  if (typeof snapshot.git?.dirty !== "boolean") {
    throw new Error(`The ${label} repository provenance has no valid Git dirty state`);
  }
  if (!Number.isSafeInteger(snapshot.git?.changedFileCount) || snapshot.git.changedFileCount < 0) {
    throw new Error(`The ${label} repository provenance has no valid Git changed-file count`);
  }
  assertSha256(snapshot.git?.statusSha256, `${label} Git status checksum`);
  assertSha256(snapshot.git?.indexFlagsSha256, `${label} Git index-flag checksum`);
  assertSha256(snapshot.sourceTreeSha256, `${label} source-tree checksum`);
  assertSha256(snapshot.packageLockSha256, `${label} package-lock checksum`);
  if (!Number.isSafeInteger(snapshot.sourceFileCount) || snapshot.sourceFileCount < 0) {
    throw new Error(`The ${label} repository provenance has no valid source-file count`);
  }
  if (typeof snapshot.formalEvidenceEligible !== "boolean") {
    throw new Error(`The ${label} repository provenance has no valid eligibility state`);
  }
  if (snapshot.formalEvidenceEligible !== !snapshot.git.dirty) {
    throw new Error(`The ${label} repository provenance eligibility contradicts its Git dirty state`);
  }
  for (const field of ["node", "npm", "docker", "platform"]) {
    if (typeof snapshot.tools?.[field] !== "string" || snapshot.tools[field].length === 0) {
      throw new Error(`The ${label} repository provenance has no valid ${field} tool value`);
    }
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`The ${label} is not a valid SHA-256 value`);
  }
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function npmInvocation() {
  return process.platform === "win32"
    ? { command: "cmd.exe", args: ["/d", "/s", "/c", "npm --version"] }
    : { command: "npm", args: ["--version"] };
}
