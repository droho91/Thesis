import { createServer } from "node:http";
import { resolve } from "node:path";
import { normalizeRuntime } from "./besu-runtime.mjs";
import { handleDemoApi } from "./demo-api.mjs";
import { serveStaticDemo } from "./demo-static-server.mjs";

const root = resolve(process.cwd(), "demo");
const port = Number(process.env.DEMO_UI_PORT || 5173);

export function startDemoUi() {
  const activeRuntime = normalizeRuntime();
  if (!activeRuntime.besuFirst) {
    throw new Error("serve-demo-ui.mjs is a canonical Besu-first UI entrypoint.");
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) return await handleDemoApi(req, res, url);
    return serveStaticDemo(root, req, res);
  });

  server.on("error", (error) => {
    console.error(`Could not start demo UI on 127.0.0.1:${port}: ${error.message}`);
    process.exit(1);
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`Demo UI: http://127.0.0.1:${port}/`);
  });
}

startDemoUi();
