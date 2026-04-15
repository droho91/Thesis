# Packet Flow

## Lock And Mint

1. A user calls `MinimalTransferApp.sendTransfer` on Bank A.
2. `EscrowVault` transfers canonical tokens from the user into escrow.
3. `MinimalTransferApp` builds a packet with action `ACTION_LOCK_MINT`.
4. `SourcePacketCommitment` appends the packet leaf to canonical source state.
5. `SourceCheckpointRegistry` commits a packet range and packet Merkle root.
6. Bank A validators sign the exact checkpoint hash.
7. A relayer submits the checkpoint as a `ClientMessage` to Bank B's `BankChainClient`.
8. Bank B's client stores a trusted consensus state.
9. A relayer submits the packet and Merkle proof to `IBCPacketHandler`.
10. The handler verifies membership against the trusted Bank A consensus state.
11. The handler consumes the packet id.
12. `MinimalTransferApp` mints `VoucherToken` to the recipient.

## Burn And Unescrow

1. A user calls `MinimalTransferApp.burnAndRelease` on Bank B.
2. `VoucherToken` burns the voucher.
3. Bank B writes a reverse packet commitment.
4. Bank B checkpoint progression creates a source-certified packet root.
5. Bank A's remote client accepts the certified Bank B checkpoint.
6. Bank A's packet handler verifies the reverse packet membership proof.
7. The packet id is consumed.
8. `EscrowVault` unescrows the canonical asset.

## Replay Protection

Replay protection exists at two levels:

- `IBCPacketHandler.consumedPackets`
- app-level processed packet maps in `VoucherToken` and `EscrowVault`

The handler is the canonical replay gate.
