# Cross-Chain Lending System Test Plan

This document focuses on system-level testing.

It validates:
- End-to-end behavior across two local chains
- Integration between contracts, workers, and UI
- Actor-based workflows (Owner, User, Validators, Executor)

It is complementary to `docs/TEST_CASES.md`:
- `TEST_CASES.md` = unit and feature-level matrix
- `SYSTEM_TESTS.md` = scenario-based end-to-end validation

## 1. System Test Objectives

The system test suite should prove:
1. `lock -> mint -> burn -> unlock` works across chains
2. Lending operations work on the destination chain
3. Owner controls correctly update market risk behavior
4. Workers process attest/execute flows without replay
5. UI reflects on-chain state and workflow semantics correctly

## 2. Test Scope

Included in scope:
- Chain A and Chain B local nodes
- `deploy:multichain`
- `seed:multichain`
- `worker:hub`
- `demo/user.html`
- `demo/owner.html`

Out of scope:
- Production bridge security proofs
- Byzantine validator simulation
- Deep RPC outage/recovery chaos tests
- Chain reorg/fork fault injection

## 3. Prerequisites

## 3.1 Start Full Local Stack

Open terminals in this order:

Terminal 1:
```bash
npm run node:chainA
```

Terminal 2:
```bash
npm run node:chainB
```

Terminal 3:
```bash
npm run deploy:multichain
```

Terminal 4:
```bash
npm run seed:multichain
```

Terminal 5:
```bash
npm run worker:hub
```

Terminal 6:
```bash
cd demo
python -m http.server 5500
```

Open:
- `http://localhost:5500/user.html`
- `http://localhost:5500/owner.html`

## 3.2 Wallet Setup

Configure MetaMask networks:
- Chain A: `31337`
- Chain B: `31338`

Use accounts:
- Owner: account index `0`
- User: account index `2`

## 3.3 Baseline Configuration

For both markets (`A_TO_B`, `B_TO_A`), apply:
- Collateral factor: `5000`
- Loan duration: `72h`
- Overdue penalty: `500`
- Liquidation bonus: `500`
- Wrapped price: `1.0`
- Stable price: `1.0`

## 4. Pass/Fail Criteria

A system scenario is pass when:
1. Transactions succeed/revert exactly as expected
2. Worker logs show expected attest/execute sequence
3. UI state after refresh matches on-chain state
4. No contradictory state across:
   - debt
   - collateral in pool
   - wrapped wallet balance
   - locked source collateral

## 5. Core System Scenarios

## ST-01 Cold Boot

Goal:
- Verify clean startup from zero running processes

Steps:
1. Start both chains
2. Deploy multi-chain stack
3. Seed balances
4. Start worker hub
5. Open both portals

Expected:
- `demo/multichain-addresses.json` is generated
- Workers run (3 validators + 1 executor)
- No UI runtime errors

## ST-02 Owner Baseline Configuration

Goal:
- Verify owner can configure risk and mock prices

Steps:
1. Connect owner wallet on `owner.html`
2. Select `A_TO_B`
3. Apply baseline values
4. Refresh

Expected:
- Risk params updated on chain
- Prices updated on chain
- Owner metrics reflect changes

## ST-03 A_TO_B Bridge Mint Flow

Goal:
- Verify lock on source mints wrapped collateral on destination

Steps:
1. Connect user on `user.html`
2. Select `A_TO_B`
3. On Chain A, lock `40 aCOL`
4. Wait for workers
5. Refresh

Expected:
- User `aCOL` wallet decreases by 40
- Source locked balance increases by 40
- Worker logs include lock attest + execute mint
- User `wA` wallet on Chain B increases by 40

## ST-04 A_TO_B Full Clean Lifecycle (Wallet Repay)

Goal:
- Verify full close using wallet stable repayment

Steps:
1. Continue from ST-03
2. Deposit `wA`
3. Borrow `sB`
4. Ensure user has enough `sB` to repay
5. Repay all
6. Withdraw max
7. Burn max
8. Wait for unlock execution
9. Refresh

Expected:
- Debt = 0
- Pool collateral = 0
- Wrapped wallet = 0
- Source locked collateral fully released

## ST-05 A_TO_B Close Debt with Collateral Sale

