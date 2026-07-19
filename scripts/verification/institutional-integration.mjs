import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { ethers } from "ethers";
import { defaultBesuRuntimeEnv, loadArtifact, providerForRpc, signerForRpc } from "../ops/besu/runtime.mjs";
import { AttestorJournal } from "../../services/institutional-relay/attestor-journal.mjs";
import { CheckpointAttestor } from "../../services/institutional-relay/checkpoint-attestor.mjs";
import { createAttestorHttpServer } from "../../services/institutional-relay/attestor-http-server.mjs";
import { createEthersLaneWorkflow } from "../../services/institutional-relay/ethers-lane-workflow.mjs";
import { InstitutionalRelayEngine } from "../../services/institutional-relay/relay-engine.mjs";
import { RelayJournal } from "../../services/institutional-relay/relay-journal.mjs";

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
const RESTART_AMOUNT = ethers.parseEther("7");
const MINIMUM_POOL_LIQUIDITY = ethers.parseEther("100000");

defaultBesuRuntimeEnv();

let attestorCluster;
let report = {
  version: "institutional-integration-report-v1",
  status: "running",
  startedAt: new Date().toISOString(),
  tests: {},
};

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
    ...(await validatorEvidence()),
  };

  attestorCluster = await startAttestorCluster({ manifest, secrets, providers, runDirectory });
  let relay = await createRelayRuntime({ manifest, relaySigners, endpoints: attestorCluster.endpoints, runDirectory });

  await ensureAllowance(
    contracts.canonicalTokenA,
    await contracts.escrowVaultA.getAddress(),
    await users.A.getAddress(),
    BRIDGE_AMOUNT + BigInt(BENCHMARK_MESSAGES) * BENCHMARK_AMOUNT + CHAOS_AMOUNT + RESTART_AMOUNT,
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
  report.benchmark = summarizeBenchmark(benchmarkSamples);

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

  const restartResult = await testRelayerRestart({
    manifest,
    contracts,
    users,
    relay,
    relaySigners,
    endpoints: attestorCluster.endpoints,
    runDirectory,
  });
  relay = restartResult.relay;
  report.tests.relayerRestart = restartResult.result;

  if (ENFORCE_BENCHMARK && report.benchmark.status !== "passed") {
    throw new Error(
      `Benchmark acceptance failed: status=${report.benchmark.status}, ` +
      `samples=${report.benchmark.sampleCount}/${report.benchmark.requiredSamples}, ` +
      `proof-and-acknowledgement p95=${report.benchmark.postSourceFinality.p95Ms}ms/${report.benchmark.targetP95Ms}ms`,
    );
  }

  report.status = "passed";
  report.finishedAt = new Date().toISOString();
  report.environment.chainAAfter = await chainSnapshot(providers.A, manifest.chains.A);
  report.environment.chainBAfter = await chainSnapshot(providers.B, manifest.chains.B);
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
  const nodes = [];
  for (const entry of secrets.attestors) {
    const journal = await AttestorJournal.open(resolve(runDirectory, `attestor-${entry.address}.json`));
    const attestor = new CheckpointAttestor({ wallet: new ethers.Wallet(entry.privateKey), sources, journal });
    const server = createAttestorHttpServer({ attestor, token, logger: quietLogger });
    await listen(server, 0);
    const port = server.address().port;
    nodes.push({ server, port, running: true, signer: attestor.signerAddress });
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
      await Promise.all(nodes.filter((node) => node.running).map((node) => close(node.server)));
      for (const node of nodes) node.running = false;
    },
  };
}

