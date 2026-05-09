import { ethers } from "ethers";
import {
  DENIED_AMOUNT,
  DEMO_PACKET_TIMEOUT_HEIGHT,
  FORWARD_AMOUNT,
  BORROW_AMOUNT,
  LIQUIDATION_REPAY,
  OUT_JS_PATH,
  OUT_JSON_PATH,
  RUNTIME_CONFIG_PATH,
  SHOCKED_VOUCHER_PRICE_E18,
  approveIfNeeded,
  asBigInt,
  chainId,
  compact,
  ensureDeploymentCode,
  ensureRiskSeeded,
  ensureSeededConfig,
  isWorldStateUnavailable,
  loadContext,
  loadRuntimeConfig,
  normalizeRuntime,
  openOrReuseHandshake,
  packetLeaf,
  packetPath,
  previewField,
  readWithRetry,
  reversePacket,
  saveRuntimeConfig,
  setPhase,
  transferPacket,
  trustRemoteHeaderAt,
  txOptions,
  txStep,
  units,
  waitForBesuRuntimeReady,
} from "../context.mjs";
import { writeTrace } from "../trace-writer.mjs";
import { buildAcknowledgementProof, buildPacketProofs } from "../proof/packet-proof-builder.mjs";
import { trustCurrentHeaderForProof } from "../proof/header-trust.mjs";
import { executeTimeoutRefundAction } from "../actions/timeout-actions.mjs";

const readDemo = (label, read) => readWithRetry(label, read);

