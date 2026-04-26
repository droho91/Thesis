# Cross-Chain Lending Demo

This repository contains a Besu-first cross-chain lending prototype for two permissioned EVM bank chains. The active model keeps the thesis architecture intact: a Besu light client verifies remote chain state, storage proofs prove packet commitments, an IBC-like lane relays packets, institutional policy gates application actions, and canonical collateral locked on Bank A is represented by a voucher on Bank B.

The lending layer is now a real single-market pool rather than a principal-only demo. Bank B suppliers deposit the debt asset and receive liquidity shares. Borrowers deposit voucher collateral represented from Bank A, borrow against policy and risk limits, accrue debt through a borrow index, and can be liquidated on accrued debt after price or interest movement.

## Thesis Defense Positioning

This project is a permissioned cross-chain lending prototype that demonstrates proof-checked cross-chain collateral representation, policy-controlled borrowing, and risk-based liquidation under a controlled Besu/QBFT environment. It is intended for academic demonstration and is not production-ready or audited.

The project does not claim to be a permissionless public bridge, a decentralized oracle system, or a production lending market. Its technical contribution is the combination of cross-chain collateral representation, proof-checked packet execution, policy-controlled lending, oracle-based valuation, health-factor-based liquidation, a Besu/QBFT light-client boundary, and UI portals for borrower, risk admin, and proof inspection.

## Architecture

- `contracts/clients/*`: Besu/QBFT light-client verification.
- `contracts/core/IBCEVMProofBoundary.sol` and `IBCProofVerifier.sol`: EVM storage proof boundary.
- `contracts/core/IBCConnectionKeeper.sol`, `IBCChannelKeeper.sol`, `IBCPacketHandler.sol`, `IBCPacketStore.sol`: proof-checked connection/channel state and packet relay.
- `contracts/apps/PolicyControlledTransferApp.sol`: policy-aware bridge application.
- `contracts/apps/PolicyControlledEscrowVault.sol`: pooled canonical asset escrow on the source chain.
- `contracts/apps/PolicyControlledVoucherToken.sol`: single-canonical-asset voucher on the destination chain.
- `contracts/apps/BankPolicyEngine.sol`: institutional allowlists, caps, and exposure accounting.
- `contracts/apps/PolicyControlledLendingPool.sol`: supplier shares, borrower debt shares, lazy interest accrual, reserves, liquidation, and bad-debt recognition.
- `scripts/*`: Besu deployment, seeding, proof relay, and thesis demo flows.

## Security Model

Packet commitments are source-app authorized. `IBCPacketStore.commitPacket` only accepts calls from a registered packet writer, and the caller must equal `packet.source.port`, which prevents arbitrary callers from consuming packet sequence numbers or forging commitments.

The transfer app enforces a one-route, one-canonical-asset invariant. Packets whose `transferData.asset` does not match the configured route canonical asset are rejected, voucher mint/burn checks the bound canonical asset, and escrow only releases its own canonical token.

The escrow vault uses pooled accounting: `totalEscrowed` represents canonical liabilities held by the vault, and unlock/refund packet IDs are processed once. It no longer tries to decrement unrelated recipient balances.

Operational contracts include emergency pause controls for packet send/receive, escrow lock/unlock, voucher transfer/mint/burn, and lending market state transitions.

## Feature Status

| Feature | Status | Explanation |
| --- | --- | --- |
| Packet execution proof | Verified on-chain | The packet handler checks storage proof data against the configured light-client/proof-verifier boundary. |
| Packet receipt replay protection | Verified on-chain | Packet receipts prevent the same packet proof from executing twice. |
| Timeout absence path | Script-assisted / visualization | Full timeout execution is covered by scripts; the browser button can also mark the timeout model for explanation. |
| Manual oracle update | Prototype assumption | Prices are set by governed demo operators and checked for freshness, not sourced from a decentralized oracle. |
| Policy allowlist and caps | Verified on-chain | `BankPolicyEngine` enforces account, asset, route, and exposure controls. |
| Borrow capacity | Verified on-chain | The lending pool uses collateral value and `collateralFactorBps`. |
| Liquidation health factor | Verified on-chain | The lending pool uses oracle value, debt state, and `liquidationThresholdBps`. |
| Liquidation preview | Verified on-chain | `previewLiquidation` reads borrower debt/collateral and returns capped repay, seize, remaining state, bad debt, and executable status. |
| Risk/Admin UI | UI visualization | The UI reads contract state and demo traces; it does not replace on-chain validation. |

