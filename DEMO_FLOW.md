# Customer-Facing Verified Demo Flow

This demo is a thesis prototype for a permissioned banking-chain setting. It combines a Bank B lending pool with a Besu-first light-client and EVM storage-proof packet lane. It is not production-ready, audited, mainnet-ready, or a decentralized market-oracle system.

The live presentation uses one main flow: a customer-facing verified demo. It should feel like a banking application while preserving the protocol checks that matter for the thesis.

## Start the local demo

```bash
npm install
npm run besu:generate
npm run besu:up
npm run deploy
npm run seed
npm run demo:warmup
npm run demo:ui
```

Open:

```text
http://127.0.0.1:5173/
```

Use **Prepare Demo Session** to reuse an already seeded local runtime. Use **Fresh Reset (slow setup only)** only before the demo window or for recovery when you need a clean deployment.

## Main live flow

1. Prepare the demo session.
2. Establish the Bank A <-> Bank B route if needed.
3. Transfer collateral to Bank B, which locks canonical collateral on Bank A and commits the packet.
4. Receive verified collateral by importing the Bank A Besu header on Bank B and verifying the storage proof.
5. Deposit collateral into the Bank B lending pool.
6. Borrow cash within available borrow capacity.
7. Simulate a collateral price drop with the governed demo oracle.
8. Execute liquidation only after the health factor makes the account liquidatable.
9. Open Technical / Thesis to show packet proof, trusted height, state root, replay protection, and liquidation evidence.

Route setup and ERC-20 approvals are infrastructure-level setup. `npm run demo:warmup` can open or reuse the route and pre-approve demo allowances before the presentation. It does not deposit collateral, borrow, shock price, liquidate, or mint voucher collateral.

The receive proof remains mandatory. Voucher collateral is minted on Bank B only after Bank B verifies the Bank A packet storage proof. The acknowledgement proof is treated as backend settlement finalization and is deferred from the user-facing path because voucher availability on Bank B does not depend on the reverse acknowledgement.

The Borrower Portal shows collateral value, current debt, available borrow, health factor, position guidance, and recent activity.

Borrow capacity is based on `collateralFactorBps`. Liquidation risk is based on the separate `liquidationThresholdBps`, so a borrower can be inside the borrow limit while still carrying a thinner health-factor buffer.

## Admin liquidation flow

Open **Risk Admin**.

1. Review the governed demo oracle prices, collateral value, debt, available borrow, borrow capacity, liquidation threshold value, health factor, collateral factor / max LTV, liquidation threshold, liquidation trigger, utilization, reserves, and bad debt.
2. Set or accept the shock price and run **Simulate Collateral Price Drop**.
3. Compare health factor before and after the price drop.
4. Review the liquidation preview: repay amount, seized collateral, remaining debt, remaining collateral, bad debt, reserve use, and supplier loss.
5. Run **Execute Liquidation** when the account is liquidatable.
6. Review the after-liquidation state and transaction hash. This section stays blank until **Execute Liquidation** has actually produced a liquidation transaction.

The oracle is intentionally labeled as a governed demo oracle. It is manual and demo-only, not a decentralized market oracle.

The liquidation preview uses the current on-chain oracle state. Run **Simulate Collateral Price Drop** before expecting executable liquidation values to change. A higher oracle price update is allowed because this is a governed oracle update, but it is not a downside shock.

“After Liquidation” is a liquidation-specific snapshot. Later repay or withdraw actions should change the live position and their own trace fields, not the liquidation snapshot.

The collateral factor / max LTV is different from the liquidation threshold. The collateral factor limits how much can be borrowed against collateral. The liquidation threshold determines the health factor. Liquidation is triggered when health factor falls below 100%, meaning `healthFactorBps < 10000`.

## Feature status classification

