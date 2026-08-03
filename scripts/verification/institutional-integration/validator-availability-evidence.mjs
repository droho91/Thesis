import { resolve } from "node:path";
import { readJsonIfExists } from "../../../services/shared/json-file.mjs";

export const VALIDATOR_AVAILABILITY_REPORT_VERSION =
  "besu-qbft-validator-availability-report-v2";
export const VALIDATOR_AVAILABILITY_TEST_MODEL =
  "single-validator crash/unavailability; no Byzantine behavior is injected";

export async function collectValidatorAvailabilityEvidence({
  cwd = process.cwd(),
  environment = process.env,
  readOptionalJson = readJsonIfExists,
} = {}) {
  const networkRoot = resolve(cwd, environment.BESU_NETWORK_ROOT || "networks/besu");
  const faultReportPath = resolve(
    cwd,
    environment.BESU_QBFT_FAULT_REPORT_PATH || ".runtime/besu-qbft-fault-report.json",
  );
  const [scaffold, faultReport] = await Promise.all([
    readOptionalJson(resolve(networkRoot, "scaffold.json")),
    readOptionalJson(faultReportPath),
  ]);
  return buildValidatorAvailabilityEvidence({ scaffold, faultReport, faultReportPath });
}

export function buildValidatorAvailabilityEvidence({ scaffold, faultReport, faultReportPath }) {
  const topology = normalizeTopology(scaffold);
  if (typeof faultReportPath !== "string" || faultReportPath.length === 0) {
    throw new Error("Validator-availability report path must be a non-empty string.");
  }

  const currentAvailabilityReport =
    topology.validatorCountPerChain >= 4
    && faultReport?.version === VALIDATOR_AVAILABILITY_REPORT_VERSION
    && faultReport?.status === "passed"
    && faultReport?.testModel === VALIDATOR_AVAILABILITY_TEST_MODEL
    && faultReport?.validatorCount === topology.validatorCountPerChain
    && faultReport?.toleratedFaults === topology.toleratedFaults
    && Array.isArray(faultReport?.validatorUnavailable)
    && Array.isArray(faultReport?.duringUnavailability)
    && Array.isArray(faultReport?.afterRecovery);

  return {
    validatorTopology: topology,
    validatorAvailabilityTest: currentAvailabilityReport
      ? {
          status: "passed",
          report: faultReportPath,
          unavailableValidators: faultReport.validatorUnavailable,
          duringUnavailability: faultReport.duringUnavailability,
          afterRecovery: faultReport.afterRecovery,
        }
      : {
          status: "not-run",
          reason: topology.validatorCountPerChain < 4
            ? "The active profile has fewer than four validators and cannot evidence QBFT fault tolerance."
            : "Run the QBFT validator-availability test and provide BESU_QBFT_FAULT_REPORT_PATH before claiming crash-fault availability evidence.",
        },
  };
}

function normalizeTopology(scaffold) {
  if (scaffold === null || scaffold === undefined) {
    return {
      validatorCountPerChain: 1,
      toleratedFaults: 0,
      dockerImage: "unknown",
    };
  }
  if (typeof scaffold !== "object" || Array.isArray(scaffold)) {
    throw new Error("Besu scaffold must be an object when present.");
  }

  const validatorCountPerChain = scaffold.validatorCount ?? 1;
  const toleratedFaults = scaffold.byzantineFaultTolerance ?? 0;
  const dockerImage = scaffold.dockerImage ?? "unknown";
  if (!Number.isSafeInteger(validatorCountPerChain) || validatorCountPerChain <= 0) {
    throw new Error("Besu scaffold validatorCount must be a positive safe integer.");
  }
  if (
    !Number.isSafeInteger(toleratedFaults)
    || toleratedFaults < 0
    || toleratedFaults >= validatorCountPerChain
  ) {
    throw new Error("Besu scaffold byzantineFaultTolerance is outside the validator topology.");
  }
  if (typeof dockerImage !== "string" || dockerImage.length === 0) {
    throw new Error("Besu scaffold dockerImage must be a non-empty string.");
  }
  return { validatorCountPerChain, toleratedFaults, dockerImage };
}
