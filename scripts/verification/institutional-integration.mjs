import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { ethers } from "ethers";
import { readJson, writeJsonAtomic } from "../../services/shared/json-file.mjs";
import { createTransactionWaiter } from "../../services/shared/transaction-receipt.mjs";
import {
  defaultBesuRuntimeEnv,
  loadArtifact,
  providerForRpc,
  readLatestBlock,
  signerForRpc,
} from "../ops/besu/runtime.mjs";
import { AttestorJournal } from "../../services/institutional-relay/attestor-journal.mjs";
import { CheckpointAttestor } from "../../services/institutional-relay/checkpoint-attestor.mjs";
import { createAttestorHttpServer } from "../../services/institutional-relay/attestor-http-server.mjs";
import { createEthersLaneWorkflow } from "../../services/institutional-relay/ethers-lane-workflow.mjs";
import { InstitutionalRelayEngine } from "../../services/institutional-relay/relay-engine.mjs";
import { RelayJournal } from "../../services/institutional-relay/relay-journal.mjs";
import { summarizeBenchmark } from "./institutional-integration/benchmark.mjs";
import {
  collectValidatorAvailabilityEvidence,
} from "./institutional-integration/validator-availability-evidence.mjs";
import { createLiveClientProofCollector } from "./live-client-proof-evidence.mjs";

const DEPLOYMENT_PATH = resolve(
  process.cwd(),
  process.env.INSTITUTIONAL_DEPLOYMENT_PATH || ".runtime/institutional-deployment.json",
);
const ATTESTOR_SECRETS_PATH = resolve(
  process.cwd(),
  process.env.INSTITUTIONAL_ATTESTOR_SECRETS_PATH || ".runtime/institutional-attestor-secrets.json",
);
const REPORT_PATH = resolve(
  process.cwd(),
  process.env.INSTITUTIONAL_INTEGRATION_REPORT_PATH || ".runtime/institutional-integration-report.json",
);
const RUN_ROOT = resolve(process.cwd(), ".runtime/institutional-integration");
const TX_TIMEOUT_MS = Number(process.env.INSTITUTIONAL_TX_TIMEOUT_MS || 90_000);
const FLOW_TIMEOUT_MS = Number(process.env.INSTITUTIONAL_FLOW_TIMEOUT_MS || 180_000);
const BENCHMARK_MESSAGES = Math.max(1, Number(process.env.INSTITUTIONAL_BENCHMARK_MESSAGES || 3));
const BENCHMARK_REQUIRED_SAMPLES = Math.max(1, Number(process.env.INSTITUTIONAL_BENCHMARK_REQUIRED_SAMPLES || 100));
const BENCHMARK_TARGET_P95_MS = Math.max(1, Number(process.env.INSTITUTIONAL_BENCHMARK_TARGET_P95_MS || 45_000));
const ENFORCE_BENCHMARK = process.env.INSTITUTIONAL_ENFORCE_BENCHMARK === "true";
const BRIDGE_AMOUNT = ethers.parseEther("1000");
const BENCHMARK_AMOUNT = ethers.parseEther("10");
const COLLATERAL_AMOUNT = ethers.parseEther("600");
const BORROW_AMOUNT = ethers.parseEther("200");
const RETURN_AMOUNT = ethers.parseEther("200");
const CHAOS_AMOUNT = ethers.parseEther("5");
const ENGINE_RELOAD_AMOUNT = ethers.parseEther("7");
const MINIMUM_POOL_LIQUIDITY = ethers.parseEther("100000");
const waitForTx = createTransactionWaiter({
  timeoutMs: TX_TIMEOUT_MS,
  timeoutMessage: ({ label, hash }) => `${label} timed out; tx=${hash}`,
  failureMessage: ({ label, hash }) => `${label} failed; tx=${hash}`,
});

defaultBesuRuntimeEnv();

let attestorCluster;
let activeRelay;
let report = {
  version: "institutional-integration-report-v3",
  status: "running",
  startedAt: new Date().toISOString(),
  tests: {},
};
const liveClientProofCollector = createLiveClientProofCollector();

