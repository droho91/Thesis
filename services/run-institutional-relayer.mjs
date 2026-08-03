import { resolve } from "node:path";
import { ethers } from "ethers";
import { providerForRpc, signerForRpc } from "../scripts/ops/besu/runtime.mjs";
import { createEthersLaneWorkflow } from "./institutional-relay/ethers-lane-workflow.mjs";
import { InstitutionalRelayEngine } from "./institutional-relay/relay-engine.mjs";
import { RelayJournal } from "./institutional-relay/relay-journal.mjs";
import { loadRelayServiceConfig, requiredEnvironment } from "./institutional-relay/service-config.mjs";

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => controller.abort());

const ownedProviders = new Set();
let journal = null;
let operationError = null;
try {
  const config = await loadRelayServiceConfig();
  journal = await RelayJournal.open(resolve(process.cwd(), config.journalPath || ".runtime/relay-journal.json"));
  const lanes = [];
  for (const lane of config.lanes) {
    const sourceSigner = await signer(lane.source, `${lane.id}:source`);
    const destinationSigner = await signer(lane.destination, `${lane.id}:destination`);
    lanes.push({
      id: lane.id,
      startBlock: Number(lane.startBlock || lane.source.deploymentBlock || 1),
      workflow: await createEthersLaneWorkflow({ ...config.defaults, ...lane }, { sourceSigner, destinationSigner }),
    });
  }

  const engine = new InstitutionalRelayEngine({
    journal,
    lanes,
    leaseMs: Number(config.leaseMs || 30_000),
    batchSize: Number(config.batchSize || 10),
    retry: config.retry,
  });
  console.log(`[relay] started ${lanes.length} lane(s), journal=${journal.snapshot().version}`);
  await engine.run({ signal: controller.signal, pollIntervalMs: Number(config.pollIntervalMs || 1_000) });
  console.log("[relay] stopped cleanly");
} catch (error) {
  operationError = error;
} finally {
  const cleanupResults = await Promise.allSettled([
    ...(journal ? [journal.close()] : []),
    ...[...ownedProviders].map((provider) => Promise.resolve().then(() => provider.destroy?.())),
  ]);
  const cleanupErrors = cleanupResults
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (operationError && cleanupErrors.length > 0) {
    throw new AggregateError([operationError, ...cleanupErrors], "Relay operation and cleanup failed");
  }
  if (operationError) throw operationError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Relay cleanup failed");
}

async function signer(endpoint, label) {
  if (endpoint.privateKeyEnv) {
    const privateKey = requiredEnvironment(endpoint.privateKeyEnv);
    const provider = providerForRpc(endpoint.rpc);
    ownedProviders.add(provider);
    const wallet = new ethers.Wallet(privateKey, provider);
    return new ethers.NonceManager(wallet);
  }
  const managedSigner = await signerForRpc(endpoint.rpc, endpoint.operatorChainKey || label, Number(endpoint.operatorIndex));
  if (managedSigner.provider) ownedProviders.add(managedSigner.provider);
  return managedSigner;
}
