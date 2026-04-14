# Test Cases

## Bank Checkpoint Verification

`test/BridgeRouter.t.sol` proves the canonical bank-chain verification path:

- `>= 2/3` validator voting power accepts a checkpoint.
- insufficient signatures fail.
- signatures bound to the wrong validator set fail.
- rotated-out validator sets fail.
- wrong checkpoint parent fails.
- wrong checkpoint sequence fails.
- conflicting checkpoints at the same source sequence freeze the source client.
- frozen source clients block message processing.

## Message Inclusion and Routing

The same test file covers message delivery:

- deterministic message leaves are proven with Merkle siblings.
- invalid Merkle siblings fail.
- consumed messages cannot replay.
- wrong route IDs fail.
- wrong source emitter fails.
- wrong source sender fails.
- any relayer address may submit valid checkpoints and message proofs.

## Secondary Risk Controls

Risk controls execute only after checkpoint and inclusion proof verification:

- paused routes fail.
- frozen routes fail.
- high-value transfers require secondary approval.
- route caps, rate windows, and fees remain route-level policy.

## Lending Flow

The business path remains end to end:

- Bank A lock -> Bank B wrapped mint -> Bank B lending deposit/borrow.
- Bank B repay/withdraw/burn -> Bank A unlock.

Legacy header, receipt, and validator-attestation bridge tests were removed because they are not part of the final architecture.
