# Bank-Chain Cross-Chain Lending Prototype

This repo models interoperability between two local permissioned EVM bank chains:

- Bank A runs its own chain and validator set.
- Bank B runs its own chain and validator set.
- Relayers are permissionless transporters.
- Destination-chain correctness comes from signed finalized checkpoints plus Merkle message inclusion proofs.
- Risk controls are secondary safety layers, not the bridge trust anchor.

No public RPC, paid prover, cloud service, mainnet deployment, or subscription API is required.

## Canonical Flow

### Lock on Bank A, Mint and Borrow on Bank B

1. User locks Bank A collateral in `CollateralVault`.
2. `MessageBus` emits a normalized message and deterministic Merkle leaf.
3. Bank A validators certify a finalized checkpoint containing the message root.
4. Any relayer submits the signed checkpoint to Bank B `BankCheckpointClient`.
5. Any relayer submits the message and Merkle proof to Bank B `BridgeRouter`.
6. Bank B verifies checkpoint finality, inclusion, replay state, route policy, and risk policy.
7. Bank B mints `WrappedCollateral`.
8. User deposits wrapped collateral and borrows `StableToken` from `LendingPool`.

### Burn on Bank B, Unlock on Bank A

1. User repays or closes debt on Bank B.
2. User withdraws wrapped collateral and calls `BridgeRouter.requestBurn`.
3. Bank B burns wrapped collateral and dispatches a release message through `MessageBus`.
4. Bank B validators certify a checkpoint containing the release message root.
5. Any relayer submits the checkpoint and inclusion proof to Bank A.
6. Bank A verifies the proof path and unlocks original collateral from `CollateralVault`.

## Core Contracts

- `contracts/checkpoint/BankCheckpointClient.sol`: stores source-chain validator sets, verifies `>= 2/3` voting power signatures, stores verified checkpoints, verifies Merkle inclusion, detects conflicting checkpoints, and freezes a source chain.
- `contracts/bridge/MessageBus.sol`: canonical source outbox. It normalizes messages, assigns nonces/sequences, emits deterministic message leaves, and provides the data committed into bank checkpoints.
- `contracts/bridge/BridgeRouter.sol`: destination executor. It accepts only messages proven against verified checkpoints, then applies replay protection and secondary route/risk policy before minting or unlocking.
- `contracts/bridge/MessageInbox.sol`: one-time message consumption and replay protection.
- `contracts/risk/RouteRegistry.sol`: route configuration, emitter/sender/asset/target binding, caps, fees, rate windows, and high-value thresholds.
- `contracts/risk/RiskManager.sol`: pause, freeze, rate limit, cooldown, and high-value approval checks after proof verification.
- `contracts/fees/FeeVault.sol`: route fee collection and optional relayer reward.
- `contracts/CollateralVault.sol`, `contracts/WrappedCollateral.sol`, `contracts/LendingPool.sol`: lending business flow.

## Local Scripts

- `npm run node:chainA`: starts Bank A local EVM.
- `npm run node:chainB`: starts Bank B local EVM.
- `npm run deploy:multichain`: deploys both bank stacks, installs local validator sets, configures routes, and writes `demo/multichain-addresses.json`.
- `npm run worker:checkpoint`: simulates source-bank validator checkpoint certification and relays signed checkpoints.
- `npm run worker:message`: relays message inclusion proofs and lets destination contracts decide validity.
- `npm run worker:risk`: observes route policy and can pause/freeze when explicitly configured.
- `npm run worker:hub`: runs checkpoint relayer, message relayer, and risk watcher together.

The validator simulation uses local dev-node accounts by default. Set `VALIDATOR_INDICES` and `LOCAL_VALIDATOR_MNEMONIC` to change the local consortium accounts.

## Tests

Run:

```bash
TMPDIR=/tmp XDG_CACHE_HOME=/tmp/.cache npm run test:solidity
```

The bridge tests cover:

- valid `>= 2/3` checkpoint quorum
- insufficient signatures
- wrong validator set ID
- validator-set rotation and stale-set failure
- wrong parent and wrong sequence
- conflicting checkpoint freeze
- valid and invalid Merkle proofs
- replay prevention
- wrong route, source emitter, and source sender
- paused and frozen routes
- high-value approval
- reverse burn/release to unlock
- arbitrary relayer addresses submitting valid data

## Local Simulation Boundaries

This is intentionally zero-cost and local:

- Validators are local dev accounts, not independent bank infrastructure.
- Checkpoint construction is simulated by scripts instead of a production bank-chain consensus export.
- Message roots are single-leaf roots in the default relayer script, while contracts support indexed Merkle proofs.
- Governance recovery is represented by authorized unfreeze and route policy functions.

The canonical on-chain path is still checkpoint and Merkle proof based. There is no validator-attestation bridge path, no header/receipt dev verifier path, and no fake proof success path.
