# Inter-Chain Linkage Model

The repository now models a local IBC/light-client-like inter-chain client for two permissioned EVM bank chains.

The linkage layer is the thesis object. Lending is retained as the application scenario, but the lending path depends on the client/proof flow: escrow a source asset, mint a voucher after proof verification, use that voucher in a minimal lending pool, then burn and unescrow through the reverse packet path.

## Layer Separation

Client layer:

- `BankChainClient`
- `BankChainClientState`
- `BankChainConsensusState`
- `BankChainClientMessage`
- `IBCMisbehaviour`

Core packet/proof layer:

- `SourcePacketCommitment`
- `SourceCheckpointRegistry`
- `IBCPacketHandler`
- `IBCProofVerifier`
- `PacketLib`
- `MerkleLib`

Application layer:

- `MinimalTransferApp`
- `EscrowVault`
- `VoucherToken`
- `VoucherLendingPool`
- `BankToken` for local demo assets

The destination chain does not rely on a bridge router or route policy as its trust anchor. It relies on a remote client state that advances only through source-certified artifacts.

## Source-Certified Artifacts

Each source bank chain maintains:

- a validator epoch registry
- a packet commitment store
- a checkpoint registry

The source checkpoint binds:

- source chain id
- source checkpoint registry
- source packet commitment store
- source validator epoch registry
- validator epoch id and hash
- monotonic checkpoint sequence
- parent checkpoint hash
- packet Merkle root
- packet sequence range
- packet accumulator
- source block number and hash anchor
- timestamp
- source commitment hash

The relayer transports the artifact. It does not define the artifact.

## Remote Client Updates

`BankChainClient.updateState` accepts a `ClientMessage` only when:

- the client is active
- the checkpoint names the currently trusted source validator epoch
- the source commitment hash recomputes correctly
- signatures cover at least two thirds of trusted validator voting power
- checkpoint sequence and parent linkage are correct
- packet ranges are contiguous
- source block anchors do not regress

Validator rotation is also source-certified. A successor epoch must parent-link to the current trusted epoch and be signed by the current trusted validator set.

## Packet Execution

The packet execution path is:

1. source app writes packet commitment
2. source checkpoint commits the packet root
3. remote client accepts the certified checkpoint
4. packet handler verifies packet membership against the accepted consensus state
5. packet handler consumes the packet id exactly once
6. destination app executes

Invalid proofs fail before application logic runs.

## Lending Workload

`VoucherLendingPool` is intentionally small. It accepts a verified voucher as collateral, lets the user borrow a local stable token within a fixed collateral factor, then repay and withdraw. It does not implement oracle pricing, liquidation, swaps, interest, or fee policy.

This preserves the project title as a multi-blockchain lending system while keeping the research focus on how two chains communicate and verify state.

## Misbehaviour

If a client receives a different validator-certified checkpoint for an already trusted source sequence, it stores `IBCMisbehaviour.Evidence`, freezes the source client, and blocks membership verification.

Recovery is explicit:

1. governance calls `beginRecovery`
2. the client enters `Recovering`
3. packet execution remains blocked
4. a certified successor validator epoch must be imported
5. the client returns to `Active`

There is no direct admin unfreeze that restores packet execution.
