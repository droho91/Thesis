# A Lending System for Multi-Blockchain Ecosystems

This repository is a local thesis prototype for cross-chain lending between two permissioned EVM bank chains.

The lending system is the use case. The research center is the inter-chain client model: how Bank B can trust a state transition from Bank A without trusting a relayer, a bridge owner, or Bank A as an administrator on Bank B.

The repo currently contains two layers of work:

- the current Solidity prototype, which is still a local IBC/light-client-like simulation,
- a new **direction-1 scaffold** for moving the thesis onto real permissioned-EVM infrastructure with Besu QBFT and EVM state proofs.

The thesis contribution is the linkage layer:

- source-chain packet commitments
- QBFT/IBFT-like finalized header artifacts
- remote client state progression
- packet path/value membership verification against a trusted remote state root
- packet non-membership verification for absent packet commitments in the trusted snapshot
- one-time packet execution
- freeze and explicit recovery on conflicting certified updates

The application layer is intentionally small: a verified source packet locks a canonical asset on
Bank A, mints a voucher on Bank B, lets the voucher collateralize a minimal Bank B lending pool,
then burns the voucher on the reverse path and unescrows the canonical asset on Bank A.

No mainnet RPC, paid prover, cloud service, subscription API, or external infrastructure is required.

The canonical runtime assumes local Besu QBFT bank chains plus storage proofs. A separate internal
compatibility harness still exists for local contract work, but it is not part of the thesis demo
surface.

## Architecture

```text
contracts/
  core/       IBC client interfaces, proof verifier, packet handler, misbehaviour evidence
  clients/    BankChainClient and bank-chain client state/message/consensus types
  source/     source validator epochs, packet commitments, local finalized-header producer
  apps/       minimal transfer app, escrow vault, voucher token, bank token, small lending pool
  libs/       Merkle, packet, commitment, and domain hash helpers
```

The trust anchor is `BankChainClient`, not a bridge router. A destination chain can execute a packet only after its remote client accepts a finalized QBFT/IBFT-like source header and verifies the packet commitment against that trusted consensus state. In the Besu-first runtime, the canonical packet path is `executionStateRoot -> eth_getProof -> recvPacketFromStorageProof(...)`.

## Canonical Flow

1. `MinimalTransferApp.sendTransfer` locks canonical tokens in `EscrowVault`.
2. The app writes an IBC-lite packet into `SourcePacketCommitment`.
3. The local source header producer finalizes a contiguous packet range, packet Merkle root, and remote state root.
4. Source validators sign a QBFT/IBFT-like commit digest over the finalized header hash.
5. An untrusted relayer submits the header as a `ClientMessage` to `BankChainClient.updateState`.
6. The client verifies validator quorum, header hash binding, parent linkage, height, state root, and source anchors.
7. In the Besu-first runtime, a relayer submits `eth_getProof` account/storage witnesses for `packetLeafAt[sequence]` and `packetPathAt[sequence]` to `IBCPacketHandler.recvPacketFromStorageProof`.
8. The handler verifies the packet commitment against the trusted remote execution state root, consumes the packet id once, and calls the destination app.
9. Bank B mints `VoucherToken`.
10. The Bank B lending pool accepts the verified voucher as collateral and lends local `bCASH`.
11. The user repays `bCASH` and withdraws the voucher.
12. The reverse path burns the voucher on Bank B, finalizes a reverse header, updates Bank A's remote client, proves membership, and unescrows from Bank A.

## Local Commands

Use writable temp/cache paths when running Hardhat from this sandboxed WSL workspace:

```bash
TMPDIR=/tmp XDG_CACHE_HOME=/tmp/.cache npm run compile
TMPDIR=/tmp XDG_CACHE_HOME=/tmp/.cache npm run test:solidity
```

## Demo Modes

The browser UI in `demo/` is now also the local contract controller. The canonical runtime is
`npm run demo:ui`, which treats Besu QBFT and storage proofs as the primary demo path.

If you want a quick file-level map of the demo/runtime surface, see `docs/DEMO_RUNTIME_MAP.md`.

The UI has direct operation buttons instead of a passive diagram:

- `Deploy + Seed`: deploy the two-chain IBC-lite stack and seed demo balances.
- Lock/mint path: `Lock aBANK`, `Finalize A Header`, `Update B Client`, `Prove + Mint Voucher`.
- Lending use case: `Deposit Voucher`, `Borrow bCASH`, `Repay bCASH`, `Withdraw Voucher`.
- Burn/unlock path: `Burn Voucher`, `Finalize B Header`, `Update A Client`, `Prove + Unlock aBANK`.
- Safety path: `Submit Conflict`, `Recover Client`, `Replay Forward`, `Check Non-Membership`.
- `Run Full Flow`: execute the whole sequence from escrow to unescrow.

The contract-backed flow writes the latest proof trace to `demo/latest-run.js` and `demo/latest-run.json` so the UI can display the real packet ids and hashes.

1. Bank A user escrows `aBANK`.
2. Bank A writes a packet commitment.
3. Bank A finalizes a local QBFT/IBFT-like source header.
4. Bank B updates its `BankChainClient` from validator commit seals over that header.
5. Bank B verifies packet membership proof and executes the packet once.
6. Bank B mints `vA`.
7. Bank B accepts verified `vA` as collateral and lends `bCASH`.
8. The user repays, withdraws `vA`, burns it, writes a reverse packet, Bank A updates its client, verifies proof, and unescrows `aBANK`.
9. A conflicting certified update can freeze the remote client; recovery requires an explicit successor validator epoch.

Start the canonical Besu-first UI controller:

