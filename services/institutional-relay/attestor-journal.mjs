import { ethers } from "ethers";
import { AtomicJsonStore } from "../shared/atomic-json-store.mjs";
import {
  canonicalSourceCheckpointHash,
  serializableCheckpoint,
} from "./checkpoint-typed-data.mjs";

const VERSION = "institutional-attestor-journal-v1";

function validate(state) {
  if (state?.version !== VERSION || !state.checkpoints || typeof state.checkpoints !== "object") {
    throw new Error("Unsupported attestor journal");
  }
}

export class AttestorJournal {
  #store;

  constructor(store) {
    this.#store = store;
  }

  static async open(path) {
    const store = await AtomicJsonStore.open(path, {
      create: () => ({ version: VERSION, checkpoints: {} }),
      validate,
    });
    return new AttestorJournal(store);
  }

  snapshot() {
    return this.#store.snapshot();
  }

  close() {
    return this.#store.close();
  }

  async record(checkpoint, domain, attestation) {
    const canonicalHash = canonicalSourceCheckpointHash(checkpoint);
    const key = `${checkpoint.sourceChainId}:${checkpoint.blockNumber}`;
    const domainKey = `${domain.chainId}:${ethers.getAddress(domain.verifyingContract)}`;
    return this.#store.mutate((state) => {
      const existing = state.checkpoints[key];
      if (existing && existing.canonicalHash !== canonicalHash) {
        throw new Error(`Attestor equivocation guard rejected conflicting checkpoint ${key}`);
      }
      const record = existing || {
        checkpoint: serializableCheckpoint(checkpoint),
        canonicalHash,
        domains: {},
      };
      const existingDomain = record.domains[domainKey];
      if (existingDomain && existingDomain.digest !== attestation.digest) {
        throw new Error(`Attestor domain replay guard rejected conflicting digest ${key}`);
      }
      record.domains[domainKey] = {
        digest: attestation.digest,
        signature: attestation.signature,
        signer: attestation.signer,
        signedAt: new Date().toISOString(),
      };
      state.checkpoints[key] = record;
      return structuredClone(record.domains[domainKey]);
    });
  }
}