async function main() {
  const manifest = await readJson(DEPLOYMENT_PATH);
  const secrets = await readJson(ATTESTOR_SECRETS_PATH);
  validateInputs(manifest, secrets);
  const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const runDirectory = resolve(RUN_ROOT, runId);
  await mkdir(runDirectory, { recursive: true });

  const providers = {
    A: providerForRpc(manifest.chains.A.rpc),
    B: providerForRpc(manifest.chains.B.rpc),
  };
  const users = {
    A: await signerForRpc(manifest.chains.A.rpc, "A", 1),
    B: await signerForRpc(manifest.chains.B.rpc, "B", 1),
  };
  const owners = {
    B: await signerForRpc(manifest.chains.B.rpc, "B", 0),
  };
  const relaySigners = {
    A: await signerForRpc(manifest.chains.A.rpc, "A", 2),
    B: await signerForRpc(manifest.chains.B.rpc, "B", 2),
  };
  const artifacts = await loadArtifacts();
  const contracts = createContracts({ manifest, users, owners, artifacts });

  report.runId = runId;
  report.environment = {
    chainA: await chainSnapshot(providers.A, manifest.chains.A),
    chainB: await chainSnapshot(providers.B, manifest.chains.B),
    checkpointModel: manifest.securityProfile.checkpointModel,
    finalityDepth: manifest.securityProfile.finalityDepth,
    ...(await collectValidatorAvailabilityEvidence()),
  };

  attestorCluster = await startAttestorCluster({ manifest, secrets, providers, runDirectory });
  let relay = await createRelayRuntime({
    manifest,
    relaySigners,
    endpoints: attestorCluster.endpoints,
    runDirectory,
    proofObserver: liveClientProofCollector.observeAcceptedProof,
  });
  activeRelay = relay;

  await ensureAllowance(
    contracts.canonicalTokenA,
    await contracts.escrowVaultA.getAddress(),
    await users.A.getAddress(),
    BRIDGE_AMOUNT + BigInt(BENCHMARK_MESSAGES) * BENCHMARK_AMOUNT + CHAOS_AMOUNT + ENGINE_RELOAD_AMOUNT,
  );
  await ensurePoolLiquidity(contracts, owners.B);

  const benchmarkSamples = [];
  let primaryMessage;
  for (let index = 0; index < BENCHMARK_MESSAGES; index++) {
    const amount = index === 0 ? BRIDGE_AMOUNT : BENCHMARK_AMOUNT;
    const sample = await executeBridge({
      direction: "A-to-B",
      sourceApp: contracts.collateralAppA,
      sourceGateway: contracts.gatewayA,
      destinationToken: contracts.voucherTokenB,
      destinationAccount: await users.B.getAddress(),
      destinationChainId: BigInt(manifest.chains.B.chainId),
      amount,
      relay,
      label: `benchmark-${index + 1}`,
      send: (timeout, reference) =>
        contracts.collateralAppA.lockAndMint(
          manifest.chains.B.chainId,
          users.B.getAddress(),
          amount,
          timeout,
          reference,
          txOptions(),
        ),
    });
    benchmarkSamples.push(sample);
    if (index === 0) primaryMessage = sample;
  }
  report.tests.lockMint = {
    status: "passed",
    messageId: primaryMessage.messageId,
    sourceTransaction: primaryMessage.sourceTransaction,
    voucherDelta: primaryMessage.destinationBalanceDelta,
  };
  report.benchmark = summarizeBenchmark(benchmarkSamples, {
    requiredSamples: BENCHMARK_REQUIRED_SAMPLES,
    targetP95Ms: BENCHMARK_TARGET_P95_MS,
  });

  report.tests.lending = await executeLending({ contracts, user: users.B });

  const returnFlow = await executeBridge({
    direction: "B-to-A",
    sourceApp: contracts.collateralAppB,
    sourceGateway: contracts.gatewayB,
    destinationToken: contracts.canonicalTokenA,
    destinationAccount: await users.A.getAddress(),
    destinationChainId: BigInt(manifest.chains.A.chainId),
    amount: RETURN_AMOUNT,
    relay,
    label: "burn-unlock",
    send: (timeout, reference) =>
      contracts.collateralAppB.burnAndUnlock(
        manifest.chains.A.chainId,
        users.A.getAddress(),
        RETURN_AMOUNT,
        timeout,
        reference,
        txOptions(),
      ),
  });
  report.tests.burnUnlock = {
    status: "passed",
    messageId: returnFlow.messageId,
    sourceTransaction: returnFlow.sourceTransaction,
    canonicalBalanceDelta: returnFlow.destinationBalanceDelta,
    endToEndMs: returnFlow.endToEndMs,
  };

  report.tests.quorumOutage = await testQuorumOutage({
    manifest,
    contracts,
    users,
    relay,
    cluster: attestorCluster,
  });

  const reloadResult = await testEngineReloadRecovery({
    manifest,
    contracts,
    users,
    relay,
    relaySigners,
    endpoints: attestorCluster.endpoints,
    runDirectory,
    proofObserver: liveClientProofCollector.observeAcceptedProof,
  });
  relay = reloadResult.relay;
  activeRelay = relay;
  report.tests.engineReloadRecovery = reloadResult.result;

  if (ENFORCE_BENCHMARK && report.benchmark.status !== "passed") {
    throw new Error(
      `Benchmark acceptance failed: status=${report.benchmark.status}, ` +
      `samples=${report.benchmark.sampleCount}/${report.benchmark.requiredSamples}, ` +
      `post-inclusion-to-completion p95=${report.benchmark.postSourceInclusionToCompletion.p95Ms}ms/${report.benchmark.targetP95Ms}ms`,
    );
  }

  report.environment.chainAAfter = await chainSnapshot(providers.A, manifest.chains.A);
  report.environment.chainBAfter = await chainSnapshot(providers.B, manifest.chains.B);
  report.liveClientProofValidation = liveClientProofCollector.build([
    report.environment.chainAAfter,
    report.environment.chainBAfter,
  ]);
  report.status = "passed";
  report.finishedAt = new Date().toISOString();
  await writeJsonAtomic(REPORT_PATH, report);
  console.log(`[institutional:integration] PASS report=${REPORT_PATH}`);
}

