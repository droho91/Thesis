import * as service from "./service.mjs";

export async function handleInstitutionalApi(request, response, url) {
  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      const payload = await service.healthPayload();
      return sendJson(response, payload.ok ? 200 : 503, payload);
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      return sendJson(response, 200, await service.statusPayload());
    }
    if (request.method === "GET" && url.pathname === "/api/trace") {
      return sendJson(response, 200, await service.tracePayload());
    }
    if (request.method === "POST" && url.pathname === "/api/action") {
      const result = await service.runActionPayload(await readRequestJson(request));
      return sendJson(response, result.statusCode, result.body);
    }
    return sendJson(response, 404, { ok: false, error: "Unknown institutional API endpoint" });
  } catch (error) {
    return sendJson(
      response,
      error.statusCode || 500,
      error.payload || { ok: false, error: error.message || String(error) },
    );
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function readRequestJson(request) {
  return new Promise((resolveRead, rejectRead) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 64 * 1024) {
        rejectRead(Object.assign(new Error("Request body is too large"), { statusCode: 413 }));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolveRead(body ? JSON.parse(body) : {});
      } catch {
        rejectRead(Object.assign(new Error("Invalid JSON request body"), { statusCode: 400 }));
      }
    });
    request.on("error", rejectRead);
  });
}
