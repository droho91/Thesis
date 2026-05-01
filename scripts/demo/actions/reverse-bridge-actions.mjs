import {
  DEMO_MAX_TIMEOUT_HEADER_GAP,
  DEMO_PACKET_TIMEOUT_HEIGHT,
  asBigInt,
  compact,
  ensureReversePacket,
  ensureRiskSeeded,
  isKnownReplay,
  isWorldStateUnavailable,
  packetLeaf,
  packetPath,
  readExistingTrace,
  readWithRetry,
  requireOpenHandshake,
  requireTrustedProofAnchor,
  reversePacket,
  setPhase,
  txOptions,
  txStep,
  units,
} from "../context.mjs";
import { writeTracePatch } from "../trace-writer.mjs";
import { buildPacketProofs } from "../proof/packet-proof-builder.mjs";
import { readReverseHeader, trustCurrentHeaderForProof, trustReverseHeader } from "../proof/header-trust.mjs";

async function latestTrustedAnchor(lightClient, sourceChainId) {
  const height = BigInt(await lightClient.latestTrustedHeight(sourceChainId));
  if (height === 0n) return null;
  const header = await lightClient.trustedHeader(sourceChainId, height);
  if (!header.exists) return null;
  return {
    height,
    headerHash: header.headerHash,
    stateRoot: header.stateRoot,
  };
}

async function requireReasonableProofRefresh({ lightClient, provider, sourceChainId, minimumHeight, label }) {
  const [trustedHeight, latestHeight] = await Promise.all([
    readWithRetry(`${label} trusted height`, () => lightClient.latestTrustedHeight(sourceChainId)),
    readWithRetry(`${label} source block`, () => provider.getBlockNumber()),
  ]);
  const trusted = BigInt(trustedHeight);
  const latest = BigInt(latestHeight);
  if (trusted !== 0n && latest > trusted + DEMO_MAX_TIMEOUT_HEADER_GAP) {
    throw new Error(
      `${label} proof state is unavailable at trusted height ${trusted.toString()}, and refreshing to latest ` +
        `${latest.toString()} would require a large header catch-up. Run Fresh Reset or rerun the guided lifecycle from a clean seeded state.`
    );
  }
  if (latest < BigInt(minimumHeight)) {
    throw new Error(`${label} source head ${latest.toString()} is below required proof height ${BigInt(minimumHeight).toString()}.`);
  }
}

async function refreshProofAnchor({ lightClient, provider, sourceChainId, minimumHeight, label }) {
  await requireReasonableProofRefresh({ lightClient, provider, sourceChainId, minimumHeight, label });
  const refreshed = await trustCurrentHeaderForProof({
    lightClient,
    provider,
    sourceChainId,
    minimumHeight,
  });
  return {
    height: refreshed.height,
    headerHash: refreshed.header.headerUpdate.headerHash,
    stateRoot: refreshed.header.headerUpdate.stateRoot,
  };
}

async function buildReversePacketProofs({ config, ctx, destinationChainId, minimumHeight, packet }) {
  let proofAnchor = await requireTrustedProofAnchor({
    lightClient: ctx.A.lightClient,
    sourceChainId: destinationChainId,
    minimumHeight,
    sourceLabel: "Bank B",
    destinationLabel: "Bank A",
  });
  try {
    const proofs = await buildPacketProofs({
      provider: ctx.providerB,
      packetStoreAddress: config.chains.B.packetStore,
      packet,
      sourceChainId: destinationChainId,
      trustedHeight: proofAnchor.height,
      stateRoot: proofAnchor.stateRoot,
    });
    return { proofAnchor, proofs };
  } catch (error) {
    if (!isWorldStateUnavailable(error)) throw error;
    console.warn("[demo] Bank B proof state unavailable at trusted height; importing a fresher header and retrying reverse packet proof.");
    proofAnchor = await refreshProofAnchor({
      lightClient: ctx.A.lightClient,
      provider: ctx.providerB,
      sourceChainId: destinationChainId,
      minimumHeight,
      label: "Bank B reverse packet",
    });
    const proofs = await buildPacketProofs({
      provider: ctx.providerB,
      packetStoreAddress: config.chains.B.packetStore,
      packet,
      sourceChainId: destinationChainId,
      trustedHeight: proofAnchor.height,
      stateRoot: proofAnchor.stateRoot,
    });
    return { proofAnchor, proofs };
  }
}

