import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { loadArtifact, normalizeRuntime } from "./besu-runtime.mjs";
import { loadRuntimeConfig, providerForChain, signerForChain, RUNTIME_CONFIG_PATH } from "./interchain-config.mjs";

// Demo read-model: probes local health and assembles the UI/status snapshot from deployed contracts.
const TRACE_JSON_PATH = resolve(process.cwd(), "demo", "latest-run.json");
const TRANSFER_AMOUNT = ethers.parseUnits(process.env.DEMO_AMOUNT || "100", 18);

function units(value) {
  return ethers.formatUnits(value, 18);
}

function hash32(value) {
  return typeof value === "string" && ethers.isHexString(value, 32);
}

function zeroHash(value) {
  return !hash32(value) || value === ethers.ZeroHash;
}

const CLIENT_STATUS_NAMES = ["Uninitialized", "Active", "Frozen", "Recovering"];

function clientStatusName(value) {
  return CLIENT_STATUS_NAMES[Number(value)] || String(value ?? "-");
}

function normalizeEvidence(evidence) {
  if (!evidence || evidence.evidenceHash === ethers.ZeroHash) return null;

  return {
    sourceChainId: evidence.sourceChainId.toString(),
    height: evidence.height.toString(),
    trustedHeaderHash: evidence.trustedHeaderHash,
    conflictingHeaderHash: evidence.conflictingHeaderHash,
    evidenceHash: evidence.evidenceHash,
    detectedAt: evidence.detectedAt.toString(),
  };
}

export function normalizeTrace(trace) {
  if (!trace || typeof trace !== "object" || Array.isArray(trace)) return trace;
  return normalizeTraceForUi(trace);
}

function normalizeTraceForUi(trace) {
  const risk = trace.risk || {};
  const security = trace.security || {};
  return {
    ...trace,
    forward: {
      ...(trace.forward || {}),
      headerHeight: trace.forward?.trustedHeight,
      headerHash: trace.forward?.trustedHeaderHash,
      stateRoot: trace.forward?.trustedStateRoot,
      executionStateRoot: trace.forward?.trustedStateRoot,
      consensusHash: trace.forward?.trustedHeaderHash,
      proofMode: "storage",
    },
    lending: {
      collateralDeposited: Boolean(risk.collateralDeposited),
      collateral: risk.collateralAfterLiquidation ?? risk.collateralDeposited,
      borrowed: Boolean(risk.borrowed),
      debt: risk.debtAfterLiquidation ?? risk.borrowed,
      repaid: Boolean(risk.repaid),
      collateralWithdrawn: Boolean(risk.collateralWithdrawn),
      completed: Boolean(risk.completed),
      liquidated: Boolean(risk.liquidationRepaid || risk.debtAfterLiquidation),
    },
    reverse: {
      ...(trace.reverse || {}),
      headerHeight: trace.timeout?.trustedHeight,
      headerHash: trace.timeout?.trustedHeaderHash,
      stateRoot: trace.timeout?.trustedStateRoot,
      executionStateRoot: trace.timeout?.trustedStateRoot,
      consensusHash: trace.timeout?.trustedHeaderHash,
      packetId: trace.denied?.packetId,
      proofMode: "storage-absence",
    },
    misbehaviour: {
      frozen: false,
      recovered: false,
      ...(trace.misbehaviour || {}),
    },
    security: {
      replayBlocked: true,
      ...security,
      timeoutAbsenceImplemented: security.timeoutAbsenceImplemented ?? security.nonMembershipImplemented ?? true,
      timeoutAbsence: security.timeoutAbsence || security.nonMembership || null,
    },
  };
}

export async function readTrace() {
  try {
    return normalizeTrace(JSON.parse(await readFile(TRACE_JSON_PATH, "utf8")));
  } catch {}
  return null;
}

async function configExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function probeRpc(rpc) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 650);
  try {
    const response = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: controller.signal,
    });
    const payload = await response.json();
    if (!payload.result) throw new Error(payload.error?.message || "eth_chainId returned no result");
    return { ok: true, chainId: Number(BigInt(payload.result)) };
  } catch (error) {
    return { ok: false, error: error.name === "AbortError" ? "timeout" : error.message };
  } finally {
    clearTimeout(timeout);
  }
}

function viewErrorSummary(error) {
  return [
    error?.code,
    error?.shortMessage,
    error?.info?.error?.message,
    error?.message,
  ]
    .filter(Boolean)
    .join(" | ");
}

function logOptionalStatusWarning(label, error) {
  if (process.env.DEBUG_DEMO_STATUS === "true") {
    console.warn(`[status] ${label}: ${viewErrorSummary(error)}`);
  }
}

