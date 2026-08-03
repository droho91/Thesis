# Defense Runbook

## One day before the defense

Review and commit the final source, then generate evidence from the isolated runtime:

```bash
npm run defense:preflight
npm test
npm run test:browser
npm run test:verification-depth
npm run institutional:evidence
npm run institutional:evidence:verify
```

`test:verification-depth` regenerates and verifies the pinned offline MPT corpus, runs fresh line-coverage thresholds, kills the four bounded security mutants and executes the named security suite. Inspect the coverage and mutation output, but do not present either report—or the offline corpus—as live Besu defense evidence. The invariant harness is already part of the Solidity test run and explores four properties with a bounded 64×64 budget; do not describe it as formal verification.

Do not edit tracked source files after this run. The evidence report records the Git commit and source digest; the verifier must end with `PASS: reports, checksums and current-source provenance match.`

Do not use `npm run institutional:evidence -- --allow-dirty` for the presentation bundle. That mode is development calibration only, produces `calibration-passed`, and is not evidence-eligible.

Likewise, do not say the hosted Besu evidence passed merely because the CI job is defined. If it is cited, retain the exact successful Actions run URL, reviewed commit, summary v4 status and verifier result. The hosted job now runs the same clean evidence command without `--allow-dirty`, but it remains unobserved until that specific run succeeds.

The evidence run is fresh and fail-closed. Its clean environment rejects unsafe/profile/process-injection overrides before Docker startup or isolated-runtime deletion. A global lock at `.runtime/locks/institutional-evidence.lock` prevents concurrent runs and `.runtime/locks/security-scenarios.lock` protects security-report generation; neither is auto-reclaimed by PID or age. Contracts and tests are force-compiled before security report v2 requires one structured Hardhat pass for each exact test signature. Summary v4 requires stable initial/completion provenance, safe Git index flags, the checksummed effective profile, all five substantive integration scenarios, both-chain validator-unavailability/recovery chronology, exact deployed-contract inventory and component report checksums. Integration v3 additionally requires pinned Besu identity on both chains and four raw commitment/acknowledgement proof observations recorded only after production-gateway acceptance.

## Start the presentation runtime

From the project directory:

```bash
npm run demo:start
```

Open a second terminal and run:

```bash
npm run demo:doctor
```

Proceed when the final line is `READY FOR DEFENSE`. The UI is available at `http://127.0.0.1:5173/`.

Immediately before presenting, rerun the read-only applicability check:

```bash
npm run institutional:evidence:verify
```

If the report is `stale`, do not present it as current even when its recorded tests passed. A commit mismatch, dirty current tree or unknown current source state is `NOT READY`; a dirty recorded run is ineligible rather than passed evidence.

If verification reports either managed lock, treat the bundle as incomplete. Check the lock's recorded host, PID and creation time and confirm that no evidence or security runner is active before manual cleanup. Never delete or bypass a lock while ownership is uncertain; the runner intentionally does not guess whether it is stale.

## Presentation sequence

1. Open **Evidence** first. Show the recorded commit, 4-validator QBFT topology, 3-of-4 checkpoint quorum, Besu live-client identity, accepted proof-observation count, security controls and latency benchmark.
2. Open **Transfer**. Lock a small aBANK amount on Bank A, issue vA on Bank B, and explain QBFT finality, the additional checkpoint wait, attestor quorum, storage-proof verification and acknowledgement.
3. Open **Lending**. Deposit vA, borrow within the policy limit, repay the exact outstanding balance and withdraw collateral.
4. Open **Settlement**. Burn vA on Bank B and show canonical aBANK released on Bank A.
5. Return to **Evidence**. Show the live trusted heights and transaction identifiers.

When explaining the Evidence panel, distinguish four layers:

1. Security report v2 records and validates the structured counts returned by the local Hardhat task for all fourteen exact signatures; it does not rely on names echoed by npm output.
2. Summary v4 binds the selected environment profile and four component reports with SHA-256 checksums, exact deployed-contract membership, integration v3 live-client/proof validation and matching source provenance captured at both the beginning and end of the run.
3. The global and security-report locks enforce cooperative local exclusivity; they are not hostile-process isolation. The verifier requires both to be absent before accepting the exact five-file public bundle.
4. Source applicability decides whether those recorded results may be associated with the currently checked-out clean commit. `stale` is a hard readiness failure.

## Security questions to demonstrate

- One validator unavailable: QBFT continues because four validators tolerate one fault.
- Two attestors unavailable: destination execution waits because 3-of-4 quorum is not available.
- Replay or forged commitment: the gateway rejects duplicate receipt execution and unproven storage commitments.
- Suspended identity: origin and destination application execution are blocked.
- Excessive borrowing: account and asset caps reject the request.
- Relay-engine reload: the same process closes and reopens the engine/journal at `source_checkpointed`, then reconciliation completes without a duplicate destination effect. Present this as reload recovery, not an OS-process crash/restart drill.
- Emergency pause: new risk is blocked while proof-checked timeout remains available.

The recorded validation results for these cases are loaded from `.runtime/evidence/`; the UI does not create or modify test results.

Attestor private keys are not part of that public report directory. The isolated evidence run stores them below `.runtime/besu-qbft-evidence/private/`, classified as `secret` and excluded from the evidence allowlist.

Present the checksums accurately: they detect inconsistent files under the trusted local host and toolchain. They are not an independent signature, cryptographic proof that the tests executed, formal verification, external audit or production certification.

## Recovery

If `demo:doctor` reports a runtime or deployment failure:

```bash
npm run demo:fresh
```

If it reports that the defense evidence belongs to another source revision, commit the reviewed source and rerun:

```bash
npm run institutional:evidence
npm run institutional:evidence:verify
```

Do not try to reuse or re-aggregate old component reports. A new reviewed source revision requires a fresh evidence run.

If an interrupted process leaves either `.runtime/locks/institutional-evidence.lock` or `.runtime/locks/security-scenarios.lock`, first confirm from its metadata and the host process table that the recorded owner is no longer active. Only a confirmed orphan is eligible for deliberate manual cleanup; there is no automatic stale-lock recovery.
