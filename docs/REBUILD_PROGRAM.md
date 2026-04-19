# Rebuild Program

This document marks a deliberate architectural pivot.

The current repository has a working Besu-backed prototype, but its canonical trust model is still a custom
attested-header client with a bespoke packet store and a minimal lending demo. That is useful as a research
artifact, but it is not the same as:

- native Besu QBFT finality verification on-chain,
- a fuller IBC core stack with connections, channels, acknowledgements, and timeouts,
- or a banking-grade risk and compliance control plane.

This rebuild program stops treating those gaps as small follow-up tasks. They are first-class architecture
boundaries and need a new implementation lane.

## Target Architecture

The replacement direction has three pillars.

### 1. Besu Light Client

The new client must trust raw Besu artifacts instead of custom checkpoint hashes.

The target client accepts:

- raw Besu block-header material,
- parsed QBFT `extraData`,
- commit seals tied to the actual header being finalized,
- validator-set transitions that are derived from chain-consensus rules instead of an off-chain resigning flow.

The target client stores:

- trusted header by height,
- trusted state root by height,
- trusted validator set / epoch by height,
- frozen evidence when conflicting finalized headers are observed.

### 2. IBC Core, Not Just Packet Consume

The new core stack needs the minimum pieces that make the packet lifecycle honest:

- connection state,
- channel state,
- packet commitments,
- packet receipts,
- acknowledgements,
- timeout handling,
- app callbacks for `OnRecvPacket`, `OnAcknowledgementPacket`, and `OnTimeoutPacket`.

This is still allowed to be a narrowed implementation, but it should look like a consciously reduced IBC
stack rather than a bespoke packet handler.

### 3. Banking Control Surface

The current lending pool is only a collateral demo. The rebuild should separate protocol verification from
institutional policy.

The control surface should at least make room for:

- counterparty / asset allowlists,
- exposure caps,
- collateral policies and haircuts,
- oracle or external price feed integration points,
- unlock / mint / borrow policy hooks,
- auditable administrative actions.

## Migration Strategy

The rebuild should not mutate the legacy prototype in-place until the new lane is coherent.

### Phase 0: Freeze And Quarantine

- Treat the existing custom stack as `legacy`.
- Keep it runnable for thesis comparison and fallback demo purposes.
- Do not extend the old `BankChainClient` model further.

### Phase 1: Besu Finality Foundation

Build a new `contracts/v2/clients/` lane that forces the design around raw Besu headers:

- raw header update types,
- parsed QBFT extra-data types,
- light-client interface that indexes trust by height,
- commit-seal verification boundary,
- validator-set transition boundary.

Current progress in this repo:

- `contracts/v2/clients/BesuLightClientTypes.sol`
- `contracts/v2/clients/IBesuLightClient.sol`
- `contracts/v2/clients/BesuQBFTExtraDataLib.sol`
- `contracts/v2/clients/BesuBlockHeaderLib.sol`
- `contracts/v2/clients/BesuLightClientBase.sol`
- `contracts/v2/clients/BesuLightClient.sol`
- `contracts/v2/core/IBCEVMTypesV2.sol`
- `contracts/v2/core/IBCEVMProofBoundaryV2.sol`
- `contracts/v2/core/BesuEVMProofVerifierV2.sol`
- `contracts/v2/core/IBCConnectionKeeperV2.sol`
- `contracts/v2/core/IBCChannelKeeperV2.sol`
- `contracts/v2/core/IBCPacketLibV2.sol`
- `contracts/v2/core/IBCPacketStoreV2.sol`
- `contracts/v2/core/IBCPacketStoreSlotsV2.sol`
- `contracts/v2/core/IBCProofVerifierV2.sol`
- `contracts/v2/core/IBCPacketHandlerV2.sol`
- `contracts/v2/core/IBCPacketReceiverV2.sol`
- `contracts/v2/test/StorageProofFixture.sol`
- `contracts/v2/test/MockPacketLifecycleAppV2.sol`
- `contracts/v2/test/MockPacketReceiverV2.sol`
- `contracts/v2/test/PacketProofBuilderV2.sol`
- `contracts/v2/apps/IBankPolicyEngine.sol`
- `contracts/v2/apps/BankPolicyEngineV2.sol`
- `contracts/v2/apps/PolicyControlledVoucherTokenV2.sol`
- `contracts/v2/apps/PolicyControlledEscrowVaultV2.sol`
- `contracts/v2/apps/PolicyControlledLendingPoolV2.sol`
- `contracts/v2/apps/PolicyControlledTransferAppV2.sol`
- `contracts/v2/apps/IAssetOracleV2.sol`
- `contracts/v2/apps/ManualAssetOracleV2.sol`
- `test/v2/BesuLightClientV2.t.sol`
- `test/v2/helpers/PacketHandlerV2Fixture.sol`
- `test/v2/PacketReceiveV2.t.sol`
- `test/v2/PacketAcknowledgementV2.t.sol`
- `test/v2/PacketTimeoutV2.t.sol`
- `test/v2/PacketHandshakeV2.t.sol`
- `test/v2/BankPolicyV2.t.sol`
- `test/v2/PolicyTransferAppV2.t.sol`
- `test/v2/LendingValuationV2.t.sol`
- `scripts/besu-header-v2.mjs`
- `scripts/fetch-besu-header-v2.mjs`
- `scripts/verify-besu-header-v2.mjs`
- `scripts/ibc-v2-config.mjs`
- `scripts/deploy-v2.mjs`
- `scripts/seed-v2.mjs`
- `scripts/demo-v2-flow.mjs`
- `scripts/smoke-besu-light-client-v2.mjs`
- `scripts/smoke-besu-proof-boundary-v2.mjs`
- `scripts/smoke-besu-packet-v2.mjs`
- `scripts/smoke-besu-timeout-v2.mjs`
- `scripts/smoke-besu-policy-packet-v2.mjs`

