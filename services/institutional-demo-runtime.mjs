import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { ethers } from "ethers";
import {
  InstitutionalActionJournal,
  UnresolvedActionConflictError,
} from "./institutional-action-journal.mjs";
import {
  ActiveExecutionTracker,
  executeDurableTransaction,
  recoverUnresolvedActionJournal,
  transactionOutcomeIsUncertain,
} from "./institutional-durable-action-runtime.mjs";
import {
  defaultBesuRuntimeEnv,
  loadArtifact,
  providerForRpc,
  readLatestBlock,
  signerForRpc,
} from "../scripts/ops/besu/runtime.mjs";
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
import { readJson, readJsonIfExists, writeJsonAtomic } from "./shared/json-file.mjs";
import { createTransactionWaiter } from "./shared/transaction-receipt.mjs";

const ATTESTOR_SECRETS_PATH = resolve(
  process.cwd(),
  process.env.INSTITUTIONAL_ATTESTOR_SECRETS_PATH || ".runtime/institutional-attestor-secrets.json",
);
const RUNTIME_ROOT = resolve(process.cwd(), process.env.INSTITUTIONAL_DEMO_ROOT || ".runtime/institutional-demo");
const TX_TIMEOUT_MS = positiveMilliseconds(
  process.env.INSTITUTIONAL_TX_TIMEOUT_MS || 90_000,
  "INSTITUTIONAL_TX_TIMEOUT_MS",
);
const FLOW_TIMEOUT_MS = positiveMilliseconds(
  process.env.INSTITUTIONAL_FLOW_TIMEOUT_MS || 180_000,
  "INSTITUTIONAL_FLOW_TIMEOUT_MS",
);
const RELAY_POLL_MS = positiveMilliseconds(
  process.env.INSTITUTIONAL_DEMO_RELAY_POLL_MS || 1_000,
  "INSTITUTIONAL_DEMO_RELAY_POLL_MS",
);
const ACTION_RECOVERY_POLL_MS = positiveMilliseconds(
  process.env.INSTITUTIONAL_ACTION_RECOVERY_POLL_MS || 2_000,
  "INSTITUTIONAL_ACTION_RECOVERY_POLL_MS",
);
const ACTION_RECOVERY_MAX_POLL_MS = positiveMilliseconds(
  process.env.INSTITUTIONAL_ACTION_RECOVERY_MAX_POLL_MS || 60_000,
  "INSTITUTIONAL_ACTION_RECOVERY_MAX_POLL_MS",
);
if (ACTION_RECOVERY_MAX_POLL_MS < ACTION_RECOVERY_POLL_MS) {
  throw new RangeError("INSTITUTIONAL_ACTION_RECOVERY_MAX_POLL_MS must be at least the recovery poll interval");
}
const MINIMUM_POOL_LIQUIDITY = ethers.parseEther(process.env.INSTITUTIONAL_DEMO_MIN_LIQUIDITY || "100000");
const TX_OPTIONS = Object.freeze({ gasLimit: 5_000_000n });
const waitForTx = createTransactionWaiter({
  timeoutMs: TX_TIMEOUT_MS,
  timeoutMessage: ({ label, hash }) => `${label} timed out; tx=${hash}`,
  failureMessage: ({ label, hash }) => `${label} failed; tx=${hash}`,
});

defaultBesuRuntimeEnv();

const ACTIONS = Object.freeze({
  bridge: { label: "Lock aBANK and issue vA on Bank B", lane: "A-to-B" },
  deposit: { label: "Activate voucher collateral", lane: "Bank B" },
  borrow: { label: "Borrow bCASH from Bank B", lane: "Bank B" },
  repay: { label: "Repay Bank B debt", lane: "Bank B" },
  repayAll: { label: "Repay complete Bank B balance", lane: "Bank B" },
  withdraw: { label: "Withdraw voucher collateral", lane: "Bank B" },
  return: { label: "Return collateral to Bank A", lane: "B-to-A" },
});

export {
  ActiveExecutionTracker,
  executeDurableTransaction,
  recoverUnresolvedActionJournal,
  transactionOutcomeIsUncertain,
};

