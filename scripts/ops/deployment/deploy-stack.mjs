import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import {
  CHAIN_A_RPC,
  CHAIN_B_RPC,
  defaultBesuRuntimeEnv,
  loadArtifact,
  providerForRpc,
  signerForRpc,
  waitForBesuRuntimeReady,
} from "../besu/runtime.mjs";

defaultBesuRuntimeEnv();

export const INSTITUTIONAL_DEPLOYMENT_PATH = resolve(
  process.cwd(),
  process.env.INSTITUTIONAL_DEPLOYMENT_PATH || ".runtime/institutional-deployment.json",
);
export const INSTITUTIONAL_ATTESTOR_SECRETS_PATH = resolve(
  process.cwd(),
  process.env.INSTITUTIONAL_ATTESTOR_SECRETS_PATH || ".runtime/institutional-attestor-secrets.json",
);

const MANIFEST_VERSION = "institutional-deployment-v1";
const ATTESTOR_SECRETS_VERSION = "institutional-attestor-secrets-v1";
const DEPLOY_GAS_LIMIT = BigInt(process.env.INSTITUTIONAL_DEPLOY_GAS_LIMIT || "10000000");
const TX_GAS_LIMIT = BigInt(process.env.INSTITUTIONAL_TX_GAS_LIMIT || "5000000");
const TX_TIMEOUT_MS = Number(process.env.INSTITUTIONAL_TX_TIMEOUT_MS || "90000");
const TRUSTING_PERIOD = BigInt(process.env.INSTITUTIONAL_TRUSTING_PERIOD_SECONDS || 7 * 24 * 60 * 60);
const MAX_CLOCK_DRIFT = BigInt(process.env.INSTITUTIONAL_MAX_CLOCK_DRIFT_SECONDS || 30);
const GOVERNANCE_DELAY = BigInt(process.env.INSTITUTIONAL_GOVERNANCE_DELAY_SECONDS || 60);
const COLLATERAL_FACTOR_BPS = 7_000n;
const LIQUIDATION_THRESHOLD_BPS = 8_000n;
const PER_TRANSFER_LIMIT = ethers.parseEther("10000");
const DAILY_OUTBOUND_LIMIT = ethers.parseEther("100000");
const EXPOSURE_CAP = ethers.parseEther("1000000");
const USER_BORROW_CAP = ethers.parseEther("100000");
const USER_CANONICAL_SEED = ethers.parseEther("100000");
const USER_REPAYMENT_BALANCE_SEED = ethers.parseEther("100");
const LENDER_LIQUIDITY_SEED = ethers.parseEther("1000000");
const ONE_E18 = ethers.parseEther("1");

async function main() {
  console.log("[institutional:deploy] checking Besu runtime");
  await waitForBesuRuntimeReady();

  const providers = {
    A: providerForRpc(CHAIN_A_RPC),
    B: providerForRpc(CHAIN_B_RPC),
  };
  const owners = {
    A: await signerForRpc(CHAIN_A_RPC, "A", 0),
    B: await signerForRpc(CHAIN_B_RPC, "B", 0),
  };
  const users = {
    A: await signerForRpc(CHAIN_A_RPC, "A", 1),
    B: await signerForRpc(CHAIN_B_RPC, "B", 1),
  };
  const relayers = {
    A: await signerForRpc(CHAIN_A_RPC, "A", 2),
    B: await signerForRpc(CHAIN_B_RPC, "B", 2),
  };
  const chainIds = {
    A: (await providers.A.getNetwork()).chainId,
    B: (await providers.B.getNetwork()).chainId,
  };
  if (chainIds.A === chainIds.B) throw new Error("Institutional deployment requires two distinct chain ids");
  const runtimeAccounts = await resolveRuntimeAccounts({ owners, users, relayers });

  const artifacts = await loadArtifacts();
  const fingerprint = artifactFingerprint(artifacts);
  const attestorSecrets = await loadOrCreateAttestorSecrets();
  const attestors = attestorSecrets.attestors.map((entry) => ethers.getAddress(entry.address)).sort(compareAddresses);
  const threshold = 3;

  let manifest = await loadReusableManifest({ fingerprint, chainIds, attestors, runtimeAccounts });
  if (!manifest) {
    manifest = await createManifest({ fingerprint, chainIds, owners, users, relayers, attestors, threshold });
    await saveManifest(manifest);
  }

  const context = { artifacts, manifest, owners, providers };
  const chainA = await deployChainA(context);
  const chainB = await deployChainB(context);
  await configureStack({ ...context, chainA, chainB, users, chainIds, attestors, threshold });
  await seedIntegrationAccounts({ ...context, chainA, chainB, users, chainIds });

  manifest.status = "ready";
  manifest.updatedAt = new Date().toISOString();
  await saveManifest(manifest);
  console.log(`[institutional:deploy] ready: ${INSTITUTIONAL_DEPLOYMENT_PATH}`);
}

