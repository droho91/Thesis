import { ethers } from "ethers";
import {
  CHAIN_A_RPC,
  CHAIN_B_RPC,
  defaultBesuRuntimeEnv,
  deploy,
  loadArtifact,
  normalizeRuntime,
  providerForRpc,
  signerForRpc,
  waitForBesuRuntimeReady,
} from "./besu-runtime.mjs";
import { saveRuntimeConfig, toConfigValue, RUNTIME_CONFIG_PATH } from "./interchain-config.mjs";

defaultBesuRuntimeEnv();

const SOURCE_CONNECTION_ID = ethers.encodeBytes32String(process.env.SOURCE_CONNECTION_ID || "connection-a");
const DESTINATION_CONNECTION_ID = ethers.encodeBytes32String(process.env.DESTINATION_CONNECTION_ID || "connection-b");
const SOURCE_CHANNEL_ID = ethers.encodeBytes32String(process.env.SOURCE_CHANNEL_ID || "channel-a");
const DESTINATION_CHANNEL_ID = ethers.encodeBytes32String(process.env.DESTINATION_CHANNEL_ID || "channel-b");
const CHANNEL_VERSION = ethers.hexlify(ethers.toUtf8Bytes(process.env.CHANNEL_VERSION || "ics-004"));
const CONNECTION_PREFIX = ethers.hexlify(ethers.toUtf8Bytes(process.env.CONNECTION_PREFIX || "ibc"));
const ORDER_UNORDERED = 1;
const DEPLOY_TX_GAS_LIMIT = BigInt(process.env.DEPLOY_TX_GAS_LIMIT || process.env.INTERCHAIN_TX_GAS_LIMIT || "10000000");
const DEPLOY_TX_WAIT_TIMEOUT_MS = Number(process.env.DEPLOY_TX_WAIT_TIMEOUT_MS || process.env.TX_WAIT_TIMEOUT_MS || 120000);

function txOptions() {
  return { gasLimit: DEPLOY_TX_GAS_LIMIT };
}

async function waitForTx(tx, label) {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`[deploy] ${label} timed out waiting for ${tx.hash}`));
    }, DEPLOY_TX_WAIT_TIMEOUT_MS);
  });
  const receipt = await Promise.race([tx.wait(), timeout]);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`[deploy] ${label} failed in transaction ${tx.hash}`);
  }
  return receipt;
}

async function txStep(label, send) {
  console.log(`[deploy] ${label}`);
  const tx = await send();
  console.log(`[deploy] ${label} tx=${tx.hash}`);
  return waitForTx(tx, label);
}

async function deployStep(label, artifact, signer, args = []) {
  console.log(`[deploy] deploy ${label}`);
  const contract = await deploy(artifact, signer, args, txOptions());
  console.log(`[deploy] deploy ${label} at ${await addressOf(contract)}`);
  return contract;
}

async function addressOf(contract) {
  return contract.getAddress();
}

async function chainIdOf(provider) {
  return Number((await provider.getNetwork()).chainId);
}

async function loadRuntimeArtifacts() {
  return {
    lightClient: await loadArtifact("clients/BesuLightClient.sol", "BesuLightClient"),
    connectionKeeper: await loadArtifact("core/IBCConnectionKeeper.sol", "IBCConnectionKeeper"),
    channelKeeper: await loadArtifact("core/IBCChannelKeeper.sol", "IBCChannelKeeper"),
    packetHandler: await loadArtifact("core/IBCPacketHandler.sol", "IBCPacketHandler"),
    packetStore: await loadArtifact("core/IBCPacketStore.sol", "IBCPacketStore"),
    bankToken: await loadArtifact("apps/BankToken.sol", "BankToken"),
    policy: await loadArtifact("apps/BankPolicyEngine.sol", "BankPolicyEngine"),
    oracle: await loadArtifact("apps/ManualAssetOracle.sol", "ManualAssetOracle"),
    escrow: await loadArtifact("apps/PolicyControlledEscrowVault.sol", "PolicyControlledEscrowVault"),
    voucher: await loadArtifact("apps/PolicyControlledVoucherToken.sol", "PolicyControlledVoucherToken"),
    lendingPool: await loadArtifact("apps/PolicyControlledLendingPool.sol", "PolicyControlledLendingPool"),
    transferApp: await loadArtifact("apps/PolicyControlledTransferApp.sol", "PolicyControlledTransferApp"),
  };
}