Goal:
- Verify `repayWithCollateral` behavior and accounting semantics

Steps:
1. Lock and mint wrapped collateral
2. Deposit and borrow
3. Use `Auto Close Debt` or `Sell Custom Amount`
4. Refresh

Expected:
- Debt decreases or closes
- Pool collateral decreases
- User releasable source collateral is reduced accordingly
- UI clearly distinguishes releasable vs residual locked backing

## ST-06 B_TO_A Symmetry

Goal:
- Verify reverse market behaves symmetrically

Steps:
1. Switch to `B_TO_A`
2. Repeat lock/mint/lend/repay/release flow

Expected:
- Same functional behavior as `A_TO_B`
- No state leakage between market directions

## ST-07 Overdue Without Penalty

Goal:
- Verify overdue state before penalty application

Steps:
1. Open debt position
2. Advance time beyond `loanDuration`
3. Refresh

Expected:
- Status becomes overdue
- Borrow and withdraw are blocked
- Repay remains available
- Penalty is still zero until explicitly applied

## ST-08 Apply Overdue Penalty

Goal:
- Verify one-time overdue penalty application

Steps:
1. Start from overdue state
2. Owner clicks `Apply Penalty`
3. Refresh both portals

Expected:
- Penalty amount > 0
- Total debt increases
- Re-applying in same overdue cycle fails

## ST-09 Liquidation of Overdue Position

Goal:
- Verify overdue liquidation path and post-state consistency

Steps:
1. Create overdue debt position
2. Trigger liquidation from owner side
3. Refresh

Expected:
- Debt is reduced or closed
- Collateral is transferred to liquidator path
- If debt reaches zero, due state resets
- Any residual debt must be explainable by collateral-value cap

## ST-10 Price Shock Liquidation

Goal:
- Verify liquidation trigger by health-factor drop

Steps:
1. Create near-limit borrowed position
2. Decrease wrapped collateral price
3. Refresh and verify HF < 1
4. Liquidate

Expected:
- Position becomes liquidatable before overdue
- Liquidation respects close factor and collateral-value cap

## ST-11 Repay Wallet Max Regression

Goal:
- Verify no stale-preview dust from UI

Steps:
1. Create debt and keep stable in user wallet
2. Use `Repay Wallet Max`
3. Refresh

Expected:
- Debt repayment uses on-chain wallet balance in tx
- No extra manual retry due only to stale preview

## ST-12 Withdraw Max Regression

Goal:
- Verify withdraw max is atomic with fresh on-chain state

Steps:
1. Create withdrawable collateral state
2. Use `Withdraw Max`
3. Refresh

Expected:
- Correct max amount is withdrawn
- No input amount required
- No preview drift failure

## ST-13 Burn Max Regression

Goal:
- Verify full wallet wrapped burn request path

Steps:
1. Ensure user has wrapped tokens in wallet
2. Click `Burn Max`
3. Wait for workers
4. Refresh

Expected:
- Wrapped wallet balance goes to 0
- Burn request is attested and executed
- Source collateral unlock follows

## ST-14 Liquidation Dust Regression

Goal:
- Verify liquidation path minimizes stale-preview under-repayment

Steps:
1. Create liquidatable position
2. Liquidate from owner portal
3. Refresh

Expected:
- No avoidable residual debt due to stale UI preview
- Residual debt (if any) is only from protocol constraints

## ST-15 Post-Liquidation User Semantics

Goal:
- Verify user portal does not overstate reclaimable collateral

Steps:
1. Liquidate an active position
2. Open user portal and refresh

Expected:
- UI correctly shows reduced releasable source collateral
- Residual locked backing is not presented as fully recoverable

## ST-16 Cross-Market Isolation

Goal:
- Verify A_TO_B and B_TO_A states remain isolated

Steps:
1. Open positions in both directions
2. Perform repay/withdraw on one market
3. Refresh the other market

Expected:
- No unintended state coupling

## 6. Operational Evidence Checklist

Collect these artifacts before demo:
1. `deploy:multichain` output
2. `seed:multichain` output
3. `worker:hub` logs showing attest/execute cycles
4. Screenshots of key states in user and owner portals
5. One successful run of each major scenario group:
   - clean full lifecycle
   - collateral-close lifecycle
   - overdue+penalty+liquidation lifecycle