async function loadArtifacts() {
  return {
    checkpointClient: await loadArtifact("gateway/InstitutionalCheckpointClient.sol", "InstitutionalCheckpointClient"),
    gateway: await loadArtifact("gateway/InstitutionalCrossChainGateway.sol", "InstitutionalCrossChainGateway"),
    identityRegistry: await loadArtifact("identity/InstitutionalIdentityRegistry.sol", "InstitutionalIdentityRegistry"),
    governance: await loadArtifact(
      "governance/InstitutionalGovernanceTimelock.sol",
      "InstitutionalGovernanceTimelock",
    ),
    bankToken: await loadArtifact("apps/BankToken.sol", "BankToken"),
    policyEngine: await loadArtifact("apps/BankPolicyEngine.sol", "BankPolicyEngine"),
    escrowVault: await loadArtifact("apps/PolicyControlledEscrowVault.sol", "PolicyControlledEscrowVault"),
    voucherToken: await loadArtifact("apps/PolicyControlledVoucherToken.sol", "PolicyControlledVoucherToken"),
    oracle: await loadArtifact("apps/ManualAssetOracle.sol", "ManualAssetOracle"),
    lendingPool: await loadArtifact("apps/PolicyControlledLendingPool.sol", "PolicyControlledLendingPool"),
    collateralApp: await loadArtifact("apps/InstitutionalCollateralApp.sol", "InstitutionalCollateralApp"),
  };
}

function artifactFingerprint(artifacts) {
  const hashes = Object.keys(artifacts)
    .sort()
    .map((name) => ethers.keccak256(artifacts[name].deployedBytecode || artifacts[name].bytecode));
  return ethers.keccak256(ethers.concat(hashes));
}

async function createManifest({ fingerprint, chainIds, owners, users, relayers, attestors, threshold }) {
  const now = new Date().toISOString();
  return {
    version: MANIFEST_VERSION,
    status: "deploying",
    artifactFingerprint: fingerprint,
    createdAt: now,
    updatedAt: now,
    securityProfile: {
      checkpointModel: `${threshold}-of-${attestors.length} institutional attestors`,
      attestorThreshold: threshold,
      attestors,
      trustingPeriodSeconds: TRUSTING_PERIOD.toString(),
      maxClockDriftSeconds: MAX_CLOCK_DRIFT.toString(),
      finalityDepth: Number(process.env.INSTITUTIONAL_FINALITY_DEPTH || 2),
      governanceMode: "bootstrap",
      governanceDelaySeconds: GOVERNANCE_DELAY.toString(),
      note: "Local integration profile. Production attestor keys must be held by separate institutions/HSMs.",
    },
    accounts: {
      A: {
        owner: await owners.A.getAddress(),
        user: await users.A.getAddress(),
        relayer: await relayers.A.getAddress(),
      },
      B: {
        owner: await owners.B.getAddress(),
        user: await users.B.getAddress(),
        relayer: await relayers.B.getAddress(),
      },
    },
    chains: {
      A: { chainId: chainIds.A.toString(), rpc: CHAIN_A_RPC, deploymentBlock: null, contracts: {} },
      B: { chainId: chainIds.B.toString(), rpc: CHAIN_B_RPC, deploymentBlock: null, contracts: {} },
    },
  };
}

