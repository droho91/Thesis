import { createServer } from "node:http";
import { resolve } from "node:path";
import {
  CHAIN_A_RPC,
  CHAIN_B_RPC,
  normalizeRuntime,
  providerForRpc,
  waitForBesuRuntimeReady,
  waitForProviderBlockHeight,
} from "./besu-runtime.mjs";
import { handleDemoApi } from "./demo-api.mjs";
import { serveStaticDemo } from "./demo-static-server.mjs";

const root = resolve(process.cwd(), "demo");
const port = Number(process.env.DEMO_UI_PORT || 5173);
const uiPreflightTimeoutMs = Number(process.env.DEMO_UI_PREFLIGHT_TIMEOUT_MS || 60000);

async function assertDemoRuntimeReady() {
  if (process.env.DEMO_UI_PREFLIGHT === "false") return;

  console.log("[preflight] Checking Besu runtime before serving demo UI...");
  await waitForBesuRuntimeReady({ timeoutMs: uiPreflightTimeoutMs });
  await Promise.all([
    waitForProviderBlockHeight(providerForRpc(CHAIN_A_RPC), 1n, {
      label: "Bank A",
      timeoutMs: uiPreflightTimeoutMs,
    }),
    waitForProviderBlockHeight(providerForRpc(CHAIN_B_RPC), 1n, {
      label: "Bank B",
      timeoutMs: uiPreflightTimeoutMs,
    }),
  ]);
}

export async function startDemoUi() {
  const activeRuntime = normalizeRuntime();
  if (!activeRuntime.besuFirst) {
    throw new Error("serve-demo-ui.mjs is a canonical Besu-first UI entrypoint.");
  }

  await assertDemoRuntimeReady();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) return await handleDemoApi(req, res, url);
    return serveStaticDemo(root, req, res);
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Could not start demo UI on 127.0.0.1:${port}: another process is already using that port.`);
      console.error("Stop the existing demo UI terminal with Ctrl+C, or set DEMO_UI_PORT to another port before starting.");
      process.exit(1);
    }
    console.error(`Could not start demo UI on 127.0.0.1:${port}: ${error.message}`);
    process.exit(1);
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`Demo UI: http://127.0.0.1:${port}/`);
  });
}

startDemoUi().catch((error) => {
  console.error(`Could not start demo UI because the Besu runtime is not ready: ${error.message}`);
  console.error("Run npm run besu:up and wait until it prints that the Besu runtime is ready, then start npm run demo:ui again.");
  process.exit(1);
});
