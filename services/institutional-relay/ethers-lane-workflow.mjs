import { ethers } from "ethers";
import { waitForSuccessfulTransaction } from "../shared/transaction-receipt.mjs";
import { loadArtifact } from "../../scripts/ops/besu/runtime.mjs";
import { collectCheckpointQuorum } from "./attestor-collector.mjs";
import { PermanentRelayError, RelayDeferredError } from "./retry.mjs";

const ACTIVE_CLIENT_STATUS = 1n;
const PROTOCOL_VERSION = 1n;

export async function createEthersLaneWorkflow(config, { sourceSigner, destinationSigner }) {
  const [gatewayArtifact, checkpointClientArtifact] = await Promise.all([
    loadArtifact("gateway/InstitutionalCrossChainGateway.sol", "InstitutionalCrossChainGateway"),
    loadArtifact("gateway/InstitutionalCheckpointClient.sol", "InstitutionalCheckpointClient"),
  ]);
  const source = await createEndpoint(config.source, sourceSigner, gatewayArtifact, checkpointClientArtifact);
  const destination = await createEndpoint(
    config.destination,
    destinationSigner,
    gatewayArtifact,
    checkpointClientArtifact,
  );
  return new EthersInstitutionalLaneWorkflow({ config, source, destination });
}

export class EthersInstitutionalLaneWorkflow {
  #config;
  #source;
  #destination;

  constructor({ config, source, destination }) {
    if (config?.proofObserver != null && typeof config.proofObserver !== "function") {
      throw new Error("Lane proofObserver must be a function when configured");
    }
    this.#config = config;
    this.#source = source;
    this.#destination = destination;
  }

