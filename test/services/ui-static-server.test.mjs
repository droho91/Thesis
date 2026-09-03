import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";
import { serveStaticDemo } from "../../scripts/ui/static-server.mjs";

let root;
let server;
let origin;
let streamFailure = null;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "institutional-static-test-"));
  await writeFile(join(root, "index.html"), "<h1>Institutional UI</h1>\n");
  server = createServer((request, response) => {
    const url = new URL(request.url, origin);
    const options = streamFailure ? { createFileStream: () => faultyStream(streamFailure) } : {};
    void serveStaticDemo(root, request, response, url, options);
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  await rm(root, { recursive: true, force: true });
});

test("static server supports GET and HEAD with explicit no-store metadata", async () => {
  const get = await send({ method: "GET", path: "/" });
  assert.equal(get.statusCode, 200);
  assert.equal(get.body, "<h1>Institutional UI</h1>\n");
  assert.equal(get.headers["cache-control"], "no-store");
  assert.equal(get.headers["x-content-type-options"], "nosniff");
  assert.match(get.headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.match(get.headers["content-security-policy"], /script-src 'self'(?:;|$)/);
  assert.doesNotMatch(get.headers["content-security-policy"], /script-src[^;]*unsafe-inline/);
  assert.equal(get.headers["x-frame-options"], "DENY");

  const head = await send({ method: "HEAD", path: "/index.html" });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, "");
  assert.equal(head.headers["content-length"], String(Buffer.byteLength(get.body)));
});

test("static server refuses a symbolic-link escape from the demo root", async (t) => {
  const outside = join(tmpdir(), `institutional-static-outside-${process.pid}.txt`);
  await writeFile(outside, "private runtime material\n", "utf8");
  t.after(() => rm(outside, { force: true }));
  try {
    await symlink(outside, join(root, "outside.txt"));
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error?.code)) {
      t.skip("symbolic-link creation is not permitted on this host");
      return;
    }
    throw error;
  }

  const response = await send({ method: "GET", path: "/outside.txt" });
  assert.equal(response.statusCode, 403);
  assert.equal(response.body, "Forbidden");
});

test("static server rejects unsupported methods and lexical traversal", async () => {
  const post = await send({ method: "POST", path: "/index.html" });
  assert.equal(post.statusCode, 405);
  assert.equal(post.headers.allow, "GET, HEAD");

  const traversal = await send({ method: "GET", path: "/..%2Foutside.txt" });
  assert.equal(traversal.statusCode, 403);
});

test("an asset open failure returns 404 without crashing the server", async () => {
  streamFailure = "before-open";
  const failed = await send({ method: "GET", path: "/index.html" });
  assert.equal(failed.statusCode, 404);
  assert.equal(failed.body, "Not found");

  streamFailure = null;
  const recovered = await send({ method: "GET", path: "/index.html" });
  assert.equal(recovered.statusCode, 200);
});

test("a read failure after headers destroys only that response and the server remains usable", async () => {
  streamFailure = "after-open";
  const failed = await send({ method: "GET", path: "/index.html", tolerateAbort: true });
  assert.equal(failed.statusCode, 200);
  assert.equal(failed.aborted, true);

  streamFailure = null;
  const recovered = await send({ method: "GET", path: "/index.html" });
  assert.equal(recovered.statusCode, 200);
  assert.match(recovered.body, /Institutional UI/);
});

function faultyStream(mode) {
  const stream = new Readable({
    read() {
      if (mode !== "after-open" || this.started) return;
      this.started = true;
      this.push("partial");
      setImmediate(() => this.destroy(new Error("injected read failure")));
    },
  });
  queueMicrotask(() => {
    if (mode === "before-open") stream.destroy(new Error("injected open failure"));
    else stream.emit("open", 1);
  });
  return stream;
}

function send({ method, path, tolerateAbort = false }) {
  return new Promise((resolveRequest, rejectRequest) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolveRequest(value);
    };
    const request = httpRequest(`${origin}${path}`, { method }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => finish({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
        aborted: false,
      }));
      response.on("aborted", () => {
        if (!tolerateAbort) return rejectRequest(new Error("response aborted"));
        finish({
          statusCode: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
          aborted: true,
        });
      });
      response.on("error", (error) => {
        if (!tolerateAbort) rejectRequest(error);
      });
    });
    request.on("error", (error) => {
      if (tolerateAbort) finish({ statusCode: null, headers: {}, body: "", aborted: true });
      else rejectRequest(error);
    });
    request.end();
  });
}
