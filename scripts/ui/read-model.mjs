import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { loadArtifact, providerForRpc } from "../ops/besu/runtime.mjs";

export const INSTITUTIONAL_DEPLOYMENT_PATH = resolve(
  process.cwd(),
  process.env.INSTITUTIONAL_DEPLOYMENT_PATH || ".runtime/institutional-deployment.json",
);
export const INSTITUTIONAL_DEMO_STATE_PATH = resolve(
  process.cwd(),
  process.env.INSTITUTIONAL_DEMO_STATE_PATH || ".runtime/institutional-demo-state.json",
);

const WAD = 10n ** 18n;
const MAX_UINT256 = (1n << 256n) - 1n;

export function formatTokenAmount(value) {
  return ethers.formatUnits(BigInt(value ?? 0), 18);
}

export function parseActionAmount(value, { field = "amount", maximum = null } = {}) {
  if (value == null || String(value).trim() === "") throw badRequest(`${field} is required`);
  let amount;
  try {
    amount = ethers.parseUnits(String(value).trim(), 18);
  } catch {
    throw badRequest(`${field} must be a decimal token amount with at most 18 decimals`);
  }
  if (amount <= 0n) throw badRequest(`${field} must be greater than zero`);
  if (maximum != null && amount > BigInt(maximum)) throw badRequest(`${field} exceeds the available on-chain amount`);
  return amount;
}

export function summarizeRelayJournal(snapshot, activeAttestors = 0) {
  const jobs = Object.values(snapshot?.jobs || {});
  const terminal = new Set(["completed", "timed_out", "failed_permanent"]);
  const latest = jobs.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] || null;
  return {
    online: activeAttestors > 0,
    activeAttestors,
    observedMessages: jobs.length,
    pendingMessages: jobs.filter((job) => !terminal.has(job.state)).length,
    completedMessages: jobs.filter((job) => job.state === "completed").length,
    latestJob: latest
      ? {
          messageId: latest.messageId,
          lane: latest.laneId,
          state: latest.state,
          sourceTransaction: latest.sourceTxHash,
          transactions: latest.transactions || {},
          updatedAt: latest.updatedAt,
          lastError: latest.lastError?.message || null,
        }
      : null,
  };
}

export function deriveInstitutionalWorkflow(status) {
  if (!status?.ready) return { stage: "prepare", nextAction: null };
  if (status.controller?.activeOperation) {
    return { stage: "processing", nextAction: status.controller.activeOperation.action };
  }

  const balances = status.balances || {};
  const latestAction = status.activity?.latest?.action;
  const canonical = decimal(balances.canonicalAvailable);
  const voucher = decimal(balances.voucherAvailable);
  const collateral = decimal(balances.activeCollateral);
  const debt = decimal(balances.outstandingDebt);

  if (debt > 0) return { stage: "manage", nextAction: "repay" };
  if (collateral > 0) return { stage: "lend", nextAction: status.risk?.availableBorrowRaw !== "0" ? "borrow" : "withdraw" };
  if (voucher > 0) {
    const returning = ["withdraw", "repay", "repayAll"].includes(latestAction);
    return { stage: returning ? "return" : "lend", nextAction: returning ? "return" : "deposit" };
  }
  if (canonical > 0) return { stage: "transfer", nextAction: "bridge" };
  return { stage: "review", nextAction: null };
}

