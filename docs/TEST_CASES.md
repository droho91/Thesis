# Cross-Chain Lending Test Cases

Tai lieu nay la test matrix de cover:

- tat ca contract flow chinh
- tat ca nut trong `user.html`
- tat ca nut trong `owner.html`
- bridge workers
- edge cases va regression quan trong

Tai lieu nay uu tien **practical coverage** cho thesis prototype, khong co tham vong liet ke tat ca fuzz state co the co cua EVM.

## 1. Muc tieu test

Can xac minh 4 lop:

1. `Core smart contracts`
2. `Bridge worker flow`
3. `User portal actions`
4. `Owner portal actions`

Can cover 4 loai tinh huong:

1. `Happy path`
2. `Validation / revert path`
3. `State transition edge case`
4. `Regression / no-dust / no-stale semantics`

## 2. Môi truong test chuan

### 2.1 Local infrastructure

- Chain A:
  - RPC: `http://127.0.0.1:8545`
  - chainId: `31337`
- Chain B:
  - RPC: `http://127.0.0.1:9545`
  - chainId: `31338`

### 2.2 Actors

- Owner: `Account #0`
- User: `Account #2`
- Validators:
  - `Account #1`
  - `Account #3`
  - `Account #4`

### 2.3 Baseline data

Seed baseline:

- `100 aCOL` to user on Chain A
- `100 bCOL` to user on Chain B
- `1000 sA` to pool on Chain A
- `1000 sB` to pool on Chain B
- `1000 sA` to router on Chain A
- `1000 sB` to router on Chain B

### 2.4 Baseline risk profile

- `collateralFactorBps = 5000`
- `loanDuration = 72 hours`
- `overduePenaltyBps = 500`
- `liquidationBonusBps = 500`
- wrapped price = `1`
- stable price = `1`

## 3. Test coverage map

### 3.1 User Portal buttons

User actions from `demo/app-core.js`:

- `lockBtn`
- `depositBtn`
- `borrowBtn`
- `repayBtn`
- `repayMaxBtn`
- `repayAllBtn`
- `withdrawMaxBtn`
- `burnMaxBtn`
- `autoCloseDebtBtn`
- `closeWithCollateralBtn`
- `withdrawBtn`
- `requestBurnBtn`
- `connectBtn`
- `refreshBtn`

### 3.2 Owner Portal buttons

Owner actions from `demo/app-core.js`:

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
- `connectBtn`
- `refreshBtn`

## 4. Contract-level test cases

## 4.1 `StableToken.sol`

### ST-01 Deploy token

- Step:
  - deploy token with name + symbol
- Expected:
  - metadata set correctly

### ST-02 Mint by owner/admin path

- Step:
  - mint to arbitrary address
- Expected:
  - receiver balance increases

### ST-03 Transfer between accounts

- Step:
  - transfer minted balance
- Expected:
  - sender and receiver balances update correctly

### ST-04 Approve + transferFrom

- Step:
  - approve spender
  - spender transfers
- Expected:
  - allowance decreases
  - balances update correctly

## 4.2 `WrappedCollateral.sol`

### WC-01 Mint from bridge

- Step:
  - call `mintFromLockEvent(...)` from authorized bridge address
- Expected:
  - wrapped balance increases
  - lock event id consumed as expected

### WC-02 Unauthorized mint fails

- Step:
  - non-bridge caller tries mint
- Expected:
  - revert

### WC-03 Burn path

- Step:
  - burn user wrapped amount through allowed burn path
- Expected:
  - wrapped total supply decreases

### WC-04 Replay protection on same lock event

- Step:
  - try mint same lock event twice
- Expected:
  - second mint rejected

## 4.3 `CollateralVault.sol`

### CV-01 Lock local collateral

- Step:
  - approve vault
  - deposit / lock local collateral
- Expected:
  - user local collateral decreases
  - vault locked balance increases
  - lock event emitted

### CV-02 Lock without allowance fails

- Expected:
  - revert from ERC20 allowance path

### CV-03 Lock zero amount fails

- Expected:
  - revert

### CV-04 Unlock from valid burn message

- Step:
  - simulate authorized unlock gateway
- Expected:
  - vault releases correct local collateral amount

### CV-05 Unauthorized unlock fails

- Expected:
  - revert

### CV-06 Unlock replay fails

- Step:
  - same burn message processed twice
- Expected:
  - second execution rejected

## 4.4 `BridgeGateway.sol`

### BG-01 Initialize target once

- Expected:
  - first init succeeds
  - second init fails

### BG-02 Request burn emits message

- Step:
  - user requests burn on wrapped chain
