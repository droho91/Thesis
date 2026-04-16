# EVM / Besu Direction

## Why This Direction

The thesis question is not "how do we rename a checkpoint bridge so that it sounds like IBC?"

The actual question is:

> If Bank A and Bank B each operate their own permissioned EVM chain, and neither bank wants to trust the other as an administrator, how can they exchange state safely enough to support a lending use case?

For an EVM thesis, the technically honest answer is:

- run permissioned EVM chains with a real private-network consensus engine such as QBFT or IBFT 2.0,
- treat the remote client as the trust anchor,
- advance remote trust from finalized headers and validator commit evidence,
- prove EVM state against the trusted `stateRoot`,
- keep the lending use case downstream from that proof path.

That keeps the project close to IBC architecture without pretending that EVM chains natively speak canonical Cosmos IBC.

## What Changes Relative To The Current Local Prototype

### 1. SourceCheckpointRegistry stops being the long-term trust source

`SourceCheckpointRegistry` remains useful only as a local transition scaffold.

It should no longer be treated as the thing that makes consensus true.

In the target direction:

- the source chain itself finalizes blocks through Besu QBFT,
- the relayer fetches finalized block headers,
- validator commit evidence comes from the consensus engine and header data,
- the destination client verifies those artifacts as remote consensus state.

### 2. Proofs move from custom packet Merkle roots toward EVM state proofs

The current prototype verifies packet commitment path/value pairs under a local state root over custom leaves.

The target direction is:

- fetch block header data from the source EVM chain,
- fetch account and storage proofs with `eth_getProof`,
- verify account/storage inclusion against the trusted `stateRoot`,
- map packet commitments, acknowledgements, and timeout markers to real contract storage slots.

This is more honest for EVM than claiming generalized ICS-23 proofs, because Ethereum storage uses Merkle Patricia Trie proofs rather than the store families normally targeted by ICS-23.

## Minimal IBC-Inspired Scope For EVM

The target is still not "full IBC on EVM."

The honest target is:

- ICS-02-inspired client state and consensus state,
- ICS-03/04-inspired connection and channel semantics in a minimal local form,
- ICS-20-like transfer semantics,
- real EVM finalized header artifacts,
- real EVM state proofs.

For this thesis, the minimum extra protocol pieces to add after the Besu pivot are:

1. connection identifiers
2. channel identifiers
3. send/recv sequence tracking
4. acknowledgement commitment tracking
5. timeout or timeout-like absence checks

That is enough to demonstrate a recognizable packet lifecycle without claiming a production-complete IBC stack.

## What The Repo Now Includes Toward This Direction

- `scripts/generate-besu-qbft-networks.mjs`
  - deterministic local Besu QBFT scaffolding for Bank A and Bank B
- `scripts/fetch-besu-header.mjs`
  - fetches an EVM block header snapshot from RPC
- `scripts/fetch-eth-proof.mjs`
  - fetches `eth_getProof` account/storage proofs from RPC
- Besu-aware script signing in `scripts/ibc-lite-common.mjs`
  - deploy/demo/relayer scripts can now use generated Besu operator and validator keys instead of depending on dev-chain unlocked accounts
- `contracts/core/IBCEVMTypes.sol` and `contracts/core/IBCEVMProofBoundary.sol`
  - a Solidity boundary layer for EVM proofs that binds proofs to a trusted client `stateRoot` and now includes minimal Merkle Patricia Trie inclusion verification for account/storage proofs
- `contracts/source/SourcePacketCommitmentSlots.sol`
  - documents the current storage-slot layout for `SourcePacketCommitment` so packet commitments can be proven as real EVM storage words
- `contracts/core/IBCPacketHandler.sol`
  - now includes a parallel `recvPacketFromStorageProof(...)` path that verifies `packetLeafAt[sequence]` and `packetPathAt[sequence]` through trusted storage-slot proofs
- script-side `executionStateRoot` hydration
  - the relayer/demo scripts now fetch the source block header from RPC, bind its `stateRoot` into the relayed client header as `executionStateRoot`, and in canonical Besu mode require `eth_getProof` storage witnesses instead of silently falling back
- first-class runtime mode
  - the repo now records `runtime.mode` and `runtime.proofPolicy` in `.ibc-lite.local.json`, so the short canonical commands (`npm run demo:ui`, `npm run deploy:ibc-lite`, `npm run demo:flow`) run Besu-first, while `legacy:*` commands keep the compatibility fallback
- `contracts/libs/RLPDecodeLib.sol`, `contracts/libs/HexPrefixLib.sol`, and `contracts/libs/MerklePatriciaProofLib.sol`
  - the RLP, hex-prefix, and trie logic needed for Ethereum account/storage inclusion proofs
- `networks/besu/`
  - generated local QBFT configuration, node keys, static peers, and Docker Compose scaffold

## What Still Needs To Be Implemented

- on-chain RLP/header parsing for Besu QBFT or IBFT block headers
- on-chain verification of validator commit seals from header `extraData` or equivalent consensus artifacts
- channel, acknowledgement, and timeout state machines
- eventual hard removal of the packet-state Merkle fallback from the internal legacy harness after the Besu path fully covers every intended regression and demo case
- on-chain verification of real `eth_getProof` witnesses fetched from Besu runtime, rather than synthetic trie fixtures in the Solidity tests plus opportunistic RPC-driven demo execution

## External References

- Besu private networks overview: https://besu.hyperledger.org/private-networks
- Besu QBFT configuration: https://besu.hyperledger.org/private-networks/how-to/configure/consensus/qbft
- Besu IBFT 2.0 configuration: https://besu.hyperledger.org/private-networks/how-to/configure/consensus/ibft
- Ethereum JSON-RPC: https://ethereum.org/developers/docs/apis/json-rpc/
- ICS-02 client semantics: https://github.com/cosmos/ibc/tree/main/spec/core/ics-002-client-semantics
- ICS-03 connection semantics: https://github.com/cosmos/ibc/tree/main/spec/core/ics-003-connection-semantics
- ICS-04 channel and packet semantics: https://github.com/cosmos/ibc/tree/main/spec/core/ics-004-channel-and-packet-semantics
