import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.cwd(), process.env.BESU_NETWORK_ROOT || "networks/besu");
const chains = ["chainA", "chainB"];

async function removeNodeData(chain) {
  const nodesRoot = resolve(root, chain, "nodes");
  const entries = await readdir(nodesRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dataPath = resolve(nodesRoot, entry.name, "data");
    await rm(dataPath, { recursive: true, force: true });
    console.log(`[besu:clean] removed ${dataPath}`);
  }
}

for (const chain of chains) {
  await removeNodeData(chain);
}
