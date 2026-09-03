import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { collectCheckpointQuorum } from "../../services/institutional-relay/attestor-collector.mjs";
import {
  CHECKPOINT_TYPES,
  checkpointDigest,
  checkpointDomain,
} from "../../services/institutional-relay/checkpoint-typed-data.mjs";

const checkpoint = {
  sourceChainId: "41001",
  blockNumber: "100",
  blockHash: `0x${"11".repeat(32)}`,
  stateRoot: `0x${"22".repeat(32)}`,
  timestamp: "1800000000",
  attestorEpoch: "1",
};
const domainInput = {
  destinationChainId: "41002",
  checkpointClient: "0x00000000000000000000000000000000000000c1",
};

test("collector validates and sorts a three-of-four quorum", async () => {
  const wallets = [1, 2, 3, 4].map((value) => new ethers.Wallet(`0x${value.toString(16).padStart(64, "0")}`));
  const domain = checkpointDomain(domainInput);
  const responses = new Map();
  for (let index = 0; index < wallets.length; index++) {
    const wallet = wallets[index];
    responses.set(`attestor-${index}`, {
      signer: wallet.address,
      signature: await wallet.signTypedData(domain, CHECKPOINT_TYPES, checkpoint),
      digest: checkpointDigest(checkpoint, domain),
    });
  }
  const fetchImpl = async (url) => {
    const signer = new URL(url).hostname;
    return { ok: true, async json() { return responses.get(signer); } };
  };
  const endpoints = wallets.map((_, index) => `http://attestor-${index}`);
  const result = await collectCheckpointQuorum({
    checkpoint,
    domain: domainInput,
    endpoints,
    threshold: 3,
    allowedAttestors: wallets.map((wallet) => wallet.address),
    fetchImpl,
  });

  assert.equal(result.signatures.length, 3);
  assert.equal(new Set(result.signers).size, 3);
  assert.ok(result.signers.every((signer) => wallets.some((wallet) => wallet.address === signer)));
  assert.deepEqual(result.signers, [...result.signers].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())));
});

test("collector returns at quorum and aborts an unavailable straggler", async () => {
  const wallets = [1, 2, 3, 4].map((value) => new ethers.Wallet(`0x${value.toString(16).padStart(64, "0")}`));
  const domain = checkpointDomain(domainInput);
  const digest = checkpointDigest(checkpoint, domain);
  let stragglerAborted = false;
  const fetchImpl = async (url, options) => {
    const index = Number(new URL(url).hostname.split("-").at(-1));
    if (index === 3) {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          stragglerAborted = true;
          reject(options.signal.reason || new Error("aborted"));
        }, { once: true });
      });
    }
    return {
      ok: true,
      async json() {
        return {
          signer: wallets[index].address,
          signature: await wallets[index].signTypedData(domain, CHECKPOINT_TYPES, checkpoint),
          digest,
        };
      },
    };
  };

  const result = await collectCheckpointQuorum({
    checkpoint,
    domain: domainInput,
    endpoints: wallets.map((_, index) => `http://attestor-${index}`),
    threshold: 3,
    allowedAttestors: wallets.map((wallet) => wallet.address),
    timeoutMs: 60_000,
    fetchImpl,
  });

  assert.equal(result.signatures.length, 3);
  assert.equal(stragglerAborted, true);
});

test("collector rejects thresholds that cannot be satisfied", async () => {
  const wallet = new ethers.Wallet(`0x${"01".padStart(64, "0")}`);
  await assert.rejects(
    collectCheckpointQuorum({
      checkpoint,
      domain: domainInput,
      endpoints: ["http://attestor-0"],
      threshold: 2,
      allowedAttestors: [wallet.address],
      fetchImpl: async () => assert.fail("invalid configuration must fail before fetch"),
    }),
    /threshold exceeds/,
  );
  await assert.rejects(
    collectCheckpointQuorum({
      checkpoint,
      domain: domainInput,
      endpoints: ["file:///tmp/not-an-attestor"],
      threshold: 1,
      allowedAttestors: [wallet.address],
      fetchImpl: async () => assert.fail("invalid endpoint must fail before fetch"),
    }),
    /must use HTTP\(S\)/,
  );
});

test("collector rejects forged, duplicate, and non-attestor responses below quorum", async () => {
  const allowed = [1, 2, 3, 4].map((value) => new ethers.Wallet(`0x${value.toString(16).padStart(64, "0")}`));
  const outsider = new ethers.Wallet(`0x${"09".padStart(64, "0")}`);
  const domain = checkpointDomain(domainInput);
  const goodSignature = await allowed[0].signTypedData(domain, CHECKPOINT_TYPES, checkpoint);
  const outsiderSignature = await outsider.signTypedData(domain, CHECKPOINT_TYPES, checkpoint);
  const digest = checkpointDigest(checkpoint, domain);
  const bodies = [
    { signer: allowed[0].address, signature: goodSignature, digest },
    { signer: allowed[0].address, signature: goodSignature, digest },
    { signer: outsider.address, signature: outsiderSignature, digest },
    { signer: allowed[1].address, signature: goodSignature, digest: `0x${"ff".repeat(32)}` },
  ];
  let index = 0;
  const fetchImpl = async () => ({ ok: true, async json() { return bodies[index++]; } });

  await assert.rejects(
    collectCheckpointQuorum({
      checkpoint,
      domain: domainInput,
      endpoints: ["http://a", "http://b", "http://c", "http://d"],
      threshold: 3,
      allowedAttestors: allowed.map((wallet) => wallet.address),
      fetchImpl,
    }),
    /Collected 1 valid checkpoint signatures/,
  );
});
