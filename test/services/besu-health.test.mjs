import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { ethers } from "ethers";
import { waitForProgress } from "../../scripts/ops/besu/health.mjs";

const validators = Array.from({ length: 4 }, (_, index) => ({
  name: `validator-${index + 1}`,
  address: ethers.getAddress(`0x${String(index + 1).padStart(40, "0")}`),
}));
const network = { key: "chainA", chainId: 41001, validators };

let server;
let rpc;
let peerChecks;

before(async () => {
  server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    let result;
    if (body.method === "eth_chainId") result = ethers.toQuantity(network.chainId);
    if (body.method === "eth_blockNumber") result = "0x2";
    if (body.method === "eth_getCode") result = "0x";
    if (body.method === "qbft_getValidatorsByBlockNumber") {
      result = validators.map((validator) => validator.address);
    }
    if (body.method === "net_peerCount") {
      peerChecks += 1;
      result = peerChecks === 1 ? "0x1" : "0x3";
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  rpc = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
});

test("health waits for peer convergence after the target block is reached", async () => {
  peerChecks = 0;
  const snapshot = await waitForProgress(network, rpc, {
    startHeight: 1,
    blocks: 1,
    timeoutMs: 1_000,
    pollIntervalMs: 10,
  });

  assert.equal(snapshot.blockNumber, 2);
  assert.equal(snapshot.peerCount, 3);
  assert.equal(snapshot.validatorCount, 4);
  assert.equal(peerChecks, 2);
});
