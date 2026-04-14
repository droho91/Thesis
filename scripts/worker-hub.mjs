import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const workers = [
  { name: "header-relayer", args: ["scripts/header-relayer.mjs"] },
  { name: "proof-relayer", args: ["scripts/proof-relayer.mjs"] },
  { name: "risk-watcher", args: ["scripts/risk-watcher.mjs"] },
];

const children = [];

function pipeWithPrefix(stream, prefix) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      console.log(`[${prefix}] ${line}`);
    }
  });
}

for (const worker of workers) {
  const child = spawn(process.execPath, worker.args, {
    cwd: rootDir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  children.push(child);
  pipeWithPrefix(child.stdout, worker.name);
  pipeWithPrefix(child.stderr, `${worker.name}:err`);

  child.on("exit", (code, signal) => {
    console.log(`[${worker.name}] exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
  });
}

function shutdown() {
  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
  setTimeout(() => process.exit(0), 200);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("worker-hub started: header-relayer, proof-relayer, risk-watcher");
console.log("Press Ctrl+C to stop all workers.");
