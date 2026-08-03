# Institutional Runtime Operations

## Defense Evidence Run

Use the isolated evidence command before the defense:

```bash
npm install
npm run defense:preflight
npm run institutional:evidence
```

`defense:preflight` reports clean-source, Chromium, Docker/Compose and existing-evidence blockers without starting or changing protocol runtime state. Its diagnostic report is not evidence and a nonzero exit must be resolved before rehearsal.

The command uses ports `18545` and `19545`, subnet `172.31.0.0/16`, and container prefix `thesis-evidence`. It does not modify the normal demo runtime on ports `8545` and `9545`.

The pipeline performs these gates in order:

1. Parse only supported CLI flags and construct an explicit child-environment allowlist. Unsafe local mode, ADMIN/DEBUG RPC, managed profile overrides, process-injection variables and provenance-altering Git/Docker variables fail before Docker startup or filesystem mutation.
2. Atomically acquire the global exclusive lock `.runtime/locks/institutional-evidence.lock` before provenance capture or evidence-runtime mutation. Any existing lock blocks the run; PID and age are never used to reclaim a supposedly stale lock automatically.
3. Capture initial repository/tool provenance using that same clean environment and require a reviewed, clean Git tree for evidence-eligible status.
4. Verify Docker, force a clean compilation of contracts and tests, then replace the previous isolated evidence runtime only after the preflight gates pass. Cleanup discovers only the exact expected containers and network through the fixed Compose project label, rejects unexpected resources or named volumes, and never executes an old generated Compose file.
5. Execute fourteen security scenarios one at a time with project-pinned Hardhat `3.12.0`, using one source file and one escaped, anchored Solidity test signature. Security report v2 records the structured Solidity `passed`, `failed`, `skipped` and `todo` counts for every invocation and requires `passed=1` with every other count at zero.
6. Generate a clean, versioned QBFT scaffold with four validators per chain and reject unpinned images, unsafe RPC APIs, wildcard CORS/hosts or a weaker topology.
7. Start eight resource-bounded Besu containers and verify RPC, world state, validator set, peer count and block progress.
8. Stop validator four on both chains, require three new blocks from each remaining 3-of-4 set, restart the nodes and require peer recovery on both chains. This is a crash-fault availability exercise, not Byzantine-message injection.
9. Deploy the institutional checkpoint, proof, gateway, identity, policy, custody, lending and timelock contracts.
10. Grant governance roles to each timelock, remove direct operator administration and verify retained pause-only/operational roles.
11. Require all five named integration scenarios—lock/mint, lending, burn/unlock, attestor-quorum outage/recovery and same-process relay-engine reload/reconciliation—and a minimum 100-message benchmark. Record `web3_clientVersion` on both chains and retain a bounded raw `eth_getProof` observation for commitment and acknowledgement membership from each chain only after its production-gateway transaction succeeds. The reload scenario does not claim an OS-process crash/restart drill.
12. Require the pinned Besu `v24.10.0` client family, four proof kind/chain observations bound to deployed gateway accounts, proof-node digests and proof-and-acknowledgement p95 below 45 seconds. Validate report completeness, capture completion provenance and require it to match the initial snapshot before writing a passing summary. Stop the isolated runtime unless `--keep-running`, then release the owned lock. On failure after startup, leave the runtime running for diagnostics but still attempt the ownership-checked lock release.

Reports:

```text
.runtime/evidence/runtime-evidence-summary.json
.runtime/evidence/besu-qbft-fault-report.json
.runtime/evidence/institutional-deployment.json
.runtime/evidence/institutional-integration-report.json
.runtime/evidence/security-scenarios.json
```

`runtime-evidence-summary.json` uses schema `institutional-runtime-evidence-v4`; the integration component uses `institutional-integration-report-v3`. The summary embeds initial and completion provenance, including the Git commit/status digest, Git index-flag digest, source-tree digest, package-lock digest, tool versions and host platform, plus deployed bytecode hashes, component-report checksums, the effective security profile and live-client proof validation. Every stability field must match across both snapshots before the run can pass. Git commit/status/index lookup failures, an invalid object ID, `assume-unchanged` or `skip-worktree` entries, a contradictory HEAD diff, a symbolic-link repository root or a symbolic link within the selected source inputs fail collection rather than producing unknown provenance. The profile records its policy source and a canonical SHA-256 checksum; collection validates that the actual child environment still matches this profile.

