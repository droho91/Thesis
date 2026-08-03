import assert from "node:assert/strict";
import { request as httpRequest, createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import {
  createInstitutionalApiSecurity,
  handleInstitutionalApi,
} from "../../scripts/ui/api.mjs";

let server;
let origin;
let host;
let security;
let actionCalls;

const serviceAdapter = {
  async healthPayload() { return { ok: true }; },
  async statusPayload() { return { ready: true }; },
  async tracePayload() { return { activity: [] }; },
  async evidencePayload() { return { available: false }; },
  async runActionPayload(body) {
    actionCalls.push(body);
    return { statusCode: 200, body: { ok: true, received: body } };
  },
};

before(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url, origin);
    void handleInstitutionalApi(request, response, url, { security, serviceAdapter });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  host = `127.0.0.1:${address.port}`;
  origin = `http://${host}`;
  security = createInstitutionalApiSecurity({ expectedOrigin: origin });
});

beforeEach(() => {
  actionCalls = [];
});

after(async () => {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
});

test("SPA bootstraps an HttpOnly SameSite session and submits a valid protected action", async () => {
  const session = await bootstrapSession();
  assert.equal(session.response.statusCode, 200);
  assert.match(session.setCookie, /HttpOnly/);
  assert.match(session.setCookie, /SameSite=Strict/);
  assert.match(session.setCookie, /Path=\//);
  assert.match(session.payload.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(session.response.headers["access-control-allow-origin"], undefined);

  const action = await send({
    method: "POST",
    path: "/api/action",
    headers: mutationHeaders(session),
    body: JSON.stringify({ action: "deposit", amount: "10", requestId: "request-valid" }),
  });
  assert.equal(action.statusCode, 200);
  assert.equal(action.payload.ok, true);
  assert.equal(actionCalls.length, 1);
  assert.equal(actionCalls[0].requestId, "request-valid");
});

test("cross-site simple POST is rejected before the action service is called", async () => {
  const response = await send({
    method: "POST",
    path: "/api/action",
    headers: {
      host,
      origin: "https://attacker.invalid",
      "sec-fetch-site": "cross-site",
      "content-type": "text/plain",
    },
    body: '{"action":"borrow"}',
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.payload.code, "ORIGIN_MISMATCH");
  assert.equal(actionCalls.length, 0);
});

test("same-origin simple content types cannot reach the action service", async () => {
  const session = await bootstrapSession();
  const response = await send({
    method: "POST",
    path: "/api/action",
    headers: {
      ...mutationHeaders(session),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "action=borrow",
  });
  assert.equal(response.statusCode, 415);
  assert.equal(response.payload.code, "JSON_CONTENT_TYPE_REQUIRED");
  assert.equal(actionCalls.length, 0);
});

test("a mismatched or malformed authority is rejected", async () => {
  const response = await send({
    method: "POST",
    path: "/api/action",
    headers: {
      host: "attacker.invalid",
      origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: '{"action":"borrow"}',
  });
  assert.equal(response.statusCode, 421);
  assert.equal(response.payload.code, "HOST_MISMATCH");
  assert.equal(actionCalls.length, 0);
});

test("a missing CSRF token is rejected for an otherwise valid same-origin request", async () => {
  const session = await bootstrapSession();
  const headers = mutationHeaders(session);
  delete headers["x-institutional-csrf-token"];
  const response = await send({
    method: "POST",
    path: "/api/action",
    headers,
    body: '{"action":"repay"}',
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.payload.code, "CSRF_TOKEN_INVALID");
  assert.equal(actionCalls.length, 0);
});

test("missing Fetch Metadata is rejected even with a valid Origin and token", async () => {
  const session = await bootstrapSession();
  const headers = mutationHeaders(session);
  delete headers["sec-fetch-site"];
  const response = await send({
    method: "POST",
    path: "/api/action",
    headers,
    body: '{"action":"repay"}',
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.payload.code, "FETCH_SITE_REJECTED");
  assert.equal(actionCalls.length, 0);
});

test("a mutation without an Origin header is rejected", async () => {
  const session = await bootstrapSession();
  const headers = mutationHeaders(session);
  delete headers.origin;
  const response = await send({
    method: "POST",
    path: "/api/action",
    headers,
    body: '{"action":"repay"}',
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.payload.code, "ORIGIN_REQUIRED");
  assert.equal(actionCalls.length, 0);
});

test("a CSRF token is bound to its server-side session", async () => {
  const first = await bootstrapSession();
  const second = await bootstrapSession();
  const response = await send({
    method: "POST",
    path: "/api/action",
    headers: {
      ...mutationHeaders(second),
      "x-institutional-csrf-token": first.payload.csrfToken,
    },
    body: '{"action":"withdraw"}',
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.payload.code, "CSRF_TOKEN_INVALID");
  assert.equal(actionCalls.length, 0);
});

test("malformed JSON is rejected after all request-integrity checks pass", async () => {
  const session = await bootstrapSession();
  const response = await send({
    method: "POST",
    path: "/api/action",
    headers: mutationHeaders(session),
    body: "{not-json",
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.code, "INVALID_JSON");
  assert.equal(actionCalls.length, 0);
});

test("oversized JSON is rejected without destroying the API server", async () => {
  const session = await bootstrapSession();
  const response = await send({
    method: "POST",
    path: "/api/action",
    headers: mutationHeaders(session),
    body: JSON.stringify({ action: "deposit", padding: "x".repeat(70 * 1_024) }),
  });
  assert.equal(response.statusCode, 413);
  assert.equal(response.payload.code, "REQUEST_TOO_LARGE");
  assert.equal(actionCalls.length, 0);

  const health = await send({ method: "GET", path: "/api/health", headers: { host } });
  assert.equal(health.statusCode, 200);
  assert.equal(health.payload.ok, true);
});

test("cross-site requests cannot bootstrap a readable CSRF token", async () => {
  const response = await send({
    method: "GET",
    path: "/api/session",
    headers: {
      host,
      origin: "https://attacker.invalid",
      "sec-fetch-site": "cross-site",
    },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.payload.code, "ORIGIN_MISMATCH");
  assert.equal(response.headers["set-cookie"], undefined);
});

async function bootstrapSession() {
  const response = await send({
    method: "GET",
    path: "/api/session",
    headers: { host, "sec-fetch-site": "same-origin" },
  });
  const setCookie = response.headers["set-cookie"]?.[0];
  assert.equal(typeof setCookie, "string");
  return {
    response,
    payload: response.payload,
    setCookie,
    cookie: setCookie.split(";", 1)[0],
  };
}

function mutationHeaders(session) {
  return {
    host,
    origin,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json; charset=utf-8",
    cookie: session.cookie,
    "x-institutional-csrf-token": session.payload.csrfToken,
  };
}

function send({ method, path, headers, body }) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest(`${origin}${path}`, { method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolveRequest({
          statusCode: response.statusCode,
          headers: response.headers,
          payload: text ? JSON.parse(text) : null,
        });
      });
    });
    request.on("error", rejectRequest);
    if (body != null) request.write(body);
    request.end();
  });
}
