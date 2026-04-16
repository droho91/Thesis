# IBC-Light-Client Scope

## Thesis Goal

The thesis is **A Lending System for Multi-Blockchain Ecosystems**.

The actual research focus is a local simulation of an IBC/light-client-like inter-chain client for two permissioned EVM bank chains. The lending use case is intentionally downstream: Bank B accepts a voucher as collateral only after Bank B's client has verified Bank A's certified state and packet proof.

The contribution is the inter-chain linkage mechanism. The app exists to demonstrate verified remote state transition and must not dominate the repository.

## Included

- source-side validator epoch artifacts
- source-side finalized packet checkpoints
- remote client state and consensus state storage
- client messages signed by source validators
- membership verification for packet commitment path/value pairs under a trusted state root
- non-membership verification for absent packet commitments in a trusted snapshot
- one-time packet execution
- freeze on conflicting certified updates
- explicit recovery through a certified successor epoch
- minimal lock/mint and burn/unescrow app flow
- minimal voucher-backed lending use case after successful proof execution

## Excluded

- advanced lending positions
- liquidation
- price oracles
- swap routing
- fee markets
- product route/risk controls
- lending behavior that can run without the verified cross-chain voucher path
- mainnet deployment
- paid RPCs
- paid proof systems
- cloud services

## Local Simplifications

- Local ECDSA accounts represent bank validators.
- Source block hashes are local anchors, not full header verification.
- Checkpoints are produced by a source registry transaction.
- The trusted state root is a local Merkle root over packet commitment path/value leaves, not a production consensus-derived app hash.
- Non-membership is implemented for packet commitment absence, but not for a generalized production IBC state store.
- Recovery is role-gated for the local simulation.