  async scan(fromBlock) {
    const latest = await this.#source.provider.getBlockNumber();
    if (fromBlock > latest) return { events: [], scannedTo: fromBlock - 1 };
    const scannedTo = Math.min(latest, fromBlock + Number(this.#config.scanRange ?? 500) - 1);
    const logs = await this.#source.gateway.queryFilter(
      this.#source.gateway.filters.MessageCommitted(),
      fromBlock,
      scannedTo,
    );
    const events = logs
      .filter((event) => BigInt(event.args.destinationChainId) === this.#destination.chainId)
      .filter((event) => sameAddress(event.args.destinationGateway, this.#destination.gatewayAddress))
      .map((event) => ({
        messageId: event.args.messageId,
        sourceTxHash: event.transactionHash,
        sourceBlockNumber: event.blockNumber,
        message: serializeMessage({
          version: PROTOCOL_VERSION,
          nonce: event.args.nonce,
          sourceChainId: this.#source.chainId,
          sourceGateway: this.#source.gatewayAddress,
          sourceApplication: event.args.sourceApplication,
          destinationChainId: event.args.destinationChainId,
          destinationGateway: event.args.destinationGateway,
          destinationApplication: event.args.destinationApplication,
          timeoutTimestamp: event.args.timeoutTimestamp,
          payload: event.args.payload,
        }),
      }));
    return { events, scannedTo };
  }

  async step(job) {
    if (await this.#source.gateway.messageCompleted(job.messageId)) return { state: "completed" };
    if (await this.#source.gateway.messageTimedOut(job.messageId)) return { state: "timed_out" };

    const received = await this.#destination.gateway.messageReceived(job.messageId);
    if (received && !["received", "destination_checkpointed"].includes(job.state)) {
      return { state: "received", patch: await this.#recoverAcknowledgement(job.messageId) };
    }
    if (!received && ["received", "destination_checkpointed"].includes(job.state)) {
      throw new PermanentRelayError("Destination receipt disappeared after being observed");
    }

    if (["observed", "source_checkpointed"].includes(job.state)) {
      const timeoutAnchor = await this.#timeoutAnchorIfReady(job);
      if (timeoutAnchor) return { state: "timeout_checkpointed", patch: { timeoutCheckpoint: timeoutAnchor } };
    }

    if (job.state === "observed") {
      const anchor = await this.#ensureCheckpoint({
        remote: this.#source,
        local: this.#destination,
        minimumHeight: BigInt(job.sourceBlockNumber),
      });
      return { state: "source_checkpointed", patch: { sourceCheckpoint: anchor } };
    }
    if (job.state === "source_checkpointed") return this.#receive(job);
    if (job.state === "received") {
      const anchor = await this.#ensureCheckpoint({
        remote: this.#destination,
        local: this.#source,
        minimumHeight: BigInt(job.destinationReceiveBlock),
      });
      return { state: "destination_checkpointed", patch: { destinationCheckpoint: anchor } };
    }
    if (job.state === "destination_checkpointed") return this.#acknowledge(job);
    if (job.state === "timeout_checkpointed") return this.#timeout(job);
    throw new PermanentRelayError(`Unsupported relay job state ${job.state}`);
  }

  async #receive(job) {
    const anchor = job.sourceCheckpoint;
    const commitment = await this.#source.gateway.messageCommitment(job.messageId);
    if (commitment === ethers.ZeroHash) throw new PermanentRelayError("Source message commitment is missing");
    const storageKey = await this.#source.gateway.commitmentStorageSlot(job.messageId);
    const proof = await buildStorageProof({
      endpoint: this.#source,
      anchor,
      storageKey,
      expectedWord: commitment,
    });
    const transaction = await this.#destination.gateway.receiveMessage(toContractMessage(job.message), proof, txOptions(this.#config));
    const receipt = await waitForTransaction(transaction, this.#config.transactionTimeoutMs);
    const event = parseGatewayEvent(this.#destination.gateway, receipt, "MessageReceived", job.messageId);
    if (!event) throw new Error("Destination receipt did not contain MessageReceived");
    await this.#observeAcceptedProof(
      "message-commitment-membership",
      proof,
      receipt,
      this.#destination.chainId,
    );
    return {
      state: "received",
      patch: {
        destinationReceiveBlock: receipt.blockNumber,
        acknowledgement: event.args.acknowledgement,
        transactions: { ...job.transactions, receive: receipt.hash },
      },
    };
  }

  async #acknowledge(job) {
    const acknowledgement = job.acknowledgement || (await this.#recoverAcknowledgement(job.messageId)).acknowledgement;
    const acknowledgementHash = await this.#destination.gateway.acknowledgementHash(job.messageId);
    if (ethers.keccak256(acknowledgement) !== acknowledgementHash) {
      throw new PermanentRelayError("Recovered acknowledgement does not match destination storage");
    }
    const storageKey = await this.#destination.gateway.acknowledgementStorageSlot(job.messageId);
    const proof = await buildStorageProof({
      endpoint: this.#destination,
      anchor: job.destinationCheckpoint,
      storageKey,
      expectedWord: acknowledgementHash,
    });
    const transaction = await this.#source.gateway.acknowledgeMessage(
      toContractMessage(job.message),
      acknowledgement,
      proof,
      txOptions(this.#config),
    );
    const receipt = await waitForTransaction(transaction, this.#config.transactionTimeoutMs);
    await this.#observeAcceptedProof(
      "acknowledgement-membership",
      proof,
      receipt,
      this.#source.chainId,
    );
    return { state: "completed", patch: { transactions: { ...job.transactions, acknowledge: receipt.hash } } };
  }

  async #timeout(job) {
    const anchor = job.timeoutCheckpoint;
    const storageKey = await this.#destination.gateway.receiptStorageSlot(job.messageId);
    const proof = await buildStorageProof({
      endpoint: this.#destination,
      anchor,
      storageKey,
      absent: true,
    });
    const transaction = await this.#source.gateway.timeoutMessage(
      toContractMessage(job.message),
      proof,
      txOptions(this.#config),
    );
    const receipt = await waitForTransaction(transaction, this.#config.transactionTimeoutMs);
    await this.#observeAcceptedProof("receipt-absence", proof, receipt, this.#source.chainId);
    return { state: "timed_out", patch: { transactions: { ...job.transactions, timeout: receipt.hash } } };
  }

  async #observeAcceptedProof(kind, proof, receipt, acceptedOnChainId) {
    if (!this.#config.proofObserver) return;
    await this.#config.proofObserver({
      kind,
      proof,
      sourceChainId: proof.sourceChainId,
      destinationChainId: acceptedOnChainId,
      acceptedTransactionHash: receipt.hash,
      acceptedBlockNumber: receipt.blockNumber,
    });
  }

  async #timeoutAnchorIfReady(job) {
    const timeoutTimestamp = BigInt(job.message.timeoutTimestamp);
    const finalizedHeight = await finalizedBlockHeight(this.#destination);
    if (finalizedHeight < 1n) return null;
    const block = await rawBlock(this.#destination.provider, finalizedHeight);
    if (BigInt(block.timestamp) < timeoutTimestamp) return null;
    return this.#ensureCheckpoint({
      remote: this.#destination,
      local: this.#source,
      minimumHeight: finalizedHeight,
      minimumTimestamp: timeoutTimestamp,
    });
  }

