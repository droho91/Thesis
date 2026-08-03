import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAcceptedProofObservation,
  buildLiveClientProofValidation,
  createLiveClientProofCollector,
  validateLiveClientProofEvidence,
} from "../../scripts/verification/live-client-proof-evidence.mjs";

const CHAIN_A = "41001";
const CHAIN_B = "41002";
const CLIENT_VERSION = "besu/v24.10.0/linux-x86_64/openjdk-java-21";
const IDENTIFIED_CLIENT_VERSION = "besu/chainA-bank-a-validator-1/v24.10.0/linux-x86_64/openjdk-java-21";

test("live proof evidence binds both Besu chains and four production-accepted membership proofs", () => {
  const evidence = passingEvidence();
  assert.equal(validateLiveClientProofEvidence(evidence), evidence);
  assert.deepEqual(evidence.validatedLiveClients, ["Besu"]);
  assert.equal(evidence.proofObservations.length, 4);
  assert.equal(evidence.proofObservations.every((proof) => proof.accountProof.length > 0), true);
});

test("live proof collector retains one bounded observation per kind and source chain", () => {
  const collector = createLiveClientProofCollector();
  for (const observation of passingObservations()) {
    const { proofSha256: _digest, ...event } = observation;
    collector.observeAcceptedProof({
      ...event,
      proof: {
        checkpointHeight: event.checkpointHeight,
        stateRoot: event.stateRoot,
        account: event.account,
        storageKey: event.storageKey,
        expectedValue: event.expectedValue,
        accountProof: event.accountProof,
        storageProof: event.storageProof,
      },
    });
    collector.observeAcceptedProof({
      ...event,
      proof: {
        checkpointHeight: event.checkpointHeight,
        stateRoot: event.stateRoot,
        account: event.account,
        storageKey: event.storageKey,
        expectedValue: event.expectedValue,
        accountProof: event.accountProof,
        storageProof: event.storageProof,
      },
    });
  }
  const evidence = collector.build(chainSnapshots());
  assert.equal(evidence.proofObservations.length, 4);
});

test("live proof validation accepts Besu node identity without weakening the pinned version", () => {
  const evidence = passingEvidence();
  evidence.clients[0].clientVersion = IDENTIFIED_CLIENT_VERSION;
  assert.equal(validateLiveClientProofEvidence(evidence), evidence);

  for (const clientVersion of [
    "besu/chainA-bank-a-validator-1/v24.10.1/linux-x86_64/openjdk-java-21",
    "besu/chainA-bank-a-validator-1/v24.10.0-rc1/linux-x86_64/openjdk-java-21",
    "besu/v24.10.0/v25.1.0/openjdk-java-21",
    "besu/chainA-bank-a-validator-1/extra/v24.10.0/linux-x86_64/openjdk-java-21",
  ]) {
    const changed = structuredClone(evidence);
    changed.clients[0].clientVersion = clientVersion;
    assert.throws(
      () => validateLiveClientProofEvidence(changed),
      /Live Besu client version does not match pinned 24\.10\.0/,
    );
  }
});

test("live proof validation fails closed on missing coverage, drift, wrong clients and duplicate acceptance", () => {
  const mutations = [
    (value) => value.proofObservations.pop(),
    (value) => { value.proofObservations[0].accountProof[0] = "0xc199"; },
    (value) => { value.clients[0].clientVersion = "geth/v1.15.0"; },
    (value) => { value.validatedLiveClients = ["Besu", "Geth"]; },
    (value) => {
      value.proofObservations[1].acceptedTransactionHash = value.proofObservations[0].acceptedTransactionHash;
      const { proofSha256: _digest, ...payload } = value.proofObservations[1];
      value.proofObservations[1] = buildAcceptedProofObservation({
        kind: payload.kind,
        sourceChainId: payload.sourceChainId,
        destinationChainId: payload.destinationChainId,
        proof: payload,
        acceptedTransactionHash: payload.acceptedTransactionHash,
        acceptedBlockNumber: payload.acceptedBlockNumber,
      });
    },
  ];

  for (const mutate of mutations) {
    const changed = structuredClone(passingEvidence());
    mutate(changed);
    assert.throws(() => validateLiveClientProofEvidence(changed));
  }
});

test("accepted proof observation rejects malformed boundaries before collection", () => {
  assert.throws(
    () => observation("unsupported", CHAIN_A, CHAIN_B, 1),
    /Unsupported live proof observation kind/,
  );
  assert.throws(
    () => observation("message-commitment-membership", CHAIN_A, CHAIN_A, 1),
    /distinct chains/,
  );
  assert.throws(
    () => buildAcceptedProofObservation({
      kind: "message-commitment-membership",
      sourceChainId: CHAIN_A,
      destinationChainId: CHAIN_B,
      proof: {
        checkpointHeight: "12",
        stateRoot: hex32(1),
        account: address(1),
        storageKey: hex32(2),
        expectedValue: "0x01",
        accountProof: [],
        storageProof: ["0xc100"],
      },
      acceptedTransactionHash: hex32(3),
      acceptedBlockNumber: 10,
    }),
    /account proof must contain/,
  );
});

function passingEvidence() {
  return buildLiveClientProofValidation({
    chainSnapshots: chainSnapshots(),
    proofObservations: passingObservations(),
  });
}

function chainSnapshots() {
  return [
    { chainId: CHAIN_A, clientVersion: CLIENT_VERSION },
    { chainId: CHAIN_B, clientVersion: CLIENT_VERSION },
  ];
}

function passingObservations() {
  return [
    observation("message-commitment-membership", CHAIN_A, CHAIN_B, 1),
    observation("acknowledgement-membership", CHAIN_A, CHAIN_B, 2),
    observation("message-commitment-membership", CHAIN_B, CHAIN_A, 3),
    observation("acknowledgement-membership", CHAIN_B, CHAIN_A, 4),
  ];
}

function observation(kind, sourceChainId, destinationChainId, identity) {
  return buildAcceptedProofObservation({
    kind,
    sourceChainId,
    destinationChainId,
    proof: {
      checkpointHeight: String(100 + identity),
      stateRoot: hex32(1_000 + identity),
      account: address(2_000 + Number(sourceChainId)),
      storageKey: hex32(3_000 + identity),
      expectedValue: "0x01",
      accountProof: [`0xc1${identity.toString(16).padStart(2, "0")}`],
      storageProof: [`0xc2${identity.toString(16).padStart(2, "0")}00`],
    },
    acceptedTransactionHash: hex32(4_000 + identity),
    acceptedBlockNumber: 200 + identity,
  });
}

function address(value) {
  return `0x${BigInt(value).toString(16).padStart(40, "0")}`;
}

function hex32(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}
