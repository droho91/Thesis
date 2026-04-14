# Cross-Chain Lending System Test Plan

System tests validate the local two-chain product flow:
- Chain A and Chain B local nodes
- proof-based bridge modules
- lending pool
- relayers
- borrower and owner demo portals

## Startup

Terminal 1:
```bash
npm run node:chainA
```

Terminal 2:
```bash
npm run node:chainB
```

Terminal 3:
```bash
npm run deploy:multichain
```

Terminal 4:
```bash
npm run seed:multichain
```

Terminal 5:
```bash
npm run worker:hub
```

Terminal 6:
```bash
cd demo
python -m http.server 5500
```

Open:
- `http://localhost:5500/user.html`
- `http://localhost:5500/owner.html`

## Expected Workers

`worker:hub` starts:
- `header-relayer`
- `proof-relayer`
- `risk-watcher`

Expected log language:
- finalized header accepted
- execution header stored
- proof verified
- message consumed or skipped as already consumed
- route active, paused, or cursed

Workers should describe header/proof transport only; correctness is enforced by destination contracts.

## Core Scenarios

## ST-01 Cold Boot

Steps:
1. Start both local chains.
2. Deploy and seed.
3. Start worker hub.
4. Open user and owner portals.

Expected:
- `demo/multichain-addresses.json` includes light clients, message buses, routers, registries, risk managers, and route IDs.
- UI shows proof-mode bridge status.
- Worker logs show relayer transport, not trusted execution.

## ST-02 Lock -> Mint

Steps:
1. User selects `A_TO_B`.
2. User locks `aCOL` on Chain A.
3. Header relayer submits Chain A finalized header to Chain B.
4. Header relayer stores Chain A execution header on Chain B.
5. Proof relayer submits the receipt proof to Chain B `BridgeRouter`.
6. User refreshes.

Expected:
- Chain A vault locked balance increases.
- Chain B `wA` balance increases only after proof verification.
- UI progresses through message dispatched, header relayed, proof ready/verified, and consumed/minted states.

## ST-03 Borrow And Repay

Steps:
1. User deposits minted wrapped collateral.
2. User borrows stable within LTV.
3. User repays stable.
4. User withdraws wrapped collateral.

Expected:
- Lending state updates normally.
- Cross-chain release remains blocked until wrapped collateral is burned and proven.

## ST-04 Burn -> Unlock

Steps:
1. User burns wrapped collateral on the lending chain through `BridgeRouter.requestBurn`.
2. Header relayer submits finalized destination-chain header to source-chain light client.
3. Header relayer stores destination-chain execution header on source chain.
4. Proof relayer submits receipt proof to source-chain `BridgeRouter`.

Expected:
- Source collateral unlocks only after proof verification.
- Message ID is consumed and cannot be replayed.

## ST-05 Risk Controls

Steps:
1. Configure a route pause or curse through `RiskManager`.
2. Attempt proof relay for that route.

Expected:
- Proof may be structurally valid, but router execution fails at route policy.
- Clearing the risk control allows future valid messages.

## ST-06 High-Value Approval

Steps:
1. Use an amount above the route high-value threshold.
2. Relay valid header and proof.
3. Apply secondary approval.
4. Relay again.

Expected:
- First relay fails with high-value approval required.
- Approved message succeeds without relying on relayer trust.

## Pass Criteria

A system scenario passes when:
- contract state matches the expected lifecycle
- UI describes header relay, proof verification, route policy, and message consumption
- relayer logs show header/proof transport
- replayed messages remain blocked
- paused, cursed, rate-limited, and high-value policies are enforced as secondary controls

## Out Of Scope

- production consensus verification
- real receipt trie verification
- adversarial chain reorg simulation
- production oracle, governance, and incident-response systems