async function loadArtifacts() {
  return {
    app: await loadArtifact("apps/InstitutionalCollateralApp.sol", "InstitutionalCollateralApp"),
    gateway: await loadArtifact("gateway/InstitutionalCrossChainGateway.sol", "InstitutionalCrossChainGateway"),
    token: await loadArtifact("apps/BankToken.sol", "BankToken"),
    voucher: await loadArtifact("apps/PolicyControlledVoucherToken.sol", "PolicyControlledVoucherToken"),
    escrow: await loadArtifact("apps/PolicyControlledEscrowVault.sol", "PolicyControlledEscrowVault"),
    lending: await loadArtifact("apps/PolicyControlledLendingPool.sol", "PolicyControlledLendingPool"),
  };
}

function createContracts({ manifest, users, owners, artifacts }) {
  const address = (chain, name) => manifest.chains[chain].contracts[name].address;
  return {
    collateralAppA: new ethers.Contract(address("A", "collateralApp"), artifacts.app.abi, users.A),
    collateralAppB: new ethers.Contract(address("B", "collateralApp"), artifacts.app.abi, users.B),
    gatewayA: new ethers.Contract(address("A", "gateway"), artifacts.gateway.abi, users.A),
    gatewayB: new ethers.Contract(address("B", "gateway"), artifacts.gateway.abi, users.B),
    canonicalTokenA: new ethers.Contract(address("A", "canonicalToken"), artifacts.token.abi, users.A),
    escrowVaultA: new ethers.Contract(address("A", "escrowVault"), artifacts.escrow.abi, users.A),
    voucherTokenB: new ethers.Contract(address("B", "voucherToken"), artifacts.voucher.abi, users.B),
    debtTokenBUser: new ethers.Contract(address("B", "debtToken"), artifacts.token.abi, users.B),
    debtTokenBOwner: new ethers.Contract(address("B", "debtToken"), artifacts.token.abi, owners.B),
    lendingPoolBUser: new ethers.Contract(address("B", "lendingPool"), artifacts.lending.abi, users.B),
    lendingPoolBOwner: new ethers.Contract(address("B", "lendingPool"), artifacts.lending.abi, owners.B),
  };
}

