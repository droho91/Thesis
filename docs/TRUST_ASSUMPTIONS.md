# Trust Assumptions

## Permissioned Bank Chains

Each bank chain is assumed to have a known validator set and epoch progression. The local implementation models that with `SourceValidatorEpochRegistry`.

## Validators

Validators certify:

- successor validator epochs
- source checkpoint hashes

The client requires at least two thirds voting power.

## Relayers

Relayers are untrusted. They can transport:

- source checkpoints
- validator signatures
- packet Merkle proofs
- packet non-membership proofs

They cannot:

- install validator truth by admin sync
- create trusted packet state without source validator signatures
- bypass client freeze
- bypass membership proof verification
- bypass non-membership proof verification
- replay consumed packets

## Source Artifacts

The source chain is authoritative for packet commitments, checkpoint progression, and the local packet commitment state root. Destination chains advance their remote view only through source-certified artifacts.

## Not Modeled

- production consensus header verification
- validator slashing
- public light-client fraud proofs
- production governance
- cross-chain fee markets
- generalized IBC state-store non-membership proofs
