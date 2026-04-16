import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ethers } from "ethers";
import {
  buildMerkleProof,
  ethGetProof,
  finalizedHeaderObject,
  headerProducerAddress,
  hydrateExecutionStateRoot,
  loadArtifact,
  loadConfig,
  merkleRoot,
  normalizeRuntime,
  packetLeafStorageSlot,
  packetPathStorageSlot,
  pretty,
  providerFor,
  rlpEncodeWord,
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

async function finalizeSourceHeader(chainKey, cfg, artifacts) {
  const signer = await signerFor(cfg, chainKey, 0);
  const chain = cfg.chains[chainKey];
  const packetStore = new ethers.Contract(chain.packetStore, artifacts.packetStore.abi, signer);
  const headerProducer = new ethers.Contract(
    headerProducerAddress(chain),
    artifacts.checkpointRegistry.abi,
    signer
  );
  const packetSequence = await packetStore.packetSequence();
  const committed = await headerProducer.lastCommittedPacketSequence();
  if (packetSequence <= committed) {
    throw new Error(`[${chainKey}] no pending packet to finalize`);
  }
  await (await headerProducer.finalizeHeader(packetSequence)).wait();
  const header = finalizedHeaderObject(await headerProducer.headersByHeight(await headerProducer.headerHeight()));
  console.log(`[${chainKey}] finalized local header ${header.height} stateRoot=${pretty(header.stateRoot)}`);
  return header;
}

async function updateRemoteClient(sourceKey, destinationKey, header, cfg, artifacts) {
  const sourceProvider = providerFor(cfg, sourceKey);
  const destinationSigner = await signerFor(cfg, destinationKey, 0);
  const client = new ethers.Contract(cfg.chains[destinationKey].client, artifacts.client.abi, destinationSigner);
  const runtime = cfg.runtime || normalizeRuntime(cfg);
  header = await hydrateExecutionStateRoot(cfg, sourceKey, header, {
    strict: runtime.proofPolicy === "storage-required",
  });
  header.blockHash = await client.hashHeader(header);
  const consensusHash = await client.hashConsensusState(header);
  const commitDigest = await client.hashCommitment(header);
  const already = await client.consensusStateHashBySequence(cfg.chains[sourceKey].chainId, header.height);
  if (already === ethers.ZeroHash) {
    const signatures = await signaturesFor(sourceKey, sourceProvider, commitDigest);
    await (await client.updateState([header], signatures)).wait();
  }
  console.log(`[${destinationKey}] trusted ${sourceKey} header=${pretty(consensusHash)} height=${header.height}`);
  return consensusHash;
}

async function relayPacket(sourceKey, destinationKey, packet, header, consensusHash, cfg, artifacts) {
  const runtime = cfg.runtime || normalizeRuntime(cfg);
  const source = cfg.chains[sourceKey];
  const destination = cfg.chains[destinationKey];
  const sourceProvider = providerFor(cfg, sourceKey);
  const destinationSigner = await signerFor(cfg, destinationKey, 0);
  const packetStore = new ethers.Contract(source.packetStore, artifacts.packetStore.abi, sourceProvider);
  const client = new ethers.Contract(destination.client, artifacts.client.abi, destinationSigner);
  const handler = new ethers.Contract(destination.packetHandler, artifacts.handler.abi, destinationSigner);
  const packetId = await packetStore.packetIdAt(packet.sequence);
  const packetLeaf = await packetStore.packetLeafAt(packet.sequence);
  const packetPath = await packetStore.packetPathAt(packet.sequence);
  const trustedRoot = await client.trustedStateRoot(source.chainId, consensusHash);

  if (header.executionStateRoot !== ethers.ZeroHash && trustedRoot === header.executionStateRoot) {
    try {
      const proof = await ethGetProof(
        sourceProvider,
        source.packetStore,
        [packetLeafStorageSlot(packet.sequence), packetPathStorageSlot(packet.sequence)],
        header.sourceBlockNumber
      );
      const leafWitness = proof.storageProof.find(
        (entry) => entry.key.toLowerCase() === packetLeafStorageSlot(packet.sequence).toLowerCase()
      );
      const pathWitness = proof.storageProof.find(
        (entry) => entry.key.toLowerCase() === packetPathStorageSlot(packet.sequence).toLowerCase()
      );
      if (!leafWitness || !pathWitness) throw new Error("missing storage proof witness");

      const leafProof = {
        sourceChainId: BigInt(source.chainId),
        consensusStateHash: consensusHash,
        stateRoot: trustedRoot,
        account: source.packetStore,
        storageKey: packetLeafStorageSlot(packet.sequence),
        expectedValue: rlpEncodeWord(packetLeaf),
        accountProof: proof.accountProof,
        storageProof: leafWitness.proof,
      };
      const pathProof = {
        sourceChainId: BigInt(source.chainId),
        consensusStateHash: consensusHash,
        stateRoot: trustedRoot,
        account: source.packetStore,
        storageKey: packetPathStorageSlot(packet.sequence),
        expectedValue: rlpEncodeWord(packetPath),
        accountProof: proof.accountProof,
        storageProof: pathWitness.proof,
      };

      if (!(await handler.consumedPackets(packetId))) {
        await (await handler.recvPacketFromStorageProof(packet, leafProof, pathProof)).wait();
      }
      console.log(`[${destinationKey}] packet executed via storage proof packetId=${pretty(packetId)}`);
      return {
        packetId,
        packetRoot: header.packetRoot,
        stateRoot: header.stateRoot,
        executionStateRoot: trustedRoot,
        proofMode: "storage",
      };
    } catch (error) {
      if (!runtime.allowMerkleFallback) {
        throw new Error(
          `[${destinationKey}] Storage proof is required in ${runtime.mode} runtime, but proof execution failed: ${error.message}`
        );
      }
      console.warn(
        `[${destinationKey}] storage proof unavailable for ${sourceKey} packet ${pretty(packetId)}; falling back to packet-state Merkle proof`
      );
    }
  }

  if (!runtime.allowMerkleFallback) {
    throw new Error(
      `[${destinationKey}] Storage proof is required in ${runtime.mode} runtime, but the trusted execution state root was unavailable.`
    );
  }

  const leaves = [];
  for (let sequence = header.firstPacketSequence; sequence <= header.lastPacketSequence; sequence++) {
    const path = await packetStore.packetPathAt(sequence);
    const leaf = await packetStore.packetLeafAt(sequence);
    leaves.push(stateLeaf(path, leaf));
  }
  const root = merkleRoot(leaves);
  if (root !== header.stateRoot) throw new Error(`[${sourceKey}] state root mismatch`);
  const leafIndex = Number(packet.sequence - header.firstPacketSequence);
  const proof = [consensusHash, leafIndex, buildMerkleProof(leaves, leafIndex)];
  if (!(await handler.consumedPackets(packetId))) {
    await (await handler.recvPacket(packet, proof)).wait();
  }
  console.log(`[${destinationKey}] packet executed packetId=${pretty(packetId)} leafIndex=${leafIndex}`);
  return {
    packetId,
    leafIndex,
    packetRoot: header.packetRoot,
    stateRoot: root,
    executionStateRoot: trustedRoot !== header.stateRoot ? trustedRoot : ethers.ZeroHash,
    proofMode: "merkle",
  };
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
  const headerA = await finalizeSourceHeader("A", cfg, artifacts);
  const consensusA = await updateRemoteClient("A", "B", headerA, cfg, artifacts);
  const lockProof = await relayPacket("A", "B", forwardPacket, headerA, consensusA, cfg, artifacts);
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
  const headerB = await finalizeSourceHeader("B", cfg, artifacts);
  const consensusB = await updateRemoteClient("B", "A", headerB, cfg, artifacts);
  const burnProof = await relayPacket("B", "A", reversePacket, headerB, consensusB, cfg, artifacts);
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
      executionStateRoot: lockProof.executionStateRoot,
      proofMode: lockProof.proofMode,
      leafIndex: lockProof.leafIndex == null ? null : String(lockProof.leafIndex),
      headerHeight: headerA.height.toString(),
      headerHash: headerA.blockHash,
      consensusHash: consensusA,
    },
    reverse: {
      packetId: burnProof.packetId,
      packetRoot: burnProof.packetRoot,
      stateRoot: burnProof.stateRoot,
      executionStateRoot: burnProof.executionStateRoot,
      proofMode: burnProof.proofMode,
      leafIndex: burnProof.leafIndex == null ? null : String(burnProof.leafIndex),
      headerHeight: headerB.height.toString(),
      headerHash: headerB.blockHash,
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
