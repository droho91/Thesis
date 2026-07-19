# Institutional Demo Flow

## Start

```bash
npm run demo:start
```

## Presentation sequence

1. **Identity**: confirm both bank customers are active and governance is timelock-enforced.
2. **Transfer**: enter aBANK amount and submit one A-to-B transfer.
3. **Lending**: deposit received vA, then borrow within the displayed Bank B limit.
4. **Position**: repay the credit and withdraw collateral.
5. **Settlement**: burn free vA and wait for automatic B-to-A release.
6. **Evidence**: show validator topology, attestor quorum, trusted heights and transaction identifiers.

Cross-chain actions normally take several QBFT blocks because the relay waits for source finality, obtains a 3-of-4 checkpoint quorum, verifies the storage proof on the destination and returns an acknowledgement. No manual header or proof step is required.

## Recovery

If the current chain data is stale or damaged:

```bash
npm run demo:fresh
```

For validator, attestor and relayer fault evidence, run:

```bash
npm run institutional:evidence
```
