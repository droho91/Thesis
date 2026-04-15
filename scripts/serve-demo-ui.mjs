import { createReadStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { readDemoStatus, runDemoAction } from "./ibc-lite-demo-actions.mjs";

const root = resolve(process.cwd(), "demo");
const port = Number(process.env.DEMO_UI_PORT || 5173);
const tracePath = resolve(root, "latest-run.json");
const configPath = resolve(process.cwd(), ".ibc-lite.local.json");
const npm = "npm";

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

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function runEnv() {
  const temp = process.env.TMPDIR || process.env.TEMP || process.env.TMP || "/tmp";
  return {
    ...process.env,
    TMPDIR: temp,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || resolve(temp, ".cache"),
  };
}

function runCommand(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: runEnv(),
      shell: process.platform === "win32",
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      rejectRun(new Error(`${command} ${args.join(" ")} could not start: ${error.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) return resolveRun(output);
      rejectRun(new Error(`${command} ${args.join(" ")} failed with exit code ${code}\n${output}`));
    });
  });
}

async function readTrace() {
  try {
    return JSON.parse(await readFile(tracePath, "utf8"));
  } catch {
    return null;
  }
}

async function hasDeploymentConfig() {
  try {
    await access(configPath);
    return true;
  } catch {
    return false;
  }
}

async function deployAndSeed() {
  const deploy = await runCommand(npm, ["run", "deploy:ibc-lite"]);
  const seed = await runCommand(npm, ["run", "seed:ibc-lite"]);
  return `${deploy}\n${seed}`;
}

async function runFlowWithRecovery() {
  let output = "";

  if (!(await hasDeploymentConfig())) {
    output += "[controller] No .ibc-lite.local.json found. Deploying and seeding first.\n";
    output += await deployAndSeed();
    output += "\n";
  }

  try {
    output += await runCommand(npm, ["run", "demo:flow"]);
    return { ok: true, output };
  } catch (firstError) {
    output += "\n[controller] First flow attempt failed.\n";
    output += `${firstError.message}\n`;
    output += "\n[controller] Redeploying a fresh local IBC-lite stack, seeding balances, and retrying once.\n";

    try {
      output += await deployAndSeed();
      output += "\n";
      output += await runCommand(npm, ["run", "demo:flow"]);
      return { ok: true, output, recovered: true };
    } catch (secondError) {
      output += "\n[controller] Retry failed.\n";
      output += secondError.message;
      return { ok: false, output, error: "Contract flow failed after automatic redeploy + seed retry." };
    }
  }
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, 200, {
        ok: true,
        platform: process.platform,
        cwd: process.cwd(),
        hasDeploymentConfig: await hasDeploymentConfig(),
        trace: await readTrace(),
      });
    }

    if (req.method === "GET" && url.pathname === "/api/trace") {
      return sendJson(res, 200, { trace: await readTrace() });
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      return sendJson(res, 200, await readDemoStatus());
    }

    if (req.method === "POST" && url.pathname === "/api/deploy-seed") {
      const output = await deployAndSeed();
      return sendJson(res, 200, { ok: true, output, trace: await readTrace(), status: await readDemoStatus() });
    }

    if (req.method === "POST" && url.pathname === "/api/action") {
      const body = await readRequestJson(req);
      const result = await runDemoAction(body.action);
      return sendJson(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/api/run-flow") {
      const result = await runFlowWithRecovery();
      return sendJson(res, result.ok ? 200 : 500, { ...result, trace: await readTrace() });
    }

    sendJson(res, 404, { ok: false, error: "Unknown API endpoint" });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message, output: error.message });
  }
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

async function fileForRequest(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const file = resolve(root, `.${pathname}`);
  if (!(file === root || file.startsWith(`${root}${sep}`))) return null;
  const info = await stat(file);
  return info.isDirectory() ? resolve(file, "index.html") : file;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    const file = await fileForRequest(req);
    if (!file) return sendText(res, 403, "Forbidden");
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
    createReadStream(file).pipe(res);
  } catch {
    sendText(res, 404, "Not found");
  }
});

server.on("error", (error) => {
  console.error(`Could not start demo UI on 127.0.0.1:${port}: ${error.message}`);
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Demo UI: http://127.0.0.1:${port}/`);
});