async function resolveRuntimeAccounts({ owners, users, relayers }) {
  return {
    A: {
      owner: await owners.A.getAddress(),
      user: await users.A.getAddress(),
      relayer: await relayers.A.getAddress(),
    },
    B: {
      owner: await owners.B.getAddress(),
      user: await users.B.getAddress(),
      relayer: await relayers.B.getAddress(),
    },
  };
}

async function loadReusableManifest({ fingerprint, chainIds, attestors, runtimeAccounts }) {
  if (process.argv.includes("--force")) return null;
  const current = await readJsonIfExists(INSTITUTIONAL_DEPLOYMENT_PATH);
  if (!current) return null;
  if (
    current.version !== MANIFEST_VERSION ||
    current.artifactFingerprint !== fingerprint ||
    BigInt(current.chains?.A?.chainId || 0) !== chainIds.A ||
    BigInt(current.chains?.B?.chainId || 0) !== chainIds.B ||
    !sameAddressList(current.securityProfile?.attestors, attestors) ||
    !manifestAccountsMatchRuntime(current.accounts, runtimeAccounts)
  ) {
    console.log("[institutional:deploy] manifest does not match current bytecode/network/accounts; starting a fresh stack");
    return null;
  }
  console.log("[institutional:deploy] resuming compatible manifest");
  return current;
}

async function loadOrCreateAttestorSecrets() {
  const existing = await readJsonIfExists(INSTITUTIONAL_ATTESTOR_SECRETS_PATH);
  if (existing) {
    if (existing.version !== ATTESTOR_SECRETS_VERSION || existing.attestors?.length !== 4) {
      throw new Error(`Unsupported attestor secret file at ${INSTITUTIONAL_ATTESTOR_SECRETS_PATH}`);
    }
    for (const entry of existing.attestors) {
      const wallet = new ethers.Wallet(entry.privateKey);
      if (ethers.getAddress(entry.address) !== wallet.address) throw new Error("Attestor key/address mismatch");
    }
    return existing;
  }

  const created = {
    version: ATTESTOR_SECRETS_VERSION,
    createdAt: new Date().toISOString(),
    attestors: Array.from({ length: 4 }, (_, index) => {
      const wallet = ethers.Wallet.createRandom();
      return { id: `attestor-${index + 1}`, address: wallet.address, privateKey: wallet.privateKey };
    }),
  };
  await writeJsonAtomic(INSTITUTIONAL_ATTESTOR_SECRETS_PATH, created, 0o600);
  console.log(`[institutional:deploy] generated local attestor keys at ${INSTITUTIONAL_ATTESTOR_SECRETS_PATH}`);
  return created;
}

async function deployChainA(context) {
  const { manifest, owners, artifacts } = context;
  const ownerAddress = await owners.A.getAddress();
  const chainId = BigInt(manifest.chains.A.chainId);
  const checkpointClient = await deployOrAttach(context, "A", "checkpointClient", artifacts.checkpointClient, [
    ownerAddress,
    TRUSTING_PERIOD,
    MAX_CLOCK_DRIFT,
  ]);
  const gateway = await deployOrAttach(context, "A", "gateway", artifacts.gateway, [
    chainId,
    await checkpointClient.getAddress(),
    ownerAddress,
  ]);
  const identityRegistry = await deployOrAttach(context, "A", "identityRegistry", artifacts.identityRegistry, [
    ownerAddress,
  ]);
  const policyEngine = await deployOrAttach(context, "A", "policyEngine", artifacts.policyEngine, [ownerAddress]);
  const canonicalToken = await deployOrAttach(context, "A", "canonicalToken", artifacts.bankToken, [
    "Bank A Deposit Token",
    "aBANK",
  ]);
  const escrowVault = await deployOrAttach(context, "A", "escrowVault", artifacts.escrowVault, [
    ownerAddress,
    await canonicalToken.getAddress(),
    await policyEngine.getAddress(),
  ]);
  const collateralApp = await deployOrAttach(context, "A", "collateralApp", artifacts.collateralApp, [
    chainId,
    await gateway.getAddress(),
    await identityRegistry.getAddress(),
    await escrowVault.getAddress(),
    ethers.ZeroAddress,
    ownerAddress,
  ]);
  const governance = await deployOrAttach(context, "A", "governance", artifacts.governance, [
    GOVERNANCE_DELAY,
    [ownerAddress],
    [ownerAddress],
    ownerAddress,
  ]);
  return { checkpointClient, gateway, identityRegistry, policyEngine, canonicalToken, escrowVault, collateralApp, governance };
}

