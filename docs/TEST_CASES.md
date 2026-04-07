# Cross-Chain Lending Test Cases

This document is the current test matrix for the thesis prototype.

It covers:
- Smart-contract unit tests
- Integration assumptions between contracts and workers
- Manual UI action checks for `user.html` and `owner.html`
- Regression checks for stale preview, replay protection, and dust behavior

## 1. Scope and Intent

Test coverage is organized into 4 layers:
1. Core contracts
2. Bridge worker behavior
3. User portal actions
4. Owner portal actions

Each test should verify one of these outcomes:
1. Happy path success
2. Validation/revert behavior
3. State transition correctness
4. Regression safety

## 2. Standard Local Environment

## 2.1 Chains

- Chain A RPC: `http://127.0.0.1:8545` (chainId `31337`)
- Chain B RPC: `http://127.0.0.1:9545` (chainId `31338`)

## 2.2 Actors

- Owner: account index `0`
- User: account index `2`
- Validators: account indices `1`, `3`, `4`

## 2.3 Seed Baseline

Expected seeded balances:
- `100 aCOL` to user on Chain A
- `100 bCOL` to user on Chain B
- `1000 sA` to lending pool on Chain A
- `1000 sB` to lending pool on Chain B
- `1000 sA` to router on Chain A
- `1000 sB` to router on Chain B

## 2.4 Baseline Risk Profile

- `collateralFactorBps = 5000`
- `liquidationThresholdBps = 8500`
- `closeFactorBps = 5000`
- `loanDuration = 72h`
- `overduePenaltyBps = 500`
- `liquidationBonusBps = 500`
- `wrapped price = 1.0`
- `stable price = 1.0`

## 3. Current Automated Unit Tests

This section is synchronized with the current test files.

## 3.1 `test/StableToken.t.sol`

Implemented tests:
- `testOwnerCanMint`
- `testMintRevertsIfNotOwner`
- `testMintRevertsForZeroAmount`
- `testMintRevertsForZeroAddress`

Invariants proven:
- Only owner can mint
- Mint requires non-zero amount and non-zero recipient

## 3.2 `test/WrappedCollateral.t.sol`

Implemented tests:
- `testBridgeCanMintAndBurn`
- `testMintRevertsIfNotBridge`
- `testBurnRevertsIfNotBridge`
- `testMintFromLockEventPreventsReplay`

Invariants proven:
- Only bridge can mint/burn
- Lock event replay is blocked

## 3.3 `test/CollateralVault.t.sol`

Implemented tests:
- `testLockUpdatesBalanceAndTransfersToken`
- `testUnlockByBridgeWorks`
- `testUnlockRevertsIfCallerIsNotBridge`
- `testUnlockRevertsIfAmountExceedsLocked`
- `testUnlockFromBurnEventPreventsReplay`
- `testLockRevertsForZeroAmount`
- `testUnlockRevertsForZeroEventId`

Invariants proven:
- Lock updates accounting and transfers collateral
- Only bridge can unlock
- Unlock cannot exceed user locked amount
- Burn event replay is blocked

## 3.4 `test/BridgeGateway.t.sol`

Implemented tests:
- `testThresholdAttestThenExecute`
- `testValidatorCannotAttestTwice`
- `testOnlyValidatorCanAttest`
- `testRequestBurnCallsTargetBurn`
- `testPauseBlocksAttestExecuteAndBurn`
- `testTxCapBlocksAttestExecuteAndBurn`
- `testExecuteCannotReplayAfterSuccess`
- `testInitializeTargetOnlyOnce`
- `testInitializeSourceEmitterOnlyOnce`
- `testRequestBurnRevertsWhenBurnDisabled`
- `testAttestAndExecuteRequireInitializedTarget`
- `testAttestAndExecuteRequireInitializedSourceEmitter`
- `testExecuteBubblesTargetRevertReason`
- `testUnlockGatewayExecutesUnlockSelector`
- `testOnlyOwnerCanSetTxCap`
- `testSetTxCapUpdatesValue`

Invariants proven:
- Threshold attestation is required before execute
- Double attestation and execute replay are blocked
- Initialization gates are enforced
- Pause and tx cap gates are enforced
- Owner-only governance setters are enforced
- Gateway supports both action selectors:
  - lock -> mint
  - burn -> unlock

## 3.5 `test/LendingPool.t.sol`

