import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd(), "networks", "besu");
const allowUnsafe = process.env.UNSAFE_LOCAL_DEMO === "true";

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? listFiles(path) : [path];
    })
  );
  return nested.flat();
}

function assertSafe(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  if (allowUnsafe) {
    console.warn("[check:besu-config] UNSAFE_LOCAL_DEMO=true; hardened config checks skipped.");
    return;
  }

  const files = await listFiles(ROOT);
  const composePath = join(ROOT, "docker-compose.yml");
  const compose = await readFile(composePath, "utf8");
  assertSafe(!compose.includes("hyperledger/besu:latest"), "docker-compose.yml must pin a Besu image version.");

  const configPaths = files.filter((path) => path.endsWith("config.toml"));
  assertSafe(configPaths.length > 0, "No Besu config.toml files found. Run npm run besu:generate first.");

  for (const path of configPaths) {
    const config = await readFile(path, "utf8");
    assertSafe(!config.includes('"ADMIN"'), `${path} must not enable ADMIN RPC by default.`);
    assertSafe(!config.includes('"DEBUG"'), `${path} must not enable DEBUG RPC by default.`);
    assertSafe(!config.includes('rpc-http-cors-origins=["all"]'), `${path} must not allow all CORS origins.`);
    assertSafe(!config.includes('host-allowlist=["*"]'), `${path} must not allow all RPC hosts.`);
  }

  console.log("[check:besu-config] hardened Besu config checks passed.");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
