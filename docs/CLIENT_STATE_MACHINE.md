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

The implemented `ClientMessage` carries a source checkpoint. It is accepted only if it is signed by the currently trusted source validator epoch.

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
