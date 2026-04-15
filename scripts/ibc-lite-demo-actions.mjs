import { access, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ethers } from "ethers";
import {
  buildMerkleProof,
  checkpointObject,
  loadArtifact,
  loadConfig,
  merkleRoot,
  providerFor,
  signaturesFor,
  signerFor,
} from "./ibc-lite-common.mjs";

const ACTION_LOCK_MINT = 1;
const ACTION_BURN_UNLOCK = 2;
const TRANSFER_AMOUNT = ethers.parseUnits(process.env.DEMO_AMOUNT || "100", 18);
const BORROW_AMOUNT = ethers.parseUnits(process.env.DEMO_BORROW || "40", 18);
const TRACE_JSON_PATH = resolve(process.cwd(), "demo", "latest-run.json");
const TRACE_JS_PATH = resolve(process.cwd(), "demo", "latest-run.js");
const CONFIG_PATH = resolve(process.cwd(), ".ibc-lite.local.json");

async function configExists() {
  try {
    await access(CONFIG_PATH);
    return true;
  } catch {
    return false;
  }
}

async function loadArtifacts() {
  return {
    app: await loadArtifact("apps/MinimalTransferApp.sol", "MinimalTransferApp"),
    bankToken: await loadArtifact("apps/BankToken.sol", "BankToken"),
    voucher: await loadArtifact("apps/VoucherToken.sol", "VoucherToken"),
    lending: await loadArtifact("apps/VoucherLendingPool.sol", "VoucherLendingPool"),
    escrow: await loadArtifact("apps/EscrowVault.sol", "EscrowVault"),
    packetStore: await loadArtifact("source/SourcePacketCommitment.sol", "SourcePacketCommitment"),
    checkpointRegistry: await loadArtifact("source/SourceCheckpointRegistry.sol", "SourceCheckpointRegistry"),
    client: await loadArtifact("clients/BankChainClient.sol", "BankChainClient"),
    handler: await loadArtifact("core/IBCPacketHandler.sol", "IBCPacketHandler"),
  };
}

async function context() {
  if (!(await configExists())) throw new Error("No deployment found. Press Deploy + Seed first.");
  const cfg = await loadConfig();
  const artifacts = await loadArtifacts();
  const ownerA = await signerFor(cfg, "A", 0);
  const ownerB = await signerFor(cfg, "B", 0);
  const userA = await signerFor(cfg, "A", Number(process.env.USER_INDEX || 1));
  const userB = await signerFor(cfg, "B", Number(process.env.USER_INDEX || 1));
  return { cfg, artifacts, ownerA, ownerB, userA, userB };
}

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

async function ensureSeed(ctx) {
  const { cfg, artifacts, ownerA, ownerB, userA, userB } = ctx;
  const canonical = new ethers.Contract(cfg.chains.A.canonicalToken, artifacts.bankToken.abi, ownerA);
  const stable = new ethers.Contract(cfg.chains.B.stableToken, artifacts.bankToken.abi, ownerB);
  const userAAddress = await userA.getAddress();

  if ((await canonical.balanceOf(userAAddress)) < TRANSFER_AMOUNT) {
    await (await canonical.mint(userAAddress, TRANSFER_AMOUNT * 5n)).wait();
  }

  if ((await stable.balanceOf(cfg.chains.B.lendingPool)) < BORROW_AMOUNT) {
    await (await stable.mint(cfg.chains.B.lendingPool, BORROW_AMOUNT * 5n)).wait();
  }

  const voucher = new ethers.Contract(cfg.chains.B.voucherToken, artifacts.voucher.abi, userB);
  const stableUser = new ethers.Contract(cfg.chains.B.stableToken, artifacts.bankToken.abi, userB);
  await (await canonical.connect(userA).approve(cfg.chains.A.escrowVault, ethers.MaxUint256)).wait();
  await (await voucher.approve(cfg.chains.B.lendingPool, ethers.MaxUint256)).wait();
  await (await stableUser.approve(cfg.chains.B.lendingPool, ethers.MaxUint256)).wait();
}

async function latestCheckpoint(chainKey, ctx) {
  const { cfg, artifacts } = ctx;
  const registry = new ethers.Contract(
    cfg.chains[chainKey].checkpointRegistry,
    artifacts.checkpointRegistry.abi,
    providerFor(cfg, chainKey)
  );
  const sequence = await registry.checkpointSequence();
  if (sequence === 0n) throw new Error(`[${chainKey}] No checkpoint exists yet.`);
  return checkpointObject(await registry.checkpointsBySequence(sequence));
}

