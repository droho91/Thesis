import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { loadArtifact, normalizeRuntime } from "./besu-runtime.mjs";
import { loadRuntimeConfig, providerForChain, signerForChain, RUNTIME_CONFIG_PATH } from "./interchain-config.mjs";

// Demo read-model: probes local health and assembles the UI/status snapshot from deployed contracts.
const TRACE_JSON_PATH = resolve(process.cwd(), "demo", "latest-run.json");
const TRANSFER_AMOUNT = ethers.parseUnits(process.env.DEMO_AMOUNT || "100", 18);
const SHOCKED_VOUCHER_PRICE_E18 = ethers.parseUnits(process.env.DEMO_SHOCKED_VOUCHER_PRICE || "0.5", 18);
const BPS = 10_000n;
const WAD = 10n ** 18n;

function units(value) {
  return ethers.formatUnits(value, 18);
}

function bps(value) {
  return value == null ? null : value.toString();
}

function minBigInt(a, b) {
  return a < b ? a : b;
}

function safeSub(a, b) {
  return a > b ? a - b : 0n;
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
  if (!evidence || !hash32(evidence.evidenceHash) || evidence.evidenceHash === ethers.ZeroHash) return null;

  return {
    sourceChainId: evidence.sourceChainId?.toString() ?? null,
    height: evidence.height?.toString() ?? null,
    trustedHeaderHash: evidence.trustedHeaderHash,
    conflictingHeaderHash: evidence.conflictingHeaderHash,
    evidenceHash: evidence.evidenceHash,
    detectedAt: evidence.detectedAt?.toString() ?? null,
  };
}

function collateralValueOf(collateral, price, haircutBps) {
  const grossValue = collateral * price / WAD;
  return grossValue * haircutBps / BPS;
}

function debtValueOf(debt, price) {
  return debt * price / WAD;
}

function maxBorrowFor({ collateral, collateralPrice, debtPrice, haircutBps, collateralFactorBps }) {
  const collateralValue = collateralValueOf(collateral, collateralPrice, haircutBps);
  const borrowValue = collateralValue * collateralFactorBps / BPS;
  return debtPrice === 0n ? 0n : borrowValue * WAD / debtPrice;
}

function healthFactorFor({ collateral, debt, collateralPrice, debtPrice, haircutBps, collateralFactorBps }) {
  if (debt === 0n) return (2n ** 256n) - 1n;
  const permittedDebtValue = collateralValueOf(collateral, collateralPrice, haircutBps) * collateralFactorBps / BPS;
  const currentDebtValue = debtValueOf(debt, debtPrice);
  if (currentDebtValue === 0n) return (2n ** 256n) - 1n;
  return permittedDebtValue * BPS / currentDebtValue;
}

function derivedLiquidationPreview({
  debt,
  collateral,
  repayAmount,
  seizedCollateral,
  totalReserves,
  totalBadDebt,
}) {
  const repay = minBigInt(repayAmount, debt);
  const seized = minBigInt(seizedCollateral, collateral);
  const debtAfterRepay = safeSub(debt, repay);
  const collateralAfterSeize = safeSub(collateral, seized);
  const collateralExhausted = collateral > 0n && collateralAfterSeize === 0n;
  const badDebtWrittenOff = collateralExhausted ? debtAfterRepay : 0n;
  const reservesUsed = minBigInt(badDebtWrittenOff, totalReserves);
  const supplierLoss = badDebtWrittenOff - reservesUsed;
  return {
    repayAmount: units(repay),
    seizedCollateral: units(seized),
    remainingDebt: units(badDebtWrittenOff > 0n ? 0n : debtAfterRepay),
    remainingCollateral: units(collateralAfterSeize),
    badDebtWrittenOff: units(badDebtWrittenOff),
    reserveUsed: units(reservesUsed),
    supplierLoss: units(supplierLoss),
    totalBadDebtAfter: units(totalBadDebt + supplierLoss),
    collateralExhausted,
  };
}

