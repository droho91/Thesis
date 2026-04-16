# IBC-Light-Client Scope

## Thesis Goal

The thesis is a local simulation of an IBC/light-client-like inter-chain client for two permissioned EVM bank chains, demonstrated with a minimal lock/mint and burn/unescrow app flow.

The contribution is the inter-chain linkage mechanism. The app exists only to demonstrate verified remote state transition and must not dominate the repository.

## Included

- source-side validator epoch artifacts
- source-side finalized packet checkpoints
- remote client state and consensus state storage
- client messages signed by source validators
- membership verification for packet commitments
- non-membership verification for absent packet commitments in a trusted snapshot
- one-time packet execution
- freeze on conflicting certified updates
- explicit recovery through a certified successor epoch
- minimal lock/mint and burn/unescrow app flow

## Excluded

- lending business logic
- advanced lending positions
- liquidation
- price oracles
- swap routing
- fee markets
- product route/risk controls
- mainnet deployment
- paid RPCs
- paid proof systems
- cloud services

## Local Simplifications

- Local ECDSA accounts represent bank validators.
- Source block hashes are local anchors, not full header verification.
- Checkpoints are produced by a source registry transaction.
- Non-membership is implemented for packet commitment absence, but not for a generalized IBC state store.
- Recovery is role-gated for the local simulation.
