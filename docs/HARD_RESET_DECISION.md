# Hard Reset Decision

This repository continues from Thesis(7), but it no longer preserves the old product-centric direction.

The thesis title remains **A Lending System for Multi-Blockchain Ecosystems**. The hard-reset decision is that the lending system is the demonstration scenario, while the scientific center of the repository is the cross-chain client protocol that lets two independent permissioned bank chains verify each other without a shared administrator or trusted relayer.

## Kept From Thesis(7)

- Source validator epoch registry logic.
- Source checkpoint registry logic.
- Packet commitment storage.
- Merkle membership proof utilities.
- Replay protection through packet consumption and app-level packet maps.
- Freeze and recovery groundwork in the bank-chain client.
- Minimal lock/mint and burn/unescrow transfer app.
- A small voucher-backed lending use case, rewritten as a secondary app that only accepts collateral after the voucher has been minted through the verified packet path.
- Tests that validate client updates, checkpoint progression, membership and non-membership proofs, replay rejection, misbehaviour, historical epoch relay, and recovery.

## Declared Disposable

- Lending-heavy business logic from the old product direction.
- Liquidation, oracle, router, swap, and product-risk machinery.
- Lending flows that can bypass the client/proof path.
- Product dashboard behavior that made lending the center of the UI.
- Any bridge/router/product abstraction that could bypass the client trust anchor.
- Any remote-trust shortcut based on admin sync or relayer-defined truth.

## New Canonical Architecture

The repository is now organized around an IBC/light-client-like separation:

- `contracts/clients`: remote bank-chain client state, consensus state, client messages, signature verification.
- `contracts/core`: packet handling, proof verification, client store, status, paths, misbehaviour evidence.
- `contracts/source`: source-certified validator epochs, source checkpoints, packet commitments.
- `contracts/apps`: minimal transfer app, escrow vault, voucher token, local demo bank token, and a deliberately small lending pool for the thesis use case.
- `contracts/libs`: Merkle, commitment, packet, and domain hashing helpers.

The trust anchor is `BankChainClient`. Packet execution is valid only after:

1. the source app writes a packet commitment,
2. the source checkpoint registry commits a source-certified remote state root,
3. the destination client accepts a validator-certified client update,
4. the packet handler verifies packet commitment path/value membership against trusted remote state,
5. the packet id is consumed exactly once.

The lending use case happens after step 5: Bank B can treat the minted voucher as collateral only because the voucher exists as the result of verified remote state. The lending pool is therefore evidence that the cross-chain client enables a banking application, not the trust anchor itself.

## No Longer Trying To Be

- A full DeFi lending product.
- A generic bridge router.
- A swap/oracle/liquidation system.
- A polished DeFi application dashboard.
- A protocol where an owner or relayer can define remote truth.
- A production IBC implementation with generalized channels, acknowledgements, timeouts, and production consensus header verification.

## Local-Simulation Simplifications

- Local deterministic ECDSA accounts represent permissioned bank validators.
- Source block anchors are local EVM block references, not full production header verification.
- Source checkpoints are created by local registry transactions.
- Non-membership verification is implemented for the local packet commitment snapshot: a proof can show that a future packet sequence is outside the trusted packet range, or that a different value is proven at the same packet commitment path.
- Recovery is role-gated and demonstrated with a successor validator epoch in the local model.
- The trusted root is now a local Merkle state root over packet commitment path/value leaves, but it is still source-certified by the local validator artifact rather than derived from production consensus headers.
- The demo is zero-cost and uses only local chains, local scripts, and local browser UI.
