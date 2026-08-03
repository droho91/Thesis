# Institutional Cross-Chain Lending Protocol

## Scope

The protocol moves a collateral claim between two permissioned bank ledgers and uses that verified claim in a lending market. It is asynchronous and compensating: it does not claim synchronous atomic execution across independent chains.

## Roles

| Role | Responsibility | Trust effect |
| --- | --- | --- |
| Customer | Requests collateral lock, borrow, repay, and release | Cannot bypass policy or proof checks |
| Bank applications | Authorize business messages and callbacks | Limited to configured gateway routes |
| Attestors | Sign finalized source checkpoints | Threshold controls accepted state roots |
| Relayers | Transport checkpoints, proofs, and transactions | Affect liveness only |
| Governance | Configure routes, limits, attestors, pause, and recovery | Explicit institutional trust boundary |
| Guardian | Freeze a lane during an incident | Can stop liveness, cannot mint or release assets |

## Components

```text
Bank A                                           Bank B
PolicyControlledEscrowVault                      PolicyControlledVoucherToken
InstitutionalRestitutionVault                    InstitutionalRestitutionVault
BankPolicyEngine                                 BankPolicyEngine
InstitutionalIdentityRegistry                    InstitutionalIdentityRegistry
InstitutionalCrossChainGateway A                 InstitutionalCrossChainGateway B
CheckpointClient A (trusts Bank B) <---------    attested Bank B state roots
        ^                               Relayer transport
        +------- attested Bank A state roots --> CheckpointClient B (trusts Bank A)
                                                  PolicyControlledLendingPool
```

Administrative roles are assigned to governance timelocks. Identity issuance, compliance decisions, and emergency suspension use separate operational roles.

Each checkpoint client trusts the opposite chain. A destination gateway accepts a message only when the source gateway storage commitment is proven under a checkpointed source state root.

## Checkpoint

The signed EIP-712 checkpoint contains:

```text
sourceChainId
blockNumber
blockHash
stateRoot
timestamp
attestorEpoch
```

Signatures are bound to the destination chain and checkpoint-client contract through the EIP-712 domain, and each attestor signs only destination pairs in its configured allowlist. Signers and configured attestors are strictly ordered to reject duplicates deterministically. `maxCheckpointSubmissionAge` rejects a checkpoint that is too old when submitted; it is not a trusting-period TTL. Once accepted, a root does not automatically expire while the client remains active. The automatic conflict path can evaluate only a still-submittable checkpoint signed by the current or immediately previous attestor epoch; older evidence requires guardian freeze and governed incident recovery. After recovery, roots below the recovery authorization floor remain queryable for audit but cannot authorize account or storage proofs.

## Message Lifecycle

```text
Uncommitted
  -> Committed on source
  -> Checkpointed
  -> Proven and received on destination
  -> Acknowledged on destination
  -> Acknowledgement proven on source
  -> Completed
```

Alternative terminal path:

```text
Committed -> timeout reached -> destination receipt absence proven -> Refunded
```

If the original sender has been terminally revoked at timeout, `Refunded` means the asset is moved into an accounted institutional restitution vault rather than returned to that account. A timelocked claim administrator may release it only to a currently eligible, policy-approved recipient and must bind the release to a nonzero adjudication reference.

`Completed` and `Refunded` are mutually exclusive. Destination receipt insertion occurs before the application callback, so a successful transaction cannot execute the same message twice. A reverting callback reverts receipt insertion atomically.

## Message Identity

The message identifier is the hash of the protocol version, source chain ID, source gateway, and source nonce. This gives one globally unique sequence per source gateway and is independent of relayer identity.

The stored message commitment additionally binds the message identifier, source application, destination chain, destination gateway, destination application, payload hash, and timeout. Changing any execution-relevant field therefore invalidates the storage proof even though those fields are not repeated in the identifier.

## Required Invariants

