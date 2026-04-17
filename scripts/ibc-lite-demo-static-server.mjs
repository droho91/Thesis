import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

// Static demo asset serving stays separate from API routing so the UI shell remains thin.
const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

async function fileForRequest(root, req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const file = resolve(root, `.${pathname}`);
  if (!(file === root || file.startsWith(`${root}${sep}`))) return null;
  const info = await stat(file);
  return info.isDirectory() ? resolve(file, "index.html") : file;
}

export async function serveStaticDemo(root, req, res) {
  try {
    const file = await fileForRequest(root, req);
    if (!file) return sendText(res, 403, "Forbidden");
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
    createReadStream(file).pipe(res);
    return undefined;
  } catch {
    return sendText(res, 404, "Not found");
  }
}
