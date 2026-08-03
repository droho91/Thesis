import { InstitutionalDemoRuntime } from "../../services/institutional-demo-runtime.mjs";
import { formalEvidencePayload } from "./evidence.mjs";

const runtime = new InstitutionalDemoRuntime();

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
  return formalEvidencePayload();
}

export async function runActionPayload(request) {
  const result = await runtime.execute(request);
  return { statusCode: 200, body: result };
}

export async function shutdownRuntime() {
  await runtime.close();
}
