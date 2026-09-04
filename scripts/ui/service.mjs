import { InstitutionalDemoRuntime } from "../../services/institutional-demo-runtime.mjs";
import { formalEvidencePayload, repositoryStateForEvidence } from "./evidence.mjs";

const runtime = new InstitutionalDemoRuntime();
const evidenceValidatorLoadedAt = new Date().toISOString();
// Node caches imported modules for the lifetime of the UI server. Capture the
// source revision now so a later commit cannot be validated by stale in-memory
// policy code while being presented as a current-source result.
const evidenceValidatorRepositoryAtLoad = repositoryStateForEvidence();

export async function prepareRuntime() {
  await runtime.initialize();
}

export async function healthPayload() {
  const status = await runtime.status();
  return {
    ok: status.runtimeReadable,
    service: "institutional-cross-chain-ui",
    version: status.stackVersion,
    ready: status.ready,
    runtimeReadable: status.runtimeReadable,
    chainsProgressing: status.chainsProgressing,
    attestorQuorumReady: status.attestorQuorumReady,
    relayerHealthy: status.relayerHealthy,
    governanceEnforced: status.governanceEnforced,
    identitiesEligible: status.identitiesEligible,
    laneReady: status.laneReady,
    message: status.message || null,
    topology: status.topology || null,
    governance: status.governance || null,
    controller: status.controller,
  };
}

export async function statusPayload() {
  return runtime.status();
}

export async function tracePayload() {
  const status = await runtime.status();
  return {
    activity: status.activity,
    relay: status.relay,
    controller: status.controller,
  };
}

export async function evidencePayload() {
  return formalEvidencePayload({
    validatorRepositoryAtLoad: evidenceValidatorRepositoryAtLoad,
    validatorLoadedAt: evidenceValidatorLoadedAt,
  });
}

export async function runActionPayload(request) {
  const result = await runtime.execute(request);
  return { statusCode: 200, body: result };
}

export async function shutdownRuntime() {
  await runtime.close();
}