async function deployChainB(context) {
  const { manifest, owners, artifacts } = context;
  const ownerAddress = await owners.B.getAddress();
  const chainId = BigInt(manifest.chains.B.chainId);
  const checkpointClient = await deployOrAttach(context, "B", "checkpointClient", artifacts.checkpointClient, [
    ownerAddress,
    TRUSTING_PERIOD,
    MAX_CLOCK_DRIFT,
  ]);
  const gateway = await deployOrAttach(context, "B", "gateway", artifacts.gateway, [
    chainId,
    await checkpointClient.getAddress(),
    ownerAddress,
  ]);
  const identityRegistry = await deployOrAttach(context, "B", "identityRegistry", artifacts.identityRegistry, [
    ownerAddress,
  ]);
  const policyEngine = await deployOrAttach(context, "B", "policyEngine", artifacts.policyEngine, [ownerAddress]);
  const voucherToken = await deployOrAttach(context, "B", "voucherToken", artifacts.voucherToken, [
    ownerAddress,
    await policyEngine.getAddress(),
    "Bank A Collateral Voucher",
    "vABANK",
  ]);
  const debtToken = await deployOrAttach(context, "B", "debtToken", artifacts.bankToken, [
    "Bank B Credit Token",
    "bCASH",
  ]);
  const oracle = await deployOrAttach(context, "B", "oracle", artifacts.oracle, [ownerAddress]);
  const lendingPool = await deployOrAttach(context, "B", "lendingPool", artifacts.lendingPool, [
    ownerAddress,
    await voucherToken.getAddress(),
    await debtToken.getAddress(),
    await policyEngine.getAddress(),
    COLLATERAL_FACTOR_BPS,
    LIQUIDATION_THRESHOLD_BPS,
  ]);
  const collateralApp = await deployOrAttach(context, "B", "collateralApp", artifacts.collateralApp, [
    chainId,
    await gateway.getAddress(),
    await identityRegistry.getAddress(),
    ethers.ZeroAddress,
    await voucherToken.getAddress(),
    ownerAddress,
  ]);
  const governance = await deployOrAttach(context, "B", "governance", artifacts.governance, [
    GOVERNANCE_DELAY,
    [ownerAddress],
    [ownerAddress],
    ownerAddress,
  ]);
  return { checkpointClient, gateway, identityRegistry, policyEngine, voucherToken, debtToken, oracle, lendingPool, collateralApp, governance };
}

