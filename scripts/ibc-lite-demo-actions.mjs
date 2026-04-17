import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ethers } from "ethers";
import {
  hydrateExecutionStateRoot,
  normalizeRuntime,
  packetCommitmentPath,
  providerFor,
  signerFor,
} from "./ibc-lite-common.mjs";
import {
  ensureFinalizedHeader,
  latestFinalizedHeader as latestProgressHeader,
  relayTrustedHeaderUpdate,
} from "./ibc-lite-header-progression.mjs";
import { context, normalizeTrace, readDemoStatus } from "./ibc-lite-demo-read-model.mjs";
import { relayPacketForCanonicalRuntime } from "./ibc-lite-relay-paths.mjs";
import { recoverClientWithSuccessorEpoch, submitConflictingHeaderUpdate } from "./ibc-lite-safety.mjs";

// Demo controller: orchestrates user-facing actions and delegates state reads to the read-model layer.
const ACTION_LOCK_MINT = 1;
const ACTION_BURN_UNLOCK = 2;
const PACKET_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes("IBCLite.Packet.v1"));
const PACKET_LEAF_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes("IBCLite.PacketLeaf.v1"));
const TRANSFER_AMOUNT = ethers.parseUnits(process.env.DEMO_AMOUNT || "100", 18);
const BORROW_AMOUNT = ethers.parseUnits(process.env.DEMO_BORROW_AMOUNT || "50", 18);
const POOL_LIQUIDITY = ethers.parseUnits(process.env.POOL_LIQUIDITY || "10000", 18);
const TRACE_JSON_PATH = resolve(process.cwd(), "demo", "latest-run.json");
const TRACE_JS_PATH = resolve(process.cwd(), "demo", "latest-run.js");
const RECOVERY_VALIDATOR_INDICES = (
  process.env.RECOVERY_VALIDATOR_INDICES || (process.env.USE_BESU_KEYS === "true" ? "1,2,3" : "6,7,8")
)
  .split(",")
  .map((value) => Number(value.trim()));

function units(value) {
  return ethers.formatUnits(value, 18);
}

function short(value) {
  if (!value || value.length <= 18) return value;
  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}


function packetTuple({
  sequence,
  sourceChainId,
  destinationChainId,
  sourcePort,
  destinationPort,
  sender,
  recipient,
  asset,
  amount,
  action,
}) {
  return {
    sequence,
    sourceChainId,
    destinationChainId,
    sourcePort,
    destinationPort,
    sender,
    recipient,
    asset,
    amount,
    action,
    memo: ethers.ZeroHash,
  };
}

function packetId(packet) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      [
        "bytes32",
        "uint256",
        "uint256",
        "uint256",
        "address",
        "address",
        "address",
        "address",
        "address",
        "uint256",
        "uint8",
        "bytes32",
      ],
      [
        PACKET_TYPEHASH,
        packet.sequence,
        packet.sourceChainId,
        packet.destinationChainId,
        packet.sourcePort,
        packet.destinationPort,
        packet.sender,
        packet.recipient,
        packet.asset,
        packet.amount,
        packet.action,
        packet.memo,
      ]
    )
  );
}

function packetLeaf(packet) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32"], [PACKET_LEAF_TYPEHASH, packetId(packet)])
  );
}

async function ensureSeed(ctx) {
  const { cfg, artifacts, ownerA, ownerB, userA } = ctx;
  const canonical = new ethers.Contract(cfg.chains.A.canonicalToken, artifacts.bankToken.abi, ownerA);
  const debtToken = cfg.chains.B.debtToken
    ? new ethers.Contract(cfg.chains.B.debtToken, artifacts.bankToken.abi, ownerB)
    : null;
  const userAAddress = await userA.getAddress();

  if ((await canonical.balanceOf(userAAddress)) < TRANSFER_AMOUNT) {
    await (await canonical.mint(userAAddress, TRANSFER_AMOUNT * 5n)).wait();
  }
  if (debtToken && (await debtToken.balanceOf(cfg.chains.B.lendingPool)) < BORROW_AMOUNT) {
    await (await debtToken.mint(cfg.chains.B.lendingPool, POOL_LIQUIDITY)).wait();
  }

  await (await canonical.connect(userA).approve(cfg.chains.A.escrowVault, ethers.MaxUint256)).wait();
}

