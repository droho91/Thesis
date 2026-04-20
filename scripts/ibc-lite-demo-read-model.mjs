import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ethers } from "ethers";
import {
  headerProducerAddress,
  loadArtifact,
  loadConfig,
  normalizeRuntime,
  providerFor,
  signerFor,
} from "./ibc-lite-common.mjs";
import { loadV2Config, providerForV2, signerForV2, V2_CONFIG_PATH } from "./ibc-v2-config.mjs";

// Demo read-model: probes local health and assembles the UI/status snapshot from deployed contracts.
const TRACE_V2_JSON_PATH = resolve(process.cwd(), "demo", "latest-v2-run.json");
const TRACE_JSON_PATH = resolve(process.cwd(), "demo", "latest-run.json");
const CONFIG_PATH = resolve(process.cwd(), ".ibc-lite.local.json");
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

function normalizeFlowTrace(flow) {
  if (!flow || typeof flow !== "object" || Array.isArray(flow)) return flow;
  return {
    ...flow,
    headerHeight: flow.headerHeight ?? flow.checkpointSequence,
    headerHash: flow.headerHash ?? flow.checkpointHash,
  };
}

export function normalizeTrace(trace) {
  if (!trace || typeof trace !== "object" || Array.isArray(trace)) return trace;
  if (trace.version === "v2") return normalizeV2TraceForUi(trace);

  const misbehaviour =
    trace.misbehaviour && typeof trace.misbehaviour === "object" && !Array.isArray(trace.misbehaviour)
      ? {
          ...trace.misbehaviour,
          height: trace.misbehaviour.height ?? trace.misbehaviour.sequence,
        }
      : trace.misbehaviour;

  return {
    ...trace,
    forward: normalizeFlowTrace(trace.forward),
    reverse: normalizeFlowTrace(trace.reverse),
    misbehaviour,
  };
}

function normalizeV2TraceForUi(trace) {
  const risk = trace.risk || {};
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
      nonMembershipImplemented: true,
      replayBlocked: true,
      ...(trace.security || {}),
    },
  };
}

export async function readTrace() {
  try {
    return normalizeTrace(JSON.parse(await readFile(TRACE_V2_JSON_PATH, "utf8")));
  } catch {}

  try {
    return normalizeTrace(JSON.parse(await readFile(TRACE_JSON_PATH, "utf8")));
  } catch {
    return null;
  }
}

async function configExists(path = CONFIG_PATH) {
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
  if (await configExists(V2_CONFIG_PATH)) {
    return localHealthV2(runtime);
  }

  if (!(await configExists(CONFIG_PATH))) {
    return {
      ready: false,
      deployed: false,
      label: "No deployment",
      runtime,
      message: runtime.besuFirst
        ? "Start the Besu bank chains with npm run besu:generate and npm run besu:up, then press Deploy + Seed."
        : "Start both local chains, then press Deploy + Seed.",
    };
  }

  const cfg = await loadConfig();
  const cfgRuntime = cfg.runtime || runtime;
  const [chainA, chainB] = await Promise.all([probeRpc(cfg.chains.A.rpc), probeRpc(cfg.chains.B.rpc)]);
  const missing = [];
  if (!chainA.ok) missing.push(`Bank A ${cfg.chains.A.rpc}`);
  if (!chainB.ok) missing.push(`Bank B ${cfg.chains.B.rpc}`);

  if (missing.length > 0) {
    return {
      ready: false,
      deployed: false,
      label: "Chains offline",
      runtime: cfgRuntime,
      message: cfgRuntime.besuFirst
        ? `Besu bank-chain RPC not reachable: ${missing.join(", ")}. Start npm run besu:generate and npm run besu:up.`
        : `Local chain RPC not reachable: ${missing.join(", ")}. Start npm run node:chainA and npm run node:chainB.`,
      chains: { A: chainA, B: chainB },
    };
  }

  const required = [
    ["A", "packetStore"],
    ["A", "validatorRegistry"],
    ["A", "headerProducer"],
    ["A", "client"],
    ["A", "packetHandler"],
    ["A", "canonicalToken"],
    ["A", "escrowVault"],
    ["A", "transferApp"],
    ["B", "packetStore"],
    ["B", "validatorRegistry"],
    ["B", "headerProducer"],
    ["B", "client"],
    ["B", "packetHandler"],
    ["B", "voucherToken"],
    ["B", "debtToken"],
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
      label: "Stale deployment",
      runtime: cfgRuntime,
      message: `Deployment config is from an older stack and is missing: ${missingFields.join(", ")}. Press Deploy + Seed.`,
      chains: { A: chainA, B: chainB },
    };
  }

  const providerA = providerFor(cfg, "A");
  const providerB = providerFor(cfg, "B");
  const codeChecks = await Promise.all([
    providerA.getCode(cfg.chains.A.escrowVault),
    providerA.getCode(cfg.chains.A.transferApp),
    providerB.getCode(cfg.chains.B.voucherToken),
    providerB.getCode(cfg.chains.B.lendingPool),
  ]);
  if (codeChecks.some((code) => code === "0x")) {
    return {
      ready: false,
      deployed: false,
      label: "Stale deployment",
      runtime: cfgRuntime,
      message:
        "Local chains are running, but configured contract addresses have no code. Press Deploy + Seed after starting fresh local chains.",
      chains: { A: chainA, B: chainB },
    };
  }

  return { ready: true, deployed: true, cfg, runtime: cfgRuntime, chains: { A: chainA, B: chainB } };
}

