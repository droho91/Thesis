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
2. Requires the QBFT-finalized source block to satisfy the configured post-inclusion checkpoint-confirmation depth.
3. Reads the block directly with `eth_getBlockByNumber`.
4. Compares block hash, state root, and timestamp with the requested checkpoint.
5. Checks its durable journal for a different canonical block at the same chain and height.
6. Requires the exact destination `(chainId, checkpointClient)` pair to appear in its configured allowlist, then signs that EIP-712 domain.
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

Every transition is written through an atomic JSON replacement. Jobs have expiring leases, bounded history, validated exponential-retry settings, and a permanent-failure state. While a workflow step is active, the engine renews its lease every one-third of the configured lease duration. Every new claim also increments a persisted fencing token; transition, deferral, and failure writes require the current worker and exact token. A result from a worker that lost or outlived its lease is discarded without terminating the relay loop. On restart, expired leases become runnable. Before each action the workflow reconciles `messageCompleted`, `messageTimedOut`, and `messageReceived` on-chain, so a transaction mined during a process crash is not blindly repeated.

Transient scan/RPC failures are isolated per lane, logged, and retried with bounded backoff while other lanes and already-observed jobs may continue. Invalid workflow results, explicit permanent errors, and malformed engine/retry configuration fail fast. Retry configuration accepts only `baseMs`, `maxMs`, and `jitterRatio` (plus an injectable `random` function for tests); legacy `initialMs`/`maximumMs` keys are rejected rather than silently ignored.

Each JSON journal canonicalizes its parent path, rejects symbolic-link/multi-hard-link store targets, and acquires a lifetime `<journal-path>.lock` with exclusive creation. A second store or OS process targeting the same canonical path fails closed. Journal replacement uses a cryptographically random, exclusively created temporary file, syncs its contents, atomically renames it, then syncs the parent directory where the platform supports directory sync. Normal shutdown calls `close()` and removes the lock only after checking both file identity and its random ownership token. A crashed process can therefore leave a stale lock; the service never reclaims it from PID or age alone. Operators must first verify that the recorded owner is no longer active before manually removing the exact lock file.

Multiple relayers may process the same on-chain event only when each process uses its own journal path; gateway receipts and terminal flags provide the final on-chain idempotency boundary. The JSON journal deliberately enforces one owner and is not a clustered store. A clustered production deployment should replace the journal adapter with a transactional shared database whose compare-and-swap includes the fencing token, while retaining the same state-machine interface.

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

The service, persistence, quorum collection, EIP-1186 proof construction, acknowledgement recovery, timeout workflow, deployment wiring, and lending application integration are implemented. The evidence runner includes a 100-message local acceptance benchmark, quorum outage/recovery and same-process relay-engine reload/reconciliation. It does not execute an OS-process crash/restart drill. Production readiness still requires longer soak/load campaigns on separately operated, production-like infrastructure.