export async function settleSeizedVoucherStep({ config, ctx, sourceChainId, destinationChainId }) {
  setPhase("step-settle-seized-voucher");
  await requireOpenHandshake(config, ctx);
  await ensureRiskSeeded(config, ctx);

  const liquidatorVoucherBalance = await ctx.B.voucherAdmin.balanceOf(ctx.liquidatorAddress);
  if (liquidatorVoucherBalance === 0n) {
    throw new Error("The authorized liquidator has no seized voucher balance. Run Execute Liquidation first.");
  }

  const sequence = asBigInt(await ctx.B.packetStore.nextSequence());
  const receipt = await txStep("step settle seized voucher", () =>
    ctx.B.transferAppLiquidator.settleSeizedVoucher(
      sourceChainId,
      ctx.sourceLiquidatorAddress,
      liquidatorVoucherBalance,
      DEMO_PACKET_TIMEOUT_HEIGHT,
      0,
      txOptions()
    )
  );
  const commitHeight = BigInt(receipt.blockNumber);
  const packet = reversePacket({
    sequence,
    sourceChainId: destinationChainId,
    destinationChainId: sourceChainId,
    config,
    sender: ctx.liquidatorAddress,
    recipient: ctx.sourceLiquidatorAddress,
    amount: liquidatorVoucherBalance,
    timeoutHeight: DEMO_PACKET_TIMEOUT_HEIGHT,
  });
  const packetIdValue = await ctx.B.packetStore.packetIdAt(sequence);

  return writeTracePatch(
    config,
    ctx,
    {
      reverse: {
        operation: "Authorized liquidator seized-voucher settlement -> Bank A escrow unlock",
        sequence: sequence.toString(),
        sender: ctx.liquidatorAddress,
        recipient: ctx.sourceLiquidatorAddress,
        amount: units(liquidatorVoucherBalance),
        amountRaw: liquidatorVoucherBalance.toString(),
        packetId: packetIdValue,
        packetLeaf: packetLeaf(packet),
        packetPath: packetPath(packet),
        sourceTxHash: receipt.hash,
        commitHeight: commitHeight.toString(),
        settlementMode: "authorized-liquidator",
        finalizedHeight: null,
        finalizedHeaderHash: null,
        finalizedStateRoot: null,
        trustedHeight: null,
        trustedHeaderHash: null,
        trustedStateRoot: null,
        packetLeafSlot: null,
        packetPathSlot: null,
        receiveTxHash: null,
        finalSourceBalance: null,
        finalRecipientBalance: null,
        finalEscrowed: null,
        proofMode: null,
      },
      liquidatorSettlement: {
        operation: "Authorized liquidator settles seized voucher through reverse bridge route",
        amount: units(liquidatorVoucherBalance),
        amountRaw: liquidatorVoucherBalance.toString(),
        liquidator: ctx.liquidatorAddress,
        recipient: ctx.sourceLiquidatorAddress,
        burnTxHash: receipt.hash,
        packetId: packetIdValue,
        commitHeight: commitHeight.toString(),
        unlockTxHash: null,
      },
    },
    {
      phase: "seized-voucher-settlement-committed",
      label: "Committed seized-voucher settlement packet",
      summary:
        `Authorized liquidator burned ${units(liquidatorVoucherBalance)} vA and wrote reverse packet ` +
        `${compact(packetIdValue)} for Bank A settlement.`,
    }
  );
}