| Feature | Status | Explanation |
| --- | --- | --- |
| Packet execution proof | Verified on-chain | Bank B accepts a packet only after the storage proof matches the packet commitment under a trusted Bank A state root. |
| Packet replay protection | Verified on-chain | Destination packet receipts prevent a received packet from executing twice. |
| Policy allowlist and caps | Verified on-chain | `BankPolicyEngine` gates accounts, assets, routes, collateral, and debt exposure. |
| Borrow capacity | Verified on-chain | The pool computes max borrow from collateral value and `collateralFactorBps`. |
| Liquidation health factor | Verified on-chain | The pool computes health from collateral value, debt, and `liquidationThresholdBps`. |
| Liquidation preview | Verified on-chain | The pool returns borrower-specific requested repay, actual repay, collateral seizure, remaining state, bad debt, and executable status. |
| Manual oracle update | Prototype assumption | The oracle is governed/manual in this prototype and has freshness checks. |
| Execute Timeout Refund | Script-assisted, on-chain verified | The script builds and relays the receipt absence proof; the Bank A packet handler verifies it and records timeout/refund state on-chain. |
| Demo orchestration | Script-assisted | Scripts collect headers/proofs, sequence transactions, and save reports in the local Besu/QBFT environment. |

## Proof inspector flow

Open **Technical / Thesis**.

The Proof Inspector follows this path:

Bank A / Source Chain -> Packet committed -> Trusted Besu header imported on Bank B -> Storage proof verifies the packet commitment under the trusted state root -> Voucher minted once -> Replay guard prevents duplicate receipt -> Acknowledgement is deferred for backend settlement finalization.

Use the inspector to show source/destination chain, packet ID, packet commitment, trusted height, header hash, state root, proof key, receipt status, deferred acknowledgement status, timeout status, replay protection, light-client status, freeze evidence, and recovery status.

## Appendix and recovery actions

Open **Appendix** or **Advanced Verification** for optional thesis evidence and recovery actions:

- Healthy Borrow Scenario: uses the borrower action flow.
- Repay and Withdraw Scenario: shows that repayment and withdrawal remain guarded by lending checks.
- Price Shock and Liquidation Scenario: uses the Risk Admin oracle shock and liquidation actions.
- Replay Attack Rejection Scenario: submits an already received packet proof and expects rejection.
- Timeout Refund Scenario: the UI action executes the receipt absence proof path; scripts build/relay the proof and the contract records timeout/refund state on-chain.
- Light Client Freeze and Recovery Scenario: submits conflicting-header evidence and then recovers the client.

Appendix cards show live snapshots where available. If the necessary packet, debt, proof, or client state does not exist yet, the UI labels that item as “Needs previous step” or “Script-backed” instead of pretending the flow has already run.

## Terminal demo

With Besu running:

```bash
npm run deploy
npm run seed
npm run demo
```

`npm run demo` executes a scripted appendix lifecycle, including storage-proof relay, lending, oracle shock, liquidation, denied packet, timeout absence proof, and refund observation.

If you regenerate or restart a fresh Besu network, run `npm run deploy` and `npm run seed` again before `npm run demo`. Verification scripts such as `npm run test:besu` deploy their own temporary stacks and do not replace the demo deployment config.

## What the thesis demonstrates

- Lending layer: collateralized borrowing, debt shares, borrow index interest, reserves, liquidation, and bad debt accounting.
- Cross-chain proof layer: Besu header trust, EVM storage proof verification, packet receipt replay protection, deferred acknowledgement settlement, and appendix timeout execution.
- Risk layer: governed oracle price movement, separate borrow factor and liquidation threshold, health factor changes, max-LTV enforcement, HF < 100% liquidation trigger, collateral seizure, reserve coverage, and supplier loss recording.

## Known limitations

- Single collateral asset, single debt asset, and single configured cross-chain route.
- Manual governed oracle for demo purposes.
- Role-gated liquidator in a permissioned banking-chain prototype.
- Local Besu runtime and scripted demo accounts.
- Timeout/refund proof construction remains script-assisted, while both the UI action and full terminal flow submit the proof to contracts for on-chain verification.
- The contracts and UI are thesis-grade prototypes, not audited production systems.
