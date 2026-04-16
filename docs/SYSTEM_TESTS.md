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
5. Bank A `SourceCheckpointRegistry` commits the packet commitment state root.
6. Run `npm run worker:client-update`.
7. Bank B `BankChainClient` accepts the source-certified checkpoint and stores the trusted state root.
8. Run `npm run worker:packet-proof`.
9. Bank B `IBCPacketHandler` verifies membership and consumes the packet.
10. Bank B `MinimalTransferApp` mints the voucher.

## Expected Burn To Unescrow

1. User calls Bank B `MinimalTransferApp.burnAndRelease`.
2. Bank B writes a reverse packet commitment.
3. Run `source-commit`, `client-update`, and `packet-proof` workers.
4. Bank A verifies the reverse packet against its trusted Bank B client state.
5. Bank A unescrows the canonical asset once.

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

## Absence And Replay

From the browser UI:

- `Check Non-Membership` verifies that the next Bank A packet sequence is absent from Bank B's trusted Bank A state root snapshot.
- `Replay Forward` attempts to execute the already consumed forward packet again and should be rejected by `IBCPacketHandler.consumedPackets`.
