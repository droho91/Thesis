import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ethers } from "ethers";
import { InstitutionalActionJournal } from "./institutional-action-journal.mjs";
import { defaultBesuRuntimeEnv, loadArtifact, providerForRpc, signerForRpc } from "../scripts/ops/besu/runtime.mjs";
import {
  INSTITUTIONAL_DEMO_STATE_PATH,
  INSTITUTIONAL_DEPLOYMENT_PATH,
  createViewContracts,
  loadViewArtifacts,
  parseActionAmount,
  readInstitutionalStatus,
} from "../scripts/ui/read-model.mjs";
import { AttestorJournal } from "./institutional-relay/attestor-journal.mjs";
import { CheckpointAttestor } from "./institutional-relay/checkpoint-attestor.mjs";
import { createAttestorHttpServer } from "./institutional-relay/attestor-http-server.mjs";
import { createEthersLaneWorkflow } from "./institutional-relay/ethers-lane-workflow.mjs";
import { InstitutionalRelayEngine } from "./institutional-relay/relay-engine.mjs";
import { RelayJournal } from "./institutional-relay/relay-journal.mjs";

const ATTESTOR_SECRETS_PATH = resolve(
  process.cwd(),
  process.env.INSTITUTIONAL_ATTESTOR_SECRETS_PATH || ".runtime/institutional-attestor-secrets.json",
);
const RUNTIME_ROOT = resolve(process.cwd(), process.env.INSTITUTIONAL_DEMO_ROOT || ".runtime/institutional-demo");
const TX_TIMEOUT_MS = Number(process.env.INSTITUTIONAL_TX_TIMEOUT_MS || 90_000);
const FLOW_TIMEOUT_MS = Number(process.env.INSTITUTIONAL_FLOW_TIMEOUT_MS || 180_000);
const RELAY_POLL_MS = Number(process.env.INSTITUTIONAL_DEMO_RELAY_POLL_MS || 1_000);
const MINIMUM_POOL_LIQUIDITY = ethers.parseEther(process.env.INSTITUTIONAL_DEMO_MIN_LIQUIDITY || "100000");
const TX_OPTIONS = Object.freeze({ gasLimit: 5_000_000n });

defaultBesuRuntimeEnv();

const ACTIONS = Object.freeze({
  bridge: { label: "Transfer collateral to Bank B", lane: "A-to-B" },
  deposit: { label: "Activate voucher collateral", lane: "Bank B" },
  borrow: { label: "Borrow Bank B credit", lane: "Bank B" },
  repay: { label: "Repay Bank B credit", lane: "Bank B" },
  repayAll: { label: "Repay complete Bank B balance", lane: "Bank B" },
  withdraw: { label: "Withdraw voucher collateral", lane: "Bank B" },
  return: { label: "Return collateral to Bank A", lane: "B-to-A" },
});

export class InstitutionalDemoRuntime {
  constructor({ logger = console } = {}) {
    this.logger = logger;
    this.initializing = null;
    this.context = null;
    this.activity = null;
    this.activeOperation = null;
    this.relayTimer = null;
    this.relayTickPromise = null;
  }

  async initialize() {
    if (this.context) return this.context;
    if (!this.initializing) this.initializing = this.#initialize().finally(() => { this.initializing = null; });
    return this.initializing;
  }

  async status() {
    try {
      const context = await this.initialize();
      return readInstitutionalStatus({
        ...context,
        activity: this.activity,
        relayJournal: context.relay.journal,
        activeAttestors: context.attestorCluster.nodes.length,
        activeOperation: this.publicActiveOperation(),
      });
    } catch (error) {
      return readInstitutionalStatus({ activity: this.activity }).then((status) => ({
        ...status,
        ready: false,
        error: compactError(error),
        message: compactError(error),
        controller: { busy: false, activeOperation: null },
      }));
    }
  }