export class InstitutionalDemoRuntime {
  constructor({ logger = console, activityWriter = writeJsonAtomic } = {}) {
    if (typeof activityWriter !== "function") throw new TypeError("activityWriter must be a function");
    this.logger = logger;
    this.activityWriter = activityWriter;
    this.initializing = null;
    this.context = null;
    this.activity = null;
    this.activeOperation = null;
    this.executionTracker = new ActiveExecutionTracker();
    this.relayTimer = null;
    this.relayTickPromise = null;
    this.readinessState = { chainProgress: {} };
    this.relayHealth = {
      lastAttemptAt: null,
      lastHealthyAt: null,
      lastError: null,
    };
    this.recoveryTimer = null;
    this.recoveryPromise = null;
    this.lastRecoveryError = null;
    this.recoveryFailureCount = 0;
    this.closing = null;
  }

  async initialize() {
    if (this.context) return this.context;
    if (!this.initializing) this.initializing = this.#initialize().finally(() => { this.initializing = null; });
    return this.initializing;
  }

  async status() {
    try {
      const context = await this.initialize();
      const status = await readInstitutionalStatus({
        ...context,
        activity: this.activity,
        relayJournal: context.relay.journal,
        activeAttestors: context.attestorCluster.nodes.filter((node) => node.server?.listening).length,
        readinessState: this.readinessState,
        relayHealth: this.relayHealth,
        activeOperation: this.publicActiveOperation(),
      });
      const unresolved = publicRecoverableOperations(context.actionJournal.unresolved());
      this.#scheduleActionRecovery();
      return {
        ...status,
        controller: {
          ...status.controller,
          recoverableOperations: unresolved,
          recovery: {
            running: Boolean(this.recoveryPromise),
            pendingCount: unresolved.length,
            lastError: this.lastRecoveryError,
          },
        },
      };
    } catch (error) {
      return readInstitutionalStatus({ activity: this.activity }).then((status) => ({
        ...status,
        ready: false,
        error: compactError(error),
        message: compactError(error),
        controller: {
          busy: false,
          activeOperation: null,
          recoverableOperations: [],
          recovery: { running: false, pendingCount: 0, lastError: null },
        },
      }));
    }
  }

  async execute(request) {
    if (this.closing) throw httpError(503, "Institutional runtime is shutting down");
    const execution = this.#executeRequest(request);
    return this.executionTracker.track(execution);
  }

