import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();

async function readText(path) {
  return readFile(resolve(root, path), "utf8");
}

async function exists(path) {
  try {
    await access(resolve(root, path));
    return true;
  } catch {
    return false;
  }
}

function item(label, status, detail) {
  return { label, status, detail };
}

function has(text, pattern) {
  return pattern.test(text);
}

async function rpcReachable(rpc) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: controller.signal,
    });
    const payload = await response.json();
    return Boolean(payload.result);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function printReport(lines) {
  for (const line of lines) {
    console.log(line);
  }
}

async function main() {
  const packageJson = JSON.parse(await readText("package.json"));
  const scripts = packageJson.scripts || {};

  const handler = await readText("contracts/core/IBCPacketHandler.sol");
  const minimalTransferTest = await readText("test/apps/MinimalTransferApp.t.sol");
  const lendingTest = await readText("test/apps/CrossChainLendingUseCase.t.sol");
  const demoFlow = await readText("scripts/demo-ibc-lite-flow.mjs");
  const packetProofRelayer = await readText("scripts/packet-proof-relayer.mjs");
  const demoActions = await readText("scripts/ibc-lite-demo-actions.mjs");
  const readme = await readText("README.md");
  const runtimeMap = await readText("docs/DEMO_RUNTIME_MAP.md");

  const results = [];

  const canonicalCommandsPass =
    scripts["deploy:ibc-lite"] === "node scripts/run-besu-command.mjs deploy:ibc-lite:raw" &&
    scripts["seed:ibc-lite"] === "node scripts/run-besu-command.mjs seed:ibc-lite:raw" &&
    scripts["demo:flow"] === "node scripts/run-besu-command.mjs demo:flow:raw" &&
    scripts["demo:ui"] === "node scripts/run-besu-command.mjs demo:ui:raw" &&
    scripts["worker:packet-proof"] === "node scripts/run-besu-command.mjs worker:packet-proof:raw";
  results.push(
    item(
      "Canonical commands are Besu-first",
      canonicalCommandsPass ? "PASS" : "FAIL",
      canonicalCommandsPass
        ? "Public commands route through run-besu-command."
        : "One or more public commands no longer route through run-besu-command."
    )
  );

  const canonicalStorageOnlyPass =
    has(demoFlow, /relayPacketForCanonicalRuntime/) &&
    has(packetProofRelayer, /relayPacketForCanonicalRuntime/) &&
    has(demoActions, /relayPacketForCanonicalRuntime/);
  results.push(
    item(
      "Canonical controller and workers call storage-first relay explicitly",
      canonicalStorageOnlyPass ? "PASS" : "FAIL",
      canonicalStorageOnlyPass
        ? "Canonical paths choose relayPacketForCanonicalRuntime explicitly."
        : "A canonical path still lacks an explicit canonical relay selection."
    )
  );

  const publicSurfacePass = !has(readme, /\blegacy:/) && !has(runtimeMap, /\blegacy:/);
  results.push(
    item(
      "Public docs no longer expose legacy commands",
      publicSurfacePass ? "PASS" : "FAIL",
      publicSurfacePass
        ? "README and demo runtime map no longer advertise legacy commands."
        : "A public doc still exposes deprecated legacy commands."
    )
  );

  const internalHarnessPresent =
    Object.keys(scripts).some((name) => name.startsWith("internal:")) ||
    Object.keys(scripts).some((name) => name.startsWith("compat:"));
  results.push(
    item(
      "Internal compatibility harness still exists",
      internalHarnessPresent ? "BLOCKED" : "PASS",
      internalHarnessPresent
        ? "internal:* and compat:* scripts are still present, so Phase 5 deletion has not happened yet."
        : "No internal compatibility harness remains on the package surface."
    )
  );

  const contractMerklePathPresent = has(handler, /function recvPacket\(/);
  results.push(
    item(
      "Contract core still contains the Merkle recvPacket path",
      contractMerklePathPresent ? "BLOCKED" : "PASS",
      contractMerklePathPresent
        ? "IBCPacketHandler still exposes recvPacket(...) alongside recvPacketFromStorageProof(...)."
        : "Only storage-proof packet execution remains in IBCPacketHandler."
    )
  );

  const testsStillUseMerkle =
    has(minimalTransferTest, /handlerB\.recvPacket\(/) ||
    has(minimalTransferTest, /handlerA\.recvPacket\(/) ||
    has(lendingTest, /handlerB\.recvPacket\(/);
  results.push(
    item(
      "Current app tests still exercise Merkle packet execution",
      testsStillUseMerkle ? "BLOCKED" : "PASS",
      testsStillUseMerkle
        ? "Minimal transfer and lending tests still call handler.recvPacket(...), so storage-only readiness is incomplete."
        : "App tests no longer rely on the Merkle packet path."
    )
  );

  let liveConfigStatus = "WARN";
  let liveConfigDetail = "No Besu deployment config detected in this environment.";
  if (await exists(".ibc-lite.local.json")) {
    try {
      const config = JSON.parse(await readText(".ibc-lite.local.json"));
      const mode = config?.runtime?.mode || "unknown";
      const chainAOk = config?.chains?.A?.rpc ? await rpcReachable(config.chains.A.rpc) : false;
      const chainBOk = config?.chains?.B?.rpc ? await rpcReachable(config.chains.B.rpc) : false;
      if (mode === "besu" && chainAOk && chainBOk) {
        liveConfigStatus = "PASS";
        liveConfigDetail = "Besu runtime config exists and both RPC endpoints respond.";
      } else if (mode === "besu") {
        liveConfigStatus = "WARN";
        liveConfigDetail = "Besu runtime config exists, but local RPC endpoints are not both reachable from this session.";
      } else {
        liveConfigStatus = "WARN";
        liveConfigDetail = `A deployment config exists, but runtime.mode is '${mode}', not 'besu'.`;
      }
    } catch {
      liveConfigStatus = "WARN";
      liveConfigDetail = "Deployment config exists but could not be parsed for runtime checks.";
    }
  }
  results.push(item("Live Besu runtime observed from this environment", liveConfigStatus, liveConfigDetail));

  const blockingStatuses = new Set(["FAIL", "BLOCKED"]);
  const readyForPhase5 = results.every((entry) => !blockingStatuses.has(entry.status));

  const lines = [
    "Phase 5 Readiness Report",
    "========================",
    "",
    ...results.map((entry) => `- [${entry.status}] ${entry.label}: ${entry.detail}`),
    "",
    `Overall readiness: ${readyForPhase5 ? "READY" : "NOT READY"}`,
  ];
  printReport(lines);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
