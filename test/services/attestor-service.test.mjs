import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { startCheckpointAttestorService } from "../../services/institutional-relay/attestor-service.mjs";

const PRIVATE_KEY = `0x${"11".repeat(32)}`;
const CHECKPOINT_CLIENT = "0x00000000000000000000000000000000000000c1";

function config(port) {
  return {
    privateKey: PRIVATE_KEY,
    token: "test-token",
    listen: { host: "127.0.0.1", port },
    sources: {
      "41001": { rpc: "http://127.0.0.1:8545", finalityDepth: 2 },
    },
    allowedDomains: [{ destinationChainId: "41002", checkpointClient: CHECKPOINT_CLIENT }],
  };
}

function listen(server, port = 0) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", resolveListen);
  });
}

function close(server) {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

test("attestor startup releases journal and providers when the listen port is occupied", async (t) => {
  const occupied = createServer();
  await listen(occupied);
  t.after(() => close(occupied));
  const port = occupied.address().port;
  let journalCloseCount = 0;
  let providerDestroyCount = 0;

  await assert.rejects(
    startCheckpointAttestorService(config(port), {
      createProvider: () => ({ destroy() { providerDestroyCount += 1; } }),
      openJournal: async () => ({
        async record() {},
        async close() { journalCloseCount += 1; },
      }),
    }),
    (error) => error?.code === "EADDRINUSE",
  );
  assert.equal(journalCloseCount, 1);
  assert.equal(providerDestroyCount, 1);
});

test("attestor service close is idempotent and releases every owned resource", async () => {
  let journalCloseCount = 0;
  let providerDestroyCount = 0;
  const service = await startCheckpointAttestorService(config(0), {
    createProvider: () => ({ destroy() { providerDestroyCount += 1; } }),
    openJournal: async () => ({
      async record() {},
      async close() { journalCloseCount += 1; },
    }),
  });
  assert.equal(service.server.listening, true);
  await Promise.all([service.close(), service.close()]);
  assert.equal(service.server.listening, false);
  assert.equal(journalCloseCount, 1);
  assert.equal(providerDestroyCount, 1);
});
