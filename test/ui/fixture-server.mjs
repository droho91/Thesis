import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { serveStaticDemo } from "../../scripts/ui/static-server.mjs";
import { evidenceFixture, statusFixture } from "./fixture-data.mjs";
import { fixtureHost, fixtureOrigin, fixturePort } from "./fixture-environment.mjs";

const demoRoot = fileURLToPath(new URL("../../demo/", import.meta.url));

function sendJson(response, statusCode, payload, additionalHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...additionalHeaders,
  });
  response.end(body);
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url || "/", fixtureOrigin);
  if (request.method === "GET" && requestUrl.pathname === "/api/status") {
    return sendJson(response, 200, statusFixture);
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/evidence") {
    return sendJson(response, 200, evidenceFixture);
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/session") {
    return sendJson(response, 200, { csrfToken: "phase7_ui_fixture_token_0000000000000000" });
  }
  if (["/api/status", "/api/evidence", "/api/session"].includes(requestUrl.pathname)) {
    return sendJson(response, 405, { error: "Method not allowed." }, { allow: "GET" });
  }
  if (requestUrl.pathname === "/api/action") {
    if (request.method !== "POST") {
      return sendJson(response, 405, { error: "Method not allowed." }, { allow: "POST" });
    }
    return sendJson(response, 501, { error: "Synthetic UI fixtures never execute financial actions." });
  }
  if (requestUrl.pathname.startsWith("/api/")) {
    return sendJson(response, 404, { error: "Fixture API route not found." });
  }

  try {
    return await serveStaticDemo(demoRoot, request, response, requestUrl);
  } catch (error) {
    if (!response.headersSent) return sendJson(response, 500, { error: error.message });
    response.destroy(error);
    return undefined;
  }
});

server.listen(fixturePort, fixtureHost, () => {
  process.stdout.write(`Phase 7 UI fixture listening on ${fixtureOrigin}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
