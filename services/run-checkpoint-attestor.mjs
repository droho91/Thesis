import { resolve } from "node:path";
import { ethers } from "ethers";
import { AttestorJournal } from "./institutional-relay/attestor-journal.mjs";
import { CheckpointAttestor } from "./institutional-relay/checkpoint-attestor.mjs";
import { createAttestorHttpServer } from "./institutional-relay/attestor-http-server.mjs";
import { loadAttestorServiceConfig } from "./institutional-relay/service-config.mjs";

const config = await loadAttestorServiceConfig();
const sources = Object.fromEntries(Object.entries(config.sources).map(([chainId, source]) => [
  chainId,
  { provider: new ethers.JsonRpcProvider(source.rpc), finalityDepth: Number(source.finalityDepth ?? 2) },
]));
const journal = await AttestorJournal.open(resolve(process.cwd(), config.journalPath || ".runtime/attestor-journal.json"));
const attestor = new CheckpointAttestor({ wallet: new ethers.Wallet(config.privateKey), sources, journal });
const server = createAttestorHttpServer({ attestor, token: config.token });

await new Promise((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(config.listen.port, config.listen.host, resolveListen);
});
console.log(`[attestor] signer=${attestor.signerAddress} listening on http://${config.listen.host}:${config.listen.port}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
