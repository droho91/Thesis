import { startCheckpointAttestorService } from "./institutional-relay/attestor-service.mjs";
import { loadAttestorServiceConfig } from "./institutional-relay/service-config.mjs";

const config = await loadAttestorServiceConfig();
const service = await startCheckpointAttestorService(config);
console.log(`[attestor] signer=${service.signerAddress} listening on http://${config.listen.host}:${config.listen.port}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    service.close()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(`[attestor] shutdown failed: ${error?.message || error}`);
        process.exit(1);
      });
  });
}