async function configureStack({ chainA, chainB, chainIds, attestors, threshold, users }) {
  const appA = await chainA.collateralApp.getAddress();
  const appB = await chainB.collateralApp.getAddress();
  const gatewayA = await chainA.gateway.getAddress();
  const gatewayB = await chainB.gateway.getAddress();
  const canonicalAsset = await chainA.canonicalToken.getAddress();
  const voucherAsset = await chainB.voucherToken.getAddress();
  const debtAsset = await chainB.debtToken.getAddress();
  const userA = await users.A.getAddress();
  const userB = await users.B.getAddress();

  await ensureSource(chainA.checkpointClient, chainIds.B, attestors, threshold, "Bank A trusts Bank B checkpoints");
  await ensureSource(chainB.checkpointClient, chainIds.A, attestors, threshold, "Bank B trusts Bank A checkpoints");
  await ensureValue(chainA.gateway.remoteGatewayByChain(chainIds.B), gatewayB, "Bank A remote gateway", () =>
    chainA.gateway.setRemoteGateway(chainIds.B, gatewayB, txOptions()),
  );
  await ensureValue(chainB.gateway.remoteGatewayByChain(chainIds.A), gatewayA, "Bank B remote gateway", () =>
    chainB.gateway.setRemoteGateway(chainIds.A, gatewayA, txOptions()),
  );
  await ensureGatewayRoute(chainA.gateway, appA, chainIds.B, appB, "Bank A application route");
  await ensureGatewayRoute(chainB.gateway, appB, chainIds.A, appA, "Bank B application route");

  await ensureAppRoute(chainA.collateralApp, chainIds.B, appB, canonicalAsset, "Bank A collateral route");
  await ensureAppRoute(chainB.collateralApp, chainIds.A, appA, canonicalAsset, "Bank B collateral route");
  await ensureBigInt(
    chainA.collateralApp.dailyOutboundLimit(canonicalAsset),
    DAILY_OUTBOUND_LIMIT,
    "Bank A daily outbound limit",
    () => chainA.collateralApp.setDailyOutboundLimit(canonicalAsset, DAILY_OUTBOUND_LIMIT, txOptions()),
  );
  await ensureBigInt(
    chainB.collateralApp.dailyOutboundLimit(canonicalAsset),
    DAILY_OUTBOUND_LIMIT,
    "Bank B daily outbound limit",
    () => chainB.collateralApp.setDailyOutboundLimit(canonicalAsset, DAILY_OUTBOUND_LIMIT, txOptions()),
  );

  await ensureValue(chainB.voucherToken.canonicalAsset(), canonicalAsset, "bind canonical voucher asset", () =>
    chainB.voucherToken.bindCanonicalAsset(canonicalAsset, txOptions()),
  );
  await ensureRole(chainA.escrowVault, await chainA.escrowVault.APP_ROLE(), appA, "Bank A escrow app role");
  await ensureRole(chainB.voucherToken, await chainB.voucherToken.APP_ROLE(), appB, "Bank B voucher app role");
  await ensureRole(
    chainB.voucherToken,
    await chainB.voucherToken.TRANSFER_OPERATOR_ROLE(),
    await chainB.lendingPool.getAddress(),
    "Bank B voucher lending transfer role",
  );
  await ensureRole(
    chainA.policyEngine,
    await chainA.policyEngine.POLICY_APP_ROLE(),
    await chainA.escrowVault.getAddress(),
    "Bank A escrow policy role",
  );
  await ensureRole(
    chainB.policyEngine,
    await chainB.policyEngine.POLICY_APP_ROLE(),
    voucherAsset,
    "Bank B voucher policy role",
  );
  await ensureRole(
    chainB.policyEngine,
    await chainB.policyEngine.POLICY_APP_ROLE(),
    await chainB.lendingPool.getAddress(),
    "Bank B lending policy role",
  );

  await ensureIdentityRoles(chainA.identityRegistry, await chainA.identityRegistry.runner.getAddress(), "Bank A");
  await ensureIdentityRoles(chainB.identityRegistry, await chainB.identityRegistry.runner.getAddress(), "Bank B");
  await ensureValue(
    chainA.policyEngine.identityRegistry(),
    await chainA.identityRegistry.getAddress(),
    "Bank A identity policy",
    () => chainA.policyEngine.setIdentityRegistry(chainA.identityRegistry.getAddress(), txOptions()),
  );
  await ensureValue(
    chainB.policyEngine.identityRegistry(),
    await chainB.identityRegistry.getAddress(),
    "Bank B identity policy",
    () => chainB.policyEngine.setIdentityRegistry(chainB.identityRegistry.getAddress(), txOptions()),
  );
  await ensureCredential(chainA.identityRegistry, userA, "bank-a-user");
  await ensureCredential(chainB.identityRegistry, userB, "bank-b-user");
  await ensureBoolean(chainA.policyEngine.accountAllowed(userA), true, "allow Bank A user", () =>
    chainA.policyEngine.setAccountAllowed(userA, true, txOptions()),
  );
  await ensureBoolean(chainB.policyEngine.accountAllowed(userB), true, "allow Bank B user", () =>
    chainB.policyEngine.setAccountAllowed(userB, true, txOptions()),
  );
  await ensureBoolean(chainA.policyEngine.sourceChainAllowed(chainIds.B), true, "allow Bank B source", () =>
    chainA.policyEngine.setSourceChainAllowed(chainIds.B, true, txOptions()),
  );
  await ensureBoolean(chainB.policyEngine.sourceChainAllowed(chainIds.A), true, "allow Bank A source", () =>
    chainB.policyEngine.setSourceChainAllowed(chainIds.A, true, txOptions()),
  );
  await ensureBoolean(chainA.policyEngine.unlockAssetAllowed(canonicalAsset), true, "allow canonical unlock", () =>
    chainA.policyEngine.setUnlockAssetAllowed(canonicalAsset, true, txOptions()),
  );
  await ensureBoolean(chainB.policyEngine.mintAssetAllowed(canonicalAsset), true, "allow voucher mint", () =>
    chainB.policyEngine.setMintAssetAllowed(canonicalAsset, true, txOptions()),
  );
  await ensureBoolean(chainB.policyEngine.collateralAssetAllowed(voucherAsset), true, "allow voucher collateral", () =>
    chainB.policyEngine.setCollateralAssetAllowed(voucherAsset, true, txOptions()),
  );
  await ensureBoolean(chainB.policyEngine.debtAssetAllowed(debtAsset), true, "allow debt asset", () =>
    chainB.policyEngine.setDebtAssetAllowed(debtAsset, true, txOptions()),
  );
  await ensureBigInt(
    chainB.policyEngine.voucherExposureCap(canonicalAsset),
    EXPOSURE_CAP,
    "voucher exposure cap",
    () => chainB.policyEngine.setVoucherExposureCap(canonicalAsset, EXPOSURE_CAP, txOptions()),
  );
  await ensureBigInt(chainB.policyEngine.collateralCap(voucherAsset), EXPOSURE_CAP, "collateral cap", () =>
    chainB.policyEngine.setCollateralCap(voucherAsset, EXPOSURE_CAP, txOptions()),
  );
  await ensureBigInt(chainB.policyEngine.debtAssetBorrowCap(debtAsset), EXPOSURE_CAP, "debt asset cap", () =>
    chainB.policyEngine.setDebtAssetBorrowCap(debtAsset, EXPOSURE_CAP, txOptions()),
  );
  await ensureBigInt(chainB.policyEngine.accountBorrowCap(userB), USER_BORROW_CAP, "user borrow cap", () =>
    chainB.policyEngine.setAccountBorrowCap(userB, USER_BORROW_CAP, txOptions()),
  );

  await ensureValue(chainB.lendingPool.valuationOracle(), await chainB.oracle.getAddress(), "lending oracle", () =>
    chainB.lendingPool.setValuationOracle(chainB.oracle.getAddress(), txOptions()),
  );
  await ensureBigInt(chainB.oracle.maxStaleness(), 30n * 24n * 60n * 60n, "oracle max staleness", () =>
    chainB.oracle.setMaxStaleness(30n * 24n * 60n * 60n, txOptions()),
  );
  await ensureFreshOraclePrice(chainB.oracle, voucherAsset, ONE_E18, "voucher price");
  await ensureFreshOraclePrice(chainB.oracle, debtAsset, ONE_E18, "debt price");
}

