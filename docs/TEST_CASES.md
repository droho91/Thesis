# Test Cases

## Bank Checkpoint Verification

`test/BridgeRouter.t.sol` proves the canonical bank-chain verification path:

- source checkpoints are committed on `BankCheckpointRegistry` before relay.
- source commitment hashes bind registry address, message bus, validator epoch, message range, accumulator, source block reference, and timestamp.
- `>= 2/3` validator voting power accepts a checkpoint.
- insufficient signatures fail.
- signatures bound to the wrong validator set fail.
- source-side validator epoch rotation and destination remote-view rotation are exercised.
- rotated-out validator sets fail.
- wrong checkpoint parent fails.
- wrong checkpoint sequence fails.
- duplicate checkpoints fail without freezing.
- conflicting checkpoints at the same source sequence freeze the source client.
- frozen source clients block message processing.
- source registry checkpoints can contain multiple messages.

## Message Inclusion and Routing

The same test file covers message delivery:

- deterministic message leaves are proven with Merkle siblings.
- Merkle proofs are built against committed checkpoint message ranges, not single-message defaults.
- invalid Merkle siblings fail.
- consumed messages cannot replay.
- wrong route IDs fail.
- wrong source emitter fails.
- wrong source sender fails.
- any relayer address may submit valid checkpoints and message proofs.
- invalid proofs fail before route pause/freeze policy is consulted.

## Secondary Risk Controls

Risk controls execute only after checkpoint and inclusion proof verification:

- paused routes fail.
- frozen routes fail.
- high-value transfers require secondary approval.
- route caps and rate windows remain route-level policy.
- prepaid source fees and destination route-funded relayer rewards are coherent.

## Lending Flow

The business path remains end to end:

- Bank A lock -> Bank B wrapped mint -> Bank B lending deposit/borrow.
- Bank B repay/withdraw/burn -> Bank A unlock.
- Unlock rights are bound back to the original source locker through the wrapped asset holder path.

Legacy header, receipt, and validator-attestation bridge tests were removed because they are not part of the final architecture.
