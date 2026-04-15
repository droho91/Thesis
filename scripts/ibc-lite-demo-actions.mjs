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
  validatorAddresses,
} from "./ibc-lite-common.mjs";

const ACTION_LOCK_MINT = 1;
const ACTION_BURN_UNLOCK = 2;
const TRANSFER_AMOUNT = ethers.parseUnits(process.env.DEMO_AMOUNT || "100", 18);
const TRACE_JSON_PATH = resolve(process.cwd(), "demo", "latest-run.json");
const TRACE_JS_PATH = resolve(process.cwd(), "demo", "latest-run.js");
const CONFIG_PATH = resolve(process.cwd(), ".ibc-lite.local.json");
const RECOVERY_VALIDATOR_INDICES = (process.env.RECOVERY_VALIDATOR_INDICES || "6,7,8")
  .split(",")
  .map((value) => Number(value.trim()));

async function configExists() {
  try {
    await access(CONFIG_PATH);
    return true;
  } catch {
    return false;
  }
}

async function probeRpc(rpc) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 650);
  try {
    const response = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: controller.signal,
    });
    const payload = await response.json();
    if (!payload.result) throw new Error(payload.error?.message || "eth_chainId returned no result");
    return { ok: true, chainId: Number(BigInt(payload.result)) };
  } catch (error) {
    return { ok: false, error: error.name === "AbortError" ? "timeout" : error.message };
  } finally {
    clearTimeout(timeout);
  }
}

async function localHealth() {
  if (!(await configExists())) {
    return {
      ready: false,
      deployed: false,
      label: "No deployment",
      message: "Start both local chains, then press Deploy + Seed.",
    };
  }

  const cfg = await loadConfig();
  const [chainA, chainB] = await Promise.all([probeRpc(cfg.chains.A.rpc), probeRpc(cfg.chains.B.rpc)]);
  const missing = [];
  if (!chainA.ok) missing.push(`Bank A ${cfg.chains.A.rpc}`);
  if (!chainB.ok) missing.push(`Bank B ${cfg.chains.B.rpc}`);

  if (missing.length > 0) {
    return {
      ready: false,
      deployed: false,
      label: "Chains offline",
      message: `Local chain RPC not reachable: ${missing.join(", ")}. Start npm run node:chainA and npm run node:chainB.`,
      chains: { A: chainA, B: chainB },
    };
  }

  return { ready: true, deployed: true, cfg, chains: { A: chainA, B: chainB } };
}

async function loadArtifacts() {
  return {
    app: await loadArtifact("apps/MinimalTransferApp.sol", "MinimalTransferApp"),
    bankToken: await loadArtifact("apps/BankToken.sol", "BankToken"),
    voucher: await loadArtifact("apps/VoucherToken.sol", "VoucherToken"),
    escrow: await loadArtifact("apps/EscrowVault.sol", "EscrowVault"),
    packetStore: await loadArtifact("source/SourcePacketCommitment.sol", "SourcePacketCommitment"),
    validatorRegistry: await loadArtifact("source/SourceValidatorEpochRegistry.sol", "SourceValidatorEpochRegistry"),
    checkpointRegistry: await loadArtifact("source/SourceCheckpointRegistry.sol", "SourceCheckpointRegistry"),
    client: await loadArtifact("clients/BankChainClient.sol", "BankChainClient"),
    handler: await loadArtifact("core/IBCPacketHandler.sol", "IBCPacketHandler"),
  };
}

