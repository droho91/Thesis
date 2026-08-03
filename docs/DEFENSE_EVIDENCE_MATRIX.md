# Defense Evidence Matrix

This matrix separates implementation, repository assurance, live observation and presentation claims. A row may be presented as current evidence only when its acceptance gate passes for the reviewed clean commit.

| Claim | Machine gate | Bound artifact | Allowed wording after a current pass | Boundary |
| --- | --- | --- | --- | --- |
| Reviewed source did not change during validation | Initial and completion Git/source/package/tool provenance are identical | `runtime-evidence-summary.json` v4 | “The evidence bundle is bound to this clean commit and source-tree digest.” | Detects inconsistency on the trusted host; it is not a signed third-party attestation |
| Named protocol attacks are rejected | 14 exact Hardhat signatures each execute once with structured `1 passed, 0 failed/skipped/todo` | `security-scenarios.json` v2 | “Fourteen named regression scenarios passed on the recorded source.” | Bounded named scenarios, not an exhaustive security proof |
| Each bank chain uses the intended QBFT topology | Four validators per chain, one validator unavailable and recovered on both chains while blocks continue | `besu-qbft-fault-report.json` v2 | “The local four-validator profile continued with one unavailable validator and recovered it.” | Crash/unavailability only; no Byzantine behavior or infrastructure-independence test |
| Governance is handed to timelocks | Exact deployment inventory, roles and timelock profile validate | `institutional-deployment.json` v2 | “The recorded deployment completed the configured timelock handoff.” | Local defense credentials and short delay are not production custody |
| Live EIP-1186 proofs reached the production boundary | Integration report identifies Besu `v24.10.0` on both chain IDs and contains four bounded raw proof observations: commitment and acknowledgement membership from each chain, each recorded only after its gateway transaction succeeded | `institutional-integration-report.json` v3 | “Besu produced these `eth_getProof` payloads and the production gateways accepted them in the recorded run.” | One client family only; this is not multi-client validation or formal MPT verification |
| The institutional lane completes its substantive workflows | Lock/mint, lending, burn/unlock, quorum outage recovery and relay-engine reload recovery all pass | `institutional-integration-report.json` v3 | “All five recorded integration workflows passed.” | Reload recovery is not an OS crash/restart drill |
| The local profile meets its latency acceptance bound | At least 100 unique messages; proof-and-acknowledgement p95 no greater than 45 seconds | Integration report v3 and summary v4 | “The recorded local Docker profile met its 45-second p95 acceptance target.” | Local lab bound, not a production SLA |
| Repository verification depth is adequate for the thesis snapshot | 139 Solidity tests, stateful 64×64 invariants, 94.03% line coverage and 4/4 selected mutants | LCOV, mutation report and test output | “No counterexample was found in the stated budgets and all selected mutants were killed.” | Not live-chain evidence, branch coverage, full mutation analysis or formal proof |
| Desktop presentation behavior remains usable | Chromium launches, then 21 Playwright project-test instances pass across three pinned viewports | Browser preflight report and Playwright output | “The desktop UI passed the recorded keyboard, accessibility, layout, typography, motion and visual checks.” | Synthetic UI fixture; not protocol evidence |

## Required command sequence

```bash
npm run defense:preflight
npm test
npm run test:browser
npm run test:verification-depth
npm run institutional:evidence
npm run institutional:evidence:verify
npm run demo:doctor
```

`defense:preflight` is read-only with respect to protocol/runtime state. It checks clean-source provenance, Chromium launchability, Docker/Compose reachability and the applicability of an existing live evidence bundle. Its report is operational diagnostics with `evidenceEligible=false`; it does not replace `institutional:evidence`.

## Phase 9 acceptance rule

Phase 9 is repository-complete when the capture and fail-closed validation paths are implemented and regression-tested. It is evidence-complete only after all of the following are observed on one reviewed clean commit:

1. browser preflight and all Playwright instances pass;
2. hosted or local clean Besu evidence finishes with summary v4 status `passed`;
3. integration v3 validates Besu on both chain IDs and four production-accepted proof observations;
4. the offline verifier reports current source applicability;
5. `demo:doctor` reports `READY FOR DEFENSE`.

At the pre-evidence 2026-08-03 local snapshot, Chromium preflight and all 21 Playwright instances pass, and Docker Desktop/Compose are reachable from WSL. The remaining blockers are the uncommitted reviewed source and the absence of a current clean live-evidence bundle. No local or hosted live pass is inferred before the evidence runner and offline verifier complete.
