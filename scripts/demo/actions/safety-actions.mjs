import { ethers } from "ethers";
import {
  buildBesuHeaderUpdate,
  buildConflictingBesuHeaderUpdate,
  setPhase,
  shortError,
  trustForwardHeader,
  trustedAnchorFromHeader,
  txOptions,
  txStep,
} from "../context.mjs";
import { writeTracePatch } from "../trace-writer.mjs";

export async function freezeClientStep({ config, ctx, sourceChainId, destinationChainId }) {
  setPhase("step-freeze-client");
  const existingStatus = Number(await ctx.B.lightClient.status(sourceChainId));
  if (existingStatus === 2) {
    const evidence = await ctx.B.lightClient.frozenEvidence(sourceChainId);
    return writeTracePatch(
      config,
      ctx,
      {
        misbehaviour: {
          frozen: true,
          recovered: false,
          sourceChainId: sourceChainId.toString(),
          destinationChainId: destinationChainId.toString(),
          height: evidence.height.toString(),
          trustedHeaderHash: evidence.trustedHeaderHash,
          conflictingHeaderHash: evidence.conflictingHeaderHash,
          evidenceHash: evidence.evidenceHash,
          detectedAt: evidence.detectedAt.toString(),
        },
        security: {
          frozen: true,
        },
      },
      {
        phase: "client-frozen",
        label: "Submitted conflicting native Besu header",
        summary: `Bank B already has Bank A frozen at height ${evidence.height.toString()}.`,
      }
    );
  }

  let trustedHeight = BigInt(await ctx.B.lightClient.latestTrustedHeight(sourceChainId));
  if (trustedHeight === 0n) {
    trustedHeight = BigInt(await ctx.providerA.getBlockNumber());
    if (trustedHeight === 0n) {
      throw new Error("Bank A has not produced any non-genesis blocks yet, so there is no header to trust or freeze.");
    }
    await trustForwardHeader(config, ctx, sourceChainId, trustedHeight);
  }

  const trustedHeader = await ctx.B.lightClient.trustedHeader(sourceChainId, trustedHeight);
  if (!trustedHeader.exists) {
    throw new Error(`Bank B does not yet trust a Bank A header at height ${trustedHeight.toString()}.`);
  }

  const conflict = await buildConflictingBesuHeaderUpdate({
    provider: ctx.providerA,
    chainKey: "A",
    blockTag: ethers.toQuantity(trustedHeight),
    sourceChainId,
    validatorEpoch: 1n,
    conflictStateRoot: ethers.keccak256(
      ethers.toUtf8Bytes(`demo-conflict:${trustedHeight.toString()}:${Date.now().toString()}`)
    ),
  });

  if (conflict.headerUpdate.headerHash === trustedHeader.headerHash) {
    throw new Error("Conflicting header generation produced the trusted hash; conflict evidence is invalid.");
  }

  try {
    await ctx.B.lightClient.updateClient.staticCall(conflict.headerUpdate, conflict.validatorSet, txOptions());
  } catch (error) {
    const text = shortError(error);
    if (text.includes("HEIGHT_NOT_FORWARD")) {
      throw new Error(
        "The deployed Besu light client predates the native misbehaviour-freeze patch. Redeploy so conflicting trusted heights freeze instead of failing as stale headers."
      );
    }
    throw error;
  }

  await txStep("step submit conflicting header update", () =>
    ctx.B.lightClient.updateClient(conflict.headerUpdate, conflict.validatorSet, txOptions())
  );

  const [frozenStatus, evidence] = await Promise.all([
    ctx.B.lightClient.status(sourceChainId),
    ctx.B.lightClient.frozenEvidence(sourceChainId),
  ]);

  if (Number(frozenStatus) !== 2) {
    throw new Error("Conflicting native header was submitted, but the Bank B light client did not freeze.");
  }

  return writeTracePatch(
    config,
    ctx,
    {
      misbehaviour: {
        frozen: true,
        recovered: false,
        sourceChainId: sourceChainId.toString(),
        destinationChainId: destinationChainId.toString(),
        height: evidence.height.toString(),
        trustedHeaderHash: evidence.trustedHeaderHash,
        conflictingHeaderHash: evidence.conflictingHeaderHash,
        evidenceHash: evidence.evidenceHash,
        detectedAt: evidence.detectedAt.toString(),
      },
      security: {
        frozen: true,
      },
    },
    {
      phase: "client-frozen",
      label: "Submitted conflicting native Besu header",
      summary: `Bank B froze its Bank A client at height ${evidence.height.toString()} after conflicting finalized-header evidence.`,
    }
  );
}

