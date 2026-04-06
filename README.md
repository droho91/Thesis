# Cross-Chain Lending Thesis Prototype

A research prototype that models collateralized lending across two chains.

Core lifecycle:
- Lock native collateral on the source chain
- Mint wrapped collateral on the destination chain
- Deposit wrapped collateral into a lending pool
- Borrow a stable token on the lending chain
- Burn wrapped collateral to unlock native collateral on the source chain

This repository is intentionally an educational thesis prototype, not a production protocol.

## 1. Scope and Research Goal

This project explores a practical question:

How can a user keep collateral on Chain X while borrowing on Chain Y, with basic risk controls?

Implemented capabilities:
- Two independent local chains
- Lock -> Mint -> Burn -> Unlock bridge flow
- Isolated lending pool per market
- Mock oracle pricing
- Mock swap router for repay-with-collateral
- Threshold-validator worker model
- User and owner demo portals

Out of scope (by design):
- Light-client or consensus-proof bridge security
- Optimistic proof/challenge messaging
- Production-grade oracle aggregation (TWAP, multi-source)
- Real cross-chain liquidation funding rails
- Full production hardening and governance controls

## 2. System Architecture

Two local chains are used:
- Chain A: Hardhat node (`31337`)
- Chain B: Ganache node (`31338`)

Two directional markets are deployed at the same time:
- `A_TO_B`: lock `aCOL` on A, mint `wA` on B, borrow `sB` on B
- `B_TO_A`: lock `bCOL` on B, mint `wB` on A, borrow `sA` on A

Each market has three layers:
1. Bridge transport layer
2. Lending core
3. Scripts/workers/UI

## 3. Contracts Overview

### `contracts/StableToken.sol`
Mintable ERC20 used for:
- Local collateral tokens (`aCOL`, `bCOL`)
- Stable tokens (`sA`, `sB`)

### `contracts/WrappedCollateral.sol`
Mint/burn wrapped collateral contract.
- Minted from validated lock events
- Burned during release flow to unlock source collateral

### `contracts/CollateralVault.sol`
Source-chain vault for native collateral.
- Accepts lock deposits
- Releases collateral only via validated unlock flow

### `contracts/BridgeGateway.sol`
Threshold-validator messaging gateway.
- Accepts attestations
- Executes destination action after threshold
- Supports burn requests (on mint side)

### `contracts/MockPriceOracle.sol`
Owner-set mock oracle with 8 decimals (`1 USD = 1e8`).

### `contracts/MockSwapRouter.sol`
Mock same-chain router for `repayWithCollateral`.
- Not an AMM
- Must be pre-funded with output token liquidity

### `contracts/LendingPool.sol`
Core lending logic per market.
Main functions:
- `depositCollateral`, `withdrawCollateral`, `withdrawMax`
- `borrow`
- `repay`, `repayAll`, `repayAvailable`
- `repayWithCollateral`
- `applyOverduePenalty`
- `liquidate`
- `writeOffBadDebt`

Risk is isolated per pool/market.

## 4. Risk Model and Defaults

Key parameters:
- `collateralFactorBps`
- `liquidationThresholdBps`
- `closeFactorBps`
- `liquidationBonusBps`
- `loanDuration`
- `overduePenaltyBps`
- `baseRateBps`, `slope1Bps`, `slope2Bps`, `kinkBps`

Current defaults:
- Collateral factor: `5000` (from deploy script)
- Liquidation threshold: `8500`
- Close factor: `5000`
- Liquidation bonus: `500`
- Loan duration: `3 days`
- Overdue penalty: `500`
- Base rate: `200`
- Slope1: `800`
- Slope2: `4000`
- Kink: `8000`

## 5. Oracle and Pricing Assumptions

Both tests and UI use `MockPriceOracle`:
- Prices are manually set by owner/admin
- No external market feed
- Borrow limit, HF, liquidation, and swap output depend on mock prices

Deployment baseline:
- Wrapped price = `1.0 USD`
- Stable price = `1.0 USD`

## 6. Critical Lifecycle Semantics

The bridge assumes:
- `1 locked local collateral <-> 1 minted wrapped collateral`

Important distinction:
- `withdraw` only moves wrapped collateral out of the pool
- `burn` is required to create unlock messages for source collateral

