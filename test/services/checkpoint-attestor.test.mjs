import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ethers } from "ethers";
import { AttestorJournal } from "../../services/institutional-relay/attestor-journal.mjs";
import { CheckpointAttestor } from "../../services/institutional-relay/checkpoint-attestor.mjs";
import {
  CHECKPOINT_TYPES,
  checkpointDomain,
} from "../../services/institutional-relay/checkpoint-typed-data.mjs";

const SOURCE_CHAIN_ID = 41001n;
const DESTINATION_CHAIN_ID = 41002n;
const CHECKPOINT_CLIENT = "0x00000000000000000000000000000000000000c1";
const BLOCK_HASH = `0x${"11".repeat(32)}`;
const STATE_ROOT = `0x${"22".repeat(32)}`;

class FakeProvider {
  constructor() {
    this.latest = 103;
    this.block = {
      number: "0x64",
      hash: BLOCK_HASH,
      stateRoot: STATE_ROOT,
      timestamp: "0x6b49d200",
    };
  }

  async getNetwork() {
    return { chainId: SOURCE_CHAIN_ID };
  }

  async getBlockNumber() {
    return this.latest;
  }

  async send(method) {
    assert.equal(method, "eth_getBlockByNumber");
    return this.block;
  }
}

function checkpoint(overrides = {}) {
  return {
    sourceChainId: SOURCE_CHAIN_ID.toString(),
    blockNumber: "100",
    blockHash: BLOCK_HASH,
    stateRoot: STATE_ROOT,
    timestamp: "1800000000",
    attestorEpoch: "1",
    ...overrides,
  };
}

async function fixture(finalityDepth = 2) {
  const directory = await mkdtemp(join(tmpdir(), "institutional-attestor-"));
  const journalPath = join(directory, "journal.json");
  const journal = await AttestorJournal.open(journalPath);
  const provider = new FakeProvider();
  const wallet = new ethers.Wallet(`0x${"01".repeat(32)}`);
  const attestor = new CheckpointAttestor({
    wallet,
    journal,
    sources: { [SOURCE_CHAIN_ID]: { provider, finalityDepth } },
  });
  return { directory, journalPath, journal, provider, wallet, attestor };
}

function request(checkpointValue = checkpoint()) {
  return {
    checkpoint: checkpointValue,
    domain: {
      destinationChainId: DESTINATION_CHAIN_ID.toString(),
      checkpointClient: CHECKPOINT_CLIENT,
    },
  };
}

test("attestor verifies the source block and returns a valid EIP-712 signature", async (t) => {
  const context = await fixture();
  t.after(() => rm(context.directory, { recursive: true, force: true }));

  const result = await context.attestor.attest(request());
  const recovered = ethers.verifyTypedData(
    checkpointDomain(request().domain),
    CHECKPOINT_TYPES,
    checkpoint(),
    result.signature,
  );
  assert.equal(recovered, context.wallet.address);
  assert.equal(result.signer, context.wallet.address);
  assert.equal(Object.keys(context.journal.snapshot().checkpoints).length, 1);
});

test("attestor refuses checkpoints before configured finality depth", async (t) => {
  const context = await fixture(4);
  t.after(() => rm(context.directory, { recursive: true, force: true }));

  await assert.rejects(context.attestor.attest(request()), /has not reached finality depth/);
  assert.equal(Object.keys(context.journal.snapshot().checkpoints).length, 0);
});

test("attestor refuses block hash, root, and timestamp mismatches", async (t) => {
  const context = await fixture();
  t.after(() => rm(context.directory, { recursive: true, force: true }));

  await assert.rejects(
    context.attestor.attest(request(checkpoint({ stateRoot: `0x${"33".repeat(32)}` }))),
    /stateRoot does not match/,
  );
  await assert.rejects(
    context.attestor.attest(request(checkpoint({ blockHash: `0x${"44".repeat(32)}` }))),
    /blockHash does not match/,
  );
  await assert.rejects(
    context.attestor.attest(request(checkpoint({ timestamp: "1800000001" }))),
    /timestamp does not match/,
  );
});

test("equivocation guard survives restart and rejects a conflicting canonical block", async (t) => {
  const context = await fixture();
  t.after(() => rm(context.directory, { recursive: true, force: true }));
  await context.attestor.attest(request());

  const conflictingRoot = `0x${"55".repeat(32)}`;
  context.provider.block = { ...context.provider.block, stateRoot: conflictingRoot };
  const reopened = await AttestorJournal.open(context.journalPath);
  const restartedAttestor = new CheckpointAttestor({
    wallet: context.wallet,
    journal: reopened,
    sources: { [SOURCE_CHAIN_ID]: { provider: context.provider, finalityDepth: 2 } },
  });

  await assert.rejects(
    restartedAttestor.attest(request(checkpoint({ stateRoot: conflictingRoot }))),
    /equivocation guard rejected/,
  );
});
