# Project Map

Project chi con mot duong van hanh chinh: institutional gateway, automatic relay va UI institutional.

## Runtime path

```text
scripts/ops/besu/                         QBFT lifecycle, config and health
scripts/ops/deployment/deploy-stack.mjs   Deploy, configure identity/policy/liquidity
scripts/ops/deployment/finalize-governance.mjs
services/institutional-demo-runtime.mjs   UI transaction controller, attestors, relay
services/institutional-action-journal.mjs Durable request/transaction reconciliation
services/institutional-relay/             Durable proof relay and journals
scripts/ui/read-model.mjs                 On-chain UI snapshot
scripts/ui/serve.mjs                      HTTP/static entrypoint
demo/                                     Desktop operations UI
```

Runtime state:

```text
.runtime/institutional-deployment.json
.runtime/institutional-attestor-secrets.json
.runtime/institutional-demo-state.json
.runtime/institutional-demo/*/relay-journal.json
```

## Protocol contracts

```text
contracts/gateway/                        Checkpoint client, EVM proof verifier, gateway
contracts/identity/                       Institutional identity and compliance status
contracts/governance/                     Timelock administration
contracts/apps/InstitutionalCollateralApp.sol
contracts/apps/BankPolicyEngine.sol
contracts/apps/PolicyControlledEscrowVault.sol
contracts/apps/PolicyControlledVoucherToken.sol
contracts/apps/PolicyControlledLendingPool.sol
```

## Transaction flow

1. Bank A customer calls `lockAndMint`; canonical aBANK enters policy escrow.
2. Automatic relay waits for finality and collects a 3-of-4 checkpoint quorum.
3. Bank B verifies account/storage proof and invokes the collateral app exactly once.
4. Verified vA can be deposited and used to borrow bCASH under policy/oracle limits.
5. After repayment and withdrawal, `burnAndUnlock` settles vA back to canonical custody on Bank A.

## Verification

```text
test/gateway/                              Proof and replay protection
test/identity/                             Credential lifecycle
test/governance/                           Timelock behavior
test/apps/InstitutionalCollateralApp.t.sol Application accounting
test/services/                             Relay, attestor and restart behavior
scripts/verification/institutional-integration.mjs  Full E2E and chaos workflow
scripts/verification/institutional-evidence.mjs     Reproducible defense evidence
```
