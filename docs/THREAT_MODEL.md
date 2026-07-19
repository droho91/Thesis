# Threat Model

## System Positioning

This project is a reference prototype for institutional cross-chain collateral and lending on two permissioned Besu/QBFT ledgers. It uses quorum-signed checkpoints and EVM account/storage proofs to authorize asynchronous cross-chain execution.

It is not a trustless public bridge, not a full IBC implementation, not audited, and not production-ready.

## Protected Assets and Properties

- Canonical aBANK held in Bank A escrow.
- Voucher vA supply and the one-to-one unsettled collateral liability.
- bCASH liquidity, borrower debt, reserves, and lending solvency state.
- Message commitments, receipts, acknowledgements, refunds, and terminal states.
- Attestor, validator, relayer, governance, identity, oracle, and operator keys.
- Safety properties: proof validity, route integrity, replay resistance, conservation, policy enforcement, and governance delay.
- Liveness properties: block production, checkpoint availability, relay progress, acknowledgement, and timeout recovery.

## Trust Assumptions

| Component | Trust assumption | Principal risk | Implemented control / remaining boundary |
| --- | --- | --- | --- |
| Besu validators | Each bank operates a governed 4-validator QBFT network. | Collusion, network partition, or loss of quorum. | The profile tolerates one unavailable validator; Byzantine injection and cross-bank infrastructure independence require further validation. |
| Attestors | Fewer than 3 of 4 attestors are malicious or compromised. | A malicious quorum can attest an arbitrary root. | EIP-712 domain binding, signer ordering, epoch/quorum checks, trusting period, conflict freeze, and durable equivocation guards. Production keys require separate HSM-backed operators. |
| Checkpoint governance | Timelock governance rotates attestors and recovers frozen clients only after institutional review. | Malicious or mistaken signer/route replacement. | Sensitive roles are transferred to timelocks; production proposers/executors must be multisig-controlled. |
| Relayer | Relayers may fail, duplicate, delay, or reorder work. | Censorship and delayed settlement. | Relayers cannot create a quorum or bypass proof checks. Durable jobs, reconciliation, retries, leases, and on-chain idempotency support recovery. |
| EVM proof verifier | MPT/RLP verification and storage-slot derivation are correct. | A parser or boundary bug may accept invalid state. | Account, slot, value, root, absence, and malformed-proof tests exist; no audit or formal proof is claimed. |
| Gateway routes | Governance configures the intended remote gateway and applications. | Misrouting, stale migration trust, or privileged abuse. | Chain/gateway/application binding, explicit old-endpoint revocation, pause, replay receipts, and mutually exclusive terminal states. |
| Identity and policy | Bank KYC/compliance systems issue correct on-chain eligibility and limits. | Fraudulent credential, stale status, or unsafe cap. | Expiry/status checks, terminal revocation, role separation, allowlists, per-account and asset caps, exposure accounting, and guardian suspension. Off-chain KYC correctness remains trusted. |
| Oracle | Authorized operators publish accurate and timely prices. | Manipulated or stale valuation can create bad debt. | Timestamped prices, staleness checks, risk caps, liquidation, reserve accounting, and pause. The local manual oracle is not a production oracle network. |
| Lending contracts | Financial parameters reflect the bank's risk policy. | Insolvency from parameter error or implementation bug. | Collateral factor, liquidation threshold, close factor, interest, liquidity, reserve, and bad-debt controls are tested; economic modeling is simplified. |
| UI/runtime service | The presentation service submits user actions and reads chain state. | Stale display or unavailable interface. | It holds no proof-validation authority; contracts remain the source of truth. Local generated accounts are demonstration credentials only. |

## Adversary Capabilities Considered

- Submit malformed, stale, wrong-domain, duplicate-signer, or insufficient-quorum checkpoints.
- Relay a valid proof with the wrong account, storage slot, value, route, application, nonce, payload, or timeout.
- Repeat delivery, acknowledgement, or timeout transactions before and after a relayer restart.
- Stop one validator, one attestor, or the relayer process.
- Attempt completion after refund, refund after completion, or execution after receipt insertion.
- Use expired, suspended, revoked, disallowed, over-cap, or undercollateralized customer state.
- Trigger stale-price, illiquid, liquidation, and bad-debt paths.
- Reuse an action request identifier after an ambiguous UI timeout or process restart.
- Transfer a collateral voucher directly between customer wallets to bypass the approved lending route.

## Enforced On-Chain

- Checkpoint signer membership, threshold, epoch, domain, age, clock drift, monotonic height, and conflict freeze.
- EVM account/storage membership and absence proofs under an accepted state root.
- Exact message commitment, trusted gateway, application route, receipt, acknowledgement, timeout, and replay checks.
- Escrow/voucher conservation and application compensation callbacks.
- Unique client references at the origin application, message receipts at the destination, and mutually exclusive terminal states.
- Identity eligibility, policy allowlists, caps, exposure accounting, and emergency pause.
- Operator-restricted voucher transfers and terminal credential revocation.
- Oracle freshness, borrowing capacity, liquidity, interest, liquidation, reserve, and bad-debt accounting.
- Timelocked administrative ownership after bootstrap.

## Off-Chain but Security-Relevant

- Attestors independently read finalized source blocks and persist an equivocation guard before signing.
- Relayers collect signatures, construct EIP-1186 proofs, persist jobs, retry, and reconcile with on-chain state.
- Validators, attestors, relayers, RPC access, private networking, monitoring, backup, and key custody require bank operational controls.
- The local UI starts these services for presentation convenience; this does not move validation out of the contracts.

## Availability and Failure Semantics

- One of four validators may stop while the remaining three retain QBFT block production.
- Two stopped validators remove quorum and must halt progress safely.
- Fewer than three available attestors prevent new checkpoints and settlement but do not authorize invalid execution.
- Relayer outage delays settlement; restart resumes durable jobs and reconciles transactions that may have mined before the crash.
- Acknowledgement proves completion. After timeout, a destination receipt-absence proof is required before compensation.
- Gateway pause blocks new sends and destination receives, while proof-checked acknowledgement and timeout transitions remain available so already verified work can reach a terminal state.
- If escrow, voucher, or identity policy prevents a compensation callback, the whole timeout transaction reverts atomically. The message stays `Pending`, no asset is lost, and the same proof can be retried after the hold is resolved.

## Known Limitations

- Consortium-trusted 3-of-4 attestor model rather than source-validator trust minimization.
- Local deterministic keys, loopback RPC, short governance delay, and manual oracle are defense-profile choices only. Generated validator keys are isolated per container but are not HSM-backed credentials.
- No external smart-contract audit, formal verification, privacy review, or regulatory certification.
- No production HSM/mTLS deployment, shared relay database, multisig governance, or disaster-recovery exercise.
- Single collateral and debt market with simplified interest and liquidation economics.
- Crash-fault validator evidence exists; a complete Byzantine validator/attestor adversarial campaign does not.
- Performance observations from one local machine are not production throughput or latency claims.
