import { createServer } from "node:http";

const MAX_BODY_BYTES = 64 * 1024;

export function createAttestorHttpServer({ attestor, token, logger = console }) {
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        return json(response, 200, { status: "ok", signer: attestor.signerAddress });
      }
      if (request.method !== "POST" || request.url !== "/v1/attest") {
        return json(response, 404, { error: "not_found" });
      }
      if (token && request.headers.authorization !== `Bearer ${token}`) {
        return json(response, 401, { error: "unauthorized" });
      }
      const body = await readJsonBody(request);
      const result = await attestor.attest(body);
      return json(response, 200, result);
    } catch (error) {
      const statusCode = Number(error?.statusCode || 500);
      if (statusCode >= 500) logger.error?.(`[attestor] ${error?.stack || error}`);
      return json(response, statusCode, { error: error?.message || String(error) });
    }
  });
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body is not valid JSON");
    error.statusCode = 400;
    throw error;
  }
}

function json(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}
