import { createHash } from "node:crypto";

import { ethers } from "ethers";

export const LIVE_CLIENT_PROOF_SCHEMA = "institutional-live-client-proof-validation-v1";

const SUPPORTED_KINDS = new Set([
  "message-commitment-membership",
  "acknowledgement-membership",
  "receipt-absence",
]);
const REQUIRED_MEMBERSHIP_KINDS = Object.freeze([
  "message-commitment-membership",
  "acknowledgement-membership",
]);
const MAX_PROOF_NODES = 128;
const MAX_PROOF_NODE_HEX_LENGTH = 131_074;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const DECIMAL_PATTERN = /^(0|[1-9]\d*)$/;

export function createLiveClientProofCollector() {
  const observations = new Map();

  return Object.freeze({
    observeAcceptedProof(event) {
      const observation = buildAcceptedProofObservation(event);
      const key = `${observation.kind}:${observation.sourceChainId}`;
      if (!observations.has(key)) observations.set(key, observation);
    },
    build(chainSnapshots) {
      return buildLiveClientProofValidation({
        chainSnapshots,
        proofObservations: [...observations.values()],
      });
    },
    snapshot() {
      return [...observations.values()].map((observation) => structuredClone(observation));
    },
  });
}

export function buildAcceptedProofObservation({
  kind,
  proof,
  sourceChainId,
  destinationChainId,
  acceptedTransactionHash,
  acceptedBlockNumber,
}) {
  if (!SUPPORTED_KINDS.has(kind)) throw new Error(`Unsupported live proof observation kind '${kind}'`);
  if (!isPlainObject(proof)) throw new Error("Accepted live proof observation has no proof payload");

  const observation = {
    kind,
    rpcMethod: "eth_getProof",
    sourceChainId: decimalString(sourceChainId, "source chain id"),
    destinationChainId: decimalString(destinationChainId, "destination chain id"),
    checkpointHeight: decimalString(proof.checkpointHeight, "checkpoint height"),
    stateRoot: hexValue(proof.stateRoot, "state root", 32),
    account: addressValue(proof.account, "proof account"),
    storageKey: hexValue(proof.storageKey, "storage key", 32),
    expectedValue: hexValue(proof.expectedValue, "expected value"),
    accountProof: proofNodes(proof.accountProof, "account proof"),
    storageProof: proofNodes(proof.storageProof, "storage proof"),
    acceptedTransactionHash: hexValue(acceptedTransactionHash, "accepted transaction hash", 32),
    acceptedBlockNumber: nonNegativeInteger(acceptedBlockNumber, "accepted block number"),
  };
  if (observation.sourceChainId === observation.destinationChainId) {
    throw new Error("Accepted live proof observation must cross distinct chains");
  }
  if (kind.endsWith("membership") && observation.expectedValue === "0x") {
    throw new Error("Membership proof observation must bind a non-empty expected value");
  }
  if (kind === "receipt-absence" && observation.expectedValue !== "0x") {
    throw new Error("Receipt-absence proof observation must use an empty expected value");
  }
  return Object.freeze({
    ...observation,
    proofSha256: proofObservationDigest(observation),
  });
}

export function buildLiveClientProofValidation({ chainSnapshots, proofObservations }) {
  if (!Array.isArray(chainSnapshots)) throw new Error("Live client proof validation needs chain snapshots");
  const clients = chainSnapshots.map((snapshot) => ({
    chainId: decimalString(snapshot?.chainId, "client chain id"),
    clientFamily: clientFamily(snapshot?.clientVersion),
    clientVersion: nonEmptyString(snapshot?.clientVersion, "client version"),
  }));
  const evidence = {
    schema: LIVE_CLIENT_PROOF_SCHEMA,
    status: "passed",
    classification: "observed-live-client-production-proof",
    rpcMethod: "eth_getProof",
    acceptanceBoundary: "InstitutionalCrossChainGateway",
    validatedLiveClients: [...new Set(clients.map((client) => client.clientFamily))].sort(),
    clients: clients.sort((left, right) => Number(left.chainId) - Number(right.chainId)),
    proofObservations: Array.isArray(proofObservations)
      ? proofObservations.map((observation) => structuredClone(observation))
      : proofObservations,
  };
  validateLiveClientProofEvidence(evidence);
  return evidence;
}

