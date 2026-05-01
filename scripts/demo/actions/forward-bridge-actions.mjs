import { ethers } from "ethers";
import {
  DEMO_MAX_TIMEOUT_HEADER_GAP,
  DEMO_PACKET_TIMEOUT_HEIGHT,
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
  readWithRetry,
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
  trustForwardHeader,
  trustProofHeaderAt,
} from "../proof/header-trust.mjs";

const FRESH_PROOF_WAIT_TIMEOUT_MS = Number(process.env.DEMO_FRESH_PROOF_WAIT_TIMEOUT_MS || "12000");
const FRESH_PROOF_WAIT_INTERVAL_MS = Number(process.env.DEMO_FRESH_PROOF_WAIT_INTERVAL_MS || "2000");

async function timedDemoStage(label, run) {
  const startedAt = Date.now();
  console.log(`[timing] ${label} started`);
  try {
    const value = await run();
    console.log(`[timing] ${label} completed in ${Date.now() - startedAt}ms`);
    return value;
  } catch (error) {
    console.warn(`[timing] ${label} failed after ${Date.now() - startedAt}ms: ${error.shortMessage || error.message}`);
    throw error;
  }
}

function proofStateUnavailableError(label, proofHeight) {
  return new Error(
    `${label} proof state at height ${BigInt(proofHeight).toString()} is no longer available from the local Besu RPC. ` +
      "Use Resume Session to refresh the proof anchor, or run Fresh Reset if the session is too stale."
  );
}

async function requireReasonableProofRefresh({ lightClient, provider, sourceChainId, minimumHeight, label }) {
  const [trustedHeight, latestHeight] = await Promise.all([
    readWithRetry(`${label} trusted height`, () => lightClient.latestTrustedHeight(sourceChainId)),
    readWithRetry(`${label} source block`, () => provider.getBlockNumber()),
  ]);
  const trusted = BigInt(trustedHeight);
  const latest = BigInt(latestHeight);
  const required = BigInt(minimumHeight);
  console.log(`[timing] ${label} proof target=${required.toString()} trusted=${trusted.toString()} latest=${latest.toString()}`);
  if (trusted !== 0n && required > trusted + DEMO_MAX_TIMEOUT_HEADER_GAP) {
    throw new Error(
      `${label} proof target ${required.toString()} is too far ahead of trusted height ${trusted.toString()}. ` +
        "Use Resume Session to refresh the proof anchor if the gap is small, or run Fresh Reset if the session is too stale. " +
        "The demo will not catch up a large header gap during this click."
    );
  }
  if (latest < required) {
    throw new Error(`${label} source head ${latest.toString()} is below required proof height ${required.toString()}.`);
  }
}

async function waitForFreshSourceHeight({ provider, minimumHeight, label }) {
  const required = BigInt(minimumHeight);
  const startedAt = Date.now();
  while (Date.now() - startedAt <= FRESH_PROOF_WAIT_TIMEOUT_MS) {
    const latest = BigInt(await readWithRetry(`${label} fresh source block`, () => provider.getBlockNumber()));
    if (latest > required) return latest;
    await new Promise((resolveWait) => setTimeout(resolveWait, FRESH_PROOF_WAIT_INTERVAL_MS));
  }
  const latest = BigInt(await readWithRetry(`${label} latest source block`, () => provider.getBlockNumber()));
  if (latest > required) return latest;
  throw new Error(
    `${label} could not observe a fresh source block after packet height ${required.toString()} ` +
      `within ${Math.round(FRESH_PROOF_WAIT_TIMEOUT_MS / 1000)}s. Use Resume Session after the chain advances, or Fresh Reset if it stays stale.`
  );
}

async function requireBoundedFreshProofRefresh({ lightClient, provider, sourceChainId, minimumHeight, label }) {
  const [trustedHeight, latestHeight] = await Promise.all([
    readWithRetry(`${label} trusted height`, () => lightClient.latestTrustedHeight(sourceChainId)),
    waitForFreshSourceHeight({ provider, minimumHeight, label }),
  ]);
  const trusted = BigInt(trustedHeight);
  const latest = BigInt(latestHeight);
  const required = BigInt(minimumHeight);
  console.log(`[timing] ${label} fresh proof target=${latest.toString()} trusted=${trusted.toString()} minimum=${required.toString()}`);
  if (latest < required) {
    throw new Error(`${label} fresh proof height ${latest.toString()} is below required packet height ${required.toString()}.`);
  }
  if (trusted !== 0n && latest > trusted + DEMO_MAX_TIMEOUT_HEADER_GAP) {
    throw new Error(
      `${label} fresh proof target ${latest.toString()} is too far ahead of trusted height ${trusted.toString()}. ` +
        "Use Resume Session to refresh the proof anchor if the gap is small, or run Fresh Reset if the session is too stale. " +
        "The demo service heartbeat keeps this gap small while the session is active."
    );
  }
  return latest;
}

