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

  constructor({ wallet, sources, journal }) {
    this.#wallet = wallet;
    this.#sources = new Map(Object.entries(sources).map(([chainId, source]) => [BigInt(chainId).toString(), source]));
    this.#journal = journal;
  }

  get signerAddress() {
    return this.#wallet.address;
  }

  async attest(request) {
    const checkpoint = normalizeCheckpoint(request.checkpoint);
    const source = this.#sources.get(checkpoint.sourceChainId.toString());
    if (!source) throw new AttestorRequestError(`Source chain ${checkpoint.sourceChainId} is not configured`, 403);
    const domain = checkpointDomain(request.domain);
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
      `Checkpoint block ${checkpoint.blockNumber} has not reached finality depth ${finalityDepth}`,
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
