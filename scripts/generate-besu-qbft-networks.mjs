import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ethers } from "ethers";

const ROOT = resolve(process.cwd(), "networks", "besu");
const VANITY = `0x${"00".repeat(32)}`;
const FUNDED_BALANCE = "0x3635C9ADC5DEA00000"; // 1000 ETH
const QBFT_MIX_HASH = "0x63746963616c2062797a616e74696e65206661756c7420746f6c6572616e6365";

const NETWORKS = [
  {
    key: "chainA",
    chainId: 41001,
    label: "Bank A",
    subnetPrefix: "172.30.10",
    hostRpcPort: 8545,
    validators: [
      "bank-a-validator-1",
      "bank-a-validator-2",
      "bank-a-validator-3",
      "bank-a-validator-4",
    ],
  },
  {
    key: "chainB",
    chainId: 41002,
    label: "Bank B",
    subnetPrefix: "172.30.20",
    hostRpcPort: 9545,
    validators: [
      "bank-b-validator-1",
      "bank-b-validator-2",
      "bank-b-validator-3",
      "bank-b-validator-4",
    ],
  },
];

function privateKeyHex(label) {
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
        blockperiodseconds: 2,
        requesttimeoutseconds: 4,
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

function configToml(network, node, enableRpc) {
  return [
    `data-path="/network/nodes/${node.name}/data"`,
    `genesis-file="/network/genesis.json"`,
    `node-private-key-file="/network/nodes/${node.name}/key"`,
    `static-nodes-file="/network/nodes/${node.name}/static-nodes.json"`,
    `p2p-host="0.0.0.0"`,
    `p2p-port=30303`,
    `discovery-enabled=false`,
    `rpc-http-enabled=${enableRpc ? "true" : "false"}`,
    `rpc-http-host="0.0.0.0"`,
    `rpc-http-port=8545`,
    `rpc-http-api=["ETH","NET","WEB3","QBFT","ADMIN","DEBUG"]`,
    `rpc-http-cors-origins=["all"]`,
    `host-allowlist=["*"]`,
    `rpc-ws-enabled=false`,
    `min-gas-price=0`,
    `sync-mode="FULL"`,
    `sync-min-peers=0`,
    `metrics-enabled=true`,
    `metrics-host="0.0.0.0"`,
    `metrics-port=9546`,
    `logging="INFO"`,
    `identity="${network.key}-${node.name}"`,
    "",
  ].join("\n");
}

function dockerCompose(networks) {
  const lines = [
    "services:",
  ];

  for (const network of networks) {
    const validators = network.validators.map((name, index) => nodeSpec(network, name, index));
    for (const [index, node] of validators.entries()) {
      const serviceName = node.name.replace(/-/g, "_");
      const exposeRpc = index === 0;
      lines.push(`  ${serviceName}:`);
      lines.push("    image: hyperledger/besu:latest");
      lines.push(`    container_name: thesis-${node.name}`);
      lines.push(`    command: ["--config-file=/network/nodes/${node.name}/config.toml"]`);
      lines.push("    volumes:");
      lines.push(`      - ./${network.key}:/network`);
      if (exposeRpc) {
        lines.push("    ports:");
        lines.push(`      - "${network.hostRpcPort}:8545"`);
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
  lines.push('        - subnet: "172.30.0.0/16"');
  lines.push("");

  return lines.join("\n");
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

async function renderNetwork(network) {
  const validators = network.validators.map((name, index) => nodeSpec(network, name, index));
  const operators = ["deployer", "user", "relayer"].map((label) => operatorSpec(network, label));
  const networkRoot = resolve(ROOT, network.key);
  const genesis = genesisFor(network, validators, operators);
  const staticNodes = validators.map((validator) => validator.enode);

  await writeJson(resolve(networkRoot, "genesis.json"), genesis);
  await writeJson(
    resolve(networkRoot, "validators.json"),
    validators.map(({ name, address, privateKey, ip, enode }) => ({ name, address, privateKey, ip, enode }))
  );
  await writeJson(resolve(networkRoot, "operators.json"), operators);

  for (const [index, node] of validators.entries()) {
    const nodeRoot = resolve(networkRoot, "nodes", node.name);
    await mkdir(resolve(nodeRoot, "data"), { recursive: true });
    await writeText(resolve(nodeRoot, "key"), `${node.privateKeyRaw}\n`);
    await writeText(resolve(nodeRoot, "address"), `${node.address}\n`);
    await writeJson(resolve(nodeRoot, "static-nodes.json"), staticNodes);
    await writeText(resolve(nodeRoot, "config.toml"), configToml(network, node, index === 0));
  }
}

async function main() {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });

  for (const network of NETWORKS) {
    await renderNetwork(network);
  }

  const readme = [
    "# Besu QBFT Local Networks",
    "",
    "This directory is generated by `npm run besu:generate`.",
    "",
    "It scaffolds two separate local permissioned EVM bank chains:",
    "",
    "- `chainA`: Bank A QBFT network on host RPC `http://127.0.0.1:8545`",
    "- `chainB`: Bank B QBFT network on host RPC `http://127.0.0.1:9545`",
    "",
    "Each chain has four validators with deterministic local keys, a QBFT genesis, and per-node config.",
    "",
    "Use `docker compose -f networks/besu/docker-compose.yml up -d` to start the local networks after generating them.",
    "",
    "Important: this is local thesis scaffolding, but it is now the canonical runtime surface for the Solidity demo flow. The remaining gap is production-grade on-chain Besu header verification, not generator integration.",
    "",
  ].join("\n");

  await writeText(resolve(ROOT, "README.md"), readme);
  await writeText(resolve(ROOT, "docker-compose.yml"), dockerCompose(NETWORKS));
  console.log(`Generated Besu QBFT network scaffolding at ${ROOT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
