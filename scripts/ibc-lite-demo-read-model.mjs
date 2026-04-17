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

// Demo read-model: probes local health and assembles the UI/status snapshot from deployed contracts.
const TRACE_JSON_PATH = resolve(process.cwd(), "demo", "latest-run.json");
const CONFIG_PATH = resolve(process.cwd(), ".ibc-lite.local.json");
const TRANSFER_AMOUNT = ethers.parseUnits(process.env.DEMO_AMOUNT || "100", 18);

function units(value) {
  return ethers.formatUnits(value, 18);
}

function zeroHash(value) {
  return !value || value === ethers.ZeroHash;
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

export async function readTrace() {
  try {
    return normalizeTrace(JSON.parse(await readFile(TRACE_JSON_PATH, "utf8")));
  } catch {
    return null;
  }
}

async function configExists() {
  try {
    await access(CONFIG_PATH);
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

export async function localHealth() {
  const runtime = normalizeRuntime();
  if (!(await configExists())) {
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
    trace?.forward?.packetId ? handlerB.consumedPackets(trace.forward.packetId) : false,
    trace?.reverse?.packetId ? handlerA.consumedPackets(trace.reverse.packetId) : false,
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
