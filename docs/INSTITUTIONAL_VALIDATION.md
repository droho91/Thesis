# Institutional Stack Validation

## Scope

The integration harness exercises the new institutional transport against two live local Besu chains. It does not use a simulator or mock proof verifier. Every delivered message is authorized by a 3-of-4 EIP-712 attestor quorum and an EIP-1186 account/storage proof checked by the destination gateway.

Run:

```bash
npm run besu:up
npm run institutional:test
```

Run the deterministic adversarial suite separately when iterating on contracts:

```bash
npm run security:test
```

It executes eleven named scenarios covering checkpoint quorum, forged/replayed commitments, identity suspension and revocation, policy caps, timelock bypass, duplicate business requests, repayment conservation, emergency pause, compensation holds, and unauthorized voucher transfer. The repayment conservation scenario is fuzzed with 128 inputs.

For a clean, isolated evidence run that does not alter the normal demo runtime:

```bash
npm run institutional:evidence
```

Smoke integration results are written to `.runtime/institutional-integration-report.json`. Formal evidence, security scenarios, deployed bytecode hashes, report checksums, and source provenance embedded in the summary are written below `.runtime/evidence/`. Runtime manifests, journals, and local private keys are intentionally excluded from Git.

## Tested Invariants

1. A user with an active institutional credential locks canonical Bank A assets in escrow.
2. Bank B mints exactly the amount committed on Bank A after checkpoint quorum and storage-proof verification.
3. The Bank B lending pool accepts the voucher as collateral and releases debt only within identity, asset, account, liquidity, and valuation limits.
4. Burning Bank B vouchers reduces outstanding exposure and unlocks the same canonical amount on Bank A.
5. With only 2 of 4 attestors available, the checkpoint threshold is not met and destination state remains unchanged.
6. Restoring a third attestor resumes the same durable relay job and executes it exactly once.
7. Restarting the relayer after `source_checkpointed` resumes from its journal; repeated ticks do not duplicate destination execution.
8. Reusing a UI request after an ambiguous transaction timeout reconciles the recorded receipt and message state instead of submitting the business action twice.

## Latest Local Observation

Validation run on 2026-07-18 against chain IDs 41001 and 41002 passed all consensus, application, relay, proof, outage, restart, and governance-handoff checks. The final isolated profile used four validators on each chain and retained liveness while validator four was unavailable on both chains.

| Metric | Result |
| --- | ---: |
| Validators per chain | 4 |
| Faulted validators | 1 per chain |
| Blocks produced during fault | 3 per chain |
| Peers during fault | 2 |
| Peers after recovery | 3 |
| A-to-B end-to-end sample | 27.531 s |
| B-to-A end-to-end sample | 27.916 s |

These values are observations from one local machine, not general performance claims. The configured checkpoint policy conservatively waits two blocks even though QBFT provides immediate finality. Each completed transfer includes source checkpointing, destination proof execution, destination checkpointing, and source acknowledgement.

This historical observation predates the current formal gate and must not be presented as a passing benchmark. A formal run now requires at least 100 completed messages, reports source-inclusion, proof-and-acknowledgement, and end-to-end latency separately, and fails when full proof-and-acknowledgement p95 exceeds 45 seconds. A clean Git commit with matching source provenance is required before the report is eligible as defense evidence.

## Formal Acceptance Gate

`npm run institutional:evidence` performs the isolated QBFT fault test, deploys a fresh governed stack, executes the named security suite, and runs the 100-message integration benchmark. The summary is `passed` only if all required samples, invariants, fault checks, provenance checks, and latency targets pass. `insufficient-samples` and `target-not-met` are failures, not warnings.

The 45-second target is a local-lab bound for the full safety path: source transaction inclusion, source-chain finality, source checkpoint attestation, destination proof execution, destination-chain finality, destination checkpoint attestation, and source-chain acknowledgement. It should not be restated as a production banking SLA without a production topology and network benchmark.

## Evidence Boundary

The evidence run demonstrates crash-fault liveness with one unavailable validator. It does not inject a validator that signs conflicting or malformed consensus messages, so it is not a complete Byzantine adversarial test.

The deployed application contracts are timelock-administered after bootstrap. Local operator accounts retain pause-only guardian roles plus explicitly documented issuer, oracle, minter, or liquidator duties. The local timelock proposer is still one generated operator key; a production deployment must replace it with an institutional multisig or equivalent governed custody and place validator/attestor keys in separate HSM-backed domains.
