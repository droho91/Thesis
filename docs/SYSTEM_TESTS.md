# Local System Test Plan

## Topology

Canonical runtime: run two local Besu permissioned-bank chains:

```bash
npm run besu:generate
npm run besu:up
```

Deploy:

```bash
npm run besu:deploy:ibc-lite
```

Seed local assets:

```bash
npm run besu:seed:ibc-lite
```

## Expected Lock To Mint

1. User approves `EscrowVault`.
2. User calls Bank A `MinimalTransferApp.sendTransfer`.
3. Bank A `SourcePacketCommitment` records a packet leaf.
4. Run `npm run worker:source-commit`.
5. Bank A local header producer finalizes the packet commitment state root.
6. Run `npm run worker:client-update`.
7. Bank B `BankChainClient` accepts the finalized source header and stores the trusted state root.
8. Run `npm run worker:packet-proof`.
9. Bank B `IBCPacketHandler` verifies the storage-slot proof and consumes the packet.
10. Bank B `MinimalTransferApp` mints the voucher.

## Expected Lending Use Case

1. User deposits the verified Bank A voucher into `CrossChainLendingPool` on Bank B.
2. User borrows local Bank B liquidity `bCASH` within the fixed collateral factor.
3. User repays `bCASH`.
4. User withdraws the voucher collateral.
5. The voucher is now available for the reverse burn path.

## Expected Burn To Unescrow

1. User calls Bank B `MinimalTransferApp.burnAndRelease`.
2. Bank B writes a reverse packet commitment.
3. Run `npm run worker:source-commit`, `npm run worker:client-update`, and `npm run worker:packet-proof`.
4. Bank A verifies the reverse packet against its trusted Bank B client state.
5. Bank A unescrows the canonical asset once.

## Misbehaviour

After a valid header is trusted, run:

```bash
npm run worker:misbehaviour
```

Expected result:

- destination `BankChainClient` stores misbehaviour evidence
- status becomes `Frozen`
- packet membership verification returns false
- packet execution is blocked until explicit recovery plus a certified successor epoch

## Absence And Replay

From the browser UI:

- `Check Non-Membership` verifies that the next Bank A packet sequence is absent from Bank B's trusted Bank A state root snapshot.
- `Replay Forward` attempts to execute the already consumed forward packet again and should be rejected by `IBCPacketHandler.consumedPackets`.

Legacy dev-harness commands (`npm run node:chainA`, `npm run node:chainB`, `npm run legacy:deploy:ibc-lite`) remain only for fast local contract testing, not for the canonical thesis demo.
