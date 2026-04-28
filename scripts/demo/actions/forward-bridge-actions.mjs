import { ethers } from "ethers";
import {
  DEMO_MAX_TIMEOUT_HEADER_GAP,
  DENIED_AMOUNT,
  FORWARD_AMOUNT,
  asBigInt,
  compact,
  ensureForwardPacket,
  ensureForwardPacketReceived,
  ensureRiskSeeded,
  isKnownReplay,
  isWorldStateUnavailable,
  packetLeaf,
  packetPath,
  requireOpenHandshake,
  setPhase,
  transferPacket,
  txOptions,
  txStep,
  units,
} from "../context.mjs";
import { writeTracePatch } from "../trace-writer.mjs";
import { buildAcknowledgementProof, buildPacketProofs } from "../proof/packet-proof-builder.mjs";
import {
  readForwardHeader,
  requireTrustedProofAnchor,
  trustCurrentHeaderForProof,
  trustForwardHeader,
} from "../proof/header-trust.mjs";

async function requireReasonableProofRefresh({ lightClient, provider, sourceChainId, minimumHeight, label }) {
  const [trustedHeight, latestHeight] = await Promise.all([
    lightClient.latestTrustedHeight(sourceChainId),
    provider.getBlockNumber(),
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

async function buildForwardPacketProofs({ config, ctx, sourceChainId, minimumHeight, packet }) {
  let proofAnchor = await requireTrustedProofAnchor({
    lightClient: ctx.B.lightClient,
    sourceChainId,
    minimumHeight,
    sourceLabel: "Bank A",
    destinationLabel: "Bank B",
  });
  try {
    const proofs = await buildPacketProofs({
      provider: ctx.providerA,
      packetStoreAddress: config.chains.A.packetStore,
      packet,
      sourceChainId,
      trustedHeight: proofAnchor.height,
      stateRoot: proofAnchor.stateRoot,
    });
    return { proofAnchor, proofs };
  } catch (error) {
    if (!isWorldStateUnavailable(error)) throw error;
    console.warn("[demo] Bank A proof state unavailable at trusted height; importing a fresher header and retrying packet proof.");
    await requireReasonableProofRefresh({
      lightClient: ctx.B.lightClient,
      provider: ctx.providerA,
      sourceChainId,
      minimumHeight,
      label: "Bank A packet",
    });
    const refreshed = await trustCurrentHeaderForProof({
      lightClient: ctx.B.lightClient,
      provider: ctx.providerA,
      sourceChainId,
      minimumHeight,
    });
    proofAnchor = {
      height: refreshed.height,
      headerHash: refreshed.header.headerUpdate.headerHash,
      stateRoot: refreshed.header.headerUpdate.stateRoot,
    };
    const proofs = await buildPacketProofs({
      provider: ctx.providerA,
      packetStoreAddress: config.chains.A.packetStore,
      packet,
      sourceChainId,
      trustedHeight: proofAnchor.height,
      stateRoot: proofAnchor.stateRoot,
    });
    return { proofAnchor, proofs };
  }
}

async function buildForwardAcknowledgementProof({
  config,
  ctx,
  destinationChainId,
  receiveHeight,
  packetId,
  acknowledgementHash,
}) {
  let ackAnchor = await trustCurrentHeaderForProof({
    lightClient: ctx.A.lightClient,
    provider: ctx.providerB,
    sourceChainId: destinationChainId,
    minimumHeight: receiveHeight,
  });
  try {
    const result = await buildAcknowledgementProof({
      provider: ctx.providerB,
      packetHandlerAddress: config.chains.B.packetHandler,
      packetIdValue: packetId,
      acknowledgementHash,
      sourceChainId: destinationChainId,
      trustedHeight: ackAnchor.height,
      stateRoot: ackAnchor.header.headerUpdate.stateRoot,
    });
    return { ackAnchor, ...result };
  } catch (error) {
    if (!isWorldStateUnavailable(error)) throw error;
    console.warn("[demo] Bank B acknowledgement state unavailable at trusted height; importing a fresher header and retrying acknowledgement proof.");
    await requireReasonableProofRefresh({
      lightClient: ctx.A.lightClient,
      provider: ctx.providerB,
      sourceChainId: destinationChainId,
      minimumHeight: receiveHeight,
      label: "Bank B acknowledgement",
    });
    ackAnchor = await trustCurrentHeaderForProof({
      lightClient: ctx.A.lightClient,
      provider: ctx.providerB,
      sourceChainId: destinationChainId,
      minimumHeight: receiveHeight,
    });
    const result = await buildAcknowledgementProof({
      provider: ctx.providerB,
      packetHandlerAddress: config.chains.B.packetHandler,
      packetIdValue: packetId,
      acknowledgementHash,
      sourceChainId: destinationChainId,
      trustedHeight: ackAnchor.height,
      stateRoot: ackAnchor.header.headerUpdate.stateRoot,
    });
    return { ackAnchor, ...result };
  }
}

export async function lockStep({ config, ctx, sourceChainId, destinationChainId }) {
  setPhase("step-lock-check-route");
  await requireOpenHandshake(config, ctx);
  await ensureRiskSeeded(config, ctx);
  await txStep("step approve escrow", () =>
    ctx.A.canonicalTokenUser.approve(config.chains.A.escrowVault, FORWARD_AMOUNT + DENIED_AMOUNT, txOptions())
  );

  setPhase("step-lock-send");
  const sequence = asBigInt(await ctx.A.packetStore.nextSequence());
  const receipt = await txStep("step send forward transfer", () =>
    ctx.A.transferAppUser.sendTransfer(destinationChainId, ctx.destinationUserAddress, FORWARD_AMOUNT, 0, 0, txOptions())
  );
  const commitHeight = BigInt(receipt.blockNumber);
  const packet = transferPacket({
    sequence,
    sourceChainId,
    destinationChainId,
    config,
    sender: ctx.sourceUserAddress,
    recipient: ctx.destinationUserAddress,
    amount: FORWARD_AMOUNT,
  });
  const packetIdValue = await ctx.A.packetStore.packetIdAt(sequence);
  const trace = await writeTracePatch(
    config,
    ctx,
    {
      forward: {
        operation: "Bank A escrow lock -> Bank B voucher mint",
        sequence: sequence.toString(),
        amount: units(FORWARD_AMOUNT),
        amountRaw: FORWARD_AMOUNT.toString(),
        packetId: packetIdValue,
        packetLeaf: packetLeaf(packet),
        packetPath: packetPath(packet),
        sourceTxHash: receipt.hash,
        commitHeight: commitHeight.toString(),
      },
    },
    {
      phase: "forward-locked",
      label: "Locked aBANK and committed a IBC packet",
      summary: `Bank A escrowed ${units(FORWARD_AMOUNT)} aBANK and wrote packet ${compact(packetIdValue)}.`,
    }
  );
  console.log(`Locked ${units(FORWARD_AMOUNT)} aBANK and committed packet ${packetIdValue}`);
  return trace;
}

export async function finalizeForwardHeaderStep({ config, ctx, sourceChainId, destinationChainId }) {
  setPhase("step-finalizeForwardHeader");
  const forward = await ensureForwardPacket(config, ctx, sourceChainId, destinationChainId);
  const header = await readForwardHeader(ctx, sourceChainId, forward.commitHeight);
  const trace = await writeTracePatch(
    config,
    ctx,
    {
      forward: {
        finalizedHeight: header.headerUpdate.height.toString(),
        finalizedHeaderHash: header.headerUpdate.headerHash,
        finalizedStateRoot: header.headerUpdate.stateRoot,
      },
    },
    {
      phase: "forward-header-read",
      label: "Read Bank A packet header",
      summary: `Read Bank A Besu header #${header.headerUpdate.height.toString()}; Bank B still needs a client update before proof execution.`,
    }
  );
  console.log(`Read Bank A header #${header.headerUpdate.height.toString()} for the forward packet`);
  return trace;
}

export async function updateForwardClientStep({ config, ctx, sourceChainId, destinationChainId }) {
  setPhase("step-updateForwardClient");
  const forward = await ensureForwardPacket(config, ctx, sourceChainId, destinationChainId);
  const header = await trustForwardHeader(config, ctx, sourceChainId, forward.commitHeight);
  const trace = await writeTracePatch(
    config,
    ctx,
    {
      forward: {
        trustedHeight: header.headerUpdate.height.toString(),
        trustedHeaderHash: header.headerUpdate.headerHash,
        trustedStateRoot: header.headerUpdate.stateRoot,
      },
    },
    {
      phase: "forward-header-trusted",
      label: "Updated Bank B Besu light client",
      summary: `Bank B now trusts Bank A Besu header #${header.headerUpdate.height.toString()}.`,
    }
  );
  console.log(`Trusted Bank A header #${header.headerUpdate.height.toString()} on Bank B`);
  return trace;
}

export async function proveForwardMintStep({ config, ctx, sourceChainId, destinationChainId }) {
  setPhase("step-prove-forward");
  await requireOpenHandshake(config, ctx);
  const forward = await ensureForwardPacket(config, ctx, sourceChainId, destinationChainId);
  const { proofAnchor, proofs } = await buildForwardPacketProofs({
    config,
    ctx,
    sourceChainId,
    minimumHeight: forward.commitHeight,
    packet: forward.packet,
  });

  let recvReceipt = null;
  try {
    recvReceipt = await txStep("step receive forward packet", () =>
      ctx.B.packetHandler.recvPacketFromStorageProof(forward.packet, proofs.leafProof, proofs.pathProof, txOptions())
    );
  } catch (error) {
    if (!isKnownReplay(error)) throw error;
  }

  const receiveHeight = recvReceipt ? BigInt(recvReceipt.blockNumber) : BigInt(await ctx.providerB.getBlockNumber());
  const ackHash = await ctx.B.packetHandler.acknowledgementHashes(forward.packetId);
  if (ackHash !== ethers.ZeroHash) {
    const acknowledgement = ethers.solidityPacked(["string", "bytes32"], ["ok:", forward.packetId]);
    const { ackAnchor, acknowledgementSlot, proof: ackProof } = await buildForwardAcknowledgementProof({
      config,
      ctx,
      destinationChainId,
      receiveHeight,
      packetId: forward.packetId,
      acknowledgementHash: ackHash,
    });
    try {
      await txStep("step acknowledge forward packet", () =>
        ctx.A.packetHandler.acknowledgePacketFromStorageProof(
          forward.packet,
          acknowledgement,
          config.chains.B.packetHandler,
          ackProof,
          txOptions()
        )
      );
    } catch (error) {
      if (!isKnownReplay(error)) throw error;
    }
    const voucherBalance = await ctx.B.voucherAdmin.balanceOf(ctx.destinationUserAddress);
    const sourceAckHash = await ctx.A.transferAppUser.acknowledgementHashByPacket(forward.packetId);
    const trace = await writeTracePatch(
      config,
      ctx,
      {
        forward: {
          packetLeafSlot: proofs.leafSlot,
          packetPathSlot: proofs.pathSlot,
          receiveTxHash: recvReceipt?.hash,
          receiveHeight: receiveHeight.toString(),
          trustedHeight: proofAnchor.height.toString(),
          trustedHeaderHash: proofAnchor.headerHash,
          trustedStateRoot: proofAnchor.stateRoot,
          destinationAckHash: ackHash,
          sourceAckHash,
          acknowledgementSlot,
          acknowledgementTrustedHeight: ackAnchor.height.toString(),
          voucherBalanceAfterReceive: units(voucherBalance),
          proofMode: "storage",
        },
      },
      {
        phase: "forward-proven",
        label: "Executed IBC packet storage proof",
        summary: `Bank B verified packet ${compact(forward.packetId)}, minted voucher, and Bank A verified the acknowledgement.`,
      }
    );
    console.log(`Proved and received packet ${forward.packetId}`);
    return trace;
  }
  throw new Error("Destination packet handler did not store an acknowledgement hash.");
}

export async function replayForwardStep({ config, ctx, sourceChainId, destinationChainId }) {
  setPhase("step-replay-forward");
  const forward = await ensureForwardPacketReceived(config, ctx, sourceChainId, destinationChainId);
  const { proofAnchor, proofs } = await buildForwardPacketProofs({
    config,
    ctx,
    provider: ctx.providerA,
    sourceChainId,
    minimumHeight: forward.commitHeight,
    packet: forward.packet,
  });
  try {
    await ctx.B.packetHandler.recvPacketFromStorageProof.staticCall(forward.packet, proofs.leafProof, proofs.pathProof);
    throw new Error("Replay was unexpectedly accepted by the IBC packet handler.");
  } catch (error) {
    if (!isKnownReplay(error)) throw error;
  }
  return writeTracePatch(
    config,
    ctx,
    {
      security: {
        replayBlocked: true,
        replayCheckedAt: new Date().toISOString(),
        replayProofHeight: proofAnchor.height.toString(),
      },
    },
    {
      phase: "replay-blocked",
      label: "Replay rejected by IBC packet receipt",
      summary: "The destination packet receipt prevented the same proof from executing twice.",
    }
  );
}
