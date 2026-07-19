# Identity, Permission, and Governance Model

## Identity Boundary

`InstitutionalIdentityRegistry` is an on-chain eligibility index, not a customer database. It stores:

```text
account
salted customer-record hash
jurisdiction code
credential expiry
risk tier (1-5)
status
```

Names, identity numbers, addresses, sanctions-screening results, and documents remain in the bank's controlled KYC system. The record hash must be built from a bank-generated salt and a canonical off-chain record; hashing low-entropy PII without a salt is not privacy protection.

Eligibility requires an `Active` credential whose expiry is strictly in the future. Expiry takes effect in view logic without waiting for an administrator transaction. A guardian may suspend an active credential immediately but cannot reactivate it.

## Role Separation

| Role | Capability | Intended holder |
| --- | --- | --- |
| `IDENTITY_ISSUER_ROLE` | Issue and renew credentials | Bank KYC service signer |
| `COMPLIANCE_ROLE` | Reactivate suspended credentials or revoke permanently | Compliance multisig |
| `GUARDIAN_ROLE` | Emergency suspension or protocol pause | Incident-response multisig |
| `APP_ADMIN_ROLE` | Configure routes and transfer limits | Governance timelock |
| `GATEWAY_ADMIN_ROLE` | Configure remote gateways and applications | Governance timelock |
| `CHECKPOINT_ADMIN_ROLE` | Configure and rotate attestors | Governance timelock |

Operational roles do not receive `DEFAULT_ADMIN_ROLE`. The timelock owns administrative roles, while narrowly scoped operational multisigs receive only the role required for their function.

## Governance

`InstitutionalGovernanceTimelock` inherits the audited OpenZeppelin `TimelockController`. Sensitive changes are scheduled by proposers, wait at least the configured delay, and are then executed by authorized executors. The intended local profile uses a short delay for demonstrations; an institutional profile uses a documented change window and multisig proposers/executors.

After deployment and role wiring, the bootstrap administrator must renounce its timelock admin role. Emergency pause and identity suspension remain immediate, but unpause, route replacement, cap increases, attestor rotation, and role changes follow the governance path.

## Application Controls

`InstitutionalCollateralApp` is the application boundary between custody and the institutional gateway:

```text
Bank A: eligible customer -> escrow lock -> gateway commitment
Bank B: proven message -> eligible recipient -> policy check -> receipt mint
Bank B: receipt burn -> gateway commitment
Bank A: proven message -> eligible recipient -> policy check -> escrow unlock
```

Controls are cumulative:

1. Gateway route authorization binds the local and remote applications.
2. The application checks the configured remote application and canonical asset again.
3. Identity eligibility is checked at the originating bank and for the receiving beneficiary.
4. Per-transfer and per-customer daily outbound limits are enforced by the application.
5. `BankPolicyEngine` rechecks identity eligibility and enforces account allowlists, source-chain allowlists, asset allowlists, exposure caps, collateral caps, and debt caps.
6. The lending pool continues to enforce oracle freshness, collateral factors, liquidation thresholds, liquidity, and pause state.

Acknowledgements are canonical ABI values binding message ID, action, and amount. Timeout compensation refunds locked canonical assets or remints burned receipts. Refund callbacks remain available while the application is paused so an emergency stop does not automatically strand pending customer assets.

## Current Boundary

The identity registry, governance timelock, collateral application, policy engine, escrow, voucher, lending pool, checkpoint client, and proof-checked gateway are deployed together by the institutional stack. The evidence runner exercises the complete flow on two live Besu networks and verifies administrative handoff to timelocks. No claim is made that local identity hashes satisfy a particular jurisdiction's data-protection or AML regulation without a bank-specific legal and security review.