The global and security-report locks are deliberate availability/safety boundaries. Normal release verifies each lock's file identity and random ownership token before unlinking it. An interrupted process can therefore leave a file behind, and the runner does not infer ownership or auto-reclaim it from PID, host or age. Confirm that no evidence runner is active on the recorded host/PID and inspect the owner metadata before any manual cleanup; while ownership is uncertain, leave the lock in place.

Private attestor material is not a report. It is written with restricted permissions below the isolated runtime:

```text
.runtime/besu-qbft-evidence/private/institutional-attestor-secrets.json
```

The profile classifies this file as `secret` and `includedInEvidenceBundle=false`; the public evidence allowlist contains exactly the five managed report files listed above and rejects any extra entry below `.runtime/evidence/`.

Verify a completed bundle without restarting the live runtime:

```bash
npm run institutional:evidence:verify
```

The verifier requires summary v4, integration report v3, a valid effective-profile checksum, security report v2 with exact per-signature Hardhat counts and forced-compilation provenance, all component checksums, substantive validator-availability/integration evidence, stable initial/completion provenance and source applicability. Integration v3 must identify pinned Besu on both chain IDs and four raw production-accepted proof observations bound to the deployed gateway accounts. It also requires exactly chains `A` and `B` and exactly the contract names in each deployment manifest: every recorded address must match, every bytecode hash must be 32 bytes and every byte count must be positive. Missing or extra entries fail the bundle. Either present or unreadable managed lock path also fails verification because the bundle may still be changing.

A clean report can remain internally passed but become `stale` when its recorded commit no longer matches, the current tree is dirty, or current source state is unknown. A dirty recorded run is ineligible rather than passed evidence. Missing completion provenance, changed provenance, invalid bytecode inventory or a remaining lock makes the report `failed`, not merely `stale`. Both `failed` and `stale` make the verifier exit nonzero and defense readiness `NOT READY`; neither is a presentation warning.

To leave the isolated runtime running after a successful evidence run:

```bash
npm run institutional:evidence -- --keep-running
```

During development only, `npm run institutional:evidence -- --allow-dirty` may be used to calibrate the pipeline. Its summary status is `calibration-passed`, never evidence-eligible `passed`, and must not be used as defense evidence.

An evidence-eligible run is always fresh. Re-aggregating an older component-report set is not supported because it would not re-execute the tested source and may require runtime state that no longer exists.

The 45-second latency target is scoped to the local Docker profile: two Besu QBFT chains with `blockperiodseconds=2`, a two-block post-inclusion checkpoint wait, source checkpointing, destination proof execution, destination checkpointing, and source acknowledgement. QBFT finality is immediate once a block is committed; the extra wait is a conservative checkpoint policy, not additional consensus finality. This is a lab acceptance bound for repeatable defense evidence, not a production SLA.

## Hosted Besu Evidence

`.github/workflows/ci.yml` defines a separate Ubuntu 24.04 clean-evidence job after the source, browser, coverage, mutation and security gates. The job performs bounded Docker/Compose preflight, runs the isolated evidence workflow under a 45-minute process timeout, runs the offline applicability verifier, prints at most 200 log lines on failure and always attempts cleanup of only the fixed `thesis-qbft-evidence` Compose project. It uploads only `.runtime/evidence/*.json`; private attestor keys remain outside that path.

The hosted command does not include `--allow-dirty`, so it can create evidence-eligible output when the checkout is clean and every gate passes. A workflow definition, queued job or uploaded artifact is still not an observed pass. Before citing hosted evidence, link the exact successful Actions run, match its commit to the reviewed source and require summary v4 plus the verifier step to pass. The Phase 9 pre-evidence audit validates workflow structure, browser behavior, Docker/Compose reachability and isolated static Besu configuration; a local or hosted live pass must still come from the clean evidence runner and verifier rather than from those prerequisites.

