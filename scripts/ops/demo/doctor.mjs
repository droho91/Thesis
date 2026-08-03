import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadScaffold, rpcByNetworkKey, rpcCall, waitForProgress } from "../besu/health.mjs";
import { formalEvidencePayload } from "../../ui/evidence.mjs";
import { classifyDefenseEvidence, readinessVerdict } from "./readiness.mjs";

const DEPLOYMENT_PATH = resolve(
  process.cwd(),
  process.env.INSTITUTIONAL_DEPLOYMENT_PATH || ".runtime/institutional-deployment.json",
);
const UI_URL = process.env.DEMO_UI_URL || `http://127.0.0.1:${process.env.DEMO_UI_PORT || 5173}`;
const CHAIN_PROGRESS_TIMEOUT_MS = Number(process.env.DEMO_DOCTOR_PROGRESS_TIMEOUT_MS || 20_000);
const REQUIRED_CONTRACTS = Object.freeze({
  A: Object.freeze([
    "canonicalToken", "checkpointClient", "collateralApp", "escrowVault", "gateway",
    "governance", "identityRegistry", "policyEngine", "restitutionVault",
  ]),
  B: Object.freeze([
    "checkpointClient", "collateralApp", "debtToken", "gateway", "governance",
    "identityRegistry", "lendingPool", "oracle", "policyEngine", "restitutionVault", "voucherToken",
  ]),
});

async function main() {
  const checks = [];
  const docker = await captureCheck("Docker daemon", dockerReady);
  checks.push(docker);

  const scaffold = await captureValue("Besu QBFT topology", async () => {
    const value = await loadScaffold();
    if (value.validatorCount !== 4 || value.byzantineFaultTolerance !== 1) {
      throw new Error(`expected 4 validators and f=1; found ${value.validatorCount} and f=${value.byzantineFaultTolerance}`);
    }
    return value;
  });
  checks.push(scaffold.check);

  if (scaffold.value) {
    const chains = await captureValue("Bank-chain health", async () => Promise.all(
      scaffold.value.networks.map((network) => waitForProgress(network, rpcByNetworkKey(network.key), {
        blocks: 1,
        timeoutMs: CHAIN_PROGRESS_TIMEOUT_MS,
      })),
    ));
    if (chains.value) {
      chains.check.detail = chains.value
        .map((chain) => `${chain.key} blocks=${chain.startBlock}->${chain.blockNumber} peers=${chain.peerCount} validators=${chain.validatorCount}`)
        .join("; ");
    }
    checks.push(chains.check);
  }

  const deployment = await captureValue("Institutional deployment", async () => {
    const value = JSON.parse(await readFile(DEPLOYMENT_PATH, "utf8"));
    if (value.status !== "ready") throw new Error(`manifest status is ${value.status || "missing"}`);
    for (const key of ["A", "B"]) {
      const expectedChainId = key === "A" ? "41001" : "41002";
      if (String(value.chains?.[key]?.chainId) !== expectedChainId) {
        throw new Error(`Bank ${key} chain ID does not match ${expectedChainId}`);
      }
    }
    return value;
  });
  checks.push(deployment.check);

  if (deployment.value) {
    checks.push(await captureCheck("Timelock governance", async () => {
      const profile = deployment.value.securityProfile;
      if (profile?.governanceMode !== "timelock-enforced") {
        throw new Error(`governance mode is ${profile?.governanceMode || "missing"}`);
      }
      return `${profile.governanceDelaySeconds}s delay; bootstrap administration handed off`;
    }));
    checks.push(await captureCheck("Deployed contract bytecode", async () => {
      const probes = [];
      for (const key of ["A", "B"]) {
        const rpc = deployment.value.chains[key].rpc;
        const contracts = deployment.value.chains[key].contracts;
        const actualNames = contracts && typeof contracts === "object" ? Object.keys(contracts).sort() : [];
        if (!sameStrings(actualNames, REQUIRED_CONTRACTS[key])) {
          throw new Error(`Bank ${key} contract manifest is incomplete or contains unexpected entries`);
        }
        for (const [name, contract] of Object.entries(contracts)) {
          probes.push(rpcCall(rpc, "eth_getCode", [contract.address, "latest"]).then((code) => {
            if (typeof code !== "string" || !/^0x[0-9a-fA-F]+$/.test(code) || code === "0x") {
              throw new Error(`Bank ${key} ${name} has no valid bytecode`);
            }
            return `${key}.${name}`;
          }));
        }
      }
      const contracts = await Promise.all(probes);
      return `${contracts.length} contracts present on-chain`;
    }));
  }

  checks.push(await captureCheck("Institutional UI", async () => {
    const response = await fetchWithTimeout(`${UI_URL}/api/status`, 8_000);
    const body = await response.json();
    if (!response.ok || !body.runtimeReadable) throw new Error(body.message || `HTTP ${response.status}`);
    const readinessSignals = [
      "chainsProgressing",
      "attestorQuorumReady",
      "relayerHealthy",
      "governanceEnforced",
      "identitiesEligible",
      "laneReady",
    ];
    const missing = readinessSignals.filter((signal) => body[signal] !== true);
    if (missing.length > 0 || !body.chains?.A?.readable || !body.chains?.B?.readable || !body.balances || !body.relay) {
      throw new Error(`institutional lane readiness failed: ${missing.join(", ") || "read model incomplete"}`);
    }
    return `${UI_URL} operational; runtime readable and lane ready`;
  }));

  checks.push(classifyDefenseEvidence(await formalEvidencePayload()));

  console.log("\nInstitutional demo readiness\n");
  for (const check of checks) {
    console.log(`[${check.status.toUpperCase()}] ${check.name}: ${check.detail}`);
  }
  console.log("");
  const verdict = readinessVerdict(checks);
  console[verdict.level](verdict.message);
  if (verdict.exitCode !== 0) process.exitCode = verdict.exitCode;
}

function sameStrings(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

async function dockerReady() {
  const version = await commandOutput("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (!version) throw new Error("Docker daemon is unavailable");
  return `server ${version}`;
}

async function captureCheck(name, operation) {
  try {
    return { name, status: "pass", detail: await operation() };
  } catch (error) {
    return { name, status: "fail", detail: error?.message || String(error) };
  }
}

async function captureValue(name, operation) {
  try {
    const value = await operation();
    return { value, check: { name, status: "pass", detail: "ready" } };
  } catch (error) {
    return { value: null, check: { name, status: "fail", detail: error?.message || String(error) } };
  }
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function commandOutput(command, args) {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env: process.env, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolveOutput(stdout.trim());
      else reject(new Error([stderr.trim(), stdout.trim()].filter(Boolean).join("\n") || `${command} exited with ${code}`));
    });
  });
}

main().catch((error) => {
  console.error(`[demo:doctor] ${error?.stack || error}`);
  process.exitCode = 1;
});
