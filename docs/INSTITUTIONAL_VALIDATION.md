# Institutional Stack Validation

## Scope

When run against a prepared Docker runtime, the integration harness exercises the new institutional transport against two live local Besu chains. It does not use a simulator or mock proof verifier. Every delivered message is authorized by a 3-of-4 EIP-712 attestor quorum and an EIP-1186 account/storage proof checked by the destination gateway.

Run:

```bash
npm run besu:up
npm run institutional:test
```

Run the deterministic adversarial suite separately when iterating on contracts:

```bash
npm run security:test
```

It executes fourteen named scenarios covering checkpoint quorum and recovery floor, forged/replayed commitments, identity suspension and revocation, restricted restitution for both transfer directions, policy caps, timelock bypass, duplicate business requests, repayment conservation, emergency pause, compensation holds, and unauthorized voucher transfer. The repayment conservation scenario is fuzzed with 128 inputs.

The security runner does not infer execution from console text. For each manifest entry it calls the project-pinned Hardhat `3.12.0` Solidity task with exactly one source file and an escaped, anchored full test signature, including the parameter type for the fuzz scenario. Security report `institutional-security-scenarios-v2` validates the task envelope and records the structured Solidity `passed`, `failed`, `skipped` and `todo` counts. Each entry must execute exactly once with `passed=1` and every other count zero; missing, duplicated, renamed, overloaded, skipped or extra executions fail collection. The report also records source-file hashes and a checksum of the structured execution array. Because Hardhat scans the complete package root for remappings, compile/test discovery may retry at most four times only for an exact `FileNotFoundError`/`ENOENT` caused by a concurrently renamed managed UI runtime temp file; the retry count is recorded. Solidity source, artifact, selector, task-result and all other filesystem errors fail immediately.

## Repository Assurance Gates

Phase 8 adds four repository-level controls that remain distinct from live Besu evidence:

1. `npm run mpt:corpus:verify` regenerates 5 generic MPT vectors and 3 account/storage vectors with exact `@ethereumjs/trie@6.2.1`, checks the npm integrity and compares the corpus, manifest and Solidity adapter byte-for-byte. The vectors use an EIP-1186-compatible proof shape, but their manifest deliberately records `validatedLiveClients=[]` and `evidenceEligible=false`; they are not captured from a running Besu, Geth or other execution client.
2. `npm run test:invariants` explores 12 bounded lending actions and evaluates four accounting properties with 64 runs and depth 64. A pass means no counterexample was found in that state/action budget. It is not exhaustive state-space exploration or formal proof.
3. `npm run test:coverage` creates a fresh Hardhat LCOV report for deployable sources, rejects malformed/truncated/duplicate records and enforces at least 90% global line coverage, 50% for every reported file, plus 70–100% floors for 11 trust-boundary sources. It measures line coverage only; it does not establish branch or function coverage.
4. `npm run test:mutation` works on an ephemeral source copy. It first requires one exact passing baseline test, then requires each of four compiling mutants—MPT root/reference binding, gateway receipt persistence, checkpoint recovery floor and liquidation-risk equality—to cause exactly one targeted failure. A `4/4` result is 100% only for this hand-selected bounded set, not mutation coverage of the full repository. Its report is stored outside the public defense-evidence bundle with `evidenceEligible=false`.

The final Phase 10 local test runs observed 140 Solidity tests, 240 service tests and the institutional UI source/read-model check passing. Separate verification-depth runs observed four stateful properties at 64×64, line coverage of 1,560/1,657 (94.15%), and 4/4 bounded mutants killed; the browser run passed 44/44 project-test instances across four pinned viewports. These results are repository test observations on the stated toolchain, not live-chain or defense evidence.

For a clean, isolated evidence run that does not alter the normal demo runtime:

```bash
npm run institutional:evidence
```

Smoke integration results are written to `.runtime/institutional-integration-report.json`. Public defense validation evidence, security scenarios, deployed bytecode hashes, report checksums and source provenance are written below `.runtime/evidence/`. The evidence runner places attestor private keys at `.runtime/besu-qbft-evidence/private/institutional-attestor-secrets.json`; summary v4 classifies this artifact as `secret` and excluded from the public evidence allowlist. Runtime manifests, journals and local private keys are intentionally excluded from Git.

