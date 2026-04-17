# IBC-Light-Client Scope

## Thesis Goal

The thesis is **A Lending System for Multi-Blockchain Ecosystems**.

The actual research focus is a local simulation of an IBC/light-client-like inter-chain client for two permissioned EVM bank chains. The lending use case is intentionally downstream: Bank B accepts a voucher as collateral only after Bank B's client has verified Bank A's certified state and packet proof.

The contribution is the inter-chain linkage mechanism. The app exists to demonstrate verified remote state transition and must not dominate the repository.

## Included

- source-side validator epoch artifacts
- source-side QBFT/IBFT-like finalized packet headers
- remote client state and consensus state storage
- client messages carrying finalized headers and source validator commit seals
- membership verification for packet commitment storage slots under a trusted execution state root, with the older packet-state proof path kept only inside the internal compatibility harness during transition
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
- Source block hashes are local anchors inside a simulated finalized header.
- Finalized headers are produced by a local source registry transaction, not by an integrated production QBFT/IBFT engine.
- The canonical Besu-first path treats the trusted execution state root as the proof anchor, but the repository still carries a packet-state Merkle root inside the internal compatibility harness as a transition scaffold.
- Non-membership is implemented for packet commitment absence, but not for a generalized production IBC state store.
- Recovery is role-gated for the local simulation.

## Direction-1 Migration Target

To move this thesis toward a more faithful permissioned-EVM light-client model, the repository is beginning a migration toward:

- Besu QBFT local bank chains instead of Hardhat/Ganache demo chains,
- real finalized EVM headers fetched from RPC,
- `eth_getProof` account/storage proofs under a trusted `stateRoot`,
- minimal connection/channel/ack/timeout semantics above the proof layer.

That direction keeps the project honest for EVM chains: it becomes more faithful to light-client architecture without pretending that the current custom packet-root proof path is already a production-complete EVM or IBC implementation.
