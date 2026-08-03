import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

export const DEFAULT_BESU_NETWORK_ROOT = "networks/besu";

export async function resolveSafeBesuNetworkRoot(
  requestedRoot = DEFAULT_BESU_NETWORK_ROOT,
  {
    workspaceRoot = process.cwd(),
    homeDirectory = homedir(),
  } = {},
) {
  const lexicalWorkspace = resolve(workspaceRoot);
  const lexicalHome = resolve(homeDirectory);
  const lexicalTarget = resolve(lexicalWorkspace, requestedRoot || DEFAULT_BESU_NETWORK_ROOT);

  rejectProtectedLocation(lexicalTarget, {
    workspace: lexicalWorkspace,
    home: lexicalHome,
    label: "requested",
  });

  const lexicalRelative = relativeWithin(lexicalWorkspace, lexicalTarget);
  if (!isAllowlistedRelativeRoot(lexicalRelative)) {
    throw new Error(
      `[besu:path] Refusing network root '${lexicalTarget}'. `
      + `Use '${DEFAULT_BESU_NETWORK_ROOT}' or a direct '.runtime/besu-*' directory.`,
    );
  }

  const canonicalWorkspace = await canonicalizeProspectivePath(lexicalWorkspace);
  const canonicalHome = await canonicalizeProspectivePath(lexicalHome);
  const canonicalTarget = await canonicalizeProspectivePath(lexicalTarget);
  rejectProtectedLocation(canonicalTarget, {
    workspace: canonicalWorkspace,
    home: canonicalHome,
    label: "canonical",
  });

  let canonicalRelative;
  try {
    canonicalRelative = relativeWithin(canonicalWorkspace, canonicalTarget);
  } catch (error) {
    throw new Error(
      `[besu:path] Refusing network root '${lexicalTarget}' because its canonical path `
      + `'${canonicalTarget}' escapes the allowlisted Besu runtime directories.`,
      { cause: error },
    );
  }
  if (!isAllowlistedRelativeRoot(canonicalRelative)) {
    throw new Error(
      `[besu:path] Refusing network root '${lexicalTarget}' because its canonical path `
      + `'${canonicalTarget}' escapes the allowlisted Besu runtime directories.`,
    );
  }

  const expectedCanonicalTarget = resolve(canonicalWorkspace, lexicalRelative);
  if (!samePath(canonicalTarget, expectedCanonicalTarget)) {
    throw new Error(
      `[besu:path] Refusing network root '${lexicalTarget}' because a symbolic link `
      + `redirects it to '${canonicalTarget}'.`,
    );
  }

  return canonicalTarget;
}

function isAllowlistedRelativeRoot(value) {
  if (samePath(value, join("networks", "besu"))) return true;
  const parts = value.split(sep);
  return parts.length === 2
    && parts[0] === ".runtime"
    && /^besu-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(parts[1]);
}

function relativeWithin(parent, child) {
  const value = relative(parent, child);
  if (value === "" || value === ".") return value;
  if (value === ".." || value.startsWith(`..${sep}`) || parse(value).root) {
    throw new Error(`[besu:path] Refusing network root '${child}' because it is outside workspace '${parent}'.`);
  }
  return value;
}

function rejectProtectedLocation(target, { workspace, home, label }) {
  if (samePath(target, parse(target).root)) {
    throw new Error(`[besu:path] Refusing ${label} network root '${target}' because it is a filesystem root.`);
  }
  if (samePath(target, home)) {
    throw new Error(`[besu:path] Refusing ${label} network root '${target}' because it is the home directory.`);
  }
  if (samePath(target, workspace)) {
    throw new Error(`[besu:path] Refusing ${label} network root '${target}' because it is the workspace root.`);
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

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
