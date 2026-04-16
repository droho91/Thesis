import { access, readFile, writeFile } from "node:fs/promises";
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
  packetCommitmentPath,
  providerFor,
  rlpEncodeWord,
  signaturesFor,
  signerFor,
  stateLeaf,
  validatorAddresses,
} from "./ibc-lite-common.mjs";

const ACTION_LOCK_MINT = 1;
const ACTION_BURN_UNLOCK = 2;
const PACKET_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes("IBCLite.Packet.v1"));
const PACKET_LEAF_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes("IBCLite.PacketLeaf.v1"));
const TRANSFER_AMOUNT = ethers.parseUnits(process.env.DEMO_AMOUNT || "100", 18);
const BORROW_AMOUNT = ethers.parseUnits(process.env.DEMO_BORROW_AMOUNT || "50", 18);
const POOL_LIQUIDITY = ethers.parseUnits(process.env.POOL_LIQUIDITY || "10000", 18);
const TRACE_JSON_PATH = resolve(process.cwd(), "demo", "latest-run.json");
const TRACE_JS_PATH = resolve(process.cwd(), "demo", "latest-run.js");
const CONFIG_PATH = resolve(process.cwd(), ".ibc-lite.local.json");
const RECOVERY_VALIDATOR_INDICES = (
  process.env.RECOVERY_VALIDATOR_INDICES || (process.env.USE_BESU_KEYS === "true" ? "1,2,3" : "6,7,8")
)
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
  const runtime = normalizeRuntime();
  if (!(await configExists())) {
    return {
      ready: false,
      deployed: false,
      label: "No deployment",
      runtime,
      message: runtime.besuFirst
        ? "Start the Besu bank chains with npm run besu:generate and npm run besu:up, then press Deploy + Seed."
        : "Start both local chains, then press Deploy + Seed.",
    };
  }

  const cfg = await loadConfig();
  const cfgRuntime = cfg.runtime || runtime;
  const [chainA, chainB] = await Promise.all([probeRpc(cfg.chains.A.rpc), probeRpc(cfg.chains.B.rpc)]);
  const missing = [];
  if (!chainA.ok) missing.push(`Bank A ${cfg.chains.A.rpc}`);
  if (!chainB.ok) missing.push(`Bank B ${cfg.chains.B.rpc}`);

  if (missing.length > 0) {
    return {
      ready: false,
      deployed: false,
      label: "Chains offline",
      runtime: cfgRuntime,
      message: cfgRuntime.besuFirst
        ? `Besu bank-chain RPC not reachable: ${missing.join(", ")}. Start npm run besu:generate and npm run besu:up.`
        : `Local chain RPC not reachable: ${missing.join(", ")}. Start npm run node:chainA and npm run node:chainB.`,
      chains: { A: chainA, B: chainB },
    };
  }

  const required = [
    ["A", "packetStore"],
    ["A", "validatorRegistry"],
    ["A", "headerProducer"],
    ["A", "client"],
    ["A", "packetHandler"],
    ["A", "canonicalToken"],
    ["A", "escrowVault"],
    ["A", "transferApp"],
    ["B", "packetStore"],
    ["B", "validatorRegistry"],
    ["B", "headerProducer"],
    ["B", "client"],
    ["B", "packetHandler"],
    ["B", "voucherToken"],
    ["B", "debtToken"],
    ["B", "lendingPool"],
    ["B", "transferApp"],
  ];
  const missingFields = required
    .filter(([chainKey, field]) => !cfg.chains?.[chainKey]?.[field])
    .map(([chainKey, field]) => `${chainKey}.${field}`);
  if (missingFields.length > 0) {
    return {
      ready: false,
      deployed: false,
      label: "Stale deployment",
      runtime: cfgRuntime,
      message: `Deployment config is from an older stack and is missing: ${missingFields.join(", ")}. Press Deploy + Seed.`,
      chains: { A: chainA, B: chainB },
    };
  }

  const providerA = providerFor(cfg, "A");
  const providerB = providerFor(cfg, "B");
  const codeChecks = await Promise.all([
    providerA.getCode(cfg.chains.A.escrowVault),
    providerA.getCode(cfg.chains.A.transferApp),
    providerB.getCode(cfg.chains.B.voucherToken),
    providerB.getCode(cfg.chains.B.lendingPool),
  ]);
  if (codeChecks.some((code) => code === "0x")) {
    return {
      ready: false,
      deployed: false,
      label: "Stale deployment",
      runtime: cfgRuntime,
      message: "Local chains are running, but configured contract addresses have no code. Press Deploy + Seed after starting fresh local chains.",
      chains: { A: chainA, B: chainB },
    };
  }

  return { ready: true, deployed: true, cfg, runtime: cfgRuntime, chains: { A: chainA, B: chainB } };
}

