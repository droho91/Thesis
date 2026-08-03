import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Trie } from "@ethereumjs/trie";
import {
  decodeRlp,
  encodeRlp,
  getAddress,
  getBytes,
  hexlify,
  id,
  keccak256,
  toBeHex,
  zeroPadValue,
} from "ethers";

export const CORPUS_SCHEMA = "institutional-mpt-proof-corpus/v1";
export const GENERATOR_PACKAGE = "@ethereumjs/trie";
export const GENERATOR_VERSION = "6.2.1";
export const GENERATOR_INTEGRITY =
  "sha512-MguABMVi/dPtgagK+SuY57rpXFP+Ghr2x+pBDy+e3VmMqUY+WGzFu1QWjBb5/iJ7lINk4CI2Uwsih07Nu9sTSg==";
export const GENERATOR_SOURCE = "https://github.com/ethereumjs/ethereumjs-monorepo.git";
export const CORPUS_URL = new URL("../../test/fixtures/mpt-proof-corpus/corpus.json", import.meta.url);
export const MANIFEST_URL = new URL("../../test/fixtures/mpt-proof-corpus/manifest.json", import.meta.url);
export const SOLIDITY_URL = new URL("../../contracts/test/PinnedMPTProofCorpus.sol", import.meta.url);

const EMPTY_CODE_HASH = keccak256("0x");
const SOURCE_ACCOUNT = getAddress("0x1111111111111111111111111111111111111111");
const SOURCE_CHAIN_ID = "41001";
const CHECKPOINT_HEIGHT = "880001";
const GENERIC_ENTRIES = [
  ["0x1234", "0x01"],
  ["0x1235", "0x02"],
  ["0x1200", `0x${"aa".repeat(32)}`],
  ["0x20", `0x${"bb".repeat(32)}`],
  ["0x21", "0x03"],
];
const STORAGE_ENTRIES = [
  [word(1n), word(BigInt(id("institutional-corpus:commitment")))],
  [word(2n), word(0x7fn)],
  [word(3n), word(0x80n)],
  [word(4n), word(0x123456n)],
];
const ABSENT_STORAGE_KEY = word(255n);

function word(value) {
  return zeroPadValue(toBeHex(value), 32);
}

