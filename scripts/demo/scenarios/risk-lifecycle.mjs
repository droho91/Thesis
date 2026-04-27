import { ethers } from "ethers";
import {
  DENIED_AMOUNT,
  FORWARD_AMOUNT,
  BORROW_AMOUNT,
  LIQUIDATION_REPAY,
  OUT_JS_PATH,
  OUT_JSON_PATH,
  RUNTIME_CONFIG_PATH,
  SHOCKED_VOUCHER_PRICE_E18,
  asBigInt,
  chainId,
  compact,
  ensureDeploymentCode,
  ensureRiskSeeded,
  ensureSeededConfig,
  loadContext,
  loadRuntimeConfig,
  normalizeRuntime,
  openOrReuseHandshake,
  packetLeaf,
  packetPath,
  previewField,
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
import { executeTimeoutRefundAction } from "../actions/timeout-actions.mjs";

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
  await txStep("approve escrow spend", () =>
    ctx.A.canonicalTokenUser.approve(config.chains.A.escrowVault, FORWARD_AMOUNT + DENIED_AMOUNT, txOptions())
  );

  setPhase("send-forward-packet");
  const approvedSequence = asBigInt(await ctx.A.packetStore.nextSequence());
  const approvedSendReceipt = await txStep("send forward packet", () =>
    ctx.A.transferAppUser.sendTransfer(destinationChainId, ctx.destinationUserAddress, FORWARD_AMOUNT, 0, 0, txOptions())
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
  });
  const approvedPacketId = await ctx.A.packetStore.packetIdAt(approvedSequence);

  setPhase("trust-source-header-and-receive");
  const approvedHeader = await trustRemoteHeaderAt({
    lightClient: ctx.B.lightClient,
    provider: ctx.providerA,
    sourceChainId,
    targetHeight: approvedCommitHeight,
    validatorEpoch: 1n,
  });
  const approvedProofHeight = approvedHeader.headerUpdate.height;
  const approvedProofs = await buildPacketProofs({
    provider: ctx.providerA,
    packetStoreAddress: config.chains.A.packetStore,
    packet: approvedPacket,
    sourceChainId,
    trustedHeight: approvedProofHeight,
    stateRoot: approvedHeader.headerUpdate.stateRoot,
  });
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
  const ackHeader = await trustRemoteHeaderAt({
    lightClient: ctx.A.lightClient,
    provider: ctx.providerB,
    sourceChainId: destinationChainId,
    targetHeight: ackHeight,
    validatorEpoch: 1n,
  });
  const acknowledgementProofHeight = ackHeader.headerUpdate.height;
  const acknowledgement = ethers.solidityPacked(["string", "bytes32"], ["ok:", approvedPacketId]);
  const { acknowledgementSlot, proof: ackProof } = await buildAcknowledgementProof({
    provider: ctx.providerB,
    packetHandlerAddress: config.chains.B.packetHandler,
    packetIdValue: approvedPacketId,
    acknowledgementHash: approvedAckHash,
    sourceChainId: destinationChainId,
    trustedHeight: acknowledgementProofHeight,
    stateRoot: ackHeader.headerUpdate.stateRoot,
  });
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
  const currentCollateral = await ctx.B.lendingPoolAdmin.collateralBalance(ctx.destinationUserAddress);
  const depositDelta = FORWARD_AMOUNT > currentCollateral ? FORWARD_AMOUNT - currentCollateral : 0n;
  if (depositDelta > 0n) {
    const voucherBalance = await ctx.B.voucherAdmin.balanceOf(ctx.destinationUserAddress);
    if (voucherBalance < depositDelta) {
      throw new Error(
        `Bank B user needs ${units(depositDelta)} free voucher collateral, but only has ${units(voucherBalance)}.`
      );
    }
    await txStep("approve voucher collateral", () =>
      ctx.B.voucherUser.approve(config.chains.B.lendingPool, depositDelta, txOptions())
    );
    await txStep("deposit voucher collateral", () => ctx.B.lendingPoolUser.depositCollateral(depositDelta, txOptions()));
  }
  const maxBorrowBefore = await ctx.B.lendingPoolAdmin.maxBorrow(ctx.destinationUserAddress);
  const availableBeforeBorrow = await ctx.B.lendingPoolAdmin.availableToBorrow(ctx.destinationUserAddress);
  const debtBeforeBorrow = await ctx.B.lendingPoolAdmin.debtBalance(ctx.destinationUserAddress);
  const borrowDelta = BORROW_AMOUNT > debtBeforeBorrow ? BORROW_AMOUNT - debtBeforeBorrow : 0n;
  if (borrowDelta > 0n) {
    if (availableBeforeBorrow < borrowDelta) {
      const collateral = await ctx.B.lendingPoolAdmin.collateralBalance(ctx.destinationUserAddress);
      throw new Error(
        `BORROW_LIMIT: available ${units(availableBeforeBorrow)} bCASH, need ${units(borrowDelta)}; ` +
          `maxBorrow=${units(maxBorrowBefore)}, collateral=${units(collateral)} vA, existingDebt=${units(debtBeforeBorrow)}.`
      );
    }
    await txStep("borrow debt asset", () => ctx.B.lendingPoolUser.borrow(borrowDelta, txOptions()));
  }
  const healthBeforeShock = await ctx.B.lendingPoolAdmin.healthFactorBps(ctx.destinationUserAddress);
  const debtAfterBorrow = await ctx.B.lendingPoolAdmin.debtBalance(ctx.destinationUserAddress);
  const collateralAfterDeposit = await ctx.B.lendingPoolAdmin.collateralBalance(ctx.destinationUserAddress);

  setPhase("risk-price-shock-and-liquidate");
  await txStep("shock voucher price", () =>
    ctx.B.oracle.setPrice(config.chains.B.voucherToken, SHOCKED_VOUCHER_PRICE_E18, txOptions())
  );
  const healthAfterShock = await ctx.B.lendingPoolAdmin.healthFactorBps(ctx.destinationUserAddress);
  const liquidatableAfterShock = await ctx.B.lendingPoolAdmin.isLiquidatable(ctx.destinationUserAddress);
  const maxLiquidationRepay = await ctx.B.lendingPoolAdmin.maxLiquidationRepay(ctx.destinationUserAddress);
  const liquidationPreview = await ctx.B.lendingPoolAdmin.previewLiquidation(
    ctx.destinationUserAddress,
    LIQUIDATION_REPAY
  );
  const actualLiquidationRepay = previewField(liquidationPreview, "actualRepayAmount", 1);
  const seizedCollateralPreview = previewField(liquidationPreview, "seizedCollateral", 2);
  const reservesBeforeLiquidation = await ctx.B.lendingPoolAdmin.totalReserves();
  const badDebtBeforeLiquidation = await ctx.B.lendingPoolAdmin.totalBadDebt();
  await txStep("approve liquidation repay", () =>
    ctx.B.debtLiquidator.approve(config.chains.B.lendingPool, actualLiquidationRepay, txOptions())
  );
  const liquidationReceipt = await txStep("liquidate unhealthy position", () =>
    ctx.B.lendingPoolLiquidator.liquidate(ctx.destinationUserAddress, LIQUIDATION_REPAY, txOptions())
  );
  const debtAfterLiquidation = await ctx.B.lendingPoolAdmin.debtBalance(ctx.destinationUserAddress);
  const collateralAfterLiquidation = await ctx.B.lendingPoolAdmin.collateralBalance(ctx.destinationUserAddress);
  const reservesAfterLiquidation = await ctx.B.lendingPoolAdmin.totalReserves();
  const badDebtAfterLiquidation = await ctx.B.lendingPoolAdmin.totalBadDebt();
  const liquidatorVoucherBalance = await ctx.B.voucherAdmin.balanceOf(ctx.liquidatorAddress);
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
      0,
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
  });
  const settlementPacketId = await ctx.B.packetStore.packetIdAt(settlementSequence);
  const settlementHeader = await trustRemoteHeaderAt({
    lightClient: ctx.A.lightClient,
    provider: ctx.providerB,
    sourceChainId: destinationChainId,
    targetHeight: settlementCommitHeight,
    validatorEpoch: 1n,
  });
  const settlementProofHeight = settlementHeader.headerUpdate.height;
  const settlementProofs = await buildPacketProofs({
    provider: ctx.providerB,
    packetStoreAddress: config.chains.B.packetStore,
    packet: settlementPacket,
    sourceChainId: destinationChainId,
    trustedHeight: settlementProofHeight,
    stateRoot: settlementHeader.headerUpdate.stateRoot,
  });
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
