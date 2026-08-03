import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ethers } from "ethers";
import {
  loadAttestorServiceConfig,
  loadRelayServiceConfig,
} from "../../services/institutional-relay/service-config.mjs";

const PRIVATE_KEY_ENV = "TEST_INSTITUTIONAL_ATTESTOR_PRIVATE_KEY";
const PRIVATE_KEY = `0x${"01".repeat(32)}`;
const CHECKPOINT_CLIENT = "0x00000000000000000000000000000000000000c1";
const GATEWAY_A = "0x00000000000000000000000000000000000000a1";
const GATEWAY_B = "0x00000000000000000000000000000000000000b1";

function attestorConfig(overrides = {}) {
  return {
    version: "institutional-attestor-v1",
    privateKeyEnv: PRIVATE_KEY_ENV,
    listen: { host: "127.0.0.1", port: 8701 },
    sources: [{ chainId: "41001", rpc: "http://127.0.0.1:8545", finalityDepth: 2 }],
    allowedDomains: [{ destinationChainId: "41002", checkpointClient: CHECKPOINT_CLIENT.toLowerCase() }],
    ...overrides,
  };
}

async function writeConfig(directory, name, config) {
  const path = join(directory, name);
  await writeFile(path, `${JSON.stringify(config)}\n`, "utf8");
  return path;
}

function relayConfig(overrides = {}) {
  return {
    version: "institutional-relay-v1",
    pollIntervalMs: 1_000,
    leaseMs: 30_000,
    batchSize: 10,
    retry: { baseMs: 250, maxMs: 2_000, jitterRatio: 0.1 },
    lanes: [{
      id: "A-to-B",
      source: {
        rpc: "http://127.0.0.1:8545",
        chainId: "41001",
        gateway: GATEWAY_A,
        checkpointClient: CHECKPOINT_CLIENT,
        operatorIndex: 2,
      },
      destination: {
        rpc: "http://127.0.0.1:9545",
        chainId: "41002",
        gateway: GATEWAY_B,
        checkpointClient: CHECKPOINT_CLIENT,
        operatorIndex: 2,
      },
      attestors: [{ url: "http://127.0.0.1:8701" }, { url: "http://127.0.0.1:8702" }, { url: "http://127.0.0.1:8703" }],
    }],
    ...overrides,
  };
}

test("attestor service config normalizes the destination-domain allowlist", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "institutional-attestor-config-"));
  process.env[PRIVATE_KEY_ENV] = PRIVATE_KEY;
  t.after(async () => {
    delete process.env[PRIVATE_KEY_ENV];
    await rm(directory, { recursive: true, force: true });
  });

  const path = await writeConfig(directory, "valid.json", attestorConfig());
  const config = await loadAttestorServiceConfig(path);
  assert.deepEqual(config.allowedDomains, [{
    destinationChainId: "41002",
    checkpointClient: ethers.getAddress(CHECKPOINT_CLIENT),
  }]);
});

test("attestor service config fails closed for missing, duplicate, or malformed destination domains", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "institutional-attestor-config-invalid-"));
  process.env[PRIVATE_KEY_ENV] = PRIVATE_KEY;
  t.after(async () => {
    delete process.env[PRIVATE_KEY_ENV];
    await rm(directory, { recursive: true, force: true });
  });

  const cases = [
    {
      name: "missing.json",
      config: attestorConfig({ allowedDomains: undefined }),
      pattern: /requires at least one allowed destination domain/,
    },
    {
      name: "duplicate.json",
      config: attestorConfig({
        allowedDomains: [
          { destinationChainId: "41002", checkpointClient: CHECKPOINT_CLIENT.toLowerCase() },
          { destinationChainId: 41002, checkpointClient: ethers.getAddress(CHECKPOINT_CLIENT) },
        ],
      }),
      pattern: /duplicated/,
    },
    {
      name: "malformed.json",
      config: attestorConfig({
        allowedDomains: [{ destinationChainId: "41002", checkpointClient: "not-an-address" }],
      }),
      pattern: /invalid address/i,
    },
  ];
  for (const entry of cases) {
    const path = await writeConfig(directory, entry.name, entry.config);
    await assert.rejects(loadAttestorServiceConfig(path), entry.pattern);
  }
});

test("relay service config accepts the documented typed retry options", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "institutional-relay-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = await writeConfig(directory, "valid.json", relayConfig());
  const config = await loadRelayServiceConfig(path);
  assert.deepEqual(config.retry, { baseMs: 250, maxMs: 2_000, jitterRatio: 0.1 });
});

test("relay service config rejects ignored legacy retry names and invalid ranges", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "institutional-relay-config-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cases = [
    {
      name: "legacy.json",
      config: relayConfig({ retry: { initialMs: 250, maximumMs: 2_000 } }),
      pattern: /Unsupported relay retry option.*initialMs.*maximumMs/,
    },
    {
      name: "range.json",
      config: relayConfig({ retry: { baseMs: 2_000, maxMs: 250 } }),
      pattern: /maxMs must be greater than or equal/,
    },
    {
      name: "jitter.json",
      config: relayConfig({ retry: { jitterRatio: 1.5 } }),
      pattern: /jitterRatio must be between 0 and 1/,
    },
    {
      name: "lease.json",
      config: relayConfig({ leaseMs: 0 }),
      pattern: /leaseMs must be a positive integer/,
    },
  ];
  for (const entry of cases) {
    const path = await writeConfig(directory, entry.name, entry.config);
    await assert.rejects(loadRelayServiceConfig(path), entry.pattern);
  }
});
