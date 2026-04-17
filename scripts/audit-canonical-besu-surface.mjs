import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();

async function readText(path) {
  return readFile(resolve(root, path), "utf8");
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}\nexpected: ${expected}\nactual:   ${actual}`);
  }
}

function expectMatch(text, pattern, label) {
  if (!pattern.test(text)) {
    throw new Error(`${label}\nmissing pattern: ${pattern}`);
  }
}

function expectNoMatch(text, pattern, label) {
  if (pattern.test(text)) {
    throw new Error(`${label}\nunexpected pattern: ${pattern}`);
  }
}

async function main() {
  const packageJson = JSON.parse(await readText("package.json"));
  const scripts = packageJson.scripts || {};

  const canonicalScripts = {
    "deploy:ibc-lite": "node scripts/run-besu-command.mjs deploy:ibc-lite:raw",
    "seed:ibc-lite": "node scripts/run-besu-command.mjs seed:ibc-lite:raw",
    "demo:flow": "node scripts/run-besu-command.mjs demo:flow:raw",
    "demo:ui": "node scripts/run-besu-command.mjs demo:ui:raw",
    "worker:source-commit": "node scripts/run-besu-command.mjs worker:source-commit:raw",
    "worker:client-update": "node scripts/run-besu-command.mjs worker:client-update:raw",
    "worker:packet-proof": "node scripts/run-besu-command.mjs worker:packet-proof:raw",
    "worker:misbehaviour": "node scripts/run-besu-command.mjs worker:misbehaviour:raw",
    "audit:canonical-besu": "node scripts/run-besu-command.mjs audit:canonical-besu:raw",
    "report:phase5-readiness": "node scripts/run-besu-command.mjs report:phase5-readiness:raw",
  };

  for (const [name, expected] of Object.entries(canonicalScripts)) {
    expectEqual(scripts[name], expected, `Canonical script mismatch for ${name}`);
  }

  for (const name of Object.keys(scripts)) {
    if (name.startsWith("legacy:") || name.startsWith("internal:") || name.startsWith("compat:")) {
      throw new Error(`package.json still exposes deprecated compatibility script: ${name}`);
    }
  }

  const relayPaths = await readText("scripts/ibc-lite-relay-paths.mjs");
  expectMatch(
    relayPaths,
    /export async function relayPacketForCanonicalRuntime\(/,
    "Missing canonical relay path export"
  );
  expectNoMatch(relayPaths, /relayPacketForCompatibilityRuntime/, "Compatibility relay path should be removed");
  expectNoMatch(relayPaths, /relayPacketWithRuntime/, "Runtime fallback relay wrapper should be removed");

  const packetProofRelayer = await readText("scripts/packet-proof-relayer.mjs");
  expectMatch(
    packetProofRelayer,
    /canonical Besu-first entrypoint/,
    "Canonical packet-proof relayer should guard against non-Besu runtime"
  );

  const demoFlow = await readText("scripts/demo-ibc-lite-flow.mjs");
  expectMatch(
    demoFlow,
    /canonical Besu-first entrypoint/,
    "Canonical demo flow should guard against non-Besu runtime"
  );

  const serveDemoUi = await readText("scripts/serve-demo-ui.mjs");
  expectMatch(
    serveDemoUi,
    /canonical Besu-first UI entrypoint/,
    "Canonical demo UI should guard against non-Besu runtime"
  );

  const deploy = await readText("scripts/deploy-ibc-lite.mjs");
  const seed = await readText("scripts/seed-ibc-lite.mjs");
  const sourceCommit = await readText("scripts/source-commit-worker.mjs");
  const clientUpdate = await readText("scripts/client-update-relayer.mjs");
  const misbehaviour = await readText("scripts/misbehaviour-relayer.mjs");
  for (const [label, text] of [
    ["deploy", deploy],
    ["seed", seed],
    ["source-commit", sourceCommit],
    ["client-update", clientUpdate],
    ["misbehaviour", misbehaviour],
  ]) {
    expectMatch(text, /canonical Besu-first entrypoint/, `Missing runtime guard in ${label} entrypoint`);
  }

  const demoStatusView = await readText("demo/demo-status-view.js");
  expectMatch(
    demoStatusView,
    /unexpected compatibility path/,
    "UI should mark compatibility proof inside Besu mode as unexpected"
  );

  const publicDocs = [
    "README.md",
    "docs/EVM_BESU_DIRECTION.md",
    "docs/DEMO_RUNTIME_MAP.md",
    "docs/IBC_LIGHT_CLIENT_SCOPE.md",
    "docs/TRUST_ASSUMPTIONS.md",
    "docs/SYSTEM_TESTS.md",
  ];
  for (const path of publicDocs) {
    const text = await readText(path);
    expectNoMatch(text, /\blegacy:/, `${path} should not expose legacy commands`);
  }

  console.log("Canonical Besu surface audit passed.");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