  async execute(request) {
    const action = String(request?.action || "");
    if (!ACTIONS[action]) throw httpError(400, `Unsupported institutional action: ${action || "missing"}`);
    const requestId = normalizeRequestId(request?.requestId);
    if (this.activeOperation) {
      throw httpError(409, `${this.activeOperation.label} is already running`, {
        controller: { busy: true, activeOperation: this.publicActiveOperation() },
      });
    }

    let startedAt = new Date().toISOString();
    const operationId = `operation-${Date.now()}-${randomBytes(4).toString("hex")}`;
    this.activeOperation = {
      id: operationId,
      requestId,
      action,
      label: ACTIONS[action].label,
      lane: ACTIONS[action].lane,
      amount: null,
      stage: "preflight",
      startedAt,
      startedAtMs: Date.now(),
    };

    let context;
    let journalPrepared = false;
    try {
      context = await this.initialize();
      const existing = context.actionJournal.get(requestId);
      if (existing) {
        if (existing.action !== action) {
          throw httpError(409, `Idempotency key ${requestId} belongs to ${existing.action}, not ${action}`);
        }
        if (existing.status === "completed") {
          this.activeOperation = null;
          return { ok: true, replayed: true, operation: existing.result, status: await this.status() };
        }
        if (existing.status === "failed") {
          throw httpError(409, `Request ${requestId} previously failed`, { operation: existing });
        }
        if (!["prepared", "submitted", "uncertain"].includes(existing.status)) {
          throw httpError(409, `Request ${requestId} has unsupported journal status ${existing.status}`, {
            operation: existing,
          });
        }
        journalPrepared = true;
        startedAt = existing.createdAt || startedAt;
        Object.assign(this.activeOperation, {
          amount: existing.amount,
          stage: existing.stage || (existing.status === "prepared" ? "prepared" : "reconciling-transaction"),
          startedAt,
          startedAtMs: Date.parse(startedAt) || Date.now(),
          sourceTransaction: existing.sourceTransaction || null,
          messageId: existing.messageId || null,
          clientReference: existing.clientReference || null,
        });
      }

      const before = await this.status();
      if (!before.ready) throw httpError(503, before.message || "Institutional runtime is not ready");
      const amount = existing
        ? ethers.parseUnits(existing.amount, 18)
        : actionAmount(action, request.amount, before);
      if (!existing) {
        this.activeOperation.amount = ethers.formatUnits(amount, 18);
        this.activeOperation.stage = "prepared";
        await context.actionJournal.prepare({
          requestId,
          action,
          label: ACTIONS[action].label,
          lane: ACTIONS[action].lane,
          amount: this.activeOperation.amount,
        });
        journalPrepared = true;
      }
      const activityStatus = existing && existing.status !== "prepared" ? existing.status : "pending";
      await this.#recordActivity(this.#activeActivity(activityStatus));

      const result = existing && existing.status !== "prepared"
        ? await this.#resumeSubmittedAction(context, existing)
        : await this.#executeAction(context, action, amount);
      const entry = {
        id: operationId,
        requestId,
        action,
        label: ACTIONS[action].label,
        lane: ACTIONS[action].lane,
        amount: this.activeOperation.amount,
        status: "completed",
        startedAt,
        finishedAt: new Date().toISOString(),
        ...result,
      };
      await context.actionJournal.complete(requestId, entry);
      await this.#recordActivity(entry);
      this.activeOperation = null;
      return { ok: true, operation: entry, status: await this.status() };
    } catch (error) {
      const outcomeUncertain = Boolean(
        this.activeOperation?.sourceTransaction
        && !error?.outcomeCertain
        && Number(error?.receipt?.status ?? -1) !== 0,
      );
      const entry = {
        id: operationId,
        requestId,
        action,
        label: ACTIONS[action].label,
        lane: ACTIONS[action].lane,
        amount: this.activeOperation?.amount || "0",
        status: outcomeUncertain ? "uncertain" : "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        sourceTransaction: this.activeOperation?.sourceTransaction || null,
        error: compactError(error),
      };
      if (journalPrepared) {
        try {
          await context.actionJournal.fail(requestId, error, {
            uncertain: outcomeUncertain,
            sourceTransaction: this.activeOperation?.sourceTransaction || null,
          });
          await this.#recordActivity(entry);
        } catch (journalError) {
          this.logger.error?.(`[institutional-ui] action journal: ${compactError(journalError)}`);
        }
      }
      this.activeOperation = null;
      throw httpError(error.statusCode || 500, compactError(error), { operation: entry });
    }
  }

