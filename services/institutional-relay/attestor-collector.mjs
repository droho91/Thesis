import { ethers } from "ethers";
import {
  CHECKPOINT_TYPES,
  checkpointDigest,
  checkpointDomain,
  serializableCheckpoint,
} from "./checkpoint-typed-data.mjs";

export class AttestorQuorumError extends Error {
  constructor(message, failures = []) {
    super(message);
    this.name = "AttestorQuorumError";
    this.failures = failures;
  }
}

export async function collectCheckpointQuorum({
  checkpoint,
  domain: domainInput,
  endpoints,
  threshold,
  allowedAttestors,
  timeoutMs = 10_000,
  fetchImpl = fetch,
}) {
  const domain = checkpointDomain(domainInput);
  const digest = checkpointDigest(checkpoint, domain);
  const allowed = new Set(allowedAttestors.map((address) => ethers.getAddress(address)));
  const requests = endpoints.map((endpoint) => requestAttestation({
    endpoint: typeof endpoint === "string" ? { url: endpoint } : endpoint,
    checkpoint,
    domain,
    timeoutMs,
    fetchImpl,
  }));
  const settled = await Promise.allSettled(requests);
  const valid = new Map();
  const failures = [];

  for (let index = 0; index < settled.length; index++) {
    const result = settled[index];
    const label = typeof endpoints[index] === "string" ? endpoints[index] : endpoints[index].url;
    if (result.status === "rejected") {
      failures.push({ endpoint: label, error: result.reason?.message || String(result.reason) });
      continue;
    }
    try {
      const response = result.value;
      if (response.digest.toLowerCase() !== digest.toLowerCase()) throw new Error("digest mismatch");
      const recovered = ethers.getAddress(ethers.verifyTypedData(
        domain,
        CHECKPOINT_TYPES,
        checkpoint,
        response.signature,
      ));
      if (recovered !== ethers.getAddress(response.signer)) throw new Error("reported signer mismatch");
      if (!allowed.has(recovered)) throw new Error("signer is not in the on-chain attestor set");
      if (valid.has(recovered)) throw new Error("duplicate attestor signer");
      valid.set(recovered, response.signature);
    } catch (error) {
      failures.push({ endpoint: label, error: error.message });
    }
  }

  if (valid.size < Number(threshold)) {
    throw new AttestorQuorumError(
      `Collected ${valid.size} valid checkpoint signatures; threshold is ${threshold}`,
      failures,
    );
  }
  const signatures = [...valid.entries()]
    .sort(([left], [right]) => left.toLowerCase().localeCompare(right.toLowerCase()))
    .map(([, signature]) => signature);
  return { digest, signatures, signers: [...valid.keys()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())), failures };
}

async function requestAttestation({ endpoint, checkpoint, domain, timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${endpoint.url.replace(/\/$/, "")}/v1/attest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {}),
      },
      body: JSON.stringify({
        checkpoint: serializableCheckpoint(checkpoint),
        domain: {
          destinationChainId: domain.chainId.toString(),
          checkpointClient: domain.verifyingContract,
        },
      }),
      signal: controller.signal,
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error || `Attestor returned HTTP ${response.status}`);
    return body;
  } finally {
    clearTimeout(timeout);
  }
}
