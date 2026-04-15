# Local System Test Plan

## Topology

Run two local permissioned-bank chains:

```bash
npm run node:chainA
npm run node:chainB
```

Deploy:

```bash
TMPDIR=/tmp XDG_CACHE_HOME=/tmp/.cache npm run deploy:ibc-lite
```

Seed local assets:

```bash
npm run seed:ibc-lite
```

## Expected Lock To Mint

1. User approves `EscrowVault`.
2. User calls Bank A `MinimalTransferApp.sendTransfer`.
3. Bank A `SourcePacketCommitment` records a packet leaf.
4. Run `npm run worker:source-commit`.
5. Bank A `SourceCheckpointRegistry` commits the packet root.
6. Run `npm run worker:client-update`.
7. Bank B `BankChainClient` accepts the source-certified checkpoint.
8. Run `npm run worker:packet-proof`.
9. Bank B `IBCPacketHandler` verifies membership and consumes the packet.
10. Bank B `MinimalTransferApp` mints the voucher.

## Expected Lending Workload

1. User approves `VoucherLendingPool` to spend the verified voucher.
2. User deposits the voucher as collateral on Bank B.
3. User borrows local stable token from the minimal lending pool.
4. User repays the stable token.
5. User withdraws the voucher.

Expected result:

- lending cannot begin before the verified voucher exists.
- lending actions do not change client trust state.
- the voucher can still be burned after repay and withdraw.

## Expected Burn To Unescrow

1. User withdraws voucher from `VoucherLendingPool` if it was deposited.
2. User calls Bank B `MinimalTransferApp.burnAndRelease`.
3. Bank B writes a reverse packet commitment.
4. Run `source-commit`, `client-update`, and `packet-proof` workers.
5. Bank A verifies the reverse packet against its trusted Bank B client state.
6. Bank A unescrows the canonical asset once.

## Misbehaviour

After a valid checkpoint is trusted, run:

```bash
npm run worker:misbehaviour
```

Expected result:

- destination `BankChainClient` stores misbehaviour evidence
- status becomes `Frozen`
- packet membership verification returns false
- packet execution is blocked until explicit recovery plus a certified successor epoch
