import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ethers } from "ethers";
import {
  buildMerkleProof,
  checkpointObject,
  loadArtifact,
  loadConfig,
  merkleRoot,
  pretty,
  providerFor,
  signaturesFor,
  signerFor,
  stateLeaf,
} from "./ibc-lite-common.mjs";

const ACTION_LOCK_MINT = 1;
const ACTION_BURN_UNLOCK = 2;
const TRANSFER_AMOUNT = ethers.parseUnits(process.env.DEMO_AMOUNT || "100", 18);
const BORROW_AMOUNT = ethers.parseUnits(process.env.DEMO_BORROW_AMOUNT || "50", 18);
const POOL_LIQUIDITY = ethers.parseUnits(process.env.POOL_LIQUIDITY || "10000", 18);
const UI_TRACE_PATH = resolve(process.cwd(), "demo", "latest-run.js");
const UI_TRACE_JSON_PATH = resolve(process.cwd(), "demo", "latest-run.json");

async function loadArtifacts() {
  return {
    app: await loadArtifact("apps/MinimalTransferApp.sol", "MinimalTransferApp"),
    bankToken: await loadArtifact("apps/BankToken.sol", "BankToken"),
    voucher: await loadArtifact("apps/VoucherToken.sol", "VoucherToken"),
    lendingPool: await loadArtifact("apps/CrossChainLendingPool.sol", "CrossChainLendingPool"),
    escrow: await loadArtifact("apps/EscrowVault.sol", "EscrowVault"),
    packetStore: await loadArtifact("source/SourcePacketCommitment.sol", "SourcePacketCommitment"),
    checkpointRegistry: await loadArtifact("source/SourceCheckpointRegistry.sol", "SourceCheckpointRegistry"),
    client: await loadArtifact("clients/BankChainClient.sol", "BankChainClient"),
    handler: await loadArtifact("core/IBCPacketHandler.sol", "IBCPacketHandler"),
  };
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

async function ensureSeed({ cfg, artifacts, ownerA, ownerB, userA }) {
  const canonical = new ethers.Contract(cfg.chains.A.canonicalToken, artifacts.bankToken.abi, ownerA);
  const debtToken = new ethers.Contract(cfg.chains.B.debtToken, artifacts.bankToken.abi, ownerB);
  const canonicalBalance = await canonical.balanceOf(await userA.getAddress());

  if (canonicalBalance < TRANSFER_AMOUNT) {
    const mintAmount = TRANSFER_AMOUNT * 5n;
    await (await canonical.mint(await userA.getAddress(), mintAmount)).wait();
    console.log(`[seed] minted ${ethers.formatUnits(mintAmount, 18)} aBANK to Bank A user`);
  }
  if ((await debtToken.balanceOf(cfg.chains.B.lendingPool)) < BORROW_AMOUNT) {
    await (await debtToken.mint(cfg.chains.B.lendingPool, POOL_LIQUIDITY)).wait();
    console.log(`[seed] funded Bank B lending pool with ${ethers.formatUnits(POOL_LIQUIDITY, 18)} bCASH`);
  }

  await (await canonical.connect(userA).approve(cfg.chains.A.escrowVault, ethers.MaxUint256)).wait();
}

async function commitSourceCheckpoint(chainKey, cfg, artifacts) {
  const signer = await signerFor(cfg, chainKey, 0);
  const chain = cfg.chains[chainKey];
  const packetStore = new ethers.Contract(chain.packetStore, artifacts.packetStore.abi, signer);
  const checkpointRegistry = new ethers.Contract(chain.checkpointRegistry, artifacts.checkpointRegistry.abi, signer);
  const packetSequence = await packetStore.packetSequence();
  const committed = await checkpointRegistry.lastCommittedPacketSequence();
  if (packetSequence <= committed) {
    throw new Error(`[${chainKey}] no pending packet to checkpoint`);
  }
  await (await checkpointRegistry.commitCheckpoint(packetSequence)).wait();
  const checkpoint = checkpointObject(await checkpointRegistry.checkpointsBySequence(await checkpointRegistry.checkpointSequence()));
  console.log(`[${chainKey}] source checkpoint ${checkpoint.sequence} committed stateRoot=${pretty(checkpoint.stateRoot)}`);
  return checkpoint;
}

async function updateRemoteClient(sourceKey, destinationKey, checkpoint, cfg, artifacts) {
  const sourceProvider = providerFor(cfg, sourceKey);
  const destinationSigner = await signerFor(cfg, destinationKey, 0);
  const client = new ethers.Contract(cfg.chains[destinationKey].client, artifacts.client.abi, destinationSigner);
  const consensusHash = await client.hashConsensusState(checkpoint);
  const already = await client.consensusStateHashBySequence(cfg.chains[sourceKey].chainId, checkpoint.sequence);
  if (already === ethers.ZeroHash) {
    const signatures = await signaturesFor(sourceProvider, consensusHash);
    await (await client.updateState([checkpoint], signatures)).wait();
  }
  console.log(`[${destinationKey}] trusted ${sourceKey} consensus=${pretty(consensusHash)} sequence=${checkpoint.sequence}`);
  return consensusHash;
}

async function relayPacket(sourceKey, destinationKey, packet, checkpoint, consensusHash, cfg, artifacts) {
  const source = cfg.chains[sourceKey];
  const destination = cfg.chains[destinationKey];
  const sourceProvider = providerFor(cfg, sourceKey);
  const destinationSigner = await signerFor(cfg, destinationKey, 0);
  const packetStore = new ethers.Contract(source.packetStore, artifacts.packetStore.abi, sourceProvider);
  const handler = new ethers.Contract(destination.packetHandler, artifacts.handler.abi, destinationSigner);
  const leaves = [];
  for (let sequence = checkpoint.firstPacketSequence; sequence <= checkpoint.lastPacketSequence; sequence++) {
    const path = await packetStore.packetPathAt(sequence);
    const leaf = await packetStore.packetLeafAt(sequence);
    leaves.push(stateLeaf(path, leaf));
  }
  const root = merkleRoot(leaves);
  if (root !== checkpoint.stateRoot) throw new Error(`[${sourceKey}] state root mismatch`);
  const leafIndex = Number(packet.sequence - checkpoint.firstPacketSequence);
  const proof = [consensusHash, leafIndex, buildMerkleProof(leaves, leafIndex)];
  const packetId = await packetStore.packetIdAt(packet.sequence);
  if (!(await handler.consumedPackets(packetId))) {
    await (await handler.recvPacket(packet, proof)).wait();
  }
  console.log(`[${destinationKey}] packet executed packetId=${pretty(packetId)} leafIndex=${leafIndex}`);
  return { packetId, leafIndex, packetRoot: checkpoint.packetRoot, stateRoot: root };
}

async function writeUiTrace(trace) {
  const contents = `window.IBCLiteLatestRun = ${JSON.stringify(trace, null, 2)};\n`;
  await writeFile(UI_TRACE_PATH, contents);
  await writeFile(UI_TRACE_JSON_PATH, `${JSON.stringify(trace, null, 2)}\n`);
  console.log(`[ui] wrote latest real trace to demo/latest-run.js`);
}

async function main() {
  const cfg = await loadConfig();
  const artifacts = await loadArtifacts();
  const ownerA = await signerFor(cfg, "A", 0);
  const ownerB = await signerFor(cfg, "B", 0);
  const userA = await signerFor(cfg, "A", Number(process.env.USER_INDEX || 1));
  const userB = await signerFor(cfg, "B", Number(process.env.USER_INDEX || 1));

  await ensureSeed({ cfg, artifacts, ownerA, ownerB, userA });

  const appA = new ethers.Contract(cfg.chains.A.transferApp, artifacts.app.abi, userA);
  const appB = new ethers.Contract(cfg.chains.B.transferApp, artifacts.app.abi, userB);
  const voucher = new ethers.Contract(cfg.chains.B.voucherToken, artifacts.voucher.abi, userB);
  const debtToken = new ethers.Contract(cfg.chains.B.debtToken, artifacts.bankToken.abi, userB);
  const lendingPool = new ethers.Contract(cfg.chains.B.lendingPool, artifacts.lendingPool.abi, userB);
  const escrow = new ethers.Contract(cfg.chains.A.escrowVault, artifacts.escrow.abi, ownerA);

  console.log("\n=== Forward path: Bank A escrow -> Bank B voucher ===");
  await (await appA.sendTransfer(cfg.chains.B.chainId, await userB.getAddress(), TRANSFER_AMOUNT)).wait();
  const forwardSequence = await new ethers.Contract(cfg.chains.A.packetStore, artifacts.packetStore.abi, providerFor(cfg, "A")).packetSequence();
  const forwardPacket = packetTuple({
    sequence: forwardSequence,
    sourceChainId: BigInt(cfg.chains.A.chainId),
    destinationChainId: BigInt(cfg.chains.B.chainId),
    sourcePort: cfg.chains.A.transferApp,
    destinationPort: cfg.chains.B.transferApp,
    sender: await userA.getAddress(),
    recipient: await userB.getAddress(),
    asset: cfg.chains.A.canonicalToken,
    amount: TRANSFER_AMOUNT,
    action: ACTION_LOCK_MINT,
  });
  const checkpointA = await commitSourceCheckpoint("A", cfg, artifacts);
  const consensusA = await updateRemoteClient("A", "B", checkpointA, cfg, artifacts);
  const lockProof = await relayPacket("A", "B", forwardPacket, checkpointA, consensusA, cfg, artifacts);
  console.log(`[B] voucher balance=${ethers.formatUnits(await voucher.balanceOf(await userB.getAddress()), 18)} vA`);

  console.log("\n=== Lending use case: verified voucher -> Bank B credit ===");
  await (await voucher.approve(await lendingPool.getAddress(), TRANSFER_AMOUNT)).wait();
  await (await lendingPool.depositCollateral(TRANSFER_AMOUNT)).wait();
  await (await lendingPool.borrow(BORROW_AMOUNT)).wait();
  console.log(`[B] borrowed=${ethers.formatUnits(BORROW_AMOUNT, 18)} bCASH against proven cross-chain voucher`);
  await (await debtToken.approve(await lendingPool.getAddress(), BORROW_AMOUNT)).wait();
  await (await lendingPool.repay(BORROW_AMOUNT)).wait();
  await (await lendingPool.withdrawCollateral(TRANSFER_AMOUNT)).wait();
  console.log(`[B] loan repaid; voucher collateral withdrawn for reverse burn path`);

  console.log("\n=== Reverse path: Bank B burn -> Bank A unescrow ===");
  await (await appB.burnAndRelease(cfg.chains.A.chainId, await userA.getAddress(), TRANSFER_AMOUNT)).wait();
  const reverseSequence = await new ethers.Contract(cfg.chains.B.packetStore, artifacts.packetStore.abi, providerFor(cfg, "B")).packetSequence();
  const reversePacket = packetTuple({
    sequence: reverseSequence,
    sourceChainId: BigInt(cfg.chains.B.chainId),
    destinationChainId: BigInt(cfg.chains.A.chainId),
    sourcePort: cfg.chains.B.transferApp,
    destinationPort: cfg.chains.A.transferApp,
    sender: await userB.getAddress(),
    recipient: await userA.getAddress(),
    asset: cfg.chains.B.voucherToken,
    amount: TRANSFER_AMOUNT,
    action: ACTION_BURN_UNLOCK,
  });
  const checkpointB = await commitSourceCheckpoint("B", cfg, artifacts);
  const consensusB = await updateRemoteClient("B", "A", checkpointB, cfg, artifacts);
  const burnProof = await relayPacket("B", "A", reversePacket, checkpointB, consensusB, cfg, artifacts);
  console.log(`[A] escrow total=${ethers.formatUnits(await escrow.totalEscrowed(), 18)} aBANK`);

  await writeUiTrace({
    generatedAt: new Date().toISOString(),
    amount: ethers.formatUnits(TRANSFER_AMOUNT, 18),
    userA: await userA.getAddress(),
    userB: await userB.getAddress(),
    lending: {
      collateralAmount: ethers.formatUnits(TRANSFER_AMOUNT, 18),
      borrowedAmount: ethers.formatUnits(BORROW_AMOUNT, 18),
      debtToken: cfg.chains.B.debtToken,
      lendingPool: cfg.chains.B.lendingPool,
      completed: true,
    },
    forward: {
      packetId: lockProof.packetId,
      packetRoot: lockProof.packetRoot,
      stateRoot: lockProof.stateRoot,
      leafIndex: String(lockProof.leafIndex),
      checkpointSequence: checkpointA.sequence.toString(),
      checkpointHash: checkpointA.sourceCommitmentHash,
      consensusHash: consensusA,
    },
    reverse: {
      packetId: burnProof.packetId,
      packetRoot: burnProof.packetRoot,
      stateRoot: burnProof.stateRoot,
      leafIndex: String(burnProof.leafIndex),
      checkpointSequence: checkpointB.sequence.toString(),
      checkpointHash: checkpointB.sourceCommitmentHash,
      consensusHash: consensusB,
    },
  });

  console.log("\n=== Trace ===");
  console.log(`lockPacketId       ${lockProof.packetId}`);
  console.log(`burnPacketId       ${burnProof.packetId}`);
  console.log(`A consensus hash   ${consensusA}`);
  console.log(`B consensus hash   ${consensusB}`);
  console.log("IBC-lite transfer proof flow complete.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