export async function runRiskScenario() {
  const runtime = normalizeRuntime();
  if (!runtime.besuFirst) {
    throw new Error("run-lending-demo.mjs is a Besu-first entrypoint.");
  }

  setPhase("wait-runtime");
  await waitForBesuRuntimeReady();

  setPhase("load-config");
  const config = await loadRuntimeConfig();
  await ensureSeededConfig(config);
  await ensureDeploymentCode(config);
  const sourceChainId = chainId(config, "A");
  const destinationChainId = chainId(config, "B");

  setPhase("load-contracts");
  const ctx = await loadContext(config);

  setPhase("open-or-reuse-handshake");
  const { connectionHandshake, channelHandshake } = await openOrReuseHandshake(config, ctx);

  setPhase("prepare-forward-policy-and-allowance");
  await ensureRiskSeeded(config, ctx);
  await approveIfNeeded(
    ctx.A.canonicalTokenUser,
    ctx.sourceUserAddress,
    config.chains.A.escrowVault,
    FORWARD_AMOUNT + DENIED_AMOUNT,
    "approve escrow spend"
  );

  setPhase("send-forward-packet");
  const approvedSequence = asBigInt(await ctx.A.packetStore.nextSequence());
  const approvedSendReceipt = await txStep("send forward packet", () =>
    ctx.A.transferAppUser.sendTransfer(
      destinationChainId,
      ctx.destinationUserAddress,
      FORWARD_AMOUNT,
      DEMO_PACKET_TIMEOUT_HEIGHT,
      0,
      txOptions()
    )
  );
  const approvedCommitHeight = BigInt(approvedSendReceipt.blockNumber);
  const approvedPacket = transferPacket({
    sequence: approvedSequence,
    sourceChainId,
    destinationChainId,
    config,
    sender: ctx.sourceUserAddress,
    recipient: ctx.destinationUserAddress,
    amount: FORWARD_AMOUNT,
    timeoutHeight: DEMO_PACKET_TIMEOUT_HEIGHT,
  });
  const approvedPacketId = await ctx.A.packetStore.packetIdAt(approvedSequence);

  setPhase("trust-source-header-and-receive");
  let approvedHeader = await trustRemoteHeaderAt({
    lightClient: ctx.B.lightClient,
    provider: ctx.providerA,
    sourceChainId,
    targetHeight: approvedCommitHeight,
    validatorEpoch: 1n,
  });
  let approvedProofHeight = approvedHeader.headerUpdate.height;
  let approvedProofs;
  try {
    approvedProofs = await buildPacketProofs({
      provider: ctx.providerA,
      packetStoreAddress: config.chains.A.packetStore,
      packet: approvedPacket,
      sourceChainId,
      trustedHeight: approvedProofHeight,
      stateRoot: approvedHeader.headerUpdate.stateRoot,
    });
  } catch (error) {
    if (!isWorldStateUnavailable(error)) throw error;
    console.warn("[demo] Bank A proof state unavailable at trusted height; importing a fresher header and retrying packet proof.");
    const refreshed = await trustCurrentHeaderForProof({
      lightClient: ctx.B.lightClient,
      provider: ctx.providerA,
      sourceChainId,
      minimumHeight: approvedCommitHeight,
    });
    approvedHeader = refreshed.header;
    approvedProofHeight = refreshed.height;
    approvedProofs = await buildPacketProofs({
      provider: ctx.providerA,
      packetStoreAddress: config.chains.A.packetStore,
      packet: approvedPacket,
      sourceChainId,
      trustedHeight: approvedProofHeight,
      stateRoot: approvedHeader.headerUpdate.stateRoot,
    });
  }
  const approvedRecvReceipt = await txStep("receive forward packet", () =>
    ctx.B.packetHandler.recvPacketFromStorageProof(
      approvedPacket,
      approvedProofs.leafProof,
      approvedProofs.pathProof,
      txOptions()
    )
  );
  const approvedAckHash = await ctx.B.packetHandler.acknowledgementHashes(approvedPacketId);
  const voucherBalanceAfterReceive = await ctx.B.voucherAdmin.balanceOf(ctx.destinationUserAddress);

  setPhase("acknowledge-forward-packet");
  const ackHeight = BigInt(approvedRecvReceipt.blockNumber);
  let ackHeader = await trustRemoteHeaderAt({
    lightClient: ctx.A.lightClient,
    provider: ctx.providerB,
    sourceChainId: destinationChainId,
    targetHeight: ackHeight,
    validatorEpoch: 1n,
  });
  let acknowledgementProofHeight = ackHeader.headerUpdate.height;
  const acknowledgement = ethers.solidityPacked(["string", "bytes32"], ["ok:", approvedPacketId]);
  let acknowledgementSlot;
  let ackProof;
  try {
    ({ acknowledgementSlot, proof: ackProof } = await buildAcknowledgementProof({
      provider: ctx.providerB,
      packetHandlerAddress: config.chains.B.packetHandler,
      packetIdValue: approvedPacketId,
      acknowledgementHash: approvedAckHash,
      sourceChainId: destinationChainId,
      trustedHeight: acknowledgementProofHeight,
      stateRoot: ackHeader.headerUpdate.stateRoot,
    }));
  } catch (error) {
    if (!isWorldStateUnavailable(error)) throw error;
    console.warn("[demo] Bank B acknowledgement state unavailable at trusted height; importing a fresher header and retrying acknowledgement proof.");
    const refreshed = await trustCurrentHeaderForProof({
      lightClient: ctx.A.lightClient,
      provider: ctx.providerB,
      sourceChainId: destinationChainId,
      minimumHeight: ackHeight,
    });
    ackHeader = refreshed.header;
    acknowledgementProofHeight = refreshed.height;
    ({ acknowledgementSlot, proof: ackProof } = await buildAcknowledgementProof({
      provider: ctx.providerB,
      packetHandlerAddress: config.chains.B.packetHandler,
      packetIdValue: approvedPacketId,
      acknowledgementHash: approvedAckHash,
      sourceChainId: destinationChainId,
      trustedHeight: acknowledgementProofHeight,
      stateRoot: ackHeader.headerUpdate.stateRoot,
    }));
  }
  const ackReceipt = await txStep("acknowledge forward packet", () =>
    ctx.A.packetHandler.acknowledgePacketFromStorageProof(
      approvedPacket,
      acknowledgement,
      config.chains.B.packetHandler,
      ackProof,
      txOptions()
    )
  );
  const sourceAckHash = await ctx.A.transferAppUser.acknowledgementHashByPacket(approvedPacketId);

  setPhase("risk-deposit-and-borrow");
  await ensureRiskSeeded(config, ctx);
  const currentCollateral = await readDemo("risk collateral balance", () =>
    ctx.B.lendingPoolAdmin.collateralBalance(ctx.destinationUserAddress)
  );
  const depositDelta = FORWARD_AMOUNT > currentCollateral ? FORWARD_AMOUNT - currentCollateral : 0n;
  if (depositDelta > 0n) {
    const voucherBalance = await readDemo("risk voucher balance", () =>
      ctx.B.voucherAdmin.balanceOf(ctx.destinationUserAddress)
    );
    if (voucherBalance < depositDelta) {
      throw new Error(
        `Bank B user needs ${units(depositDelta)} free voucher collateral, but only has ${units(voucherBalance)}.`
      );
    }
    await approveIfNeeded(
      ctx.B.voucherUser,
      ctx.destinationUserAddress,
      config.chains.B.lendingPool,
      depositDelta,
      "approve voucher collateral"
    );
    await txStep("deposit voucher collateral", () => ctx.B.lendingPoolUser.depositCollateral(depositDelta, txOptions()));
  }
  const [maxBorrowBefore, availableBeforeBorrow, debtBeforeBorrow] = await Promise.all([
    readDemo("risk max borrow", () => ctx.B.lendingPoolAdmin.maxBorrow(ctx.destinationUserAddress)),
    readDemo("risk available borrow", () => ctx.B.lendingPoolAdmin.availableToBorrow(ctx.destinationUserAddress)),
    readDemo("risk debt before borrow", () => ctx.B.lendingPoolAdmin.debtBalance(ctx.destinationUserAddress)),
  ]);
  const borrowDelta = BORROW_AMOUNT > debtBeforeBorrow ? BORROW_AMOUNT - debtBeforeBorrow : 0n;
  if (borrowDelta > 0n) {
    if (availableBeforeBorrow < borrowDelta) {
      const collateral = await readDemo("risk collateral for borrow limit", () =>
        ctx.B.lendingPoolAdmin.collateralBalance(ctx.destinationUserAddress)
      );
      throw new Error(
        `BORROW_LIMIT: available ${units(availableBeforeBorrow)} bCASH, need ${units(borrowDelta)}; ` +
          `maxBorrow=${units(maxBorrowBefore)}, collateral=${units(collateral)} vA, existingDebt=${units(debtBeforeBorrow)}.`
      );
    }
    await txStep("borrow debt asset", () => ctx.B.lendingPoolUser.borrow(borrowDelta, txOptions()));
  }
  const [healthBeforeShock, debtAfterBorrow, collateralAfterDeposit] = await Promise.all([
    readDemo("risk health before shock", () => ctx.B.lendingPoolAdmin.healthFactorBps(ctx.destinationUserAddress)),
    readDemo("risk debt after borrow", () => ctx.B.lendingPoolAdmin.debtBalance(ctx.destinationUserAddress)),
    readDemo("risk collateral after deposit", () => ctx.B.lendingPoolAdmin.collateralBalance(ctx.destinationUserAddress)),
  ]);

  setPhase("risk-price-shock-and-liquidate");
  await txStep("shock voucher price", () =>
    ctx.B.oracle.setPrice(config.chains.B.voucherToken, SHOCKED_VOUCHER_PRICE_E18, txOptions())
  );
  const [healthAfterShock, liquidatableAfterShock, maxLiquidationRepay, liquidationPreview] = await Promise.all([
    readDemo("risk health after shock", () => ctx.B.lendingPoolAdmin.healthFactorBps(ctx.destinationUserAddress)),
    readDemo("risk liquidatable after shock", () => ctx.B.lendingPoolAdmin.isLiquidatable(ctx.destinationUserAddress)),
    readDemo("risk max liquidation repay", () => ctx.B.lendingPoolAdmin.maxLiquidationRepay(ctx.destinationUserAddress)),
    readDemo("risk liquidation preview", () =>
      ctx.B.lendingPoolAdmin.previewLiquidation(ctx.destinationUserAddress, LIQUIDATION_REPAY)
    ),
  ]);
  const actualLiquidationRepay = previewField(liquidationPreview, "actualRepayAmount", 1);
  const seizedCollateralPreview = previewField(liquidationPreview, "seizedCollateral", 2);
  const [reservesBeforeLiquidation, badDebtBeforeLiquidation] = await Promise.all([
    readDemo("risk reserves before liquidation", () => ctx.B.lendingPoolAdmin.totalReserves()),
    readDemo("risk bad debt before liquidation", () => ctx.B.lendingPoolAdmin.totalBadDebt()),
  ]);
  await approveIfNeeded(
    ctx.B.debtLiquidator,
    ctx.liquidatorAddress,
    config.chains.B.lendingPool,
    actualLiquidationRepay,
    "approve liquidation repay"
  );
  const liquidationReceipt = await txStep("liquidate unhealthy position", () =>
    ctx.B.lendingPoolLiquidator.liquidate(ctx.destinationUserAddress, LIQUIDATION_REPAY, txOptions())
  );
  const [
    debtAfterLiquidation,
    collateralAfterLiquidation,
    reservesAfterLiquidation,
    badDebtAfterLiquidation,
    liquidatorVoucherBalance,
  ] = await Promise.all([
    readDemo("risk debt after liquidation", () => ctx.B.lendingPoolAdmin.debtBalance(ctx.destinationUserAddress)),
    readDemo("risk collateral after liquidation", () => ctx.B.lendingPoolAdmin.collateralBalance(ctx.destinationUserAddress)),
    readDemo("risk reserves after liquidation", () => ctx.B.lendingPoolAdmin.totalReserves()),
    readDemo("risk bad debt after liquidation", () => ctx.B.lendingPoolAdmin.totalBadDebt()),
    readDemo("risk liquidator voucher balance", () => ctx.B.voucherAdmin.balanceOf(ctx.liquidatorAddress)),
  ]);
  const badDebtWrittenOff =
    debtAfterBorrow > actualLiquidationRepay + debtAfterLiquidation ? debtAfterBorrow - actualLiquidationRepay - debtAfterLiquidation : 0n;
  const reservesUsed =
    reservesBeforeLiquidation > reservesAfterLiquidation ? reservesBeforeLiquidation - reservesAfterLiquidation : 0n;
  const supplierLoss =
    badDebtAfterLiquidation > badDebtBeforeLiquidation ? badDebtAfterLiquidation - badDebtBeforeLiquidation : 0n;

  setPhase("settle-liquidator-voucher");
  if (liquidatorVoucherBalance === 0n) {
    throw new Error("Liquidation completed without seized voucher collateral, so settlement cannot be demonstrated.");
  }
  const settlementSequence = asBigInt(await ctx.B.packetStore.nextSequence());
  const settlementBurnReceipt = await txStep("settle seized voucher", () =>
    ctx.B.transferAppLiquidator.settleSeizedVoucher(
      sourceChainId,
      ctx.sourceLiquidatorAddress,
      liquidatorVoucherBalance,
      DEMO_PACKET_TIMEOUT_HEIGHT,
      0,
      txOptions()
    )
  );
  const settlementCommitHeight = BigInt(settlementBurnReceipt.blockNumber);
  const settlementPacket = reversePacket({
    sequence: settlementSequence,
    sourceChainId: destinationChainId,
    destinationChainId: sourceChainId,
    config,
    sender: ctx.liquidatorAddress,
    recipient: ctx.sourceLiquidatorAddress,
    amount: liquidatorVoucherBalance,
    timeoutHeight: DEMO_PACKET_TIMEOUT_HEIGHT,
  });
  const settlementPacketId = await ctx.B.packetStore.packetIdAt(settlementSequence);
  let settlementHeader = await trustRemoteHeaderAt({
    lightClient: ctx.A.lightClient,
    provider: ctx.providerB,
    sourceChainId: destinationChainId,
    targetHeight: settlementCommitHeight,
    validatorEpoch: 1n,
  });
  let settlementProofHeight = settlementHeader.headerUpdate.height;
  let settlementProofs;
  try {
    settlementProofs = await buildPacketProofs({
      provider: ctx.providerB,
      packetStoreAddress: config.chains.B.packetStore,
      packet: settlementPacket,
      sourceChainId: destinationChainId,
      trustedHeight: settlementProofHeight,
      stateRoot: settlementHeader.headerUpdate.stateRoot,
    });
  } catch (error) {
    if (!isWorldStateUnavailable(error)) throw error;
    console.warn("[demo] Bank B settlement proof state unavailable; importing a fresher header and retrying packet proof.");
    const refreshed = await trustCurrentHeaderForProof({
      lightClient: ctx.A.lightClient,
      provider: ctx.providerB,
      sourceChainId: destinationChainId,
      minimumHeight: settlementCommitHeight,
    });
    settlementHeader = refreshed.header;
    settlementProofHeight = refreshed.height;
    settlementProofs = await buildPacketProofs({
      provider: ctx.providerB,
      packetStoreAddress: config.chains.B.packetStore,
      packet: settlementPacket,
      sourceChainId: destinationChainId,
      trustedHeight: settlementProofHeight,
      stateRoot: settlementHeader.headerUpdate.stateRoot,
    });
  }
  const settlementRecvReceipt = await txStep("receive seized-voucher settlement packet", () =>
    ctx.A.packetHandler.recvPacketFromStorageProof(
      settlementPacket,
      settlementProofs.leafProof,
      settlementProofs.pathProof,
      txOptions()
    )
  );
  const liquidatorOriginBalanceAfterSettlement = await ctx.A.canonicalTokenAdmin.balanceOf(ctx.sourceLiquidatorAddress);
  const escrowAfterSettlement = await ctx.A.escrow.totalEscrowed();

  const timeoutResult = await executeTimeoutRefundAction(config, ctx, sourceChainId, destinationChainId, {
    ensureSeeded: false,
  });

  setPhase("read-final-state");
  const poolLiquidity = await ctx.B.debtAdmin.balanceOf(config.chains.B.lendingPool);
  const destinationDebtBalance = await ctx.B.debtAdmin.balanceOf(ctx.destinationUserAddress);

  const trace = {
    version: "interchain-lending",
    generatedAt: new Date().toISOString(),
    configPath: RUNTIME_CONFIG_PATH,
    runtime: config.runtime,
    architecture:
      "Besu light-client header imports, EVM storage-proof packet relay, and policy-controlled cross-chain lending.",
    scenario: {
      mode: "risk-liquidation",
      description:
        "Risk lifecycle: bridge collateral, borrow, shock oracle price, liquidate, settle seized voucher, and demonstrate timeout refund.",
      completed: true,
    },
    chains: {
      A: {
        chainId: sourceChainId.toString(),
        lightClient: config.chains.A.lightClient,
        packetHandler: config.chains.A.packetHandler,
        packetStore: config.chains.A.packetStore,
        transferApp: config.chains.A.transferApp,
        canonicalToken: config.chains.A.canonicalToken,
        escrowVault: config.chains.A.escrowVault,
      },
      B: {
        chainId: destinationChainId.toString(),
        lightClient: config.chains.B.lightClient,
        packetHandler: config.chains.B.packetHandler,
        packetStore: config.chains.B.packetStore,
        transferApp: config.chains.B.transferApp,
        voucherToken: config.chains.B.voucherToken,
        debtToken: config.chains.B.debtToken,
        oracle: config.chains.B.oracle,
        lendingPool: config.chains.B.lendingPool,
      },
    },
    participants: {
      sourceUser: ctx.sourceUserAddress,
      sourceLiquidator: ctx.sourceLiquidatorAddress,
      destinationUser: ctx.destinationUserAddress,
      liquidator: ctx.liquidatorAddress,
    },
    handshake: {
      connection: connectionHandshake,
      channel: channelHandshake,
      sourceConnectionId: config.constants.sourceConnectionId,
      destinationConnectionId: config.constants.destinationConnectionId,
      sourceChannelId: config.constants.sourceChannelId,
      destinationChannelId: config.constants.destinationChannelId,
    },
    forward: {
      operation: "Bank A escrow lock -> Bank B voucher mint",
      sequence: approvedSequence.toString(),
      amount: units(FORWARD_AMOUNT),
      packetId: approvedPacketId,
      packetLeaf: packetLeaf(approvedPacket),
      packetPath: packetPath(approvedPacket),
      packetLeafSlot: approvedProofs.leafSlot,
      packetPathSlot: approvedProofs.pathSlot,
      sourceTxHash: approvedSendReceipt.hash,
      receiveTxHash: approvedRecvReceipt.hash,
      acknowledgementTxHash: ackReceipt.hash,
      commitHeight: approvedCommitHeight.toString(),
      receiveHeight: ackHeight.toString(),
      trustedHeight: approvedProofHeight.toString(),
      trustedHeaderHash: approvedHeader.headerUpdate.headerHash,
      trustedStateRoot: approvedHeader.headerUpdate.stateRoot,
      destinationAckHash: approvedAckHash,
      sourceAckHash,
      acknowledgementSlot,
      acknowledgementTrustedHeight: acknowledgementProofHeight.toString(),
      voucherBalanceAfterReceive: units(voucherBalanceAfterReceive),
    },
    risk: {
      operation: "Voucher collateral -> bCASH borrow -> oracle shock -> authorized liquidation",
      collateralDeposited: units(collateralAfterDeposit),
      maxBorrowBefore: units(maxBorrowBefore),
      borrowed: units(debtAfterBorrow),
      healthBeforeShockBps: healthBeforeShock.toString(),
      shockedVoucherPriceE18: SHOCKED_VOUCHER_PRICE_E18.toString(),
      healthAfterShockBps: healthAfterShock.toString(),
      liquidatableAfterShock,
      maxLiquidationRepay: units(maxLiquidationRepay),
      liquidationRepaid: units(actualLiquidationRepay),
      liquidationRequestedRepay: units(LIQUIDATION_REPAY),
      liquidationTxHash: liquidationReceipt.hash,
      seizedCollateral: units(seizedCollateralPreview),
      collateralBeforeLiquidation: units(collateralAfterDeposit),
      debtBeforeLiquidation: units(debtAfterBorrow),
      debtAfterLiquidation: units(debtAfterLiquidation),
      collateralAfterLiquidation: units(collateralAfterLiquidation),
      reservesAfterLiquidation: units(reservesAfterLiquidation),
      badDebtAfterLiquidation: units(badDebtAfterLiquidation),
      badDebtWrittenOff: units(badDebtWrittenOff),
      reservesUsed: units(reservesUsed),
      supplierLoss: units(supplierLoss),
      liquidatorVoucherBalance: units(liquidatorVoucherBalance),
      poolLiquidity: units(poolLiquidity),
      destinationDebtTokenBalance: units(destinationDebtBalance),
    },
    reverse: {
      operation: "Authorized liquidator seized-voucher settlement -> Bank A escrow unlock",
      sequence: settlementSequence.toString(),
      sender: ctx.liquidatorAddress,
      recipient: ctx.sourceLiquidatorAddress,
      amount: units(liquidatorVoucherBalance),
      amountRaw: liquidatorVoucherBalance.toString(),
      packetId: settlementPacketId,
      packetLeaf: packetLeaf(settlementPacket),
      packetPath: packetPath(settlementPacket),
      packetLeafSlot: settlementProofs.leafSlot,
      packetPathSlot: settlementProofs.pathSlot,
      sourceTxHash: settlementBurnReceipt.hash,
      receiveTxHash: settlementRecvReceipt.hash,
      commitHeight: settlementCommitHeight.toString(),
      trustedHeight: settlementProofHeight.toString(),
      trustedHeaderHash: settlementHeader.headerUpdate.headerHash,
      trustedStateRoot: settlementHeader.headerUpdate.stateRoot,
      finalRecipientBalance: units(liquidatorOriginBalanceAfterSettlement),
      finalEscrowed: units(escrowAfterSettlement),
      proofMode: "storage",
      settlementMode: "authorized-liquidator",
    },
    liquidatorSettlement: {
      operation: "Authorized liquidator settles seized voucher through reverse bridge route",
      amount: units(liquidatorVoucherBalance),
      amountRaw: liquidatorVoucherBalance.toString(),
      liquidator: ctx.liquidatorAddress,
      recipient: ctx.sourceLiquidatorAddress,
      burnTxHash: settlementBurnReceipt.hash,
      unlockTxHash: settlementRecvReceipt.hash,
      packetId: settlementPacketId,
      commitHeight: settlementCommitHeight.toString(),
      finalRecipientBalance: units(liquidatorOriginBalanceAfterSettlement),
      finalEscrowed: units(escrowAfterSettlement),
    },
    denied: timeoutResult.denied,
    timeout: timeoutResult.timeout,
    security: timeoutResult.security,
    latestOperation: {
      phase: "complete",
      label: "Completed storage-proof cross-chain lending flow",
      summary:
        "Opened/reused the IBC connection and channel, verified packet proofs, ran lending valuation, liquidation, seized-voucher settlement, and timeout absence for a denied packet.",
    },
  };

  setPhase("write-trace");
  await writeTrace(trace);

  config.status = {
    ...(config.status || {}),
    proofCheckedHandshakeOpened: true,
    lastDemoRunAt: trace.generatedAt,
    lastDemoScenario: "risk-liquidation",
  };
  config.latestTrace = {
    json: OUT_JSON_PATH,
    js: OUT_JS_PATH,
  };
  await saveRuntimeConfig(config);

  console.log("=== Proof-checked banking flow ===");
  console.log(`Handshake: connection ${connectionHandshake.reused ? "reused" : "opened"}, channel ${channelHandshake.reused ? "reused" : "opened"}`);
  console.log(`[A->B] packet ${compact(approvedPacketId)} locked ${units(FORWARD_AMOUNT)} aBANK and minted voucher on Bank B`);
  console.log(`[risk] deposited ${units(collateralAfterDeposit)} vA, borrowed ${units(debtAfterBorrow)} bCASH, liquidated ${units(actualLiquidationRepay)} bCASH after price shock`);
  console.log(`[settlement] liquidator burned ${units(liquidatorVoucherBalance)} vA and unlocked origin collateral with packet ${compact(settlementPacketId)}`);
  console.log(`[timeout] denied packet ${compact(timeoutResult.denied.packetId)} refunded=${timeoutResult.denied.refundObserved}`);
  console.log(`[ui] wrote demo trace to ${OUT_JSON_PATH}`);
}