async function safeView(label, read, fallback = null) {
  try {
    return await read();
  } catch (error) {
    logOptionalStatusWarning(label, error);
    return fallback;
  }
}

export async function localHealth() {
  const runtime = normalizeRuntime();
  if (!(await configExists(RUNTIME_CONFIG_PATH))) {
    return {
      ready: false,
      deployed: false,
      label: "No deployment",
      stackVersion: "besu-light-client",
      runtime,
      message: "Start the Besu bank chains with npm run besu:generate and npm run besu:up, then press Prepare / Reuse or Fresh Reset.",
    };
  }
  return readLocalHealth(runtime);
}

async function readLocalHealth(runtime) {
  const cfg = await loadRuntimeConfig();
  const cfgRuntime = cfg.runtime || runtime;
  const [chainA, chainB] = await Promise.all([probeRpc(cfg.chains.A.rpc), probeRpc(cfg.chains.B.rpc)]);
  const missing = [];
  if (!chainA.ok) missing.push(`Bank A ${cfg.chains.A.rpc}`);
  if (!chainB.ok) missing.push(`Bank B ${cfg.chains.B.rpc}`);

  if (missing.length > 0) {
    return {
      ready: false,
      deployed: false,
      stackVersion: "besu-light-client",
      label: "Chains offline",
      runtime: cfgRuntime,
      message: `Besu bank-chain RPC not reachable: ${missing.join(", ")}. Start npm run besu:up.`,
      chains: { A: chainA, B: chainB },
    };
  }

  const required = [
    ["A", "lightClient"],
    ["A", "connectionKeeper"],
    ["A", "channelKeeper"],
    ["A", "packetHandler"],
    ["A", "packetStore"],
    ["A", "policyEngine"],
    ["A", "canonicalToken"],
    ["A", "escrowVault"],
    ["A", "transferApp"],
    ["B", "lightClient"],
    ["B", "connectionKeeper"],
    ["B", "channelKeeper"],
    ["B", "packetHandler"],
    ["B", "packetStore"],
    ["B", "policyEngine"],
    ["B", "voucherToken"],
    ["B", "debtToken"],
    ["B", "oracle"],
    ["B", "lendingPool"],
    ["B", "transferApp"],
  ];
  const missingFields = required
    .filter(([chainKey, field]) => !cfg.chains?.[chainKey]?.[field])
    .map(([chainKey, field]) => `${chainKey}.${field}`);
  if (missingFields.length > 0) {
    return {
      ready: false,
      deployed: false,
      stackVersion: "besu-light-client",
      label: "Stale interchain lending deployment",
      runtime: cfgRuntime,
      message: `Interchain lending deployment config is missing: ${missingFields.join(", ")}. Run npm run deploy and npm run seed.`,
      chains: { A: chainA, B: chainB },
    };
  }

  const providerA = providerForChain(cfg, "A");
  const providerB = providerForChain(cfg, "B");
  const codeChecks = await Promise.all([
    providerA.getCode(cfg.chains.A.lightClient),
    providerA.getCode(cfg.chains.A.transferApp),
    providerA.getCode(cfg.chains.A.escrowVault),
    providerB.getCode(cfg.chains.B.lightClient),
    providerB.getCode(cfg.chains.B.transferApp),
    providerB.getCode(cfg.chains.B.lendingPool),
  ]);
  if (codeChecks.some((code) => code === "0x")) {
    return {
      ready: false,
      deployed: false,
      stackVersion: "besu-light-client",
      label: "Stale interchain lending deployment",
      runtime: cfgRuntime,
      message:
        "Runtime config exists, but one or more configured contract addresses have no code. Run npm run deploy and npm run seed after starting fresh Besu chains.",
      chains: { A: chainA, B: chainB },
    };
  }

  const artifacts = await loadRuntimeArtifacts();
  const lightClientA = new ethers.Contract(cfg.chains.A.lightClient, artifacts.lightClient.abi, providerA);
  const lightClientB = new ethers.Contract(cfg.chains.B.lightClient, artifacts.lightClient.abi, providerB);
  try {
    await Promise.all([
      lightClientA.latestTrustedHeight(BigInt(cfg.chains.B.chainId)),
      lightClientB.latestTrustedHeight(BigInt(cfg.chains.A.chainId)),
    ]);
  } catch (error) {
    return {
      ready: false,
      deployed: false,
      stackVersion: "besu-light-client",
      label: "Stale interchain lending deployment",
      runtime: cfgRuntime,
      message:
        `Configured interchain light-client address does not answer the expected BesuLightClient ABI: ${viewErrorSummary(error)}. ` +
        "Run npm run deploy and npm run seed against the currently running Besu chains.",
      chains: { A: chainA, B: chainB },
    };
  }

  return { ready: true, deployed: true, stackVersion: "besu-light-client", cfg, runtime: cfgRuntime, chains: { A: chainA, B: chainB } };
}