export async function readInstitutionalStatus(runtime = {}) {
  const manifest = runtime.manifest || await readJsonIfExists(INSTITUTIONAL_DEPLOYMENT_PATH);
  const activity = runtime.activity || await readJsonIfExists(INSTITUTIONAL_DEMO_STATE_PATH) || emptyActivity();
  if (!manifest) return unavailableStatus("Institutional stack is not deployed", activity);
  if (manifest.version !== "institutional-deployment-v1" || manifest.status !== "ready") {
    return unavailableStatus("Institutional deployment manifest is incomplete", activity, manifest);
  }

  const providers = runtime.providers || {
    A: providerForRpc(manifest.chains.A.rpc),
    B: providerForRpc(manifest.chains.B.rpc),
  };
  const artifacts = runtime.artifacts || await loadViewArtifacts();
  const contracts = runtime.contracts || createViewContracts(manifest, providers, artifacts);

  try {
    await assertDeploymentCode(manifest, providers);
    const status = await readOnChainStatus({ manifest, providers, contracts, activity, runtime });
    status.workflow = deriveInstitutionalWorkflow(status);
    return status;
  } catch (error) {
    return {
      ...unavailableStatus(`Institutional runtime is not readable: ${compactError(error)}`, activity, manifest),
      error: compactError(error),
    };
  }
}

async function readOnChainStatus({ manifest, providers, contracts, activity, runtime }) {
  const userA = manifest.accounts.A.user;
  const userB = manifest.accounts.B.user;
  const chainAId = BigInt(manifest.chains.A.chainId);
  const chainBId = BigInt(manifest.chains.B.chainId);
  const [
    blockA,
    blockB,
    canonicalAvailable,
    escrowed,
    voucherAvailable,
    creditAvailable,
    activeCollateral,
    outstandingDebt,
    poolLiquidity,
    totalBorrows,
    maxBorrow,
    availableBorrow,
    collateralValue,
    liquidationValue,
    healthFactor,
    collateralFactorBps,
    liquidationThresholdBps,
    voucherPrice,
    debtPrice,
    voucherPriceUpdatedAt,
    debtPriceUpdatedAt,
    nextNonceA,
    nextNonceB,
    trustedAOnB,
    trustedBOnA,
    identityA,
    identityB,
    governanceDelayA,
    governanceDelayB,
  ] = await Promise.all([
    providers.A.getBlockNumber(),
    providers.B.getBlockNumber(),
    contracts.canonicalTokenA.balanceOf(userA),
    contracts.escrowVaultA.totalEscrowed(),
    contracts.voucherTokenB.balanceOf(userB),
    contracts.debtTokenB.balanceOf(userB),
    contracts.lendingPoolB.collateralBalance(userB),
    contracts.lendingPoolB.debtOf(userB),
    contracts.lendingPoolB.availableLiquidity(),
    contracts.lendingPoolB.accruedTotalBorrows(),
    contracts.lendingPoolB.maxBorrow(userB),
    contracts.lendingPoolB.availableToBorrow(userB),
    contracts.lendingPoolB.collateralValue(userB),
    contracts.lendingPoolB.liquidationThresholdValue(userB),
    contracts.lendingPoolB.healthFactorE18(userB),
    contracts.lendingPoolB.collateralFactorBps(),
    contracts.lendingPoolB.liquidationThresholdBps(),
    contracts.oracleB.assetPriceE18(manifest.chains.B.contracts.voucherToken.address),
    contracts.oracleB.assetPriceE18(manifest.chains.B.contracts.debtToken.address),
    contracts.oracleB.assetPriceUpdatedAt(manifest.chains.B.contracts.voucherToken.address),
    contracts.oracleB.assetPriceUpdatedAt(manifest.chains.B.contracts.debtToken.address),
    contracts.gatewayA.nextNonce(),
    contracts.gatewayB.nextNonce(),
    contracts.checkpointClientB.latestTrustedHeight(chainAId),
    contracts.checkpointClientA.latestTrustedHeight(chainBId),
    contracts.identityRegistryA.effectiveStatus(userA),
    contracts.identityRegistryB.effectiveStatus(userB),
    contracts.governanceA.getMinDelay(),
    contracts.governanceB.getMinDelay(),
  ]);

  const scaffold = await readJsonIfExists(resolve(process.cwd(), process.env.BESU_NETWORK_ROOT || "networks/besu", "scaffold.json"));
  const relay = summarizeRelayJournal(runtime.relayJournal?.snapshot?.(), runtime.activeAttestors || 0);
  const status = {
    ready: true,
    deployed: true,
    stackVersion: "institutional-v1",
    generatedAt: new Date().toISOString(),
    controller: {
      busy: Boolean(runtime.activeOperation),
      activeOperation: runtime.activeOperation || null,
    },
    topology: {
      validatorsPerChain: Number(scaffold?.validatorCount || 0),
      toleratedFaultsPerChain: Number(scaffold?.byzantineFaultTolerance || 0),
      checkpointModel: manifest.securityProfile.checkpointModel,
      attestorThreshold: Number(manifest.securityProfile.attestorThreshold),
      configuredAttestors: manifest.securityProfile.attestors.length,
      finalityDepth: Number(manifest.securityProfile.finalityDepth),
    },
    governance: {
      mode: manifest.securityProfile.governanceMode || "bootstrap",
      delaySeconds: {
        A: governanceDelayA.toString(),
        B: governanceDelayB.toString(),
      },
    },
    chains: {
      A: chainStatus(manifest.chains.A, blockA, trustedBOnA),
      B: chainStatus(manifest.chains.B, blockB, trustedAOnB),
    },
    participants: {
      sourceCustomer: userA,
      destinationCustomer: userB,
      relayerA: manifest.accounts.A.relayer,
      relayerB: manifest.accounts.B.relayer,
      identity: {
        A: identityStatus(identityA),
        B: identityStatus(identityB),
      },
    },
    balances: {
      canonicalAvailable: formatTokenAmount(canonicalAvailable),
      escrowed: formatTokenAmount(escrowed),
      voucherAvailable: formatTokenAmount(voucherAvailable),
      creditAvailable: formatTokenAmount(creditAvailable),
      activeCollateral: formatTokenAmount(activeCollateral),
      outstandingDebt: formatTokenAmount(outstandingDebt),
      poolLiquidity: formatTokenAmount(poolLiquidity),
      totalBorrows: formatTokenAmount(totalBorrows),
    },
    risk: {
      maxBorrow: formatTokenAmount(maxBorrow),
      maxBorrowRaw: maxBorrow.toString(),
      availableBorrow: formatTokenAmount(availableBorrow),
      availableBorrowRaw: availableBorrow.toString(),
      collateralValue: formatTokenAmount(collateralValue),
      liquidationThresholdValue: formatTokenAmount(liquidationValue),
      healthFactor: healthFactor >= MAX_UINT256 / 2n ? null : ethers.formatUnits(healthFactor, 18),
      collateralFactorBps: collateralFactorBps.toString(),
      liquidationThresholdBps: liquidationThresholdBps.toString(),
      voucherPrice: ethers.formatUnits(voucherPrice, 18),
      debtPrice: ethers.formatUnits(debtPrice, 18),
      voucherPriceUpdatedAt: voucherPriceUpdatedAt.toString(),
      debtPriceUpdatedAt: debtPriceUpdatedAt.toString(),
    },
    gateway: {
      nextNonceA: nextNonceA.toString(),
      nextNonceB: nextNonceB.toString(),
    },
    relay,
    activity,
  };
  return status;
}