function proofAnchorFromTrustedHeader(trusted) {
  return {
    height: trusted.height,
    headerHash: trusted.header.headerUpdate.headerHash,
    stateRoot: trusted.header.headerUpdate.stateRoot,
  };
}

async function refreshProofAnchor({ lightClient, provider, sourceChainId, minimumHeight, label }) {
  const required = BigInt(minimumHeight);
  await timedDemoStage(`${label}: validate proof height`, () =>
    requireReasonableProofRefresh({ lightClient, provider, sourceChainId, minimumHeight: required, label })
  );
  const refreshed = await timedDemoStage(`${label}: trust proof header ${required.toString()}`, () =>
    trustProofHeaderAt({
      lightClient,
      provider,
      sourceChainId,
      proofHeight: required,
    })
  );
  return proofAnchorFromTrustedHeader(refreshed);
}

async function refreshFreshProofAnchor({ lightClient, provider, sourceChainId, minimumHeight, label }) {
  const freshHeight = await timedDemoStage(`${label}: select fresh proof height`, () =>
    requireBoundedFreshProofRefresh({ lightClient, provider, sourceChainId, minimumHeight, label })
  );
  const refreshed = await timedDemoStage(`${label}: trust fresh proof header ${freshHeight.toString()}`, () =>
    trustProofHeaderAt({
      lightClient,
      provider,
      sourceChainId,
      proofHeight: freshHeight,
    })
  );
  return proofAnchorFromTrustedHeader(refreshed);
}