Implemented tests:
- `testDepositAndBorrowWithinLtv`
- `testBorrowRevertsIfLtvExceeded`
- `testWithdrawRevertsIfItBreaksLtv`
- `testRepayThenWithdrawAllCollateral`
- `testRepayAllClearsAccruedDebtAndAllowsFullWithdraw`
- `testRepayAvailableUsesCurrentWalletBalanceAndClearsDebtWhenSufficient`
- `testRepayWithCollateralReducesDebtWithoutExternalStable`
- `testRepayWithCollateralCanFullyClosePositionThenWithdrawRemainder`
- `testWithdrawMaxUsesFreshStateAndWithdrawsAllWhenDebtIsZero`
- `testOwnerCanUpdateRiskAndInterestParams`
- `testRiskUpdatesRevertForNonAdmin`
- `testAccrueInterestIncreasesDebt`
- `testInterestDoesNotCompoundOnPriorInterest`
- `testPenaltyDoesNotAccrueAdditionalInterest`
- `testUtilizationAndBorrowRateIncreaseAfterBorrow`
- `testOverduePenaltyFlow`
- `testBorrowAndWithdrawRevertWhenOverdue`
- `testHealthFactorLiquidationWhenPriceDrops`
- `testLiquidateOverdueResetsDebtAndTransfersCollateral`
- `testLiquidationRepayIsCappedByCollateralValue`
- `testWriteOffBadDebtClearsResidualInsolventPosition`
- `testPauseBlocksBorrowAndUnpauseRestores`
- `testIsLiquidatableTrueWhenOverdue`

Invariants proven:
- LTV/withdraw limits are enforced
- Debt repayment modes are correct (`repay`, `repayAll`, `repayAvailable`, `repayWithCollateral`)
- Interest accrues on principal and does not compound on interest
- Overdue and penalty semantics are correct
- Liquidation is bounded by close factor and collateral value
- Insolvent residual debt can be written off by risk admin
- Pause/unpause and `isLiquidatable` behavior is validated

## 4. Bridge Worker Integration Checks

Files:
- `scripts/validator-worker.mjs`
- `scripts/executor-worker.mjs`
- `scripts/worker-hub.mjs`

Required checks:
1. Validator worker attests lock and burn messages exactly once per validator
2. Executor worker executes only when threshold is reached
3. Executed messages are not replayed in later cycles
4. Both markets (`A_TO_B`, `B_TO_A`) process independently

Evidence to collect:
- Worker logs showing attest and execute entries for both lock and burn flows

## 5. Manual UI Action Matrix

## 5.1 User Portal (`demo/user.html`)

Actions to validate:
- `lockBtn`
- `depositBtn`
- `borrowBtn`
- `repayBtn`
- `repayMaxBtn`
- `repayAllBtn`
- `autoCloseDebtBtn`
- `closeWithCollateralBtn`
- `withdrawBtn`
- `withdrawMaxBtn`
- `requestBurnBtn`
- `burnMaxBtn`

Per action, verify:
1. Guard state (disabled reason text) is correct
2. Transaction succeeds or reverts with expected reason
3. Position summary values update after refresh
4. Bridge queue/timeline updates when applicable

## 5.2 Owner Portal (`demo/owner.html`)

Actions to validate:
- `applyRiskProfileBtn`
- `updateFactorBtn`
- `updateDurationBtn`
- `updatePenaltyBtn`
- `updateBonusBtn`
- `updateCollateralPriceBtn`
- `updateStablePriceBtn`
- `mintCollateralToUserBtn`
- `mintStableToUserBtn`
- `mintStableToPoolBtn`
- `advanceTimeBtn`
- `applyPenaltyBtn`
- `liquidateBtn`

Per action, verify:
1. Correct chain-role guard behavior
2. Correct on-chain parameter/state change
3. User portal reflects new state after refresh

## 6. Regression Checklist Before Thesis Demo

Run this short list before presentation:
1. `npm run deploy:multichain`
2. `npm run seed:multichain`
3. `npm run worker:hub`
4. Execute one full clean cycle (`lock -> mint -> deposit -> borrow -> repayAll -> withdrawMax -> burnMax -> unlock`)
5. Execute one collateral-close cycle (`repayWithCollateral`) and verify reduced releasable source collateral
6. Execute one overdue + penalty + liquidation cycle
7. Validate both market directions (`A_TO_B` and `B_TO_A`)

## 7. Notes

- This is an educational thesis prototype, not a production protocol.
- Security assumptions (trusted worker set, no light-client proof system) are deliberate and should be stated during presentation.
