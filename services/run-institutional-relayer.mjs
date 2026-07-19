import { resolve } from "node:path";
import { ethers } from "ethers";
import { signerForRpc } from "../scripts/ops/besu/runtime.mjs";
import { createEthersLaneWorkflow } from "./institutional-relay/ethers-lane-workflow.mjs";
import { InstitutionalRelayEngine } from "./institutional-relay/relay-engine.mjs";
import { RelayJournal } from "./institutional-relay/relay-journal.mjs";
import { loadRelayServiceConfig, requiredEnvironment } from "./institutional-relay/service-config.mjs";

const config = await loadRelayServiceConfig();
const journal = await RelayJournal.open(resolve(process.cwd(), config.journalPath || ".runtime/relay-journal.json"));
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

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => controller.abort());
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

async function signer(endpoint, label) {
  if (endpoint.privateKeyEnv) {
    const privateKey = requiredEnvironment(endpoint.privateKeyEnv);
    const wallet = new ethers.Wallet(privateKey, new ethers.JsonRpcProvider(endpoint.rpc));
    return new ethers.NonceManager(wallet);
  }
  return signerForRpc(endpoint.rpc, endpoint.operatorChainKey || label, Number(endpoint.operatorIndex));
}