async function seedIntegrationAccounts({ chainA, chainB, users, manifest }) {
  const userA = await users.A.getAddress();
  const userB = await users.B.getAddress();
  const ownerB = manifest.accounts.B.owner;
  await ensureMinimumBalance(chainA.canonicalToken, userA, USER_CANONICAL_SEED, "seed Bank A canonical asset");
  await ensureMinimumBalance(chainB.debtToken, userB, USER_REPAYMENT_BALANCE_SEED, "seed Bank B repayment balance");
  await ensureMinimumBalance(chainB.debtToken, ownerB, LENDER_LIQUIDITY_SEED, "seed Bank B lender liquidity");
}

async function deployOrAttach(context, chainKey, name, artifact, args) {
  const { manifest, owners, providers } = context;
  const chain = manifest.chains[chainKey];
  let entry = chain.contracts[name];
  if (entry?.address) {
    const code = await providers[chainKey].getCode(entry.address);
    if (code !== "0x") {
      console.log(`[institutional:deploy] reuse ${chainKey}.${name} at ${entry.address}`);
      return new ethers.Contract(entry.address, artifact.abi, owners[chainKey]);
    }
    if (entry.transactionHash) {
      const pending = await providers[chainKey].getTransaction(entry.transactionHash);
      if (pending) {
        console.log(`[institutional:deploy] resume pending ${chainKey}.${name} tx=${entry.transactionHash}`);
        const receipt = await waitForTx(pending, `deploy ${chainKey}.${name}`);
        entry.deploymentBlock = receipt.blockNumber;
        await saveManifest(manifest);
        return new ethers.Contract(entry.address, artifact.abi, owners[chainKey]);
      }
    }
    delete chain.contracts[name];
  }

  console.log(`[institutional:deploy] deploy ${chainKey}.${name}`);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, owners[chainKey]);
  const contract = await factory.deploy(...args, { gasLimit: DEPLOY_GAS_LIMIT });
  const transaction = contract.deploymentTransaction();
  entry = {
    address: await contract.getAddress(),
    transactionHash: transaction.hash,
    deploymentBlock: null,
  };
  chain.contracts[name] = entry;
  await saveManifest(manifest);
  const receipt = await waitForTx(transaction, `deploy ${chainKey}.${name}`);
  entry.deploymentBlock = receipt.blockNumber;
  chain.deploymentBlock = chain.deploymentBlock == null
    ? receipt.blockNumber
    : Math.min(Number(chain.deploymentBlock), receipt.blockNumber);
  await saveManifest(manifest);
  console.log(`[institutional:deploy] deployed ${chainKey}.${name} at ${entry.address}`);
  return contract;
}

