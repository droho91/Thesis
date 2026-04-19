# Local System Test Plan

## Canonical Runtime

The thesis demo now targets the v2 Besu-first stack:

- native Besu/QBFT header updates through `BesuLightClient`
- proof-checked connection and channel handshakes
- EVM storage proofs from `eth_getProof`
- packet receipts, acknowledgements, timeouts, replay protection
- policy-controlled voucher, lending, freeze, and recovery paths

The older `ibc-lite` scripts remain as compatibility utilities, but they are not the primary system-test path.

## Start The Bank Chains

```bash
npm run besu:generate
npm run besu:up
```

Expected result:

- Bank A RPC is ready on `http://127.0.0.1:8545`
- Bank B RPC is ready on `http://127.0.0.1:9545`
- chain IDs are `41001` and `41002`

## Deploy And Seed

```bash
npm run deploy:v2
npm run seed:v2
```

Expected result:

- `.ibc-v2.local.json` is written
- both chains have a `BesuLightClient`, connection keeper, channel keeper, packet store, packet handler, and app contracts
- Bank A source user receives `aBANK`
- Bank B lending pool receives `bCASH`
- policy, oracle, exposure cap, borrow cap, and liquidation parameters are seeded

## Full Flow

```bash
npm run demo:v2
```

Expected result:

1. Connection handshake opens with storage-proof verification.
2. Channel handshake opens with storage-proof verification.
3. Bank A locks canonical `aBANK` and commits a packet.
4. Bank B trusts a native Besu header for Bank A.
5. Bank B verifies packet storage proof and mints `vA`.
6. Bank A verifies the acknowledgement storage proof.
7. Bank B accepts `vA` as collateral.
8. User borrows `bCASH`, then repays and withdraws collateral.
9. Bank B burns `vA` and commits the reverse packet.
10. Bank A verifies the reverse storage proof and unescrows `aBANK`.
11. Timeout and absence-proof paths remain available for denied packets.

Trace output:

```text
demo/latest-v2-run.json
demo/latest-v2-run.js
```

## UI Demo

```bash
npm run demo:ui
```

Open:

```text
http://127.0.0.1:5173/
```

Use the UI controls in this order for a narrated demo:

1. Deploy + Seed
2. Run Full Flow
3. Replay Forward
4. Submit Conflict
5. Recover Client
6. Check Non-Membership

Use `Reset to Seeded` whenever you need to restart the narrated flow from a clean post-seed baseline. It creates a fresh v2 deployment and reseeds policy, oracle, balances, and trace state.

The state inspector should show:

- `Replay gate: blocked`
- `Safety state: Active / Active` after recovery
- misbehaviour evidence as frozen height, evidence hash, or recovered height
- v2 trace phase such as `forward-proven`, `replay-blocked`, `client-frozen`, or `client-recovered`

## Individual CLI Actions

For single-step checks, run the v2 flow script directly:

```bash
USE_BESU_KEYS=true RUNTIME_MODE=besu PROOF_POLICY=storage-required node scripts/demo-v2-flow.mjs --step replayForward
USE_BESU_KEYS=true RUNTIME_MODE=besu PROOF_POLICY=storage-required node scripts/demo-v2-flow.mjs --step freezeClient
USE_BESU_KEYS=true RUNTIME_MODE=besu PROOF_POLICY=storage-required node scripts/demo-v2-flow.mjs --step recoverClient
USE_BESU_KEYS=true RUNTIME_MODE=besu PROOF_POLICY=storage-required node scripts/demo-v2-flow.mjs --step checkNonMembership
```

Expected results:

- `replayForward` creates/proves a forward packet if needed, then confirms the destination receipt blocks replay.
- `freezeClient` submits conflicting native Besu header evidence and moves Bank B's Bank A client to `Frozen`.
- `recoverClient` begins recovery, re-anchors at a newer Besu header, clears evidence, and returns the client to `Active`.
- `checkNonMembership` records that the receipt-absence proof path is available for timeout safety.

## Smoke Tests

When the Besu chains are running:

```bash
npm run besu:smoke:v2
npm run besu:proof:v2
npm run besu:packet:v2
npm run besu:policy:v2
npm run besu:timeout:v2
npm run besu:timeout:timestamp:v2
```

Expected result: each command exits with code `0`.

## Contract Regression

```bash
npm run compile
npm run test:v2
```

Expected result:

- valid commit seals are accepted
- insufficient, duplicate, unknown, or mismatched commit seals are rejected
- conflicting trusted height freezes the client
- recovery requires a frozen client, a recovery state, and a forward trusted anchor

Hardhat 3 expects Solidity test files, not a directory argument. Use `npm run test:v2` for the full v2 contract regression set, or pass explicit `.t.sol` files to `npm run test -- ...`.
- recovery clears frozen evidence and returns the client to `Active`

## Known Runtime Note

Local Besu may not retain historical world state for old `eth_getProof` calls. The demo therefore builds packet and acknowledgement proofs against a current trusted head after confirming that the relevant commitment still exists. This keeps the demo compatible with non-archive local Besu nodes while preserving the same on-chain proof verification path.
