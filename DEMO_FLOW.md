# Institutional Demo Flow

## Start

```bash
npm run demo:start
```

In a second terminal, verify defense readiness:

```bash
npm run demo:doctor
```

## Presentation sequence

1. **Evidence**: establish the scope first—show the recorded source commit, validation scenarios, local latency benchmark, validator topology and attestor quorum.
2. **Identity**: confirm both bank customers are active and governance is timelock-enforced.
3. **Transfer**: lock aBANK on Bank A and wait for vA issuance on Bank B.
4. **Lending**: deposit received vA, then borrow within the displayed Bank B limit.
5. **Position**: repay the debt and withdraw collateral.
6. **Settlement**: burn free vA and wait for automatic B-to-A canonical-asset release.

QBFT finalizes a block when the validator supermajority commits it. The local checkpoint policy then waits two additional blocks before attestation, obtains a 3-of-4 quorum, verifies the storage proof on the destination and returns an acknowledgement. This is a conservative checkpoint-confirmation delay, not additional consensus finality. No manual header or proof step is required.

## Recovery

If the current chain data is stale or damaged:

```bash
npm run demo:fresh
```

For validator availability, attestor-quorum outage and relay recovery evidence, run:

```bash
npm run institutional:evidence
```
