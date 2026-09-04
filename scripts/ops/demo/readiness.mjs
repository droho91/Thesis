export function classifyDefenseEvidence(evidence = {}) {
  if (!evidence.available) {
    return {
      name: "Defense evidence",
      status: "fail",
      detail: evidence.message || "no validation evidence report is available",
    };
  }

  if (evidence.validatorRuntime?.sourceMatchesCurrent === false) {
    return {
      name: "Defense evidence",
      status: "fail",
      detail: `evidence validator runtime is stale (${evidence.validatorRuntime.reason || "source mismatch"}); restart the UI process`,
    };
  }

  const reportStatus = evidence.reportStatus ?? evidence.status;
  if (reportStatus !== "passed") {
    return {
      name: "Defense evidence",
      status: "fail",
      detail: "one or more validation reports did not pass",
    };
  }

  // Prefer the explicit applicability field. The provenance alias keeps older
  // payloads fail-closed without treating a missing/unknown value as current.
  const applicableToCurrentSource = evidence.applicableToCurrentSource === true
    || (evidence.applicableToCurrentSource == null && evidence.provenance?.sourceMatches === true);
  if (!applicableToCurrentSource) {
    return {
      name: "Defense evidence",
      status: "fail",
      detail: `recorded validation passed but is not applicable to the current source (${evidence.applicabilityReason || "source applicability unknown"})`,
    };
  }

  if (
    evidence.liveClients?.status !== "passed"
    || !Array.isArray(evidence.liveClients?.validated)
    || evidence.liveClients.validated.length === 0
    || !Number.isSafeInteger(evidence.liveClients?.acceptedProofObservations)
    || evidence.liveClients.acceptedProofObservations < 4
  ) {
    return {
      name: "Defense evidence",
      status: "fail",
      detail: "current evidence has no complete live-client production-proof observation",
    };
  }

  return {
    name: "Defense evidence",
    status: "pass",
    detail: `${evidence.security.passed}/${evidence.security.total} security controls; `
      + `${evidence.benchmark.sampleCount} latency samples; `
      + `${evidence.integrity.verifiedReports}/${evidence.integrity.expectedReports} report checksums; `
      + `${evidence.liveClients.validated.join("+")} live client; `
      + `${evidence.liveClients.acceptedProofObservations} accepted proof observations; `
      + `commit ${evidence.provenance.recordedCommitShort}`,
  };
}

export function readinessVerdict(checks) {
  const failures = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;

  if (failures > 0) {
    return {
      ready: false,
      exitCode: 1,
      level: "error",
      message: `[demo:doctor] NOT READY: ${failures} required check(s) failed.`,
    };
  }
  if (warnings > 0) {
    return {
      ready: true,
      exitCode: 0,
      level: "warn",
      message: `[demo:doctor] READY FOR DEFENSE WITH ${warnings} WARNING(S).`,
    };
  }
  return {
    ready: true,
    exitCode: 0,
    level: "log",
    message: "[demo:doctor] READY FOR DEFENSE",
  };
}
