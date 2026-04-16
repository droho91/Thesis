# Trust Assumptions

## Permissioned Bank Chains

Each bank chain is assumed to have a known validator set and epoch progression. The local implementation models that with `SourceValidatorEpochRegistry`.

## Validators

Validators certify:

- successor validator epochs
- QBFT/IBFT-like finalized source header commit digests

The client requires at least two thirds voting power.

## Relayers

Relayers are untrusted. They can transport:

- finalized source headers
- validator commit seals
- packet Merkle proofs
- packet non-membership proofs

They cannot:

- install validator truth by admin sync
- create trusted packet state without source validator signatures
- bypass client freeze
- bypass membership proof verification
- bypass non-membership proof verification
- replay consumed packets
- make the lending pool accept collateral that was not minted through the verified packet path

## Source Artifacts

The source chain is authoritative for packet commitments, finalized-header progression, and the local packet commitment state root. Destination chains advance their remote view only through source-certified headers and commit seals.

## Direction-1 Besu Assumption

For the Besu/QBFT transition path, the intended long-term trust artifact is a real private-network EVM header plus the validator commit evidence that finalized it, not a helper contract on the source chain.

The current helper-based finalized-header producer is therefore transitional. It is useful for the existing zero-cost Solidity simulation, but it is not the intended final trust source if the repository migrates to real Besu bank chains.

When the repo is run in `runtime.mode = besu`, the packet path is storage-proof-first. The older packet-state Merkle path is treated as legacy compatibility, not as the canonical Besu demo surface.

## Lending Assumption

The lending pool trusts only local Bank B tokens. Its cross-chain collateral is the local voucher token minted by the verified transfer app. The pool does not inspect remote Bank A state directly and does not replace the client/proof layer.

## Not Modeled

- production QBFT/IBFT engine integration
- validator slashing
- public light-client fraud proofs
- production governance
- cross-chain fee markets
- generalized IBC state-store non-membership proofs
- production Besu QBFT commit-seal parsing and verification
- minimal connection/channel/ack/timeout state machines
- on-chain verification of real Besu-finalized header artifacts instead of the current helper-produced finalized-header scaffold
