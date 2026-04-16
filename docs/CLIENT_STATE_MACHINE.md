# Client State Machine

`BankChainClient` is the canonical trust anchor for a remote bank chain.

## States

`Uninitialized`:

- no trusted source epoch exists
- used only before constructor bootstrap

`Active`:

- client accepts valid source-certified validator epoch updates
- client accepts valid source-certified checkpoint updates
- packet membership verification can succeed
- packet non-membership verification can succeed for absence claims bound to the trusted remote state root

`Frozen`:

- entered when conflicting certified consensus states are detected
- membership verification returns false
- packet execution is blocked
- recovery must be started explicitly

`Recovering`:

- entered by `beginRecovery`
- packet execution remains blocked
- client can return to active only by accepting a certified successor validator epoch

## Client Messages

The implemented `ClientMessage` carries a source checkpoint. It is accepted only if it is signed by a known trusted source validator epoch.

The active epoch remains the head of the validator-set chain. Historical epochs remain usable for delayed checkpoint relay when the checkpoint source block is before the successor epoch activation anchor. A checkpoint signed by a superseded epoch after the successor activation is rejected.

## Membership And Non-Membership

`verifyMembership` proves that a packet commitment path/value exists under the trusted remote `stateRoot` in `ConsensusState`.

`verifyNonMembership` proves packet absence in the local snapshot in two cases:

- the claimed packet sequence is greater than the trusted checkpoint's last packet sequence
- the claimed sequence is inside the trusted range, but a different value is proven at the same packet commitment path

## Misbehaviour Evidence

Misbehaviour is not a weak boolean. The client stores:

- source chain id
- conflicting sequence
- trusted consensus state hash
- conflicting consensus state hash
- evidence hash
- detection timestamp

## Recovery Rule

Recovery requires a successor validator epoch:

```text
current trusted epoch --signs--> successor epoch
```

Only after the successor epoch is imported does the client return to `Active`.
