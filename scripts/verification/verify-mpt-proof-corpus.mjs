import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { getBytes, hexlify } from "ethers";

import {
  CORPUS_URL,
  MANIFEST_URL,
  SOLIDITY_URL,
  assertPinnedDependency,
  inspectProofTopology,
  renderArtifacts,
} from "./mpt-proof-corpus.mjs";

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} drifted; run npm run mpt:corpus:generate and review the diff`);
}

function addTopology(total, next) {
  for (const key of Object.keys(total)) total[key] += next[key];
}

export async function verifyPinnedMptCorpus() {
  await assertPinnedDependency();
  const expected = await renderArtifacts();
  const [corpusJson, manifestJson, solidity] = await Promise.all([
    readFile(CORPUS_URL, "utf8"),
    readFile(MANIFEST_URL, "utf8"),
    readFile(SOLIDITY_URL, "utf8"),
  ]);
  assertEqual(corpusJson, expected.corpusJson, "MPT corpus");
  assertEqual(manifestJson, expected.manifestJson, "MPT corpus manifest");
  assertEqual(solidity, expected.solidity, "MPT corpus Solidity adapter");

  const topology = { branch: 0, extension: 0, leaf: 0, inlineNodeReference: 0, hashedNodeReference: 0 };
  for (const vector of expected.corpus.genericVectors) addTopology(topology, inspectProofTopology(vector.proof));
  if (topology.branch === 0 || topology.extension === 0 || topology.leaf === 0) {
    throw new Error(`MPT corpus lost branch/extension/leaf coverage: ${JSON.stringify(topology)}`);
  }
  if (topology.inlineNodeReference === 0 || topology.hashedNodeReference === 0) {
    throw new Error(`MPT corpus lost inline/hashed child coverage: ${JSON.stringify(topology)}`);
  }
  if (expected.manifest.evidenceEligible !== false || expected.corpus.compatibility.validatedLiveClients.length !== 0) {
    throw new Error("Offline assurance corpus must not claim live-client or defense-evidence provenance");
  }

  for (const vector of expected.corpus.storageVectors) {
    if (getBytes(vector.stateRoot).length !== 32 || getBytes(vector.storageKey).length !== 32) {
      throw new Error(`EIP-1186 vector ${vector.id} has a non-word root or storage key`);
    }
    if (vector.accountProof.length === 0 || vector.storageProof.length === 0) {
      throw new Error(`EIP-1186 vector ${vector.id} has an empty proof`);
    }
    if (hexlify(getBytes(vector.account)) !== vector.account.toLowerCase()) {
      throw new Error(`EIP-1186 vector ${vector.id} has a non-canonical account`);
    }
  }

  return {
    genericVectors: expected.corpus.genericVectors.length,
    storageVectors: expected.corpus.storageVectors.length,
    topology,
    classification: expected.manifest.classification,
    evidenceEligible: expected.manifest.evidenceEligible,
    validatedLiveClients: expected.corpus.compatibility.validatedLiveClients,
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  const result = await verifyPinnedMptCorpus();
  console.log(`Verified ${result.genericVectors} generic and ${result.storageVectors} EIP-1186 storage vectors.`);
  console.log(`Topology: ${JSON.stringify(result.topology)}`);
  console.log(`Classification: ${result.classification}; evidenceEligible=false.`);
}
