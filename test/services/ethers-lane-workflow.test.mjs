import assert from "node:assert/strict";
import test from "node:test";
import { EthersInstitutionalLaneWorkflow, rlpEncodeStorageWord } from "../../services/institutional-relay/ethers-lane-workflow.mjs";

const GATEWAY_A = "0x00000000000000000000000000000000000000A1";
const GATEWAY_B = "0x00000000000000000000000000000000000000B1";

test("storage words use canonical Ethereum trie RLP encoding", () => {
  assert.equal(rlpEncodeStorageWord("0x00"), "0x80");
  assert.equal(rlpEncodeStorageWord("0x01"), "0x01");
  assert.equal(rlpEncodeStorageWord("0x7f"), "0x7f");
  assert.equal(rlpEncodeStorageWord("0x80"), "0x8180");
  assert.equal(rlpEncodeStorageWord(`0x${"12".repeat(32)}`), `0xa0${"12".repeat(32)}`);
});

test("lane scanner reconstructs the canonical message envelope from gateway events", async () => {
  const event = {
    transactionHash: `0x${"33".repeat(32)}`,
    blockNumber: 50,
    args: {
      messageId: `0x${"44".repeat(32)}`,
      nonce: 7n,
      sourceApplication: "0x00000000000000000000000000000000000000A2",
      destinationChainId: 41002n,
      destinationGateway: GATEWAY_B,
      destinationApplication: "0x00000000000000000000000000000000000000B2",
      timeoutTimestamp: 1_800_003_600n,
      payload: "0x1234",
    },
  };
  const source = {
    chainId: 41001n,
    gatewayAddress: GATEWAY_A,
    provider: { async getBlockNumber() { return 80; } },
    gateway: {
      filters: { MessageCommitted() { return {}; } },
      async queryFilter() { return [event]; },
    },
  };
  const destination = { chainId: 41002n, gatewayAddress: GATEWAY_B };
  const workflow = new EthersInstitutionalLaneWorkflow({
    config: { scanRange: 100 },
    source,
    destination,
  });

  const result = await workflow.scan(40);
  assert.equal(result.scannedTo, 80);
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0].message, {
    version: "1",
    nonce: "7",
    sourceChainId: "41001",
    sourceGateway: GATEWAY_A,
    sourceApplication: "0x00000000000000000000000000000000000000A2",
    destinationChainId: "41002",
    destinationGateway: GATEWAY_B,
    destinationApplication: "0x00000000000000000000000000000000000000B2",
    timeoutTimestamp: "1800003600",
    payload: "0x1234",
  });
});