export async function loadRuntimeArtifacts() {
  return {
    bankToken: await loadArtifact("apps/BankToken.sol", "BankToken"),
    lightClient: await loadArtifact("clients/BesuLightClient.sol", "BesuLightClient"),
    packetStore: await loadArtifact("core/IBCPacketStore.sol", "IBCPacketStore"),
    handler: await loadArtifact("core/IBCPacketHandler.sol", "IBCPacketHandler"),
    voucher: await loadArtifact("apps/PolicyControlledVoucherToken.sol", "PolicyControlledVoucherToken"),
    lendingPool: await loadArtifact("apps/PolicyControlledLendingPool.sol", "PolicyControlledLendingPool"),
    escrow: await loadArtifact("apps/PolicyControlledEscrowVault.sol", "PolicyControlledEscrowVault"),
  };
}

export async function readDemoStatus() {
  const health = await localHealth();
  if (!health.ready) return health;
  return readOnchainDemoStatus(health);
}

async function trustedHeaderSummary(lightClient, sourceChainId, height) {
  if (height === 0n) return null;
  const state = await safeView(
    `trustedHeader(${sourceChainId.toString()},${height.toString()})`,
    () => lightClient.trustedHeader(sourceChainId, height),
    null
  );
  if (!state) return null;
  if (!state.exists) return null;
  return {
    consensusHash: state.headerHash,
    validatorEpochId: "-",
    headerHeight: state.height.toString(),
    blockHash: state.headerHash,
    packetRoot: "-",
    stateRoot: state.stateRoot,
    executionStateRoot: state.stateRoot,
    packetRange: "-",
    packetCount: "-",
    sourceBlockNumber: state.height.toString(),
    sourceBlockHash: state.headerHash,
  };
}

