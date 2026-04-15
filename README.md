# Bank-Chain Interop Checkpoint Prototype

This repository is a local simulation of an inter-chain linkage mechanism for two permissioned EVM bank chains. The lending contracts are the workload; the thesis contribution is the linkage layer.

Bank A and Bank B each run a local chain, their own source-side validator epoch registry, a canonical message bus, and a checkpoint registry. Remote correctness is established by source-originated validator epochs, source-chain checkpoint commitments, bank-validator quorum signatures, parent-linked checkpoint progression, source block anchors, Merkle message inclusion proofs, strict replay protection, and freeze/recovery handling.

No public RPC, paid prover, cloud service, mainnet deployment, subscription API, or external paid infrastructure is required.

## Canonical Linkage Flow

1. A bank application emits a normalized cross-chain message through `MessageBus`.
2. `MessageBus` assigns a nonce and message sequence, stores the message id and leaf, and updates a deterministic message history root.
3. `BankValidatorSetRegistry` maintains the source chain's canonical validator epoch progression.
4. `BankCheckpointRegistry` commits a contiguous message range on the source chain.
5. The source checkpoint binds:
   - `sourceChainId`
   - source checkpoint registry address
   - source message bus address
   - source validator epoch registry address
   - `validatorEpochId`
   - validator epoch hash
   - monotonic checkpoint sequence
   - parent checkpoint hash
   - message root
   - message sequence range
   - message accumulator
   - source block number/hash reference
   - timestamp
6. Bank-chain validators certify source epoch artifacts and exact checkpoint hashes with `>= 2/3` voting power.
7. Any relayer submits certified successor epochs and signed checkpoints to the remote `BankCheckpointClient`.
8. The client verifies epoch binding, quorum, source commitment shape, parent linkage, sequence, message range, and source progression.
9. Any relayer submits the message and Merkle proof to `BridgeRouter`.
10. The router verifies checkpoint inclusion before route policy, fee, risk, mint, unlock, or lending logic runs.
11. `MessageInbox` consumes the message id exactly once.

## Contracts

- `contracts/checkpoint/BankValidatorSetRegistry.sol`: source-chain bank validator epoch registry. It records source-originated epoch artifacts with parent epoch hashes, validator lists, equal or weighted voting power, quorum rules, source block anchors, and canonical epoch hashes.
- `contracts/checkpoint/BankCheckpointRegistry.sol`: source-chain canonical checkpoint producer. It commits message ranges, source progression references, validator epoch binding, and checkpoint hashes on-chain.
- `contracts/checkpoint/BankCheckpointClient.sol`: destination remote view. It bootstraps from a source-originated genesis epoch, imports later remote epochs only through certified source epoch artifacts, verifies `>= 2/3` signatures against the active epoch, enforces parent-linked progression, stores verified checkpoints, verifies Merkle inclusion, detects conflicting checkpoints, freezes sources, and requires explicit recovery plus a certified successor epoch.
- `contracts/bridge/MessageBus.sol`: canonical source outbox. It normalizes messages, assigns nonces/sequences, stores leaves, and maintains the deterministic message history commitment used by checkpoints.
- `contracts/bridge/BridgeRouter.sol`: destination executor. It verifies source freeze state and message inclusion before route/risk policy and before mint/unlock actions.
- `contracts/bridge/MessageInbox.sol`: replay protection for verified cross-chain messages.
- `contracts/risk/RouteRegistry.sol` and `contracts/risk/RiskManager.sol`: secondary safety controls. They never replace checkpoint or proof correctness.
- `contracts/CollateralVault.sol`, `contracts/WrappedCollateral.sol`, and `contracts/LendingPool.sol`: lending demonstration workload.

## Local Scripts

- `npm run node:chainA`: starts Bank A local EVM.
- `npm run node:chainB`: starts Bank B local EVM.
- `npm run deploy:multichain`: deploys source cores first, bootstraps each remote client from the other bank's source validator epoch artifact, then deploys routes and demo contracts.
- `npm run seed:multichain`: seeds local demo balances.
- `npm run worker:checkpoint`: transports certified source validator epochs, asks each source registry to commit pending message ranges, gathers local bank-validator signatures over the canonical checkpoint artifact, and submits it to the remote client.
- `npm run worker:message`: builds real Merkle proofs from source `MessageBus` leaves within certified checkpoint ranges and submits messages to the destination router.
- `npm run worker:risk`: observes secondary route/risk policy.
- `npm run worker:hub`: runs checkpoint, message, and risk workers together.

The validator simulation uses local dev-node accounts by default. Set `VALIDATOR_INDICES` and `LOCAL_VALIDATOR_MNEMONIC` to change the local consortium accounts.

## Tests

Run:

```bash
TMPDIR=/tmp XDG_CACHE_HOME=/tmp/.cache npm run test:solidity
```

The linkage tests cover removal of admin validator sync, certified source epoch rotation, stale epoch rejection, canonical source checkpoint commitment, `>= 2/3` quorum, insufficient quorum, wrong validator epoch id, wrong parent linkage, wrong sequence, duplicate checkpoint behavior, conflicting checkpoint freeze, explicit recovery through certified successor epoch, valid and invalid Merkle proofs, replay rejection, wrong route, wrong source emitter, wrong source sender, multi-message checkpoints, route policy ordering, high-value approval, reverse burn/unlock, fee flow, and arbitrary relayer submission.

## Documentation

Read `docs/INTERCHAIN_LINKAGE_MODEL.md` for the thesis architecture and the local-simulation boundaries.

## Local Simulation Boundaries

- Validators are local dev accounts, not independent bank infrastructure.
- Source checkpoint production is an on-chain local registry driven by a local worker, not a production consensus engine.
- Validator certification is simulated with local ECDSA signatures over the canonical checkpoint hash.
- Source block references are local EVM block number/hash anchors, not full light-client header verification.
- Recovery is represented by authorized entry into `Recovering` plus import of a certified successor epoch.

The canonical path has no destination admin validator sync, legacy header verifier, receipt shortcut, fake proof path, or bridge-signer-only attestation path.
