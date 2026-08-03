import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  CORPUS_URL,
  MANIFEST_URL,
  SOLIDITY_URL,
  assertPinnedDependency,
  renderArtifacts,
} from "./mpt-proof-corpus.mjs";

await assertPinnedDependency();
const artifacts = await renderArtifacts();

await mkdir(new URL(".", CORPUS_URL), { recursive: true });
await Promise.all([
  writeFile(CORPUS_URL, artifacts.corpusJson, "utf8"),
  writeFile(MANIFEST_URL, artifacts.manifestJson, "utf8"),
  writeFile(SOLIDITY_URL, artifacts.solidity, "utf8"),
]);

console.log(`Generated ${artifacts.corpus.genericVectors.length} generic and ${artifacts.corpus.storageVectors.length} EIP-1186 storage vectors.`);
console.log(`Corpus: ${fileURLToPath(CORPUS_URL)}`);
console.log(`Manifest: ${fileURLToPath(MANIFEST_URL)}`);
console.log(`Solidity adapter: ${fileURLToPath(SOLIDITY_URL)}`);