## Normal Runtime

The normal scaffold now requires four validators per chain. An existing one-validator scaffold is intentionally rejected instead of being silently reused.

Phase 5 changes checkpoint, gateway, collateral-application and lending ABIs, bumps the deployment manifest to `institutional-deployment-v2`, and changes evidence schemas. Every older local deployment and report bundle must therefore be rebuilt; restarting only the UI is not sufficient. Use the one-time migration sequence below after preserving any diagnostic state that matters. Environment key `INSTITUTIONAL_TRUSTING_PERIOD_SECONDS` is replaced by `INSTITUTIONAL_MAX_CHECKPOINT_SUBMISSION_AGE_SECONDS`, which is recorded as `maxCheckpointSubmissionAgeSeconds`; the value is a submission-age bound, not a root TTL.

Phase 6 is a behavior-preserving module split and does not require another chain-state migration. Copy local overrides from the current `.env.example`: an automated test now rejects keys that production source no longer reads and requires every non-compatibility source key to be documented. The old prototype transfer/light-client/packet controls were removed because they no longer configure this runtime.

One-time migration from an old scaffold or any contract/runtime architecture change:

```bash
npm run besu:down
npm run besu:generate
npm run besu:up
npm run institutional:test
```

Subsequent starts reuse the matching scaffold and deployment:

```bash
npm run besu:up
npm run institutional:test
```

### Financial keeper and route migration

`PolicyControlledLendingPool` retains every unprocessed accrual second. `accrueInterest()` processes one batch of at most 365 days; `catchUpInterest(maxBatches)` processes at most 32 batches per transaction. When debt exists and backlog exceeds 365 days, borrow, repay, collateral, liquidity, liquidation, reserve and risk-model mutations fail with `ACCRUAL_CATCH_UP_REQUIRED` until a keeper reduces the backlog. Monitor `accrualBacklogSeconds()` and `accrualBatchesRequired()`; do not reset `lastAccrualTimestamp` or redeploy to erase debt time.

To migrate an application route, first configure the replacement route as current on both applications and keep the old gateway application route enabled. The old application version remains trusted. Then schedule old-version revocation, reconcile every acknowledgement/timeout until `pendingOutboundByRoute(chainId, oldApplication) == 0`, wait the full `ROUTE_DRAIN_PERIOD`, and call `revokeRemoteRoute`. Customer transfers cannot set a timeout beyond `MAX_TRANSFER_LIFETIME`, which equals the drain period. Revoking the gateway-level route follows the same final drain decision.

The default lending `pause()` mask stops borrowing, collateral withdrawal, liquidity withdrawal and reserve withdrawal. It intentionally leaves repayment, collateral top-up, liquidity deposit, liquidation and bad-debt recognition available. Guardians may add action flags with `pauseActions`; only risk governance may clear flags with `unpauseActions` or `unpause`.

`besu:up` starts one bank chain at a time to avoid eight validator JVMs competing during genesis initialization. It does not return success until both chains produce blocks and each RPC node observes all four validators and three peers. Scaffold version 4 mounts each validator's own key and data directory only; RPC ports are bound to loopback and the Besu image is pinned by immutable digest.

Runtime health requires new finalized blocks, not merely a responsive RPC process. After Docker Desktop resumes, `besu:up` allows up to 300 seconds for Besu to reopen its database, world state, and RPC. Once RPC is available, the chain has 60 seconds to demonstrate block progress. If every validator and peer is visible but one chain still does not produce blocks, `besu:up` performs one coordinated restart of that chain's four validator processes and verifies block progress again. This recovery preserves chain data and deployed contracts. It does not loop indefinitely or hide invalid topology, missing peers, unavailable world state, or a second consensus failure.

Docker Desktop's WSL Compose proxy can transiently return `getwd: no such file or directory` even though the repository directory still exists. `besu:start` retries exactly this diagnostic once. A repeated cwd failure or any other Compose error remains fatal and leaves the isolated runtime available for bounded diagnostics.