- Expected:
  - burn request recorded
  - event emitted

### BG-03 Attest lock message

- Step:
  - validator 1 attests
  - validator 2 attests
- Expected:
  - attest count increases
  - threshold reached after second validator

### BG-04 Duplicate validator attestation fails

- Step:
  - same validator attests same message twice
- Expected:
  - second attestation rejected

### BG-05 Non-validator attestation fails

- Expected:
  - revert

### BG-06 Execute before threshold fails

- Expected:
  - revert

### BG-07 Execute mint after threshold

- Expected:
  - target mint contract called
  - message marked executed

### BG-08 Execute unlock after threshold

- Expected:
  - target unlock contract called
  - message marked executed

### BG-09 Execute replay fails

- Expected:
  - second execute rejected

### BG-10 Pause blocks request/attest/execute

- Expected:
  - actions fail while paused

### BG-11 Tx cap enforced

- Step:
  - request amount above cap
- Expected:
  - rejected

## 4.5 `MockPriceOracle.sol`

### OR-01 Set and get price

- Expected:
  - stored price matches input

### OR-02 Update price overwrites prior value

- Expected:
  - latest value returned

### OR-03 Unset price behavior

- Expected:
  - verify current contract semantics

## 4.6 `MockSwapRouter.sol`

### SW-01 Swap wrapped to stable at 1:1

- Given:
  - wrapped price = 1
  - stable price = 1
  - fee = 0
- Expected:
  - 10 wrapped in => 10 stable out

### SW-02 Swap respects fee

- Given:
  - fee > 0
- Expected:
  - output reduced by fee

### SW-03 Swap fails if router lacks stable liquidity

- Expected:
  - revert

### SW-04 Swap fails for zero amount

- Expected:
  - revert

## 4.7 `LendingPool.sol`

### LP-01 Deposit collateral

- Expected:
  - `collateralAmount` increases

### LP-02 Deposit zero fails

- Expected:
  - revert `AMOUNT_ZERO`

### LP-03 Borrow within limit

- Given:
  - collateral 100
  - factor 50%
- Step:
  - borrow 40
- Expected:
  - principal = 40
  - stable wallet increases

### LP-04 Borrow above limit fails

- Step:
  - borrow 60 on same state
- Expected:
  - revert `LTV_EXCEEDED`

### LP-05 Withdraw exact with zero debt

- Expected:
  - full collateral withdraws

### LP-06 Withdraw exact while debt still healthy

- Expected:
  - partial withdraw allowed if still within limit

### LP-07 Withdraw exact breaks LTV

- Expected:
  - revert `LTV_EXCEEDED`

### LP-08 Withdraw max with zero debt

- Expected:
  - withdraws all collateral

### LP-09 Withdraw max with debt

- Expected:
  - withdraws exact max on-chain amount
- Regression:
  - no preview drift issue

### LP-10 Withdraw max with nothing to withdraw

- Expected:
  - revert `NOTHING_TO_WITHDRAW`

### LP-11 Repay exact partial amount

- Expected:
  - penalty then interest then principal waterfall

### LP-12 Repay exact over current debt fails

- Expected:
  - revert `REPAY_TOO_MUCH`

### LP-13 Repay all with sufficient stable

- Expected:
  - debt fields all zero
  - due timestamp reset

### LP-14 Repay all with insufficient stable

- Expected:
  - transfer or balance failure

### LP-15 Repay available with exact stable balance

- Expected:
  - debt cleared if wallet sufficient

### LP-16 Repay available with insufficient wallet stable

- Expected:
  - partial debt reduction
  - no revert if wallet > 0

### LP-17 Repay available with zero wallet stable

- Expected:
  - revert `NO_STABLE_BALANCE`

### LP-18 Repay with collateral partial

- Expected:
  - collateral in pool decreases
  - debt decreases
  - wrapped wallet unchanged

### LP-19 Repay with collateral full close

- Expected:
  - debt reaches zero
  - remaining collateral can be withdrawn

### LP-20 Repay with collateral without router

- Expected:
  - revert `SWAP_ROUTER_ZERO`

### LP-21 Repay with collateral amount > pool collateral

- Expected:
  - revert `INSUFFICIENT_COLLATERAL`

### LP-22 Interest accrual over time

- Expected:
  - debt increases after warp/time advance

### LP-23 Interest does not compound on accrued interest

- Expected:
  - additional interest computed only on principal

### LP-24 Penalty does not accrue further interest

- Expected:
  - penalty fixed after applied

### LP-25 Borrow when overdue fails

- Expected:
  - revert `LOAN_OVERDUE`

### LP-26 Withdraw when overdue fails

