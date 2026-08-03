import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, relative, resolve } from "node:path";

const MANAGED_RELATIVE_PATHS = Object.freeze({
  evidenceRoot: ".runtime/evidence",
  lockRoot: ".runtime/locks",
});

export async function resolveSafeEvidencePaths({
  workspaceRoot = process.cwd(),
  homeDirectory = homedir(),
} = {}) {
  const lexicalWorkspace = resolve(workspaceRoot);
  const workspaceDetails = await lstat(lexicalWorkspace);
  if (workspaceDetails.isSymbolicLink() || !workspaceDetails.isDirectory()) {
    throw new Error("[evidence:path] Refusing a non-directory or symbolic-link workspace root.");
  }
  const canonicalWorkspace = await canonicalizeProspectivePath(lexicalWorkspace);
  const canonicalHome = await canonicalizeProspectivePath(resolve(homeDirectory));

  const [evidenceRoot, lockRoot] = await Promise.all(Object.values(MANAGED_RELATIVE_PATHS).map(
    (relativePath) => resolveExactManagedDirectory({
      lexicalWorkspace,
      canonicalWorkspace,
      canonicalHome,
      relativePath,
    }),
  ));

  return Object.freeze({
    workspaceRoot: canonicalWorkspace,
    evidenceRoot,
    lockRoot,
    summaryPath: resolve(evidenceRoot, "runtime-evidence-summary.json"),
    securityReportPath: resolve(evidenceRoot, "security-scenarios.json"),
    institutionalLockPath: resolve(lockRoot, "institutional-evidence.lock"),
    securityLockPath: resolve(lockRoot, "security-scenarios.lock"),
  });
}

async function resolveExactManagedDirectory({
  lexicalWorkspace,
  canonicalWorkspace,
  canonicalHome,
  relativePath,
}) {
  const lexicalTarget = resolve(lexicalWorkspace, relativePath);
  await assertNoManagedSymlinkComponents(lexicalWorkspace, relativePath);
  const canonicalTarget = await canonicalizeProspectivePath(lexicalTarget);
  const expectedTarget = resolve(canonicalWorkspace, relativePath);
  const label = relativePath.replaceAll("\\", "/");

  if (!samePath(canonicalTarget, expectedTarget)) {
    throw new Error(
      `[evidence:path] Refusing '${label}' because a symbolic link redirects it to '${canonicalTarget}'.`,
    );
  }
  if (!isWithin(canonicalWorkspace, canonicalTarget)) {
    throw new Error(`[evidence:path] Refusing '${label}' because it escapes the workspace.`);
  }
  if (
    samePath(canonicalTarget, canonicalWorkspace)
    || samePath(canonicalTarget, canonicalHome)
    || samePath(canonicalTarget, dirname(canonicalTarget))
  ) {
    throw new Error(`[evidence:path] Refusing protected managed directory '${canonicalTarget}'.`);
  }
  return canonicalTarget;
}

async function assertNoManagedSymlinkComponents(workspace, relativePath) {
  let cursor = workspace;
  for (const segment of relativePath.split(/[\\/]+/)) {
    cursor = resolve(cursor, segment);
    try {
      const details = await lstat(cursor);
      if (details.isSymbolicLink()) {
        throw new Error(`[evidence:path] Refusing symbolic-link managed path component '${cursor}'.`);
      }
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

async function canonicalizeProspectivePath(path) {
  let cursor = resolve(path);
  const missingSegments = [];
  while (true) {
    try {
      const canonicalAncestor = await realpath(cursor);
      return resolve(canonicalAncestor, ...missingSegments);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function isWithin(parent, child) {
  const value = relative(parent, child);
  return value !== ".." && !value.startsWith("../") && !value.startsWith("..\\");
}

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