async function startAttestorCluster({ manifest, secrets, providers, runDirectory }) {
  const token = `integration-${randomBytes(24).toString("hex")}`;
  const finalityDepth = Number(manifest.securityProfile.finalityDepth);
  const sources = {
    [manifest.chains.A.chainId]: { provider: providers.A, finalityDepth },
    [manifest.chains.B.chainId]: { provider: providers.B, finalityDepth },
  };
  const allowedDomains = allowedCheckpointDomains(manifest);
  const nodes = [];
  try {
    for (const entry of secrets.attestors) {
      const journal = await AttestorJournal.open(resolve(runDirectory, `attestor-${entry.address}.json`));
      const attestor = new CheckpointAttestor({
        wallet: new ethers.Wallet(entry.privateKey),
        sources,
        journal,
        allowedDomains,
      });
      const server = createAttestorHttpServer({ attestor, token, logger: quietLogger });
      const node = { server, journal, port: null, running: false, signer: attestor.signerAddress };
      nodes.push(node);
      await listen(server, 0);
      node.port = server.address().port;
      node.running = true;
    }
  } catch (error) {
    await closeAttestorNodes(nodes);
    throw error;
  }
  const endpoints = nodes.map((node) => ({ url: `http://127.0.0.1:${node.port}`, token }));
  console.log(`[institutional:integration] started ${nodes.length} local attestors`);
  return {
    nodes,
    endpoints,
    async stop(indices) {
      for (const index of indices) {
        if (!nodes[index].running) continue;
        await close(nodes[index].server);
        nodes[index].running = false;
      }
    },
    async start(indices) {
      for (const index of indices) {
        if (nodes[index].running) continue;
        await listen(nodes[index].server, nodes[index].port);
        nodes[index].running = true;
      }
    },
    async close() {
      await closeAttestorNodes(nodes);
    },
  };
}

async function closeAttestorNodes(nodes) {
  const results = await Promise.allSettled(nodes.flatMap((node) => [
    ...(node.running ? [close(node.server).finally(() => { node.running = false; })] : []),
    ...(typeof node.journal?.close === "function" ? [node.journal.close()] : []),
  ]));
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}

async function createRelayRuntime({
  manifest,
  relaySigners,
  endpoints,
  runDirectory,
  journalPath,
  proofObserver,
}) {
  const finalityDepth = Number(manifest.securityProfile.finalityDepth);
  const laneConfig = (sourceKey, destinationKey) => ({
    source: endpointConfig(manifest, sourceKey, finalityDepth),
    destination: endpointConfig(manifest, destinationKey, finalityDepth),
    attestors: endpoints,
    attestorTimeoutMs: 2_000,
    transactionTimeoutMs: TX_TIMEOUT_MS,
    pollIntervalMs: 500,
    scanRange: 500,
    gasLimit: "5000000",
    proofObserver,
  });
  const workflowAB = await createEthersLaneWorkflow(laneConfig("A", "B"), {
    sourceSigner: relaySigners.A,
    destinationSigner: relaySigners.B,
  });
  const workflowBA = await createEthersLaneWorkflow(laneConfig("B", "A"), {
    sourceSigner: relaySigners.B,
    destinationSigner: relaySigners.A,
  });
  const path = journalPath || resolve(runDirectory, "relay-journal.json");
  const journal = await RelayJournal.open(path);
  try {
    const engine = new InstitutionalRelayEngine({
      journal,
      lanes: [
        { id: "A-to-B", startBlock: Number(manifest.chains.A.deploymentBlock), workflow: workflowAB },
        { id: "B-to-A", startBlock: Number(manifest.chains.B.deploymentBlock), workflow: workflowBA },
      ],
      leaseMs: 15_000,
      batchSize: 20,
      retry: { baseMs: 250, maxMs: 1_000, jitterRatio: 0 },
    });
    let closePromise = null;
    return {
      engine,
      journal,
      journalPath: path,
      close() {
        closePromise ||= journal.close();
        return closePromise;
      },
    };
  } catch (error) {
    await journal.close();
    throw error;
  }
}

