# Test Cases

## Client Semantics

`test/client/BankChainClient.t.sol` covers:

- client initializes from a source-originated validator epoch
- valid client update succeeds
- invalid client update fails
- duplicate update is safely rejected
- source-certified validator rotation is required before rotated checkpoints are accepted
- delayed checkpoints signed by a historical epoch can still be accepted after rotation
- a superseded epoch cannot certify a post-rotation checkpoint
- relayer-defined truth cannot advance the client
- conflicting certified updates freeze the client
- recovery requires explicit recovery plus a certified successor epoch
- valid packet non-membership succeeds for future sequences and occupied-by-different-leaf cases
- invalid non-membership for an existing packet fails

## Packet Proofs

`test/core/PacketHandler.t.sol` covers:

- valid packet membership proof succeeds
- invalid membership proof fails
- packet membership is verified against the trusted remote state root
- replayed packet fails
- packet execution cannot happen before trusted remote state exists

## Minimal App

`test/apps/MinimalTransferApp.t.sol` covers:

- source escrow -> destination voucher mint
- destination voucher burn -> source unescrow

## Invariant-Style Coverage

`test/invariants/PacketReplayInvariant.t.sol` checks that executing a packet once cannot increase voucher supply a second time.