Phase 9 raises the live-proof acceptance boundary. Integration report v3 records `web3_clientVersion` for both chain IDs and retains a bounded raw proof observation for message-commitment and acknowledgement membership from each chain. An observation is emitted only after the corresponding transaction succeeds through `InstitutionalCrossChainGateway`. The validator requires pinned Besu `v26.8.1`, accepting its exact semantic-version segment either directly after `besu/` or after one configured node-identity segment, plus `eth_getProof`, the deployed source gateway account, non-empty account/storage nodes, an intact proof digest and all four kind/chain combinations. Extra or conflicting semantic-version segments fail closed. A clean passing report therefore supports a single-client Besu observation claim; it does not establish Geth/Nethermind interoperability, multi-client equivalence or formal MPT correctness. Any report captured with the previous client pin is historical and cannot satisfy the current gate.

Before any isolated runtime is started or removed, the runner creates an explicit environment allowlist and a checksummed effective security profile. Unsafe local mode, ADMIN/DEBUG RPC, managed topology/RPC/governance/proof overrides, unsupported CLI flags, process-injection variables and provenance-altering Git/Docker variables are rejected before mutation. Every runner and provenance subprocess receives the same clean environment.

The global exclusive lock at `.runtime/locks/institutional-evidence.lock` serializes the complete run, while `.runtime/locks/security-scenarios.lock` protects the independently generated security report. A live, foreign-host or unverifiable owner blocks the relevant operation. After an abrupt exit, a later local run may reclaim only a valid same-host/same-platform lock whose recorded PID the OS confirms is absent; age alone never authorizes reclamation. Initial and completion provenance must match across Git commit/status/index flags, source tree, package lock, tool versions and platform before the summary can pass. Git lookup failure, an invalid commit ID, `assume-unchanged`/`skip-worktree`, a contradictory HEAD diff, or a symbolic link at the repository root or inside a selected source input fails closed.

## Tested Invariants

1. A user with an active institutional credential locks canonical Bank A assets in escrow.
2. Bank B mints exactly the amount committed on Bank A after checkpoint quorum and storage-proof verification.
3. The Bank B lending pool accepts the voucher as collateral, disburses bCASH, and records borrower debt only within identity, asset, account, liquidity, valuation, and collateral limits.
4. Burning Bank B vouchers reduces outstanding exposure and unlocks the same canonical amount on Bank A.
5. With only 2 of 4 attestors available, the checkpoint threshold is not met and destination state remains unchanged.
6. Restoring a third attestor resumes the same durable relay job; the gateway permits at most one successful destination effect for that message.
7. Closing and recreating the relay engine/journal in the same process after `source_checkpointed` resumes through reconciliation; repeated ticks do not duplicate destination execution. This scenario does not exercise OS-process restart.
8. Reusing a UI request after an ambiguous transaction timeout reconciles the recorded receipt and message state instead of submitting the business action twice.
9. Recovery preserves historical checkpoint data for audit while rejecting proofs below the new authorization floor.
10. Terminally revoked senders cannot receive assets directly; lock and burn timeout compensation is accounted in restricted custody until governed release.

## Historical Local Observation (2026-07-18)

Validation run on 2026-07-18 against chain IDs 41001 and 41002 passed the then-current consensus, application, relay, proof, outage, same-process relay reload and governance-handoff checks. The final isolated profile used four validators on each chain and retained liveness while validator four was unavailable on both chains.

| Metric | Result |
| --- | ---: |
| Validators per chain | 4 |
| Faulted validators | 1 per chain |
| Blocks produced during validator unavailability | 3 per chain |
| Peers during validator unavailability | 2 |
| Peers after recovery | 3 |
| A-to-B end-to-end sample | 27.531 s |
| B-to-A end-to-end sample | 27.916 s |

These values are observations from one local machine, not general performance claims. The configured checkpoint policy conservatively waits two blocks even though QBFT provides immediate finality. Each completed transfer includes source checkpointing, destination proof execution, destination checkpointing, and source acknowledgement.