The presentation API uses narrower, time-bounded readiness signals. `runtimeReadable` means the current on-chain snapshot was read successfully; `chainsProgressing` requires both observed heads to advance and expires after the liveness window; `attestorQuorumReady` requires the configured threshold; `relayerHealthy` requires a recent successful relay heartbeat; `governanceEnforced` verifies both timelock delays; and `identitiesEligible` covers both demonstration customers. Only their conjunction, `laneReady`, enables UI actions. The first sample after startup is intentionally not enough to establish chain progress.

Automatic recovery can be disabled for incident investigation:

```bash
$env:BESU_START_AUTO_RECOVER = "false"
npm run besu:up
```

The command above is for PowerShell. On Bash, use `export BESU_START_AUTO_RECOVER=false`.

## Diagnostics

```bash
npm run check:besu-config
npm run besu:health
npm run besu:availability-test
```

If RPC is unavailable, inspect container state and the first validator log for the affected bank:

```bash
docker compose -f networks/besu/docker-compose.yml ps
docker logs thesis-bank-a-validator-1
docker logs thesis-bank-b-validator-1
```

If an interrupted deployment left a pending transaction, rerun `npm run institutional:deploy`. The manifest records each broadcast transaction and resumes it instead of redeploying completed contracts.

Every financial UI action requires an idempotency `requestId`. Before broadcast, action-journal v3 persists the exact signed raw transaction together with its hash, chain ID, signer, nonce, destination, calldata hash, business intent and transaction-persistence provenance. Existing v1/v2 journals are migrated explicitly. The journal write is synced before the first broadcast attempt. Any unresolved financial action creates a global local-runtime fence before allowance or other action prerequisites can consume a nonce; completed request identifiers are retained instead of becoming reusable after journal growth. The browser retains and validates the complete `{requestId, action, amount}` tuple for an uncertain retry, and all token amounts remain normalized decimal strings backed by 18-decimal `BigInt` units rather than JavaScript floating point.

At startup and on status reads, the runtime automatically scans recoverable `prepared`, `signed`, `broadcasting`, `submitted` and `uncertain` actions in serial order. It first checks the exact transaction hash for a receipt or pending transaction. If neither is visible, it rebroadcasts only the persisted raw bytes; it never signs the same action again at a refreshed nonce. A successful receipt resumes event/relay reconciliation, while a reverted receipt is recorded as a definite failure. The UI also retains the same request tuple, so an explicit same-intent retry remains idempotent but is not required to start recovery. Do not reset a chain merely because the browser timed out.

If `/api/status` fails or times out, the SPA immediately discards its actionable snapshot, renders the runtime unavailable and disables every form. It does not retain a previously ready state. A later successful refresh must re-establish `laneReady` before any new POST can be submitted.

Failed automatic reconciliation backs off from 2 seconds to a 60-second ceiling. An irreconcilable raw transaction, event or deployment mismatch remains fail-closed and keeps the global action fence; this prototype has no operator override/quarantine command. Preserve the journal and logs for diagnosis rather than deleting the action or resetting a chain. The regression suite covers injected crash windows plus close/reopen reconciliation, not an operating-system `SIGKILL` disaster-recovery drill.

The exact-raw outbox closes the local crash window; it is not a claim of business-level exactly-once execution for arbitrary external clients. The pool contracts do not accept the UI request identifier, and a clustered runtime still requires a transactional shared database/CAS plus an explicit idempotency design. Action-journal storage is intentionally append-retentive in this prototype and needs an archival policy before long-running production use.

Action, relay and attestor JSON stores hold `<journal>.lock` for their complete lifetime. A second owner fails closed. After an unclean process exit, first confirm from the recorded PID/host/token metadata and operating-system state that no owner remains; only then remove the exact orphaned lock. Never delete a broad runtime directory to recover one lock.

The UI action API accepts only the exact loopback origin printed at startup. On page initialization, the SPA calls `/api/session` with same-origin Fetch Metadata; the server returns an in-memory CSRF token bound to an opaque `HttpOnly`, `SameSite=Strict` session cookie. `POST /api/action` requires the exact Host and Origin, `Sec-Fetch-Site: same-origin`, `Content-Type: application/json`, the session cookie and its matching CSRF header. The token is not persisted in browser storage. A server restart invalidates the old session; the SPA obtains a fresh session and retries only the request that was rejected before runtime execution.

