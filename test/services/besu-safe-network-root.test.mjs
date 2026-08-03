import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import test from "node:test";
import { resolveSafeBesuNetworkRoot } from "../../scripts/ops/besu/safe-network-root.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "besu-safe-root-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  await Promise.all([
    mkdir(join(workspace, "networks"), { recursive: true }),
    mkdir(join(workspace, ".runtime"), { recursive: true }),
    mkdir(home, { recursive: true }),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, workspace, home };
}

test("allows only the standard and isolated evidence Besu roots", async (t) => {
  const context = await fixture(t);

  assert.equal(
    await resolveSafeBesuNetworkRoot("networks/besu", {
      workspaceRoot: context.workspace,
      homeDirectory: context.home,
    }),
    resolve(context.workspace, "networks/besu"),
  );
  assert.equal(
    await resolveSafeBesuNetworkRoot(".runtime/besu-qbft-evidence", {
      workspaceRoot: context.workspace,
      homeDirectory: context.home,
    }),
    resolve(context.workspace, ".runtime/besu-qbft-evidence"),
  );
});

test("rejects filesystem, home, workspace, outside, and broad runtime roots", async (t) => {
  const context = await fixture(t);
  const options = { workspaceRoot: context.workspace, homeDirectory: context.home };

  await assert.rejects(resolveSafeBesuNetworkRoot(parse(context.workspace).root, options), /filesystem root/);
  await assert.rejects(resolveSafeBesuNetworkRoot(context.home, options), /home directory/);
  await assert.rejects(resolveSafeBesuNetworkRoot(context.workspace, options), /workspace root/);
  await assert.rejects(resolveSafeBesuNetworkRoot(join(context.root, "outside"), options), /outside workspace/);
  await assert.rejects(resolveSafeBesuNetworkRoot("networks", options), /Use 'networks\/besu'/);
  await assert.rejects(resolveSafeBesuNetworkRoot(".runtime", options), /direct '.runtime\/besu-\*'/);
  await assert.rejects(resolveSafeBesuNetworkRoot(".runtime/not-besu", options), /direct '.runtime\/besu-\*'/);
  await assert.rejects(resolveSafeBesuNetworkRoot(".runtime/besu-evidence/nested", options), /direct '.runtime\/besu-\*'/);
});

test("rejects a symlink that redirects an allowlisted root outside the workspace", async (t) => {
  const context = await fixture(t);
  const outside = join(context.root, "outside-besu");
  await mkdir(outside, { recursive: true });
  await symlink(outside, join(context.workspace, "networks", "besu"), "dir");

  await assert.rejects(
    resolveSafeBesuNetworkRoot("networks/besu", {
      workspaceRoot: context.workspace,
      homeDirectory: context.home,
    }),
    /canonical path.*escapes the allowlisted Besu runtime directories/,
  );
});

test("rejects an allowlisted missing target below a symlinked runtime parent", async (t) => {
  const context = await fixture(t);
  const outsideRuntime = join(context.root, "outside-runtime");
  await mkdir(outsideRuntime, { recursive: true });
  await rm(join(context.workspace, ".runtime"), { recursive: true });
  await symlink(outsideRuntime, join(context.workspace, ".runtime"), "dir");

  await assert.rejects(
    resolveSafeBesuNetworkRoot(".runtime/besu-evidence", {
      workspaceRoot: context.workspace,
      homeDirectory: context.home,
    }),
    /canonical path.*escapes the allowlisted Besu runtime directories/,
  );
});
