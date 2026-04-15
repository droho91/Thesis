# IBC-Lite Bank Chain Client Simulation

This repository is a local simulation of an IBC/light-client-like inter-chain client for two permissioned EVM bank chains.

The thesis contribution is the linkage layer:

- source-chain packet commitments
- source-certified checkpoint artifacts
- remote client state progression
- packet membership verification against trusted remote state
- one-time packet execution
- freeze and explicit recovery on conflicting certified updates

The lending system is now presented as an application workload on top of the linkage layer. A verified packet mints a voucher on Bank B; that voucher can be deposited into a deliberately minimal lending pool, borrowed against, repaid, withdrawn, burned, and then proven back to Bank A for unescrow.

No mainnet RPC, paid prover, cloud service, subscription API, or external infrastructure is required.

The local relayer signs validator-certified artifacts with the deterministic local mnemonic used by
Hardhat and Ganache, so the demo does not depend on node RPC methods such as `personal_sign`.
Override `LOCAL_CHAIN_MNEMONIC` only if you also start both local chains with the same mnemonic.

## Architecture

```text
contracts/
  core/       IBC client interfaces, proof verifier, packet handler, misbehaviour evidence
  clients/    BankChainClient and bank-chain client state/message/consensus types
  source/     source validator epochs, packet commitments, source checkpoints
  apps/       minimal transfer app, escrow vault, voucher token, voucher lending pool, local bank token
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
10. The user can use the verified voucher in `VoucherLendingPool` as the lending workload.
11. The reverse path burns the voucher on Bank B, commits a reverse packet, updates Bank A's remote client, proves membership, and unescrows from Bank A.

## Local Commands

Use writable temp/cache paths when running Hardhat from this sandboxed WSL workspace:

```bash
TMPDIR=/tmp XDG_CACHE_HOME=/tmp/.cache npm run compile
TMPDIR=/tmp XDG_CACHE_HOME=/tmp/.cache npm run test:solidity
```

## Demo Modes

The browser UI in `demo/` is now also the local contract controller. It explains the linkage model step by step and can trigger the real local actions through the `npm run demo:ui` server.

The UI has direct operation buttons instead of a passive diagram:

- `Deploy + Seed`: deploy the two-chain IBC-lite stack and seed demo balances.
- Lock/mint path: `Lock aBANK`, `Commit A Checkpoint`, `Update B Client`, `Prove + Mint Voucher`.
- Lending workload: `Deposit Voucher`, `Borrow sBANK`, `Repay sBANK`, `Withdraw Voucher`.
- Burn/unlock path: `Burn Voucher`, `Commit B Checkpoint`, `Update A Client`, `Prove + Unlock aBANK`.
- `Run Full Flow`: execute the whole sequence from escrow to unescrow.

The contract-backed flow writes the latest proof trace to `demo/latest-run.js` and `demo/latest-run.json` so the UI can display the real packet ids and hashes.

1. Bank A user escrows `aBANK`.
2. Bank A writes a packet commitment.
3. Bank A commits a source checkpoint.
4. Bank B updates its `BankChainClient` from a validator-certified artifact.
5. Bank B verifies packet membership proof and executes the packet once.
6. Bank B mints `vA`.
7. The user deposits `vA` into the minimal lending pool, borrows, repays, and withdraws.
8. Bank B burns `vA`, writes a reverse packet, Bank A updates its client, verifies proof, and unescrows `aBANK`.

Start the UI controller:

```bash
npm run demo:ui
```

Then open `http://127.0.0.1:5173/`.

Start local chains:

```bash
npm run node:chainA
npm run node:chainB
```

Deploy and seed from terminal if you do not want to use the UI buttons:

```bash
TMPDIR=/tmp XDG_CACHE_HOME=/tmp/.cache npm run deploy:ibc-lite
npm run seed:ibc-lite
npm run demo:flow
```

On Windows PowerShell, set the temp/cache variables like this before deploying:

```powershell
$env:TMPDIR="C:\Users\outta\AppData\Local\Temp"
$env:XDG_CACHE_HOME="C:\Users\outta\AppData\Local\Temp\.cache"
npm run demo:ui
```

Then use `Deploy + Seed` and either the step-by-step operation buttons or `Run Full Flow` in the browser.

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
- voucher lending use case after proof execution
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