Validated milestones on the live Besu runtime:

- `npm run besu:verify:v2` recovers real commit-seal signers from Besu block `extraData`.
- `npm run besu:smoke:v2` deploys `BesuLightClient` on chain B, initializes a trust anchor, and accepts a real
  Besu header update on-chain.
- `npm run besu:proof:v2` verifies a live `eth_getProof` storage proof against the v2 light-client trusted
  state root.
- The v2 smoke scripts now emit structured JSON failure reports as well as success reports. When the Besu RPC
  runtime is unreachable from the current shell, the output file records the failing phase and diagnostic hints
  instead of leaving only a raw terminal exception.
- `npm run deploy:v2` is the new deployment entrypoint for the rebuilt stack. It deploys the Besu light clients,
  connection/channel keepers, packet handlers, packet stores, policy engines, policy-controlled transfer apps,
  escrow/voucher/debt/oracle/lending contracts, wires app roles and packet handler stores, and writes
  `.ibc-v2.local.json`. The proof-checked connection/channel handshake is intentionally left to the v2 demo flow
  so deployment remains separate from protocol execution.
- `npm run seed:v2` is the new seed entrypoint for the rebuilt stack. It reads `.ibc-v2.local.json`, mints Bank A
  canonical balances, funds Bank B debt liquidity and the liquidator wallet, configures policy allowlists/caps,
  sets oracle prices, applies collateral factor / haircut / liquidation settings, grants the liquidator role, and
  marks the v2 config as seeded.
- `npm run demo:v2` is the new protocol execution entrypoint for the rebuilt stack. It reads the deployed and seeded
  `.ibc-v2.local.json`, opens or reuses the proof-checked connection/channel handshake, executes the Bank A to Bank B
  packet with Besu storage proofs, verifies the acknowledgement back to Bank A, routes the voucher through the Bank B
  lending/liquidation lane, then proves a policy-denied packet timeout and writes `demo/latest-v2-run.json`.
- The demo UI service now prefers the v2 config and trace path. `Deploy + Seed` calls `deploy-v2.mjs` and
  `seed-v2.mjs`, `Run full flow` calls `demo-v2-flow.mjs`, and the status/read-model layer renders balances,
  trusted Besu light-client heights, packet receipts, acknowledgements, timeout state, and the latest v2 operation
  from `demo/latest-v2-run.json`.
- `demo-v2-flow.mjs` also supports `--step <action>` for UI-driven execution. The migrated v2 step actions cover
  forward lock/header trust/proof mint, lending deposit/borrow/repay/withdraw, reverse burn/header trust/proof
  unlock, replay rejection, and the receipt-absence safety explanation. Legacy freeze/recovery buttons are blocked
  with an explicit v2-not-wired message until native-header recovery UX is implemented.
- Besu runtime commands now have fast preflight guards. `besu:up` checks the Docker daemon before composing Besu,
  while `deploy:v2`, `seed:v2`, and `demo:v2` check Bank A/B RPC reachability before compiling or running long
  deployment logic. If Docker Desktop is closed or WSL integration is missing, the scripts now fail with an explicit
  runtime message instead of waiting 120 seconds and surfacing only `fetch failed`.