## Lending Mechanics

The lending pool is a single market with one collateral token and one debt token:

- Suppliers call `depositLiquidity` and receive liquidity shares.
- Suppliers call `withdrawLiquidity` or `redeemLiquidity` subject to available cash.
- Borrowers deposit voucher collateral and borrow debt-token liquidity.
- Borrower debt is tracked as shares against `borrowIndexE18`.
- Interest accrues lazily on state-changing actions or explicit `accrueInterest()`.
- Borrow APR follows a utilization model with base rate, kink, slope 1, and slope 2.
- A reserve factor diverts part of accrued interest to protocol reserves.
- Borrow capacity uses `collateralFactorBps`; health factor and liquidation eligibility use the separate `liquidationThresholdBps`.
- Health factor, borrow limits, and liquidation use accrued debt.
- If liquidation exhausts collateral and debt remains, the pool writes off the remaining debt, uses reserves first, and records supplier loss in `totalBadDebt`.

Policy caps still apply to principal borrowing. Interest is economic debt in the pool, while the policy engine tracks institutional principal exposure and explicit write-offs.

## Oracle Assumptions

`ManualAssetOracle` is a governed demo oracle with timestamped prices. It reverts when a price is missing or stale. The lending pool no longer falls back to 1:1 pricing; valuation requires an explicit oracle.

This is appropriate for the thesis prototype because price publication is governed by the permissioned bank environment. It is not a production decentralized oracle network.

## Install

```bash
npm install
```

If Hardhat cache/temp writes fail in WSL, run commands with explicit temp paths:

```bash
TMPDIR=/tmp XDG_CACHE_HOME=/tmp/.cache npm run compile
TMPDIR=/tmp XDG_CACHE_HOME=/tmp/.cache npm test
```

## Run Solidity Tests

```bash
npm run compile
npm test
```

`npm test` and `npm run test:solidity` both run the Solidity test suite.

## Run The Besu Demo

Start two local Besu QBFT bank chains:

```bash
npm run besu:generate
npm run besu:up
```

Start the browser controller:

```bash
npm run demo:ui
```

Open:

```text
http://127.0.0.1:5173/
```

Use `Prepare Demo Account` or `Fresh Reset`, then run the flow step by step or use `Run Guided Lifecycle`.

For the thesis-defense walkthrough, including the Borrower Portal, Risk Admin liquidation console, Proof Inspector, scenario panel, and known limitations, see [DEMO_FLOW.md](./DEMO_FLOW.md). For trust assumptions and limitations, see [docs/THREAT_MODEL.md](./docs/THREAT_MODEL.md).

## Run The Demo From Terminal

With Besu running:

```bash
npm run besu:demo
```

`npm run besu:demo` compiles, deploys, seeds, and then runs the terminal walkthrough against the currently running Besu chains. If you already have a fresh seeded deployment and only want to replay the terminal flow, use `npm run demo`.

The seed script now deposits Bank B supplier liquidity through the lending pool instead of minting debt tokens directly into the pool.

After `npm run besu:generate` or a fresh Besu network reset, run `npm run deploy` and `npm run seed` before `npm run demo`. The `npm run test:besu` verification lanes deploy temporary contracts for reports; they do not seed the browser/terminal demo stack.

## Run Besu Verification Tests

With Besu running:

```bash
npm run test:besu
```

Individual verification lanes are also available:

```bash
npm run verify:light-client
npm run verify:storage-proof
npm run verify:packet-relay
npm run verify:policy-packet
npm run verify:timeout-height
npm run verify:timeout-timestamp
```

## Stop Besu

```bash
npm run besu:down
```

## Generated Local Files

The demo can generate local runtime files such as `.interchain-lending.local.json`, `demo/latest-run.json`, `demo/latest-run.js`, and verification reports. They are runtime outputs, not source files.

## Remaining Prototype Limits

The market is intentionally single-asset and single-route. Oracle updates are governed and manual. Liquidation is role-gated for the institutional setting. The contracts are thesis-grade prototypes and have not been audited for production deployment.
