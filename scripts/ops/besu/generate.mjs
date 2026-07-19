import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ethers } from "ethers";

const ROOT = resolve(process.cwd(), process.env.BESU_NETWORK_ROOT || "networks/besu");
const IF_MISSING = process.argv.includes("--if-missing");
const SCAFFOLD_VERSION = "besu-qbft-scaffold-v4";
const VANITY = `0x${"00".repeat(32)}`;
const FUNDED_BALANCE = "0x3635C9ADC5DEA00000"; // 1000 ETH
const QBFT_MIX_HASH = "0x63746963616c2062797a616e74696e65206661756c7420746f6c6572616e6365";
const UNSAFE_LOCAL_DEMO = process.env.UNSAFE_LOCAL_DEMO === "true";
const BESU_ENABLE_ADMIN_DEBUG = process.env.BESU_ENABLE_ADMIN_DEBUG === "true";
const BESU_DOCKER_IMAGE = process.env.BESU_DOCKER_IMAGE ||
  "hyperledger/besu:24.10.0@sha256:644f31577d06f0076375fb4a92805e30038b8dee2b25dda4dd3a843f79ccca65";
const BESU_JAVA_OPTS = process.env.BESU_JAVA_OPTS || "-Xms128m -Xmx512m -XX:ActiveProcessorCount=2";
const BESU_VALIDATOR_COUNT = Math.min(
  7,
  Math.max(1, Number(process.env.BESU_VALIDATOR_COUNT || process.env.DEMO_BESU_VALIDATOR_COUNT || "4")),
);
const BESU_CONTAINER_PREFIX = process.env.BESU_CONTAINER_PREFIX || "thesis";
const BESU_CHAIN_A_RPC_PORT = Number(process.env.BESU_CHAIN_A_RPC_PORT || "8545");
const BESU_CHAIN_B_RPC_PORT = Number(process.env.BESU_CHAIN_B_RPC_PORT || "9545");
const QBFT_BLOCK_PERIOD_SECONDS = Number(process.env.BESU_QBFT_BLOCK_PERIOD_SECONDS || "2");
const QBFT_REQUEST_TIMEOUT_SECONDS = Number(process.env.BESU_QBFT_REQUEST_TIMEOUT_SECONDS || "10");
const BESU_SUBNET_SECOND_OCTET = Number(process.env.BESU_SUBNET_SECOND_OCTET || "30");
const BESU_SUBNET = `172.${BESU_SUBNET_SECOND_OCTET}.0.0/16`;
const BONSAI_HISTORICAL_BLOCK_LIMIT = Number(process.env.BESU_BONSAI_HISTORICAL_BLOCK_LIMIT || "100000");
const BONSAI_TRIE_LOGS_PRUNING_WINDOW_SIZE = Math.max(
  BONSAI_HISTORICAL_BLOCK_LIMIT + 1,
  Number(process.env.BESU_BONSAI_TRIE_LOGS_PRUNING_WINDOW_SIZE || String(BONSAI_HISTORICAL_BLOCK_LIMIT + 20000)),
);

function validatorNames(prefix) {
  return Array.from({ length: BESU_VALIDATOR_COUNT }, (_, index) => `${prefix}-validator-${index + 1}`);
}

const NETWORKS = [
  {
    key: "chainA",
    chainId: 41001,
    label: "Bank A",
    subnetPrefix: `172.${BESU_SUBNET_SECOND_OCTET}.10`,
    hostRpcPort: BESU_CHAIN_A_RPC_PORT,
    validators: validatorNames("bank-a"),
  },
  {
    key: "chainB",
    chainId: 41002,
    label: "Bank B",
    subnetPrefix: `172.${BESU_SUBNET_SECOND_OCTET}.20`,
    hostRpcPort: BESU_CHAIN_B_RPC_PORT,
    validators: validatorNames("bank-b"),
  },
];

function requiredScaffoldPaths() {
  const common = ["scaffold.json", "docker-compose.yml"];
  for (const network of NETWORKS) {
    common.push(`${network.key}/genesis.json`, `${network.key}/operators.json`, `${network.key}/validators.json`);
    for (const name of network.validators) {
      common.push(
        `${network.key}/nodes/${name}/config.toml`,
        `${network.key}/nodes/${name}/key`,
        `${network.key}/nodes/${name}/static-nodes.json`,
      );
    }
  }
  return common;
}