export async function burnStep({ config, ctx, sourceChainId, destinationChainId }) {
  setPhase("step-burn");
  await requireOpenHandshake(config, ctx);
  const trace = await readExistingTrace();
  const pendingReversePacket = trace.reverse?.packetId
    ? !(await ctx.A.packetHandler.packetReceipts(trace.reverse.packetId).catch(() => Boolean(trace.reverse?.receiveTxHash)))
    : false;
  if (pendingReversePacket) {
    throw new Error("A reverse packet is already pending. Verify the reverse proof next.");
  }

  const [freeVoucher, activeDebt, activeCollateral, sourceEscrow] = await Promise.all([
    ctx.B.voucherAdmin.balanceOf(ctx.destinationUserAddress),
    ctx.B.lendingPoolAdmin.debtBalance(ctx.destinationUserAddress),
    ctx.B.lendingPoolAdmin.collateralBalance(ctx.destinationUserAddress),
    ctx.A.escrow.totalEscrowed(),
  ]);
  if (activeDebt > 0n) throw new Error("Repay all debt first.");
  if (activeCollateral > 0n) throw new Error("Withdraw collateral from the lending pool first.");
  if (freeVoucher === 0n) {
    throw new Error("Bank B user needs a free voucher balance before burn. Repay and withdraw collateral first.");
  }
  if (sourceEscrow < freeVoucher) {
    throw new Error(
      `Bank A escrow ${units(sourceEscrow)} aBANK is lower than the requested voucher burn ${units(freeVoucher)} vA. ` +
        "Do not burn more voucher than source escrow can unlock."
    );
  }

  const burnAmount = freeVoucher;
  const sequence = asBigInt(await ctx.B.packetStore.nextSequence());
  const receipt = await txStep("step burn voucher and release", () =>
    ctx.B.transferAppAdmin.connect(ctx.destinationUser).burnAndRelease(
      sourceChainId,
      ctx.sourceUserAddress,
      burnAmount,
      DEMO_PACKET_TIMEOUT_HEIGHT,
      0,
      txOptions()
    )
  );
  const [voucherAfter, nextSequenceAfter] = await Promise.all([
    ctx.B.voucherAdmin.balanceOf(ctx.destinationUserAddress),
    ctx.B.packetStore.nextSequence(),
  ]);
  if (voucherAfter + burnAmount !== freeVoucher) {
    throw new Error("Voucher burn accounting mismatch after Bank B burn.");
  }
  if (asBigInt(nextSequenceAfter) !== sequence + 1n) {
    throw new Error("Reverse packet sequence did not advance as expected after voucher burn.");
  }
  const commitHeight = BigInt(receipt.blockNumber);
  const packet = reversePacket({
    sequence,
    sourceChainId: destinationChainId,
    destinationChainId: sourceChainId,
    config,
    sender: ctx.destinationUserAddress,
    recipient: ctx.sourceUserAddress,
    amount: burnAmount,
    timeoutHeight: DEMO_PACKET_TIMEOUT_HEIGHT,
  });
  const packetIdValue = await ctx.B.packetStore.packetIdAt(sequence);
  const committed = await ctx.B.packetStore.committedPacket(packetIdValue);
  if (!committed) {
    throw new Error("Reverse packet commitment was not recorded on Bank B after voucher burn.");
  }
  return writeTracePatch(
    config,
    ctx,
    {
      reverse: {
        operation: "Bank B voucher burn -> Bank A escrow unlock",
        sequence: sequence.toString(),
        sender: ctx.destinationUserAddress,
        recipient: ctx.sourceUserAddress,
        amount: units(burnAmount),
        amountRaw: burnAmount.toString(),
        packetId: packetIdValue,
        packetLeaf: packetLeaf(packet),
        packetPath: packetPath(packet),
        sourceTxHash: receipt.hash,
        commitHeight: commitHeight.toString(),
        settlementMode: null,
        finalizedHeight: null,
        finalizedHeaderHash: null,
        finalizedStateRoot: null,
        trustedHeight: null,
        trustedHeaderHash: null,
        trustedStateRoot: null,
        packetLeafSlot: null,
        packetPathSlot: null,
        receiveTxHash: null,
        finalSourceBalance: null,
        finalRecipientBalance: null,
        finalEscrowed: null,
        proofMode: null,
      },
      liquidatorSettlement: null,
    },
    {
      phase: "reverse-burned",
      label: "Burned voucher and committed reverse packet",
      summary: `Bank B burned ${units(burnAmount)} vA and wrote packet ${compact(packetIdValue)}.`,
    }
  );
}

export async function finalizeReverseHeaderStep({ config, ctx, sourceChainId, destinationChainId }) {
  setPhase("step-finalizeReverseHeader");
  const reverse = await ensureReversePacket(config, ctx, sourceChainId, destinationChainId);
  const header = await readReverseHeader(ctx, destinationChainId, reverse.commitHeight);
  return writeTracePatch(
    config,
    ctx,
    {
      reverse: {
        finalizedHeight: header.headerUpdate.height.toString(),
        finalizedHeaderHash: header.headerUpdate.headerHash,
        finalizedStateRoot: header.headerUpdate.stateRoot,
      },
    },
    {
      phase: "reverse-header-read",
      label: "Read Bank B packet header",
      summary: `Read Bank B Besu header #${header.headerUpdate.height.toString()}; Bank A still needs a client update before proof execution.`,
    }
  );
}