async function commitCheckpoint(chainKey, ctx) {
  const { cfg, artifacts } = ctx;
  const signer = await signerFor(cfg, chainKey, 0);
  const chain = cfg.chains[chainKey];
  const packetStore = new ethers.Contract(chain.packetStore, artifacts.packetStore.abi, signer);
  const registry = new ethers.Contract(chain.checkpointRegistry, artifacts.checkpointRegistry.abi, signer);
  const packetSequence = await packetStore.packetSequence();
  const committed = await registry.lastCommittedPacketSequence();

  if (packetSequence === 0n) throw new Error(`[${chainKey}] No packet has been written yet.`);
  if (packetSequence > committed) {
    await (await registry.commitCheckpoint(packetSequence)).wait();
  }

  return latestCheckpoint(chainKey, ctx);
}

async function updateRemoteClient(sourceKey, destinationKey, ctx) {
  const { cfg, artifacts } = ctx;
  const checkpoint = await latestCheckpoint(sourceKey, ctx);
  const sourceProvider = providerFor(cfg, sourceKey);
  const destinationSigner = await signerFor(cfg, destinationKey, 0);
  const client = new ethers.Contract(cfg.chains[destinationKey].client, artifacts.client.abi, destinationSigner);
  const consensusHash = await client.hashConsensusState(checkpoint);
  const already = await client.consensusStateHashBySequence(cfg.chains[sourceKey].chainId, checkpoint.sequence);

  if (already === ethers.ZeroHash) {
    const signatures = await signaturesFor(sourceProvider, consensusHash);
    await (await client.updateState([checkpoint], signatures)).wait();
  }

  return { checkpoint, consensusHash };
}

async function packetFor(sourceKey, destinationKey, action, ctx, sequence) {
  const { cfg, artifacts, userA, userB } = ctx;
  const source = cfg.chains[sourceKey];
  const destination = cfg.chains[destinationKey];
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
  const checkpoint = await latestCheckpoint(sourceKey, ctx);
  const destinationSigner = await signerFor(cfg, destinationKey, 0);
  const sourceProvider = providerFor(cfg, sourceKey);
  const source = cfg.chains[sourceKey];
  const destination = cfg.chains[destinationKey];
  const client = new ethers.Contract(destination.client, artifacts.client.abi, destinationSigner);
  const packetStore = new ethers.Contract(source.packetStore, artifacts.packetStore.abi, sourceProvider);
  const handler = new ethers.Contract(destination.packetHandler, artifacts.handler.abi, destinationSigner);
  const consensusHash = await client.consensusStateHashBySequence(source.chainId, checkpoint.sequence);
  if (consensusHash === ethers.ZeroHash) {
    throw new Error(`[${destinationKey}] Remote client has not trusted checkpoint #${checkpoint.sequence}.`);
  }

  const leaves = [];
  for (let sequence = checkpoint.firstPacketSequence; sequence <= checkpoint.lastPacketSequence; sequence++) {
    leaves.push(await packetStore.packetLeafAt(sequence));
  }

  const root = merkleRoot(leaves);
  if (root !== checkpoint.packetRoot) throw new Error(`[${sourceKey}] Packet root mismatch.`);
  const packet = await packetFor(sourceKey, destinationKey, action, ctx, checkpoint.lastPacketSequence);
  const leafIndex = Number(packet.sequence - checkpoint.firstPacketSequence);
  const packetId = await packetStore.packetIdAt(packet.sequence);

  if (!(await handler.consumedPackets(packetId))) {
    await (await handler.recvPacket(packet, [consensusHash, leafIndex, buildMerkleProof(leaves, leafIndex)])).wait();
  }

  return { packetId, leafIndex, checkpoint, packetRoot: root, consensusHash };
}

async function writeTracePatch(patch) {
  let trace = {};
  try {
    trace = JSON.parse(await readFile(TRACE_JSON_PATH, "utf8"));
  } catch {
    trace = {};
  }
  trace = { ...trace, generatedAt: new Date().toISOString(), ...patch };
  await writeFile(TRACE_JSON_PATH, `${JSON.stringify(trace, null, 2)}\n`);
  await writeFile(TRACE_JS_PATH, `window.IBCLiteLatestRun = ${JSON.stringify(trace, null, 2)};\n`);
  return trace;
}

