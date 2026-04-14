# Test Cases

## Bridge Proof Model

Primary file:
- `test/BridgeRouter.t.sol`

Required bridge assertions:
1. `lock -> mint` succeeds only after a finalized source header and receipt-proof path.
2. `burn -> unlock` succeeds only after a finalized destination header and receipt-proof path.
3. Replaying a consumed message ID fails.
4. Invalid proof roots fail.
5. Unknown or wrong routes fail.
6. Wrong source emitter fails before execution.
7. Wrong source adapter fails before execution.
8. Paused routes fail.
9. Per-window rate limits fail when exceeded.
10. High-value transfers require secondary approval.
11. Any address can relay headers and proofs; correctness does not depend on relayer identity.

The local verifier is intentionally strict and deterministic, but not mainnet-grade. It models the proof boundary while keeping relayers untrusted.

## Lending

Primary file:
- `test/LendingPool.t.sol`

Coverage:
- deposit wrapped collateral
- borrow within collateral factor
- reject borrow/withdraw that breaks LTV
- repay exact, repay all, repay available
- repay with collateral through mock router
- liquidation, overdue penalty, bad-debt write-off
- owner risk parameter updates

## Assets

Primary files:
- `test/CollateralVault.t.sol`
- `test/WrappedCollateral.t.sol`
- `test/StableToken.t.sol`

Coverage:
- vault lock dispatches through `MessageBus`
- vault unlock is restricted to `BridgeRouter`
- wrapped mint/burn is restricted to `BridgeRouter`
- duplicate lock/burn message IDs cannot be replayed in adapter accounting
- stable token minting remains owner-only for local demo liquidity

## Bridge Test Scope

Bridge coverage lives in `test/BridgeRouter.t.sol`, which exercises the current header/proof router directly.
