import { ethers } from "ethers";
import {
  CHECKPOINT_TYPES,
  checkpointDigest,
  checkpointDomain,
  normalizeCheckpoint,
  serializableCheckpoint,
} from "./checkpoint-typed-data.mjs";

export class AttestorRequestError extends Error {
  constructor(message, statusCode = 400, options = {}) {
    super(message, options);
    this.name = "AttestorRequestError";
    this.statusCode = statusCode;
  }
}

export class CheckpointAttestor {
  #wallet;
  #sources;
  #journal;
  #allowedDomains;

  constructor({ wallet, sources, journal, allowedDomains }) {
    this.#wallet = wallet;
    this.#sources = new Map(Object.entries(sources).map(([chainId, source]) => [BigInt(chainId).toString(), source]));
    this.#journal = journal;
    this.#allowedDomains = new Set(
      normalizeAllowedCheckpointDomains(allowedDomains).map((domain) => destinationDomainKey({
        chainId: BigInt(domain.destinationChainId),
        verifyingContract: domain.checkpointClient,
      })),
    );
  }

  get signerAddress() {
    return this.#wallet.address;
  }

  async attest(request) {
    const domain = requestedDestinationDomain(request?.domain);
    if (!this.#allowedDomains.has(destinationDomainKey(domain))) {
      throw new AttestorRequestError(
        `Checkpoint destination domain ${domain.chainId}:${domain.verifyingContract} is not allowed`,
        403,
      );
    }
    const checkpoint = normalizeCheckpoint(request?.checkpoint);
    const source = this.#sources.get(checkpoint.sourceChainId.toString());
    if (!source) throw new AttestorRequestError(`Source chain ${checkpoint.sourceChainId} is not configured`, 403);
    await verifySourceCheckpoint(source, checkpoint);

    const signature = await this.#wallet.signTypedData(domain, CHECKPOINT_TYPES, checkpoint);
    const digest = checkpointDigest(checkpoint, domain);
    const signer = ethers.verifyTypedData(domain, CHECKPOINT_TYPES, checkpoint, signature);
    if (ethers.getAddress(signer) !== ethers.getAddress(this.#wallet.address)) {
      throw new Error("Attestor signature self-verification failed");
    }

    const attestation = { signer, signature, digest };
    await this.#journal.record(checkpoint, domain, attestation);
    return {
      checkpoint: serializableCheckpoint(checkpoint),
      domain: {
        destinationChainId: domain.chainId.toString(),
        checkpointClient: domain.verifyingContract,
      },
      ...attestation,
    };
  }
}

export function normalizeAllowedCheckpointDomains(allowedDomains) {
  if (!Array.isArray(allowedDomains) || allowedDomains.length === 0) {
    throw new Error("Attestor configuration requires at least one allowed destination domain");
  }
  const normalized = [];
  const keys = new Set();
  for (const [index, input] of allowedDomains.entries()) {
    const domain = normalizeDestinationDomain(input, `Attestor allowed destination domain ${index}`);
    const key = destinationDomainKey(domain);
    if (keys.has(key)) {
      throw new Error(`Attestor allowed destination domain is duplicated: ${domain.chainId}:${domain.verifyingContract}`);
    }
    keys.add(key);
    normalized.push(Object.freeze({
      destinationChainId: domain.chainId.toString(),
      checkpointClient: domain.verifyingContract,
    }));
  }
  return Object.freeze(normalized);
}

function requestedDestinationDomain(input) {
  try {
    return normalizeDestinationDomain(input, "Checkpoint destination domain");
  } catch (cause) {
    throw new AttestorRequestError(cause.message, 400, { cause });
  }
}

function normalizeDestinationDomain(input, label) {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("must be an object");
    const domain = checkpointDomain(input);
    if (domain.chainId <= 0n) throw new Error("destinationChainId must be positive");
    if (domain.verifyingContract === ethers.ZeroAddress) throw new Error("checkpointClient must not be the zero address");
    return domain;
  } catch (cause) {
    throw new Error(`${label} is invalid: ${cause.message}`, { cause });
  }
}

function destinationDomainKey(domain) {
  return `${domain.chainId}:${ethers.getAddress(domain.verifyingContract).toLowerCase()}`;
}

async function verifySourceCheckpoint(source, checkpoint) {
  const network = await source.provider.getNetwork();
  if (network.chainId !== checkpoint.sourceChainId) {
    throw new AttestorRequestError(
      `Configured RPC chain ${network.chainId} does not match checkpoint source ${checkpoint.sourceChainId}`,
      503,
    );
  }
  const latestHeight = BigInt(await source.provider.getBlockNumber());
  const finalityDepth = BigInt(source.finalityDepth ?? 0);
  if (latestHeight < checkpoint.blockNumber + finalityDepth) {
    throw new AttestorRequestError(
      `Checkpoint block ${checkpoint.blockNumber} has not reached checkpoint confirmation depth ${finalityDepth}`,
      425,
    );
  }

  const block = await source.provider.send("eth_getBlockByNumber", [ethers.toQuantity(checkpoint.blockNumber), false]);
  if (!block) throw new AttestorRequestError(`Source block ${checkpoint.blockNumber} was not found`, 404);
  requireEqualHex(block.hash, checkpoint.blockHash, "blockHash");
  requireEqualHex(block.stateRoot, checkpoint.stateRoot, "stateRoot");
  if (BigInt(block.timestamp) !== checkpoint.timestamp) {
    throw new AttestorRequestError("Checkpoint timestamp does not match source RPC", 409);
  }
}

function requireEqualHex(actual, expected, field) {
  if (ethers.hexlify(actual).toLowerCase() !== ethers.hexlify(expected).toLowerCase()) {
    throw new AttestorRequestError(`Checkpoint ${field} does not match source RPC`, 409);
  }
}