export async function readDemoStatus() {
  if (!(await configExists())) {
    return {
      deployed: false,
      message: "Start both local chains, then press Deploy + Seed.",
    };
  }

  const ctx = await context();
  const { cfg, artifacts, userA, userB } = ctx;
  const userAAddress = await userA.getAddress();
  const userBAddress = await userB.getAddress();
  const canonical = new ethers.Contract(cfg.chains.A.canonicalToken, artifacts.bankToken.abi, providerFor(cfg, "A"));
  const escrow = new ethers.Contract(cfg.chains.A.escrowVault, artifacts.escrow.abi, providerFor(cfg, "A"));
  const voucher = new ethers.Contract(cfg.chains.B.voucherToken, artifacts.voucher.abi, providerFor(cfg, "B"));
  const stable = new ethers.Contract(cfg.chains.B.stableToken, artifacts.bankToken.abi, providerFor(cfg, "B"));
  const lending = new ethers.Contract(cfg.chains.B.lendingPool, artifacts.lending.abi, providerFor(cfg, "B"));
  const packetA = new ethers.Contract(cfg.chains.A.packetStore, artifacts.packetStore.abi, providerFor(cfg, "A"));
  const packetB = new ethers.Contract(cfg.chains.B.packetStore, artifacts.packetStore.abi, providerFor(cfg, "B"));
  const checkpointA = new ethers.Contract(
    cfg.chains.A.checkpointRegistry,
    artifacts.checkpointRegistry.abi,
    providerFor(cfg, "A")
  );
  const checkpointB = new ethers.Contract(
    cfg.chains.B.checkpointRegistry,
    artifacts.checkpointRegistry.abi,
    providerFor(cfg, "B")
  );
  const clientA = new ethers.Contract(cfg.chains.A.client, artifacts.client.abi, providerFor(cfg, "A"));
  const clientB = new ethers.Contract(cfg.chains.B.client, artifacts.client.abi, providerFor(cfg, "B"));

  const [
    bankABalance,
    escrowTotal,
    voucherBalance,
    stableBalance,
    poolStable,
    collateral,
    debt,
    packetSequenceA,
    packetSequenceB,
    checkpointSequenceA,
    checkpointSequenceB,
    trustedAOnB,
    trustedBOnA,
  ] = await Promise.all([
    canonical.balanceOf(userAAddress),
    escrow.totalEscrowed(),
    voucher.balanceOf(userBAddress),
    stable.balanceOf(userBAddress),
    stable.balanceOf(cfg.chains.B.lendingPool),
    lending.collateralBalance(userBAddress),
    lending.debtBalance(userBAddress),
    packetA.packetSequence(),
    packetB.packetSequence(),
    checkpointA.checkpointSequence(),
    checkpointB.checkpointSequence(),
    clientB.latestConsensusStateSequence(cfg.chains.A.chainId),
    clientA.latestConsensusStateSequence(cfg.chains.B.chainId),
  ]);

  let trace = null;
  try {
    trace = JSON.parse(await readFile(TRACE_JSON_PATH, "utf8"));
  } catch {
    trace = null;
  }

  return {
    deployed: true,
    userA: userAAddress,
    userB: userBAddress,
    amount: units(TRANSFER_AMOUNT),
    borrowAmount: units(BORROW_AMOUNT),
    balances: {
      bankA: units(bankABalance),
      escrow: units(escrowTotal),
      voucher: units(voucherBalance),
      stable: units(stableBalance),
      poolStable: units(poolStable),
      collateral: units(collateral),
      debt: units(debt),
    },
    progress: {
      packetSequenceA: packetSequenceA.toString(),
      packetSequenceB: packetSequenceB.toString(),
      checkpointSequenceA: checkpointSequenceA.toString(),
      checkpointSequenceB: checkpointSequenceB.toString(),
      trustedAOnB: trustedAOnB.toString(),
      trustedBOnA: trustedBOnA.toString(),
    },
    trace,
  };
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
  } else if (action === "checkpointForward") {
    const checkpoint = await commitCheckpoint("A", ctx);
    trace = await writeTracePatch({
      forward: {
        checkpointSequence: checkpoint.sequence.toString(),
        checkpointHash: checkpoint.sourceCommitmentHash,
        packetRoot: checkpoint.packetRoot,
      },
    });
    message = `Committed Bank A checkpoint #${checkpoint.sequence}.`;
  } else if (action === "updateForwardClient") {
    const { checkpoint, consensusHash } = await updateRemoteClient("A", "B", ctx);
    trace = await writeTracePatch({
      forward: {
        checkpointSequence: checkpoint.sequence.toString(),
        checkpointHash: checkpoint.sourceCommitmentHash,
        packetRoot: checkpoint.packetRoot,
        consensusHash,
      },
    });
    message = `Updated Bank B client with Bank A checkpoint #${checkpoint.sequence}.`;
  } else if (action === "proveForwardMint") {
    const proof = await relayPacket("A", "B", ACTION_LOCK_MINT, ctx);
    trace = await writeTracePatch({
      forward: {
        packetId: proof.packetId,
        leafIndex: String(proof.leafIndex),
        packetRoot: proof.packetRoot,
        checkpointSequence: proof.checkpoint.sequence.toString(),
        checkpointHash: proof.checkpoint.sourceCommitmentHash,
        consensusHash: proof.consensusHash,
      },
    });
    message = `Verified packet membership on Bank B and minted voucher ${short(proof.packetId)}.`;
  } else if (action === "depositCollateral") {
    const lending = new ethers.Contract(cfg.chains.B.lendingPool, artifacts.lending.abi, userB);
    const userBAddress = await userB.getAddress();
    const current = await lending.collateralBalance(userBAddress);
    if (current < TRANSFER_AMOUNT) await (await lending.depositCollateral(TRANSFER_AMOUNT - current)).wait();
    trace = await writeTracePatch({ lending: { lastAction: "deposit", completed: false } });
    message = `Deposited voucher collateral into the Bank B lending pool.`;
  } else if (action === "borrow") {
    const lending = new ethers.Contract(cfg.chains.B.lendingPool, artifacts.lending.abi, userB);
    const userBAddress = await userB.getAddress();
    const current = await lending.debtBalance(userBAddress);
    if (current < BORROW_AMOUNT) await (await lending.borrow(BORROW_AMOUNT - current)).wait();
    trace = await writeTracePatch({ lending: { lastAction: "borrow", completed: false } });
    message = `Borrowed ${units(BORROW_AMOUNT)} sBANK against voucher collateral.`;
  } else if (action === "repay") {
    const lending = new ethers.Contract(cfg.chains.B.lendingPool, artifacts.lending.abi, userB);
    const userBAddress = await userB.getAddress();
    const debt = await lending.debtBalance(userBAddress);
    if (debt > 0n) await (await lending.repay(debt)).wait();
    trace = await writeTracePatch({ lending: { lastAction: "repay", completed: false } });
    message = `Repaid the Bank B lending position.`;
  } else if (action === "withdrawCollateral") {
    const lending = new ethers.Contract(cfg.chains.B.lendingPool, artifacts.lending.abi, userB);
    const userBAddress = await userB.getAddress();
    const collateral = await lending.collateralBalance(userBAddress);
    if (collateral > 0n) await (await lending.withdrawCollateral(collateral)).wait();
    trace = await writeTracePatch({ lending: { lastAction: "withdraw", completed: true } });
    message = `Withdrew voucher collateral from the lending pool.`;
  } else if (action === "burn") {
    const appB = new ethers.Contract(cfg.chains.B.transferApp, artifacts.app.abi, userB);
    await (await appB.burnAndRelease(cfg.chains.A.chainId, await userA.getAddress(), TRANSFER_AMOUNT)).wait();
    message = `Burned voucher on Bank B and wrote a reverse packet commitment.`;
  } else if (action === "checkpointReverse") {
    const checkpoint = await commitCheckpoint("B", ctx);
    trace = await writeTracePatch({
      reverse: {
        checkpointSequence: checkpoint.sequence.toString(),
        checkpointHash: checkpoint.sourceCommitmentHash,
        packetRoot: checkpoint.packetRoot,
      },
    });
    message = `Committed Bank B checkpoint #${checkpoint.sequence}.`;
  } else if (action === "updateReverseClient") {
    const { checkpoint, consensusHash } = await updateRemoteClient("B", "A", ctx);
    trace = await writeTracePatch({
      reverse: {
        checkpointSequence: checkpoint.sequence.toString(),
        checkpointHash: checkpoint.sourceCommitmentHash,
        packetRoot: checkpoint.packetRoot,
        consensusHash,
      },
    });
    message = `Updated Bank A client with Bank B checkpoint #${checkpoint.sequence}.`;
  } else if (action === "proveReverseUnlock") {
    const proof = await relayPacket("B", "A", ACTION_BURN_UNLOCK, ctx);
    trace = await writeTracePatch({
      reverse: {
        packetId: proof.packetId,
        leafIndex: String(proof.leafIndex),
        packetRoot: proof.packetRoot,
        checkpointSequence: proof.checkpoint.sequence.toString(),
        checkpointHash: proof.checkpoint.sourceCommitmentHash,
        consensusHash: proof.consensusHash,
      },
    });
    message = `Verified reverse packet on Bank A and unescrowed aBANK ${short(proof.packetId)}.`;
  } else if (action === "fullFlow") {
    for (const step of [
      "lock",
      "checkpointForward",
      "updateForwardClient",
      "proveForwardMint",
      "depositCollateral",
      "borrow",
      "repay",
      "withdrawCollateral",
      "burn",
      "checkpointReverse",
      "updateReverseClient",
      "proveReverseUnlock",
    ]) {
      await runDemoAction(step);
    }
    message = "Completed the full lock/mint/lending/burn/unescrow flow.";
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