async function pathExists(path) {
  return access(path).then(() => true).catch(() => false);
}

async function reuseCompleteScaffoldIfRequested() {
  if (!IF_MISSING) return false;

  const requiredPaths = requiredScaffoldPaths();
  const present = await Promise.all(requiredPaths.map((path) => pathExists(resolve(ROOT, path))));
  const scaffold = await readFile(resolve(ROOT, "scaffold.json"), "utf8")
    .then((value) => JSON.parse(value))
    .catch(() => null);
  const profileMatches =
    scaffold?.version === SCAFFOLD_VERSION &&
    scaffold.validatorCount === BESU_VALIDATOR_COUNT &&
    scaffold.dockerImage === BESU_DOCKER_IMAGE &&
    scaffold.javaOpts === BESU_JAVA_OPTS &&
    scaffold.containerPrefix === BESU_CONTAINER_PREFIX &&
    scaffold.subnet === BESU_SUBNET &&
    scaffold.consensus?.blockPeriodSeconds === QBFT_BLOCK_PERIOD_SECONDS &&
    scaffold.consensus?.requestTimeoutSeconds === QBFT_REQUEST_TIMEOUT_SECONDS &&
    scaffold.networks?.length === NETWORKS.length &&
    scaffold.networks?.every((network, index) =>
      network.chainId === NETWORKS[index].chainId && network.hostRpcPort === NETWORKS[index].hostRpcPort
    );
  if (present.every(Boolean) && profileMatches) {
    console.log("[besu:generate] Reusing the existing Besu network scaffold.");
    return true;
  }

  const entries = await readdir(ROOT).catch(() => []);
  if (entries.length > 0) {
    const missing = requiredPaths.filter((_, index) => !present[index]);
    const reason = profileMatches ? `missing files: ${missing.join(", ")}` : "profile does not match requested topology";
    throw new Error(
      `[besu:generate] Existing Besu scaffold cannot be reused (${reason}). ` +
        "Run npm run besu:down followed by npm run besu:generate before starting it again."
    );
  }

  return false;
}

function privateKeyHex(label) {
  if (!UNSAFE_LOCAL_DEMO) return ethers.Wallet.createRandom().privateKey;
  return ethers.keccak256(ethers.toUtf8Bytes(`thesis-besu-qbft:${label}`));
}

function nodeSpec(network, name, index) {
  const privateKey = privateKeyHex(`${network.key}:${name}`);
  const wallet = new ethers.Wallet(privateKey);
  const publicKey = ethers.SigningKey.computePublicKey(privateKey, false);
  const nodeId = publicKey.slice(4);
  const ip = `${network.subnetPrefix}.${11 + index}`;
  return {
    name,
    privateKey,
    privateKeyRaw: privateKey.slice(2),
    address: wallet.address,
    nodeId,
    ip,
    enode: `enode://${nodeId}@${ip}:30303`,
  };
}

function operatorSpec(network, label) {
  const privateKey = privateKeyHex(`${network.key}:${label}`);
  const wallet = new ethers.Wallet(privateKey);
  return {
    label,
    address: wallet.address,
    privateKey,
  };
}

function qbftExtraData(validators) {
  const validatorAddresses = [...validators].map((validator) => validator.address.toLowerCase()).sort();
  return ethers.encodeRlp([VANITY, validatorAddresses, [], "0x", []]);
}

