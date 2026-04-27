import {
  DEMO_MAX_TIMEOUT_HEADER_GAP,
  DENIED_AMOUNT,
  asBigInt,
  compact,
  ensureRiskSeeded,
  openOrReuseHandshake,
  packetLeaf,
  packetPath,
  setPhase,
  shortError,
  transferPacket,
  txOptions,
  txStep,
  units,
} from "../context.mjs";
import { writeTracePatch } from "../trace-writer.mjs";
import { buildPacketProofs } from "../proof/packet-proof-builder.mjs";
import { buildReceiptAbsenceProof } from "../proof/receipt-absence-proof-builder.mjs";
import { trustRemoteHeaderAt } from "../proof/header-trust.mjs";

export async function executeTimeoutRefundAction(config, ctx, sourceChainId, destinationChainId, options = {}) {
  const phasePrefix = options.phasePrefix || "";
  const labelPrefix = options.labelPrefix || "";
  const phase = (name) => setPhase(`${phasePrefix}${name}`);
  const ensureDemoFriendlyHeaderGap = async ({ lightClient, chainIdValue, targetHeight, label }) => {
    const trustedHeight = BigInt(await lightClient.latestTrustedHeight(chainIdValue));
    const target = BigInt(targetHeight);
    if (trustedHeight !== 0n && target > trustedHeight + DEMO_MAX_TIMEOUT_HEADER_GAP) {
      throw new Error(
        `${label} trusted height is too far behind for the single-click timeout demo ` +
          `(trusted=${trustedHeight.toString()}, target=${target.toString()}). ` +
          "Run Fresh Reset or the full lifecycle from a clean seeded state."
      );
    }
  };

  phase("prepare-timeout-route");
  if (options.ensureSeeded !== false) {
    await ensureRiskSeeded(config, ctx);
  }
  await openOrReuseHandshake(config, ctx);

  phase("send-denied-packet");
  const sourceBalanceBefore = await ctx.A.canonicalTokenAdmin.balanceOf(ctx.sourceUserAddress);
  const escrowBefore = await ctx.A.escrow.totalEscrowed();
  if (sourceBalanceBefore < DENIED_AMOUNT) {
    throw new Error(
      `Source user needs ${units(DENIED_AMOUNT)} aBANK for the timeout demo, but only has ${units(sourceBalanceBefore)}.`
    );
  }
  const escrowAllowance = await ctx.A.canonicalTokenUser.allowance(ctx.sourceUserAddress, config.chains.A.escrowVault);
  if (escrowAllowance < DENIED_AMOUNT) {
    await txStep(`${labelPrefix}approve escrow for denied packet`, () =>
      ctx.A.canonicalTokenUser.approve(config.chains.A.escrowVault, DENIED_AMOUNT, txOptions())
    );
  }
  await txStep(`${labelPrefix}block destination user`, () =>
    ctx.B.policy.setAccountAllowed(ctx.destinationUserAddress, false, txOptions())
  );

  let restoredDestinationUser = false;
  try {
    const deniedTimeoutHeight = BigInt(await ctx.providerB.getBlockNumber());
    const deniedSequence = asBigInt(await ctx.A.packetStore.nextSequence());
    const deniedSendReceipt = await txStep(`${labelPrefix}send denied packet`, () =>
      ctx.A.transferAppUser.sendTransfer(
        destinationChainId,
        ctx.destinationUserAddress,
        DENIED_AMOUNT,
        deniedTimeoutHeight,
        0,
        txOptions()
      )
    );
    const deniedCommitHeight = BigInt(deniedSendReceipt.blockNumber);
    const deniedPacket = transferPacket({
      sequence: deniedSequence,
      sourceChainId,
      destinationChainId,
      config,
      sender: ctx.sourceUserAddress,
      recipient: ctx.destinationUserAddress,
      amount: DENIED_AMOUNT,
      timeoutHeight: deniedTimeoutHeight,
    });
    const deniedPacketId = await ctx.A.packetStore.packetIdAt(deniedSequence);
    const sourceBalanceAfterSend = await ctx.A.canonicalTokenAdmin.balanceOf(ctx.sourceUserAddress);
    const escrowAfterSend = await ctx.A.escrow.totalEscrowed();

    phase("prove-denied-packet");
    await ensureDemoFriendlyHeaderGap({
      lightClient: ctx.B.lightClient,
      chainIdValue: sourceChainId,
      targetHeight: deniedCommitHeight,
      label: "Bank B light client for Bank A",
    });
    const deniedHeader = await trustRemoteHeaderAt({
      lightClient: ctx.B.lightClient,
      provider: ctx.providerA,
      sourceChainId,
      targetHeight: deniedCommitHeight,
      validatorEpoch: 1n,
    });
    const deniedProofHeight = deniedHeader.headerUpdate.height;
    const deniedProofs = await buildPacketProofs({
      provider: ctx.providerA,
      packetStoreAddress: config.chains.A.packetStore,
      packet: deniedPacket,
      sourceChainId,
      trustedHeight: deniedProofHeight,
      stateRoot: deniedHeader.headerUpdate.stateRoot,
    });

    phase("confirm-denied-receive");
    let deniedReason = "unknown";
    let deniedRejected = false;
    try {
      await ctx.B.packetHandler.recvPacketFromStorageProof.staticCall(
        deniedPacket,
        deniedProofs.leafProof,
        deniedProofs.pathProof
      );
    } catch (error) {
      deniedRejected = true;
      deniedReason = shortError(error);
    }
    if (!deniedRejected) {
      throw new Error("Denied packet unexpectedly succeeded.");
    }

    phase("timeout-denied-packet");
    await ensureDemoFriendlyHeaderGap({
      lightClient: ctx.A.lightClient,
      chainIdValue: destinationChainId,
      targetHeight: deniedTimeoutHeight,
      label: "Bank A light client for Bank B",
    });
    const timeoutHeader = await trustRemoteHeaderAt({
      lightClient: ctx.A.lightClient,
      provider: ctx.providerB,
      sourceChainId: destinationChainId,
      targetHeight: deniedTimeoutHeight,
      validatorEpoch: 1n,
    });
    const timeoutProofHeight = timeoutHeader.headerUpdate.height;
    const { receiptSlot, proof: deniedReceiptAbsenceProof } = await buildReceiptAbsenceProof({
      provider: ctx.providerB,
      packetHandlerAddress: config.chains.B.packetHandler,
      packetIdValue: deniedPacketId,
      sourceChainId: destinationChainId,
      trustedHeight: timeoutProofHeight,
      stateRoot: timeoutHeader.headerUpdate.stateRoot,
    });
    const timeoutReceipt = await txStep(`${labelPrefix}timeout denied packet`, () =>
      ctx.A.packetHandler.timeoutPacketFromStorageProof(
        deniedPacket,
        config.chains.B.packetHandler,
        deniedReceiptAbsenceProof,
        txOptions()
      )
    );

    await txStep(`${labelPrefix}restore destination user`, () =>
      ctx.B.policy.setAccountAllowed(ctx.destinationUserAddress, true, txOptions())
    );
    restoredDestinationUser = true;

    phase("verify-timeout-refund");
    const [deniedTimedOut, deniedRefundFlag, finalSourceBalance, finalEscrowed] = await Promise.all([
      ctx.A.packetHandler.packetTimeouts(deniedPacketId),
      ctx.A.transferAppUser.timedOutPacket(deniedPacketId),
      ctx.A.canonicalTokenAdmin.balanceOf(ctx.sourceUserAddress),
      ctx.A.escrow.totalEscrowed(),
    ]);

    if (!deniedTimedOut) {
      throw new Error(`Timeout transaction ${timeoutReceipt.hash} succeeded, but packetTimeouts(${deniedPacketId}) is false.`);
    }
    if (!deniedRefundFlag) {
      throw new Error(`Timeout transaction ${timeoutReceipt.hash} succeeded, but the transfer app did not record the refund.`);
    }
    if (sourceBalanceAfterSend !== sourceBalanceBefore - DENIED_AMOUNT) {
      throw new Error("Denied packet send did not lock the expected source-user balance before timeout.");
    }
    if (escrowAfterSend !== escrowBefore + DENIED_AMOUNT) {
      throw new Error("Denied packet send did not increase escrow by the expected amount before timeout.");
    }
    if (finalSourceBalance !== sourceBalanceBefore) {
      throw new Error("Timeout refund did not restore the source-user balance to its pre-denied-packet value.");
    }
    if (finalEscrowed !== escrowBefore) {
      throw new Error("Timeout refund did not restore escrow to its pre-denied-packet value.");
    }

    return {
      denied: {
        operation: "Policy denial on Bank B plus timeout refund on Bank A",
        sequence: deniedSequence.toString(),
        amount: units(DENIED_AMOUNT),
        packetId: deniedPacketId,
        packetLeaf: packetLeaf(deniedPacket),
        packetPath: packetPath(deniedPacket),
        packetLeafSlot: deniedProofs.leafSlot,
        packetPathSlot: deniedProofs.pathSlot,
        commitHeight: deniedCommitHeight.toString(),
        trustedHeight: deniedProofHeight.toString(),
        trustedHeaderHash: deniedHeader.headerUpdate.headerHash,
        trustedStateRoot: deniedHeader.headerUpdate.stateRoot,
        timeoutHeight: deniedTimeoutHeight.toString(),
        deniedReason,
        timedOut: deniedTimedOut,
        refundObserved: deniedRefundFlag,
        timeoutTxHash: timeoutReceipt.hash,
        finalSourceBalance: units(finalSourceBalance),
        finalEscrowed: units(finalEscrowed),
      },
      timeout: {
        trustedHeight: timeoutProofHeight.toString(),
        trustedHeaderHash: timeoutHeader.headerUpdate.headerHash,
        trustedStateRoot: timeoutHeader.headerUpdate.stateRoot,
        receiptStorageKey: receiptSlot,
      },
      security: {
        timeoutAbsenceImplemented: true,
        timeoutAbsence: {
          kind: "receipt-absence-proof",
          status: "Script-assisted, on-chain verified",
          packetId: deniedPacketId,
          receiptSlot,
          trustedHeight: timeoutProofHeight.toString(),
          timeoutTxHash: timeoutReceipt.hash,
          refundObserved: deniedRefundFlag,
          timedOut: deniedTimedOut,
        },
      },
    };
  } finally {
    if (!restoredDestinationUser) {
      try {
        await txStep(`${labelPrefix}restore destination user`, () =>
          ctx.B.policy.setAccountAllowed(ctx.destinationUserAddress, true, txOptions())
        );
      } catch (error) {
        console.error(`[demo] failed to restore destination user after timeout path: ${shortError(error)}`);
      }
    }
  }
}

