# Demo Flow

This demo is a thesis prototype for a permissioned banking-chain setting. It combines a Bank B lending pool with a Besu-first light-client and EVM storage-proof packet lane. It is not production-ready, audited, mainnet-ready, or a decentralized market-oracle system.

## Start the local demo

```bash
npm install
npm run besu:generate
npm run besu:up
npm run demo:ui
```

Open:

```text
http://127.0.0.1:5173/
```

Use **Prepare Demo Account** to reuse an already seeded local runtime. Use **Fresh Reset** from Demo Tools when you need a clean deployment.

## Borrower flow

1. Prepare the demo account.
2. Bridge collateral from Bank A to Bank B.
3. Import the Bank A Besu header on Bank B and verify the storage proof.
4. Receive the voucher collateral.
5. Deposit voucher collateral into the Bank B lending pool.
6. Borrow bCASH within available borrow capacity.
7. Repay debt or withdraw collateral while health checks remain satisfied.

The Borrower Portal shows collateral value, current debt, available borrow, health factor, position guidance, and recent activity.

Repay and withdraw actions update their own trace fields and the live position view. They do not overwrite the liquidation-specific “After Liquidation” snapshot.

Borrow capacity is based on `collateralFactorBps`. Liquidation risk is based on the separate `liquidationThresholdBps`, so a borrower can be inside the borrow limit while still carrying a thinner health-factor buffer.

## Admin liquidation flow

Open **Risk Admin**.

1. Review the governed demo oracle prices, collateral value, debt, available borrow, borrow capacity, liquidation threshold value, health factor, collateral factor / max LTV, liquidation threshold, liquidation trigger, utilization, reserves, and bad debt.
2. Set or accept the shock price and run **Simulate Oracle Shock**.
3. Compare health factor before and after the price drop.
4. Review the liquidation preview: repay amount, seized collateral, remaining debt, remaining collateral, bad debt, reserve use, and supplier loss.
5. Run **Execute Liquidation** when the account is liquidatable.
6. Review the after-liquidation state and transaction hash. This section stays blank until **Execute Liquidation** has actually produced a liquidation transaction.

The oracle is intentionally labeled as a governed demo oracle. It is manual and demo-only, not a decentralized market oracle.

The liquidation preview uses the current on-chain oracle state. Run **Simulate Oracle Shock** before expecting executable liquidation values to change. A higher oracle price update is allowed because this is a governed oracle update, but it is not a downside shock.

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
| Timeout model button | Visualization only | The UI explains receipt absence; the full script exercises the on-chain timeout path. |
| Demo orchestration | Script-assisted | Scripts collect headers/proofs, sequence transactions, and save reports in the local Besu/QBFT environment. |

## Proof inspector flow

Open **Technical / Thesis**.

The Proof Inspector follows this path:

Bank A / Source Chain -> Packet committed -> Trusted Besu header imported on Bank B -> Storage proof verifies the packet commitment under the trusted state root -> Voucher minted once -> Replay attempt rejected -> Acknowledgement or timeout finalizes lifecycle.

Use the inspector to show source/destination chain, packet ID, packet commitment, trusted height, header hash, state root, proof key, receipt status, acknowledgement status, timeout status, replay protection, light-client status, freeze evidence, and recovery status.

## Scenario panel

Open **Scenarios** for defense-ready flows:

- Healthy Borrow Scenario: uses the borrower action flow.
- Repay and Withdraw Scenario: uses existing repayment and withdrawal actions.
- Price Shock and Liquidation Scenario: uses the Risk Admin oracle shock and liquidation actions.
- Replay Attack Rejection Scenario: submits an already received packet proof and expects rejection.
- Timeout Refund Scenario: the UI shows the timeout absence model; the full refund path is exercised by `npm run demo`.
- Light Client Freeze and Recovery Scenario: submits conflicting-header evidence and then recovers the client.

Scenario cards show live snapshots where available. If the necessary packet, debt, proof, or client state does not exist yet, the UI labels that scenario as “Needs previous step” or “Script-backed” instead of pretending the flow has already run.

## Terminal demo

With Besu running:

```bash
npm run deploy
npm run seed
npm run demo
```

`npm run demo` executes the full scripted lifecycle, including storage-proof relay, lending, oracle shock, liquidation, denied packet, timeout absence proof, and refund observation.

If you regenerate or restart a fresh Besu network, run `npm run deploy` and `npm run seed` again before `npm run demo`. Verification scripts such as `npm run test:besu` deploy their own temporary stacks and do not replace the demo deployment config.

## What the thesis demonstrates

- Lending layer: collateralized borrowing, debt shares, borrow index interest, reserves, liquidation, and bad debt accounting.
- Cross-chain proof layer: Besu header trust, EVM storage proof verification, packet receipt replay protection, acknowledgements, and timeout execution in the scripted flow.
- Risk layer: governed oracle price movement, separate borrow factor and liquidation threshold, health factor changes, max-LTV enforcement, HF < 100% liquidation trigger, collateral seizure, reserve coverage, and supplier loss recording.

## Known limitations

- Single collateral asset, single debt asset, and single configured cross-chain route.
- Manual governed oracle for demo purposes.
- Role-gated liquidator in a permissioned banking-chain prototype.
- Local Besu runtime and scripted demo accounts.
- Some timeout/refund details are script-driven and visible in the UI after running the full terminal flow.
- The contracts and UI are thesis-grade prototypes, not audited production systems.