So, `Debt = 0` does **not** mean cross-chain lifecycle is complete.
A full close requires:
- Debt is zero
- Pool collateral is zero
- Wrapped wallet balance intended for release is burned
- Burn message is attested/executed
- Source collateral is unlocked

## 7. Repayment Modes and Economic Consequences

Mode A: repay with wallet stable
- `Repay Exact Amount`
- `Repay All`
- `Repay Wallet Max`

Mode B: sell wrapped collateral to repay
- `Auto Close Debt`
- `Sell Custom Amount`
- Contract path: `repayWithCollateral`

When selling collateral:
- Debt decreases
- Pool collateral decreases
- Sold wrapped amount is no longer available to burn
- Therefore, full source collateral reclaim may no longer be possible

UI intentionally separates:
- `User-Releasable Source Collateral`
- `Locked Source Backing Not Held by Borrower`

## 8. Overdue, Penalty, and Liquidation

Overdue when:
- Debt > 0
- `dueTimestamp > 0`
- `block.timestamp > dueTimestamp`

Overdue behavior:
- Borrow disabled
- Withdraw disabled
- Repay/close still allowed

`Apply Penalty`:
- Adds penalty amount to debt
- Does not "lock" a user account

`Liquidate`:
- Liquidator repays borrower debt in stable
- Receives collateral plus liquidation bonus

Dust mitigation improvements in this prototype:
- `repayAvailable()`
- `withdrawMax()`
- UI liquidation path uses `MaxUint256` instead of stale preview debt

## 9. Scripts and Runtime Roles

### `scripts/deploy-multichain.mjs`
Deploys all contracts to both chains and writes:
- `demo/multichain-addresses.json`

### `scripts/seed-multichain.mjs`
Seeds demo balances:
- User local collateral
- Pool stable liquidity
- Router stable liquidity

Default values:
- `COLLATERAL_SEED=100`
- `STABLE_LIQUIDITY=1000`
- `ROUTER_STABLE_LIQUIDITY=1000`

### `scripts/validator-worker.mjs`
- Watches lock/burn events
- Submits attestations

### `scripts/executor-worker.mjs`
- Executes mint/unlock once threshold is reached

### `scripts/worker-hub.mjs`
Starts:
- 3 validators
- 1 executor

Run only one `worker:hub` instance at a time.

## 10. UI Overview

### `demo/user.html`
Borrower portal for:
- Lock
- Deposit
- Borrow
- Repay
- Withdraw
- Burn

### `demo/owner.html`
Admin/risk portal for:
- Risk parameter updates
- Mock price updates
- Liquidity seeding helpers
- Time advancement in local dev
- Penalty and liquidation actions

Some owner actions are intentionally "demo conveniences" and not production patterns.

## 11. Generated Files

- `demo/multichain-addresses.json`: deployment output consumed by UI/workers
- `artifacts/`: Hardhat compilation artifacts
- `cache/`: build cache

## 12. Quick Start

Use 5 terminals for protocol runtime plus 1 for static UI hosting.

### Terminal 1: Chain A
```bash
npm run node:chainA
```
- RPC: `http://127.0.0.1:8545`
- Chain ID: `31337`

### Terminal 2: Chain B
```bash
npm run node:chainB
```
- RPC: `http://127.0.0.1:9545`
- Chain ID: `31338`

### Terminal 3: Deploy
```bash
npm run deploy:multichain
```

### Terminal 4: Seed
```bash
npm run seed:multichain
```

### Terminal 5: Workers
```bash
npm run worker:hub
```

### Terminal 6: Static server for demo UI
```bash
cd demo
python -m http.server 5500
```

Open:
- `http://localhost:5500/user.html`
- `http://localhost:5500/owner.html`

If UI state appears stale, fully reload (`Ctrl+F5`).

## 13. MetaMask Setup

Add both local networks:

### Chain A
- RPC URL: `http://127.0.0.1:8545`
- Chain ID: `31337`
- Currency symbol: `ETH`

### Chain B
- RPC URL: `http://127.0.0.1:9545`
- Chain ID: `31338`
- Currency symbol: `ETH`

Import local dev accounts from mnemonic:
- `Account #0`: owner
- `Account #2`: user

## 14. Recommended Demo Baseline