async function context() {
  const health = await localHealth();
  if (!health.ready) throw new Error(health.message);
  const cfg = health.cfg;
  const artifacts = await loadArtifacts();
  const ownerA = await signerFor(cfg, "A", 0);
  const userA = await signerFor(cfg, "A", Number(process.env.USER_INDEX || 1));
  const userB = await signerFor(cfg, "B", Number(process.env.USER_INDEX || 1));
  return { cfg, artifacts, ownerA, userA, userB };
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

function validatorEpochObject(epoch) {
  return {
    sourceChainId: epoch.sourceChainId,
    sourceValidatorSetRegistry: epoch.sourceValidatorSetRegistry,
    epochId: epoch.epochId,
    parentEpochHash: epoch.parentEpochHash,
    validators: Array.from(epoch.validators),
    votingPowers: Array.from(epoch.votingPowers),
    totalVotingPower: epoch.totalVotingPower,
    quorumNumerator: epoch.quorumNumerator,
    quorumDenominator: epoch.quorumDenominator,
    activationBlockNumber: epoch.activationBlockNumber,
    activationBlockHash: epoch.activationBlockHash,
    timestamp: epoch.timestamp,
    epochHash: epoch.epochHash,
    active: epoch.active,
  };
}

async function ensureSeed(ctx) {
  const { cfg, artifacts, ownerA, userA } = ctx;
  const canonical = new ethers.Contract(cfg.chains.A.canonicalToken, artifacts.bankToken.abi, ownerA);
  const userAAddress = await userA.getAddress();

  if ((await canonical.balanceOf(userAAddress)) < TRANSFER_AMOUNT) {
    await (await canonical.mint(userAAddress, TRANSFER_AMOUNT * 5n)).wait();
  }

  await (await canonical.connect(userA).approve(cfg.chains.A.escrowVault, ethers.MaxUint256)).wait();
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

async function submitConflict(ctx) {
  const { cfg, artifacts } = ctx;
  const sourceProvider = providerFor(cfg, "A");
  const destinationSigner = await signerFor(cfg, "B", 0);
  const client = new ethers.Contract(cfg.chains.B.client, artifacts.client.abi, destinationSigner);
  const checkpoint = await latestCheckpoint("A", ctx);
  const existing = await client.consensusStateHashBySequence(cfg.chains.A.chainId, checkpoint.sequence);
  if (existing === ethers.ZeroHash) throw new Error("Bank B must trust an A checkpoint before conflict evidence can freeze it.");

  checkpoint.packetRoot = ethers.keccak256(ethers.toUtf8Bytes(`conflict:A:${Date.now()}`));
  checkpoint.sourceCommitmentHash = await client.hashSourceCommitment(checkpoint);
  const conflictHash = await client.hashConsensusState(checkpoint);
  const signatures = await signaturesFor(sourceProvider, conflictHash);
  await (await client.updateState([checkpoint], signatures)).wait();
  return { conflictHash, sequence: checkpoint.sequence.toString() };
}

async function recoverBankBClientForA(ctx) {
  const { cfg, artifacts } = ctx;
  const ownerA = await signerFor(cfg, "A", 0);
  const ownerB = await signerFor(cfg, "B", 0);
  const sourceProvider = providerFor(cfg, "A");
  const validatorRegistry = new ethers.Contract(cfg.chains.A.validatorRegistry, artifacts.validatorRegistry.abi, ownerA);
  const client = new ethers.Contract(cfg.chains.B.client, artifacts.client.abi, ownerB);
  const currentEpochId = await validatorRegistry.activeValidatorEpochId();
  const nextEpochId = currentEpochId + 1n;
  const validators = await validatorAddresses(sourceProvider, RECOVERY_VALIDATOR_INDICES);
  const powers = validators.map(() => 1n);

  await (await client.beginRecovery(cfg.chains.A.chainId)).wait();
  await (await validatorRegistry.commitValidatorEpoch(nextEpochId, validators, powers)).wait();
  const epoch = validatorEpochObject(await validatorRegistry.validatorEpoch(nextEpochId));
  const signatures = await signaturesFor(sourceProvider, epoch.epochHash);
  await (await client.updateValidatorEpoch(epoch, signatures)).wait();
  return { epochId: nextEpochId.toString(), epochHash: epoch.epochHash };
}

export async function readDemoStatus() {
  const health = await localHealth();
  if (!health.ready) return health;

  const ctx = await context();
  const { cfg, artifacts, userA, userB } = ctx;
  const userAAddress = await userA.getAddress();
  const userBAddress = await userB.getAddress();
  const canonical = new ethers.Contract(cfg.chains.A.canonicalToken, artifacts.bankToken.abi, providerFor(cfg, "A"));
  const escrow = new ethers.Contract(cfg.chains.A.escrowVault, artifacts.escrow.abi, providerFor(cfg, "A"));
  const voucher = new ethers.Contract(cfg.chains.B.voucherToken, artifacts.voucher.abi, providerFor(cfg, "B"));
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
    packetSequenceA,
    packetSequenceB,
    checkpointSequenceA,
    checkpointSequenceB,
    trustedAOnB,
    trustedBOnA,
    statusAOnB,
    statusBOnA,
  ] = await Promise.all([
    canonical.balanceOf(userAAddress),
    escrow.totalEscrowed(),
    voucher.balanceOf(userBAddress),
    packetA.packetSequence(),
    packetB.packetSequence(),
    checkpointA.checkpointSequence(),
    checkpointB.checkpointSequence(),
    clientB.latestConsensusStateSequence(cfg.chains.A.chainId),
    clientA.latestConsensusStateSequence(cfg.chains.B.chainId),
    clientB.status(cfg.chains.A.chainId),
    clientA.status(cfg.chains.B.chainId),
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
    balances: {
      bankA: units(bankABalance),
      escrow: units(escrowTotal),
      voucher: units(voucherBalance),
    },
    progress: {
      packetSequenceA: packetSequenceA.toString(),
      packetSequenceB: packetSequenceB.toString(),
      checkpointSequenceA: checkpointSequenceA.toString(),
      checkpointSequenceB: checkpointSequenceB.toString(),
      trustedAOnB: trustedAOnB.toString(),
      trustedBOnA: trustedBOnA.toString(),
      statusAOnB: Number(statusAOnB),
      statusBOnA: Number(statusBOnA),
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
  } else if (action === "freezeClient") {
    const conflict = await submitConflict(ctx);
    trace = await writeTracePatch({ misbehaviour: { frozen: true, ...conflict } });
    message = `Submitted conflicting checkpoint evidence. Bank B client for Bank A is frozen at sequence ${conflict.sequence}.`;
  } else if (action === "recoverClient") {
    const recovery = await recoverBankBClientForA(ctx);
    trace = await writeTracePatch({ misbehaviour: { frozen: false, recovered: true, ...recovery } });
    message = `Recovered Bank B client for Bank A using successor validator epoch #${recovery.epochId}.`;
  } else if (action === "fullFlow") {
    for (const step of [
      "lock",
      "checkpointForward",
      "updateForwardClient",
      "proveForwardMint",
      "burn",
      "checkpointReverse",
      "updateReverseClient",
      "proveReverseUnlock",
    ]) {
      await runDemoAction(step);
    }
    message = "Completed the full lock/mint/burn/unescrow proof flow.";
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