async function ensureSource(client, sourceChainId, attestors, threshold, label) {
  const status = BigInt(await client.status(sourceChainId));
  if (status === 1n) {
    const epoch = await client.currentAttestorEpoch(sourceChainId);
    const configured = await client.attestorSet(sourceChainId, epoch);
    const configuredThreshold = Number(configured.threshold ?? configured[0]);
    const configuredAttestors = configured.attestors ?? configured[2];
    if (configuredThreshold !== threshold || !sameAddressList(configuredAttestors, attestors)) {
      throw new Error(`${label} does not match the deployment attestor profile`);
    }
    return;
  }
  if (status !== 0n) throw new Error(`${label} is not active (status=${status})`);
  await txStep(label, () => client.configureSource(sourceChainId, attestors, threshold, txOptions()));
}

async function ensureGatewayRoute(gateway, localApp, remoteChainId, remoteApp, label) {
  const key = await gateway.routeKey(localApp, remoteChainId, remoteApp);
  await ensureBoolean(gateway.applicationRoutes(key), true, label, () =>
    gateway.setApplicationRoute(localApp, remoteChainId, remoteApp, true, txOptions()),
  );
}

async function ensureAppRoute(app, remoteChainId, remoteApp, canonicalAsset, label) {
  const route = await app.remoteRoutes(remoteChainId);
  const matches =
    route.enabled &&
    sameAddress(route.remoteApplication, remoteApp) &&
    sameAddress(route.canonicalAsset, canonicalAsset) &&
    BigInt(route.perTransferLimit) === PER_TRANSFER_LIMIT;
  if (matches) return;
  await txStep(label, () =>
    app.configureRemoteRoute(remoteChainId, remoteApp, canonicalAsset, PER_TRANSFER_LIMIT, true, txOptions()),
  );
}

async function ensureIdentityRoles(registry, admin, label) {
  await ensureRole(registry, await registry.IDENTITY_ISSUER_ROLE(), admin, `${label} identity issuer role`);
  await ensureRole(registry, await registry.COMPLIANCE_ROLE(), admin, `${label} compliance role`);
  await ensureRole(registry, await registry.GUARDIAN_ROLE(), admin, `${label} identity guardian role`);
}