async function latestFinalizedHeader(chainKey, ctx) {
  return latestProgressHeader({ cfg: ctx.cfg, artifacts: ctx.artifacts, chainKey });
}

async function finalizeHeader(chainKey, ctx) {
  return ensureFinalizedHeader({ cfg: ctx.cfg, artifacts: ctx.artifacts, chainKey, logPrefix: chainKey });
}

async function updateRemoteClient(sourceKey, destinationKey, ctx) {
  return relayTrustedHeaderUpdate({
    cfg: ctx.cfg,
    artifacts: ctx.artifacts,
    sourceKey,
    destinationKey,
    header: await latestFinalizedHeader(sourceKey, ctx),
    runtime: ctx.cfg.runtime || normalizeRuntime(ctx.cfg),
    logPrefix: destinationKey,
  });
}

async function packetFor(sourceKey, destinationKey, action, ctx, sequence) {
  const { cfg, artifacts, userA, userB } = ctx;
  const source = cfg.chains[sourceKey];
  const sourceProvider = providerFor(cfg, sourceKey);
  const packetStore = new ethers.Contract(source.packetStore, artifacts.packetStore.abi, sourceProvider);
  const packetSequence = sequence ?? (await packetStore.packetSequence());

  if (action === ACTION_LOCK_MINT) {
    return packetTuple({
      sequence: packetSequence,
      sourceChainId: BigInt(cfg.chains.A.chainId),
      destinationChainId: BigInt(cfg.chains.B.chainId),
      sourcePort: cfg.chains.A.transferApp,
      destinationPort: cfg.chains.B.transferApp,
      sender: await userA.getAddress(),
      recipient: await userB.getAddress(),
      asset: cfg.chains.A.canonicalToken,
      amount: TRANSFER_AMOUNT,
      action,
    });
  }

  return packetTuple({
    sequence: packetSequence,
    sourceChainId: BigInt(cfg.chains.B.chainId),
    destinationChainId: BigInt(cfg.chains.A.chainId),
    sourcePort: cfg.chains.B.transferApp,
    destinationPort: cfg.chains.A.transferApp,
    sender: await userB.getAddress(),
    recipient: await userA.getAddress(),
    asset: cfg.chains.B.voucherToken,
    amount: TRANSFER_AMOUNT,
    action,
  });
}

async function relayPacket(sourceKey, destinationKey, action, ctx) {
  const { cfg, artifacts } = ctx;
  const runtime = cfg.runtime || normalizeRuntime(cfg);
  const header = await hydrateExecutionStateRoot(cfg, sourceKey, await latestFinalizedHeader(sourceKey, ctx), {
    strict: runtime.proofPolicy === "storage-required",
  });
  const source = cfg.chains[sourceKey];
  const client = new ethers.Contract(cfg.chains[destinationKey].client, artifacts.client.abi, providerFor(cfg, destinationKey));
  const consensusHash = await client.consensusStateHashBySequence(source.chainId, header.height);
  if (consensusHash === ethers.ZeroHash) {
    throw new Error(`[${destinationKey}] Remote client has not trusted header #${header.height}.`);
  }
  const packet = await packetFor(sourceKey, destinationKey, action, ctx, header.lastPacketSequence);
  const proof = await relayPacketForCanonicalRuntime({
    cfg,
    artifacts,
    sourceKey,
    destinationKey,
    packet,
    header,
    consensusHash,
    logPrefix: destinationKey,
  });
  return { ...proof, header };
}

function isReplayRejection(error) {
  const text = [error?.shortMessage, error?.reason, error?.message].filter(Boolean).join("\n");
  return text.includes("PACKET_ALREADY_CONSUMED");
}

