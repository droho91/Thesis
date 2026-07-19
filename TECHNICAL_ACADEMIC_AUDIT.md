# Technical And Academic Audit

Tai lieu nay khoa pham vi ky thuat de code, demo va luan van mo ta cung mot he thong.

## 1. Tuyen bo he thong

Day la reference prototype cho lending lien ngan hang tren hai Besu permissioned ledger. Tai san aBANK duoc khoa trong escrow cua Bank A; Bank B chi mint voucher vA sau khi destination contract xac minh duoc:

1. checkpoint cua Bank A co chu ky EIP-712 dat quorum 3-of-4;
2. account/storage proof EIP-1186 khop state root da duoc checkpoint;
3. commitment dung message, route, application, amount va timeout;
4. identity, policy va exposure limit cua khach hang van hop le.

Nen goi mo hinh nay la **institutional quorum-checkpoint gateway with proof-verified execution**. Day khong phai trustless light client, full IBC implementation hay production public bridge.

## 2. Duong tin cay end-to-end

```text
Bank A customer lock aBANK
  -> InstitutionalCollateralApp khoa tai san trong escrow
  -> InstitutionalCrossChainGateway ghi commitment vao storage slot co dinh
  -> 4 attestor doc finalized block va ky checkpoint EIP-712
  -> relayer gui checkpoint + quorum chu ky sang Bank B
  -> InstitutionalCheckpointClient chap nhan state root
  -> gateway Bank B verify account/storage proof duoi root do
  -> gateway ghi receipt truoc khi callback de chong replay
  -> collateral app kiem tra route, identity va policy, sau do mint vA
  -> lending pool dinh gia vA va enforce borrow/liquidation controls
```

Khi tat toan, Bank B burn vA va commit message nguoc lai. Bank A chi release aBANK sau checkpoint, proof va callback hop le. Acknowledgement duoc chung minh nguoc ve source de dua message vao terminal state `Completed`; timeout chi refund khi co proof vang mat destination receipt.

## 3. Security boundary

| Thanh phan | Bao dam trong code | Gia dinh tin cay / gioi han |
| --- | --- | --- |
| Besu QBFT | Moi bank co 4 validator; 3 validator van tao block khi 1 node dung | Bank kiem soat validator, networking va genesis; local test khong mo phong day du Byzantine behavior |
| Attestor quorum | Chu ky EIP-712 bind source checkpoint, destination chain va checkpoint client; duplicate/wrong signer bi reject | It nhat 3-of-4 attestor phai trung thuc; key production can HSM va operator doc lap |
| Checkpoint client | Enforce quorum, epoch, trusting period, clock drift va freeze khi co conflicting quorum | Governance cau hinh/rotate/recover attestor set |
| EVM proof boundary | Verify account va storage MPT proof duoi trusted state root | MPT/RLP code chua external audit hay formal verification |
| Gateway | Route binding, exact commitment, receipt/replay, ack, timeout va terminal-state exclusion | Governance cau hinh remote gateway/application route |
| Identity/policy | Credential status/expiry, allowlist, cap va exposure accounting on-chain | KYC source record va policy decision van la trach nhiem cua ngan hang |
| Lending | Oracle freshness, collateral factor, interest, liquidity, liquidation va bad debt | Manual oracle va simplified market model trong prototype |
| Relayer | Durable, retryable va idempotent transport | Co the delay/censor message, nhung khong the tu tao trusted root hay bypass proof |
| UI/runtime service | Gui transaction that va doc state on-chain | La presentation surface, khong phai security authority |

## 4. Mo hinh checkpoint

Checkpoint gom `sourceChainId`, `blockNumber`, `blockHash`, `stateRoot`, `timestamp` va `attestorEpoch`. EIP-712 domain bind chu ky voi destination chain va checkpoint-client contract, nen chu ky khong the replay sang lane khac.

Defense profile dung 4 attestor va threshold 3. Cach tiep can nay cho phep skip block height va rotate signer bang governance, nhung doi lai an toan phu thuoc quorum attestor thay vi verify truc tiep consensus validator set tren destination chain. Day la trade-off co chu dich cho consortium banking, khong duoc mo ta la trustless.

## 5. Message lifecycle

```text
Committed -> Checkpointed -> Received -> Acknowledged -> Completed
     \
      -> timeout reached + receipt absence proof -> Refunded
```

`Completed` va `Refunded` loai tru nhau. Receipt duoc ghi truoc application callback trong cung transaction; callback revert thi receipt cung revert. Relayer restart reconcile journal voi on-chain state truoc khi gui lai, con contract receipt/terminal flag la lop idempotency cuoi cung.