  publicActiveOperation() {
    if (!this.activeOperation) return null;
    return {
      ...this.activeOperation,
      elapsedSeconds: Math.max(0, Math.round((Date.now() - this.activeOperation.startedAtMs) / 1_000)),
      startedAtMs: undefined,
    };
  }

  async close() {
    if (this.relayTimer) clearInterval(this.relayTimer);
    this.relayTimer = null;
    if (this.context?.attestorCluster) await this.context.attestorCluster.close();
    this.context = null;
  }

  async #initialize() {
    const [manifest, secrets, activity] = await Promise.all([
      readJson(INSTITUTIONAL_DEPLOYMENT_PATH),
      readJson(ATTESTOR_SECRETS_PATH),
      readJsonIfExists(INSTITUTIONAL_DEMO_STATE_PATH),
    ]);
    validateDeployment(manifest, secrets);
    const runtimeKey = `${manifest.chains.A.contracts.gateway.address.slice(2, 10)}-${manifest.chains.B.contracts.gateway.address.slice(2, 10)}`;
    this.activity = activity?.version === "institutional-demo-state-v1" && activity.deploymentId === runtimeKey
      ? activity
      : emptyActivity(runtimeKey);

    const providers = {
      A: providerForRpc(manifest.chains.A.rpc),
      B: providerForRpc(manifest.chains.B.rpc),
    };
    const users = {
      A: await signerForRpc(manifest.chains.A.rpc, "A", 1),
      B: await signerForRpc(manifest.chains.B.rpc, "B", 1),
    };
    const owners = { B: await signerForRpc(manifest.chains.B.rpc, "B", 0) };
    const relayers = {
      A: await signerForRpc(manifest.chains.A.rpc, "A", 2),
      B: await signerForRpc(manifest.chains.B.rpc, "B", 2),
    };
    const artifacts = {
      ...await loadViewArtifacts(),
      app: await loadArtifact("apps/InstitutionalCollateralApp.sol", "InstitutionalCollateralApp"),
    };
    const contracts = createActionContracts({ manifest, providers, users, owners, artifacts });
    const runtimeDirectory = resolve(RUNTIME_ROOT, runtimeKey);
    await mkdir(runtimeDirectory, { recursive: true });
    const actionJournal = await InstitutionalActionJournal.open(resolve(runtimeDirectory, "action-journal.json"));

