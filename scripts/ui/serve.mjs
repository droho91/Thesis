import { createServer } from "node:http";
import { resolve } from "node:path";
import { waitForBesuRuntimeReady } from "../ops/besu/runtime.mjs";
import { handleInstitutionalApi } from "./api.mjs";
import { prepareRuntime, shutdownRuntime } from "./service.mjs";
import { serveStaticDemo } from "./static-server.mjs";

const root = resolve(process.cwd(), "demo");
const port = Number(process.env.DEMO_UI_PORT || 5173);
const preflightTimeoutMs = Number(process.env.DEMO_UI_PREFLIGHT_TIMEOUT_MS || 90_000);

async function main() {
  if (process.env.DEMO_UI_PREFLIGHT !== "false") {
    console.log("[institutional-ui] checking bank-chain runtime");
    await waitForBesuRuntimeReady({ timeoutMs: preflightTimeoutMs });
    console.log("[institutional-ui] starting attestors and automatic relay");
    await prepareRuntime();
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
      if (url.pathname.startsWith("/api/")) return handleInstitutionalApi(request, response, url);
      return serveStaticDemo(root, request, response);
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    }
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`[institutional-ui] port ${port} is already in use; set DEMO_UI_PORT to another port`);
    } else {
      console.error(`[institutional-ui] ${error.message}`);
    }
    process.exitCode = 1;
  });

  const shutdown = async () => {
    server.close();
    await shutdownRuntime();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  server.listen(port, "127.0.0.1", () => {
    console.log(`[institutional-ui] http://127.0.0.1:${port}/`);
  });
}

main().catch((error) => {
  console.error(`[institutional-ui] ${error.message}`);
  console.error("Run npm run demo:prepare, then start the UI again.");
  process.exitCode = 1;
});