export async function executeTimeoutRefundStep({ config, ctx, sourceChainId, destinationChainId }) {
  const timeoutResult = await executeTimeoutRefundAction(config, ctx, sourceChainId, destinationChainId, {
    phasePrefix: "step-",
    labelPrefix: "step ",
  });
  return writeTracePatch(
    config,
    ctx,
    {
      denied: timeoutResult.denied,
      timeout: timeoutResult.timeout,
      security: timeoutResult.security,
    },
    {
      phase: "timeout-refunded",
      label: "Timeout refund executed",
      summary:
        `Bank A verified receipt absence for denied packet ${compact(timeoutResult.denied.packetId)} and refunded the source user.`,
    }
  );
}

export async function verifyTimeoutAbsenceStep({ config, ctx }) {
  return writeTracePatch(
    config,
    ctx,
    {
      security: {
        timeoutAbsenceImplemented: true,
        timeoutAbsence: {
          kind: "receipt-absence-proof",
          status: "Legacy/debug marker",
          note:
            "Legacy/debug marker only. The main timeout path is executeTimeoutRefund, which submits a receipt absence proof and records timeout/refund state on-chain.",
        },
      },
    },
    {
      phase: "legacy-timeout-marker",
      label: "Legacy timeout explanation marker",
      summary:
        "Legacy/debug marker only; use executeTimeoutRefund for the script-assisted, on-chain verified timeout refund path.",
    }
  );
}