  async #ensureCheckpoint({ remote, local, minimumHeight, minimumTimestamp = 0n }) {
    if (BigInt(await local.checkpointClient.status(remote.chainId)) !== ACTIVE_CLIENT_STATUS) {
      throw new PermanentRelayError(`Checkpoint client for chain ${remote.chainId} is not active`);
    }
    const trustedHeight = BigInt(await local.checkpointClient.latestTrustedHeight(remote.chainId));
    if (trustedHeight >= minimumHeight) {
      const trustedTimestamp = BigInt(await local.checkpointClient.trustedTimestamp(remote.chainId, trustedHeight));
      if (trustedTimestamp >= minimumTimestamp) {
        return validateTrustedAnchor(remote, local, trustedHeight);
      }
    }

    const candidateHeight = await finalizedBlockHeight(remote);
    if (candidateHeight < minimumHeight) {
      throw new RelayDeferredError(`Chain ${remote.chainId} has not finalized block ${minimumHeight}`, this.#config.pollIntervalMs);
    }
    const block = await rawBlock(remote.provider, candidateHeight);
    if (BigInt(block.timestamp) < minimumTimestamp) {
      throw new RelayDeferredError(`Chain ${remote.chainId} has not reached timeout timestamp`, this.#config.pollIntervalMs);
    }
    const existingRoot = await local.checkpointClient.trustedStateRoot(remote.chainId, candidateHeight);
    if (existingRoot !== ethers.ZeroHash) {
      if (existingRoot.toLowerCase() !== block.stateRoot.toLowerCase()) {
        throw new PermanentRelayError(`Trusted checkpoint root conflict at ${remote.chainId}:${candidateHeight}`);
      }
      return serializeAnchor(block);
    }

    const epoch = BigInt(await local.checkpointClient.currentAttestorEpoch(remote.chainId));
    if (epoch === 0n) throw new PermanentRelayError(`Attestors are not configured for chain ${remote.chainId}`);
    const set = await local.checkpointClient.attestorSet(remote.chainId, epoch);
    const threshold = Number(set.threshold ?? set[0]);
    const allowedAttestors = set.attestors ?? set[2];
    const checkpoint = {
      sourceChainId: remote.chainId,
      blockNumber: candidateHeight,
      blockHash: block.hash,
      stateRoot: block.stateRoot,
      timestamp: BigInt(block.timestamp),
      attestorEpoch: epoch,
    };
    const quorum = await collectCheckpointQuorum({
      checkpoint,
      domain: { destinationChainId: local.chainId, checkpointClient: local.checkpointClientAddress },
      endpoints: this.#config.attestors,
      threshold,
      allowedAttestors,
      timeoutMs: this.#config.attestorTimeoutMs,
    });
    const transaction = await local.checkpointClient.submitCheckpoint(checkpoint, quorum.signatures, txOptions(this.#config));
    await waitForTransaction(transaction, this.#config.transactionTimeoutMs);
    return validateTrustedAnchor(remote, local, candidateHeight);
  }

  async #recoverAcknowledgement(messageId) {
    const fromBlock = Number(this.#destination.deploymentBlock ?? 0);
    const latest = await this.#destination.provider.getBlockNumber();
    const range = Number(this.#config.scanRange ?? 500);
    for (let start = fromBlock; start <= latest; start += range) {
      const end = Math.min(latest, start + range - 1);
      const logs = await this.#destination.gateway.queryFilter(
        this.#destination.gateway.filters.MessageReceived(messageId),
        start,
        end,
      );
      if (logs.length > 0) {
        const event = logs[0];
        return { destinationReceiveBlock: event.blockNumber, acknowledgement: event.args.acknowledgement };
      }
    }
    throw new PermanentRelayError(`MessageReceived event for ${messageId} cannot be recovered`);
  }
}

async function createEndpoint(config, signer, gatewayArtifact, checkpointClientArtifact) {
  const provider = signer.provider;
  const network = await provider.getNetwork();
  const chainId = BigInt(config.chainId);
  if (network.chainId !== chainId) throw new Error(`RPC chain ${network.chainId} does not match configured chain ${chainId}`);
  const gatewayAddress = ethers.getAddress(config.gateway);
  const checkpointClientAddress = ethers.getAddress(config.checkpointClient);
  return {
    chainId,
    provider,
    signer,
    gatewayAddress,
    checkpointClientAddress,
    gateway: new ethers.Contract(gatewayAddress, gatewayArtifact.abi, signer),
    checkpointClient: new ethers.Contract(checkpointClientAddress, checkpointClientArtifact.abi, signer),
    finalityDepth: BigInt(config.finalityDepth ?? 2),
    deploymentBlock: Number(config.deploymentBlock ?? 0),
  };
}

async function validateTrustedAnchor(remote, local, height) {
  const trustedRoot = await local.checkpointClient.trustedStateRoot(remote.chainId, height);
  const block = await rawBlock(remote.provider, height);
  if (trustedRoot.toLowerCase() !== block.stateRoot.toLowerCase()) {
    throw new PermanentRelayError(`Trusted checkpoint does not match RPC state root at ${remote.chainId}:${height}`);
  }
  return serializeAnchor(block);
}

async function finalizedBlockHeight(endpoint) {
  const latest = BigInt(await endpoint.provider.getBlockNumber());
  return latest > endpoint.finalityDepth ? latest - endpoint.finalityDepth : 0n;
}

async function rawBlock(provider, height) {
  const block = await provider.send("eth_getBlockByNumber", [ethers.toQuantity(height), false]);
  if (!block?.hash || !block?.stateRoot || block.timestamp == null) {
    throw new RelayDeferredError(`Block ${height} is not available from RPC`);
  }
  return {
    blockNumber: BigInt(block.number).toString(),
    hash: block.hash,
    stateRoot: block.stateRoot,
    timestamp: BigInt(block.timestamp).toString(),
  };
}

function serializeAnchor(block) {
  return {
    blockNumber: BigInt(block.blockNumber).toString(),
    blockHash: block.hash,
    stateRoot: block.stateRoot,
    timestamp: BigInt(block.timestamp).toString(),
  };
}

async function buildStorageProof({ endpoint, anchor, storageKey, expectedWord, absent = false }) {
  const result = await endpoint.provider.send("eth_getProof", [
    endpoint.gatewayAddress,
    [storageKey],
    ethers.toQuantity(anchor.blockNumber),
  ]);
  const storage = result?.storageProof?.[0];
  if (!result?.accountProof?.length || !storage?.proof?.length) throw new Error("RPC returned an incomplete EIP-1186 proof");
  return {
    sourceChainId: endpoint.chainId,
    checkpointHeight: BigInt(anchor.blockNumber),
    stateRoot: anchor.stateRoot,
    account: endpoint.gatewayAddress,
    storageKey,
    expectedValue: absent ? "0x" : rlpEncodeStorageWord(expectedWord),
    accountProof: result.accountProof,
    storageProof: storage.proof,
  };
}

export function rlpEncodeStorageWord(word) {
  const value = BigInt(word);
  if (value === 0n) return "0x80";
  let raw = value.toString(16);
  if (raw.length % 2) raw = `0${raw}`;
  const byteLength = raw.length / 2;
  if (byteLength === 1 && Number.parseInt(raw, 16) < 0x80) return `0x${raw}`;
  if (byteLength > 55) throw new Error("Storage word is unexpectedly long");
  return `0x${(0x80 + byteLength).toString(16)}${raw}`;
}

function serializeMessage(message) {
  return {
    ...message,
    version: BigInt(message.version).toString(),
    nonce: BigInt(message.nonce).toString(),
    sourceChainId: BigInt(message.sourceChainId).toString(),
    destinationChainId: BigInt(message.destinationChainId).toString(),
    timeoutTimestamp: BigInt(message.timeoutTimestamp).toString(),
  };
}

function toContractMessage(message) {
  return {
    ...message,
    version: BigInt(message.version),
    nonce: BigInt(message.nonce),
    sourceChainId: BigInt(message.sourceChainId),
    destinationChainId: BigInt(message.destinationChainId),
    timeoutTimestamp: BigInt(message.timeoutTimestamp),
  };
}

function sameAddress(left, right) {
  return ethers.getAddress(left) === ethers.getAddress(right);
}

function txOptions(config) {
  return config.gasLimit ? { gasLimit: BigInt(config.gasLimit) } : {};
}

async function waitForTransaction(transaction, timeoutMs = 120_000) {
  return waitForSuccessfulTransaction(transaction, {
    timeoutMs,
    timeoutMessage: ({ hash }) => `Transaction ${hash} confirmation timed out`,
    failureMessage: ({ hash }) => `Transaction ${hash} failed`,
  });
}

function parseGatewayEvent(contract, receipt, eventName, messageId) {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed?.name === eventName && parsed.args.messageId.toLowerCase() === messageId.toLowerCase()) return parsed;
    } catch {
      // Ignore logs emitted by application callbacks.
    }
  }
  return null;
}
