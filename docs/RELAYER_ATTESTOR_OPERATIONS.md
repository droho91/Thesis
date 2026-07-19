# Relayer and Attestor Operations

## Process Separation

The transport is split into independently restartable processes:

| Process | Holds | May affect |
| --- | --- | --- |
| Attestor | One checkpoint signing key and one equivocation journal | Safety only as part of the configured quorum |
| Relayer | Transaction keys, relay journal, RPC access | Liveness; it cannot invent a trusted root or bypass a storage proof |
| Besu validator | One validator key | Source-ledger consensus |

The defense profile runs four attestors and requires three signatures. A relayer asks all configured endpoints concurrently, verifies every EIP-712 signature locally, removes duplicate signers, checks membership against the on-chain attestor set, sorts signatures, and submits only a valid quorum.

## Attestor Checks

Before signing, each attestor:

1. Resolves the configured source RPC and verifies its chain ID.
2. Requires the source block to reach the configured finality depth.
3. Reads the block directly with `eth_getBlockByNumber`.
4. Compares block hash, state root, and timestamp with the requested checkpoint.
5. Checks its durable journal for a different canonical block at the same chain and height.
6. Signs the EIP-712 checkpoint for one destination chain and checkpoint-client address.
7. Persists the signed digest before returning it.

An attestor binds to loopback by default. A non-loopback listener is rejected unless an API token is configured. A bank deployment must place the endpoint behind mTLS and keep the signing key in an HSM or managed signing service; the environment-key adapter is the local defense profile, not the production key boundary.

## Relay State Machine

```text
observed
  -> source_checkpointed
  -> received
  -> destination_checkpointed
  -> completed

observed/source_checkpointed
  -> timeout_checkpointed
  -> timed_out
```

Every transition is written through an atomic JSON replacement. Jobs have expiring leases, bounded history, exponential retry, and a permanent-failure state. On restart, expired leases become runnable. Before each action the workflow reconciles `messageCompleted`, `messageTimedOut`, and `messageReceived` on-chain, so a transaction mined during a process crash is not blindly repeated.

Multiple relayers may process the same event because gateway receipts and terminal flags provide on-chain idempotency. Each process must use its own journal path; the JSON journal is single-process storage. A clustered production deployment should replace the journal adapter with a transactional shared database while retaining the same state-machine interface.

## Configuration

Examples:

```text
config/institutional-attestor.example.json
config/institutional-relay.example.json
```

Runtime files containing endpoint addresses or journal state are ignored by Git. Private keys and API tokens are read only from the named environment variables.

Start one attestor instance:

```powershell
$env:INSTITUTIONAL_ATTESTOR_CONFIG="config/institutional-attestor.json"
npm run attestor:start
```

Start the relayer after the attestor quorum is healthy:

```powershell
$env:INSTITUTIONAL_RELAY_CONFIG="config/institutional-relay.json"
npm run relay:start
```

The relayer configuration contains directional lanes. A lane observes new messages in one direction and also completes their acknowledgement or timeout in the reverse direction. Add a second lane only when applications may originate independent messages from the other bank.

## Current Boundary

The service, persistence, quorum collection, EIP-1186 proof construction, acknowledgement recovery, timeout workflow, deployment wiring, and lending application integration are implemented. The evidence runner covers outage/recovery and restart idempotency. The 100-message soak and latency acceptance target remains a separate production-readiness gate.