    await ensurePoolLiquidity(contracts, manifest.accounts.B.owner);
    const attestorCluster = await startAttestorCluster({ manifest, secrets, providers, runtimeDirectory, logger: this.logger });
    const relay = await createRelayRuntime({ manifest, relayers, endpoints: attestorCluster.endpoints, runtimeDirectory });
    const context = {
      manifest,
      secrets,
      providers,
      users,
      owners,
      relayers,
      artifacts,
      contracts,
      attestorCluster,
      relay,
      actionJournal,
    };
    this.context = context;
    this.relayTimer = setInterval(() => {
      this.#tickRelay().catch((error) => this.logger.error?.(`[institutional-ui] relay tick: ${compactError(error)}`));
    }, RELAY_POLL_MS);
    this.relayTimer.unref?.();
    await this.#tickRelay();
    return context;
  }

  async #executeAction(context, action, amount) {
    switch (action) {
      case "bridge":
        return this.#bridge(context, amount, "A-to-B");
      case "return":
        return this.#bridge(context, amount, "B-to-A");
      case "deposit":
        return this.#bankBTransaction(context, amount, "deposit");
      case "borrow":
        return this.#bankBTransaction(context, amount, "borrow");
      case "repay":
        return this.#bankBTransaction(context, amount, "repay");
      case "repayAll":
        return this.#bankBTransaction(context, amount, "repayAll");
      case "withdraw":
        return this.#bankBTransaction(context, amount, "withdraw");
      default:
        throw httpError(400, `Unsupported action ${action}`);
    }
  }

  async #resumeSubmittedAction(context, operation) {
    const sourceTransaction = operation.sourceTransaction;
    if (!/^0x[0-9a-fA-F]{64}$/.test(sourceTransaction || "")) {
      throw certainError(`Request ${operation.requestId} has no recoverable source transaction`);
    }

    this.activeOperation.stage = "reconciling-transaction";
    const provider = operation.action === "bridge" ? context.providers.A : context.providers.B;
    const receipt = await provider.getTransactionReceipt(sourceTransaction);
    if (!receipt) {
      throw httpError(409, `Transaction ${sourceTransaction} is still pending; retry reconciliation shortly`);
    }
    if (Number(receipt.status) !== 1) {
      const error = certainError(`Transaction ${sourceTransaction} reverted on-chain`);
      error.receipt = receipt;
      throw error;
    }

    if (["bridge", "return"].includes(operation.action)) {
      return this.#resumeBridge(context, operation, receipt);
    }

    await this.#recordSubmitted({ hash: receipt.hash }, { sourceBlock: receipt.blockNumber });
    const payment = ["repay", "repayAll"].includes(operation.action)
      ? findEventArgument(context.contracts.lendingPoolB, receipt, "Repaid", "amount")
      : null;
    if (["repay", "repayAll"].includes(operation.action) && payment == null) {
      throw new Error(`Transaction ${sourceTransaction} emitted no Repaid event`);
    }
    return {
      sourceTransaction: receipt.hash,
      sourceBlock: receipt.blockNumber,
      ...(payment == null ? {} : { amount: ethers.formatUnits(payment, 18) }),
      reconciled: true,
    };
  }

  async #resumeBridge(context, operation, receipt) {
    const forward = operation.action === "bridge";
    const sourceApp = forward ? context.contracts.collateralAppA : context.contracts.collateralAppB;
    const sourceGateway = forward ? context.contracts.gatewayA : context.contracts.gatewayB;
    const direction = forward ? "A-to-B" : "B-to-A";
    const messageId = operation.messageId
      || findEventArgument(sourceApp, receipt, "CollateralMessageSent", "messageId");
    if (!messageId) throw new Error(`Transaction ${receipt.hash} emitted no CollateralMessageSent event`);

    this.activeOperation.stage = "reconciling-relay";
    this.activeOperation.messageId = messageId;
    await this.#recordSubmitted(
      { hash: receipt.hash },
      { messageId, sourceBlock: receipt.blockNumber, clientReference: operation.clientReference || null },
    );
    await runUntil(
      () => this.#tickRelay(),
      async () => Boolean(
        await sourceGateway.messageCompleted(messageId)
        || await sourceGateway.messageTimedOut(messageId)
      ),
      `${direction} relay reconciliation`,
    );
    if (!await sourceGateway.messageCompleted(messageId)) {
      throw certainError(`${direction} message ${messageId} timed out and was compensated on the source chain`);
    }
    if (Number(await sourceApp.transferStatus(messageId)) !== 2) {
      throw new Error(`${direction} application transfer ${messageId} is not completed`);
    }
    const job = context.relay.journal.snapshot().jobs[messageId];
    return {
      messageId,
      sourceTransaction: receipt.hash,
      receiveTransaction: job?.transactions?.receive || null,
      acknowledgementTransaction: job?.transactions?.acknowledge || null,
      sourceBlock: receipt.blockNumber,
      reconciled: true,
    };
  }

  async #bridge(context, amount, direction) {
    const forward = direction === "A-to-B";
    const sourceApp = forward ? context.contracts.collateralAppA : context.contracts.collateralAppB;
    const sourceGateway = forward ? context.contracts.gatewayA : context.contracts.gatewayB;
    const destinationToken = forward ? context.contracts.voucherTokenB : context.contracts.canonicalTokenA;
    const destinationAccount = forward ? context.manifest.accounts.B.user : context.manifest.accounts.A.user;
    const destinationChainId = BigInt(forward ? context.manifest.chains.B.chainId : context.manifest.chains.A.chainId);
    const before = BigInt(await destinationToken.balanceOf(destinationAccount));

    if (forward) {
      await ensureAllowance(
        context.contracts.canonicalTokenA,
        await context.contracts.escrowVaultA.getAddress(),
        context.manifest.accounts.A.user,
        amount,
      );
    }

    this.activeOperation.stage = "source-confirmation";
    const sourceBlock = await sourceApp.runner.provider.getBlock("latest");
    const timeout = BigInt(sourceBlock.timestamp) + 30n * 60n;
    const reference = ethers.keccak256(
      ethers.toUtf8Bytes(`institutional-ui:${direction}:${this.activeOperation.requestId}`),
    );
    this.activeOperation.clientReference = reference;
    const transaction = forward
      ? await sourceApp.lockAndMint(destinationChainId, destinationAccount, amount, timeout, reference, TX_OPTIONS)
      : await sourceApp.burnAndUnlock(destinationChainId, destinationAccount, amount, timeout, reference, TX_OPTIONS);
    await this.#recordSubmitted(transaction, { clientReference: reference });
    const receipt = await waitForTx(transaction, `${direction} source transaction`);
    const messageId = findEventArgument(sourceApp, receipt, "CollateralMessageSent", "messageId");
    if (!messageId) throw new Error("Source application emitted no CollateralMessageSent event");
    this.activeOperation.messageId = messageId;
    await this.#recordSubmitted(transaction, { messageId, sourceBlock: receipt.blockNumber });

    this.activeOperation.stage = "attestor-quorum";
    await runUntil(
      () => this.#tickRelay(),
      () => sourceGateway.messageCompleted(messageId),
      `${direction} relay acknowledgement`,
    );
    const after = BigInt(await destinationToken.balanceOf(destinationAccount));
    if (after - before !== amount) throw new Error(`Destination balance changed by ${after - before}, expected ${amount}`);
    const job = context.relay.journal.snapshot().jobs[messageId];
    return {
      messageId,
      sourceTransaction: receipt.hash,
      receiveTransaction: job?.transactions?.receive || null,
      acknowledgementTransaction: job?.transactions?.acknowledge || null,
      sourceBlock: receipt.blockNumber,
    };
  }

  async #bankBTransaction(context, amount, action) {
    const pool = context.contracts.lendingPoolB;
    let transaction;
    if (action === "deposit") {
      await ensureAllowance(context.contracts.voucherTokenB, await pool.getAddress(), context.manifest.accounts.B.user, amount);
      this.activeOperation.stage = "depositing-collateral";
      transaction = await pool.depositCollateral(amount, TX_OPTIONS);
    } else if (action === "borrow") {
      this.activeOperation.stage = "risk-policy-check";
      transaction = await pool.borrow(amount, TX_OPTIONS);
    } else if (action === "repay") {
      await ensureAllowance(context.contracts.debtTokenB, await pool.getAddress(), context.manifest.accounts.B.user, amount);
      this.activeOperation.stage = "repaying-credit";
      transaction = await pool.repay(amount, TX_OPTIONS);
    } else if (action === "repayAll") {
      await ensureAllowance(context.contracts.debtTokenB, await pool.getAddress(), context.manifest.accounts.B.user, amount);
      this.activeOperation.stage = "repaying-complete-balance";
      transaction = await pool.repayAll(TX_OPTIONS);
    } else if (action === "withdraw") {
      this.activeOperation.stage = "withdrawing-collateral";
      transaction = await pool.withdrawCollateral(amount, TX_OPTIONS);
    } else {
      throw new Error(`Unsupported Bank B action ${action}`);
    }
    await this.#recordSubmitted(transaction);
    const receipt = await waitForTx(transaction, `${action} transaction`);
    const payment = ["repay", "repayAll"].includes(action)
      ? findEventArgument(pool, receipt, "Repaid", "amount")
      : null;
    return {
      sourceTransaction: receipt.hash,
      sourceBlock: receipt.blockNumber,
      ...(payment == null ? {} : { amount: ethers.formatUnits(payment, 18) }),
    };
  }

  async #tickRelay() {
    if (!this.context?.relay?.engine) return;
    if (!this.relayTickPromise) {
      this.relayTickPromise = this.context.relay.engine.tick().finally(() => { this.relayTickPromise = null; });
    }
    return this.relayTickPromise;
  }

  async #recordActivity(entry) {
    const state = this.activity || emptyActivity();
    state.latest = entry;
    state.history = [entry, ...(state.history || []).filter((item) => item.id !== entry.id)].slice(0, 40);
    state.updatedAt = new Date().toISOString();
    this.activity = state;
    await writeJsonAtomic(INSTITUTIONAL_DEMO_STATE_PATH, state);
  }

  async #recordSubmitted(transaction, patch = {}) {
    Object.assign(this.activeOperation, patch, {
      sourceTransaction: transaction.hash,
    });
    await this.context.actionJournal.submitted(
      this.activeOperation.requestId,
      transaction.hash,
      { stage: this.activeOperation.stage, ...patch },
    );
    await this.#recordActivity(this.#activeActivity("submitted"));
  }

  #activeActivity(status) {
    return {
      id: this.activeOperation.id,
      requestId: this.activeOperation.requestId,
      action: this.activeOperation.action,
      label: this.activeOperation.label,
      lane: this.activeOperation.lane,
      amount: this.activeOperation.amount,
      status,
      startedAt: this.activeOperation.startedAt,
      sourceTransaction: this.activeOperation.sourceTransaction || null,
      messageId: this.activeOperation.messageId || null,
    };
  }
}

