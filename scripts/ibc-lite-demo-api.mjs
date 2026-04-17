import { runDemoAction } from "./ibc-lite-demo-actions.mjs";
import {
  deploySeedPayload,
  healthPayload,
  runFlowPayload,
  statusPayload,
  tracePayload,
} from "./ibc-lite-demo-service.mjs";

// Demo API router: converts HTTP requests into service/controller calls and serializes JSON responses.
function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readRequestJson(req) {
  return new Promise((resolveRead, rejectRead) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 1_000_000) {
        req.destroy();
        rejectRead(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolveRead(body ? JSON.parse(body) : {});
      } catch {
        rejectRead(new Error("Invalid JSON request body"));
      }
    });
    req.on("error", rejectRead);
  });
}

export async function handleDemoApi(req, res, url) {
  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, 200, await healthPayload());
    }

    if (req.method === "GET" && url.pathname === "/api/trace") {
      return sendJson(res, 200, await tracePayload());
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      return sendJson(res, 200, await statusPayload());
    }

    if (req.method === "POST" && url.pathname === "/api/deploy-seed") {
      return sendJson(res, 200, await deploySeedPayload());
    }

    if (req.method === "POST" && url.pathname === "/api/action") {
      const body = await readRequestJson(req);
      const result = await runDemoAction(body.action);
      return sendJson(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/api/run-flow") {
      const result = await runFlowPayload();
      return sendJson(res, result.statusCode, result.body);
    }

    return sendJson(res, 404, { ok: false, error: "Unknown API endpoint" });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: error.message, output: error.message });
  }
}