Per market (`A_TO_B` or `B_TO_A`):
- `Collateral factor = 5000`
- `Loan duration = 72 hours`
- `Overdue penalty = 500`
- `Liquidation bonus = 500`
- Wrapped price = `1`
- Stable price = `1`

Use the owner portal `Apply Baseline` action.

## 15. Recommended Demo Flow

### Full source-collateral release path
1. Owner applies baseline
2. User locks collateral
3. Workers mint wrapped collateral
4. User deposits wrapped collateral
5. User borrows stable
6. (Optional demo convenience) Owner mints stable to user
7. User repays (`Repay All` or `Repay Wallet Max`)
8. User withdraws (`Withdraw Max`)
9. User burns (`Burn Max`)
10. Workers execute unlock on source chain

### Debt closure via collateral sale
1. User deposits
2. User borrows
3. User runs `Auto Close Debt` or `Sell Custom Amount`
4. User withdraws remaining wrapped collateral
5. User burns remaining wrapped balance

This closes debt but may not recover all originally locked source collateral.

## 16. Test Suite

Run tests:
```bash
npm test
```

Solidity tests included:
- `test/BridgeGateway.t.sol`
- `test/CollateralVault.t.sol`
- `test/LendingPool.t.sol`
- `test/StableToken.t.sol`
- `test/WrappedCollateral.t.sol`

`LendingPool` coverage includes:
- Deposit/borrow/repay/withdraw flows
- Interest accrual behavior
- Overdue penalty path
- Liquidation mechanics
- Residual bad debt write-off
- `repayAll`, `repayAvailable`, `repayWithCollateral`, `withdrawMax`

## 17. Build and Troubleshooting

Recommended clean rebuild:
```bash
npx hardhat clean
npx hardhat compile
npm run deploy:multichain
npm run seed:multichain
```

If deployment fails with gas estimation or `CALL_EXCEPTION`:
1. Confirm optimizer is enabled in `hardhat.config.js`
2. Clean and recompile
3. Regenerate `demo/multichain-addresses.json`

If running in restricted environments (CI/containers/sandbox):
- Hardhat may need writable cache/temp directories
- You can set:
```bash
XDG_CACHE_HOME=/tmp TMPDIR=/tmp npm test
```

## 18. Known Limitations

- Mock oracle (no live feeds)
- Mock router (no real AMM liquidity)
- Threshold-validator bridge without consensus proof
- Off-chain worker polling
- Strong owner privileges for risk/liquidity setup
- Demo-only admin convenience actions
- No real cross-chain liquidator capital path
- No automated messaging-layer circuit breakers

## 19. Future Work

Priority upgrades after thesis stage:
- Optimistic or proof-based cross-chain messaging
- Multi-source oracle + TWAP
- Automated bridge/layer circuit breakers
- Cross-chain liquidation execution/funding model
- Validator economics (fees/slashing)
- More granular collateral policy per chain/market

## 20. Suggested Reading Order (Codebase)

1. `contracts/LendingPool.sol`
2. `contracts/BridgeGateway.sol`
3. `contracts/CollateralVault.sol`
4. `contracts/WrappedCollateral.sol`
5. `contracts/MockPriceOracle.sol`
6. `contracts/MockSwapRouter.sol`
7. `scripts/deploy-multichain.mjs`
8. `scripts/seed-multichain.mjs`
9. `scripts/validator-worker.mjs`
10. `scripts/executor-worker.mjs`
11. `demo/app-core.js`
12. `test/LendingPool.t.sol`

## 21. Glossary

- Source chain: chain that holds native collateral
- Lending chain: chain hosting the lending pool
- Local collateral: `aCOL` or `bCOL`
- Wrapped collateral: `wA` or `wB`
- Stable: `sA` or `sB`
- Lock: deposit native collateral into vault
- Mint: create wrapped collateral on remote chain
- Deposit: move wrapped collateral into lending pool
- Withdraw: remove wrapped collateral from lending pool
- Burn: destroy wrapped collateral to request source unlock
- Unlock: release native collateral from source vault

## 22. Thesis Positioning Note

This repository is intended to demonstrate architecture, risk semantics, and end-to-end lifecycle behavior for academic evaluation. It is not intended for real fund custody or production deployment.
