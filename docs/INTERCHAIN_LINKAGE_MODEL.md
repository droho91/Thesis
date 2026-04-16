# Inter-Chain Linkage Model

The repository now models a local IBC/light-client-like inter-chain client for two permissioned EVM bank chains.

The linkage layer is the thesis object. The application path is deliberately minimal: escrow a source asset, mint a voucher after proof verification, use that verified voucher as lending collateral, burn the voucher, then unescrow through the reverse packet path.

## Layer Separation

Client layer:

- `BankChainClient`
- `BankChainClientState`
- `BankChainConsensusState`
- `BankChainClientMessage`
- `IBCMisbehaviour`

Core packet/proof layer:

- `SourcePacketCommitment`
- legacy `SourceCheckpointRegistry` contract acting as the local finalized-header producer for the simulation
- `IBCPacketHandler`
- `IBCProofVerifier`
- `PacketLib`
- `MerkleLib`

Application layer:

- `MinimalTransferApp`
- `EscrowVault`
- `VoucherToken`
- `BankToken` for local demo assets
- `CrossChainLendingPool` as a small proof-backed lending use case

The destination chain does not rely on a bridge router or route policy as its trust anchor. It relies on a remote client state that advances only through finalized source headers certified by validator commit seals.

## QBFT/IBFT-Like Finalized Headers

Each source bank chain maintains:

- a validator epoch registry
- a packet commitment store
- a local header producer that finalizes packet ranges for this zero-cost simulation

The finalized header binds:

- source chain id
- source header producer
- source packet commitment store
- source validator epoch registry
- validator epoch id and hash
- monotonic header height
- parent header hash
- packet Merkle root
- state root over packet commitment path/value leaves
- packet sequence range
- packet accumulator
- source block number and hash anchor
- QBFT/IBFT round
- timestamp
- finalized header hash

The relayer transports the header and commit seals. It does not define remote truth.

## Remote Client Updates

`BankChainClient.updateState` accepts a `ClientMessage` only when:

- the client is active
- the header names a known trusted source validator epoch
- the header hash recomputes correctly
- validator commit seals cover at least two thirds of trusted validator voting power
- header height and parent linkage are correct
- packet ranges are contiguous
- the header carries a nonzero trusted remote state root
- source block anchors do not regress
- if the epoch has a known successor, the header source block must be before the successor activation anchor

Validator rotation is also source-certified. A successor epoch must parent-link to the current trusted epoch and be signed by the current trusted validator set.

Historical epochs remain usable for delayed relay of headers that were finalized before the successor activation anchor. They cannot sign new post-rotation headers.

## Packet Execution

The packet execution path is:

1. source app writes packet commitment
2. source header commits the packet commitment path/value state root
3. remote client accepts the finalized header and commit seals
4. packet handler verifies packet membership against the accepted consensus state root
5. packet handler consumes the packet id exactly once
6. destination app executes

Invalid proofs fail before application logic runs.

`verifyNonMembership` is implemented for local packet commitment absence. It can verify that a future sequence is not present in the trusted header snapshot, or that a different value is proven at the same packet commitment path.

## Lending Use Case Boundary

The lending pool is intentionally downstream from the client/proof path. It never decides whether Bank A state is true. It only accepts the `VoucherToken` that Bank B minted after `IBCPacketHandler` verified packet membership and consumed the packet id.

That keeps the thesis aligned with its title while preserving the research focus: lending is the bank application, but cross-chain client verification is the protocol contribution.

## Misbehaviour

If a client receives a different validator-certified header for an already trusted source height, it stores `IBCMisbehaviour.Evidence`, freezes the source client, and blocks membership verification.

Recovery is explicit:

1. governance calls `beginRecovery`
2. the client enters `Recovering`
3. packet execution remains blocked
4. a certified successor validator epoch must be imported
5. the client returns to `Active`

There is no direct admin unfreeze that restores packet execution.