async function loadArtifacts() {
  return {
    app: await loadArtifact("apps/MinimalTransferApp.sol", "MinimalTransferApp"),
    bankToken: await loadArtifact("apps/BankToken.sol", "BankToken"),
    voucher: await loadArtifact("apps/VoucherToken.sol", "VoucherToken"),
    lendingPool: await loadArtifact("apps/CrossChainLendingPool.sol", "CrossChainLendingPool"),
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

function zeroHash(value) {
  return !value || value === ethers.ZeroHash;
}

function normalizeFlowTrace(flow) {
  if (!flow || typeof flow !== "object" || Array.isArray(flow)) return flow;
  return {
    ...flow,
    headerHeight: flow.headerHeight ?? flow.checkpointSequence,
    headerHash: flow.headerHash ?? flow.checkpointHash,
  };
}

function normalizeTrace(trace) {
  if (!trace || typeof trace !== "object" || Array.isArray(trace)) return trace;

  const misbehaviour =
    trace.misbehaviour && typeof trace.misbehaviour === "object" && !Array.isArray(trace.misbehaviour)
      ? {
          ...trace.misbehaviour,
          height: trace.misbehaviour.height ?? trace.misbehaviour.sequence,
        }
      : trace.misbehaviour;

  return {
    ...trace,
    forward: normalizeFlowTrace(trace.forward),
    reverse: normalizeFlowTrace(trace.reverse),
    misbehaviour,
  };
}

async function consensusSummary(client, sourceChainId, consensusHash) {
  if (zeroHash(consensusHash)) return null;
  const state = await client.consensusState(sourceChainId, consensusHash);
  return {
    consensusHash,
    validatorEpochId: state.validatorEpochId.toString(),
    validatorEpochHash: state.validatorEpochHash,
    headerHeight: state.height.toString(),
    blockHash: state.blockHash,
    packetRoot: state.packetRoot,
    stateRoot: state.stateRoot,
    executionStateRoot: state.executionStateRoot,
    packetRange: `${state.firstPacketSequence.toString()}-${state.lastPacketSequence.toString()}`,
    packetCount: state.packetCount.toString(),
    sourceBlockNumber: state.sourceBlockNumber.toString(),
    sourceBlockHash: state.sourceBlockHash,
  };
}

async function bindHeaderHash(client, header) {
  header.blockHash = await client.hashHeader(header);
  return header;
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
  const { cfg, artifacts } = ctx;
  const headerProducer = new ethers.Contract(
    headerProducerAddress(cfg.chains[chainKey]),
    artifacts.checkpointRegistry.abi,
    providerFor(cfg, chainKey)
  );
  const height = await headerProducer.headerHeight();
  if (height === 0n) throw new Error(`[${chainKey}] No finalized header exists yet.`);
  return finalizedHeaderObject(await headerProducer.headersByHeight(height));
}

async function finalizeHeader(chainKey, ctx) {
  const { cfg, artifacts } = ctx;
  const signer = await signerFor(cfg, chainKey, 0);
  const chain = cfg.chains[chainKey];
  const packetStore = new ethers.Contract(chain.packetStore, artifacts.packetStore.abi, signer);
  const headerProducer = new ethers.Contract(headerProducerAddress(chain), artifacts.checkpointRegistry.abi, signer);
  const packetSequence = await packetStore.packetSequence();
  const committed = await headerProducer.lastCommittedPacketSequence();

  if (packetSequence === 0n) throw new Error(`[${chainKey}] No packet has been written yet.`);
  if (packetSequence > committed) {
    await (await headerProducer.finalizeHeader(packetSequence)).wait();
  }

  return latestFinalizedHeader(chainKey, ctx);
}

async function updateRemoteClient(sourceKey, destinationKey, ctx) {
  const { cfg, artifacts } = ctx;
  const runtime = cfg.runtime || normalizeRuntime(cfg);
  const header = await hydrateExecutionStateRoot(cfg, sourceKey, await latestFinalizedHeader(sourceKey, ctx), {
    strict: runtime.proofPolicy === "storage-required",
  });
  const sourceProvider = providerFor(cfg, sourceKey);
  const destinationSigner = await signerFor(cfg, destinationKey, 0);
  const client = new ethers.Contract(cfg.chains[destinationKey].client, artifacts.client.abi, destinationSigner);
  const finalizedHeader = await bindHeaderHash(client, header);
  const consensusHash = await client.hashConsensusState(finalizedHeader);
  const commitDigest = await client.hashCommitment(finalizedHeader);
  const already = await client.consensusStateHashBySequence(cfg.chains[sourceKey].chainId, finalizedHeader.height);

  if (already === ethers.ZeroHash) {
    const signatures = await signaturesFor(sourceKey, sourceProvider, commitDigest);
    await (await client.updateState([finalizedHeader], signatures)).wait();
  }

  return { header: finalizedHeader, consensusHash };
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
  const destinationSigner = await signerFor(cfg, destinationKey, 0);
  const sourceProvider = providerFor(cfg, sourceKey);
  const source = cfg.chains[sourceKey];
  const destination = cfg.chains[destinationKey];
  const client = new ethers.Contract(destination.client, artifacts.client.abi, destinationSigner);
  const packetStore = new ethers.Contract(source.packetStore, artifacts.packetStore.abi, sourceProvider);
  const handler = new ethers.Contract(destination.packetHandler, artifacts.handler.abi, destinationSigner);
  const consensusHash = await client.consensusStateHashBySequence(source.chainId, header.height);
  if (consensusHash === ethers.ZeroHash) {
    throw new Error(`[${destinationKey}] Remote client has not trusted header #${header.height}.`);
  }
  const trustedRoot = await client.trustedStateRoot(source.chainId, consensusHash);
  const packet = await packetFor(sourceKey, destinationKey, action, ctx, header.lastPacketSequence);
  const packetId = await packetStore.packetIdAt(packet.sequence);
  const packetLeaf = await packetStore.packetLeafAt(packet.sequence);
  const packetPath = await packetStore.packetPathAt(packet.sequence);

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

      await (await handler.recvPacketFromStorageProof(packet, leafProof, pathProof)).wait();

      return {
        packetId,
        leafIndex: null,
        header,
        packetRoot: header.packetRoot,
        stateRoot: header.stateRoot,
        executionStateRoot: trustedRoot,
        consensusHash,
        proofMode: "storage",
      };
    } catch (error) {
      if (!runtime.allowMerkleFallback) {
        throw new Error(
          `[${destinationKey}] Storage proof is required in ${runtime.mode} runtime, but proof execution failed: ${error.message}`
        );
      }
      console.warn(
        `[${destinationKey}] storage proof unavailable for ${sourceKey} packet ${short(packetId)}; falling back to packet-state Merkle proof`
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
  if (root !== header.stateRoot) throw new Error(`[${sourceKey}] State root mismatch.`);
  const leafIndex = Number(packet.sequence - header.firstPacketSequence);

  await (await handler.recvPacket(packet, [consensusHash, leafIndex, buildMerkleProof(leaves, leafIndex)])).wait();

  return {
    packetId,
    leafIndex,
    header,
    packetRoot: header.packetRoot,
    stateRoot: root,
    executionStateRoot: trustedRoot !== header.stateRoot ? trustedRoot : ethers.ZeroHash,
    consensusHash,
    proofMode: "merkle",
  };
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
  const { cfg, artifacts } = ctx;
  const sourceProvider = providerFor(cfg, "A");
  const destinationSigner = await signerFor(cfg, "B", 0);
  const client = new ethers.Contract(cfg.chains.B.client, artifacts.client.abi, destinationSigner);
  const header = await latestFinalizedHeader("A", ctx);
  const existing = await client.consensusStateHashBySequence(cfg.chains.A.chainId, header.height);
  if (existing === ethers.ZeroHash) throw new Error("Bank B must trust an A header before conflict evidence can freeze it.");

  header.packetRoot = ethers.keccak256(ethers.toUtf8Bytes(`conflict:A:${Date.now()}`));
  header.stateRoot = ethers.keccak256(ethers.toUtf8Bytes(`conflict-state:A:${Date.now()}`));
  header.blockHash = await client.hashHeader(header);
  const conflictHash = await client.hashConsensusState(header);
  const commitDigest = await client.hashCommitment(header);
  const signatures = await signaturesFor("A", sourceProvider, commitDigest);
  await (await client.updateState([header], signatures)).wait();
  return { conflictHash, height: header.height.toString() };
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
  const validators = await validatorAddresses("A", sourceProvider, RECOVERY_VALIDATOR_INDICES);
  const powers = validators.map(() => 1n);

  await (await client.beginRecovery(cfg.chains.A.chainId)).wait();
  await (await validatorRegistry.commitValidatorEpoch(nextEpochId, validators, powers)).wait();
  const epoch = validatorEpochObject(await validatorRegistry.validatorEpoch(nextEpochId));
  const signatures = await signaturesFor("A", sourceProvider, epoch.epochHash);
  await (await client.updateValidatorEpoch(epoch, signatures)).wait();
  return { epochId: nextEpochId.toString(), epochHash: epoch.epochHash };
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
  const debtToken = cfg.chains.B.debtToken
    ? new ethers.Contract(cfg.chains.B.debtToken, artifacts.bankToken.abi, providerFor(cfg, "B"))
    : null;
  const lendingPool = cfg.chains.B.lendingPool
    ? new ethers.Contract(cfg.chains.B.lendingPool, artifacts.lendingPool.abi, providerFor(cfg, "B"))
    : null;
  const packetA = new ethers.Contract(cfg.chains.A.packetStore, artifacts.packetStore.abi, providerFor(cfg, "A"));
  const packetB = new ethers.Contract(cfg.chains.B.packetStore, artifacts.packetStore.abi, providerFor(cfg, "B"));
  const headerProducerA = new ethers.Contract(
    headerProducerAddress(cfg.chains.A),
    artifacts.checkpointRegistry.abi,
    providerFor(cfg, "A")
  );
  const headerProducerB = new ethers.Contract(
    headerProducerAddress(cfg.chains.B),
    artifacts.checkpointRegistry.abi,
    providerFor(cfg, "B")
  );
  const clientA = new ethers.Contract(cfg.chains.A.client, artifacts.client.abi, providerFor(cfg, "A"));
  const clientB = new ethers.Contract(cfg.chains.B.client, artifacts.client.abi, providerFor(cfg, "B"));
  const handlerA = new ethers.Contract(cfg.chains.A.packetHandler, artifacts.handler.abi, providerFor(cfg, "A"));
  const handlerB = new ethers.Contract(cfg.chains.B.packetHandler, artifacts.handler.abi, providerFor(cfg, "B"));

  let trace = null;
  try {
    trace = normalizeTrace(JSON.parse(await readFile(TRACE_JSON_PATH, "utf8")));
  } catch {
    trace = null;
  }

  const [
    bankABalance,
    escrowTotal,
    voucherBalance,
    bankBBalance,
    poolCollateral,
    poolDebt,
    poolLiquidity,
    packetSequenceA,
    packetSequenceB,
    headerHeightA,
    headerHeightB,
    trustedAOnB,
    trustedBOnA,
    statusAOnB,
    statusBOnA,
    activeEpochAOnB,
    activeEpochBOnA,
    consensusHashAOnB,
    consensusHashBOnA,
    sourceBlockAOnB,
    sourceBlockBOnA,
  ] = await Promise.all([
    canonical.balanceOf(userAAddress),
    escrow.totalEscrowed(),
    voucher.balanceOf(userBAddress),
    debtToken ? debtToken.balanceOf(userBAddress) : 0n,
    lendingPool ? lendingPool.collateralBalance(userBAddress) : 0n,
    lendingPool ? lendingPool.debtBalance(userBAddress) : 0n,
    debtToken && lendingPool ? debtToken.balanceOf(cfg.chains.B.lendingPool) : 0n,
    packetA.packetSequence(),
    packetB.packetSequence(),
    headerProducerA.headerHeight(),
    headerProducerB.headerHeight(),
    clientB.latestConsensusStateSequence(cfg.chains.A.chainId),
    clientA.latestConsensusStateSequence(cfg.chains.B.chainId),
    clientB.status(cfg.chains.A.chainId),
    clientA.status(cfg.chains.B.chainId),
    clientB.activeValidatorEpochId(cfg.chains.A.chainId),
    clientA.activeValidatorEpochId(cfg.chains.B.chainId),
    clientB.latestConsensusStateHash(cfg.chains.A.chainId),
    clientA.latestConsensusStateHash(cfg.chains.B.chainId),
    clientB.latestSourceBlockNumber(cfg.chains.A.chainId),
    clientA.latestSourceBlockNumber(cfg.chains.B.chainId),
  ]);

  const [trustedAOnBSummary, trustedBOnASummary, forwardConsumed, reverseConsumed] = await Promise.all([
    consensusSummary(clientB, cfg.chains.A.chainId, consensusHashAOnB),
    consensusSummary(clientA, cfg.chains.B.chainId, consensusHashBOnA),
    trace?.forward?.packetId ? handlerB.consumedPackets(trace.forward.packetId) : false,
    trace?.reverse?.packetId ? handlerA.consumedPackets(trace.reverse.packetId) : false,
  ]);

  return {
    deployed: true,
    runtime: health.runtime || cfg.runtime || normalizeRuntime(cfg),
    userA: userAAddress,
    userB: userBAddress,
    amount: units(TRANSFER_AMOUNT),
    balances: {
      bankA: units(bankABalance),
      escrow: units(escrowTotal),
      voucher: units(voucherBalance),
      bankB: units(bankBBalance),
      poolCollateral: units(poolCollateral),
      poolDebt: units(poolDebt),
      poolLiquidity: units(poolLiquidity),
    },
    progress: {
      packetSequenceA: packetSequenceA.toString(),
      packetSequenceB: packetSequenceB.toString(),
      headerHeightA: headerHeightA.toString(),
      headerHeightB: headerHeightB.toString(),
      trustedAOnB: trustedAOnB.toString(),
      trustedBOnA: trustedBOnA.toString(),
      statusAOnB: Number(statusAOnB),
      statusBOnA: Number(statusBOnA),
      activeEpochAOnB: activeEpochAOnB.toString(),
      activeEpochBOnA: activeEpochBOnA.toString(),
      consensusHashAOnB,
      consensusHashBOnA,
      sourceBlockAOnB: sourceBlockAOnB.toString(),
      sourceBlockBOnA: sourceBlockBOnA.toString(),
    },
    trust: {
      aOnB: trustedAOnBSummary,
      bOnA: trustedBOnASummary,
    },
    security: {
      forwardConsumed,
      reverseConsumed,
      replayBlocked: Boolean(forwardConsumed || trace?.security?.replayBlocked),
      nonMembershipImplemented: true,
      nonMembership: trace?.security?.nonMembership || null,
      frozen: Number(statusAOnB) === 2 || Number(statusBOnA) === 2,
      recovering: Number(statusAOnB) === 3 || Number(statusBOnA) === 3,
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