This historical observation predates the current evidence acceptance gate and must not be presented as a passing benchmark. An eligible run now requires at least 100 completed messages, reports source-inclusion, proof-and-acknowledgement, and end-to-end latency separately, and fails when full proof-and-acknowledgement p95 exceeds 45 seconds. A clean Git commit with matching source provenance is required before the report is eligible as defense evidence.

## Defense Evidence Acceptance Gate

`npm run institutional:evidence` performs the isolated QBFT validator-availability test, deploys a fresh governed stack, executes the named security suite, and runs the 100-message integration benchmark. The summary is `passed` only if all required samples, invariants, availability/recovery checks, provenance checks, and latency targets pass. `insufficient-samples` and `target-not-met` are failures, not warnings.

Collection validates content rather than accepting top-level status strings alone. Integration report v3 requires all five entries—`lockMint`, `lending`, `burnUnlock`, `quorumOutage` and `engineReloadRecovery`—with scenario-specific receipts, message identities and state transitions, plus both Besu client identities and four production-accepted raw proof observations. The validator-availability report v2 must cover both chains during unavailability and after recovery, retain the exact four-validator sets, prove chronology, meet peer thresholds and prove new block production. Its `testModel` explicitly excludes Byzantine behavior. The fourteen-scenario security report v2 must exactly match its manifest and structured Hardhat counts after a forced clean compile. The completion provenance snapshot must exactly match the initial snapshot before status can become `passed`.

The 45-second target is a local-lab bound for the full safety path: source transaction inclusion, the configured post-inclusion checkpoint wait, source checkpoint attestation, destination proof execution, the destination checkpoint wait, destination checkpoint attestation, and source-chain acknowledgement. QBFT blocks have immediate consensus finality; the extra block depth is a conservative checkpoint policy. The target must not be restated as a production banking SLA without a production topology and network benchmark.

Each integration-v3 sample records `sourceIncludedAt` when the source receipt is observed, `sourceInclusionMs` from action start to that observation, and `postSourceInclusionToCompletionMs` from there through acknowledgement completion. The latter is deliberately not named post-finality latency: QBFT finality belongs to the committed source block, while the measured interval also contains checkpoint waiting, attestation, proof execution and acknowledgement.

After generation, run the offline applicability gate:

```bash
npm run institutional:evidence:verify
```

The verifier recomputes the four component-report checksums, validates summary/profile v4, integration report v3 and security report v2, requires stable initial/completion provenance, and compares the recorded clean commit with the current repository. It also requires exactly chains `A` and `B`, the four live proof kind/chain observations, and exactly the deployed contract names from each chain's manifest, with matching addresses, valid 32-byte code hashes and positive byte counts. Missing/extra bytecode entries, any public file outside the exact five-report allowlist, or either remaining/unreadable managed lock fail verification because the bundle cannot be treated as complete.

A passed clean report is `stale` when commits differ, the current tree is dirty, or current source state cannot be determined. A dirty recorded run is ineligible instead of passed. An unstable/missing completion snapshot, invalid deployed-bytecode inventory or remaining lock is a failed report, not stale evidence. Both outcomes exit nonzero and make defense readiness `NOT READY`. Commit the reviewed source and perform a fresh evidence run; existing component reports are not re-aggregated as new evidence.

`npm run institutional:evidence -- --allow-dirty` is available only for development calibration. It produces `calibration-passed` and is never evidence-eligible.

## Evidence Boundary

The evidence run demonstrates crash-fault liveness with one unavailable validator. It does not inject a validator that signs conflicting or malformed consensus messages, so it is not a complete Byzantine adversarial test.

The deployed application contracts are timelock-administered after bootstrap. Local operator accounts retain pause-only guardian roles plus explicitly documented issuer, oracle, minter, or liquidator duties. The local timelock proposer is still one generated operator key; a production deployment must replace it with an institutional multisig or equivalent governed custody and place validator/attestor keys in separate HSM-backed domains.

The SHA-256 profile, source and report digests provide consistency checks under a trusted execution host. They are not signatures from an independent witness and do not establish that an uncompromised toolchain executed the tests. The operating system, filesystem, Git, Node/npm, Hardhat and Docker/Besu installation remain trust assumptions. Accordingly, the bundle is reproducible validation evidence, not formal verification, cryptographic proof of execution, external audit evidence or regulatory certification.