async function ensureCredential(registry, account, reference) {
  const status = BigInt(await registry.effectiveStatus(account));
  if (status !== 0n) {
    if (status !== 1n) throw new Error(`Credential for ${account} is not active (status=${status})`);
    return;
  }
  const currentBlock = await registry.runner.provider.getBlock("latest");
  const validUntil = BigInt(currentBlock.timestamp) + 365n * 24n * 60n * 60n;
  await txStep(`issue credential for ${reference}`, () =>
    registry.issueCredential(
      account,
      ethers.keccak256(ethers.toUtf8Bytes(`institutional-demo:${reference}:${account}`)),
      ethers.encodeBytes32String("VN"),
      validUntil,
      1,
      txOptions(),
    ),
  );
}

async function ensureRole(contract, role, account, label) {
  if (await contract.hasRole(role, account)) return;
  await txStep(label, () => contract.grantRole(role, account, txOptions()));
}

async function ensureMinimumBalance(token, account, minimum, label) {
  const balance = BigInt(await token.balanceOf(account));
  if (balance >= minimum) return;
  await txStep(label, () => token.mint(account, minimum - balance, txOptions()));
}

async function ensureFreshOraclePrice(oracle, asset, expectedPrice, label) {
  const [price, updatedAt, maxStaleness, block] = await Promise.all([
    oracle.assetPriceE18(asset),
    oracle.assetPriceUpdatedAt(asset),
    oracle.maxStaleness(),
    oracle.runner.provider.getBlock("latest"),
  ]);
  const refreshBefore = BigInt(updatedAt) + BigInt(maxStaleness) / 2n;
  if (BigInt(price) === expectedPrice && BigInt(block.timestamp) < refreshBefore) return;
  await txStep(label, () => oracle.setPrice(asset, expectedPrice, txOptions()));
}

async function ensureValue(currentPromise, expected, label, send) {
  const current = await currentPromise;
  if (sameAddress(current, expected)) return;
  await txStep(label, send);
}

async function ensureBoolean(currentPromise, expected, label, send) {
  if (Boolean(await currentPromise) === expected) return;
  await txStep(label, send);
}

async function ensureBigInt(currentPromise, expected, label, send) {
  if (BigInt(await currentPromise) === BigInt(expected)) return;
  await txStep(label, send);
}

function sameAddress(left, right) {
  return ethers.getAddress(left) === ethers.getAddress(right);
}

function compareAddresses(left, right) {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function sameAddressList(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((address, index) => sameAddress(address, right[index]));
}

export function manifestAccountsMatchRuntime(manifestAccounts, runtimeAccounts) {
  return ["A", "B"].every((chainKey) =>
    ["owner", "user", "relayer"].every((role) => {
      const manifestAddress = manifestAccounts?.[chainKey]?.[role];
      const runtimeAddress = runtimeAccounts?.[chainKey]?.[role];
      return Boolean(manifestAddress && runtimeAddress && sameAddress(manifestAddress, runtimeAddress));
    }),
  );
}

function txOptions() {
  return { gasLimit: TX_GAS_LIMIT };
}

async function txStep(label, send) {
  console.log(`[institutional:deploy] configure ${label}`);
  const transaction = await send();
  await waitForTx(transaction, label);
}

async function waitForTx(transaction, label) {
  let timer;
  try {
    const receipt = await Promise.race([
      transaction.wait(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`[institutional:deploy] ${label} timed out after ${TX_TIMEOUT_MS}ms; tx=${transaction.hash}`)),
          TX_TIMEOUT_MS,
        );
      }),
    ]);
    if (!receipt || receipt.status !== 1) throw new Error(`[institutional:deploy] ${label} failed; tx=${transaction.hash}`);
    return receipt;
  } finally {
    clearTimeout(timer);
  }
}

async function saveManifest(manifest) {
  manifest.updatedAt = new Date().toISOString();
  await writeJsonAtomic(INSTITUTIONAL_DEPLOYMENT_PATH, manifest);
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomic(path, value, mode = 0o644) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
  await rename(temporary, path);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
