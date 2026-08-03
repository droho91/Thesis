# Project Map

Project chỉ còn một đường vận hành chính: institutional gateway, automatic relay và institutional operations UI.

## Runtime path

```text
scripts/ops/besu/                         QBFT lifecycle, config and health
scripts/ops/deployment/deploy-stack.mjs   Deploy, configure identity/policy/liquidity
scripts/ops/deployment/deployment-manifest.mjs  Pure manifest fingerprint/compatibility boundary
scripts/ops/deployment/finalize-governance.mjs
scripts/ops/demo/doctor.mjs              Defense-readiness preflight
services/institutional-demo-runtime.mjs   UI transaction controller, attestors, relay
services/institutional-durable-action-runtime.mjs  Durable transaction/outbox execution boundary
services/institutional-action-journal.mjs Durable signed-transaction outbox and request reconciliation
services/institutional-relay/             Durable proof relay and journals
services/shared/                           JSON I/O, receipt waiting, atomic persistence and process locks
scripts/ui/read-model.mjs                 On-chain UI snapshot
scripts/ui/evidence.mjs                   Sanitized validation evidence and checksum validation
scripts/ui/serve.mjs                      HTTP/static entrypoint
demo/                                     Desktop operations UI
demo/token-amount.js                      Exact 18-decimal BigInt amount domain
demo/action-request.js                    Browser retry-intent binding
demo/lending-domain.js                    Pure lending modes, validation and health rules
demo/ui-presentation.js                   Generic and evidence presentation formatting
demo/workflow-presentation.js             Workflow metadata, labels and Linky recommendations
demo/tab-keyboard.js                       Pure roving-tab keyboard index boundary
```

Runtime state:

```text
.runtime/institutional-deployment.json
.runtime/institutional-attestor-secrets.json
.runtime/institutional-demo-state.json
.runtime/institutional-demo/*/relay-journal.json
.runtime/institutional-demo/*/action-journal.json
.runtime/institutional-demo/*/*.lock       Exclusive journal ownership; may remain after an unclean exit
```

Isolated defense-evidence artifacts:

```text
.runtime/evidence/                        Public summary and component reports only
.runtime/besu-qbft-evidence/              Isolated QBFT scaffold and runtime state
.runtime/besu-qbft-evidence/private/      Secret runtime artifacts; excluded from public evidence
```

The evidence profile classifies `.runtime/besu-qbft-evidence/private/institutional-attestor-secrets.json` as `secret` with `includedInEvidenceBundle=false`. No private key is part of the `.runtime/evidence/` report allowlist.

## Protocol contracts

```text
contracts/gateway/                        Checkpoint client, EVM proof verifier, gateway
contracts/identity/                       Institutional identity and compliance status
contracts/governance/                     Timelock administration
contracts/apps/InstitutionalCollateralApp.sol
contracts/apps/BankPolicyEngine.sol
contracts/apps/PolicyControlledEscrowVault.sol
contracts/apps/PolicyControlledVoucherToken.sol
contracts/apps/InstitutionalRestitutionVault.sol
contracts/apps/PolicyControlledLendingPool.sol
contracts/apps/LendingPoolMath.sol        Pure share/rate/risk/pause math; internal linking only
```

## Transaction flow

1. Bank A customer calls `lockAndMint`; canonical aBANK enters policy escrow and remains on Bank A.
2. After QBFT commits the source block, the relay waits for the configured checkpoint-confirmation depth and collects a 3-of-4 attestor quorum.
3. Bank B verifies the account/storage proof and permits at most one successful collateral-app effect for the message.
4. Proof-issued vA can be deposited and used to borrow bCASH under policy/oracle limits.
5. After repayment and withdrawal, `burnAndUnlock` settles vA back to canonical custody on Bank A.
6. If an original sender is terminally revoked during a timeout, compensation enters a governed restitution vault instead of becoming permanently blocked.

## Verification