```bash
npm run besu:generate
npm run besu:up
npm run demo:ui
```

Then open `http://127.0.0.1:5173/`.

Deploy and seed from terminal if you do not want to use the UI buttons:

```bash
npm run deploy:ibc-lite
npm run seed:ibc-lite
npm run demo:flow
```

The internal compatibility harness is intentionally outside the canonical thesis demo path and is not documented as a normal operator flow here.

On Windows PowerShell, set the temp/cache variables like this before deploying:

```powershell
$env:TMPDIR="C:\Users\outta\AppData\Local\Temp"
$env:XDG_CACHE_HOME="C:\Users\outta\AppData\Local\Temp\.cache"
npm run besu:generate
npm run besu:up
npm run demo:ui
```

Then use `Deploy + Seed` and either the step-by-step operation buttons or `Run Full Flow` in the browser.

Besu-first worker scripts:

- `npm run worker:source-commit`: finalize pending source packet ranges into local header artifacts.
- `npm run worker:client-update`: relay latest finalized header and commit seals into the remote client.
- `npm run worker:packet-proof`: relay storage proofs for packet execution; in Besu runtime this path requires `eth_getProof` rather than falling back silently.
- `npm run worker:misbehaviour`: submit a deliberately conflicting certified update for freeze testing.

## Tests

The Solidity tests cover:

- client initialization
- valid and invalid client updates
- duplicate update rejection
- validator epoch rotation through source-certified artifacts
- delayed header relay across validator epoch boundaries
- misbehaviour freeze and explicit recovery
- valid and invalid membership proofs
- valid and invalid non-membership proofs
- replay rejection
- trusted remote state as a precondition for packet execution
- escrow -> voucher mint
- verified voucher -> Bank B lending collateral
- collateral borrow/repay/withdraw before reverse burn
- burn -> unescrow

## Documentation

- `docs/IBC_LIGHT_CLIENT_SCOPE.md`
- `docs/HARD_RESET_DECISION.md`
- `docs/EVM_BESU_DIRECTION.md`
- `docs/DEMO_RUNTIME_MAP.md`
- `docs/THESIS_POSITIONING.md`
- `docs/CLIENT_STATE_MACHINE.md`
- `docs/PACKET_FLOW.md`
- `docs/TRUST_ASSUMPTIONS.md`
- `docs/SYSTEM_TESTS.md`
- `docs/TEST_CASES.md`

## Local Simulation Boundaries

The model uses local ECDSA validator commit seals over QBFT/IBFT-like finalized header hashes,
local EVM block anchors, source-chain registries, and an RPC-hydrated execution state root for the
canonical Besu-first proof path. A packet-state Merkle root still survives internally for the
internal compatibility harness only. The repo still does not implement production QBFT/IBFT engine
integration, slashing, validator operations, governance hardening, or a full production IBC client.

## Direction 1: Besu + EVM State Proofs

To move the thesis toward an honest permissioned-EVM light-client model, the repo now includes Besu/QBFT scaffolding and proof-fetch tools:

- `npm run besu:generate`
  - generates two local Besu QBFT bank networks under `networks/besu/`
- `npm run besu:up`
  - starts the generated Besu networks with Docker Compose
- `npm run besu:down`
  - stops and removes the generated Besu containers
- `npm run besu:header`
  - fetches a live EVM header snapshot from a chain RPC
- `npm run proof:eth`
  - fetches `eth_getProof` output for an account/storage proof

This does **not** mean the Solidity light client already verifies Besu headers on-chain. It means the repo now has the local network and RPC-tooling foundation needed for the next honest step:

1. replace Hardhat/Ganache demo chains with Besu QBFT bank chains,
2. fetch real finalized EVM headers,
3. fetch real account/storage proofs through `eth_getProof`,
4. replace the custom local state-root proof path with real EVM proof verification,
5. add minimal connection/channel/ack/timeout semantics.

See `docs/EVM_BESU_DIRECTION.md` for the exact boundary and rationale.

The Solidity side now also includes an explicit EVM-proof boundary layer:

- `IBCEVMTypes.StorageProof`
- `IBCEVMProofBoundary`
- `IBCClient.trustedStateRoot(...)`
- `IBCClient.trustedPacketCommitment(...)`
- `SourcePacketCommitmentSlots`
- `IBCPacketHandler.recvPacketFromStorageProof(...)`

That boundary is still intentionally modest, but it is no longer a placeholder. It now verifies Ethereum Merkle Patricia Trie inclusion for synthetic account/storage proofs under a client-trusted root, and the packet handler now has a parallel receive path that consumes trusted storage proofs for `SourcePacketCommitment.packetLeafAt[sequence]` and `packetPathAt[sequence]`.

The script layer now hydrates an `executionStateRoot` from the source RPC block header and uses
`eth_getProof` for the packet storage slots as the canonical Besu runtime path. The older
packet-state Merkle proof path remains only behind the internal compatibility harness. What the repo
still does **not** do is verify Besu finalized headers on-chain.

### Running The Current Stack On Besu QBFT

The current Solidity contracts can now use the generated Besu operator and validator keys for deployment, relaying, and demo actions.

Generate and start the two local Besu bank chains:

```bash
npm run besu:generate
npm run besu:up
```

Then run the Besu-first deployment and demo stack:

```bash
npm run deploy:ibc-lite
npm run seed:ibc-lite
npm run demo:ui
```

The script layer maps Besu operators as:

- signer index `0` -> `deployer`
- signer index `1` -> `user`
- signer index `2` -> `relayer`

And it signs validator updates from the generated `validators.json` keys instead of using the Hardhat/Ganache mnemonic path.
