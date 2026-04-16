import { spawn } from "node:child_process";

const script = process.argv[2];
if (!script) {
  console.error("Usage: node scripts/run-besu-command.mjs <npm-script-name>");
  process.exit(1);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const args = ["run", script];
const env = {
  ...process.env,
  USE_BESU_KEYS: process.env.USE_BESU_KEYS || "true",
  RUNTIME_MODE: process.env.RUNTIME_MODE || "besu",
  PROOF_POLICY: process.env.PROOF_POLICY || "storage-required",
  CHAIN_A_RPC: process.env.CHAIN_A_RPC || "http://127.0.0.1:8545",
  CHAIN_B_RPC: process.env.CHAIN_B_RPC || "http://127.0.0.1:9545",
};

const child = spawn(npm, args, {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
  shell: false,
});

child.on("close", (code) => {
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
