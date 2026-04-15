# Test Cases

## Client Semantics

`test/client/BankChainClient.t.sol` covers:

- client initializes from a source-originated validator epoch
- valid client update succeeds
- invalid client update fails
- duplicate update is safely rejected
- source-certified validator rotation is required before rotated checkpoints are accepted
- relayer-defined truth cannot advance the client
- conflicting certified updates freeze the client
- recovery requires explicit recovery plus a certified successor epoch

## Packet Proofs

`test/core/PacketHandler.t.sol` covers:

- valid packet membership proof succeeds
- invalid membership proof fails
- replayed packet fails
- packet execution cannot happen before trusted remote state exists

## Minimal App

`test/apps/MinimalTransferApp.t.sol` covers:

- source escrow -> destination voucher mint
- destination voucher burn -> source unescrow

## Lending Use Case

`test/apps/VoucherLendingUseCase.t.sol` covers:

- lending cannot start before a verified voucher exists
- verified voucher can be deposited as collateral
- user can borrow, repay, and withdraw in the minimal pool
- end-to-end lending use case can return to burn/unescrow

## Invariant-Style Coverage

`test/invariants/PacketReplayInvariant.t.sol` checks that executing a packet once cannot increase voucher supply a second time.