async function verifyForwardNonMembership(ctx) {
  const { cfg, artifacts } = ctx;
  const header = await latestFinalizedHeader("A", ctx);
  const client = new ethers.Contract(cfg.chains.B.client, artifacts.client.abi, providerFor(cfg, "B"));
  const consensusHash = await client.consensusStateHashBySequence(cfg.chains.A.chainId, header.height);
  if (consensusHash === ethers.ZeroHash) {
    throw new Error("[B] Bank B client has not trusted the Bank A header yet.");
  }

  const absentSequence = header.lastPacketSequence + 1n;
  const absentPacket = await packetFor("A", "B", ACTION_LOCK_MINT, ctx, absentSequence);
  const absentLeaf = packetLeaf(absentPacket);
  const path = packetCommitmentPath(cfg.chains.A.chainId, cfg.chains.A.transferApp, absentSequence);
  const proof = ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(uint256 sequence,uint256 leafIndex,bytes32 witnessedValue,bytes32[] siblings)"],
    [[absentSequence, 0n, ethers.ZeroHash, []]]
  );
  const verified = await client.verifyNonMembership(cfg.chains.A.chainId, consensusHash, path, absentLeaf, proof);
  if (!verified) throw new Error("Bank B client rejected the non-membership proof.");

  return {
    consensusHash,
    absentSequence: absentSequence.toString(),
    absentLeaf,
    path,
  };
}

async function writeTracePatch(patch) {
  let trace = {};
  try {
    trace = normalizeTrace(JSON.parse(await readFile(TRACE_JSON_PATH, "utf8")));
  } catch {
    trace = {};
  }
  trace = { ...trace, generatedAt: new Date().toISOString() };
  for (const [key, value] of Object.entries(patch)) {
    const existing = trace[key];
    if (
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      trace[key] = { ...existing, ...value };
    } else {
      trace[key] = value;
    }
  }
  trace = normalizeTrace(trace);
  await writeFile(TRACE_JSON_PATH, `${JSON.stringify(trace, null, 2)}\n`);
  await writeFile(TRACE_JS_PATH, `window.IBCLiteLatestRun = ${JSON.stringify(trace, null, 2)};\n`);
  return trace;
}

async function submitConflict(ctx) {
  return submitConflictingHeaderUpdate({
    cfg: ctx.cfg,
    artifacts: ctx.artifacts,
    sourceKey: "A",
    destinationKey: "B",
    requireExistingTrusted: true,
    logPrefix: "B",
  });
}

async function recoverBankBClientForA(ctx) {
  return recoverClientWithSuccessorEpoch({
    cfg: ctx.cfg,
    artifacts: ctx.artifacts,
    sourceKey: "A",
    destinationKey: "B",
    recoveryValidatorIndices: RECOVERY_VALIDATOR_INDICES,
    logPrefix: "B",
  });
}

async function lendingContracts(ctx) {
  const { cfg, artifacts, userB } = ctx;
  if (!cfg.chains.B.lendingPool || !cfg.chains.B.debtToken) {
    throw new Error("Bank B lending pool is not deployed. Redeploy + Seed the latest stack.");
  }
  return {
    voucher: new ethers.Contract(cfg.chains.B.voucherToken, artifacts.voucher.abi, userB),
    debtToken: new ethers.Contract(cfg.chains.B.debtToken, artifacts.bankToken.abi, userB),
    pool: new ethers.Contract(cfg.chains.B.lendingPool, artifacts.lendingPool.abi, userB),
  };
}

async function depositVerifiedCollateral(ctx) {
  const { voucher, pool } = await lendingContracts(ctx);
  const userBAddress = await ctx.userB.getAddress();
  const voucherBalance = await voucher.balanceOf(userBAddress);
  if (voucherBalance < TRANSFER_AMOUNT) {
    throw new Error("Bank B user needs verified voucher collateral before depositing into lending.");
  }
  const currentCollateral = await pool.collateralBalance(userBAddress);
  if (currentCollateral >= TRANSFER_AMOUNT) {
    return { collateral: currentCollateral.toString() };
  }
  await (await voucher.approve(await pool.getAddress(), TRANSFER_AMOUNT)).wait();
  await (await pool.depositCollateral(TRANSFER_AMOUNT)).wait();
  return { collateral: TRANSFER_AMOUNT.toString() };
}

async function borrowBankBLiquidity(ctx) {
  const { pool } = await lendingContracts(ctx);
  const userBAddress = await ctx.userB.getAddress();
  const currentDebt = await pool.debtBalance(userBAddress);
  if (currentDebt >= BORROW_AMOUNT) return { debt: currentDebt.toString() };
  await (await pool.borrow(BORROW_AMOUNT - currentDebt)).wait();
  return { debt: BORROW_AMOUNT.toString() };
}