- `npm run besu:packet:v2` opens the connection and channel with proof-checked v2 handshake transitions, commits
  a packet on chain A, proves its leaf/path over `eth_getProof`, executes the packet on chain B with a written
  receipt and stored acknowledgement hash, then proves that acknowledgement back to chain A from chain B's
  trusted state root and delivers the verified acknowledgement to the source application callback. The packet
  envelope now carries source/destination channel IDs, opaque app data, and timeout fields inside the committed
  packet hash.
- `npm run besu:timeout:v2` opens the connection and channel with the same proof-checked handshake helper,
  commits a packet on chain A, intentionally leaves it unreceived on chain B, proves the destination receipt
  slot is absent under Bank B's trusted state root, marks the packet timed out on chain A after the trusted
  destination height reaches the committed timeout height, and delivers the timeout callback to the source
  application.
- `npm run besu:timeout:timestamp:v2` proves the timestamp branch on the live Besu runtime: the packet commits
  with `timeout.height = 0`, `timeout.timestamp` set from a real Bank B block time, the source light client
  trusts a later Bank B header, and the timeout succeeds only after the trusted remote timestamp reaches the
  committed timeout timestamp.
- `BesuLightClient` accepts forward non-adjacent header updates when the new header carries valid QBFT commit
  seals for the trusted validator set. Adjacent updates still enforce parent linkage. This keeps the live relayer
  usable on QBFT networks that produce empty blocks between protocol actions.
- `IBCConnectionKeeperV2` now has proof-checked `connectionOpenInit/Try/Ack/Confirm` transitions. Each step
  stores a compact connection commitment and the counterparty step verifies that commitment via an EVM storage
  proof under the local Besu light client's trusted state root.
- `IBCChannelKeeperV2` now has proof-checked `channelOpenInit/Try/Ack/Confirm` transitions. Channel routes are
  not packet-usable until the handshake reaches `Open`, and the committed channel state includes local/counterparty
  ports, channel IDs, connection hop, ordering, version, and counterparty chain ID.
- The old admin-open helpers were renamed to `openConnectionUnsafe` and `openChannelRouteUnsafe` so the ABI
  itself now marks them as scaffolding rather than protocol-correct flows.
- `BesuLightClient` now stores the parsed timestamp for each trusted Besu header. `IBCPacketHandlerV2` supports
  timestamp-based timeout as well as height-based timeout, with tests for both the accepted and not-yet-expired
  timestamp cases.
- The oversized `test/v2/PacketHandlerV2.t.sol` harness was split into lifecycle-focused suites:
  `PacketReceiveV2.t.sol`, `PacketAcknowledgementV2.t.sol`, `PacketTimeoutV2.t.sol`, and
  `PacketHandshakeV2.t.sol`. Shared synthetic proof construction now lives in
  `contracts/v2/test/PacketProofBuilderV2.sol` and `test/v2/helpers/PacketHandlerV2Fixture.sol`.
- `npx hardhat test test/v2/BesuLightClientV2.t.sol test/v2/PacketReceiveV2.t.sol
  test/v2/PacketAcknowledgementV2.t.sol test/v2/PacketTimeoutV2.t.sol test/v2/PacketHandshakeV2.t.sol`
  runs the focused v2 regression set. It covers valid Besu-style commit seals plus wrong parent, wrong state
  root, insufficient quorum, unknown signer, duplicate signer, mismatched validator set, packet replay,
  acknowledgement replay/fraud cases, receipt non-membership timeout, timestamp timeout, and proof-checked
  connection/channel handshake progression.
- `BankPolicyEngineV2` now provides a stateful policy surface with:
  - account and source-chain allowlists,
  - asset allowlists for mint, unlock, collateral, and debt legs,
  - voucher exposure caps,
  - collateral caps,
  - debt-asset caps and per-account borrow caps,
  - auditable `note...` hooks for voucher mint, canonical unlock, collateral accept/release, and debt borrow/repay.
- `PolicyControlledVoucherTokenV2`, `PolicyControlledEscrowVaultV2`, and `PolicyControlledLendingPoolV2`
  now place explicit institutional authorization boundaries around the `mint / unlock / borrow` actions that
  the legacy prototype treated as purely application-local logic.
- `PolicyControlledLendingPoolV2` now has an explicit valuation boundary:
  - optional `IAssetOracleV2` pricing,
  - configurable collateral haircut,
  - value-based borrow ceiling computation against the debt asset instead of an implicit 1:1 assumption.
  - role-gated liquidation for unhealthy positions, with close-factor and liquidation-bonus controls.