function endpointConfig(manifest, key, finalityDepth) {
  const chain = manifest.chains[key];
  return {
    chainId: chain.chainId,
    gateway: chain.contracts.gateway.address,
    checkpointClient: chain.contracts.checkpointClient.address,
    deploymentBlock: chain.deploymentBlock,
    finalityDepth,
  };
}

function allowedCheckpointDomains(manifest) {
  return ["A", "B"].map((key) => ({
    destinationChainId: manifest.chains[key].chainId,
    checkpointClient: manifest.chains[key].contracts.checkpointClient.address,
  }));
}

async function executeBridge({
  direction,
  sourceApp,
  sourceGateway,
  destinationToken,
  destinationAccount,
  destinationChainId,
  amount,
  relay,
  label,
  send,
}) {
  const before = BigInt(await destinationToken.balanceOf(destinationAccount));
  const sourceBlock = await readLatestBlock(sourceApp.runner.provider, { label: `${label} source block` });
  const timeout = BigInt(sourceBlock.timestamp) + 30n * 60n;
  const reference = ethers.keccak256(ethers.toUtf8Bytes(`${label}:${Date.now()}:${randomBytes(8).toString("hex")}`));
  const startedAt = Date.now();
  const transaction = await send(timeout, reference);
  const receipt = await waitForTx(transaction, `${label} source transaction`);
  const sourceIncludedAt = Date.now();
  const messageId = findEventArgument(sourceApp, receipt, "CollateralMessageSent", "messageId");
  if (!messageId) throw new Error(`${label} did not emit CollateralMessageSent`);
  await runUntil(relay, () => sourceGateway.messageCompleted(messageId), `${label} acknowledgement`);
  const after = BigInt(await destinationToken.balanceOf(destinationAccount));
  const delta = after - before;
  if (delta !== amount) throw new Error(`${label} destination balance delta ${delta} does not equal ${amount}`);
  const job = relay.journal.snapshot().jobs[messageId];
  const completedAt = Date.now();
  const sourceInclusionMs = sourceIncludedAt - startedAt;
  const postSourceInclusionToCompletionMs = completedAt - sourceIncludedAt;
  const endToEndMs = completedAt - startedAt;
  console.log(`[institutional:integration] ${direction} ${label} completed in ${endToEndMs}ms`);
  return {
    direction,
    label,
    messageId,
    amount: amount.toString(),
    sourceTransaction: receipt.hash,
    sourceBlock: receipt.blockNumber,
    destinationBalanceDelta: delta.toString(),
    sourceInclusionMs,
    sourceIncludedAt: new Date(sourceIncludedAt).toISOString(),
    postSourceInclusionToCompletionMs,
    endToEndMs,
    relayTransactions: job?.transactions || {},
    relayHistory: job?.history || [],
    destinationChainId: destinationChainId.toString(),
  };
}

async function executeLending({ contracts, user }) {
  const userAddress = await user.getAddress();
  await ensureAllowance(contracts.voucherTokenB, await contracts.lendingPoolBUser.getAddress(), userAddress, COLLATERAL_AMOUNT);
  const collateralBefore = BigInt(await contracts.lendingPoolBUser.collateralBalance(userAddress));
  const debtBalanceBefore = BigInt(await contracts.debtTokenBUser.balanceOf(userAddress));
  const deposit = await contracts.lendingPoolBUser.depositCollateral(COLLATERAL_AMOUNT, txOptions());
  const depositReceipt = await waitForTx(deposit, "deposit voucher collateral");
  const borrow = await contracts.lendingPoolBUser.borrow(BORROW_AMOUNT, txOptions());
  const borrowReceipt = await waitForTx(borrow, "borrow bCASH from Bank B");
  const collateralAfter = BigInt(await contracts.lendingPoolBUser.collateralBalance(userAddress));
  const debtBalanceAfter = BigInt(await contracts.debtTokenBUser.balanceOf(userAddress));
  if (collateralAfter - collateralBefore !== COLLATERAL_AMOUNT) throw new Error("Collateral accounting delta is incorrect");
  if (debtBalanceAfter - debtBalanceBefore !== BORROW_AMOUNT) throw new Error("Borrowed token balance delta is incorrect");
  return {
    status: "passed",
    collateralAmount: COLLATERAL_AMOUNT.toString(),
    borrowedAmount: BORROW_AMOUNT.toString(),
    depositTransaction: depositReceipt.hash,
    borrowTransaction: borrowReceipt.hash,
    healthFactorE18: (await contracts.lendingPoolBUser.healthFactorE18(userAddress)).toString(),
  };
}