async function createRelayRuntime({ manifest, relaySigners, endpoints, runDirectory, journalPath }) {
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
  const engine = new InstitutionalRelayEngine({
    journal,
    lanes: [
      { id: "A-to-B", startBlock: Number(manifest.chains.A.deploymentBlock), workflow: workflowAB },
      { id: "B-to-A", startBlock: Number(manifest.chains.B.deploymentBlock), workflow: workflowBA },
    ],
    leaseMs: 15_000,
    batchSize: 20,
    retry: { initialMs: 250, maximumMs: 1_000, jitterRatio: 0 },
  });
  return { engine, journal, journalPath: path };
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
  const sourceBlock = await sourceApp.runner.provider.getBlock("latest");
  const timeout = BigInt(sourceBlock.timestamp) + 30n * 60n;
  const reference = ethers.keccak256(ethers.toUtf8Bytes(`${label}:${Date.now()}:${randomBytes(8).toString("hex")}`));
  const startedAt = Date.now();
  const transaction = await send(timeout, reference);
  const receipt = await waitForTx(transaction, `${label} source transaction`);
  const sourceFinalizedAt = Date.now();
  const messageId = findEventArgument(sourceApp, receipt, "CollateralMessageSent", "messageId");
  if (!messageId) throw new Error(`${label} did not emit CollateralMessageSent`);
  await runUntil(relay, () => sourceGateway.messageCompleted(messageId), `${label} acknowledgement`);
  const after = BigInt(await destinationToken.balanceOf(destinationAccount));
  const delta = after - before;
  if (delta !== amount) throw new Error(`${label} destination balance delta ${delta} does not equal ${amount}`);
  const job = relay.journal.snapshot().jobs[messageId];
  const completedAt = Date.now();
  const sourceInclusionMs = sourceFinalizedAt - startedAt;
  const postSourceFinalityMs = completedAt - sourceFinalizedAt;
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
    postSourceFinalityMs,
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
  const borrowReceipt = await waitForTx(borrow, "borrow Bank B credit");
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
  const sourceBlock = await contracts.collateralAppA.runner.provider.getBlock("latest");
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
  if (after - before !== CHAOS_AMOUNT) throw new Error("Recovered quorum did not mint exactly once");
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

async function testRelayerRestart({
  manifest,
  contracts,
  users,
  relay,
  relaySigners,
  endpoints,
  runDirectory,
}) {
  const userB = await users.B.getAddress();
  const before = BigInt(await contracts.voucherTokenB.balanceOf(userB));
  const block = await contracts.collateralAppA.runner.provider.getBlock("latest");
  const transaction = await contracts.collateralAppA.lockAndMint(
    manifest.chains.B.chainId,
    userB,
    RESTART_AMOUNT,
    BigInt(block.timestamp) + 30n * 60n,
    ethers.keccak256(ethers.toUtf8Bytes(`relayer-restart:${Date.now()}`)),
    txOptions(),
  );
  const receipt = await waitForTx(transaction, "relayer restart source transaction");
  const messageId = findEventArgument(contracts.collateralAppA, receipt, "CollateralMessageSent", "messageId");
  await runUntil(
    relay,
    async () => relay.journal.snapshot().jobs[messageId]?.state === "source_checkpointed",
    "source checkpoint before relayer restart",
  );
  const restarted = await createRelayRuntime({
    manifest,
    relaySigners,
    endpoints,
    runDirectory,
    journalPath: relay.journalPath,
  });
  await runUntil(restarted, () => contracts.gatewayA.messageCompleted(messageId), "relayer restart recovery");
  const after = BigInt(await contracts.voucherTokenB.balanceOf(userB));
  if (after - before !== RESTART_AMOUNT) throw new Error("Restarted relayer did not mint exactly once");
  await restarted.engine.tick();
  await restarted.engine.tick();
  const afterReplay = BigInt(await contracts.voucherTokenB.balanceOf(userB));
  if (afterReplay !== after) throw new Error("Repeated relay ticks duplicated destination execution");
  return {
    relay: restarted,
    result: {
      status: "passed",
      messageId,
      restartState: "source_checkpointed",
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

function summarizeBenchmark(samples) {
  const endToEnd = samples.map((sample) => sample.endToEndMs).sort((a, b) => a - b);
  const sourceInclusion = samples.map((sample) => sample.sourceInclusionMs).sort((a, b) => a - b);
  const postSourceFinality = samples.map((sample) => sample.postSourceFinalityMs).sort((a, b) => a - b);
  const enoughSamples = samples.length >= BENCHMARK_REQUIRED_SAMPLES;
  const meetsLatency = percentile(postSourceFinality, 0.95) <= BENCHMARK_TARGET_P95_MS;
  return {
    status: !enoughSamples ? "insufficient-samples" : meetsLatency ? "passed" : "target-not-met",
    definition: "Full proof-and-acknowledgement cycle after source transaction inclusion",
    acceptanceProfile:
      "Local Docker QBFT profile: 2s block period, finality depth 2, source checkpoint, destination proof execution, destination checkpoint, and source acknowledgement.",
    sampleCount: endToEnd.length,
    requiredSamples: BENCHMARK_REQUIRED_SAMPLES,
    targetP95Ms: BENCHMARK_TARGET_P95_MS,
    samples,
    sourceInclusion: summarizeDurations(sourceInclusion),
    postSourceFinality: summarizeDurations(postSourceFinality),
    endToEnd: summarizeDurations(endToEnd),
  };
}

function summarizeDurations(values) {
  return {
    minMs: values[0],
    maxMs: values.at(-1),
    meanMs: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
  };
}

function percentile(sorted, quantile) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

async function chainSnapshot(provider, chain) {
  const network = await provider.getNetwork();
  return {
    chainId: network.chainId.toString(),
    blockNumber: await provider.getBlockNumber(),
    rpc: chain.rpc,
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

async function waitForTx(transaction, label) {
  let timer;
  try {
    const receipt = await Promise.race([
      transaction.wait(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out; tx=${transaction.hash}`)), TX_TIMEOUT_MS);
      }),
    ]);
    if (!receipt || receipt.status !== 1) throw new Error(`${label} failed; tx=${transaction.hash}`);
    return receipt;
  } finally {
    clearTimeout(timer);
  }
}

function txOptions() {
  return { gasLimit: 5_000_000n };
}

function validateInputs(manifest, secrets) {
  if (manifest.version !== "institutional-deployment-v1" || manifest.status !== "ready") {
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

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function validatorEvidence() {
  const networkRoot = resolve(process.cwd(), process.env.BESU_NETWORK_ROOT || "networks/besu");
  const faultReportPath = resolve(
    process.cwd(),
    process.env.BESU_QBFT_FAULT_REPORT_PATH || ".runtime/besu-qbft-fault-report.json",
  );
  const scaffold = await readJsonIfExists(resolve(networkRoot, "scaffold.json"));
  const faultReport = await readJsonIfExists(faultReportPath);
  const validatorCount = Number(scaffold?.validatorCount || 1);
  return {
    validatorTopology: {
      validatorCountPerChain: validatorCount,
      toleratedFaults: Number(scaffold?.byzantineFaultTolerance || 0),
      dockerImage: scaffold?.dockerImage || "unknown",
    },
    validatorFaultTest: faultReport?.status === "passed"
      ? {
          status: "passed",
          report: faultReportPath,
          faultedValidators: faultReport.faults,
          duringFault: faultReport.duringFault,
          afterRecovery: faultReport.afterRecovery,
        }
      : {
          status: "not-run",
          reason: validatorCount < 4
            ? "The active profile has fewer than four validators and cannot evidence QBFT fault tolerance."
            : "Run the QBFT fault test and provide BESU_QBFT_FAULT_REPORT_PATH before claiming validator-fault evidence.",
        },
  };
}

async function readJsonIfExists(path) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
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
    await attestorCluster?.close().catch(() => {});
  });