export function validateLiveClientProofEvidence(
  evidence,
  { expectedChainIds = ["41001", "41002"], expectedBesuVersion = "24.10.0" } = {},
) {
  if (!isPlainObject(evidence)) throw new Error("Live client proof evidence is missing or malformed");
  if (evidence.schema !== LIVE_CLIENT_PROOF_SCHEMA) throw new Error("Unsupported live client proof evidence schema");
  if (evidence.status !== "passed") throw new Error("Live client proof evidence did not pass");
  if (evidence.classification !== "observed-live-client-production-proof") {
    throw new Error("Live client proof evidence classification is invalid");
  }
  if (evidence.rpcMethod !== "eth_getProof") throw new Error("Live proof RPC method is not eth_getProof");
  if (evidence.acceptanceBoundary !== "InstitutionalCrossChainGateway") {
    throw new Error("Live proof acceptance boundary is not the production gateway");
  }
  if (!sameStrings(evidence.validatedLiveClients, ["Besu"])) {
    throw new Error("Live proof evidence must identify exactly the observed Besu client family");
  }

  const expectedChains = [...expectedChainIds].sort();
  if (!Array.isArray(evidence.clients) || evidence.clients.length !== expectedChains.length) {
    throw new Error("Live proof evidence must identify one client for each bank chain");
  }
  const actualChains = evidence.clients.map((client) => decimalString(client?.chainId, "client chain id")).sort();
  if (!sameStrings(actualChains, expectedChains)) throw new Error("Live proof client chain set is incomplete");
  for (const client of evidence.clients) {
    if (client.clientFamily !== "Besu") throw new Error("Live proof client family is not Besu");
    const version = nonEmptyString(client.clientVersion, "client version");
    if (!matchesPinnedBesuVersion(version, expectedBesuVersion)) {
      throw new Error(`Live Besu client version does not match pinned ${expectedBesuVersion}`);
    }
  }

  if (!Array.isArray(evidence.proofObservations) || evidence.proofObservations.length < 4) {
    throw new Error("Live proof evidence has fewer than four accepted membership observations");
  }
  if (evidence.proofObservations.length > expectedChains.length * SUPPORTED_KINDS.size) {
    throw new Error("Live proof evidence contains an unbounded observation set");
  }
  const keys = new Set();
  const transactions = new Set();
  for (const observation of evidence.proofObservations) {
    validateProofObservation(observation, expectedChains);
    const key = `${observation.kind}:${observation.sourceChainId}`;
    if (keys.has(key)) throw new Error(`Live proof evidence repeats observation '${key}'`);
    keys.add(key);
    if (transactions.has(observation.acceptedTransactionHash)) {
      throw new Error("Live proof evidence repeats an accepted transaction hash");
    }
    transactions.add(observation.acceptedTransactionHash);
  }
  for (const chainId of expectedChains) {
    for (const kind of REQUIRED_MEMBERSHIP_KINDS) {
      if (!keys.has(`${kind}:${chainId}`)) {
        throw new Error(`Live proof evidence is missing '${kind}' for chain ${chainId}`);
      }
    }
  }
  return evidence;
}

function validateProofObservation(observation, expectedChains) {
  if (!isPlainObject(observation) || !SUPPORTED_KINDS.has(observation.kind)) {
    throw new Error("Live proof observation has an unsupported kind");
  }
  if (observation.rpcMethod !== "eth_getProof") throw new Error("Live proof observation has a wrong RPC method");
  const sourceChainId = decimalString(observation.sourceChainId, "source chain id");
  const destinationChainId = decimalString(observation.destinationChainId, "destination chain id");
  if (!expectedChains.includes(sourceChainId) || !expectedChains.includes(destinationChainId)) {
    throw new Error("Live proof observation references an unexpected chain");
  }
  if (sourceChainId === destinationChainId) throw new Error("Live proof observation does not cross chains");
  decimalString(observation.checkpointHeight, "checkpoint height");
  hexValue(observation.stateRoot, "state root", 32);
  addressValue(observation.account, "proof account");
  hexValue(observation.storageKey, "storage key", 32);
  const expectedValue = hexValue(observation.expectedValue, "expected value");
  proofNodes(observation.accountProof, "account proof");
  proofNodes(observation.storageProof, "storage proof");
  hexValue(observation.acceptedTransactionHash, "accepted transaction hash", 32);
  nonNegativeInteger(observation.acceptedBlockNumber, "accepted block number");
  if (observation.kind.endsWith("membership") && expectedValue === "0x") {
    throw new Error("Live membership observation has no expected value");
  }
  if (observation.kind === "receipt-absence" && expectedValue !== "0x") {
    throw new Error("Live absence observation has a non-empty expected value");
  }
  if (!HASH_PATTERN.test(observation.proofSha256 || "")) throw new Error("Live proof observation digest is malformed");
  const { proofSha256: _recorded, ...payload } = observation;
  if (proofObservationDigest(payload) !== observation.proofSha256) {
    throw new Error("Live proof observation digest mismatch");
  }
}

function proofObservationDigest(value) {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function proofNodes(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PROOF_NODES) {
    throw new Error(`${label} must contain between 1 and ${MAX_PROOF_NODES} nodes`);
  }
  return value.map((node, index) => {
    const normalized = hexValue(node, `${label} node ${index}`);
    if (normalized.length > MAX_PROOF_NODE_HEX_LENGTH) throw new Error(`${label} node ${index} is too large`);
    return normalized;
  });
}

function clientFamily(version) {
  const value = nonEmptyString(version, "client version");
  if (/^besu\//i.test(value)) return "Besu";
  throw new Error(`Unsupported live execution client '${value}'`);
}

function matchesPinnedBesuVersion(clientVersion, expectedVersion) {
  const segments = clientVersion.split("/");
  if (segments[0]?.toLowerCase() !== "besu" || segments.some((segment) => segment.length === 0)) return false;

  const semanticVersionIndexes = [];
  for (let index = 1; index < segments.length; index += 1) {
    if (/^v\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?$/i.test(segments[index])) {
      semanticVersionIndexes.push(index);
    }
  }

  if (semanticVersionIndexes.length !== 1) return false;
  const [versionIndex] = semanticVersionIndexes;
  if (versionIndex !== 1 && versionIndex !== 2) return false;
  return segments[versionIndex].toLowerCase() === `v${expectedVersion}`.toLowerCase();
}

function decimalString(value, label) {
  const normalized = typeof value === "bigint" ? value.toString() : String(value ?? "");
  if (!DECIMAL_PATTERN.test(normalized)) throw new Error(`${label} must be an unsigned decimal string`);
  return normalized;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

function addressValue(value, label) {
  try {
    return ethers.getAddress(value);
  } catch {
    throw new Error(`${label} is not a valid address`);
  }
}

function hexValue(value, label, bytes) {
  if (typeof value !== "string" || !ethers.isHexString(value, bytes)) {
    throw new Error(`${label} is not valid hexadecimal data`);
  }
  return value.toLowerCase();
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is missing`);
  return value.trim();
}

function sameStrings(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