async function ensurePoolLiquidity(contracts, owner) {
  const available = BigInt(await contracts.lendingPoolBOwner.availableLiquidity());
  if (available >= MINIMUM_POOL_LIQUIDITY) return;
  const amount = MINIMUM_POOL_LIQUIDITY - available;
  const ownerAddress = await owner.getAddress();
  const balance = BigInt(await contracts.debtTokenBOwner.balanceOf(ownerAddress));
  if (balance < amount) throw new Error(`Bank B lender has ${balance}, needs ${amount}`);
  await ensureAllowance(contracts.debtTokenBOwner, await contracts.lendingPoolBOwner.getAddress(), ownerAddress, amount);
  await waitForTx(await contracts.lendingPoolBOwner.depositLiquidity(amount, txOptions()), "seed lending liquidity");
}

async function testQuorumOutage({ manifest, contracts, users, relay, cluster }) {
  await cluster.stop([2, 3]);
  const userB = await users.B.getAddress();
  const before = BigInt(await contracts.voucherTokenB.balanceOf(userB));
  const sourceBlock = await readLatestBlock(contracts.collateralAppA.runner.provider, {
    label: "quorum outage source block",
  });
  const timeout = BigInt(sourceBlock.timestamp) + 30n * 60n;
  const transaction = await contracts.collateralAppA.lockAndMint(
    manifest.chains.B.chainId,
    userB,
    CHAOS_AMOUNT,
    timeout,
    ethers.keccak256(ethers.toUtf8Bytes(`quorum-outage:${Date.now()}`)),
    txOptions(),
  );
  const receipt = await waitForTx(transaction, "quorum outage source transaction");
  const messageId = findEventArgument(contracts.collateralAppA, receipt, "CollateralMessageSent", "messageId");
  await runUntil(
    relay,
    async () => {
      const job = relay.journal.snapshot().jobs[messageId];
      return Boolean(job?.lastError?.message?.includes("threshold is 3"));
    },
    "quorum failure observation",
  );
  const during = BigInt(await contracts.voucherTokenB.balanceOf(userB));
  if (during !== before) throw new Error("Destination state changed without attestor quorum");
  await cluster.start([2]);
  await runUntil(relay, () => contracts.gatewayA.messageCompleted(messageId), "quorum recovery acknowledgement");
  const after = BigInt(await contracts.voucherTokenB.balanceOf(userB));
  if (after - before !== CHAOS_AMOUNT) throw new Error("Recovered quorum did not preserve one expected mint effect");
  await cluster.start([3]);
  return {
    status: "passed",
    messageId,
    unavailableAttestors: 2,
    threshold: manifest.securityProfile.attestorThreshold,
    destinationDeltaWithoutQuorum: (during - before).toString(),
    destinationDeltaAfterRecovery: (after - before).toString(),
  };
}