function createActionContracts({ manifest, providers, users, owners, artifacts }) {
  const address = (chain, name) => manifest.chains[chain].contracts[name].address;
  const view = createViewContracts(manifest, providers, artifacts);
  return {
    ...view,
    collateralAppA: new ethers.Contract(address("A", "collateralApp"), artifacts.app.abi, users.A),
    collateralAppB: new ethers.Contract(address("B", "collateralApp"), artifacts.app.abi, users.B),
    gatewayA: new ethers.Contract(address("A", "gateway"), artifacts.gateway.abi, users.A),
    gatewayB: new ethers.Contract(address("B", "gateway"), artifacts.gateway.abi, users.B),
    canonicalTokenA: new ethers.Contract(address("A", "canonicalToken"), artifacts.token.abi, users.A),
    escrowVaultA: new ethers.Contract(address("A", "escrowVault"), artifacts.escrow.abi, users.A),
    voucherTokenB: new ethers.Contract(address("B", "voucherToken"), artifacts.voucher.abi, users.B),
    debtTokenB: new ethers.Contract(address("B", "debtToken"), artifacts.token.abi, users.B),
    lendingPoolB: new ethers.Contract(address("B", "lendingPool"), artifacts.lending.abi, users.B),
    debtTokenBOwner: new ethers.Contract(address("B", "debtToken"), artifacts.token.abi, owners.B),
    lendingPoolBOwner: new ethers.Contract(address("B", "lendingPool"), artifacts.lending.abi, owners.B),
  };
}