export async function recoverClientStep({ config, ctx, sourceChainId }) {
  setPhase("step-recover-client");
  const existingStatus = Number(await ctx.B.lightClient.status(sourceChainId));
  if (existingStatus === 1) {
    return writeTracePatch(
      config,
      ctx,
      {
        misbehaviour: {
          frozen: false,
          recovered: true,
        },
        security: {
          frozen: false,
        },
      },
      {
        phase: "client-recovered",
        label: "Recovered native Besu light client",
        summary: "Bank B client for Bank A is already active.",
      }
    );
  }

  const evidence = await ctx.B.lightClient.frozenEvidence(sourceChainId);
  if (existingStatus !== 2 && existingStatus !== 3) {
    throw new Error("Bank B client for Bank A is not frozen, so there is no recovery action to run.");
  }
  if (evidence.evidenceHash === ethers.ZeroHash) {
    throw new Error("The Bank B client is not carrying frozen evidence, so recovery cannot derive its recovery point.");
  }

  if (existingStatus === 2) {
    await txStep("step begin client recovery", () => ctx.B.lightClient.beginRecovery(sourceChainId, txOptions()));
  }

  let recoveryHeight = BigInt(await ctx.providerA.getBlockNumber());
  if (recoveryHeight <= evidence.height) {
    await txStep("step advance Bank A recovery head", () =>
      ctx.A.policy.setAccountAllowed(ctx.sourceUserAddress, true, txOptions())
    );
    recoveryHeight = BigInt(await ctx.providerA.getBlockNumber());
  }
  if (recoveryHeight <= evidence.height) {
    throw new Error(
      `Bank A did not advance past frozen height ${evidence.height.toString()}, so a new recovery trust anchor could not be created.`
    );
  }

  const recoveryHeader = await buildBesuHeaderUpdate({
    provider: ctx.providerA,
    blockTag: ethers.toQuantity(recoveryHeight),
    sourceChainId,
    validatorEpoch: 1n,
  });

  await txStep("step recover native Besu client", () =>
    ctx.B.lightClient.recoverClient(
      sourceChainId,
      trustedAnchorFromHeader(recoveryHeader),
      recoveryHeader.validatorSet,
      txOptions()
    )
  );

  const [recoveredStatus, latestTrustedHeight, clearedEvidence] = await Promise.all([
    ctx.B.lightClient.status(sourceChainId),
    ctx.B.lightClient.latestTrustedHeight(sourceChainId),
    ctx.B.lightClient.frozenEvidence(sourceChainId),
  ]);

  if (Number(recoveredStatus) !== 1) {
    throw new Error("Bank B light client did not return to Active after recovery.");
  }
  if (latestTrustedHeight !== recoveryHeader.headerUpdate.height) {
    throw new Error("Recovered trusted height does not match the recovery trust anchor.");
  }
  if (clearedEvidence.evidenceHash !== ethers.ZeroHash) {
    throw new Error("Frozen evidence was not cleared after recovery.");
  }

  return writeTracePatch(
    config,
    ctx,
    {
      misbehaviour: {
        frozen: false,
        recovered: true,
        recoveredAtHeight: recoveryHeader.headerUpdate.height.toString(),
        recoveredHeaderHash: recoveryHeader.headerUpdate.headerHash,
        recoveredStateRoot: recoveryHeader.headerUpdate.stateRoot,
        previousEvidenceHeight: evidence.height.toString(),
        previousEvidenceHash: evidence.evidenceHash,
      },
      security: {
        frozen: false,
      },
    },
    {
      phase: "client-recovered",
      label: "Recovered native Besu light client",
      summary: `Bank B re-anchored its Bank A client at height ${recoveryHeader.headerUpdate.height.toString()} and returned it to Active.`,
    }
  );
}