async function localHealthV2(runtime) {
  const cfg = await loadV2Config();
  const cfgRuntime = cfg.runtime || runtime;
  const [chainA, chainB] = await Promise.all([probeRpc(cfg.chains.A.rpc), probeRpc(cfg.chains.B.rpc)]);
  const missing = [];
  if (!chainA.ok) missing.push(`Bank A ${cfg.chains.A.rpc}`);
  if (!chainB.ok) missing.push(`Bank B ${cfg.chains.B.rpc}`);

  if (missing.length > 0) {
    return {
      ready: false,
      deployed: false,
      stackVersion: "v2",
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
      stackVersion: "v2",
      label: "Stale v2 deployment",
      runtime: cfgRuntime,
      message: `V2 deployment config is missing: ${missingFields.join(", ")}. Run npm run deploy:v2 and npm run seed:v2.`,
      chains: { A: chainA, B: chainB },
    };
  }

  const providerA = providerForV2(cfg, "A");
  const providerB = providerForV2(cfg, "B");
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
      stackVersion: "v2",
      label: "Stale v2 deployment",
      runtime: cfgRuntime,
      message:
        "V2 config exists, but one or more configured contract addresses have no code. Run npm run deploy:v2 and npm run seed:v2 after starting fresh Besu chains.",
      chains: { A: chainA, B: chainB },
    };
  }

  const artifacts = await loadV2Artifacts();
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
      stackVersion: "v2",
      label: "Stale v2 deployment",
      runtime: cfgRuntime,
      message:
        `Configured v2 light-client address does not answer the expected BesuLightClient ABI: ${viewErrorSummary(error)}. ` +
        "Run npm run deploy:v2 and npm run seed:v2 against the currently running Besu chains.",
      chains: { A: chainA, B: chainB },
    };
  }

  return { ready: true, deployed: true, stackVersion: "v2", cfg, runtime: cfgRuntime, chains: { A: chainA, B: chainB } };
}

export async function loadArtifacts() {
  return {
    app: await loadArtifact("apps/MinimalTransferApp.sol", "MinimalTransferApp"),
    bankToken: await loadArtifact("apps/BankToken.sol", "BankToken"),
    voucher: await loadArtifact("apps/VoucherToken.sol", "VoucherToken"),
    lendingPool: await loadArtifact("apps/CrossChainLendingPool.sol", "CrossChainLendingPool"),
    escrow: await loadArtifact("apps/EscrowVault.sol", "EscrowVault"),
    packetStore: await loadArtifact("source/SourcePacketCommitment.sol", "SourcePacketCommitment"),
    validatorRegistry: await loadArtifact("source/SourceValidatorEpochRegistry.sol", "SourceValidatorEpochRegistry"),
    checkpointRegistry: await loadArtifact("source/SourceCheckpointRegistry.sol", "SourceCheckpointRegistry"),
    client: await loadArtifact("clients/BankChainClient.sol", "BankChainClient"),
    handler: await loadArtifact("core/IBCPacketHandler.sol", "IBCPacketHandler"),
  };
}

export async function loadV2Artifacts() {
  return {
    bankToken: await loadArtifact("apps/BankToken.sol", "BankToken"),
    lightClient: await loadArtifact("v2/clients/BesuLightClient.sol", "BesuLightClient"),
    packetStore: await loadArtifact("v2/core/IBCPacketStoreV2.sol", "IBCPacketStoreV2"),
    handler: await loadArtifact("v2/core/IBCPacketHandlerV2.sol", "IBCPacketHandlerV2"),
    voucher: await loadArtifact("v2/apps/PolicyControlledVoucherTokenV2.sol", "PolicyControlledVoucherTokenV2"),
    lendingPool: await loadArtifact("v2/apps/PolicyControlledLendingPoolV2.sol", "PolicyControlledLendingPoolV2"),
    escrow: await loadArtifact("v2/apps/PolicyControlledEscrowVaultV2.sol", "PolicyControlledEscrowVaultV2"),
  };
}