function packetStatusLabel({ consumed, acknowledged, timedOut, rejected, frozen, recovered }) {
  if (frozen) return "Frozen";
  if (recovered) return "Recovered";
  if (timedOut) return "Timed out";
  if (acknowledged) return "Acknowledged";
  if (consumed) return "Executed";
  if (rejected) return "Rejected";
  return "Pending";
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
    oracle: await loadArtifact("apps/ManualAssetOracle.sol", "ManualAssetOracle"),
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
  const liquiditySupplier = cfg.participants?.liquiditySupplier || cfg.chains.B.admin;

  const canonical = new ethers.Contract(cfg.chains.A.canonicalToken, artifacts.bankToken.abi, providerA);
  const escrow = new ethers.Contract(cfg.chains.A.escrowVault, artifacts.escrow.abi, providerA);
  const voucher = new ethers.Contract(cfg.chains.B.voucherToken, artifacts.voucher.abi, providerB);
  const debtToken = new ethers.Contract(cfg.chains.B.debtToken, artifacts.bankToken.abi, providerB);
  const lendingPool = new ethers.Contract(cfg.chains.B.lendingPool, artifacts.lendingPool.abi, providerB);
  const oracle = new ethers.Contract(cfg.chains.B.oracle, artifacts.oracle.abi, providerB);
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
    poolCash,
    poolLiquidity,
    totalAssets,
    totalBorrows,
    totalReserves,
    totalBadDebt,
    totalDebtShares,
    totalLiquidityShares,
    borrowIndex,
    exchangeRate,
    utilizationRate,
    borrowRate,
    supplierLiquidity,
    supplierShares,
    borrowerDebtShares,
    healthFactor,
    maxBorrow,
    availableToBorrow,
    collateralValue,
    debtValue,
    collateralFactorBps,
    collateralHaircutBps,
    liquidationCloseFactorBps,
    liquidationBonusBps,
    isLiquidatable,
    maxLiquidationRepay,
    previewLiquidationRaw,
    voucherPrice,
    voucherPriceUpdatedAt,
    debtPrice,
    debtPriceUpdatedAt,
    maxStaleness,
    headBlockB,
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
    lendingPool.totalCash(),
    lendingPool.availableLiquidity(),
    lendingPool.totalAssets(),
    lendingPool.accruedTotalBorrows(),
    lendingPool.totalReserves(),
    lendingPool.totalBadDebt(),
    lendingPool.totalDebtShares(),
    lendingPool.totalLiquidityShares(),
    lendingPool.borrowIndexE18(),
    lendingPool.exchangeRateE18(),
    lendingPool.utilizationRateBps(),
    lendingPool.currentBorrowRateBps(),
    lendingPool.liquidityBalanceOf(liquiditySupplier),
    lendingPool.liquidityShares(liquiditySupplier),
    lendingPool.debtShares(destinationUser),
    safeView("healthFactorBps", () => lendingPool.healthFactorBps(destinationUser), 0n),
    safeView("maxBorrow", () => lendingPool.maxBorrow(destinationUser), 0n),
    safeView("availableToBorrow", () => lendingPool.availableToBorrow(destinationUser), 0n),
    safeView("collateralValue", () => lendingPool.collateralValue(destinationUser), 0n),
    safeView("debtValue", () => lendingPool.debtValue(destinationUser), 0n),
    lendingPool.collateralFactorBps(),
    lendingPool.collateralHaircutBps(),
    lendingPool.liquidationCloseFactorBps(),
    lendingPool.liquidationBonusBps(),
    safeView("isLiquidatable", () => lendingPool.isLiquidatable(destinationUser), false),
    safeView("maxLiquidationRepay", () => lendingPool.maxLiquidationRepay(destinationUser), 0n),
    safeView(
      "previewLiquidation(max)",
      async () => {
        const repay = await lendingPool.maxLiquidationRepay(destinationUser);
        return repay > 0n ? lendingPool.previewLiquidation(destinationUser, repay) : 0n;
      },
      0n
    ),
    oracle.assetPriceE18(cfg.chains.B.voucherToken),
    oracle.assetPriceUpdatedAt(cfg.chains.B.voucherToken),
    oracle.assetPriceE18(cfg.chains.B.debtToken),
    oracle.assetPriceUpdatedAt(cfg.chains.B.debtToken),
    oracle.maxStaleness(),
    providerB.getBlock("latest"),
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
  const nowB = BigInt(headBlockB?.timestamp ?? 0);
  const oracleAge = (updatedAt) => updatedAt > 0n && nowB >= updatedAt ? nowB - updatedAt : 0n;
  const voucherPriceAge = oracleAge(voucherPriceUpdatedAt);
  const debtPriceAge = oracleAge(debtPriceUpdatedAt);
  const oracleFresh = voucherPriceUpdatedAt > 0n && debtPriceUpdatedAt > 0n && voucherPriceAge <= maxStaleness && debtPriceAge <= maxStaleness;
  const shockedCollateralValue = collateralValueOf(poolCollateral, SHOCKED_VOUCHER_PRICE_E18, collateralHaircutBps);
  const shockedMaxBorrow = maxBorrowFor({
    collateral: poolCollateral,
    collateralPrice: SHOCKED_VOUCHER_PRICE_E18,
    debtPrice,
    haircutBps: collateralHaircutBps,
    collateralFactorBps,
  });
  const shockedHealthFactor = healthFactorFor({
    collateral: poolCollateral,
    debt: poolDebt,
    collateralPrice: SHOCKED_VOUCHER_PRICE_E18,
    debtPrice,
    haircutBps: collateralHaircutBps,
    collateralFactorBps,
  });
  const liquidationPreview = derivedLiquidationPreview({
    debt: poolDebt,
    collateral: poolCollateral,
    repayAmount: maxLiquidationRepay,
    seizedCollateral: previewLiquidationRaw,
    totalReserves,
    totalBadDebt,
  });
  const misbehaviourTrace = trace?.misbehaviour || {};
  const deniedTimedOutLive = Boolean(deniedTimedOut || trace?.denied?.timedOut);
  const forwardProofVerified = Boolean(forwardConsumed || trace?.forward?.receiveTxHash || voucherBalance > 0n || poolCollateral > 0n);
  const packetLifecycleStatus = packetStatusLabel({
    consumed: forwardProofVerified,
    acknowledged: forwardAcknowledged,
    timedOut: false,
    rejected: false,
    frozen: statusAOnBNumber === 2 || statusBOnANumber === 2,
    recovered: Boolean(misbehaviourTrace.recovered),
  });

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
      poolCash: units(poolCash),
      poolLiquidity: units(poolLiquidity),
    },
    market: {
      liquiditySupplier,
      supplierLiquidity: units(supplierLiquidity),
      supplierShares: units(supplierShares),
      totalLiquidityShares: units(totalLiquidityShares),
      totalAssets: units(totalAssets),
      totalBorrows: units(totalBorrows),
      totalDebtShares: units(totalDebtShares),
      totalReserves: units(totalReserves),
      totalBadDebt: units(totalBadDebt),
      borrowIndex: units(borrowIndex),
      exchangeRate: units(exchangeRate),
      utilizationRateBps: utilizationRate.toString(),
      borrowRateBps: borrowRate.toString(),
      borrowerDebtShares: units(borrowerDebtShares),
      healthFactorBps: healthFactor.toString(),
      maxBorrow: units(maxBorrow),
      availableToBorrow: units(availableToBorrow),
      voucherPrice: units(voucherPrice),
      debtPrice: units(debtPrice),
      voucherPriceAgeSeconds: voucherPriceAge.toString(),
      debtPriceAgeSeconds: debtPriceAge.toString(),
      maxStalenessSeconds: maxStaleness.toString(),
      oracleFresh,
    },
    risk: {
      oracle: {
        label: "Governed Demo Oracle",
        collateralAsset: "vA",
        debtAsset: "bCASH",
        collateralPrice: units(voucherPrice),
        debtPrice: units(debtPrice),
        collateralPriceUpdatedAt: voucherPriceUpdatedAt.toString(),
        debtPriceUpdatedAt: debtPriceUpdatedAt.toString(),
        collateralPriceAgeSeconds: voucherPriceAge.toString(),
        debtPriceAgeSeconds: debtPriceAge.toString(),
        maxStalenessSeconds: maxStaleness.toString(),
        fresh: oracleFresh,
      },
      position: {
        borrower: destinationUser,
        collateral: units(poolCollateral),
        collateralValue: units(collateralValue),
        debt: units(poolDebt),
        debtValue: units(debtValue),
        maxBorrow: units(maxBorrow),
        availableBorrow: units(availableToBorrow),
        healthFactorBps: healthFactor.toString(),
        liquidatable: Boolean(isLiquidatable),
      },
      market: {
        totalLiquidity: units(totalAssets),
        availableLiquidity: units(poolLiquidity),
        totalDebt: units(totalBorrows),
        totalReserves: units(totalReserves),
        totalBadDebt: units(totalBadDebt),
        utilizationRateBps: utilizationRate.toString(),
        borrowRateBps: borrowRate.toString(),
      },
      policy: {
        collateralFactorBps: bps(collateralFactorBps),
        collateralHaircutBps: bps(collateralHaircutBps),
        liquidationThresholdBps: bps(collateralFactorBps),
        liquidationCloseFactorBps: bps(liquidationCloseFactorBps),
        liquidationBonusBps: bps(liquidationBonusBps),
      },
      shockPreview: {
        collateralPrice: units(SHOCKED_VOUCHER_PRICE_E18),
        collateralValue: units(shockedCollateralValue),
        maxBorrow: units(shockedMaxBorrow),
        availableBorrow: units(safeSub(shockedMaxBorrow, poolDebt)),
        healthFactorBps: shockedHealthFactor.toString(),
        liquidatable: poolDebt > 0n && shockedHealthFactor < BPS,
      },
      liquidationPreview: {
        ...liquidationPreview,
        repayAmountRaw: maxLiquidationRepay.toString(),
        seizedCollateralRaw: minBigInt(previewLiquidationRaw, poolCollateral).toString(),
        closeFactorBps: liquidationCloseFactorBps.toString(),
        bonusBps: liquidationBonusBps.toString(),
        executable: Boolean(isLiquidatable && maxLiquidationRepay > 0n),
      },
      afterLiquidation: {
        debt: units(poolDebt),
        collateral: units(poolCollateral),
        reserves: units(totalReserves),
        badDebt: units(totalBadDebt),
        latestTxHash: trace?.risk?.liquidationTxHash || null,
      },
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
    proofInspector: {
      model: "Besu-first light-client verification model",
      sourceChain: `Bank A / ${chainIdA.toString()}`,
      destinationChain: `Bank B / ${chainIdB.toString()}`,
      reverseSourceChain: `Bank B / ${chainIdB.toString()}`,
      reverseDestinationChain: `Bank A / ${chainIdA.toString()}`,
      packetId: trace?.forward?.packetId || null,
      messageId: trace?.forward?.packetId || null,
      packetCommitment: trace?.forward?.packetLeaf || null,
      packetPath: trace?.forward?.packetPath || null,
      trustedHeight: trace?.forward?.trustedHeight || trustedAOnB.toString(),
      headerHash: trace?.forward?.trustedHeaderHash || trustedAOnBSummary?.consensusHash || ethers.ZeroHash,
      stateRoot: trace?.forward?.trustedStateRoot || trustedAOnBSummary?.stateRoot || ethers.ZeroHash,
      storageSlot: trace?.forward?.packetLeafSlot || null,
      proofKey: trace?.forward?.packetPathSlot || trace?.forward?.packetLeafSlot || null,
      proofVerificationResult: forwardProofVerified ? "Verified" : "Pending",
      receiptStatus: forwardConsumed ? "Executed once" : "Pending",
      acknowledgementStatus: forwardAcknowledged || trace?.forward?.sourceAckHash ? "Acknowledged" : "Pending",
      timeoutStatus: deniedTimedOutLive
        ? "Timed out"
        : traceSecurity.timeoutAbsence || traceSecurity.nonMembership
          ? "Receipt absence proof available"
          : "Pending",
      replayProtectionStatus: traceSecurity.replayBlocked || forwardConsumed ? "Protected" : "Pending",
      lightClientStatus: {
        bankAOnBankB: clientStatusName(statusAOnBNumber),
        bankBOnBankA: clientStatusName(statusBOnANumber),
        frozen: statusAOnBNumber === 2 || statusBOnANumber === 2,
        recovering: statusAOnBNumber === 3 || statusBOnANumber === 3,
      },
      freezeEvidence: frozenEvidenceAOnB || frozenEvidenceBOnA || normalizeEvidence(misbehaviourTrace),
      recoveryStatus: misbehaviourTrace.recovered
        ? "Recovered"
        : statusAOnBNumber === 3 || statusBOnANumber === 3
          ? "Recovering"
          : statusAOnBNumber === 2 || statusBOnANumber === 2
            ? "Frozen"
            : "Active",
      lifecycleStatus: packetLifecycleStatus,
      deniedPacketId: trace?.denied?.packetId || null,
      timeoutStorageKey: trace?.timeout?.receiptStorageKey || traceSecurity.timeoutAbsence?.receiptSlot || null,
      replayProofHeight: traceSecurity.replayProofHeight || null,
    },
    trace,
  };
}