export async function updateReverseClientStep({ config, ctx, sourceChainId, destinationChainId }) {
  setPhase("step-updateReverseClient");
  const reverse = await ensureReversePacket(config, ctx, sourceChainId, destinationChainId);
  const before = await latestTrustedAnchor(ctx.A.lightClient, destinationChainId);
  let header = null;
  try {
    header = await trustReverseHeader(config, ctx, destinationChainId, reverse.commitHeight);
  } catch (error) {
    const after = await latestTrustedAnchor(ctx.A.lightClient, destinationChainId).catch(() => null);
    const progressed =
      after &&
      (!before || after.height > before.height) &&
      after.height < BigInt(reverse.commitHeight);
    if (!progressed) throw error;

    return writeTracePatch(
      config,
      ctx,
      {
        reverse: {
          trustedHeight: after.height.toString(),
          trustedHeaderHash: after.headerHash,
          trustedStateRoot: after.stateRoot,
        },
      },
      {
        phase: "reverse-header-partial",
        label: "Partially updated Bank A Besu light client",
        summary:
          `Bank A now trusts Bank B Besu header #${after.height.toString()} and still needs ` +
          `header #${BigInt(reverse.commitHeight).toString()} before reverse proof execution. Retry Sync Trust on Bank A.`,
      }
    );
  }
  return writeTracePatch(
    config,
    ctx,
    {
      reverse: {
        trustedHeight: header.headerUpdate.height.toString(),
        trustedHeaderHash: header.headerUpdate.headerHash,
        trustedStateRoot: header.headerUpdate.stateRoot,
      },
    },
    {
      phase: "reverse-header-trusted",
      label: "Updated Bank A Besu light client",
      summary: `Bank A now trusts Bank B Besu header #${header.headerUpdate.height.toString()}.`,
    }
  );
}

export async function proveReverseUnlockStep({ config, ctx, sourceChainId, destinationChainId }) {
  setPhase("step-prove-reverse");
  await requireOpenHandshake(config, ctx);
  const reverse = await ensureReversePacket(config, ctx, sourceChainId, destinationChainId);
  let proofAnchor = null;
  let proofs = null;
  let recvReceipt = null;

  const receivedBefore = await readWithRetry("Bank A reverse packet receipt", () =>
    ctx.A.packetHandler.packetReceipts(reverse.packetId)
  ).catch(() => false);

  if (receivedBefore) {
    proofAnchor = await requireTrustedProofAnchor({
      lightClient: ctx.A.lightClient,
      sourceChainId: destinationChainId,
      minimumHeight: reverse.commitHeight,
      sourceLabel: "Bank B",
      destinationLabel: "Bank A",
    });
  } else {
    ({ proofAnchor, proofs } = await buildReversePacketProofs({
      config,
      ctx,
      destinationChainId,
      minimumHeight: reverse.commitHeight,
      packet: reverse.packet,
    }));
    try {
      recvReceipt = await txStep("step receive reverse packet", () =>
        ctx.A.packetHandler.recvPacketFromStorageProof(reverse.packet, proofs.leafProof, proofs.pathProof, txOptions())
      );
    } catch (error) {
      const receivedAfterError = await ctx.A.packetHandler.packetReceipts(reverse.packetId).catch(() => false);
      if (!isKnownReplay(error) && !receivedAfterError) throw error;
    }
  }
  const [finalSourceBalance, finalRecipientBalance] = await Promise.all([
    ctx.A.canonicalTokenAdmin.balanceOf(ctx.sourceUserAddress),
    ctx.A.canonicalTokenAdmin.balanceOf(reverse.recipient),
  ]);
  const finalEscrowed = await ctx.A.escrow.totalEscrowed();
  return writeTracePatch(
    config,
    ctx,
    {
      reverse: {
        packetLeafSlot: proofs?.leafSlot ?? reverse.trace?.reverse?.packetLeafSlot,
        packetPathSlot: proofs?.pathSlot ?? reverse.trace?.reverse?.packetPathSlot,
        receiveTxHash: recvReceipt?.hash ?? reverse.trace?.reverse?.receiveTxHash,
        trustedHeight: proofAnchor.height.toString(),
        trustedHeaderHash: proofAnchor.headerHash,
        trustedStateRoot: proofAnchor.stateRoot,
        finalSourceBalance: units(finalSourceBalance),
        finalRecipientBalance: units(finalRecipientBalance),
        finalEscrowed: units(finalEscrowed),
        proofMode: "storage",
      },
      ...(reverse.trace?.liquidatorSettlement
        ? {
          liquidatorSettlement: {
            unlockTxHash: recvReceipt?.hash,
            finalRecipientBalance: units(finalRecipientBalance),
            finalEscrowed: units(finalEscrowed),
          },
        }
        : {}),
    },
    {
      phase: "reverse-proven",
      label: "Executed reverse packet storage proof",
      summary: `Bank A verified packet ${compact(reverse.packetId)} and unlocked escrow for ${compact(reverse.recipient)}.`,
    }
  );
}