function artifactFingerprint(artifacts) {
  const names = [
    "lightClient",
    "connectionKeeper",
    "channelKeeper",
    "packetHandler",
    "packetStore",
    "bankToken",
    "policy",
    "oracle",
    "escrow",
    "voucher",
    "lendingPool",
    "transferApp",
  ];
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32[]"],
      [names.map((name) => ethers.keccak256(artifacts[name].deployedBytecode || artifacts[name].bytecode || "0x"))]
    )
  );
}

async function deployTransport({ chainId, owner, artifacts }) {
  const ownerAddress = await owner.getAddress();
  const lightClient = await deployStep("BesuLightClient", artifacts.lightClient, owner, [ownerAddress]);
  const lightClientAddress = await addressOf(lightClient);
  const connectionKeeper = await deployStep("IBCConnectionKeeper", artifacts.connectionKeeper, owner, [
    chainId,
    lightClientAddress,
    ownerAddress,
  ]);
  const connectionKeeperAddress = await addressOf(connectionKeeper);
  const channelKeeper = await deployStep("IBCChannelKeeper", artifacts.channelKeeper, owner, [
    chainId,
    connectionKeeperAddress,
    ownerAddress,
  ]);
  const channelKeeperAddress = await addressOf(channelKeeper);
  const packetHandler = await deployStep("IBCPacketHandler", artifacts.packetHandler, owner, [
    chainId,
    lightClientAddress,
    channelKeeperAddress,
    ownerAddress,
  ]);
  const packetStore = await deployStep("IBCPacketStore", artifacts.packetStore, owner, [chainId]);

  return {
    lightClient,
    connectionKeeper,
    channelKeeper,
    packetHandler,
    packetStore,
  };
}

async function deployBankA({ chainId, owner, artifacts, transport }) {
  const ownerAddress = await owner.getAddress();
  const canonicalToken = await deployStep("Bank A canonical token", artifacts.bankToken, owner, [
    "Bank A Deposit Token",
    "aBANK",
  ]);
  const policyEngine = await deployStep("Bank A policy engine", artifacts.policy, owner, [ownerAddress]);
  const escrowVault = await deployStep("Bank A escrow vault", artifacts.escrow, owner, [
    ownerAddress,
    await addressOf(canonicalToken),
    await addressOf(policyEngine),
  ]);
  const transferApp = await deployStep("Bank A transfer app", artifacts.transferApp, owner, [
    chainId,
    await addressOf(transport.packetStore),
    await addressOf(transport.packetHandler),
    await addressOf(escrowVault),
    ethers.ZeroAddress,
    ownerAddress,
  ]);

  return { canonicalToken, policyEngine, escrowVault, transferApp };
}

async function deployBankB({ chainId, owner, artifacts, transport }) {
  const ownerAddress = await owner.getAddress();
  const policyEngine = await deployStep("Bank B policy engine", artifacts.policy, owner, [ownerAddress]);
  const voucherToken = await deployStep("Bank B voucher token", artifacts.voucher, owner, [
    ownerAddress,
    await addressOf(policyEngine),
    "Voucher A",
    "vA",
  ]);
  const debtToken = await deployStep("Bank B debt token", artifacts.bankToken, owner, ["Bank B Credit Token", "bCASH"]);
  const oracle = await deployStep("Bank B oracle", artifacts.oracle, owner, [ownerAddress]);
  const lendingPool = await deployStep("Bank B lending pool", artifacts.lendingPool, owner, [
    ownerAddress,
    await addressOf(voucherToken),
    await addressOf(debtToken),
    await addressOf(policyEngine),
    8_000,
  ]);
  const transferApp = await deployStep("Bank B transfer app", artifacts.transferApp, owner, [
    chainId,
    await addressOf(transport.packetStore),
    await addressOf(transport.packetHandler),
    ethers.ZeroAddress,
    await addressOf(voucherToken),
    ownerAddress,
  ]);

  return { policyEngine, voucherToken, debtToken, oracle, lendingPool, transferApp };
}

