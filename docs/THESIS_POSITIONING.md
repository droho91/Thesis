# Thesis Positioning

## Title

**A Lending System for Multi-Blockchain Ecosystems**

## Research Question

If two banks each operate their own permissioned EVM chain, and neither bank wants to trust the other bank as an administrator, how can they communicate safely enough for one bank to accept state that originated on the other chain?

This repository answers that question with a local IBC/light-client-like model:

- each bank chain writes canonical packet commitments on its own source chain,
- source validators certify finalized checkpoint artifacts,
- the counterparty chain stores a remote client state,
- packet execution requires membership verification against trusted remote state,
- replay is blocked by consumed packet ids,
- conflicting certified updates freeze the client,
- recovery requires an explicit successor validator epoch.

## Why IBC / Light Client Direction

The repository follows the design direction used by IBC rather than inventing a bridge protocol:

- IBC separates client, core, and application layers.
- IBC clients track counterparty consensus state and expose state verification functions.
- IBC-style applications do not decide remote truth; they execute only after the core layer verifies the packet path.
- ICS-20-style token transfer uses escrow/mint and burn/unescrow semantics.

Primary references:

- IBC architecture and client role: https://ibcprotocol.dev/how-ibc-works
- ICS-02 client semantics: https://github.com/cosmos/ibc/tree/main/spec/core/ics-002-client-semantics
- ICS-20 fungible token transfer: https://github.com/cosmos/ibc/tree/main/spec/app/ics-020-fungible-token-transfer
- ICS-23 vector commitments: https://github.com/cosmos/ibc/tree/main/spec/core/ics-023-vector-commitments

## How Lending Fits

The lending part is intentionally small:

1. Bank A escrows `aBANK`.
2. Bank A writes a packet commitment.
3. Bank B updates its Bank A client from a certified checkpoint.
4. Bank B verifies the packet proof and mints `vA`.
5. Bank B lending pool accepts `vA` as collateral.
6. The user borrows local Bank B liquidity `bCASH`.
7. The user repays, withdraws `vA`, burns it, and proves the reverse packet so Bank A unescrows `aBANK`.

The lending pool is therefore a demonstration of what verified cross-chain state enables. It is not the protocol's trust anchor.

## What This Prototype Is Not

This is not a production IBC implementation. It does not include:

- production consensus header verification,
- generalized channel handshakes,
- acknowledgements and timeout machinery,
- slashing or validator governance,
- generalized IBC store proofs,
- mainnet RPC or paid proving infrastructure.

Those are intentionally outside the local zero-cost thesis prototype. The implemented model is enough to demonstrate the key bank-chain question: cross-chain application state should be accepted only through a remote client and proof verification path, not through trusted relayers or product-admin shortcuts.
