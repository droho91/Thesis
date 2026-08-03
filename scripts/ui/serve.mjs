import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { waitForBesuRuntimeReady } from "../ops/besu/runtime.mjs";
import {
  createInstitutionalApiSecurity,
  handleInstitutionalApi,
  sendJson,
} from "./api.mjs";
import { prepareRuntime, shutdownRuntime } from "./service.mjs";
import { serveStaticDemo } from "./static-server.mjs";

const LOOPBACK_HOST = "127.0.0.1";
const root = resolve(process.cwd(), "demo");

export async function startInstitutionalUi({
  staticRoot = root,
  port = parsePort(process.env.DEMO_UI_PORT || "5173"),
  preflight = process.env.DEMO_UI_PREFLIGHT !== "false",
  preflightTimeoutMs = parsePositiveInteger(
    process.env.DEMO_UI_PREFLIGHT_TIMEOUT_MS || "90000",
    "DEMO_UI_PREFLIGHT_TIMEOUT_MS",
  ),
  waitForRuntimeReady = waitForBesuRuntimeReady,
  prepare = prepareRuntime,
  shutdown = shutdownRuntime,
  serviceAdapter,
  logger = console,
} = {}) {
  let ready = false;
  let security = null;

  const server = createServer((request, response) => {
    void routeRequest(request, response).catch((error) => {
      logger.error?.(`[institutional-ui] request failed: ${error.message || String(error)}`);
      sendJson(
        response,
        error.statusCode || 500,
        error.payload || { ok: false, error: "Internal UI server error" },
      );
    });
  });

  async function routeRequest(request, response) {
    if (!ready || !security) {
      return sendJson(response, 503, { ok: false, error: "Institutional UI is starting" });
    }
    security.assertExpectedHost(request);
    const url = requestUrl(request, security.expectedOrigin);
    if (!url) return sendJson(response, 400, { ok: false, error: "Invalid request target" });
    if (url.pathname.startsWith("/api/")) {
      return handleInstitutionalApi(request, response, url, { security, serviceAdapter });
    }
    return serveStaticDemo(staticRoot, request, response, url);
  }

  try {
    await listen(server, port, LOOPBACK_HOST);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("UI server did not expose a TCP address");
    const origin = `http://${LOOPBACK_HOST}:${address.port}`;
    security = createInstitutionalApiSecurity({ expectedOrigin: origin });

    if (preflight) {
      logger.log?.("[institutional-ui] checking bank-chain runtime");
      await waitForRuntimeReady({ timeoutMs: preflightTimeoutMs });
      logger.log?.("[institutional-ui] starting attestors and automatic relay");
      await prepare();
    }
    ready = true;

    let closingPromise = null;
    return Object.freeze({
      server,
      origin,
      close() {
        if (!closingPromise) {
          ready = false;
          closingPromise = closeUiResources({ server, shutdown });
        }
        return closingPromise;
      },
    });
  } catch (startError) {
    ready = false;
    try {
      await closeUiResources({ server, shutdown });
    } catch (cleanupError) {
      const cleanupErrors = cleanupError instanceof AggregateError
        ? cleanupError.errors
        : [cleanupError];
      throw new AggregateError(
        [startError, ...cleanupErrors],
        "UI startup and cleanup failed",
      );
    }
    throw startError;
  }
}

export function requestUrl(request, expectedOrigin) {
  if (typeof request.url !== "string" || !request.url.startsWith("/") || request.url.startsWith("//")) {
    return null;
  }
  try {
    const parsed = new URL(request.url, expectedOrigin);
    return parsed.origin === expectedOrigin ? parsed : null;
  } catch {
    return null;
  }
}

export function listen(server, port, host = LOOPBACK_HOST) {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export function closeServer(server) {
  return new Promise((resolveClose, rejectClose) => {
    if (!server.listening) return resolveClose();
    server.close((error) => error ? rejectClose(error) : resolveClose());
    server.closeIdleConnections?.();
  });
}

export async function closeUiResources({ server, shutdown, close = closeServer }) {
  const results = await Promise.allSettled([
    close(server),
    Promise.resolve().then(() => shutdown()),
  ]);
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "UI server and runtime cleanup both failed");
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("DEMO_UI_PORT must be an integer from 1 to 65535");
  }
  return port;
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

async function main() {
  const controller = await startInstitutionalUi();
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await controller.close();
    } catch (error) {
      console.error(`[institutional-ui] shutdown failed: ${error.message}`);
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  console.log(`[institutional-ui] ${controller.origin}/`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    if (error.code === "EADDRINUSE") {
      console.error("[institutional-ui] configured port is already in use; set DEMO_UI_PORT to another port");
    } else {
      console.error(`[institutional-ui] ${error.message}`);
      console.error("Run npm run demo:prepare, then start the UI again.");
    }
    process.exitCode = 1;
  });
}
