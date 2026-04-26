# Threat Model

## System positioning

This project is a permissioned cross-chain lending prototype. It demonstrates proof-checked cross-chain collateral representation, policy-controlled borrowing, and risk-based liquidation under a controlled Besu/QBFT validator environment.

It is not a production public bridge, not a decentralized oracle network, not audited, and not mainnet-ready.

## Trust assumptions

| Component | Trust Assumption | Risk | Mitigation / Prototype Scope |
| --- | --- | --- | --- |
| Relayer / Executor | Relayers submit packets, headers, and proofs but should not decide whether state transitions are valid. | Censorship, delay, or failed submission. | Packet receipt, acknowledgement, and timeout checks are enforced by contracts where the flow is implemented; availability and liveness are prototype assumptions. |
| Oracle | Prices are manually governed in the demo. | Incorrect, stale, or malicious price updates can affect borrow capacity and liquidation. | `ManualAssetOracle` records timestamps and blocks stale prices; decentralized oracle design is out of scope. |
| Admin / Governance | Admins configure policy, oracle, risk parameters, roles, and pauses. | Misconfiguration or privileged abuse. | Permissioned-bank setting assumes governed operators; docs and UI label these as controlled prototype assumptions. |
| Validator set | Besu/QBFT validators operate the local permissioned chains. | Validator collusion or chain halt can break assumptions. | Prototype targets a controlled validator set and demonstrates light-client boundary behavior, not public-chain validator economics. |
| Light client initialization | Initial trusted validator/header state is configured by the deployment/demo environment. | Bad initialization can make later proof checks meaningless. | Initialization is an explicit trusted setup for the thesis prototype. |
| Proof verifier | The verifier checks EVM storage proof data against trusted state roots. | Bugs in proof parsing or boundary assumptions can accept invalid state. | Solidity tests and Besu verification scripts cover expected proof paths; no formal verification or audit is claimed. |
| Policy engine | `BankPolicyEngine` enforces allowlists, caps, and exposure accounting. | Wrong caps or allowlists can block users or overexpose the market. | Policy checks are on-chain, but policy choices are governance assumptions. |
| UI | The UI visualizes contract state and can trigger demo scripts. | UI can mislabel script-assisted state or stale local data. | README, `DEMO_FLOW.md`, and labels distinguish verified on-chain, script-assisted, visualization-only, and prototype assumptions. |
| Smart contracts | Contracts enforce packet, policy, lending, oracle freshness, and liquidation rules. | Contract bugs, missing edge cases, or economic simplifications. | Tests cover core paths; contracts are thesis-grade and not audited. |
| User wallet | Demo users sign transactions through local generated accounts. | Key compromise or wrong account actions. | Local deterministic accounts are for demo only. |
| Stable token | The debt token is a controlled Bank B token in the prototype. | It is not an externally collateralized or market-tested stablecoin. | Simplified stable asset model is intentionally scoped to the prototype. |

## Security scope

### Enforced on-chain

- Policy allowlists, caps, and exposure accounting.
- Packet receipt replay protection.
- Storage-proof checked packet receive/acknowledgement/timeout paths where the full script executes them.
- Oracle price presence and freshness.
- Borrow capacity from `collateralFactorBps`.
- Health factor and liquidation eligibility from `liquidationThresholdBps`.
- Liquidation close factor, liquidation bonus, collateral seizure, and bad-debt recognition.

### Script-assisted

- Local Besu/QBFT network generation and lifecycle orchestration.
- Header/proof collection from local RPC endpoints.
- Guided demo sequencing and report generation.
- Some scenario setup and status snapshots used for thesis demonstration.

### Visualization only

- UI-only timeout model marker triggered by **Show Timeout Model**.
- Scenario cards before the required packet/debt/proof state exists.
- Local status summaries that explain state but do not replace contract verification.

### Out of scope

- Production public-bridge security.
- Decentralized oracle networks.
- Permissionless validator economics.
- Formal verification.
- Production-grade monitoring, key management, rate limiting, and incident response.
- Multi-asset lending, cross-margining, and complex interest-rate markets.

## Known limitations

- Manual/governed oracle.
- Permissioned validator set.
- Explicit light-client trusted setup.
- No formal verification.
- No audit.
- Single collateral asset and single debt asset.
- Simplified liquidity and interest model.
- Local demo accounts and Besu runtime assumptions.