function actionAmount(action, requested, status) {
  if (action === "repayAll") {
    const debt = ethers.parseUnits(status.balances.outstandingDebt || "0", 18);
    const balance = ethers.parseUnits(status.balances.creditAvailable || "0", 18);
    if (debt === 0n) throw httpError(400, "No outstanding Bank B credit remains");
    if (balance < debt) throw httpError(409, "Wallet bCASH balance is insufficient to repay the complete debt");
    return debt;
  }
  const limits = {
    bridge: status.balances.canonicalAvailable,
    deposit: status.balances.voucherAvailable,
    borrow: status.risk.availableBorrow,
    repay: smallerDecimal(status.balances.outstandingDebt, status.balances.creditAvailable),
    withdraw: status.balances.activeCollateral,
    return: status.balances.voucherAvailable,
  };
  const maximum = ethers.parseUnits(limits[action] || "0", 18);
  return parseActionAmount(requested, { maximum });
}

function normalizeRequestId(value) {
  const requestId = value == null || String(value).trim() === ""
    ? `request-${Date.now()}-${randomBytes(8).toString("hex")}`
    : String(value).trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(requestId)) {
    throw httpError(400, "requestId must contain 8-128 letters, digits, dots, colons, underscores or hyphens");
  }
  return requestId;
}