async function configureStack({ chainA, chainB, bankA, bankB, chainIdA, chainIdB }) {
  const appAAddress = await addressOf(bankA.transferApp);
  const appBAddress = await addressOf(bankB.transferApp);
  const packetStoreAAddress = await addressOf(chainA.packetStore);
  const packetStoreBAddress = await addressOf(chainB.packetStore);

  await txStep("grant Bank A escrow app", () => bankA.escrowVault.grantApp(appAAddress, txOptions()));
  await txStep("grant Bank B voucher app", () => bankB.voucherToken.grantApp(appBAddress, txOptions()));

  await txStep("grant Bank A policy app role to escrow", async () =>
    bankA.policyEngine.grantRole(await bankA.policyEngine.POLICY_APP_ROLE(), await addressOf(bankA.escrowVault), txOptions())
  );
  await txStep("grant Bank B policy app role to voucher", async () =>
    bankB.policyEngine.grantRole(await bankB.policyEngine.POLICY_APP_ROLE(), await addressOf(bankB.voucherToken), txOptions())
  );
  await txStep("grant Bank B policy app role to lending pool", async () =>
    bankB.policyEngine.grantRole(await bankB.policyEngine.POLICY_APP_ROLE(), await addressOf(bankB.lendingPool), txOptions())
  );

  await txStep("configure Bank A remote route", async () =>
    bankA.transferApp.configureRemoteRoute(
      chainIdB,
      appBAddress,
      SOURCE_CHANNEL_ID,
      DESTINATION_CHANNEL_ID,
      await addressOf(bankA.canonicalToken),
      txOptions()
    )
  );
  await txStep("configure Bank B remote route", async () =>
    bankB.transferApp.configureRemoteRoute(
      chainIdA,
      appAAddress,
      DESTINATION_CHANNEL_ID,
      SOURCE_CHANNEL_ID,
      await addressOf(bankA.canonicalToken),
      txOptions()
    )
  );

  await txStep("bind Bank A packet app", () => chainA.packetHandler.setPortApplication(appAAddress, appAAddress, txOptions()));
  await txStep("bind Bank B packet app", () => chainB.packetHandler.setPortApplication(appBAddress, appBAddress, txOptions()));
  await txStep("trust Bank A packet store on Bank A", () =>
    chainA.packetHandler.setTrustedPacketStore(chainIdA, packetStoreAAddress, txOptions())
  );
  await txStep("trust Bank B packet store on Bank A", () =>
    chainA.packetHandler.setTrustedPacketStore(chainIdB, packetStoreBAddress, txOptions())
  );
  await txStep("trust Bank A packet store on Bank B", () =>
    chainB.packetHandler.setTrustedPacketStore(chainIdA, packetStoreAAddress, txOptions())
  );
  await txStep("trust Bank B packet store on Bank B", () =>
    chainB.packetHandler.setTrustedPacketStore(chainIdB, packetStoreBAddress, txOptions())
  );
}