async function testEngineReloadRecovery({
  manifest,
  contracts,
  users,
  relay,
  relaySigners,
  endpoints,
  runDirectory,
  proofObserver,
}) {
  const userB = await users.B.getAddress();
  const before = BigInt(await contracts.voucherTokenB.balanceOf(userB));
  const block = await readLatestBlock(contracts.collateralAppA.runner.provider, {
    label: "relay engine reload source block",
  });
  const transaction = await contracts.collateralAppA.lockAndMint(
    manifest.chains.B.chainId,
    userB,
    ENGINE_RELOAD_AMOUNT,
    BigInt(block.timestamp) + 30n * 60n,
    ethers.keccak256(ethers.toUtf8Bytes(`relay-engine-reload:${Date.now()}`)),
    txOptions(),
  );
  const receipt = await waitForTx(transaction, "relay engine reload source transaction");
  const messageId = findEventArgument(contracts.collateralAppA, receipt, "CollateralMessageSent", "messageId");
  await runUntil(
    relay,
    async () => relay.journal.snapshot().jobs[messageId]?.state === "source_checkpointed",
    "source checkpoint before relay engine reload",
  );
  await relay.close();
  const reloaded = await createRelayRuntime({
    manifest,
    relaySigners,
    endpoints,
    runDirectory,
    journalPath: relay.journalPath,
    proofObserver,
  });
  await runUntil(reloaded, () => contracts.gatewayA.messageCompleted(messageId), "relay engine reload recovery");
  const after = BigInt(await contracts.voucherTokenB.balanceOf(userB));
  if (after - before !== ENGINE_RELOAD_AMOUNT) throw new Error("Reloaded relay engine did not preserve one expected mint effect");
  await reloaded.engine.tick();
  await reloaded.engine.tick();
  const afterReplay = BigInt(await contracts.voucherTokenB.balanceOf(userB));
  if (afterReplay !== after) throw new Error("Repeated relay ticks duplicated destination execution");
  return {
    relay: reloaded,
    result: {
      status: "passed",
      messageId,
      reloadState: "source_checkpointed",
      destinationDelta: (after - before).toString(),
      duplicateDeltaAfterRepeatedTicks: (afterReplay - after).toString(),
    },
  };
}

async function ensureAllowance(token, spender, owner, required) {
  if (BigInt(await token.allowance(owner, spender)) >= required) return;
  await waitForTx(await token.approve(spender, ethers.MaxUint256, txOptions()), `approve ${spender}`);
}

async function runUntil(relay, predicate, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < FLOW_TIMEOUT_MS) {
    await relay.engine.tick();
    if (await predicate()) return;
    await sleep(500);
  }
  throw new Error(`${label} did not complete within ${FLOW_TIMEOUT_MS}ms`);
}

async function chainSnapshot(provider, chain) {
  const [network, clientVersion] = await Promise.all([
    provider.getNetwork(),
    provider.send("web3_clientVersion", []),
  ]);
  return {
    chainId: network.chainId.toString(),
    blockNumber: await provider.getBlockNumber(),
    rpc: chain.rpc,
    clientVersion,
  };
}

function findEventArgument(contract, receipt, eventName, argument) {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed?.name === eventName) return parsed.args[argument];
    } catch {
      // The receipt also contains logs from the gateway and token callbacks.
    }
  }
  return null;
}

function txOptions() {
  return { gasLimit: 5_000_000n };
}

function validateInputs(manifest, secrets) {
  if (manifest.version !== "institutional-deployment-v2" || manifest.status !== "ready") {
    throw new Error(`Run npm run institutional:deploy before integration tests`);
  }
  if (secrets.version !== "institutional-attestor-secrets-v1" || secrets.attestors?.length !== 4) {
    throw new Error("Institutional attestor secrets are missing or invalid");
  }
  const expected = new Set(manifest.securityProfile.attestors.map((address) => ethers.getAddress(address)));
  for (const entry of secrets.attestors) {
    const wallet = new ethers.Wallet(entry.privateKey);
    if (!expected.has(wallet.address)) throw new Error(`Attestor ${wallet.address} is not in the deployment manifest`);
  }
}

function listen(server, port) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
}

function close(server) {
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

const quietLogger = { info() {}, error() {} };

main()
  .catch(async (error) => {
    report.status = "failed";
    report.finishedAt = new Date().toISOString();
    report.error = { message: error?.message || String(error), stack: error?.stack };
    await writeJsonAtomic(REPORT_PATH, report).catch(() => {});
    console.error(error?.stack || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    const cleanupResults = await Promise.allSettled([
      activeRelay?.close(),
      attestorCluster?.close(),
    ]);
    const cleanupFailures = cleanupResults
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (cleanupFailures.length > 0) {
      console.error(`[institutional:integration] cleanup failed: ${cleanupFailures.map((error) => error?.message || error).join("; ")}`);
      process.exitCode = 1;
    }
  });
