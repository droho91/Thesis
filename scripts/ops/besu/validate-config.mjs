import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ethers } from "ethers";

const ROOT = resolve(process.cwd(), process.env.BESU_NETWORK_ROOT || "networks/besu");
const allowUnsafe = process.env.UNSAFE_LOCAL_DEMO === "true";

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? listFiles(path) : [path];
    })
  );
  return nested.flat();
}

function assertSafe(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  if (allowUnsafe) {
    console.warn("[check:besu-config] UNSAFE_LOCAL_DEMO=true; hardened config checks skipped.");
    return;
  }

  const files = await listFiles(ROOT);
  const composePath = join(ROOT, "docker-compose.yml");
  const compose = await readFile(composePath, "utf8");
  const scaffold = JSON.parse(await readFile(join(ROOT, "scaffold.json"), "utf8"));
  const requestedValidatorCount = Number(process.env.BESU_VALIDATOR_COUNT || 4);
  assertSafe(
    /image:\s*["']?hyperledger\/besu:[^\s"']+@sha256:[0-9a-f]{64}["']?/.test(compose),
    "docker-compose.yml must pin the Besu image by immutable digest.",
  );
  assertSafe(scaffold.version === "besu-qbft-scaffold-v4", "Unsupported Besu scaffold version.");
  assertSafe(!compose.includes("privileged: true"), "Validator containers must not run privileged.");
  assertSafe(
    !compose.includes("./chainA:/network") && !compose.includes("./chainB:/network"),
    "Validator containers must not mount an entire bank-chain directory.",
  );
  assertSafe(
    scaffold.validatorCount === requestedValidatorCount,
    `Besu scaffold has ${scaffold.validatorCount} validators per chain; expected ${requestedValidatorCount}.`,
  );
  assertSafe(
    scaffold.validatorCount >= 4,
    "Hardened QBFT profile requires at least four validators per chain.",
  );
  assertSafe(
    scaffold.byzantineFaultTolerance >= 1,
    "Hardened QBFT profile must tolerate at least one validator fault.",
  );

  const configPaths = files.filter((path) => path.endsWith("config.toml"));
  assertSafe(
    configPaths.length === scaffold.validatorCount * scaffold.networks.length,
    `Expected ${scaffold.validatorCount * scaffold.networks.length} validator configs, found ${configPaths.length}.`,
  );

  for (const network of scaffold.networks) {
    const networkRoot = join(ROOT, network.key);
    const genesis = JSON.parse(await readFile(join(networkRoot, "genesis.json"), "utf8"));
    const validators = JSON.parse(await readFile(join(networkRoot, "validators.json"), "utf8"));
    assertSafe(genesis.config?.chainId === network.chainId, `${network.key} genesis chain id mismatch.`);
    assertSafe(validators.length === scaffold.validatorCount, `${network.key} validators.json count mismatch.`);
    assertSafe(
      validators.every((validator) => validator.privateKey == null),
      `${network.key} validators.json must not expose private keys.`,
    );
    assertSafe(genesis.config?.qbft?.blockperiodseconds > 0, `${network.key} QBFT block period is invalid.`);
    assertSafe(genesis.config?.qbft?.requesttimeoutseconds > 0, `${network.key} QBFT request timeout is invalid.`);
    assertSafe(
      genesis.config.qbft.blockperiodseconds === scaffold.consensus?.blockPeriodSeconds,
      `${network.key} QBFT block period does not match scaffold profile.`,
    );
    assertSafe(
      genesis.config.qbft.requesttimeoutseconds === scaffold.consensus?.requestTimeoutSeconds,
      `${network.key} QBFT request timeout does not match scaffold profile.`,
    );
    assertSafe(
      genesis.config.qbft.requesttimeoutseconds >= genesis.config.qbft.blockperiodseconds * 2,
      `${network.key} QBFT request timeout must be at least twice the block period.`,
    );

    const decodedExtraData = ethers.decodeRlp(genesis.extraData);
    const genesisValidators = decodedExtraData[1].map((address) => ethers.getAddress(address)).sort(compareAddresses);
    const expectedValidators = validators.map((validator) => ethers.getAddress(validator.address)).sort(compareAddresses);
    assertSafe(
      sameAddressList(genesisValidators, expectedValidators),
      `${network.key} genesis validator set does not match validators.json.`,
    );

    for (const validator of validators) {
      assertSafe(compose.includes(`container_name: ${validator.name.replace(/^/, `${scaffold.containerPrefix}-`)}`), `${validator.name} is missing from Compose.`);
      const serviceName = validator.name.replace(/-/g, "_");
      const service = composeServiceBlock(compose, serviceName);
      assertSafe(service.includes("no-new-privileges:true"), `${validator.name} must enable no-new-privileges.`);
      assertSafe(
        service.includes(`./${network.key}/nodes/${validator.name}/key:/network/key:ro`),
        `${validator.name} does not mount only its own read-only validator key.`,
      );
      assertSafe(
        !service.match(new RegExp(`\\./${network.key}/nodes/(?!${validator.name.replaceAll("-", "\\-")}/)[^:]+/key`)),
        `${validator.name} can access another validator key.`,
      );
      assertSafe(!service.includes("operators.json"), `${validator.name} must not mount operator credentials.`);
      const staticNodes = JSON.parse(
        await readFile(join(networkRoot, "nodes", validator.name, "static-nodes.json"), "utf8"),
      );
      assertSafe(staticNodes.length === scaffold.validatorCount, `${validator.name} static peer count mismatch.`);
      assertSafe(new Set(staticNodes).size === scaffold.validatorCount, `${validator.name} static peers are not unique.`);
    }
  }

  for (const path of configPaths) {
    const config = await readFile(path, "utf8");
    assertSafe(!config.includes('"ADMIN"'), `${path} must not enable ADMIN RPC by default.`);
    assertSafe(!config.includes('"DEBUG"'), `${path} must not enable DEBUG RPC by default.`);
    assertSafe(!config.includes('rpc-http-cors-origins=["all"]'), `${path} must not allow all CORS origins.`);
    assertSafe(!config.includes('host-allowlist=["*"]'), `${path} must not allow all RPC hosts.`);
    assertSafe(config.includes('node-private-key-file="/network/key"'), `${path} must use the isolated key mount.`);
    assertSafe(!config.includes("/network/nodes/"), `${path} must not depend on the shared chain directory layout.`);
  }

  for (const network of scaffold.networks) {
    assertSafe(
      compose.includes(`"127.0.0.1:${network.hostRpcPort}:8545"`),
      `${network.key} RPC must bind to host loopback.`,
    );
  }

  console.log("[check:besu-config] hardened Besu config checks passed.");
}

function composeServiceBlock(compose, serviceName) {
  const marker = `  ${serviceName}:`;
  const start = compose.indexOf(marker);
  if (start < 0) return "";
  const remainder = compose.slice(start + marker.length);
  const nextService = remainder.search(/\n  [A-Za-z0-9_]+:\n/);
  return nextService < 0 ? remainder : remainder.slice(0, nextService);
}

function compareAddresses(left, right) {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function sameAddressList(left, right) {
  return left.length === right.length && left.every((address, index) => address === right[index]);
}

main().catch((error) => {
  if (error?.code === "ENOENT") {
    console.error("[check:besu-config] Besu scaffold is incomplete; run npm run besu:generate first.");
    process.exit(1);
  }
  console.error(error.message || error);
  process.exit(1);
});