## 6. Invariant hoc thuat chinh

1. Chi application da authorize moi tao commitment.
2. Commitment bind day du source/destination chain, gateway, application, nonce, payload va timeout.
3. Destination execution can trusted checkpoint va proof cua dung storage slot/value.
4. Moi message chi co toi da mot successful destination execution.
5. Minted voucher khong vuot qua canonical collateral da khoa va chua settle.
6. Completion can acknowledgement proof; refund can timeout va receipt-absence proof.
7. Credential, policy, oracle va lending constraints duoc enforce tren chain noi action xay ra.
8. Sensitive administration di qua timelock; guardian chi co quyen dung khan cap.
9. Moi business request co client reference duy nhat; UI timeout/retry khong duoc lock hoac burn tai san lan hai.
10. Xoa debt chi duoc phep khi pool thu du dung so du da accrue; khong co dust write-off lam mat can bang ke toan.

## 7. Evidence trong repository

| Claim | Evidence |
| --- | --- |
| Checkpoint quorum, epoch, expiry va conflict freeze | `test/gateway/InstitutionalCheckpointClient.t.sol` |
| MPT account/storage proof boundary | `test/gateway/InstitutionalEVMProofVerifier.t.sol` |
| Commitment, receive, replay, ack va timeout | `test/gateway/InstitutionalCrossChainGateway.t.sol` |
| Lock/mint, burn/unlock va compensation | `test/apps/InstitutionalCollateralApp.t.sol` |
| Identity va timelock governance | `test/identity/`, `test/governance/` |
| Policy, valuation, interest va liquidation | `test/apps/BankPolicy.t.sol`, `test/apps/LendingValuation.t.sol` |
| Attestor, durable relay va process restart | `test/services/` |
| 11 adversarial scenario va fuzz debt conservation | `npm run security:test` |
| Live two-chain workflow va fault experiment | `npm run institutional:evidence` |

Unit tests chung minh contract invariant trong pham vi test. Security runner tao report gan voi source hash. Formal evidence runner yeu cau 100 message, provenance khop source, deployed bytecode hash va proof-and-acknowledgement p95 duoi 45 giay cho full safety path tren local Docker QBFT. Evidence nay van khong thay the external audit, formal verification hay production pilot.

## 8. Ly do runtime moi on dinh hon

- Mot topology duy nhat: 4 validator moi chain, duoc validate truoc deploy.
- Deployment manifest resume transaction da broadcast thay vi deploy lai mu quang.
- Checkpoint co the nhay height; khong can submit tung intermediate block header.
- Relayer co durable journal, lease, retry va on-chain reconciliation.
- UI chi goi API action nho; attestor va relay tu dong xu ly proof lifecycle.
- Evidence runner dung port, volume va container tach biet nen khong pha runtime trinh bay.
- Action journal luu `requestId`, transaction hash va trang thai truoc/sau broadcast; client reference on-chain ngan duplicate business action khi UI timeout.
- Besu scaffold tach rieng key/data cua tung validator, pin image digest va chi bind RPC vao loopback.

## 9. Gioi han va viec can truoc production

- External audit va formal verification cho gateway, MPT/RLP proof va financial contracts.
- HSM-backed attestor/validator/relayer keys, mTLS va independent bank infrastructure.
- Multisig proposer/executor, runbook rotation/recovery va monitored incident response.
- Production oracle, legal finality, privacy, AML/KYC integration va data-retention review.
- Shared transactional relay database, observability, backup va disaster-recovery drills.
- Load/soak testing theo acceptance target, khong suy rong latency tu mot laptop local.
- Differential test doc lap cho MPT/RLP verifier va nang cap Besu sau compatibility campaign.
- Evidence chinh thuc chi hop le tren mot clean, co chu dich Git commit; working tree dang thay doi khong duoc dung de tuyen bo reproducibility.

## 10. Cau noi bao ve ngan gon

"He thong dung mot institutional checkpoint quorum 3-of-4 de xac lap state root cua ledger doi tac, sau do destination gateway tu xac minh EVM storage proof truoc khi thuc thi dung mot lan. Relayer chi anh huong liveness; identity, policy, custody va lending risk tiep tuc duoc enforce on-chain. Day la consortium-trusted reference architecture, khong phai trustless public bridge, va cac gia dinh ve key custody, governance, oracle va audit duoc cong khai trong threat model."
