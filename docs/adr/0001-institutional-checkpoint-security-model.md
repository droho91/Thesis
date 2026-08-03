# ADR 0001: Institutional Checkpoint Security Model

- Status: Accepted
- Date: 2026-07-18
- Scope: Cross-chain finality and state-root trust

## Context

The previous prototype verified raw Besu QBFT headers on-chain and implemented a partial IBC-style connection, channel, and packet stack. That path made every intermediate header part of the critical path, did not support validator rotation, required many manually orchestrated transactions, and coupled the browser demo to large scripts.

The target is an institutional cross-chain lending reference architecture. It must expose its trust assumptions, recover deterministically after process failures, and complete receive, acknowledgement, and timeout lifecycles without user-operated proof buttons.

## Decision

Use a hybrid institutional checkpoint model:

1. A source gateway commits message hashes in fixed EVM storage slots.
2. Configured institutional attestors separately observe a finalized source block and sign its block hash, state root, height, timestamp, source chain, and attestor epoch using EIP-712.
3. Any relayer may submit a checkpoint and signatures to the destination checkpoint client.
4. The checkpoint client accepts the state root only after the configured attestor supermajority, greater than two thirds, is met under the stated signer-honesty assumptions.
5. The destination gateway verifies an EVM account/storage proof under that trusted root before executing the message.
6. A conflicting quorum-signed checkpoint at the same height freezes the client only while that evidence satisfies the maximum submission age and current/previous epoch rules. Historical evidence outside that automatic path requires guardian freeze and governed recovery.
7. Attestor rotation and incident recovery are explicit governance actions and produce on-chain events.

The defense profile uses four attestors and a threshold of three. The intended institutional allocation is Bank A, Bank B, a consortium operator, and an independent control/audit operator.

## Why This Model

This model preserves proof-based application execution while removing custom QBFT header parsing from the production-critical path. It also separates safety from liveness:

- QBFT establishes source consensus finality; the attestor quorum authorizes the destination to accept an observed finalized state root;
- EVM storage proof establishes that the exact gateway commitment exists under that root;
- relayers only transport evidence and affect liveness;
- destination contracts enforce replay, route, timeout, policy, and accounting invariants.

The structure follows patterns visible in IBC relaying, Hyperledger Cacti gateways, and CCIP commit/execute networks, while retaining a security model that can be deployed inside a governed banking consortium.

## Alternatives Rejected

### Continue the custom QBFT light client

Rejected for the main path. Correct skip verification, validator voting/rotation, Besu-version compatibility, trusting periods, and incident recovery substantially increase the verification surface. It remains a possible research extension.

### Full IBC implementation

Rejected for the current use case. A single governed bank-to-bank lane does not justify maintaining a bespoke implementation of all connection/channel semantics. The new protocol retains the useful send, receive, acknowledgement, timeout, and replay lifecycle.

### Single bank-operated signer

Rejected because one compromised key could authorize an arbitrary state root.

### Relayer database as the source of truth

Rejected. The database is operational state only; checkpoint, message, receipt, acknowledgement, and timeout state remain on-chain.

## Security Assumptions

- Fewer than the signature threshold of attestors are malicious or compromised.
- Attestors sign only finalized source blocks and protect keys using institutional key management in deployment environments.
- Destination governance is trusted to rotate attestors and recover a frozen client after documented incident review.
- EVM proof verification and gateway storage-slot derivation are correct.
- Relayer failure can delay settlement but cannot create a valid checkpoint or execute a message twice.

## Consequences

Positive:

- constant-size checkpoint updates that can skip heights;
- no validator-transition parser on the critical path;
- explicit quorum and governance assumptions;
- permissionless relay submission;
- deterministic conflict freeze and recovery;
- compatibility with private Besu chains and HSM-backed ECDSA keys.

Negative:

- the protocol is consortium-trusted rather than trust-minimized to the source validator set;
- attestor operations and governance become part of the bank operating model;
- privacy, liability, legal finality, and production key custody remain deployment concerns outside Solidity.

## References

- Besu QBFT: https://docs.besu-eth.org/private-networks/how-to/configure/consensus/qbft
- IBC architecture: https://ibcprotocol.dev/how-ibc-classic-works
- Hyperledger Cacti: https://hyperledger-cacti.github.io/cacti/
- CCIP off-chain architecture: https://docs.chain.link/ccip/concepts/architecture/offchain/overview
- Swift interoperability experiments: https://www.swift.com/swift-resource/252093/download?force_download=1