function bytes(hex) {
  return getBytes(hex);
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function proofHex(proof) {
  return proof.map((node) => hexlify(node));
}

function rlpStorageWord(value) {
  const integer = BigInt(value);
  if (integer === 0n) return "0x80";
  let raw = integer.toString(16);
  if (raw.length % 2 !== 0) raw = `0${raw}`;
  return encodeRlp(`0x${raw}`);
}

function accountRlp(storageRoot, nonce, balance) {
  const encodeInteger = (value) => (value === 0n ? "0x" : toBeHex(value));
  return encodeRlp([encodeInteger(nonce), encodeInteger(balance), storageRoot, EMPTY_CODE_HASH]);
}

async function trieFrom(entries) {
  const trie = new Trie({ useKeyHashing: false, useRootPersistence: false });
  for (const [key, value] of entries) await trie.put(bytes(key), bytes(value));
  return trie;
}

async function vector(trie, { id: vectorId, key, value = "0x", outcome, scenario }) {
  const proof = await trie.createProof(bytes(key));
  const independentlyRead = await trie.verifyProof(trie.root(), bytes(key), proof);
  if (outcome === "present" && hexlify(independentlyRead) !== value) {
    throw new Error(`Generator self-check failed for membership vector ${vectorId}`);
  }
  if (outcome === "absent" && independentlyRead !== null) {
    throw new Error(`Generator self-check failed for absence vector ${vectorId}`);
  }
  return {
    id: vectorId,
    scenario,
    outcome,
    root: hexlify(trie.root()),
    key,
    value,
    proof: proofHex(proof),
  };
}

async function buildGenericVectors() {
  const trie = await trieFrom(GENERIC_ENTRIES);
  return Promise.all([
    vector(trie, {
      id: "generic-extension-inline-membership",
      scenario: "extension, hashed branch reference, nested inline branch and inline leaf",
      outcome: "present",
      key: "0x1234",
      value: "0x01",
    }),
    vector(trie, {
      id: "generic-long-leaf-membership",
      scenario: "branch membership with a hashed long-value leaf",
      outcome: "present",
      key: "0x1200",
      value: `0x${"aa".repeat(32)}`,
    }),
    vector(trie, {
      id: "generic-missing-branch-child",
      scenario: "absence at an empty branch child",
      outcome: "absent",
      key: "0x22",
    }),
    vector(trie, {
      id: "generic-divergent-leaf",
      scenario: "absence at a divergent inline leaf",
      outcome: "absent",
      key: "0x1236",
    }),
    vector(trie, {
      id: "generic-divergent-extension",
      scenario: "absence at a divergent extension path",
      outcome: "absent",
      key: "0x1334",
    }),
  ]);
}

async function buildStorageTrie() {
  const entries = STORAGE_ENTRIES.map(([storageKey, storageWord]) => [
    keccak256(storageKey),
    rlpStorageWord(storageWord),
  ]);
  return trieFrom(entries);
}

async function buildStateTrie(sourceStorageRoot) {
  const accounts = [
    [SOURCE_ACCOUNT, sourceStorageRoot, 3n, 2_000_000n],
    [getAddress("0x2222222222222222222222222222222222222222"), id("storage-root:b"), 1n, 17n],
    [getAddress("0x3333333333333333333333333333333333333333"), id("storage-root:c"), 7n, 23n],
    [getAddress("0x4444444444444444444444444444444444444444"), id("storage-root:d"), 2n, 42n],
  ];
  return trieFrom(accounts.map(([account, storageRoot, nonce, balance]) => [
    keccak256(account),
    accountRlp(storageRoot, nonce, balance),
  ]));
}

async function storageVector(stateTrie, storageTrie, { id: vectorId, storageKey, expectedValue, outcome }) {
  const accountProof = await stateTrie.createProof(bytes(keccak256(SOURCE_ACCOUNT)));
  const storageProof = await storageTrie.createProof(bytes(keccak256(storageKey)));
  const accountValue = await stateTrie.verifyProof(stateTrie.root(), bytes(keccak256(SOURCE_ACCOUNT)), accountProof);
  const storageValue = await storageTrie.verifyProof(storageTrie.root(), bytes(keccak256(storageKey)), storageProof);
  if (accountValue === null) throw new Error(`Generator lost source account for ${vectorId}`);
  if (outcome === "present" && hexlify(storageValue) !== expectedValue) {
    throw new Error(`Generator self-check failed for storage membership vector ${vectorId}`);
  }
  if (outcome === "absent" && storageValue !== null) {
    throw new Error(`Generator self-check failed for storage absence vector ${vectorId}`);
  }
  return {
    id: vectorId,
    outcome,
    sourceChainId: SOURCE_CHAIN_ID,
    checkpointHeight: CHECKPOINT_HEIGHT,
    stateRoot: hexlify(stateTrie.root()),
    account: SOURCE_ACCOUNT,
    storageKey,
    expectedValue,
    accountProof: proofHex(accountProof),
    storageProof: proofHex(storageProof),
  };
}

async function buildStorageVectors() {
  const storageTrie = await buildStorageTrie();
  const stateTrie = await buildStateTrie(hexlify(storageTrie.root()));
  const [firstKey, firstWord] = STORAGE_ENTRIES[0];
  const [singleByteKey, singleByteWord] = STORAGE_ENTRIES[1];
  return Promise.all([
    storageVector(stateTrie, storageTrie, {
      id: "eip1186-storage-membership-long-word",
      outcome: "present",
      storageKey: firstKey,
      expectedValue: rlpStorageWord(firstWord),
    }),
    storageVector(stateTrie, storageTrie, {
      id: "eip1186-storage-membership-single-byte",
      outcome: "present",
      storageKey: singleByteKey,
      expectedValue: rlpStorageWord(singleByteWord),
    }),
    storageVector(stateTrie, storageTrie, {
      id: "eip1186-storage-absence",
      outcome: "absent",
      storageKey: ABSENT_STORAGE_KEY,
      expectedValue: "0x",
    }),
  ]);
}

export async function buildCorpus() {
  return {
    schema: CORPUS_SCHEMA,
    generator: {
      package: GENERATOR_PACKAGE,
      version: GENERATOR_VERSION,
      packageIntegrity: GENERATOR_INTEGRITY,
      source: GENERATOR_SOURCE,
      options: { useKeyHashing: false, inputKeys: "pre-hashed for state/storage vectors" },
    },
    compatibility: {
      wireFormat: "EIP-1186 root-to-leaf arrays of canonical RLP-encoded MPT nodes",
      formatTargets: ["Hyperledger Besu eth_getProof", "Geth eth_getProof", "EthereumJS Trie proof API"],
      validatedLiveClients: [],
      validationLevel: "client-neutral format plus independent offline generation; no live Besu/Geth capture",
    },
    assuranceBoundary:
      "Committed deterministic test fixture only. It is not live-chain evidence, proof of a client run, formal verification, or defense evidence.",
    genericVectors: await buildGenericVectors(),
    storageVectors: await buildStorageVectors(),
  };
}

function solidityHex(value) {
  return `hex"${value.slice(2)}"`;
}

function solidityProofAssignments(field, proof) {
  return proof.map((node, index) => `        vector.${field}[${index}] = ${solidityHex(node)};`).join("\n");
}

function renderGenericVector(vector, index) {
  return `    if (index == ${index}) {
        vector.root = ${vector.root};
        vector.key = ${solidityHex(vector.key)};
        vector.value = ${solidityHex(vector.value)};
        vector.present = ${vector.outcome === "present"};
        vector.proof = new bytes[](${vector.proof.length});
${solidityProofAssignments("proof", vector.proof)}
        return vector;
    }`;
}

function renderStorageVector(vector, index) {
  return `    if (index == ${index}) {
        vector.sourceChainId = ${vector.sourceChainId};
        vector.checkpointHeight = ${vector.checkpointHeight};
        vector.stateRoot = ${vector.stateRoot};
        vector.account = ${vector.account};
        vector.storageKey = ${vector.storageKey};
        vector.expectedValue = ${solidityHex(vector.expectedValue)};
        vector.present = ${vector.outcome === "present"};
        vector.accountProof = new bytes[](${vector.accountProof.length});
${solidityProofAssignments("accountProof", vector.accountProof)}
        vector.storageProof = new bytes[](${vector.storageProof.length});
${solidityProofAssignments("storageProof", vector.storageProof)}
        return vector;
    }`;
}

export function renderSolidity(corpus) {
  const genericCases = corpus.genericVectors.map(renderGenericVector).join("\n");
  const storageCases = corpus.storageVectors.map(renderStorageVector).join("\n");
  return `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice GENERATED by scripts/verification/generate-mpt-proof-corpus.mjs.
/// @dev Deterministic test-assurance fixtures, not live-chain or defense evidence.
contract PinnedMPTProofCorpus {
    struct GenericVector {
        bytes32 root;
        bytes key;
        bytes value;
        bytes[] proof;
        bool present;
    }

    struct StorageVector {
        uint256 sourceChainId;
        uint256 checkpointHeight;
        bytes32 stateRoot;
        address account;
        bytes32 storageKey;
        bytes expectedValue;
        bytes[] accountProof;
        bytes[] storageProof;
        bool present;
    }

    function genericCount() external pure returns (uint256) {
        return ${corpus.genericVectors.length};
    }

    function storageCount() external pure returns (uint256) {
        return ${corpus.storageVectors.length};
    }

    function genericAt(uint256 index) external pure returns (GenericVector memory vector) {
${genericCases}
        revert("CORPUS_GENERIC_INDEX_OOB");
    }

    function storageAt(uint256 index) external pure returns (StorageVector memory vector) {
${storageCases}
        revert("CORPUS_STORAGE_INDEX_OOB");
    }
}
`;
}

export async function renderArtifacts() {
  const corpus = await buildCorpus();
  const corpusJson = canonicalJson(corpus);
  const solidity = renderSolidity(corpus);
  const manifest = {
    schema: "institutional-mpt-proof-corpus-manifest/v1",
    corpus: "corpus.json",
    corpusSha256: sha256(corpusJson),
    solidityAdapter: "../../../contracts/test/PinnedMPTProofCorpus.sol",
    solidityAdapterSha256: sha256(solidity),
    source: {
      kind: "deterministic-offline-generation",
      tool: GENERATOR_PACKAGE,
      version: GENERATOR_VERSION,
      packageIntegrity: GENERATOR_INTEGRITY,
      repository: GENERATOR_SOURCE,
    },
    classification: "deterministic-test-assurance-fixture",
    evidenceEligible: false,
  };
  return { corpus, corpusJson, manifest, manifestJson: canonicalJson(manifest), solidity };
}

export async function assertPinnedDependency() {
  const [packageJson, packageLock] = await Promise.all([
    readFile(new URL("../../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../../package-lock.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  if (packageJson.devDependencies?.[GENERATOR_PACKAGE] !== GENERATOR_VERSION) {
    throw new Error(`${GENERATOR_PACKAGE} must be pinned exactly to ${GENERATOR_VERSION}`);
  }
  const locked = packageLock.packages?.[`node_modules/${GENERATOR_PACKAGE}`];
  if (locked?.version !== GENERATOR_VERSION || locked?.integrity !== GENERATOR_INTEGRITY) {
    throw new Error(`${GENERATOR_PACKAGE} lock provenance does not match the pinned version and integrity`);
  }
}

export function inspectProofTopology(proof) {
  const topology = { branch: 0, extension: 0, leaf: 0, inlineNodeReference: 0, hashedNodeReference: 0 };
  for (const encoded of proof) {
    const node = decodeRlp(encoded);
    if (!Array.isArray(node)) throw new Error("Proof node must be an RLP list");
    if (node.length === 17) {
      topology.branch += 1;
      for (const child of node.slice(0, 16)) {
        if (Array.isArray(child)) topology.inlineNodeReference += 1;
        else if (child !== "0x" && bytes(child).length === 32) topology.hashedNodeReference += 1;
      }
      continue;
    }
    if (node.length !== 2 || Array.isArray(node[0])) throw new Error("Proof node is not a canonical MPT node");
    const flag = Number.parseInt(node[0].slice(2, 3), 16);
    if ((flag & 2) !== 0) topology.leaf += 1;
    else topology.extension += 1;
    const child = node[1];
    if ((flag & 2) === 0) {
      if (Array.isArray(child)) topology.inlineNodeReference += 1;
      else if (child !== "0x" && bytes(child).length === 32) topology.hashedNodeReference += 1;
    }
  }
  return topology;
}