async function buildForwardPacketProofs({ config, ctx, sourceChainId, minimumHeight, packet }) {
  setPhase("step-prove-forward-packet-proof-anchor");
  let proofAnchor = await refreshProofAnchor({
    lightClient: ctx.B.lightClient,
    provider: ctx.providerA,
    sourceChainId,
    minimumHeight,
    label: "Bank A packet",
  });
  try {
    setPhase("step-prove-forward-packet-proof-build");
    const proofs = await timedDemoStage("Bank A packet: build storage proof", () =>
      buildPacketProofs({
        provider: ctx.providerA,
        packetStoreAddress: config.chains.A.packetStore,
        packet,
        sourceChainId,
        trustedHeight: proofAnchor.height,
        stateRoot: proofAnchor.stateRoot,
      })
    );
    return { proofAnchor, proofs };
  } catch (error) {
    if (!isWorldStateUnavailable(error)) throw error;
    console.warn("[demo] Bank A proof state unavailable at packet height; trusting a fresh Bank A header and rebuilding the same packet proof.");
    proofAnchor = await refreshFreshProofAnchor({
      lightClient: ctx.B.lightClient,
      provider: ctx.providerA,
      sourceChainId,
      minimumHeight,
      label: "Bank A packet",
    });
    setPhase("step-prove-forward-packet-proof-build");
    let proofs = null;
    try {
      proofs = await timedDemoStage("Bank A packet: rebuild storage proof at fresh height", () =>
        buildPacketProofs({
          provider: ctx.providerA,
          packetStoreAddress: config.chains.A.packetStore,
          packet,
          sourceChainId,
          trustedHeight: proofAnchor.height,
          stateRoot: proofAnchor.stateRoot,
        })
      );
    } catch (retryError) {
      if (isWorldStateUnavailable(retryError)) throw proofStateUnavailableError("Bank A packet", proofAnchor.height);
      throw retryError;
    }
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
  setPhase("step-prove-forward-ack-proof-anchor");
  await timedDemoStage("Bank B acknowledgement: validate proof height", () =>
    requireReasonableProofRefresh({
      lightClient: ctx.A.lightClient,
      provider: ctx.providerB,
      sourceChainId: destinationChainId,
      minimumHeight: receiveHeight,
      label: "Bank B acknowledgement",
    })
  );
  let ackAnchor = await timedDemoStage(`Bank B acknowledgement: trust proof header ${BigInt(receiveHeight).toString()}`, () =>
    trustProofHeaderAt({
      lightClient: ctx.A.lightClient,
      provider: ctx.providerB,
      sourceChainId: destinationChainId,
      proofHeight: receiveHeight,
    })
  );
  try {
    setPhase("step-prove-forward-ack-proof-build");
    const result = await timedDemoStage("Bank B acknowledgement: build storage proof", () =>
      buildAcknowledgementProof({
        provider: ctx.providerB,
        packetHandlerAddress: config.chains.B.packetHandler,
        packetIdValue: packetId,
        acknowledgementHash,
        sourceChainId: destinationChainId,
        trustedHeight: ackAnchor.height,
        stateRoot: ackAnchor.header.headerUpdate.stateRoot,
      })
    );
    return { ackAnchor, ...result };
  } catch (error) {
    if (!isWorldStateUnavailable(error)) throw error;
    console.warn("[demo] Bank B acknowledgement state unavailable at target height; retrying the exact acknowledgement proof anchor once.");
    setPhase("step-prove-forward-ack-proof-anchor");
    await timedDemoStage("Bank B acknowledgement: revalidate proof height", () =>
      requireReasonableProofRefresh({
        lightClient: ctx.A.lightClient,
        provider: ctx.providerB,
        sourceChainId: destinationChainId,
        minimumHeight: receiveHeight,
        label: "Bank B acknowledgement",
      })
    );
    ackAnchor = await timedDemoStage(`Bank B acknowledgement: retrust proof header ${BigInt(receiveHeight).toString()}`, () =>
      trustProofHeaderAt({
        lightClient: ctx.A.lightClient,
        provider: ctx.providerB,
        sourceChainId: destinationChainId,
        proofHeight: receiveHeight,
      })
    );
    setPhase("step-prove-forward-ack-proof-build");
    let result = null;
    try {
      result = await timedDemoStage("Bank B acknowledgement: rebuild storage proof", () =>
        buildAcknowledgementProof({
          provider: ctx.providerB,
          packetHandlerAddress: config.chains.B.packetHandler,
          packetIdValue: packetId,
          acknowledgementHash,
          sourceChainId: destinationChainId,
          trustedHeight: ackAnchor.height,
          stateRoot: ackAnchor.header.headerUpdate.stateRoot,
        })
      );
    } catch (retryError) {
      if (isWorldStateUnavailable(retryError)) {
        throw proofStateUnavailableError("Bank B acknowledgement", ackAnchor.height);
      }
      throw retryError;
    }
    return { ackAnchor, ...result };
  }
}

async function writeForwardReceiveTrace({
  config,
  ctx,
  forward,
  proofAnchor,
  proofs,
  receiveHeight,
  ackHash,
  ackAnchor = null,
  acknowledgementSlot = null,
  sourceAckHash = null,
  acknowledgementWarning = null,
}) {
  setPhase("step-prove-forward-refresh");
  const voucherBalance = await ctx.B.voucherAdmin.balanceOf(ctx.destinationUserAddress);
  const acknowledged = sourceAckHash && sourceAckHash !== ethers.ZeroHash;
  const trace = await writeTracePatch(
    config,
    ctx,
    {
      forward: {
        packetLeafSlot: proofs.leafSlot,
        packetPathSlot: proofs.pathSlot,
        receiveTxHash: forward.receiveTxHash || null,
        receiveHeight: receiveHeight.toString(),
        trustedHeight: proofAnchor.height.toString(),
        trustedHeaderHash: proofAnchor.headerHash,
        trustedStateRoot: proofAnchor.stateRoot,
        destinationAckHash: ackHash,
        sourceAckHash: acknowledged ? sourceAckHash : null,
        acknowledgementSlot,
        acknowledgementTrustedHeight: ackAnchor ? ackAnchor.height.toString() : null,
        voucherBalanceAfterReceive: units(voucherBalance),
        proofMode: "storage",
      },
    },
    {
      phase: acknowledged ? "forward-proven" : "forward-received",
      label: acknowledged ? "Executed IBC packet storage proof" : "Received IBC packet storage proof",
      summary: acknowledged
        ? `Bank B verified packet ${compact(forward.packetId)}, minted voucher, and Bank A verified the acknowledgement.`
        : `Bank B verified packet ${compact(forward.packetId)} and minted voucher. ${acknowledgementWarning || "Bank A acknowledgement remains pending."}`,
    }
  );
  console.log(
    acknowledged
      ? `Proved and received packet ${forward.packetId}`
      : `Received packet ${forward.packetId}; acknowledgement proof remains pending`
  );
  return trace;
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
    ctx.A.transferAppUser.sendTransfer(
      destinationChainId,
      ctx.destinationUserAddress,
      FORWARD_AMOUNT,
      DEMO_PACKET_TIMEOUT_HEIGHT,
      0,
      txOptions()
    )
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
    timeoutHeight: DEMO_PACKET_TIMEOUT_HEIGHT,
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
        finalizedHeight: null,
        finalizedHeaderHash: null,
        finalizedStateRoot: null,
        trustedHeight: null,
        trustedHeaderHash: null,
        trustedStateRoot: null,
        packetLeafSlot: null,
        packetPathSlot: null,
        receiveTxHash: null,
        receiveHeight: null,
        destinationAckHash: null,
        sourceAckHash: null,
        acknowledgementSlot: null,
        acknowledgementTrustedHeight: null,
        voucherBalanceAfterReceive: null,
        proofMode: null,
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
  setPhase("step-prove-forward-check-route");
  await timedDemoStage("Forward receive: check open route", () => requireOpenHandshake(config, ctx));
  const forward = await timedDemoStage("Forward receive: load packet commitment", () =>
    ensureForwardPacket(config, ctx, sourceChainId, destinationChainId)
  );
  const { proofAnchor, proofs } = await buildForwardPacketProofs({
    config,
    ctx,
    sourceChainId,
    minimumHeight: forward.commitHeight,
    packet: forward.packet,
  });

  let recvReceipt = null;
  try {
    setPhase("step-prove-forward-receive-tx");
    recvReceipt = await timedDemoStage("Forward receive: submit storage proof tx", () =>
      txStep("step receive forward packet", () =>
        ctx.B.packetHandler.recvPacketFromStorageProof(forward.packet, proofs.leafProof, proofs.pathProof, txOptions())
      )
    );
  } catch (error) {
    if (!isKnownReplay(error)) {
      const receivedAfterError = await ctx.B.packetHandler.packetReceipts(forward.packetId).catch(() => false);
      if (!receivedAfterError) throw error;
      console.warn(`[demo] Forward receive transaction reported an error after the packet was received: ${error.shortMessage || error.message}`);
    }
  }

  const receiveHeight = recvReceipt ? BigInt(recvReceipt.blockNumber) : BigInt(await ctx.providerB.getBlockNumber());
  forward.receiveTxHash = recvReceipt?.hash || null;
  const ackHash = await ctx.B.packetHandler.acknowledgementHashes(forward.packetId);
  if (ackHash !== ethers.ZeroHash) {
    const acknowledgement = ethers.solidityPacked(["string", "bytes32"], ["ok:", forward.packetId]);
    let ackAnchor = null;
    let acknowledgementSlot = null;
    try {
      const ackProofResult = await buildForwardAcknowledgementProof({
        config,
        ctx,
        destinationChainId,
        receiveHeight,
        packetId: forward.packetId,
        acknowledgementHash: ackHash,
      });
      ackAnchor = ackProofResult.ackAnchor;
      acknowledgementSlot = ackProofResult.acknowledgementSlot;
      setPhase("step-prove-forward-ack-tx");
      await timedDemoStage("Forward receive: submit acknowledgement proof tx", () =>
        txStep("step acknowledge forward packet", () =>
          ctx.A.packetHandler.acknowledgePacketFromStorageProof(
            forward.packet,
            acknowledgement,
            config.chains.B.packetHandler,
            ackProofResult.proof,
            txOptions()
          )
        )
      );
    } catch (error) {
      const sourceAcknowledged = await ctx.A.packetHandler.packetAcknowledgements(forward.packetId).catch(() => false);
      if (!isKnownReplay(error) && !sourceAcknowledged) {
        const received = await ctx.B.packetHandler.packetReceipts(forward.packetId).catch(() => false);
        if (!received) throw error;
        const warning = `Bank A acknowledgement proof was deferred after: ${error.shortMessage || error.message}`;
        console.warn(`[demo] ${warning}`);
        return writeForwardReceiveTrace({
          config,
          ctx,
          forward,
          proofAnchor,
          proofs,
          receiveHeight,
          ackHash,
          ackAnchor,
          acknowledgementSlot,
          acknowledgementWarning: warning,
        });
      }
    }
    const sourceAckHash = await ctx.A.transferAppUser.acknowledgementHashByPacket(forward.packetId);
    return writeForwardReceiveTrace({
      config,
      ctx,
      forward,
      proofAnchor,
      proofs,
      receiveHeight,
      ackHash,
      ackAnchor,
      acknowledgementSlot,
      sourceAckHash,
    });
  }
  throw new Error("Destination packet handler did not store an acknowledgement hash.");
}

export async function replayForwardStep({ config, ctx, sourceChainId, destinationChainId }) {
  setPhase("step-replay-forward");
  const forward = await ensureForwardPacketReceived(config, ctx, sourceChainId, destinationChainId);
  const { proofAnchor, proofs } = await buildForwardPacketProofs({
    config,
    ctx,
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
        explicitReplayAttackRejected: true,
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