function genesisFor(network, validators, operators) {
  const alloc = Object.fromEntries(
    [...validators, ...operators].map((entry) => [
      entry.address,
      {
        balance: FUNDED_BALANCE,
      },
    ])
  );

  return {
    config: {
      chainId: network.chainId,
      homesteadBlock: 0,
      eip150Block: 0,
      eip155Block: 0,
      eip158Block: 0,
      byzantiumBlock: 0,
      constantinopleBlock: 0,
      petersburgBlock: 0,
      istanbulBlock: 0,
      berlinBlock: 0,
      londonBlock: 0,
      zeroBaseFee: true,
      qbft: {
        epochlength: 30000,
        blockperiodseconds: QBFT_BLOCK_PERIOD_SECONDS,
        requesttimeoutseconds: QBFT_REQUEST_TIMEOUT_SECONDS,
      },
    },
    nonce: "0x0",
    timestamp: "0x0",
    extraData: qbftExtraData(validators),
    gasLimit: "0x1fffffffffffff",
    difficulty: "0x1",
    mixHash: QBFT_MIX_HASH,
    coinbase: "0x0000000000000000000000000000000000000000",
    alloc,
    number: "0x0",
    gasUsed: "0x0",
    parentHash: `0x${"00".repeat(32)}`,
  };
}

function rpcApis() {
  const apis = ["ETH", "NET", "WEB3", "QBFT"];
  if (UNSAFE_LOCAL_DEMO || BESU_ENABLE_ADMIN_DEBUG) apis.push("ADMIN", "DEBUG");
  return JSON.stringify(apis);
}

function rpcCorsOrigins() {
  if (UNSAFE_LOCAL_DEMO) return JSON.stringify(["all"]);
  return JSON.stringify(["http://127.0.0.1:5173", "http://localhost:5173"]);
}

function hostAllowlist() {
  if (UNSAFE_LOCAL_DEMO) return JSON.stringify(["*"]);
  return JSON.stringify(["127.0.0.1", "localhost"]);
}

function configToml(network, node, enableRpc) {
  return [
    `data-path="/network/data"`,
    `genesis-file="/network/genesis.json"`,
    `node-private-key-file="/network/key"`,
    `static-nodes-file="/network/static-nodes.json"`,
    `p2p-host="0.0.0.0"`,
    `p2p-port=30303`,
    `discovery-enabled=false`,
    `rpc-http-enabled=${enableRpc ? "true" : "false"}`,
    `rpc-http-host="0.0.0.0"`,
    `rpc-http-port=8545`,
    `rpc-http-api=${rpcApis()}`,
    `rpc-http-cors-origins=${rpcCorsOrigins()}`,
    `host-allowlist=${hostAllowlist()}`,
    `rpc-ws-enabled=false`,
    `min-gas-price=0`,
    `sync-mode="FULL"`,
    `sync-min-peers=0`,
    `# Local demo setting: keep enough Bonsai historical state for storage-proof RPC after idle periods.`,
    `bonsai-historical-block-limit=${BONSAI_HISTORICAL_BLOCK_LIMIT}`,
    `bonsai-trie-logs-pruning-window-size=${BONSAI_TRIE_LOGS_PRUNING_WINDOW_SIZE}`,
    `metrics-enabled=true`,
    `metrics-host="0.0.0.0"`,
    `metrics-port=9546`,
    `logging="INFO"`,
    `identity="${network.key}-${node.name}"`,
    "",
  ].join("\n");
}

function dockerCompose(generatedNetworks) {
  const lines = [
    "services:",
  ];

  for (const { network, validators } of generatedNetworks) {
    for (const [index, node] of validators.entries()) {
      const serviceName = node.name.replace(/-/g, "_");
      const exposeRpc = index === 0;
      lines.push(`  ${serviceName}:`);
      lines.push(`    image: "${BESU_DOCKER_IMAGE}"`);
      lines.push(`    container_name: ${BESU_CONTAINER_PREFIX}-${node.name}`);
      lines.push("    restart: unless-stopped");
      lines.push("    stop_grace_period: 30s");
      lines.push("    security_opt:");
      lines.push("      - no-new-privileges:true");
      lines.push("    environment:");
      lines.push(`      JAVA_OPTS: "${BESU_JAVA_OPTS}"`);
      lines.push(`    command: ["--config-file=/network/config.toml"]`);
      lines.push("    volumes:");
      lines.push(`      - ./${network.key}/genesis.json:/network/genesis.json:ro`);
      lines.push(`      - ./${network.key}/nodes/${node.name}/config.toml:/network/config.toml:ro`);
      lines.push(`      - ./${network.key}/nodes/${node.name}/static-nodes.json:/network/static-nodes.json:ro`);
      lines.push(`      - ./${network.key}/nodes/${node.name}/key:/network/key:ro`);
      lines.push(`      - ./${network.key}/nodes/${node.name}/data:/network/data`);
      if (exposeRpc) {
        lines.push("    ports:");
        lines.push(`      - "127.0.0.1:${network.hostRpcPort}:8545"`);
      }
      lines.push("    networks:");
      lines.push("      thesis_besu:");
      lines.push(`        ipv4_address: ${node.ip}`);
    }
  }

  lines.push("networks:");
  lines.push("  thesis_besu:");
  lines.push("    driver: bridge");
  lines.push("    ipam:");
  lines.push("      config:");
  lines.push(`        - subnet: "${BESU_SUBNET}"`);
  lines.push("");

  return lines.join("\n");
}