  async #executeRequest(request) {
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
          throw journalOperationHttpError(
            409,
            `Idempotency key ${requestId} belongs to ${existing.action}, not ${action}`,
            existing,
          );
        }
        if (request?.amount != null && String(request.amount).trim() !== "") {
          let requestedAmount;
          try {
            requestedAmount = parseActionAmount(request.amount);
          } catch (amountError) {
            throw journalOperationHttpError(
              amountError.statusCode || 400,
              compactError(amountError),
              existing,
            );
          }
          if (requestedAmount !== ethers.parseUnits(existing.amount, 18)) {
            throw journalOperationHttpError(
              409,
              `Idempotency key ${requestId} was already used for a different amount`,
              existing,
            );
          }
        }
        if (existing.status === "completed") {
          await this.#recordActivity(existing.result);
          this.activeOperation = null;
          return { ok: true, replayed: true, operation: existing.result, status: await this.status() };
        }
        if (existing.status === "failed") {
          throw journalOperationHttpError(409, `Request ${requestId} previously failed`, existing);
        }
        if (!["prepared", "signed", "broadcasting", "submitted", "uncertain"].includes(existing.status)) {
          throw journalOperationHttpError(
            409,
            `Request ${requestId} has unsupported journal status ${existing.status}`,
            existing,
          );
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

      const result = existing && (existing.status !== "prepared" || existing.outbox)
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
      if (error instanceof UnresolvedActionConflictError) {
        const conflict = journalOperationHttpError(409, error.message, error.blockingOperation);
        conflict.code = error.code;
        conflict.payload.code = error.code;
        this.activeOperation = null;
        throw conflict;
      }
      if (error?.preserveJournalOperation) {
        this.activeOperation = null;
        throw error;
      }
      const journalOperation = context?.actionJournal?.get(requestId);
      const knownSourceTransaction = this.activeOperation?.sourceTransaction
        || journalOperation?.outbox?.transactionHash
        || journalOperation?.sourceTransaction
        || null;
      const outcomeUncertain = transactionOutcomeIsUncertain(error, knownSourceTransaction);
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
        sourceTransaction: knownSourceTransaction,
        error: compactError(error),
      };
      if (journalPrepared) {
        try {
          await context.actionJournal.fail(requestId, error, {
            uncertain: outcomeUncertain,
            sourceTransaction: knownSourceTransaction,
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
    if (!this.closing) {
      this.closing = this.#close().finally(() => { this.closing = null; });
    }
    return this.closing;
  }

  async #close() {
    if (this.relayTimer) clearInterval(this.relayTimer);
    this.relayTimer = null;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    if (this.initializing) await this.initializing.catch(() => {});
    if (this.relayTimer) clearInterval(this.relayTimer);
    this.relayTimer = null;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    if (this.recoveryPromise) await this.recoveryPromise.catch(() => {});
    await this.executionTracker.waitForIdle();

    const context = this.context;
    this.context = null;
    const cleanupErrors = [];
    if (this.relayTickPromise) {
      try {
        await this.relayTickPromise;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    cleanupErrors.push(...await closeRuntimeResources(context));
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Institutional demo runtime did not close cleanly");
    }
  }

  async #initialize() {
    const [manifest, secrets, activity] = await Promise.all([
      readJson(INSTITUTIONAL_DEPLOYMENT_PATH),
      readJson(ATTESTOR_SECRETS_PATH),
      readJsonIfExists(INSTITUTIONAL_DEMO_STATE_PATH),
    ]);
    validateDeployment(manifest, secrets);
    this.readinessState = { chainProgress: {} };
    this.relayHealth = { lastAttemptAt: null, lastHealthyAt: null, lastError: null };
    const runtimeKey = `${manifest.chains.A.contracts.gateway.address.slice(2, 10)}-${manifest.chains.B.contracts.gateway.address.slice(2, 10)}`;
    this.activity = activity?.version === "institutional-demo-state-v1" && activity.deploymentId === runtimeKey
      ? activity
      : emptyActivity(runtimeKey);

    let context = null;
    const partial = { providers: null, users: null, owners: null, relayers: null };
    try {
      const providers = {};
      partial.providers = providers;
      providers.A = providerForRpc(manifest.chains.A.rpc);
      providers.B = providerForRpc(manifest.chains.B.rpc);
      const users = {};
      partial.users = users;
      users.A = await signerForRpc(manifest.chains.A.rpc, "A", 1);
      users.B = await signerForRpc(manifest.chains.B.rpc, "B", 1);
      const owners = {};
      partial.owners = owners;
      owners.B = await signerForRpc(manifest.chains.B.rpc, "B", 0);
      const relayers = {};
      partial.relayers = relayers;
      relayers.A = await signerForRpc(manifest.chains.A.rpc, "A", 2);
      relayers.B = await signerForRpc(manifest.chains.B.rpc, "B", 2);
      const artifacts = {
        ...await loadViewArtifacts(),
        app: await loadArtifact("apps/InstitutionalCollateralApp.sol", "InstitutionalCollateralApp"),
      };
      const contracts = createActionContracts({ manifest, providers, users, owners, artifacts });
      const runtimeDirectory = resolve(RUNTIME_ROOT, runtimeKey);
      await mkdir(runtimeDirectory, { recursive: true });
      const actionJournal = await InstitutionalActionJournal.open(resolve(runtimeDirectory, "action-journal.json"));
      partial.actionJournal = actionJournal;

      await ensurePoolLiquidity(contracts, manifest.accounts.B.owner);
      const attestorCluster = await startAttestorCluster({
        manifest,
        secrets,
        providers,
        runtimeDirectory,
        logger: this.logger,
      });
      partial.attestorCluster = attestorCluster;
      const relay = await createRelayRuntime({
        manifest,
        relayers,
        endpoints: attestorCluster.endpoints,
        runtimeDirectory,
      });
      partial.relay = relay;
      context = {
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
      this.#scheduleActionRecovery();
      return context;
    } catch (initializationError) {
      if (this.relayTimer) clearInterval(this.relayTimer);
      this.relayTimer = null;
      if (this.relayTickPromise) {
        await this.relayTickPromise.catch(() => {});
      }
      if (this.context === context) this.context = null;
      const cleanupErrors = await closeRuntimeResources(context || partial);
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [initializationError, ...cleanupErrors],
          "Institutional demo runtime failed to initialize and fully release its resources",
        );
      }
      throw initializationError;
    }
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
    const sourceTransaction = operation.outbox?.transactionHash || operation.sourceTransaction;
    if (!/^0x[0-9a-fA-F]{64}$/.test(sourceTransaction || "")) {
      throw certainError(`Request ${operation.requestId} has no recoverable source transaction`);
    }

    this.activeOperation.stage = "reconciling-transaction";
    let receipt;
    if (operation.outbox) {
      const signer = operation.action === "bridge" ? context.users.A : context.users.B;
      receipt = await this.#executeDurableTransaction(context, {
        signer,
        transactionRequest: null,
        label: `${operation.action} transaction reconciliation`,
      });
    } else {
      const provider = operation.action === "bridge" ? context.providers.A : context.providers.B;
      receipt = await provider.getTransactionReceipt(sourceTransaction);
      if (!receipt) {
        throw httpError(409, `Transaction ${sourceTransaction} is still pending; retry reconciliation shortly`);
      }
      assertSuccessfulReceipt(receipt, sourceTransaction, `${operation.action} transaction reconciliation`);
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
    const sourceBlock = await readLatestBlock(sourceApp.runner.provider, {
      label: `${direction} source block`,
    });
    const timeout = BigInt(sourceBlock.timestamp) + 30n * 60n;
    const reference = ethers.keccak256(
      ethers.toUtf8Bytes(`institutional-ui:${direction}:${this.activeOperation.requestId}`),
    );
    this.activeOperation.clientReference = reference;
    const transactionRequest = forward
      ? await sourceApp.lockAndMint.populateTransaction(
          destinationChainId,
          destinationAccount,
          amount,
          timeout,
          reference,
          TX_OPTIONS,
        )
      : await sourceApp.burnAndUnlock.populateTransaction(
          destinationChainId,
          destinationAccount,
          amount,
          timeout,
          reference,
          TX_OPTIONS,
        );
    const receipt = await this.#executeDurableTransaction(context, {
      signer: sourceApp.runner,
      transactionRequest,
      label: `${direction} source transaction`,
      patch: { clientReference: reference },
    });
    const messageId = findEventArgument(sourceApp, receipt, "CollateralMessageSent", "messageId");
    if (!messageId) throw new Error("Source application emitted no CollateralMessageSent event");
    this.activeOperation.messageId = messageId;
    await this.#recordSubmitted({ hash: receipt.hash }, { messageId, sourceBlock: receipt.blockNumber });

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
    let transactionRequest;
    if (action === "deposit") {
      await ensureAllowance(context.contracts.voucherTokenB, await pool.getAddress(), context.manifest.accounts.B.user, amount);
      this.activeOperation.stage = "depositing-collateral";
      transactionRequest = await pool.depositCollateral.populateTransaction(amount, TX_OPTIONS);
    } else if (action === "borrow") {
      this.activeOperation.stage = "risk-policy-check";
      transactionRequest = await pool.borrow.populateTransaction(amount, TX_OPTIONS);
    } else if (action === "repay") {
      await ensureAllowance(context.contracts.debtTokenB, await pool.getAddress(), context.manifest.accounts.B.user, amount);
      this.activeOperation.stage = "repaying-credit";
      transactionRequest = await pool.repay.populateTransaction(amount, TX_OPTIONS);
    } else if (action === "repayAll") {
      await ensureAllowance(context.contracts.debtTokenB, await pool.getAddress(), context.manifest.accounts.B.user, amount);
      this.activeOperation.stage = "repaying-complete-balance";
      transactionRequest = await pool.repayAll.populateTransaction(TX_OPTIONS);
    } else if (action === "withdraw") {
      this.activeOperation.stage = "withdrawing-collateral";
      transactionRequest = await pool.withdrawCollateral.populateTransaction(amount, TX_OPTIONS);
    } else {
      throw new Error(`Unsupported Bank B action ${action}`);
    }
    const receipt = await this.#executeDurableTransaction(context, {
      signer: pool.runner,
      transactionRequest,
      label: `${action} transaction`,
    });
    await this.#recordSubmitted({ hash: receipt.hash }, { sourceBlock: receipt.blockNumber });
    const payment = ["repay", "repayAll"].includes(action)
      ? findEventArgument(pool, receipt, "Repaid", "amount")
      : null;
    if (["repay", "repayAll"].includes(action) && payment == null) {
      throw new Error(`Transaction ${receipt.hash} emitted no Repaid event`);
    }
    return {
      sourceTransaction: receipt.hash,
      sourceBlock: receipt.blockNumber,
      ...(payment == null ? {} : { amount: ethers.formatUnits(payment, 18) }),
    };
  }

  async #tickRelay() {
    if (!this.context?.relay?.engine) return;
    if (!this.relayTickPromise) {
      this.relayHealth.lastAttemptAt = new Date().toISOString();
      this.relayTickPromise = this.context.relay.engine.tick()
        .then((result) => {
          if (result.scanErrors?.length > 0) {
            this.relayHealth.lastError = result.scanErrors.map((entry) => (
              `${entry.laneId}: ${entry.error?.message || "scan failed"}`
            )).join("; ");
          } else {
            this.relayHealth.lastHealthyAt = new Date().toISOString();
            this.relayHealth.lastError = null;
          }
          return result;
        })
        .catch((error) => {
          this.relayHealth.lastError = compactError(error);
          throw error;
        })
        .finally(() => { this.relayTickPromise = null; });
    }
    return this.relayTickPromise;
  }

  #scheduleActionRecovery(delayMs = 0) {
    if (this.closing || this.recoveryTimer || this.recoveryPromise || !this.context?.actionJournal) return;
    if (this.context.actionJournal.unresolved().length === 0) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      this.#recoverUnresolvedActions().catch((error) => {
        this.logger.error?.(`[institutional-ui] action recovery: ${compactError(error)}`);
      });
    }, delayMs);
    this.recoveryTimer.unref?.();
  }

  async #recoverUnresolvedActions() {
    if (this.recoveryPromise) return this.recoveryPromise;
    if (this.closing || !this.context?.actionJournal) return [];
    if (this.activeOperation) {
      this.#scheduleActionRecovery(ACTION_RECOVERY_POLL_MS);
      return [];
    }

    const context = this.context;
    const recovery = recoverUnresolvedActionJournal({
      actionJournal: context.actionJournal,
      executeAction: (request) => this.execute(request),
      onError: (error, operation) => {
        this.lastRecoveryError = {
          requestId: operation.requestId,
          message: compactError(error),
          at: new Date().toISOString(),
        };
        this.logger.error?.(
          `[institutional-ui] recover action ${operation.requestId}: ${compactError(error)}`,
        );
      },
    });
    this.recoveryPromise = recovery;
    try {
      const results = await recovery;
      if (results.length > 0 && results.every((result) => result.ok)) {
        this.lastRecoveryError = null;
        this.recoveryFailureCount = 0;
      } else if (results.some((result) => !result.ok)) {
        this.recoveryFailureCount += 1;
      }
      return results;
    } catch (error) {
      this.recoveryFailureCount += 1;
      throw error;
    } finally {
      if (this.recoveryPromise === recovery) this.recoveryPromise = null;
      if (!this.closing && this.context === context && context.actionJournal.unresolved().length > 0) {
        this.#scheduleActionRecovery(recoveryBackoffMilliseconds(this.recoveryFailureCount));
      }
    }
  }

  async #executeDurableTransaction(context, { signer, transactionRequest, label, patch = {} }) {
    const operation = context.actionJournal.get(this.activeOperation.requestId);
    if (operation?.outbox) this.activeOperation.sourceTransaction = operation.outbox.transactionHash;
    return executeDurableTransaction({
      actionJournal: context.actionJournal,
      requestId: this.activeOperation.requestId,
      signer,
      transactionRequest,
      label,
      patch: { stage: this.activeOperation.stage, ...patch },
      hooks: {
        afterPersist: async (outbox) => this.#recordOutboxActivity(outbox, "signed", patch),
        onBroadcasting: async (outbox) => this.#recordOutboxActivity(outbox, "broadcasting", patch),
        onSubmitted: async (outbox) => this.#recordOutboxActivity(outbox, "submitted", patch),
      },
      onHookError: (error) => {
        this.logger.error?.(`[institutional-ui] action activity projection: ${compactError(error)}`);
      },
    });
  }

  async #recordOutboxActivity(outbox, status, patch) {
    Object.assign(this.activeOperation, patch, { sourceTransaction: outbox.transactionHash });
    await this.#recordActivity(this.#activeActivity(status));
  }

  async #recordActivity(entry) {
    const state = this.activity || emptyActivity();
    state.latest = entry;
    state.history = [entry, ...(state.history || []).filter((item) => item.id !== entry.id)].slice(0, 40);
    state.updatedAt = new Date().toISOString();
    this.activity = state;
    try {
      await this.activityWriter(INSTITUTIONAL_DEMO_STATE_PATH, state);
      return true;
    } catch (error) {
      this.logger.error?.(`[institutional-ui] activity projection: ${compactError(error)}`);
      return false;
    }
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
    if (debt === 0n) throw httpError(400, "No outstanding Bank B debt remains");
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