async function buildConfig({ runtime, artifacts, chainIdA, chainIdB, ownerA, ownerB, chainA, chainB, bankA, bankB }) {
  const ownerAAddress = await ownerA.getAddress();
  const ownerBAddress = await ownerB.getAddress();
  return toConfigValue({
    version: "interchain-lending",
    build: {
      artifactFingerprint: artifactFingerprint(artifacts),
      storageWordRlp: "canonical-trimmed-v1",
    },
    runtime: {
      ...runtime,
      configPath: RUNTIME_CONFIG_PATH,
    },
    constants: {
      order: "unordered",
      orderValue: ORDER_UNORDERED,
      connectionPrefix: CONNECTION_PREFIX,
      channelVersion: CHANNEL_VERSION,
      sourceConnectionId: SOURCE_CONNECTION_ID,
      destinationConnectionId: DESTINATION_CONNECTION_ID,
      sourceChannelId: SOURCE_CHANNEL_ID,
      destinationChannelId: DESTINATION_CHANNEL_ID,
    },
    chains: {
      A: {
        rpc: CHAIN_A_RPC,
        chainId: chainIdA,
        admin: ownerAAddress,
        lightClient: await addressOf(chainA.lightClient),
        connectionKeeper: await addressOf(chainA.connectionKeeper),
        channelKeeper: await addressOf(chainA.channelKeeper),
        packetHandler: await addressOf(chainA.packetHandler),
        packetStore: await addressOf(chainA.packetStore),
        policyEngine: await addressOf(bankA.policyEngine),
        canonicalToken: await addressOf(bankA.canonicalToken),
        escrowVault: await addressOf(bankA.escrowVault),
        transferApp: await addressOf(bankA.transferApp),
      },
      B: {
        rpc: CHAIN_B_RPC,
        chainId: chainIdB,
        admin: ownerBAddress,
        lightClient: await addressOf(chainB.lightClient),
        connectionKeeper: await addressOf(chainB.connectionKeeper),
        channelKeeper: await addressOf(chainB.channelKeeper),
        packetHandler: await addressOf(chainB.packetHandler),
        packetStore: await addressOf(chainB.packetStore),
        policyEngine: await addressOf(bankB.policyEngine),
        voucherToken: await addressOf(bankB.voucherToken),
        debtToken: await addressOf(bankB.debtToken),
        oracle: await addressOf(bankB.oracle),
        lendingPool: await addressOf(bankB.lendingPool),
        transferApp: await addressOf(bankB.transferApp),
      },
    },
    paths: {
      forward: {
        source: "A",
        destination: "B",
        sourceConnectionId: SOURCE_CONNECTION_ID,
        destinationConnectionId: DESTINATION_CONNECTION_ID,
        sourceChannelId: SOURCE_CHANNEL_ID,
        destinationChannelId: DESTINATION_CHANNEL_ID,
      },
      reverse: {
        source: "B",
        destination: "A",
        sourceConnectionId: DESTINATION_CONNECTION_ID,
        destinationConnectionId: SOURCE_CONNECTION_ID,
        sourceChannelId: DESTINATION_CHANNEL_ID,
        destinationChannelId: SOURCE_CHANNEL_ID,
      },
    },
    status: {
      deployed: true,
      proofCheckedHandshakeOpened: false,
      seeded: false,
    },
  });
}

export async function runDeploy() {
  const runtime = normalizeRuntime();
  if (!runtime.besuFirst) {
    throw new Error("deploy-lending-demo.mjs is a Besu-first entrypoint.");
  }

  await waitForBesuRuntimeReady();

  const providerA = providerForRpc(CHAIN_A_RPC);
  const providerB = providerForRpc(CHAIN_B_RPC);
  const chainIdA = await chainIdOf(providerA);
  const chainIdB = await chainIdOf(providerB);
  const ownerA = await signerForRpc(CHAIN_A_RPC, "A", 0);
  const ownerB = await signerForRpc(CHAIN_B_RPC, "B", 0);
  const artifacts = await loadRuntimeArtifacts();

  const chainA = await deployTransport({ chainId: chainIdA, owner: ownerA, artifacts });
  const chainB = await deployTransport({ chainId: chainIdB, owner: ownerB, artifacts });
  const bankA = await deployBankA({ chainId: chainIdA, owner: ownerA, artifacts, transport: chainA });
  const bankB = await deployBankB({ chainId: chainIdB, owner: ownerB, artifacts, transport: chainB });

  await configureStack({ chainA, chainB, bankA, bankB, chainIdA, chainIdB });

  const config = await buildConfig({ runtime, artifacts, chainIdA, chainIdB, ownerA, ownerB, chainA, chainB, bankA, bankB });
  await saveRuntimeConfig(config);

  console.log(`[deploy] deployed Bank A stack on chainId=${chainIdA}`);
  console.log(`[deploy] deployed Bank B stack on chainId=${chainIdB}`);
  console.log(`[deploy] deployment saved to ${RUNTIME_CONFIG_PATH}`);
}

runDeploy()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
