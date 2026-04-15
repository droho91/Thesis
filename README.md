# IBC-Lite Bank Chain Client Simulation

This repository is a local simulation of an IBC/light-client-like inter-chain client for two permissioned EVM bank chains.

The thesis contribution is the linkage layer:

- source-chain packet commitments
- source-certified checkpoint artifacts
- remote client state progression
- packet membership verification against trusted remote state
- one-time packet execution
- freeze and explicit recovery on conflicting certified updates

The application is intentionally small: lock a canonical asset on Bank A, mint a voucher on Bank B, burn the voucher on Bank B, and unescrow the canonical asset on Bank A.

No mainnet RPC, paid prover, cloud service, subscription API, or external infrastructure is required.

## Architecture

```text
contracts/
  core/       IBC client interfaces, proof verifier, packet handler, misbehaviour evidence
  clients/    BankChainClient and bank-chain client state/message/consensus types
  source/     source validator epochs, packet commitments, source checkpoints
  apps/       minimal transfer app, escrow vault, voucher token, local bank token
  libs/       Merkle, packet, commitment, and domain hash helpers
```

The trust anchor is `BankChainClient`, not a bridge router. A destination chain can execute a packet only after its remote client accepts a validator-certified source checkpoint and verifies the packet leaf against that trusted consensus state.

## Canonical Flow

1. `MinimalTransferApp.sendTransfer` locks canonical tokens in `EscrowVault`.
2. The app writes an IBC-lite packet into `SourcePacketCommitment`.
3. `SourceCheckpointRegistry` commits a contiguous packet range and packet Merkle root.
4. Source validators sign the exact checkpoint hash.
5. An untrusted relayer submits the checkpoint as a `ClientMessage` to `BankChainClient.updateState`.
6. The client verifies validator quorum, source commitment binding, parent linkage, sequence, and source anchors.
7. A relayer submits the packet plus Merkle proof to `IBCPacketHandler.recvPacket`.
8. The handler verifies membership against the trusted remote client state, consumes the packet id once, and calls the destination app.
9. Bank B mints `VoucherToken`.
10. The reverse path burns the voucher on Bank B, commits a reverse packet, updates Bank A's remote client, proves membership, and unescrows from Bank A.

## Local Commands

Use writable temp/cache paths when running Hardhat from this sandboxed WSL workspace:

```bash
TMPDIR=/tmp XDG_CACHE_HOME=/tmp/.cache npm run compile
TMPDIR=/tmp XDG_CACHE_HOME=/tmp/.cache npm run test:solidity
```

Start local chains:

```bash
npm run node:chainA
npm run node:chainB
```

Deploy and seed the local IBC-lite stack:

```bash
TMPDIR=/tmp XDG_CACHE_HOME=/tmp/.cache npm run deploy:ibc-lite
npm run seed:ibc-lite
```

Worker scripts:

- `npm run worker:source-commit`: commit pending source packet ranges.
- `npm run worker:client-update`: relay latest source-certified checkpoint into the remote client.
- `npm run worker:packet-proof`: relay packet Merkle proofs for execution.
- `npm run worker:misbehaviour`: submit a deliberately conflicting certified update for freeze testing.

## Tests

The Solidity tests cover:

- client initialization
- valid and invalid client updates
- duplicate update rejection
- validator epoch rotation through source-certified artifacts
- misbehaviour freeze and explicit recovery
- valid and invalid membership proofs
- replay rejection
- trusted remote state as a precondition for packet execution
- escrow -> voucher mint
- burn -> unescrow

## Documentation

- `docs/IBC_LIGHT_CLIENT_SCOPE.md`
- `docs/CLIENT_STATE_MACHINE.md`
- `docs/PACKET_FLOW.md`
- `docs/TRUST_ASSUMPTIONS.md`
- `docs/SYSTEM_TESTS.md`
- `docs/TEST_CASES.md`

## Local Simulation Boundaries

The model uses local ECDSA validator signatures over source checkpoint hashes, local EVM block anchors, and source-chain registries as the finalized artifact source. It does not implement production header verification, slashing, validator operations, governance hardening, or non-membership proofs.
