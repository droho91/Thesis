# Packet Flow

## Lock And Mint

1. A user calls `MinimalTransferApp.sendTransfer` on Bank A.
2. `EscrowVault` transfers canonical tokens from the user into escrow.
3. `MinimalTransferApp` builds a packet with action `ACTION_LOCK_MINT`.
4. `SourcePacketCommitment` appends the packet leaf to canonical source state.
5. The local header producer finalizes a packet range, packet Merkle root, and Merkle state root.
6. Bank A validators sign the QBFT/IBFT-like commit digest for the finalized header hash.
7. A relayer submits the header and commit seals as a `ClientMessage` to Bank B's `BankChainClient`.
8. Bank B's client stores a trusted consensus state.
9. In the Besu-first runtime, a relayer submits `eth_getProof` witnesses for the `packetLeafAt` and `packetPathAt` storage slots to `IBCPacketHandler.recvPacketFromStorageProof`.
10. The handler verifies the packet commitment against the trusted Bank A execution state root.
11. The handler consumes the packet id.
12. `MinimalTransferApp` mints `VoucherToken` to the recipient.

## Lending Use Case After Proof

The lending path is deliberately placed after packet proof execution.

1. Bank B user receives `VoucherToken` only after Bank B verifies Bank A's packet commitment under a trusted consensus state.
2. The user deposits the verified voucher into `CrossChainLendingPool`.
3. Bank B lends local `bCASH` up to a fixed collateral factor.
4. The user repays `bCASH`.
5. The user withdraws the voucher.
6. Only then can the voucher be burned to start the reverse cross-chain packet.

This keeps the thesis story clear: the lending system is possible because the two bank chains can verify cross-chain state, not because a bridge router or relayer is trusted.

## Packet Absence

`BankChainClient.verifyNonMembership` is available for packet commitment absence claims in the trusted snapshot.

The local proof supports two cases:

- a future sequence greater than the trusted header's last packet sequence
- a claimed packet body that is absent because another packet leaf occupies the same sequence

This is useful for demonstrating timeout-like and missing-commitment reasoning while moving the verifier to execution-state-root semantics.

## Burn And Unescrow

1. A user calls `MinimalTransferApp.burnAndRelease` on Bank B.
2. `VoucherToken` burns the voucher.
3. Bank B writes a reverse packet commitment.
4. Bank B finalized-header progression creates a certified state root.
5. Bank A's remote client accepts the certified Bank B header and commit seals.
6. Bank A's packet handler verifies the reverse packet proof against the trusted Bank B execution state root.
7. The packet id is consumed.
8. `EscrowVault` unescrows the canonical asset.

## Replay Protection

Replay protection exists at two levels:

- `IBCPacketHandler.consumedPackets`
- app-level processed packet maps in `VoucherToken` and `EscrowVault`

The handler is the canonical replay gate.