async function readOnchainDemoStatus(health) {
  const cfg = health.cfg;
  const artifacts = await loadRuntimeArtifacts();
  const providerA = providerForChain(cfg, "A");
  const providerB = providerForChain(cfg, "B");
  const sourceUser =
    cfg.participants?.sourceUser ||
    (await (await signerForChain(cfg, "A", Number(cfg.participants?.sourceUserIndex ?? 1))).getAddress());
  const destinationUser =
    cfg.participants?.destinationUser ||
    (await (await signerForChain(cfg, "B", Number(cfg.participants?.destinationUserIndex ?? 1))).getAddress());

  const canonical = new ethers.Contract(cfg.chains.A.canonicalToken, artifacts.bankToken.abi, providerA);
  const escrow = new ethers.Contract(cfg.chains.A.escrowVault, artifacts.escrow.abi, providerA);
  const voucher = new ethers.Contract(cfg.chains.B.voucherToken, artifacts.voucher.abi, providerB);
  const debtToken = new ethers.Contract(cfg.chains.B.debtToken, artifacts.bankToken.abi, providerB);
  const lendingPool = new ethers.Contract(cfg.chains.B.lendingPool, artifacts.lendingPool.abi, providerB);
  const packetA = new ethers.Contract(cfg.chains.A.packetStore, artifacts.packetStore.abi, providerA);
  const packetB = new ethers.Contract(cfg.chains.B.packetStore, artifacts.packetStore.abi, providerB);
  const handlerA = new ethers.Contract(cfg.chains.A.packetHandler, artifacts.handler.abi, providerA);
  const handlerB = new ethers.Contract(cfg.chains.B.packetHandler, artifacts.handler.abi, providerB);
  const lightClientA = new ethers.Contract(cfg.chains.A.lightClient, artifacts.lightClient.abi, providerA);
  const lightClientB = new ethers.Contract(cfg.chains.B.lightClient, artifacts.lightClient.abi, providerB);
  const trace = await readTrace();
  const chainIdA = BigInt(cfg.chains.A.chainId);
  const chainIdB = BigInt(cfg.chains.B.chainId);

  const [
    bankABalance,
    escrowTotal,
    voucherBalance,
    bankBBalance,
    poolCollateral,
    poolDebt,
    poolLiquidity,
    packetSequenceA,
    packetSequenceB,
    headA,
    headB,
    trustedAOnB,
    trustedBOnA,
    statusAOnB,
    statusBOnA,
    activeEpochAOnB,
    activeEpochBOnA,
    evidenceAOnB,
    evidenceBOnA,
  ] = await Promise.all([
    canonical.balanceOf(sourceUser),
    escrow.totalEscrowed(),
    voucher.balanceOf(destinationUser),
    debtToken.balanceOf(destinationUser),
    lendingPool.collateralBalance(destinationUser),
    lendingPool.debtBalance(destinationUser),
    debtToken.balanceOf(cfg.chains.B.lendingPool),
    packetA.packetSequence(),
    packetB.packetSequence(),
    providerA.getBlockNumber(),
    providerB.getBlockNumber(),
    lightClientB.latestTrustedHeight(chainIdA),
    lightClientA.latestTrustedHeight(chainIdB),
    lightClientB.status(chainIdA),
    lightClientA.status(chainIdB),
    lightClientB.latestValidatorEpoch(chainIdA),
    lightClientA.latestValidatorEpoch(chainIdB),
    lightClientB.frozenEvidence(chainIdA),
    lightClientA.frozenEvidence(chainIdB),
  ]);

  const statusAOnBNumber = Number(statusAOnB);
  const statusBOnANumber = Number(statusBOnA);
  const frozenEvidenceAOnB = normalizeEvidence(evidenceAOnB);
  const frozenEvidenceBOnA = normalizeEvidence(evidenceBOnA);
  const [trustedAOnBSummary, trustedBOnASummary, forwardConsumed, forwardAcknowledged, deniedTimedOut] =
    await Promise.all([
      trustedHeaderSummary(lightClientB, chainIdA, trustedAOnB),
      trustedHeaderSummary(lightClientA, chainIdB, trustedBOnA),
      trace?.forward?.packetId ? handlerB.packetReceipts(trace.forward.packetId) : false,
      trace?.forward?.packetId ? handlerA.packetAcknowledgements(trace.forward.packetId) : false,
      trace?.denied?.packetId ? handlerA.packetTimeouts(trace.denied.packetId) : false,
    ]);

  const traceSecurity = trace?.security || {};

  return {
    deployed: true,
    stackVersion: "besu-light-client",
    runtime: health.runtime || cfg.runtime || normalizeRuntime(),
    userA: sourceUser,
    userB: destinationUser,
    amount: units(TRANSFER_AMOUNT),
    balances: {
      bankA: units(bankABalance),
      escrow: units(escrowTotal),
      voucher: units(voucherBalance),
      bankB: units(bankBBalance),
      poolCollateral: units(poolCollateral),
      poolDebt: units(poolDebt),
      poolLiquidity: units(poolLiquidity),
    },
    progress: {
      packetSequenceA: packetSequenceA.toString(),
      packetSequenceB: packetSequenceB.toString(),
      headerHeightA: trace?.forward?.finalizedHeight || headA.toString(),
      headerHeightB: trace?.reverse?.finalizedHeight || headB.toString(),
      trustedAOnB: trustedAOnB.toString(),
      trustedBOnA: trustedBOnA.toString(),
      statusAOnB: statusAOnBNumber,
      statusBOnA: statusBOnANumber,
      statusAOnBName: clientStatusName(statusAOnBNumber),
      statusBOnAName: clientStatusName(statusBOnANumber),
      activeEpochAOnB: activeEpochAOnB.toString(),
      activeEpochBOnA: activeEpochBOnA.toString(),
      consensusHashAOnB: trustedAOnBSummary?.consensusHash || ethers.ZeroHash,
      consensusHashBOnA: trustedBOnASummary?.consensusHash || ethers.ZeroHash,
      sourceBlockAOnB: trustedAOnB.toString(),
      sourceBlockBOnA: trustedBOnA.toString(),
    },
    trust: {
      aOnB: trustedAOnBSummary,
      bOnA: trustedBOnASummary,
    },
    security: {
      forwardConsumed,
      reverseConsumed: false,
      forwardAcknowledged,
      deniedTimedOut,
      replayBlocked: Boolean(forwardConsumed || traceSecurity.replayBlocked),
      replayProofHeight: traceSecurity.replayProofHeight || null,
      timeoutAbsenceImplemented: traceSecurity.timeoutAbsenceImplemented ?? traceSecurity.nonMembershipImplemented ?? true,
      timeoutAbsence: traceSecurity.timeoutAbsence || traceSecurity.nonMembership || null,
      frozen: statusAOnBNumber === 2 || statusBOnANumber === 2,
      recovering: statusAOnBNumber === 3 || statusBOnANumber === 3,
      evidenceAOnB: frozenEvidenceAOnB,
      evidenceBOnA: frozenEvidenceBOnA,
    },
    trace,
  };
}