async function writeJson(path, value, mode = 0o644) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

async function writeText(path, value, mode = 0o644) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, { mode });
}

async function renderNetwork(network, validators, operators) {
  const networkRoot = resolve(ROOT, network.key);
  const genesis = genesisFor(network, validators, operators);
  const staticNodes = validators.map((validator) => validator.enode);

  await writeJson(resolve(networkRoot, "genesis.json"), genesis);
  await writeJson(
    resolve(networkRoot, "validators.json"),
    validators.map(({ name, address, ip, enode }) => ({ name, address, ip, enode }))
  );
  await writeJson(resolve(networkRoot, "operators.json"), operators, 0o600);

  for (const [index, node] of validators.entries()) {
    const nodeRoot = resolve(networkRoot, "nodes", node.name);
    await mkdir(resolve(nodeRoot, "data"), { recursive: true });
    await writeText(resolve(nodeRoot, "key"), `${node.privateKeyRaw}\n`, 0o600);
    await writeText(resolve(nodeRoot, "address"), `${node.address}\n`);
    await writeJson(resolve(nodeRoot, "static-nodes.json"), staticNodes);
    await writeText(resolve(nodeRoot, "config.toml"), configToml(network, node, index === 0));
  }
}

async function main() {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(BESU_CONTAINER_PREFIX)) {
    throw new Error("BESU_CONTAINER_PREFIX contains unsupported characters");
  }
  if (!Number.isInteger(BESU_SUBNET_SECOND_OCTET) || BESU_SUBNET_SECOND_OCTET < 16 || BESU_SUBNET_SECOND_OCTET > 31) {
    throw new Error("BESU_SUBNET_SECOND_OCTET must be an integer from 16 through 31");
  }
  if (![BESU_CHAIN_A_RPC_PORT, BESU_CHAIN_B_RPC_PORT].every((port) => Number.isInteger(port) && port > 0 && port < 65536)) {
    throw new Error("Besu RPC ports must be valid TCP ports");
  }
  if (!Number.isInteger(QBFT_BLOCK_PERIOD_SECONDS) || QBFT_BLOCK_PERIOD_SECONDS < 1) {
    throw new Error("BESU_QBFT_BLOCK_PERIOD_SECONDS must be a positive integer");
  }
  if (
    !Number.isInteger(QBFT_REQUEST_TIMEOUT_SECONDS) ||
    QBFT_REQUEST_TIMEOUT_SECONDS < QBFT_BLOCK_PERIOD_SECONDS * 2
  ) {
    throw new Error("BESU_QBFT_REQUEST_TIMEOUT_SECONDS must be an integer at least twice the block period");
  }
  if (await reuseCompleteScaffoldIfRequested()) return;

  if (UNSAFE_LOCAL_DEMO) {
    console.warn(
      "[besu:generate] UNSAFE_LOCAL_DEMO=true: deterministic keys, ADMIN/DEBUG RPC, wildcard CORS, and wildcard host allowlist are enabled for local demo only."
    );
  } else if (BESU_ENABLE_ADMIN_DEBUG) {
    console.warn("[besu:generate] BESU_ENABLE_ADMIN_DEBUG=true: ADMIN/DEBUG RPC APIs are enabled in hardened network mode.");
  }
  console.log(`[besu:generate] Generating ${BESU_VALIDATOR_COUNT} validator(s) per bank chain.`);

  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });

  const generatedNetworks = NETWORKS.map((network) => ({
    network,
    validators: network.validators.map((name, index) => nodeSpec(network, name, index)),
    operators: ["deployer", "user", "relayer"].map((label) => operatorSpec(network, label)),
  }));
  for (const { network, validators, operators } of generatedNetworks) {
    await renderNetwork(network, validators, operators);
  }

  const scaffold = {
    version: SCAFFOLD_VERSION,
    generatedAt: new Date().toISOString(),
    validatorCount: BESU_VALIDATOR_COUNT,
    byzantineFaultTolerance: Math.floor((BESU_VALIDATOR_COUNT - 1) / 3),
    dockerImage: BESU_DOCKER_IMAGE,
    javaOpts: BESU_JAVA_OPTS,
    containerPrefix: BESU_CONTAINER_PREFIX,
    subnet: BESU_SUBNET,
    consensus: {
      blockPeriodSeconds: QBFT_BLOCK_PERIOD_SECONDS,
      requestTimeoutSeconds: QBFT_REQUEST_TIMEOUT_SECONDS,
    },
    networks: generatedNetworks.map(({ network, validators }) => ({
      key: network.key,
      chainId: network.chainId,
      hostRpcPort: network.hostRpcPort,
      validators: validators.map(({ name, address, ip }) => ({
        name,
        address,
        ip,
        containerName: `${BESU_CONTAINER_PREFIX}-${name}`,
      })),
    })),
  };
  await writeJson(resolve(ROOT, "scaffold.json"), scaffold);

  const validatorProfile = BESU_VALIDATOR_COUNT >= 4
    ? `Each chain uses ${BESU_VALIDATOR_COUNT} validators with generated local keys and tolerates ${scaffold.byzantineFaultTolerance} unavailable validator(s).`
    : `Each chain uses ${BESU_VALIDATOR_COUNT} validator(s). This can produce blocks but is not a Byzantine-fault-tolerant profile.`;
  const readme = [
    "# Besu QBFT Local Networks",
    "",
    "This directory is generated by `npm run besu:generate`.",
    "",
    "It scaffolds two separate local permissioned EVM bank chains:",
    "",
    `- \`chainA\`: Bank A QBFT network on host RPC \`http://127.0.0.1:${BESU_CHAIN_A_RPC_PORT}\``,
    `- \`chainB\`: Bank B QBFT network on host RPC \`http://127.0.0.1:${BESU_CHAIN_B_RPC_PORT}\``,
    "",
    validatorProfile,
    "",
    UNSAFE_LOCAL_DEMO
      ? "Warning: this directory was generated with `UNSAFE_LOCAL_DEMO=true`; do not treat the keys or RPC surface as hardened."
      : "Default mode avoids deterministic keys, pins the Besu Docker image by digest, isolates each validator key mount, disables ADMIN/DEBUG RPC, and binds host RPC ports to loopback.",
    "",
    `Generated node configs set \`bonsai-historical-block-limit=${BONSAI_HISTORICAL_BLOCK_LIMIT}\` and \`bonsai-trie-logs-pruning-window-size=${BONSAI_TRIE_LOGS_PRUNING_WINDOW_SIZE}\` so the local demo can serve storage proofs after idle periods. This is a local demo retention setting, not production guidance.`,
    "",
    `Validator JVM profile: \`${BESU_JAVA_OPTS}\`.`,
    "",
    `Consensus timing: \`blockperiodseconds=${QBFT_BLOCK_PERIOD_SECONDS}\`, \`requesttimeoutseconds=${QBFT_REQUEST_TIMEOUT_SECONDS}\`. The wider local request timeout prevents premature round changes while Docker Desktop starts validator JVMs.`,
    "",
    "The versioned `scaffold.json` binds the topology expected by health and fault-recovery checks. Each validator container receives only its own key; generated keys remain local evidence credentials, not production custody.",
    "",
  ].join("\n");

  await writeText(resolve(ROOT, "README.md"), readme);
  await writeText(resolve(ROOT, "docker-compose.yml"), dockerCompose(generatedNetworks));
  console.log(`Generated Besu QBFT network scaffolding at ${ROOT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