function publicRecoverableOperations(operations) {
  return operations.map((operation) => ({
    requestId: operation.requestId,
    action: operation.action,
    label: operation.label,
    lane: operation.lane,
    amount: operation.amount,
    status: operation.status,
    sourceTransaction: operation.outbox?.transactionHash || operation.sourceTransaction || null,
    broadcastAttempts: operation.outbox?.broadcastAttempts || 0,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    error: operation.error || null,
  }));
}

function normalizeRequestId(value) {
  if (value == null || String(value).trim() === "") {
    throw httpError(400, "requestId is required for every financial action");
  }
  const requestId = String(value).trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(requestId)) {
    throw httpError(400, "requestId must contain 8-128 letters, digits, dots, colons, underscores or hyphens");
  }
  if (["__proto__", "constructor", "prototype"].includes(requestId)) {
    throw httpError(400, "requestId uses a reserved identifier");
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

export async function startAttestorCluster({
  manifest,
  secrets,
  providers,
  runtimeDirectory,
  logger,
  dependencies = {},
}) {
  const openJournal = dependencies.openJournal || ((path) => AttestorJournal.open(path));
  const createAttestor = dependencies.createAttestor || ((options) => new CheckpointAttestor(options));
  const createServer = dependencies.createServer || createAttestorHttpServer;
  const listenServer = dependencies.listenServer || listen;
  const token = `ui-${randomBytes(24).toString("hex")}`;
  const finalityDepth = Number(manifest.securityProfile.finalityDepth);
  const sources = {
    [manifest.chains.A.chainId]: { provider: providers.A, finalityDepth },
    [manifest.chains.B.chainId]: { provider: providers.B, finalityDepth },
  };
  const allowedDomains = allowedCheckpointDomains(manifest);
  const nodes = [];
  try {
    for (const entry of secrets.attestors) {
      const node = { server: null, journal: null, signer: null, port: null };
      nodes.push(node);
      const wallet = new ethers.Wallet(entry.privateKey);
      node.journal = await openJournal(resolve(runtimeDirectory, `attestor-${wallet.address}.json`));
      const attestor = createAttestor({
        wallet,
        sources,
        journal: node.journal,
        allowedDomains,
      });
      node.signer = attestor.signerAddress;
      node.server = createServer({ attestor, token, logger });
      await listenServer(node.server, 0);
      node.port = node.server.address().port;
    }
  } catch (startupError) {
    const cleanupErrors = await closeAttestorNodes(nodes);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [startupError, ...cleanupErrors],
        "Attestor cluster failed to start and fully release its partial resources",
      );
    }
    throw startupError;
  }
  let closePromise = null;
  return {
    nodes,
    endpoints: nodes.map((node) => ({ url: `http://127.0.0.1:${node.port}`, token })),
    close() {
      if (!closePromise) {
        closePromise = closeAttestorNodes(nodes).then((errors) => {
          if (errors.length > 0) throw new AggregateError(errors, "Attestor cluster did not close cleanly");
        });
      }
      return closePromise;
    },
  };
}