- `ManualAssetOracleV2` provides a concrete on-chain integration point for tests and demos while keeping the
  production boundary open for an external oracle adapter later.
- `PolicyControlledTransferAppV2` now reconnects the transport layer to the policy-controlled asset lane. It
  can:
  - lock canonical assets and commit a forward packet,
  - mint vouchers on receive only when policy allows,
  - burn vouchers and commit a reverse packet,
  - unlock canonical assets on reverse receive,
  - restore canonical assets or vouchers on timeout depending on which leg failed.
- `npx hardhat test test/v2/BankPolicyV2.t.sol` covers the new apps lane: policy-gated voucher minting,
  unlock-side exposure reduction, blocked collateral deposit for disallowed accounts, borrow cap enforcement,
  and policy-accounting updates on repay/withdraw.
- `npx hardhat test test/v2/PolicyTransferAppV2.t.sol` exercises the policy-aware packet application path:
  forward lock-and-send, receive-side mint authorization, reverse burn-and-release, acknowledgement recording,
  and timeout-triggered refund / voucher restoration behavior.
- `npx hardhat test test/v2/LendingValuationV2.t.sol` covers the valuation lane: unit-price fallback without
  an oracle, oracle-driven collateral valuation, haircut-adjusted collateral value, and debt-side borrow
  ceiling enforcement from normalized prices. It also covers role-gated liquidation for undercollateralized
  positions, close-factor rejection, healthy-position rejection, and policy-accounting updates when debt is
  repaid and collateral is seized.
- `scripts/smoke-besu-policy-packet-v2.mjs` is the live-runtime validation lane for the policy-aware packet app.
  It deploys the v2 transport and policy-controlled asset stack on both Besu chains, runs an approved transfer,
  routes the proven voucher into the Bank B lending pool, borrows against oracle/haircut-adjusted collateral,
  applies a price shock, liquidates part of the bad debt through an authorized liquidator, then runs a
  policy-denied packet path that falls back to timeout-based refund. In the current execution environment, this
  script is ready and `node --check` clean, but live verification remains blocked until the local Besu RPC
  endpoints are reachable from the tool runtime again. The script now also writes a structured failure report
  with the failing phase and diagnostic hints so runtime connectivity problems stop looking like a silent crash.

Success criterion:

- the codebase has a dedicated place where native Besu finality verification can be implemented without
  reusing the bespoke checkpoint model.
- the codebase has a v2 deployment config that can replace `.ibc-lite.local.json` for the next seed/demo/UI
  migration step.
- the codebase has separate v2 deploy, seed, and demo paths, so protocol execution no longer depends on
  deploy-everything smoke scripts.

### Phase 2: Minimal Honest IBC Core

Build a new `contracts/v2/core/` lane with:

- connection types,
- channel types,
- packet / receipt / acknowledgement / timeout state,
- app-facing callback interfaces.

Success criterion:

- the packet lifecycle is described by a state machine closer to IBC than the current fire-and-consume flow.

### Phase 3: Banking Policy And Risk

Build a new `contracts/v2/apps/` lane with:

- policy-engine interfaces,
- collateral policy hooks,
- credit limit / exposure controls,
- compliance gates around mint / unlock / borrow.

Success criterion:

- the system cleanly separates transport validity from institutional approval logic.

Current progress in this repo:

- `BankPolicyEngineV2` establishes a concrete policy engine instead of a placeholder interface.
- voucher minting, canonical unlock, collateral intake, and borrowing now have explicit policy checks and
  stateful policy-accounting hooks.
- the apps lane now includes a narrow valuation and liquidation surface, but it is still intentionally limited:
  it is not yet a full bank operating model with production oracle governance, legal-entity hierarchies, recovery
  waterfall accounting, or settlement-netting controls.

## Legacy Boundary

The following surfaces should now be read as legacy prototype surfaces:

- `contracts/clients/BankChainClient.sol`
- `contracts/clients/BankChainClientMessage.sol`
- `contracts/core/IBCPacketHandler.sol`
- `contracts/apps/CrossChainLendingPool.sol`

They remain valuable for comparison and for the currently working demo, but they are no longer the target
architecture for the rebuild.

## Immediate Next Step

The next concrete step is to connect the new policy lane back into the transport lane:

- build a policy-aware v2 packet application that routes verified `recv / ack / timeout` events into the new
  policy-controlled voucher / escrow surfaces,
- then add a live Besu smoke that shows a policy-approved mint path and a policy-denied path end to end.