export async function context() {
  const health = await localHealth();
  if (!health.ready) throw new Error(health.message);
  const cfg = health.cfg;
  const artifacts = await loadArtifacts();
  const ownerA = await signerFor(cfg, "A", 0);
  const ownerB = await signerFor(cfg, "B", 0);
  const userA = await signerFor(cfg, "A", Number(process.env.USER_INDEX || 1));
  const userB = await signerFor(cfg, "B", Number(process.env.USER_INDEX || 1));
  return { cfg, artifacts, ownerA, ownerB, userA, userB };
}

async function consensusSummary(client, sourceChainId, consensusHash) {
  if (zeroHash(consensusHash)) return null;
  const state = await client.consensusState(sourceChainId, consensusHash);
  return {
    consensusHash,
    validatorEpochId: state.validatorEpochId.toString(),
    validatorEpochHash: state.validatorEpochHash,
    headerHeight: state.height.toString(),
    blockHash: state.blockHash,
    packetRoot: state.packetRoot,
    stateRoot: state.stateRoot,
    executionStateRoot: state.executionStateRoot,
    packetRange: `${state.firstPacketSequence.toString()}-${state.lastPacketSequence.toString()}`,
    packetCount: state.packetCount.toString(),
    sourceBlockNumber: state.sourceBlockNumber.toString(),
    sourceBlockHash: state.sourceBlockHash,
  };
}

