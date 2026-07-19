# Institutional Runtime Operations

## Defense Evidence Run

Use the isolated evidence command before the defense:

```bash
npm install
npm run institutional:evidence
```

The command uses ports `18545` and `19545`, subnet `172.31.0.0/16`, and container prefix `thesis-evidence`. It does not modify the normal demo runtime on ports `8545` and `9545`.

The pipeline performs these gates in order:

1. Verify Docker and compile the contracts.
2. Generate a clean, versioned QBFT scaffold with four validators per chain.
3. Reject unpinned images, unsafe RPC APIs, wildcard CORS/hosts, or a topology below four validators.
4. Start eight resource-bounded Besu containers and verify RPC, world state, validator set, peer count, and block progress.
5. Stop validator four on both chains, require three new blocks from each remaining 3-of-4 set, restart the nodes, and require peer recovery.
6. Deploy the institutional checkpoint, proof, gateway, identity, policy, custody, lending, and timelock contracts.
7. Grant governance roles to each timelock, remove direct operator administration, and verify retained pause-only/operational roles.
8. Run the named adversarial security suite and write source-bound scenario evidence.
9. Run lock/mint, lending, burn/unlock, attestor-quorum outage/recovery, relayer restart, replay protection, and a minimum 100-message latency benchmark.
10. Require full proof-and-acknowledgement p95 below 45 seconds, write checksummed evidence, and stop the isolated runtime. On failure, leave it running for diagnostics.

Reports:

```text
.runtime/evidence/runtime-evidence-summary.json
.runtime/evidence/besu-qbft-fault-report.json
.runtime/evidence/institutional-deployment.json
.runtime/evidence/institutional-integration-report.json
.runtime/evidence/security-scenarios.json
```

`runtime-evidence-summary.json` embeds the Git commit, dirty-tree state, source-tree digest, package-lock digest, tool versions, deployed bytecode hashes, and checksums of the component reports.

To leave the isolated runtime running after a successful evidence run:

```bash
npm run institutional:evidence -- --keep-running
```

During development only, `npm run institutional:evidence -- --allow-dirty` may be used to calibrate the pipeline. Its summary status is `calibration-passed`, never formal `passed`, and must not be used as defense evidence.

The 45-second latency target is scoped to the local Docker profile: two Besu QBFT chains with `blockperiodseconds=2`, finality depth 2, source checkpointing, destination proof execution, destination checkpointing, and source acknowledgement. It is a lab acceptance bound for repeatable defense evidence, not a production SLA.

## Normal Runtime

The normal scaffold now requires four validators per chain. An existing one-validator scaffold is intentionally rejected instead of being silently reused.

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

`besu:up` starts one bank chain at a time to avoid eight validator JVMs competing during genesis initialization. It does not return success until both chains produce blocks and each RPC node observes all four validators and three peers. Scaffold version 4 mounts each validator's own key and data directory only; RPC ports are bound to loopback and the Besu image is pinned by immutable digest.

## Diagnostics

```bash
npm run check:besu-config
npm run besu:health
npm run besu:fault-test
```

If RPC is unavailable, inspect container state and the first validator log for the affected bank:

```bash
docker compose -f networks/besu/docker-compose.yml ps
docker logs thesis-bank-a-validator-1
docker logs thesis-bank-b-validator-1
```

If an interrupted deployment left a pending transaction, rerun `npm run institutional:deploy`. The manifest records each broadcast transaction and resumes it instead of redeploying completed contracts.

If a UI action reports an uncertain outcome, keep the page/session and press the same action again. The UI reuses its request identifier; the runtime reads the recorded transaction receipt and either resumes the proof relay, returns the completed result, or reports a definite revert/refund. Do not reset a chain merely because the browser timed out.

If a chain answers `eth_chainId` but cannot read world state, do not continue with application commands. Preserve logs for incident evidence, then rebuild the local runtime with the one-time migration sequence above.

## Security Boundary

The local profile pins Besu `24.10.0` by version and image digest, constrains each validator JVM to a 512 MB heap, disables ADMIN/DEBUG RPC by default, binds host RPC to loopback, applies `no-new-privileges`, and uses static Docker-network peers. Every validator container receives only its own private key. Generated validator, operator, and attestor keys are local evidence credentials, not production custody.

Besu documents QBFT as its recommended enterprise private-network consensus, requires a supermajority of at least two thirds to sign blocks, and requires at least four validators for Byzantine fault tolerance. Four validators tolerate one unresponsive validator. See the official [QBFT configuration](https://docs.besu-eth.org/private-networks/how-to/configure/consensus/qbft) and [PoA consensus](https://docs.besu-eth.org/private-networks/concepts/poa) documentation.

Production acceptance still requires independent bank-controlled infrastructure, HSM-backed validator and attestor keys, authenticated private networking, monitored backups, audited upgrade procedures, a multisig timelock proposer, and external smart-contract/security review.
