# Inter-Chain Linkage Model

## Thesis Focus

The prototype models an inter-chain linkage mechanism for two permissioned EVM bank chains. The lending layer is intentionally secondary: it creates useful cross-chain messages, but correctness comes from the checkpoint and message-verification layer.

The target model is inspired by IBC and light-client principles:

- source-chain commitments are canonical artifacts of the source chain
- source validator epochs are canonical source artifacts
- relayers are permissionless and untrusted
- destination execution depends on verified source commitments
- message inclusion is proven against a committed `messageRoot`
- every message is consumed at most once
- conflicting certified checkpoints freeze the remote source view
- route/risk policies run only after checkpoint and proof correctness is established

## Bank A and Bank B

Each bank chain has:

- a local `MessageBus`
- a source `BankValidatorSetRegistry`
- a source `BankCheckpointRegistry`
- a destination-side `BankCheckpointClient` for the other bank chain
- a `BridgeRouter` that executes proven messages
- secondary `RouteRegistry` and `RiskManager` controls

Bank A validators certify Bank A epochs and checkpoints. Bank B validators certify Bank B epochs and checkpoints. A relayer can transport either direction, but cannot make a message, epoch, or checkpoint valid by itself.

## Source-Side Validator Epochs

`BankValidatorSetRegistry` is the source-side epoch progression point. Each committed epoch includes:

- `sourceChainId`
- source validator epoch registry address
- epoch id
- parent epoch hash
- validator list
- voting powers
- total voting power
- quorum numerator and denominator
- source activation block number
- source activation block hash
- timestamp
- epoch hash
- active state on the source registry

The destination `BankCheckpointClient` has no `setValidatorSet` or `setValidatorSetActive` admin path. It starts from a source-originated genesis epoch artifact at deployment, then accepts later remote epochs only through `submitValidatorEpoch`. A successor epoch must:

- come from the same source epoch registry
- parent-link to the currently trusted epoch hash
- move the epoch id forward
- carry a nonzero source block hash anchor
- be signed by the currently trusted epoch with the configured quorum

This models permissioned-chain epoch handoff: the old finalized validator epoch certifies the next source-originated epoch artifact. The relayer only transports that artifact and signatures.

## Source-Side Canonical Checkpoints

`BankCheckpointRegistry` is the source-side commitment point. A checkpoint is not assembled only by a relayer. It is committed on the source chain and stored by sequence.

The committed checkpoint includes:

- `sourceChainId`
- source checkpoint registry address
- source message bus address
- source validator epoch registry address
- `validatorEpochId`
- validator epoch hash
- checkpoint sequence
- parent checkpoint hash
- `messageRoot`
- first and last message sequence
- message count
- message accumulator
- source block number
- source block hash reference
- timestamp
- source commitment hash
- final checkpoint hash

The registry enforces contiguous message ranges and parent-linked source checkpoint progression. It also stores historical `checkpointSequence -> messageRoot`, source block number/hash anchors, and canonical checkpoint hashes.

## Validator Certification

`BankCheckpointClient` stores the destination chain's remote view of the source bank validator epochs. A checkpoint is accepted only when:

- the checkpoint `validatorEpochId` is active for the source view
- the checkpoint validator epoch hash matches the stored remote view
- the checkpoint names the same source epoch registry as the trusted epoch
- recovered signatures represent at least `2/3` of total voting power
- duplicate signatures are rejected
- stale or wrong validator epochs fail

Validator rotation is source-originated: the source validator registry commits a successor epoch and the remote client must import that certified epoch before checkpoints from that epoch can advance the remote view. There is no destination-side admin sync path for remote validator epochs.

## Source Progression Anchors

Epochs and checkpoints carry source block number/hash anchors. The source registries derive these anchors during the source-chain transaction that commits the epoch or checkpoint. The destination client validates that:

- epoch anchors are nonzero and do not regress
- checkpoint anchors are nonzero
- checkpoint source block numbers do not regress
- same-block checkpoint progression must keep the same source block hash
- checkpoints cannot predate the active validator epoch anchor

In this local simulation, the hash falls back to a deterministic local anchor when the dev EVM cannot expose a historical block hash. The anchor still participates in the epoch/checkpoint hashes and client progression logic.

## Message Commitments and Inclusion Proofs

`MessageBus` appends outgoing messages to a canonical sequence. Each message has a deterministic `messageId` and leaf hash. The bus stores:

- message sequence
- message id
- message leaf
- deterministic message history root

When a source checkpoint is committed, the checkpoint registry builds a Merkle root over a contiguous range of message leaves. Multiple messages per checkpoint are supported. Relayers later reconstruct the same leaf range and submit a Merkle proof for one message.

`BridgeRouter` executes only if `BankCheckpointClient.verifyMessageInclusion` returns true for:

- source chain id
- verified checkpoint hash
- message leaf
- leaf index inside the checkpoint range
- Merkle siblings

Invalid proofs fail before route policy, risk policy, minting, unlocking, or fee handling.

## Replay Protection

`MessageInbox` consumes the deterministic message id exactly once. A replayed message fails even if it still has a valid checkpoint and Merkle proof.

Wrapped minting and source unlocks also keep their own processed-event maps, so the application layer remains defensive even after inbox consumption.

## Client State, Conflict Freeze, and Recovery

If a destination client already accepted a checkpoint for a source sequence and later receives a different validly signed checkpoint for the same source and sequence, it records conflicting checkpoint evidence and freezes that source.

The client state machine is:

- `Active`
- `Frozen`
- `Recovering`

While `Frozen` or `Recovering`:

- message inclusion verification for that source returns false
- `BridgeRouter` rejects messages from that source with `SOURCE_FROZEN`
- route/risk policy cannot override the freeze

Recovery is explicit and nontrivial. Governance can move a frozen source into `Recovering` with `beginRecovery`, but the client returns to `Active` only when it accepts a certified successor validator epoch through `submitValidatorEpoch`. There is no direct admin unfreeze that restores message execution by itself.

## Relayer Role

Relayers are transporters only. They can:

- trigger source checkpoint commits when messages are pending
- transport source validator epoch artifacts and signatures
- collect signatures over the emitted checkpoint hash
- submit checkpoint objects and signatures to the destination client
- construct Merkle proofs from source message leaves
- submit proven messages to the destination router

They cannot:

- choose a different message root for a canonical checkpoint
- install or rotate the destination remote validator epoch by admin sync
- bypass validator quorum
- bypass parent linkage
- bypass source freeze
- bypass Merkle inclusion
- replay a consumed message

## Route and Risk Controls

Route and risk modules are secondary defenses. They bind expected emitters, senders, assets, targets, limits, fees, pause/freeze state, and high-value approval, but they run after checkpoint and proof verification. This keeps route policy from becoming the source of truth.

## Local Simulation Versus Production

This prototype remains zero-cost and local:

- local Hardhat/Ganache chains stand in for Bank A and Bank B
- local dev accounts stand in for bank-chain validators
- ECDSA signatures stand in for local QBFT/IBFT-style validator certification
- source block number/hash anchors stand in for full source header verification
- source checkpoint production is triggered by local scripts
- recovery is role-gated entry into `Recovering` plus certified successor epoch import

A production system would need full validator operations, robust epoch distribution, stronger source-chain light-client verification, slashing or formal dispute handling, operational key management, monitoring, and audited governance recovery.
