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
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    throw new TypeError("Attestor endpoints must be a non-empty array");
  }
  if (!Array.isArray(allowedAttestors) || allowedAttestors.length === 0) {
    throw new TypeError("Allowed attestors must be a non-empty array");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("Attestor fetch implementation must be a function");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new RangeError("Attestor timeoutMs must be an integer between 1 and 2147483647");
  }
  const domain = checkpointDomain(domainInput);
  const digest = checkpointDigest(checkpoint, domain);
  const normalizedEndpoints = endpoints.map(normalizeEndpoint);
  const normalizedAllowed = allowedAttestors.map((address) => ethers.getAddress(address));
  const allowed = new Set(normalizedAllowed);
  if (allowed.size !== normalizedAllowed.length) {
    throw new TypeError("Allowed attestors must be unique");
  }
  if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > endpoints.length || threshold > allowed.size) {
    throw new RangeError("Attestor threshold exceeds the available endpoints or allowed signers");
  }

  const valid = new Map();
  const failures = [];
  const pending = new Map(normalizedEndpoints.map((endpoint, index) => {
    const controller = new AbortController();
    const task = requestAttestation({
      endpoint,
      checkpoint,
      domain,
      timeoutMs,
      fetchImpl,
      controller,
    }).then(
      (value) => ({ index, status: "fulfilled", value }),
      (reason) => ({ index, status: "rejected", reason }),
    );
    return [index, { controller, task }];
  }));

  while (pending.size > 0) {
    const result = await Promise.race([...pending.values()].map(({ task }) => task));
    const index = result.index;
    pending.delete(index);
    const label = normalizedEndpoints[index].url;
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

    if (valid.size >= threshold) {
      // A threshold signature set is sufficient on-chain. Abort stragglers so
      // one unavailable fourth endpoint cannot add its full timeout to every
      // checkpoint or inflate calldata with signatures the contract does not need.
      for (const { controller } of pending.values()) controller.abort();
      return quorumResult(digest, valid, failures);
    }
  }

  throw new AttestorQuorumError(
    `Collected ${valid.size} valid checkpoint signatures; threshold is ${threshold}`,
    failures,
  );
}

function normalizeEndpoint(endpoint, index) {
  const candidate = typeof endpoint === "string" ? { url: endpoint } : endpoint;
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError(`Attestor endpoint ${index} must be a URL or endpoint object`);
  }
  if (typeof candidate.url !== "string" || candidate.url.trim().length === 0) {
    throw new TypeError(`Attestor endpoint ${index} URL must be a non-empty string`);
  }
  let url;
  try {
    url = new URL(candidate.url);
  } catch (error) {
    throw new TypeError(`Attestor endpoint ${index} URL is invalid`, { cause: error });
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new TypeError(`Attestor endpoint ${index} must use HTTP(S) without URL credentials`);
  }
  if (candidate.token !== undefined && typeof candidate.token !== "string") {
    throw new TypeError(`Attestor endpoint ${index} token must be a string`);
  }
  return { ...candidate, url: url.toString() };
}

function quorumResult(digest, valid, failures) {
  const signatures = [...valid.entries()]
    .sort(([left], [right]) => left.toLowerCase().localeCompare(right.toLowerCase()))
    .map(([, signature]) => signature);
  return { digest, signatures, signers: [...valid.keys()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())), failures };
}

async function requestAttestation({ endpoint, checkpoint, domain, timeoutMs, fetchImpl, controller }) {
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