export async function loadViewArtifacts() {
  return {
    token: await loadArtifact("apps/BankToken.sol", "BankToken"),
    voucher: await loadArtifact("apps/PolicyControlledVoucherToken.sol", "PolicyControlledVoucherToken"),
    escrow: await loadArtifact("apps/PolicyControlledEscrowVault.sol", "PolicyControlledEscrowVault"),
    lending: await loadArtifact("apps/PolicyControlledLendingPool.sol", "PolicyControlledLendingPool"),
    oracle: await loadArtifact("apps/ManualAssetOracle.sol", "ManualAssetOracle"),
    gateway: await loadArtifact("gateway/InstitutionalCrossChainGateway.sol", "InstitutionalCrossChainGateway"),
    checkpointClient: await loadArtifact("gateway/InstitutionalCheckpointClient.sol", "InstitutionalCheckpointClient"),
    identityRegistry: await loadArtifact("identity/InstitutionalIdentityRegistry.sol", "InstitutionalIdentityRegistry"),
    governance: await loadArtifact("governance/InstitutionalGovernanceTimelock.sol", "InstitutionalGovernanceTimelock"),
  };
}

export function createViewContracts(manifest, providers, artifacts) {
  const address = (chain, name) => manifest.chains[chain].contracts[name].address;
  return {
    canonicalTokenA: new ethers.Contract(address("A", "canonicalToken"), artifacts.token.abi, providers.A),
    escrowVaultA: new ethers.Contract(address("A", "escrowVault"), artifacts.escrow.abi, providers.A),
    voucherTokenB: new ethers.Contract(address("B", "voucherToken"), artifacts.voucher.abi, providers.B),
    debtTokenB: new ethers.Contract(address("B", "debtToken"), artifacts.token.abi, providers.B),
    lendingPoolB: new ethers.Contract(address("B", "lendingPool"), artifacts.lending.abi, providers.B),
    oracleB: new ethers.Contract(address("B", "oracle"), artifacts.oracle.abi, providers.B),
    gatewayA: new ethers.Contract(address("A", "gateway"), artifacts.gateway.abi, providers.A),
    gatewayB: new ethers.Contract(address("B", "gateway"), artifacts.gateway.abi, providers.B),
    checkpointClientA: new ethers.Contract(address("A", "checkpointClient"), artifacts.checkpointClient.abi, providers.A),
    checkpointClientB: new ethers.Contract(address("B", "checkpointClient"), artifacts.checkpointClient.abi, providers.B),
    identityRegistryA: new ethers.Contract(address("A", "identityRegistry"), artifacts.identityRegistry.abi, providers.A),
    identityRegistryB: new ethers.Contract(address("B", "identityRegistry"), artifacts.identityRegistry.abi, providers.B),
    governanceA: new ethers.Contract(address("A", "governance"), artifacts.governance.abi, providers.A),
    governanceB: new ethers.Contract(address("B", "governance"), artifacts.governance.abi, providers.B),
  };
}