async function ensurePoolLiquidity(contracts, ownerAddress) {
  const available = BigInt(await contracts.lendingPoolBOwner.availableLiquidity());
  if (available >= MINIMUM_POOL_LIQUIDITY) return;
  const signerAddress = await contracts.lendingPoolBOwner.runner.getAddress();
  if (ethers.getAddress(ownerAddress) !== ethers.getAddress(signerAddress)) {
    throw new Error(
      `Deployment manifest Bank B owner ${ownerAddress} does not match the active operator ${signerAddress}; ` +
        "run npm run institutional:deploy before starting the UI",
    );
  }
  const amount = MINIMUM_POOL_LIQUIDITY - available;
  const balance = BigInt(await contracts.debtTokenBOwner.balanceOf(signerAddress));
  if (balance < amount) throw new Error(`Bank B liquidity provider has ${balance}, needs ${amount}`);
  await ensureAllowance(
    contracts.debtTokenBOwner,
    await contracts.lendingPoolBOwner.getAddress(),
    signerAddress,
    amount,
  );
  await waitForTx(await contracts.lendingPoolBOwner.depositLiquidity(amount, TX_OPTIONS), "seed institutional liquidity");
}

async function startAttestorCluster({ manifest, secrets, providers, runtimeDirectory, logger }) {
  const token = `ui-${randomBytes(24).toString("hex")}`;
  const finalityDepth = Number(manifest.securityProfile.finalityDepth);
  const sources = {
    [manifest.chains.A.chainId]: { provider: providers.A, finalityDepth },
    [manifest.chains.B.chainId]: { provider: providers.B, finalityDepth },
  };
  const nodes = [];
  for (const entry of secrets.attestors) {
    const journal = await AttestorJournal.open(resolve(runtimeDirectory, `attestor-${entry.address}.json`));
    const attestor = new CheckpointAttestor({ wallet: new ethers.Wallet(entry.privateKey), sources, journal });
    const server = createAttestorHttpServer({ attestor, token, logger });
    await listen(server, 0);
    nodes.push({ server, signer: attestor.signerAddress, port: server.address().port });
  }
  return {
    nodes,
    endpoints: nodes.map((node) => ({ url: `http://127.0.0.1:${node.port}`, token })),
    async close() {
      await Promise.all(nodes.map((node) => close(node.server)));
    },
  };
}

