import { classifyDefenseEvidence, readinessVerdict } from "../ops/demo/readiness.mjs";
import { formalEvidencePayload } from "../ui/evidence.mjs";

async function main() {
  const check = classifyDefenseEvidence(await formalEvidencePayload());
  console.log(`[${check.status.toUpperCase()}] ${check.name}: ${check.detail}`);

  const verdict = readinessVerdict([check]);
  if (!verdict.ready) {
    console.error(`[institutional:evidence:verify] FAILED: ${check.detail}`);
    process.exitCode = verdict.exitCode;
    return;
  }

  console.log("[institutional:evidence:verify] PASS: reports, checksums and current-source provenance match.");
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
