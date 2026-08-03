import { randomBytes, timingSafeEqual } from "node:crypto";
import * as service from "./service.mjs";

const SESSION_COOKIE = "institutional_ui_session";
const CSRF_HEADER = "x-institutional-csrf-token";
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const DEFAULT_MAX_SESSIONS = 128;
const MAX_REQUEST_BYTES = 64 * 1_024;

export function createInstitutionalApiSecurity({
  expectedOrigin,
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  maxSessions = DEFAULT_MAX_SESSIONS,
  now = Date.now,
  randomToken = () => randomBytes(32).toString("base64url"),
} = {}) {
  const origin = normalizeExpectedOrigin(expectedOrigin);
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs <= 0) {
    throw new TypeError("sessionTtlMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxSessions) || maxSessions <= 0) {
    throw new TypeError("maxSessions must be a positive safe integer");
  }

  const sessions = new Map();

  function assertExpectedHost(request) {
    const host = singleHeader(request, "host");
    if (host !== origin.host) {
      throw httpError(421, "HOST_MISMATCH", "Request Host does not match the loopback UI origin");
    }
  }

  function assertSameOriginMetadata(request, { requireOrigin = false } = {}) {
    assertExpectedHost(request);
    const requestOrigin = singleHeader(request, "origin");
    if (requireOrigin && !requestOrigin) {
      throw httpError(403, "ORIGIN_REQUIRED", "A same-origin Origin header is required");
    }
    if (requestOrigin && normalizedRequestOrigin(requestOrigin) !== origin.origin) {
      throw httpError(403, "ORIGIN_MISMATCH", "Cross-origin UI request rejected");
    }
    if (singleHeader(request, "sec-fetch-site") !== "same-origin") {
      throw httpError(403, "FETCH_SITE_REJECTED", "Request must originate from the same UI origin");
    }
  }

  function bootstrap(request) {
    assertSameOriginMetadata(request);
    evictExpiredSessions();

    const currentSessionId = sessionIdFromRequest(request);
    let session = currentSessionId ? sessions.get(currentSessionId) : null;
    const timestamp = now();
    if (!session || session.expiresAt <= timestamp) {
      if (currentSessionId) sessions.delete(currentSessionId);
      session = {
        id: requireRandomToken(randomToken(), "session identifier"),
        csrfToken: requireRandomToken(randomToken(), "CSRF token"),
        createdAt: timestamp,
        expiresAt: timestamp + sessionTtlMs,
      };
      sessions.set(session.id, session);
      evictOverflowSessions();
    }

    return {
      csrfToken: session.csrfToken,
      cookie: serializeSessionCookie(session.id, sessionTtlMs, origin.protocol === "https:"),
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  function authorizeMutation(request) {
    assertSameOriginMetadata(request, { requireOrigin: true });
    if (mediaType(singleHeader(request, "content-type")) !== "application/json") {
      throw httpError(415, "JSON_CONTENT_TYPE_REQUIRED", "Content-Type must be application/json");
    }

    evictExpiredSessions();
    const sessionId = sessionIdFromRequest(request);
    const session = sessionId ? sessions.get(sessionId) : null;
    if (!session) {
      throw httpError(403, "CSRF_SESSION_INVALID", "A valid UI session is required");
    }

    const candidate = singleHeader(request, CSRF_HEADER);
    if (!candidate || !constantTimeEqual(candidate, session.csrfToken)) {
      throw httpError(403, "CSRF_TOKEN_INVALID", "CSRF token validation failed");
    }

    session.expiresAt = now() + sessionTtlMs;
    return session;
  }

  function evictExpiredSessions() {
    const timestamp = now();
    for (const [id, session] of sessions) {
      if (session.expiresAt <= timestamp) sessions.delete(id);
    }
  }

  function evictOverflowSessions() {
    while (sessions.size > maxSessions) {
      const oldest = sessions.keys().next().value;
      sessions.delete(oldest);
    }
  }

  return Object.freeze({
    expectedOrigin: origin.origin,
    expectedHost: origin.host,
    assertExpectedHost,
    bootstrap,
    authorizeMutation,
  });
}

export async function handleInstitutionalApi(request, response, url, {
  security,
  serviceAdapter = service,
} = {}) {
  try {
    if (!security) throw httpError(500, "API_SECURITY_NOT_CONFIGURED", "API security is not configured");
    security.assertExpectedHost(request);

    if (request.method === "GET" && url.pathname === "/api/session") {
      const session = security.bootstrap(request);
      return sendJson(response, 200, {
        ok: true,
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt,
      }, { "set-cookie": session.cookie });
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      const payload = await serviceAdapter.healthPayload();
      return sendJson(response, payload.ok ? 200 : 503, payload);
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      return sendJson(response, 200, await serviceAdapter.statusPayload());
    }
    if (request.method === "GET" && url.pathname === "/api/trace") {
      return sendJson(response, 200, await serviceAdapter.tracePayload());
    }
    if (request.method === "GET" && url.pathname === "/api/evidence") {
      return sendJson(response, 200, await serviceAdapter.evidencePayload());
    }
    if (request.method === "POST" && url.pathname === "/api/action") {
      security.authorizeMutation(request);
      const result = await serviceAdapter.runActionPayload(await readRequestJson(request));
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

export function sendJson(response, statusCode, payload, additionalHeaders = {}) {
  if (response.destroyed || response.writableEnded) return false;
  if (response.headersSent) {
    response.destroy(new Error("Cannot replace an API response after headers were sent"));
    return false;
  }
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    pragma: "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...additionalHeaders,
  });
  response.end(`${JSON.stringify(payload)}\n`);
  return true;
}

export function readRequestJson(request) {
  return new Promise((resolveRead, rejectRead) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;

    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
      callback(value);
    };
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_REQUEST_BYTES) {
        settle(rejectRead, httpError(413, "REQUEST_TOO_LARGE", "Request body is too large"));
        request.resume();
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (!body.trim()) {
        settle(rejectRead, httpError(400, "JSON_BODY_REQUIRED", "JSON request body is required"));
        return;
      }
      try {
        const parsed = JSON.parse(body);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
          settle(rejectRead, httpError(400, "JSON_OBJECT_REQUIRED", "JSON request body must be an object"));
          return;
        }
        settle(resolveRead, parsed);
      } catch {
        settle(rejectRead, httpError(400, "INVALID_JSON", "Invalid JSON request body"));
      }
    };
    const onAborted = () => settle(rejectRead, httpError(400, "REQUEST_ABORTED", "Request body was aborted"));
    const onError = (error) => settle(rejectRead, error);

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
  });
}

function normalizeExpectedOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("expectedOrigin must be an absolute HTTP(S) origin");
  }
  if (!["http:", "https:"].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash) {
    throw new TypeError("expectedOrigin must be an absolute HTTP(S) origin without path, credentials, query or fragment");
  }
  return parsed;
}

function normalizedRequestOrigin(value) {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function singleHeader(request, name) {
  const value = request.headers[name];
  if (typeof value !== "string" || value.includes(",")) return "";
  return value.trim();
}

function mediaType(value) {
  return value.split(";", 1)[0].trim().toLowerCase();
}

function sessionIdFromRequest(request) {
  const header = singleHeader(request, "cookie");
  if (!header) return null;
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE}=`))
    .map((part) => part.slice(SESSION_COOKIE.length + 1));
  return values.length === 1 && /^[A-Za-z0-9_-]{32,128}$/.test(values[0]) ? values[0] : null;
}

function serializeSessionCookie(sessionId, ttlMs, secure) {
  const attributes = [
    `${SESSION_COOKIE}=${sessionId}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.max(1, Math.floor(ttlMs / 1_000))}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

function requireRandomToken(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(value)) {
    throw new TypeError(`${label} generator returned an invalid value`);
  }
  return value;
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function httpError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.payload = { ok: false, code, error: message };
  return error;
}
