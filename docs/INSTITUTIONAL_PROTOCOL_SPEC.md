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
Bank A                                      Bank B
CollateralVault                            RestrictedCollateralReceipt
BankPolicyRegistry                         BankPolicyRegistry
IdentityRegistry                           IdentityRegistry
CrossChainGateway A                        CrossChainGateway B
InstitutionalCheckpointClient B <------    attested Bank B checkpoints
        ^                          Relayer cluster
        +------ attested Bank A checkpoints ------> InstitutionalCheckpointClient A
                                             LendingMarket
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

Signatures are bound to the destination chain and checkpoint-client contract through the EIP-712 domain. Signers and configured attestors are strictly ordered to reject duplicates deterministically. A checkpoint expires after the configured trusting period and may not exceed the clock-drift allowance.

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

`Completed` and `Refunded` are mutually exclusive. Destination receipt insertion occurs before the application callback, so a successful transaction cannot execute the same message twice. A reverting callback reverts receipt insertion atomically.

## Message Identity

The message identifier is the hash of the protocol version, source chain ID, source gateway, and source nonce. This gives one globally unique sequence per source gateway and is independent of relayer identity.

The stored message commitment additionally binds the message identifier, source application, destination chain, destination gateway, destination application, payload hash, and timeout. Changing any execution-relevant field therefore invalidates the storage proof even though those fields are not repeated in the identifier.

## Required Invariants

1. A message commitment is written only by an authorized source application.
2. A destination executes only a configured source chain, gateway, and application route.
3. A commitment proof must match the exact message hash and trusted checkpoint root.
4. A message ID has at most one successful destination receipt.
5. Source completion requires a proven destination acknowledgement.
6. Source refund requires timeout and a proven absence of the destination receipt.
7. Completed messages cannot be refunded; refunded messages cannot be acknowledged.
8. Lock liabilities equal canonical collateral held by the source vault.
9. Receipt supply does not exceed proven and unsettled locked collateral.
10. Lending collateral, debt, liquidation, and release remain subject to policy and risk controls.
11. New customer-originated actions require a non-expired active identity credential.
12. Governance changes cannot bypass the configured timelock; emergency roles may stop activity but cannot create assets.

## Operational Requirements

- Relayer jobs are persistent and idempotent.
- Multiple relayer instances may process the same event safely.
- Every message exposes source transaction, destination transaction, checkpoint, proof height, and terminal state.
- Restarting a relayer resumes unfinished jobs through reconciliation with on-chain state.
- Gateway migration keeps the previous endpoint trusted until its in-flight messages settle; revocation is explicit.
- Presentation startup reuses a frozen deployment manifest; it does not regenerate networks or redeploy contracts.
- Four-validator Besu networks and four attestors are used for fault experiments. Keys are deterministic only in the local defense profile.
- Each attestor independently verifies the source RPC block and persists an equivocation guard before returning a signature.

## Acceptance Targets

- 100 sequential end-to-end messages without manual proof actions.
- No duplicate execution under duplicate relay and process restart.
- P95 local settlement below 45 seconds for the full proof-and-acknowledgement cycle after source transaction inclusion.
- One relayer outage does not lose messages.
- One of four Besu validators may stop without loss of block production.
- More than one validator failure stalls safely without unauthorized settlement.
- Wrong signer, quorum, root, account, slot, value, route, nonce, timeout, and replay cases are rejected.