export async function readDemoStatus() {
  const health = await localHealth();
  if (!health.ready) return health;
  if (health.stackVersion === "v2") return readDemoStatusV2(health);

  const ctx = await context();
  const { cfg, artifacts, userA, userB } = ctx;
  const userAAddress = await userA.getAddress();
  const userBAddress = await userB.getAddress();
  const canonical = new ethers.Contract(cfg.chains.A.canonicalToken, artifacts.bankToken.abi, providerFor(cfg, "A"));
  const escrow = new ethers.Contract(cfg.chains.A.escrowVault, artifacts.escrow.abi, providerFor(cfg, "A"));
  const voucher = new ethers.Contract(cfg.chains.B.voucherToken, artifacts.voucher.abi, providerFor(cfg, "B"));
  const debtToken = cfg.chains.B.debtToken
    ? new ethers.Contract(cfg.chains.B.debtToken, artifacts.bankToken.abi, providerFor(cfg, "B"))
    : null;
  const lendingPool = cfg.chains.B.lendingPool
    ? new ethers.Contract(cfg.chains.B.lendingPool, artifacts.lendingPool.abi, providerFor(cfg, "B"))
    : null;
  const packetA = new ethers.Contract(cfg.chains.A.packetStore, artifacts.packetStore.abi, providerFor(cfg, "A"));
  const packetB = new ethers.Contract(cfg.chains.B.packetStore, artifacts.packetStore.abi, providerFor(cfg, "B"));
  const headerProducerA = new ethers.Contract(
    headerProducerAddress(cfg.chains.A),
    artifacts.checkpointRegistry.abi,
    providerFor(cfg, "A")
  );
  const headerProducerB = new ethers.Contract(
    headerProducerAddress(cfg.chains.B),
    artifacts.checkpointRegistry.abi,
    providerFor(cfg, "B")
  );
  const clientA = new ethers.Contract(cfg.chains.A.client, artifacts.client.abi, providerFor(cfg, "A"));
  const clientB = new ethers.Contract(cfg.chains.B.client, artifacts.client.abi, providerFor(cfg, "B"));
  const handlerA = new ethers.Contract(cfg.chains.A.packetHandler, artifacts.handler.abi, providerFor(cfg, "A"));
  const handlerB = new ethers.Contract(cfg.chains.B.packetHandler, artifacts.handler.abi, providerFor(cfg, "B"));
  const trace = await readTrace();

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
    headerHeightA,
    headerHeightB,
    trustedAOnB,
    trustedBOnA,
    statusAOnB,
    statusBOnA,
    activeEpochAOnB,
    activeEpochBOnA,
    consensusHashAOnB,
    consensusHashBOnA,
    sourceBlockAOnB,
    sourceBlockBOnA,
  ] = await Promise.all([
    canonical.balanceOf(userAAddress),
    escrow.totalEscrowed(),
    voucher.balanceOf(userBAddress),
    debtToken ? debtToken.balanceOf(userBAddress) : 0n,
    lendingPool ? lendingPool.collateralBalance(userBAddress) : 0n,
    lendingPool ? lendingPool.debtBalance(userBAddress) : 0n,
    debtToken && lendingPool ? debtToken.balanceOf(cfg.chains.B.lendingPool) : 0n,
    packetA.packetSequence(),
    packetB.packetSequence(),
    headerProducerA.headerHeight(),
    headerProducerB.headerHeight(),
    clientB.latestConsensusStateSequence(cfg.chains.A.chainId),
    clientA.latestConsensusStateSequence(cfg.chains.B.chainId),
    clientB.status(cfg.chains.A.chainId),
    clientA.status(cfg.chains.B.chainId),
    clientB.activeValidatorEpochId(cfg.chains.A.chainId),
    clientA.activeValidatorEpochId(cfg.chains.B.chainId),
    clientB.latestConsensusStateHash(cfg.chains.A.chainId),
    clientA.latestConsensusStateHash(cfg.chains.B.chainId),
    clientB.latestSourceBlockNumber(cfg.chains.A.chainId),
    clientA.latestSourceBlockNumber(cfg.chains.B.chainId),
  ]);

  const [trustedAOnBSummary, trustedBOnASummary, forwardConsumed, reverseConsumed] = await Promise.all([
    consensusSummary(clientB, cfg.chains.A.chainId, consensusHashAOnB),
    consensusSummary(clientA, cfg.chains.B.chainId, consensusHashBOnA),
    hash32(trace?.forward?.packetId) ? handlerB.consumedPackets(trace.forward.packetId) : false,
    hash32(trace?.reverse?.packetId) ? handlerA.consumedPackets(trace.reverse.packetId) : false,
  ]);

  return {
    deployed: true,
    runtime: health.runtime || cfg.runtime || normalizeRuntime(cfg),
    userA: userAAddress,
    userB: userBAddress,
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
      headerHeightA: headerHeightA.toString(),
      headerHeightB: headerHeightB.toString(),
      trustedAOnB: trustedAOnB.toString(),
      trustedBOnA: trustedBOnA.toString(),
      statusAOnB: Number(statusAOnB),
      statusBOnA: Number(statusBOnA),
      activeEpochAOnB: activeEpochAOnB.toString(),
      activeEpochBOnA: activeEpochBOnA.toString(),
      consensusHashAOnB,
      consensusHashBOnA,
      sourceBlockAOnB: sourceBlockAOnB.toString(),
      sourceBlockBOnA: sourceBlockBOnA.toString(),
    },
    trust: {
      aOnB: trustedAOnBSummary,
      bOnA: trustedBOnASummary,
    },
    security: {
      forwardConsumed,
      reverseConsumed,
      replayBlocked: Boolean(forwardConsumed || trace?.security?.replayBlocked),
      nonMembershipImplemented: true,
      nonMembership: trace?.security?.nonMembership || null,
      frozen: Number(statusAOnB) === 2 || Number(statusBOnA) === 2,
      recovering: Number(statusAOnB) === 3 || Number(statusBOnA) === 3,
    },
    trace,
  };
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

async function readDemoStatusV2(health) {
  const cfg = health.cfg;
  const artifacts = await loadV2Artifacts();
  const providerA = providerForV2(cfg, "A");
  const providerB = providerForV2(cfg, "B");
  const sourceUser =
    cfg.participants?.sourceUser ||
    (await (await signerForV2(cfg, "A", Number(cfg.participants?.sourceUserIndex ?? 1))).getAddress());
  const destinationUser =
    cfg.participants?.destinationUser ||
    (await (await signerForV2(cfg, "B", Number(cfg.participants?.destinationUserIndex ?? 1))).getAddress());

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

  return {
    deployed: true,
    stackVersion: "v2",
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
      replayBlocked: Boolean(forwardConsumed || trace?.security?.replayBlocked),
      replayProofHeight: trace?.security?.replayProofHeight || null,
      nonMembershipImplemented: true,
      nonMembership: trace?.security?.nonMembership || null,
      frozen: statusAOnBNumber === 2 || statusBOnANumber === 2,
      recovering: statusAOnBNumber === 3 || statusBOnANumber === 3,
      evidenceAOnB: frozenEvidenceAOnB,
      evidenceBOnA: frozenEvidenceBOnA,
    },
    trace,
  };
}