- Expected:
  - revert `LOAN_OVERDUE`

### LP-27 Apply penalty once

- Expected:
  - first apply succeeds
  - second apply same overdue cycle fails

### LP-28 Liquidate undercollateralized by price drop

- Expected:
  - liquidator repays allowed amount
  - receives collateral bonus

### LP-29 Liquidate overdue position

- Expected:
  - can repay up to full debt path

### LP-30 Liquidation capped by collateral value

- Expected:
  - no over-repayment beyond realizable collateral
  - residual bad debt possible

### LP-31 Write off residual bad debt

- Expected:
  - only after collateral exhausted
  - debt fields clear

### LP-32 Pause blocks user flows

- Expected:
  - deposit / withdraw / borrow / repay / repayAll / repayAvailable / withdrawMax / repayWithCollateral blocked

## 5. End-to-end cross-chain flows

## 5.1 Market `A -> B` happy path

### E2E-AB-01 Full clean cycle using wallet stable repay

- Owner apply baseline
- User lock `aCOL` on Chain A
- Workers attest + mint `wA` on Chain B
- User deposit `wA`
- User borrow `sB`
- Owner mint `sB` to user if needed for demo
- User repay all
- User withdraw max
- User burn max
- Workers attest + unlock `aCOL`

Expected:

- final debt = 0
- `wA wallet = 0`
- `wA in pool = 0`
- `Locked aCOL = 0`
- `aCOL wallet` returns to full unlocked amount

### E2E-AB-02 Close debt using collateral sale

- Same until borrow
- User auto close debt
- User withdraw max remaining collateral
- User burn max remaining wrapped

Expected:

- debt = 0
- source collateral unlocked only for borrower-controlled wrapped remainder
- UI shows residual locked backing if applicable

## 5.2 Market `B -> A` symmetry path

### E2E-BA-01 Full clean cycle

Same as above, but:

- lock `bCOL`
- mint `wB`
- borrow `sA`
- repay / withdraw / burn / unlock

Expected:

- same invariants hold in reverse direction

## 6. User Portal manual test cases

## 6.1 Global / shared actions

### U-01 Connect wallet as user

- Expected:
  - wallet card updates
  - role shows `User`
  - chain shown correctly

### U-02 Connect wrong account type

- Use owner account in user portal
- Expected:
  - role text updates accordingly
  - user-only action guards should block inappropriate operations if implemented

### U-03 Refresh after state change

- Expected:
  - balances and cards reflect latest on-chain state

### U-04 Switch market selector `A -> B` to `B -> A`

- Expected:
  - labels update:
    - collateral symbol
    - wrapped symbol
    - stable symbol
  - active market text updates

## 6.2 Collateral In card

### U-10 `Lock Collateral` happy path

- Input valid positive amount
- Expected:
  - approval prompt if needed
  - lock tx succeeds
  - worker later mints wrapped token on destination chain

### U-11 `Lock Collateral` zero amount

- Expected:
  - UI validation error

### U-12 `Lock Collateral` above wallet balance

- Expected:
  - UI validation error or tx revert

### U-13 `Deposit` happy path

- Preconditions:
  - wrapped token already minted
- Expected:
  - destination pool collateral increases

### U-14 `Deposit` before wrapped exists

- Expected:
  - fail with max 0 or insufficient balance

### U-15 `Deposit` above wrapped wallet

- Expected:
  - validation fail

### U-16 `Deposit` zero

- Expected:
  - validation fail

## 6.3 Debt card

### U-20 `Borrow` happy path

- Expected:
  - stable wallet increases
  - debt appears

### U-21 `Borrow` above limit

- Expected:
  - UI says borrow exceeds limit

### U-22 `Borrow` with zero deposit

- Expected:
  - fail

### U-23 `Borrow` while overdue

- Expected:
  - fail

### U-24 `Repay Exact Amount` partial

- Expected:
  - debt decreases exactly

### U-25 `Repay Exact Amount` full

- Expected:
  - debt reaches 0 if exact enough

### U-26 `Repay Exact Amount` zero / empty

- Expected:
  - validation fail

### U-27 `Repay Exact Amount` over debt

- Expected:
  - fail

### U-28 `Repay Exact Amount` without stable balance

- Expected:
  - fail

### U-29 `Repay Wallet Max` happy path with enough stable

- Expected:
  - debt reaches 0 in one tx
- Regression:
  - no dust from stale preview

### U-30 `Repay Wallet Max` partial path

- Given:
  - wallet stable < debt
- Expected:
  - debt decreases
  - not fully cleared

### U-31 `Repay Wallet Max` with zero stable