1. A message commitment is written only by an authorized source application.
2. A destination executes only a configured source chain, gateway, and application route.
3. A commitment proof must match the exact message hash and trusted checkpoint root.
4. A message ID has at most one successful destination effect; retry-until-terminal delivery is an off-chain liveness property.
5. Source completion requires a proven destination acknowledgement.
6. Source refund requires timeout and a proven absence of the destination receipt.
7. Completed messages cannot be refunded; refunded messages cannot be acknowledged.
8. The source-vault balance covers accounted escrow liabilities; strict equality assumes no unsolicited token transfer to the vault.
9. Receipt supply does not exceed proven and unsettled locked collateral.
10. Lending collateral, debt, liquidation, and release remain subject to policy and risk controls.
11. New customer-originated actions require a non-expired active identity credential.
12. Governance changes cannot bypass the configured timelock; emergency roles may stop activity but cannot create assets.
13. Checkpoint recovery cannot reactivate proof authorization from a root below the recovery floor.
14. Terminal-revocation compensation remains fully accounted in restricted custody until a governed, policy-checked release.
15. Emergency lending pause blocks risk-increasing origination and withdrawal paths without blocking repayment or collateral top-up; liquidation and supplier actions have independent pause flags.
16. Accrual batching advances the timestamp only by elapsed time actually processed; financial actions fail closed while more than one accrual batch remains outstanding.
17. A collateral-application route is trusted by `(chainId, remoteApplication)` version. The current outbound version may change without revoking the previous inbound version; revocation requires the enforced message-lifetime drain and zero local pending messages.
18. Policy limits govern unpaid origination principal, not accrued debt. Account principal is aggregated across debt assets, accrued interest is repaid first, and a write-off freezes new origination until governed resolution.
19. Every executable partial liquidation has `healthFactorAfter >= healthFactorBefore`; risk parameter updates must also satisfy the aggregate haircut/threshold/bonus constraint.
20. Outbound velocity is accounted independently by `(account, canonicalAsset, UTC day)` so activity in one asset cannot consume or evade another asset's configured limit.
21. Gateway and application deployments bind their configured local chain ID to `block.chainid`. The current lending market intentionally supports only 18-decimal collateral/debt tokens and 18-decimal oracle prices; unsupported token metadata is rejected at deployment and an oracle address must contain bytecode.
22. If supplier assets reach zero while legacy shares remain, the pool advances a supplier-loss epoch and invalidates those claims before accepting recapitalization. New capital cannot revive written-off shares.

## Operational Requirements

- Relayer jobs are persistent and idempotent.
- Multiple relayer instances may process the same event safely.
- Every message exposes source transaction, destination transaction, checkpoint, proof height, and terminal state.
- Restarting a relayer resumes unfinished jobs through reconciliation with on-chain state.
- Gateway migration keeps the previous endpoint trusted until its in-flight messages settle; application routes additionally enforce a seven-day maximum message lifetime, a matching drain window, and zero local pending messages before explicit revocation.
- A keeper processes lending accrual backlog through bounded `catchUpInterest(maxBatches)` calls. The contract never advances `lastAccrualTimestamp` over unprocessed debt time.
- Presentation startup reuses a frozen deployment manifest; it does not regenerate networks or redeploy contracts.
- Four-validator Besu networks and four local attestor services are used for availability/outage experiments. Generated keys are random by default; deterministic keys are enabled only by the explicitly unsafe local flag.
- Each attestor independently verifies the source RPC block and persists an equivocation guard before returning a signature.
- Besu generation accepts only canonical runtime targets under `networks/besu` or `.runtime/besu-*`; broad, external and symlink-escaped deletion targets are rejected before filesystem mutation.

## Acceptance Targets

- 100 sequential end-to-end messages without manual proof actions.
- No duplicate execution under duplicate relay and process restart.
- P95 local settlement below 45 seconds for the full proof-and-acknowledgement cycle after source transaction inclusion.
- One relayer outage does not lose messages.
- One of four Besu validators may stop without loss of block production.
- Two unavailable validators stall block production; safety beyond one Byzantine validator is not claimed by this local experiment.
- Wrong signer, quorum, root, account, slot, value, route, nonce, timeout, and replay cases are rejected.