export async function createRelayRuntime({
  manifest,
  relayers,
  endpoints,
  runtimeDirectory,
  dependencies = {},
}) {
  const openJournal = dependencies.openJournal || ((path) => RelayJournal.open(path));
  const createWorkflow = dependencies.createWorkflow || createEthersLaneWorkflow;
  const createEngine = dependencies.createEngine || ((options) => new InstitutionalRelayEngine(options));
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
  const journal = await openJournal(resolve(runtimeDirectory, "relay-journal.json"));
  try {
    const lanes = [
      {
        id: "A-to-B",
        startBlock: Number(manifest.chains.A.deploymentBlock),
        workflow: await createWorkflow(laneConfig("A", "B"), {
          sourceSigner: relayers.A,
          destinationSigner: relayers.B,
        }),
      },
      {
        id: "B-to-A",
        startBlock: Number(manifest.chains.B.deploymentBlock),
        workflow: await createWorkflow(laneConfig("B", "A"), {
          sourceSigner: relayers.B,
          destinationSigner: relayers.A,
        }),
      },
    ];
    const engine = createEngine({
      journal,
      lanes,
      leaseMs: 15_000,
      batchSize: 20,
      retry: { baseMs: 250, maxMs: 2_000, jitterRatio: 0 },
    });
    return { engine, journal };
  } catch (startupError) {
    try {
      await journal.close();
    } catch (closeError) {
      throw new AggregateError(
        [startupError, closeError],
        "Relay runtime failed to start and release its journal",
      );
    }
    throw startupError;
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

function validateDeployment(manifest, secrets) {
  if (manifest.version !== "institutional-deployment-v2" || manifest.status !== "ready") {
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

async function closeAttestorNodes(nodes) {
  const errors = [];
  const serverResults = await Promise.allSettled(
    nodes.filter((node) => node.server).map((node) => close(node.server)),
  );
  errors.push(...serverResults.filter((result) => result.status === "rejected").map((result) => result.reason));
  const journalResults = await Promise.allSettled(
    nodes.filter((node) => node.journal).map((node) => node.journal.close()),
  );
  errors.push(...journalResults.filter((result) => result.status === "rejected").map((result) => result.reason));
  return errors;
}

export async function closeRuntimeResources(context) {
  if (!context) return [];
  const errors = [];
  for (const resource of [context.attestorCluster, context.relay?.journal, context.actionJournal]) {
    if (!resource || typeof resource.close !== "function") continue;
    try {
      await resource.close();
    } catch (error) {
      errors.push(error);
    }
  }

  const providers = new Set(Object.values(context.providers || {}));
  for (const signerGroup of [context.users, context.owners, context.relayers]) {
    for (const signer of Object.values(signerGroup || {})) {
      if (signer?.provider) providers.add(signer.provider);
    }
  }
  const providerResults = await Promise.allSettled(
    [...providers]
      .filter((provider) => typeof provider?.destroy === "function")
      .map((provider) => Promise.resolve().then(() => provider.destroy())),
  );
  errors.push(...providerResults.filter((result) => result.status === "rejected").map((result) => result.reason));
  return errors;
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

export function positiveMilliseconds(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) {
    throw new RangeError(`${label} must be an integer between 1 and 2147483647 milliseconds`);
  }
  return parsed;
}

export function recoveryBackoffMilliseconds(failureCount) {
  if (!Number.isSafeInteger(failureCount) || failureCount < 0) {
    throw new RangeError("Action recovery failure count must be a non-negative safe integer");
  }
  const exponent = Math.min(Math.max(0, failureCount - 1), 20);
  return Math.min(ACTION_RECOVERY_MAX_POLL_MS, ACTION_RECOVERY_POLL_MS * (2 ** exponent));
}

function compactError(error) {
  return error?.shortMessage || error?.info?.error?.message || error?.message || String(error);
}

function certainError(message) {
  const error = new Error(message);
  error.outcomeCertain = true;
  return error;
}

function certainHttpError(statusCode, message, payload = {}) {
  const error = httpError(statusCode, message, payload);
  error.outcomeCertain = true;
  return error;
}

function journalOperationHttpError(statusCode, message, operation) {
  const error = certainHttpError(statusCode, message, { operation });
  error.preserveJournalOperation = true;
  return error;
}

function httpError(statusCode, message, payload = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.payload = { ok: false, error: message, ...payload };
  return error;
}

export const INSTITUTIONAL_ACTIONS = ACTIONS;