- Expected:
  - fail `NO_STABLE_BALANCE`

### U-32 `Repay All` with enough stable

- Expected:
  - debt = 0

### U-33 `Repay All` with insufficient stable

- Expected:
  - fail

### U-34 `Repay All` when debt already zero

- Expected:
  - UI says no debt to repay

### U-35 `Auto Close Debt` happy path

- Given:
  - debt > 0
  - pool collateral > 0
- Expected:
  - auto-estimated wrapped amount sold
  - debt reduces or closes

### U-36 `Auto Close Debt` when no debt

- Expected:
  - UI says no debt to close

### U-37 `Auto Close Debt` when no collateral in pool

- Expected:
  - fail

### U-38 `Auto Close Debt` on dusty debt

- Expected:
  - one-click path should minimize residual dust

### U-39 `Sell Custom Amount` happy path

- Expected:
  - exact collateral amount sold
  - debt reduced accordingly

### U-40 `Sell Custom Amount` empty input

- Expected:
  - validation fail

### U-41 `Sell Custom Amount` above pool collateral

- Expected:
  - fail

### U-42 `Sell Custom Amount` when no debt

- Expected:
  - fail

## 6.4 Release card

### U-50 `Withdraw Max` happy path with debt = 0

- Expected:
  - all remaining collateral withdrawn in one tx

### U-51 `Withdraw Max` healthy partial withdraw with debt > 0

- Expected:
  - exact safe max withdrawn

### U-52 `Withdraw Max` when nothing withdrawable

- Expected:
  - fail `NOTHING_TO_WITHDRAW`

### U-53 `Withdraw Max` while overdue

- Expected:
  - fail `LOAN_OVERDUE`

### U-54 `Withdraw Exact Amount` happy path

- Expected:
  - specified amount withdrawn

### U-55 `Withdraw Exact Amount` empty input

- Expected:
  - validation fail

### U-56 `Withdraw Exact Amount` above safe max

- Expected:
  - fail

### U-57 `Withdraw Exact Amount` while overdue

- Expected:
  - fail

### U-58 `Burn Wrapped` exact happy path

- Given:
  - wrapped in wallet > 0
- Expected:
  - burn request emitted
  - worker later unlocks local collateral

### U-59 `Burn Wrapped` empty input

- Expected:
  - validation fail

### U-60 `Burn Wrapped` above wallet wrapped

- Expected:
  - fail

### U-61 `Burn Max` happy path

- Expected:
  - full wallet wrapped amount burned directly

### U-62 `Burn Max` with zero wrapped wallet

- Expected:
  - fail or explicit no-balance message

## 6.5 User Portal state-display cases

### U-70 No position, no lock yet

- Expected:
  - summary says no lock event detected / no active debt semantics

### U-71 Active debt healthy

- Expected:
  - status chip shows active / healthy

### U-72 Unsafe by price drop

- Expected:
  - status chip shows unsafe / liquidation available

### U-73 Overdue before penalty

- Expected:
  - status chip overdue
  - next action mentions penalty

### U-74 Overdue after penalty

- Expected:
  - status chip overdue
  - next action mentions liquidation or repayment

### U-75 Settled by collateral sale

- Expected:
  - debt 0
  - residual backing explained in outcome card

### U-76 Settled by liquidation

- Expected:
  - outcome card distinguishes borrower-releasable vs residual locked backing

## 7. Owner Portal manual test cases

## 7.1 Global

### O-01 Connect wallet as owner

- Expected:
  - role = owner

### O-02 Open owner portal with non-owner

- Expected:
  - management actions fail by role

### O-03 Refresh owner snapshot

- Expected:
  - all borrower metrics refresh correctly

## 7.2 Market Configuration

### O-10 `Apply Baseline` happy path

- Expected:
  - factor, duration, penalty, bonus, prices all update

### O-11 `Apply Baseline` with invalid factor

- Expected:
  - validation fail

### O-12 `Apply Baseline` with invalid duration

- Expected:
  - validation fail

### O-13 `Apply Baseline` with invalid prices

- Expected:
  - validation fail

### O-14 `Set Factor`

- Expected:
  - factor changes

### O-15 `Set Factor` above threshold

- Expected:
  - revert due to threshold relation

### O-16 `Set Duration`

- Expected:
  - loan duration changes

### O-17 `Set Penalty`

- Expected:
  - overdue penalty bps changes

### O-18 `Set Bonus`

- Expected:
  - liquidation bonus changes

### O-19 `Set Wrapped Price`

- Expected:
  - max borrow / health factor recalculate

### O-20 `Set Stable Price`

- Expected:
  - debt value / max borrow semantics recalculate

