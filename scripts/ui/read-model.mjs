import { resolve } from "node:path";
import { ethers } from "ethers";
import { readJsonIfExists } from "../../services/shared/json-file.mjs";
import { loadArtifact, providerForRpc, readContractCode } from "../ops/besu/runtime.mjs";

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
const DEFAULT_LIVENESS_STALE_MS = 15_000;

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

export function summarizeRelayJournal(snapshot, {
  activeAttestors = 0,
  attestorThreshold = 0,
  relayHealth = null,
  now = Date.now(),
  staleAfterMs = DEFAULT_LIVENESS_STALE_MS,
} = {}) {
  const jobs = Object.values(snapshot?.jobs || {});
  const terminal = new Set(["completed", "timed_out", "failed_permanent"]);
  const latest = jobs.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] || null;
  const lastHealthyAtMs = timestampMs(relayHealth?.lastHealthyAt);
  const relayerHealthy = lastHealthyAtMs != null
    && relayHealth?.lastError == null
    && now - lastHealthyAtMs <= staleAfterMs;
  const attestorQuorumReady = Number.isSafeInteger(activeAttestors)
    && Number.isSafeInteger(attestorThreshold)
    && attestorThreshold > 0
    && activeAttestors >= attestorThreshold;
  return {
    activeAttestors,
    attestorQuorumReady,
    relayerHealthy,
    lastHeartbeatAt: relayHealth?.lastAttemptAt || null,
    lastHealthyAt: relayHealth?.lastHealthyAt || null,
    lastError: relayHealth?.lastError || null,
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
  if (!status?.laneReady && !status?.ready) return { stage: "prepare", nextAction: null };
  if (status.controller?.activeOperation) {
    return { stage: "processing", nextAction: status.controller.activeOperation.action };
  }

  const balances = status.balances || {};
  const latestAction = status.activity?.latest?.action;
  const canonical = decimalUnits(balances.canonicalAvailable);
  const voucher = decimalUnits(balances.voucherAvailable);
  const collateral = decimalUnits(balances.activeCollateral);
  const debt = decimalUnits(balances.outstandingDebt);

  if (debt > 0n) return { stage: "manage", nextAction: "repay" };
  if (collateral > 0n) return { stage: "lend", nextAction: BigInt(status.risk?.availableBorrowRaw || 0) > 0n ? "borrow" : "withdraw" };
  if (voucher > 0n) {
    const returning = ["withdraw", "repay", "repayAll"].includes(latestAction);
    return { stage: returning ? "return" : "lend", nextAction: returning ? "return" : "deposit" };
  }
  if (canonical > 0n) return { stage: "transfer", nextAction: "bridge" };
  return { stage: "review", nextAction: null };
}

export function observeChainProgress(previous = {}, heads, {
  now = Date.now(),
  staleAfterMs = DEFAULT_LIVENESS_STALE_MS,
} = {}) {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("Chain progress timestamp is invalid");
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1) {
    throw new RangeError("Chain progress stale interval must be a positive safe integer");
  }
  const chains = {};
  for (const key of ["A", "B"]) {
    const blockNumber = Number(heads?.[key]);
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
      throw new RangeError(`Bank ${key} block number is invalid`);
    }
    const prior = previous?.[key];
    let lastProgressAt = Number.isSafeInteger(prior?.lastProgressAt) ? prior.lastProgressAt : null;
    if (Number.isSafeInteger(prior?.blockNumber)) {
      if (blockNumber > prior.blockNumber) lastProgressAt = now;
      if (blockNumber < prior.blockNumber) lastProgressAt = null;
    }
    chains[key] = {
      blockNumber,
      observedAt: now,
      lastProgressAt,
      progressing: lastProgressAt != null && now - lastProgressAt <= staleAfterMs,
    };
  }
  return {
    chains,
    chainsProgressing: chains.A.progressing && chains.B.progressing,
  };
}