async function assertDeploymentCode(manifest, providers) {
  const targets = [
    ["A", "gateway"],
    ["A", "collateralApp"],
    ["A", "canonicalToken"],
    ["B", "gateway"],
    ["B", "collateralApp"],
    ["B", "voucherToken"],
    ["B", "lendingPool"],
  ];
  const results = await Promise.all(targets.map(async ([chain, name]) => {
    const address = manifest.chains?.[chain]?.contracts?.[name]?.address;
    if (!ethers.isAddress(address)) return `${chain}.${name}`;
    const code = await providers[chain].getCode(address);
    return code === "0x" ? `${chain}.${name}` : null;
  }));
  const missing = results.filter(Boolean);
  if (missing.length) throw new Error(`missing contract code: ${missing.join(", ")}`);
}

function chainStatus(chain, blockNumber, trustedRemoteHeight) {
  return {
    chainId: chain.chainId,
    rpc: chain.rpc,
    blockNumber,
    trustedRemoteHeight: trustedRemoteHeight.toString(),
    healthy: true,
  };
}

function identityStatus(value) {
  const names = ["missing", "active", "suspended", "revoked", "expired"];
  const numeric = Number(value);
  return { code: numeric, label: names[numeric] || `status-${numeric}`, active: numeric === 1 };
}

function unavailableStatus(message, activity, manifest = null) {
  return {
    ready: false,
    deployed: false,
    stackVersion: "institutional-v1",
    message,
    manifest: manifest ? { status: manifest.status, version: manifest.version } : null,
    controller: { busy: false, activeOperation: null },
    activity,
    workflow: { stage: "prepare", nextAction: null },
  };
}

function emptyActivity() {
  return { version: "institutional-demo-state-v1", latest: null, history: [] };
}

function decimal(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compactError(error) {
  return error?.shortMessage || error?.info?.error?.message || error?.message || String(error);
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

async function readJsonIfExists(path) {
  try {
    await access(path);
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export const INTERNALS = Object.freeze({ WAD });