## 7.3 Liquidity Management

### O-30 `Mint to User` collateral

- Expected:
  - user local collateral wallet increases on selected source chain

### O-31 `Mint to User` stable

- Expected:
  - user stable wallet increases on selected destination chain

### O-32 `Mint to Pool`

- Expected:
  - pool stable liquidity increases

### O-33 Mint zero amount

- Expected:
  - validation fail

## 7.4 Enforcement

### O-40 `Advance +1 Day` on local chain

- Expected:
  - lending chain time advances
  - due / interest state shifts after refresh

### O-41 `Advance +1 Day` on unsupported RPC

- Expected:
  - clear error saying local-only / unsupported

### O-42 `Apply Penalty` when overdue and not yet penalized

- Expected:
  - penalty amount increases

### O-43 `Apply Penalty` when not overdue

- Expected:
  - fail

### O-44 `Apply Penalty` twice same cycle

- Expected:
  - second attempt fails

### O-45 `Liquidate User` overdue full close path

- Expected:
  - debt closes if collateral sufficient
  - borrower loses collateral

### O-46 `Liquidate User` undercollateralized by price drop

- Expected:
  - partial liquidation according to close factor and collateral value

### O-47 `Liquidate User` when not liquidatable

- Expected:
  - fail

### O-48 `Liquidate User` with owner lacking stable

- Expected:
  - owner convenience funding path works if still present in UI

### O-49 `Liquidate User` should not leave preview-based dust

- Expected:
  - because UI now sends `MaxUint256`, residual dust from stale preview should not remain unless collateral-value cap requires it

## 8. Bridge worker and infra cases

### W-01 Worker hub starts all workers

- Expected:
  - 3 validator workers + 1 executor worker start

### W-02 Lock event attested by threshold validators

- Expected:
  - 2 or more attests logged

### W-03 Executor mints wrapped after threshold

- Expected:
  - wrapped token minted on destination chain

### W-04 Burn event attested

- Expected:
  - burn message attested by validators

### W-05 Executor unlocks source collateral

- Expected:
  - local collateral released from vault

### W-06 Worker restart mid-demo

- Expected:
  - no replay corruption
  - pending messages still executable

### W-07 Duplicate attestation not produced twice

- Expected:
  - same validator does not attest same message twice

### W-08 Gateway pause blocks worker progress

- Expected:
  - bridge stops moving until unpaused

## 9. Regression cases tied to past issues

### R-01 `Withdraw Max` must not require manual input

- Expected:
  - direct tx path

### R-02 `Burn Max` must not require manual input

- Expected:
  - direct tx path

### R-03 `Repay Wallet Max` must not rely on stale preview amount

- Expected:
  - on-chain `repayAvailable` semantics

### R-04 `Liquidate User` must not use stale preview debt exact amount

- Expected:
  - sends `MaxUint256`

### R-05 `Repay with collateral` should leave economically consistent residual backing

- Expected:
  - UI outcome card explains locked backing not held by borrower

### R-06 `Debt = 0` should not imply source collateral fully unlocked

- Expected:
  - UI still distinguishes release state vs debt state

### R-07 Overdue tiny residual debt should still block borrow

- Expected:
  - semantics remain consistent

### R-08 Position summary should not claim "no lock event" for settled-but-residual-backing cases

- Expected:
  - wording remains accurate

## 10. Exploratory manual scenarios

### X-01 Borrow, then price crash, then partial liquidation, then repay remainder

### X-02 Borrow, overdue, apply penalty, repay all from wallet, withdraw, burn

### X-03 Borrow, auto close debt, withdraw remainder, burn remainder

### X-04 Open `A -> B` and `B -> A` in same session and verify state isolation

### X-05 Refresh UI during pending tx and ensure no double-submit path causes inconsistent state

### X-06 Rapid button clicks during pending state

- Expected:
  - duplicate submit blocked

### X-07 Reload browser mid-flow

- Expected:
  - state reconstructs from chain

## 11. Smoke checklist before demo

Truoc khi demo that, chay nhanh:

1. `deploy:multichain`
2. `seed:multichain`
3. `worker:hub`
4. `A -> B` happy path
5. `B -> A` symmetry path
6. overdue + penalty
7. liquidation path
8. `Repay Wallet Max`
9. `Withdraw Max`
10. `Burn Max`

## 12. Recommended execution order

Neu muon test co he thong, nen theo thu tu:

1. contract unit tests
2. owner config tests
3. user happy paths
4. user negative paths
5. overdue / penalty / liquidation
6. bridge worker lifecycle
7. regression tests for max buttons and dust
8. exploratory manual tests

