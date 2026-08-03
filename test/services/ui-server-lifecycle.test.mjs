import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { closeUiResources, startInstitutionalUi } from "../../scripts/ui/serve.mjs";

const silentLogger = { log() {}, error() {} };
const serviceAdapter = {
  async healthPayload() { return { ok: true }; },
  async statusPayload() { return { ready: true }; },
  async tracePayload() { return { activity: [] }; },
  async evidencePayload() { return { available: false }; },
  async runActionPayload() { return { statusCode: 200, body: { ok: true } }; },
};

test("an occupied UI port fails before runtime preparation starts", async () => {
  const blocker = createServer((_request, response) => response.end("occupied"));
  await listen(blocker, 0);
  const port = blocker.address().port;
  let prepareCalls = 0;
  let shutdownCalls = 0;

  await assert.rejects(
    startInstitutionalUi({
      port,
      preflight: true,
      waitForRuntimeReady: async () => {},
      prepare: async () => { prepareCalls += 1; },
      shutdown: async () => { shutdownCalls += 1; },
      serviceAdapter,
      logger: silentLogger,
    }),
    (error) => error?.code === "EADDRINUSE",
  );
  assert.equal(prepareCalls, 0);
  assert.equal(shutdownCalls, 1);
  await close(blocker);
});

test("startup failure closes the reserved HTTP listener and runs cleanup", async () => {
  let shutdownCalls = 0;
  await assert.rejects(
    startInstitutionalUi({
      port: 0,
      preflight: true,
      waitForRuntimeReady: async () => {},
      prepare: async () => { throw new Error("partial runtime initialization failed"); },
      shutdown: async () => { shutdownCalls += 1; },
      serviceAdapter,
      logger: silentLogger,
    }),
    /partial runtime initialization failed/,
  );
  assert.equal(shutdownCalls, 1);
});

test("startup and cleanup failures are both preserved", async () => {
  const startFailure = new Error("injected runtime startup failure");
  const cleanupFailure = new Error("injected runtime cleanup failure");
  await assert.rejects(
    startInstitutionalUi({
      port: 0,
      preflight: true,
      waitForRuntimeReady: async () => {},
      prepare: async () => { throw startFailure; },
      shutdown: async () => { throw cleanupFailure; },
      serviceAdapter,
      logger: silentLogger,
    }),
    (error) => error instanceof AggregateError
      && error.errors.includes(startFailure)
      && error.errors.includes(cleanupFailure),
  );
});

test("UI shutdown is idempotent and releases runtime resources once", async () => {
  let shutdownCalls = 0;
  const controller = await startInstitutionalUi({
    port: 0,
    preflight: false,
    shutdown: async () => { shutdownCalls += 1; },
    serviceAdapter,
    logger: silentLogger,
  });
  assert.equal(controller.server.listening, true);
  await Promise.all([controller.close(), controller.close()]);
  assert.equal(controller.server.listening, false);
  assert.equal(shutdownCalls, 1);
});

test("runtime cleanup still runs when closing the HTTP server fails", async () => {
  const closeFailure = new Error("injected HTTP close failure");
  let shutdownCalls = 0;
  await assert.rejects(
    closeUiResources({
      server: {},
      close: async () => { throw closeFailure; },
      shutdown: async () => { shutdownCalls += 1; },
    }),
    (error) => error === closeFailure,
  );
  assert.equal(shutdownCalls, 1);
});

test("dual cleanup failures are preserved in an AggregateError", async () => {
  const closeFailure = new Error("injected HTTP close failure");
  const runtimeFailure = new Error("injected runtime close failure");
  await assert.rejects(
    closeUiResources({
      server: {},
      close: async () => { throw closeFailure; },
      shutdown: async () => { throw runtimeFailure; },
    }),
    (error) => error instanceof AggregateError
      && error.errors.includes(closeFailure)
      && error.errors.includes(runtimeFailure),
  );
});

function listen(server, port) {
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