export async function readInstitutionalStatus(runtime = {}) {
  const manifest = runtime.manifest || await readJsonIfExists(INSTITUTIONAL_DEPLOYMENT_PATH);
  const activity = runtime.activity || await readJsonIfExists(INSTITUTIONAL_DEMO_STATE_PATH) || emptyActivity();
  if (!manifest) return unavailableStatus("Institutional stack is not deployed", activity);
  if (manifest.version !== "institutional-deployment-v2" || manifest.status !== "ready") {
    return unavailableStatus("Institutional deployment manifest is incomplete", activity, manifest);
  }

  const ownsProviders = !runtime.providers;
  const createProvider = runtime.providerFactory || providerForRpc;
  let providers = runtime.providers;
  if (ownsProviders) {
    providers = {};
    try {
      providers.A = createProvider(manifest.chains.A.rpc);
      providers.B = createProvider(manifest.chains.B.rpc);
    } catch (initializationError) {
      const cleanupErrors = await destroyProviders(providers);
      const errors = [initializationError, ...cleanupErrors];
      const message = errors.map(compactError).join("; ");
      return {
        ...unavailableStatus(`Institutional runtime provider initialization failed: ${message}`, activity, manifest),
        error: message,
      };
    }
  }
  let status;

  try {
    const artifacts = runtime.artifacts || await loadViewArtifacts();
    const contracts = runtime.contracts || createViewContracts(manifest, providers, artifacts);
    await assertDeploymentCode(manifest, providers);
    status = await readOnChainStatus({ manifest, providers, contracts, activity, runtime });
    status.workflow = deriveInstitutionalWorkflow(status);
  } catch (error) {
    status = {
      ...unavailableStatus(`Institutional runtime is not readable: ${compactError(error)}`, activity, manifest),
      error: compactError(error),
    };
  }

  if (ownsProviders) {
    const cleanupErrors = await destroyProviders(providers);
    if (cleanupErrors.length > 0) {
      const cleanupMessage = cleanupErrors.map(compactError).join("; ");
      return {
        ...unavailableStatus(
          `Institutional runtime provider cleanup failed: ${cleanupMessage}`,
          activity,
          manifest,
        ),
        error: cleanupMessage,
      };
    }
  }
  return status;
}

