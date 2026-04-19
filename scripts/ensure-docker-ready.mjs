import { spawn } from "node:child_process";

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
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
      resolve({ ok: false, output: error.message });
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, output });
    });
  });
}

const result = await run("docker", ["version", "--format", "{{.Server.Version}}"]);
if (!result.ok) {
  console.error("[docker] Docker daemon is not reachable.");
  console.error("Open Docker Desktop and wait until it says it is running, then rerun:");
  console.error("  npm run besu:up");
  console.error("");
  console.error("Original Docker output:");
  console.error(result.output.trim() || "(no output)");
  process.exit(1);
}

console.log(`[docker] Docker daemon ready (server ${result.output.trim()}).`);