The HTTP listener reserves its port before starting the embedded runtime, so `EADDRINUSE` cannot leave newly started background services behind. Startup failure closes the listener and invokes runtime cleanup. Shutdown is idempotent and attempts both listener and runtime cleanup even if either fails. Static files attach open/read/client-close handlers before streaming: an open failure returns 404, while a failure after response headers destroys only that response instead of emitting an unhandled stream error.

Raw RPC calls use `AbortController`, and ethers providers inherit a bounded HTTP request timeout (`RPC_REQUEST_TIMEOUT_MS`, default 5 seconds). Runtime shutdown waits for tracked financial actions and relay ticks before closing attestor/action/relay journals and every provider it owns. Signer or provider partial-initialization failures release resources immediately; an ambiguous nonce error is surfaced for reconciliation and is never moved automatically to a new nonce.

If a chain answers `eth_chainId` but cannot read world state, do not continue with application commands. Preserve logs for incident evidence, then rebuild the local runtime with the one-time migration sequence above.

If a chain exposes the correct four-validator topology and three peers but its block height remains unchanged, restart only that bank's complete validator group. Never restart a single QBFT validator repeatedly while diagnosing a stalled round. `npm run besu:up` now performs this coordinated one-time recovery automatically.

## Security Boundary

The local profile pins Besu `24.10.0` by version and image digest, constrains each validator JVM to a 512 MB heap, disables ADMIN/DEBUG RPC by default, binds host RPC to loopback, applies `no-new-privileges`, and uses static Docker-network peers. Every validator container receives only its own private key. Generated validator, operator, and attestor keys are local evidence credentials, not production custody.

Before generation reads or deletes runtime state, the requested `BESU_NETWORK_ROOT` is canonicalized and checked against a narrow allowlist. Only `networks/besu` and a direct `.runtime/besu-*` child are accepted; filesystem/home/workspace roots, external targets, nested broad targets and symlink escapes fail before mutation.

The evidence runner adds an independent pre-mutation boundary: all spawned Node, npm, Git, Docker and verification commands receive its explicit allowlisted environment. `UNSAFE_LOCAL_DEMO` and `BESU_ENABLE_ADMIN_DEBUG` are forced to `false`; topology, RPC, proof, governance and report-path values are profile-managed; benchmark/timeouts accept only bounded values. Unsupported CLI flags and environment variables capable of process injection or changing provenance fail before the runner can remove an old isolated runtime.

The evidence run is globally serialized by `.runtime/locks/institutional-evidence.lock`, while `.runtime/locks/security-scenarios.lock` protects the security report; its initial and completion repository snapshots must remain identical. Git failures, unsafe index flags, contradictory HEAD state and symlinked provenance inputs are rejected instead of being downgraded to unknown state. The offline verifier additionally requires the exact five-file public bundle, exact deployed-contract inventory and absence of both locks, so it cannot treat an in-progress or ambiguously interrupted run as complete.

SHA-256 profile/report checksums detect inconsistency relative to the trusted files read by the verifier. They are not signed attestations and do not protect against a compromised host, modified runtime/toolchain, malicious administrator or fabricated evidence directory. Node, npm, Hardhat, Docker/Besu binaries, the operating system and local filesystem therefore remain trust assumptions. The pipeline is reproducible defense validation, not cryptographic proof of execution, formal verification or an external audit.

Besu documents QBFT as its recommended enterprise private-network consensus, requires a supermajority of at least two thirds to sign blocks, and requires at least four validators for Byzantine fault tolerance. Four validators tolerate one unresponsive validator. See the official [QBFT configuration](https://docs.besu-eth.org/private-networks/how-to/configure/consensus/qbft) and [PoA consensus](https://docs.besu-eth.org/private-networks/concepts/poa) documentation.

Production acceptance still requires independent bank-controlled infrastructure, HSM-backed validator and attestor keys, authenticated private networking, monitored backups, audited upgrade procedures, a multisig timelock proposer, and external smart-contract/security review.
