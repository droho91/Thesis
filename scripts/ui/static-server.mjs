import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";

// Static demo asset serving stays separate from API routing so the UI shell remains thin.
const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const noStoreHeaders = {
  "cache-control": "no-store",
  pragma: "no-cache",
  // Dynamic progress and health meters set numeric widths at runtime. Permit
  // inline CSS for those values while keeping executable scripts same-origin.
  "content-security-policy": "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), geolocation=(), microphone=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function sendText(response, statusCode, body, additionalHeaders = {}) {
  if (response.destroyed || response.writableEnded) return false;
  if (response.headersSent) {
    response.destroy(new Error("Cannot replace a static response after headers were sent"));
    return false;
  }
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    ...noStoreHeaders,
    ...additionalHeaders,
  });
  response.end(body);
  return true;
}

async function fileForRequest(root, requestUrl) {
  const pathname = decodeURIComponent(requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname);
  const canonicalRoot = await realpath(root);
  const requestedFile = resolve(canonicalRoot, `.${pathname}`);
  if (!(requestedFile === canonicalRoot || requestedFile.startsWith(`${canonicalRoot}${sep}`))) return null;

  // A lexical prefix check alone follows a repository symlink outside the UI
  // root. Resolve the actual target before opening it and apply the boundary a
  // second time so only assets physically rooted below demo/ can be served.
  let file = await realpath(requestedFile);
  if (!(file === canonicalRoot || file.startsWith(`${canonicalRoot}${sep}`))) return null;
  let info = await stat(file);
  if (!info.isDirectory()) return { file, info };
  file = await realpath(resolve(file, "index.html"));
  if (!file.startsWith(`${canonicalRoot}${sep}`)) return null;
  info = await stat(file);
  return { file, info };
}

export async function serveStaticDemo(root, request, response, requestUrl, {
  createFileStream = createReadStream,
} = {}) {
  if (!requestUrl || !(requestUrl instanceof URL)) {
    return sendText(response, 400, "Invalid request target");
  }
  if (!["GET", "HEAD"].includes(request.method)) {
    return sendText(response, 405, "Method not allowed", { allow: "GET, HEAD" });
  }

  let asset;
  try {
    asset = await fileForRequest(resolve(root), requestUrl);
  } catch {
    return sendText(response, 404, "Not found");
  }
  if (!asset) return sendText(response, 403, "Forbidden");

  const headers = {
    "content-type": types[extname(asset.file)] || "application/octet-stream",
    "content-length": String(asset.info.size),
    ...noStoreHeaders,
  };
  if (request.method === "HEAD") {
    if (!response.destroyed && !response.writableEnded && !response.headersSent) {
      response.writeHead(200, headers);
      response.end();
    }
    return undefined;
  }

  const stream = createFileStream(asset.file);
  const temporaryErrorGuard = () => {};
  const closeStream = () => stream.destroy();
  stream.on("error", temporaryErrorGuard);
  response.once("close", closeStream);

  try {
    await once(stream, "open");
    if (response.destroyed || response.writableEnded) {
      stream.destroy();
      return undefined;
    }
    response.writeHead(200, headers);
    const completion = pipeline(stream, response);
    stream.off("error", temporaryErrorGuard);
    await completion;
  } catch (error) {
    if (!response.headersSent) sendText(response, 404, "Not found");
    else if (!response.destroyed) response.destroy(error);
  } finally {
    stream.off("error", temporaryErrorGuard);
    response.off("close", closeStream);
    if (!stream.destroyed) stream.destroy();
  }
  return undefined;
}