async function destroyProviders(providers) {
  const unique = [...new Set(Object.values(providers || {}).filter(Boolean))];
  const results = await Promise.allSettled(unique.map((provider) => (
    typeof provider.destroy === "function"
      ? Promise.resolve().then(() => provider.destroy())
      : Promise.resolve()
  )));
  return results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
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
    originationPrincipalDebt,
    pausedActionMask,
    accrualBacklogSeconds,
    accrualBatchesRequired,
    maxAccrualElapsed,
    accountDefaulted,
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
    contracts.lendingPoolB.originationPrincipalDebt(userB),
    contracts.lendingPoolB.pausedActionMask(),
    contracts.lendingPoolB.accrualBacklogSeconds(),
    contracts.lendingPoolB.accrualBatchesRequired(),
    contracts.lendingPoolB.MAX_ACCRUAL_ELAPSED(),
    contracts.policyEngineB.accountDefaulted(userB),
  ]);

  const scaffold = await readJsonIfExists(resolve(process.cwd(), process.env.BESU_NETWORK_ROOT || "networks/besu", "scaffold.json"));
  const generatedAtMs = typeof runtime.now === "function" ? runtime.now() : Date.now();
  const progress = observeChainProgress(runtime.readinessState?.chainProgress, { A: blockA, B: blockB }, {
    now: generatedAtMs,
    staleAfterMs: runtime.livenessStaleMs || DEFAULT_LIVENESS_STALE_MS,
  });
  if (runtime.readinessState) runtime.readinessState.chainProgress = progress.chains;
  const attestorThreshold = Number(manifest.securityProfile.attestorThreshold);
  const relay = summarizeRelayJournal(runtime.relayJournal?.snapshot?.(), {
    activeAttestors: runtime.activeAttestors || 0,
    attestorThreshold,
    relayHealth: runtime.relayHealth,
    now: generatedAtMs,
    staleAfterMs: runtime.livenessStaleMs || DEFAULT_LIVENESS_STALE_MS,
  });
  const identitiesEligible = identityStatus(identityA).active && identityStatus(identityB).active;
  const configuredGovernanceDelay = BigInt(manifest.securityProfile.governanceDelaySeconds || 0);
  const governanceEnforced = manifest.securityProfile.governanceMode === "timelock-enforced"
    && governanceDelayA >= configuredGovernanceDelay
    && governanceDelayB >= configuredGovernanceDelay
    && configuredGovernanceDelay > 0n;
  const laneReady = progress.chainsProgressing
    && relay.attestorQuorumReady
    && relay.relayerHealthy
    && governanceEnforced
    && identitiesEligible;
  const status = {
    ready: laneReady,
    runtimeReadable: true,
    chainsProgressing: progress.chainsProgressing,
    attestorQuorumReady: relay.attestorQuorumReady,
    relayerHealthy: relay.relayerHealthy,
    governanceEnforced,
    identitiesEligible,
    laneReady,
    deployed: true,
    stackVersion: "institutional-v1",
    generatedAt: new Date(generatedAtMs).toISOString(),
    message: laneReady ? null : readinessMessage({
      chainsProgressing: progress.chainsProgressing,
      attestorQuorumReady: relay.attestorQuorumReady,
      relayerHealthy: relay.relayerHealthy,
      governanceEnforced,
      identitiesEligible,
    }),
    controller: {
      busy: Boolean(runtime.activeOperation),
      activeOperation: runtime.activeOperation || null,
    },
    topology: {
      validatorsPerChain: Number(scaffold?.validatorCount || 0),
      toleratedFaultsPerChain: Number(scaffold?.byzantineFaultTolerance || 0),
      checkpointModel: manifest.securityProfile.checkpointModel,
      attestorThreshold,
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
      A: chainStatus(manifest.chains.A, blockA, trustedBOnA, progress.chains.A),
      B: chainStatus(manifest.chains.B, blockB, trustedAOnB, progress.chains.B),
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
      originationPrincipalDebt: formatTokenAmount(originationPrincipalDebt),
      accountDefaulted,
      creditStatus: accountDefaulted ? "defaulted" : "eligible",
      pausedActionMask: pausedActionMask.toString(),
      borrowPaused: (pausedActionMask & 1n) !== 0n,
      collateralWithdrawalPaused: (pausedActionMask & 2n) !== 0n,
      accrualBacklogSeconds: accrualBacklogSeconds.toString(),
      accrualBatchesRequired: accrualBatchesRequired.toString(),
      accrualCatchUpRequired: totalBorrows > 0n && accrualBacklogSeconds > maxAccrualElapsed,
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
    policy: await loadArtifact("apps/BankPolicyEngine.sol", "BankPolicyEngine"),
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
    policyEngineB: new ethers.Contract(address("B", "policyEngine"), artifacts.policy.abi, providers.B),
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
    const code = await readContractCode(providers[chain], address, { label: `${chain}.${name}` });
    return code === "0x" ? `${chain}.${name}` : null;
  }));
  const missing = results.filter(Boolean);
  if (missing.length) throw new Error(`missing contract code: ${missing.join(", ")}`);
}

function chainStatus(chain, blockNumber, trustedRemoteHeight, progress) {
  return {
    chainId: chain.chainId,
    rpc: chain.rpc,
    blockNumber,
    trustedRemoteHeight: trustedRemoteHeight.toString(),
    readable: true,
    progressing: Boolean(progress?.progressing),
    lastProgressAt: progress?.lastProgressAt == null ? null : new Date(progress.lastProgressAt).toISOString(),
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
    runtimeReadable: false,
    chainsProgressing: false,
    attestorQuorumReady: false,
    relayerHealthy: false,
    governanceEnforced: false,
    identitiesEligible: false,
    laneReady: false,
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

function decimalUnits(value) {
  try {
    return ethers.parseUnits(String(value || "0"), 18);
  } catch {
    return 0n;
  }
}

function timestampMs(value) {
  if (Number.isSafeInteger(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function readinessMessage(signals) {
  const missing = Object.entries(signals)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  return `Institutional lane is readable but not ready: ${missing.join(", ")}`;
}

function compactError(error) {
  return error?.shortMessage || error?.info?.error?.message || error?.message || String(error);
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

export const INTERNALS = Object.freeze({ WAD, DEFAULT_LIVENESS_STALE_MS });