async function repayBankBLiquidity(ctx) {
  const { debtToken, pool } = await lendingContracts(ctx);
  const userBAddress = await ctx.userB.getAddress();
  const currentDebt = await pool.debtBalance(userBAddress);
  if (currentDebt === 0n) return { debt: "0" };
  await (await debtToken.approve(await pool.getAddress(), currentDebt)).wait();
  await (await pool.repay(currentDebt)).wait();
  return { debt: "0" };
}

async function withdrawVerifiedCollateral(ctx) {
  const { pool } = await lendingContracts(ctx);
  const userBAddress = await ctx.userB.getAddress();
  const currentCollateral = await pool.collateralBalance(userBAddress);
  if (currentCollateral === 0n) return { collateral: "0" };
  await (await pool.withdrawCollateral(currentCollateral)).wait();
  return { collateral: "0" };
}

export async function runDemoAction(action) {
  const ctx = await context();
  const { cfg, artifacts, userA, userB } = ctx;
  await ensureSeed(ctx);

  let message = "";
  let trace = null;

  if (action === "lock") {
    const appA = new ethers.Contract(cfg.chains.A.transferApp, artifacts.app.abi, userA);
    await (await appA.sendTransfer(cfg.chains.B.chainId, await userB.getAddress(), TRANSFER_AMOUNT)).wait();
    message = `Locked ${units(TRANSFER_AMOUNT)} aBANK on Bank A and wrote a packet commitment.`;
  } else if (action === "finalizeForwardHeader") {
    const header = await finalizeHeader("A", ctx);
    trace = await writeTracePatch({
      forward: {
        headerHeight: header.height.toString(),
        headerHash: header.blockHash,
        packetRoot: header.packetRoot,
        stateRoot: header.stateRoot,
        executionStateRoot: header.executionStateRoot,
      },
    });
    message = `Finalized Bank A header #${header.height}.`;
  } else if (action === "updateForwardClient") {
    const { header, consensusHash } = await updateRemoteClient("A", "B", ctx);
    trace = await writeTracePatch({
      forward: {
        headerHeight: header.height.toString(),
        headerHash: header.blockHash,
        packetRoot: header.packetRoot,
        stateRoot: header.stateRoot,
        executionStateRoot: header.executionStateRoot,
        consensusHash,
      },
    });
    message = `Updated Bank B client with Bank A finalized header #${header.height}.`;
  } else if (action === "proveForwardMint") {
    const proof = await relayPacket("A", "B", ACTION_LOCK_MINT, ctx);
    trace = await writeTracePatch({
      forward: {
        packetId: proof.packetId,
        leafIndex: proof.leafIndex == null ? null : String(proof.leafIndex),
        packetRoot: proof.packetRoot,
        stateRoot: proof.stateRoot,
        executionStateRoot: proof.executionStateRoot,
        headerHeight: proof.header.height.toString(),
        headerHash: proof.header.blockHash,
        consensusHash: proof.consensusHash,
        proofMode: proof.proofMode,
      },
    });
    message = `Verified packet membership on Bank B and minted voucher ${short(proof.packetId)}.`;
  } else if (action === "depositCollateral") {
    const result = await depositVerifiedCollateral(ctx);
    trace = await writeTracePatch({
      lending: {
        collateralDeposited: true,
        collateral: result.collateral,
      },
    });
    message = `Deposited verified voucher collateral into Bank B lending pool.`;
  } else if (action === "borrow") {
    const result = await borrowBankBLiquidity(ctx);
    trace = await writeTracePatch({
      lending: {
        borrowed: true,
        debt: result.debt,
      },
    });
    message = `Borrowed ${units(BORROW_AMOUNT)} bCASH from Bank B against verified cross-chain collateral.`;
  } else if (action === "repay") {
    const result = await repayBankBLiquidity(ctx);
    trace = await writeTracePatch({
      lending: {
        repaid: true,
        debt: result.debt,
      },
    });
    message = "Repaid Bank B lending debt.";
  } else if (action === "withdrawCollateral") {
    const result = await withdrawVerifiedCollateral(ctx);
    trace = await writeTracePatch({
      lending: {
        collateralWithdrawn: true,
        completed: true,
        collateral: result.collateral,
      },
    });
    message = "Withdrew voucher collateral so it can be burned for the reverse proof path.";
  } else if (action === "replayForward") {
    try {
      await relayPacket("A", "B", ACTION_LOCK_MINT, ctx);
      throw new Error("Replay was unexpectedly accepted by the packet handler.");
    } catch (error) {
      if (!isReplayRejection(error)) throw error;
    }
    trace = await writeTracePatch({ security: { replayBlocked: true, replayCheckedAt: new Date().toISOString() } });
    message = "Replay attempt rejected by consumed packet state.";
  } else if (action === "checkNonMembership") {
    const absence = await verifyForwardNonMembership(ctx);
    trace = await writeTracePatch({ security: { nonMembership: absence } });
    message = `Verified non-membership for future Bank A packet sequence #${absence.absentSequence}.`;
  } else if (action === "burn") {
    const voucher = new ethers.Contract(cfg.chains.B.voucherToken, artifacts.voucher.abi, providerFor(cfg, "B"));
    if ((await voucher.balanceOf(await userB.getAddress())) < TRANSFER_AMOUNT) {
      throw new Error("Bank B user needs a free voucher balance before burn. Repay and withdraw lending collateral first.");
    }
    const appB = new ethers.Contract(cfg.chains.B.transferApp, artifacts.app.abi, userB);
    await (await appB.burnAndRelease(cfg.chains.A.chainId, await userA.getAddress(), TRANSFER_AMOUNT)).wait();
    message = `Burned voucher on Bank B and wrote a reverse packet commitment.`;
  } else if (action === "finalizeReverseHeader") {
    const header = await finalizeHeader("B", ctx);
    trace = await writeTracePatch({
      reverse: {
        headerHeight: header.height.toString(),
        headerHash: header.blockHash,
        packetRoot: header.packetRoot,
        stateRoot: header.stateRoot,
        executionStateRoot: header.executionStateRoot,
      },
    });
    message = `Finalized Bank B header #${header.height}.`;
  } else if (action === "updateReverseClient") {
    const { header, consensusHash } = await updateRemoteClient("B", "A", ctx);
    trace = await writeTracePatch({
      reverse: {
        headerHeight: header.height.toString(),
        headerHash: header.blockHash,
        packetRoot: header.packetRoot,
        stateRoot: header.stateRoot,
        executionStateRoot: header.executionStateRoot,
        consensusHash,
      },
    });
    message = `Updated Bank A client with Bank B finalized header #${header.height}.`;
  } else if (action === "proveReverseUnlock") {
    const proof = await relayPacket("B", "A", ACTION_BURN_UNLOCK, ctx);
    trace = await writeTracePatch({
      reverse: {
        packetId: proof.packetId,
        leafIndex: proof.leafIndex == null ? null : String(proof.leafIndex),
        packetRoot: proof.packetRoot,
        stateRoot: proof.stateRoot,
        executionStateRoot: proof.executionStateRoot,
        headerHeight: proof.header.height.toString(),
        headerHash: proof.header.blockHash,
        consensusHash: proof.consensusHash,
        proofMode: proof.proofMode,
      },
    });
    message = `Verified reverse packet on Bank A and unescrowed aBANK ${short(proof.packetId)}.`;
  } else if (action === "freezeClient") {
    const conflict = await submitConflict(ctx);
    trace = await writeTracePatch({ misbehaviour: { frozen: true, ...conflict } });
    message = `Submitted conflicting finalized-header evidence. Bank B client for Bank A is frozen at height ${conflict.height}.`;
  } else if (action === "recoverClient") {
    const recovery = await recoverBankBClientForA(ctx);
    trace = await writeTracePatch({ misbehaviour: { frozen: false, recovered: true, ...recovery } });
    message = `Recovered Bank B client for Bank A using successor validator epoch #${recovery.epochId}.`;
  } else if (action === "fullFlow") {
    for (const step of [
      "lock",
      "finalizeForwardHeader",
      "updateForwardClient",
      "proveForwardMint",
      "depositCollateral",
      "borrow",
      "repay",
      "withdrawCollateral",
      "burn",
      "finalizeReverseHeader",
      "updateReverseClient",
      "proveReverseUnlock",
    ]) {
      await runDemoAction(step);
    }
    message = "Completed the full proof-backed lending flow and reverse unescrow path.";
  } else {
    throw new Error(`Unknown demo action: ${action}`);
  }

  return {
    ok: true,
    message,
    trace,
    status: await readDemoStatus(),
  };
}