```text
test/gateway/                              Proof and replay protection
contracts/test/MPTProofAssurance.sol       Independent test corpus/reference walker
test/gateway/MerklePatriciaProofAssurance.t.sol  Branch/extension/inline/differential fuzz
test/fixtures/mpt-proof-corpus/            Pinned deterministic corpus + provenance/checksum manifest
contracts/test/PinnedMPTProofCorpus.sol    Generated Solidity adapter for the pinned offline corpus
test/gateway/PinnedMPTProofCorpus.t.sol    Production/reference checks for generic and EIP-1186-shaped vectors
test/apps/PolicyControlledLendingPoolInvariant.t.sol  12-action bounded stateful lending harness
hardhat.coverage.config.js                 Deployable-source coverage profile; excludes test helpers
scripts/verification/solidity-coverage-gate.mjs  Fresh LCOV generation and fail-closed line thresholds
scripts/verification/mutation-smoke.mjs    Isolated four-mutant security sensitivity gate
test/identity/                             Credential lifecycle
test/governance/                           Timelock behavior
test/apps/InstitutionalCollateralApp.t.sol Application accounting
test/services/                             Runtime, relay, attestor, persistence, API security, UI domain and source-semantics regression
test/ui/                                   Loopback synthetic fixture; keyboard, axe, typography, motion and visual gates
test/ui/institutional-ui.spec.mjs-snapshots/  10 reviewed Linux/Chromium visual baselines
playwright.config.mjs                      Three pinned desktop viewport projects
scripts/verification/institutional-integration.mjs  Full E2E and chaos workflow
scripts/verification/institutional-integration/     Benchmark and validator-evidence boundaries
scripts/verification/live-client-proof-evidence.mjs Live Besu client/proof capture and fail-closed validation
scripts/verification/browser-runtime-preflight.mjs Chromium executable/library/launch diagnostics
scripts/verification/defense-preflight.mjs          Clean-source/browser/Docker/evidence readiness gate
scripts/verification/security-scenarios.mjs         Exact-signature Hardhat security executions
scripts/verification/security-scenario-results.mjs  Structured count/report-v2 validation
scripts/verification/evidence-environment.mjs       Fail-closed environment and profile policy
scripts/verification/provenance.mjs                 Source/tool provenance under the clean environment
scripts/verification/institutional-evidence.mjs     Fresh isolated defense-evidence pipeline
scripts/verification/verify-evidence.mjs            Offline report/checksum/source-applicability gate
docs/DEFENSE_RUNBOOK.md                            Presentation and recovery checklist
docs/DEFENSE_EVIDENCE_MATRIX.md                    Claim-to-gate-to-artifact presentation matrix
.github/workflows/ci.yml                           Source/browser/depth gates plus clean hosted Besu evidence definition
```

`test/ui/fixture-data.mjs` là fixture tổng hợp theo phần payload mà UI tiêu thụ, gồm đúng 5 integration và 14 security entries để ép layout đi qua trạng thái Evidence đầy đủ. Nó không đọc `.runtime/evidence`, không chạy Besu và không phải defense evidence.

`institutional-evidence.mjs` emits summary v4 with a checksummed effective security profile. Collection fails unless integration report v3 identifies the pinned Besu client on both chains, binds four accepted live proof observations to deployed gateways, all five required integration scenarios pass, and validator-availability evidence proves both chains retained block production and recovered their peer topology. With project-pinned Hardhat `3.12.0`, `security-scenarios.mjs` emits report v2 only when each exact Solidity signature produces structured counts `passed=1, failed=0, skipped=0, todo=0`.

`npm run institutional:evidence:verify` recomputes component checksums and compares recorded provenance with the current repository. A valid clean historical report becomes `stale` when the current commit differs, the current tree is dirty, or current source state cannot be established; readiness remains fail-closed as `NOT READY`. A report captured from a dirty tree is ineligible rather than historical evidence.

The pinned MPT corpus is generated offline by the exact `@ethereumjs/trie` package recorded in its manifest. Its EIP-1186-compatible shape and deterministic hashes make fixture drift machine-detectable, but its own metadata remains `validatedLiveClients=[]`. Phase 9 separately captures a bounded raw proof set from live Besu and records it only after the production gateway transaction succeeds; this raises live assurance for one client family without claiming multi-client validation. The hosted clean-evidence job remains unobserved until a specific successful Actions run, verifier result and matching commit are inspected.
