import {
  FORWARD_AMOUNT,
  amountFromTrace,
  asBigInt,
  compact,
  ensureReversePacket,
  ensureRiskSeeded,
  isKnownReplay,
  packetLeaf,
  packetPath,
  readExistingTrace,
  requireOpenHandshake,
  reversePacket,
  setPhase,
  txOptions,
  txStep,
  units,
} from "../context.mjs";
import { writeTracePatch } from "../trace-writer.mjs";
import { buildPacketProofs } from "../proof/packet-proof-builder.mjs";
import { readReverseHeader, requireTrustedProofAnchor, trustReverseHeader } from "../proof/header-trust.mjs";

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
      0,
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
  const burnAmount = amountFromTrace(trace.forward, FORWARD_AMOUNT);
  const freeVoucher = await ctx.B.voucherAdmin.balanceOf(ctx.destinationUserAddress);
  if (freeVoucher < burnAmount) {
    throw new Error("Bank B user needs a free voucher balance before burn. Repay and withdraw collateral first.");
  }
  const sequence = asBigInt(await ctx.B.packetStore.nextSequence());
  const receipt = await txStep("step burn voucher and release", () =>
    ctx.B.transferAppAdmin.connect(ctx.destinationUser).burnAndRelease(
      sourceChainId,
      ctx.sourceUserAddress,
      burnAmount,
      0,
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
    sender: ctx.destinationUserAddress,
    recipient: ctx.sourceUserAddress,
    amount: burnAmount,
  });
  const packetIdValue = await ctx.B.packetStore.packetIdAt(sequence);
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
      },
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
  const header = await trustReverseHeader(config, ctx, destinationChainId, reverse.commitHeight);
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
  const proofAnchor = await requireTrustedProofAnchor({
    lightClient: ctx.A.lightClient,
    sourceChainId: destinationChainId,
    minimumHeight: reverse.commitHeight,
    sourceLabel: "Bank B",
    destinationLabel: "Bank A",
  });
  const proofs = await buildPacketProofs({
    provider: ctx.providerB,
    packetStoreAddress: config.chains.B.packetStore,
    packet: reverse.packet,
    sourceChainId: destinationChainId,
    trustedHeight: proofAnchor.height,
    stateRoot: proofAnchor.stateRoot,
  });
  let recvReceipt = null;
  try {
    recvReceipt = await txStep("step receive reverse packet", () =>
      ctx.A.packetHandler.recvPacketFromStorageProof(reverse.packet, proofs.leafProof, proofs.pathProof, txOptions())
    );
  } catch (error) {
    if (!isKnownReplay(error)) throw error;
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
        packetLeafSlot: proofs.leafSlot,
        packetPathSlot: proofs.pathSlot,
        receiveTxHash: recvReceipt?.hash,
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