async function createRelayRuntime({ manifest, relayers, endpoints, runtimeDirectory }) {
  const finalityDepth = Number(manifest.securityProfile.finalityDepth);
  const laneConfig = (sourceKey, destinationKey) => ({
    source: endpointConfig(manifest, sourceKey, finalityDepth),
    destination: endpointConfig(manifest, destinationKey, finalityDepth),
    attestors: endpoints,
    attestorTimeoutMs: 2_500,
    transactionTimeoutMs: TX_TIMEOUT_MS,
    pollIntervalMs: 500,
    scanRange: 500,
    gasLimit: "5000000",
  });
  const journal = await RelayJournal.open(resolve(runtimeDirectory, "relay-journal.json"));
  const lanes = [
    {
      id: "A-to-B",
      startBlock: Number(manifest.chains.A.deploymentBlock),
      workflow: await createEthersLaneWorkflow(laneConfig("A", "B"), {
        sourceSigner: relayers.A,
        destinationSigner: relayers.B,
      }),
    },
    {
      id: "B-to-A",
      startBlock: Number(manifest.chains.B.deploymentBlock),
      workflow: await createEthersLaneWorkflow(laneConfig("B", "A"), {
        sourceSigner: relayers.B,
        destinationSigner: relayers.A,
      }),
    },
  ];
  const engine = new InstitutionalRelayEngine({
    journal,
    lanes,
    leaseMs: 15_000,
    batchSize: 20,
    retry: { initialMs: 250, maximumMs: 2_000, jitterRatio: 0 },
  });
  return { engine, journal };
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

function validateDeployment(manifest, secrets) {
  if (manifest.version !== "institutional-deployment-v1" || manifest.status !== "ready") {
    throw new Error("Run npm run institutional:deploy before starting the institutional UI");
  }
  if (manifest.securityProfile.governanceMode !== "timelock-enforced") {
    throw new Error("Run npm run institutional:governance before starting the institutional UI");
  }
  if (secrets.version !== "institutional-attestor-secrets-v1" || secrets.attestors?.length !== 4) {
    throw new Error("Institutional attestor secrets are missing or invalid");
  }
  const expected = new Set(manifest.securityProfile.attestors.map((address) => ethers.getAddress(address)));
  for (const entry of secrets.attestors) {
    const wallet = new ethers.Wallet(entry.privateKey);
    if (!expected.has(wallet.address)) throw new Error(`Attestor ${wallet.address} is not configured`);
  }
}

async function ensureAllowance(token, spender, owner, required) {
  if (BigInt(await token.allowance(owner, spender)) >= required) return;
  await waitForTx(await token.approve(spender, ethers.MaxUint256, TX_OPTIONS), `approve ${spender}`);
}

async function runUntil(tick, predicate, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < FLOW_TIMEOUT_MS) {
    if (await predicate()) return;
    await tick();
    if (await predicate()) return;
    await sleep(500);
  }
  throw new Error(`${label} did not complete within ${FLOW_TIMEOUT_MS}ms`);
}

function findEventArgument(contract, receipt, eventName, argument) {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed?.name === eventName) return parsed.args[argument];
    } catch {
      // The receipt also includes gateway, policy and token logs.
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

function smallerDecimal(left, right) {
  const a = ethers.parseUnits(left || "0", 18);
  const b = ethers.parseUnits(right || "0", 18);
  return ethers.formatUnits(a < b ? a : b, 18);
}

function emptyActivity(deploymentId = null) {
  return { version: "institutional-demo-state-v1", deploymentId, latest: null, history: [], updatedAt: null };
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
    if (!server.listening) return resolveClose();
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function compactError(error) {
  return error?.shortMessage || error?.info?.error?.message || error?.message || String(error);
}

function certainError(message) {
  const error = new Error(message);
  error.outcomeCertain = true;
  return error;
}

function httpError(statusCode, message, payload = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.payload = { ok: false, error: message, ...payload };
  return error;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
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
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

export const INSTITUTIONAL_ACTIONS = ACTIONS;
