# Hướng dẫn lý thuyết và giảng giải hệ thống

Tài liệu này là bản ghi nhớ bền vững cho các buổi học và bảo vệ sau audit. Nó giải thích code hiện hành, không nâng kết quả test thành formal proof hoặc production assurance.

## 1. Câu chuyện hệ thống trong 90 giây

Bank A giữ tài sản gốc aBANK trong escrow. Gateway A ghi commitment của message vào storage. Sau khi block Bank A được QBFT finalize, quorum attestor 3-of-4 ký checkpoint EIP-712 chứa state root. Bank B chỉ chấp nhận khi gateway B tự kiểm tra EIP-1186-shaped account/storage proof dưới root đã checkpoint, đúng gateway, slot và commitment. Callback sau đó phát hành voucher vA có policy; vA có thể làm collateral trong lending pool Bank B. Acknowledgement từ Bank B lại được proof về Bank A để khép message.

Hệ thống là **consortium-trusted, proof-checked và asynchronous**. Nó không phải trustless light client và không cung cấp synchronous atomic transaction giữa hai chain.

## 2. Ba lớp tin cậy không được trộn lẫn

| Lớp | Trả lời câu hỏi | Không chứng minh |
| --- | --- | --- |
| QBFT validator set | Block nào là canonical/final trên từng bank chain? | Destination đã tin state root của chain kia |
| Checkpoint attestor quorum | Root nào của source chain được checkpoint client chấp nhận? | Storage value cụ thể có trong root |
| MPT account/storage proof | Account, slot và value cụ thể có/không có dưới root đã tin? | Root ban đầu là trung thực nếu quorum attestor thông đồng |

Relayer chỉ vận chuyển checkpoint, proof và transaction. Relayer có thể làm mất liveness bằng cách dừng hoặc trì hoãn, nhưng không thể tự tạo signature quorum hay proof hợp lệ. Collector xử lý phản hồi song song và dừng ngay khi có ba signer hợp lệ duy nhất; endpoint còn chậm bị abort để không cộng timeout vào mỗi checkpoint.

## 3. QBFT: safety, liveness và ý nghĩa của 4 validator

Với mô hình Byzantine fault tolerance chuẩn `n >= 3f + 1`, bốn validator cho phép lập luận trong phạm vi tối đa một Byzantine validator (`f=1`). Quorum commit 3-of-4 là hai phần ba làm tròn lên. Thử nghiệm của project dừng một validator và quan sát block tiếp tục; đó là **crash/unavailability exercise**, không phải Byzantine-message injection.

Hai điểm cần nói chính xác:

- QBFT cho immediate finality của block đã commit; `finalityDepth` trong runtime là khoảng chờ bảo thủ trước khi attestor ký, không biến probabilistic finality thành deterministic finality.
- BFT theorem phụ thuộc giả định về validator independence, network timing và implementation. Tám container local không chứng minh organizational independence.

Besu được pin `26.8.1` bằng OCI index digest. Bản nâng cấp này quan trọng với profile hiện tại vì upstream nêu các fix cho BFT transaction selection, QBFT round/vote và Bonsai state root. Evidence cũ dưới client pin trước chỉ là lịch sử và phải chạy lại.

## 4. EIP-712 checkpoint signatures

EIP-712 tạo digest typed structured data có domain separation. Trong project, payload checkpoint bind source chain, height, block hash, state root, timestamp và attestor epoch; domain bind destination chain và checkpoint-client contract. Vì vậy chữ ký hợp lệ cho client/chain này không tự động hợp lệ cho client/chain khác.

EIP-712 không tự cung cấp replay protection. Project phải tự dùng height, epoch, root conflict state, ordered unique signers và recovery authorization floor. Khi bảo vệ, không nói “EIP-712 chặn replay” mà nên nói “domain separation kết hợp protocol state chặn cross-domain reuse và stale authorization”.

## 5. EIP-1186, Merkle Patricia Trie và RLP

`eth_getProof` trả account proof và storage proof. Account tuple Ethereum có dạng RLP `[nonce, balance, storageRoot, codeHash]`. Luồng verifier:

1. Lấy trusted state root từ checkpoint client.
2. Hash address thành account-trie key và verify account proof.
3. Decode account RLP, yêu cầu bốn field và `storageRoot` đúng 32 byte.
4. Hash storage slot key và verify storage proof dưới `storageRoot`.
5. So sánh RLP-encoded expected storage value, hoặc kiểm divergent path/missing child cho absence proof.

MPT child reference có hai dạng: node encoded ngắn hơn 32 byte được inline; node dài hơn hoặc bằng 32 byte được tham chiếu bằng Keccak-256. RLP và hex-prefix phải canonical; chấp nhận encoding không canonical có thể tạo ambiguity giữa verifier.

Giới hạn học thuật: EIP-1186 hiện có status `Stagnant`; nó định nghĩa RPC proof shape chứ không phải một formal verification của Solidity verifier. Corpus offline 5+3 vector, differential reference walker, fuzz và live Besu observation là các lớp assurance bổ sung, không thay external audit/multi-client equivalence.

## 6. Message lifecycle: safety khác liveness

Luồng thành công:

```text
source commit -> source checkpoint -> destination receive/callback
              -> destination checkpoint -> source acknowledgement -> completed
```

Luồng timeout:

```text
source commit -> timeout -> destination receipt-absence proof -> refund/restitution
```

Safety cốt lõi là at-most-once successful effect. Gateway ghi receipt trước callback trong cùng EVM transaction; nếu callback revert thì receipt cũng revert. `completed` và `timed_out` loại trừ nhau. Điều này không bảo đảm message sẽ hoàn tất: chain, attestor hoặc relayer dừng vẫn có thể làm mất liveness.

Protocol là compensating chứ không atomic xuyên chain. Timeout cần proof rằng destination receipt vắng mặt. Nếu account gốc bị terminal revoke, tài sản đi vào restitution vault và chỉ được release qua identity, policy, timelock và adjudication reference.

## 7. Lending model

### 7.1 Utilization và kinked borrow rate

Project dùng:

```text
U = borrows / (availableCash + borrows)
```

với clamp 0–10.000 basis points. Borrow rate năm hàng năm là piecewise linear: `base + slope1 * U/kink` trước kink, sau kink là `base + slope1 + slope2 * (U-kink)/(1-kink)`. Mô hình này cùng họ với utilization/kink model phổ biến trong Compound-style lending; đây là implementation tham chiếu, không phải claim economic optimality.

Interest accrual là simple linear accrual trên mỗi khoảng thời gian được xử lý và cập nhật borrow index. Khoảng backlog dài được chia batch; timestamp chỉ tiến theo thời gian đã accrue, không bỏ qua phần dư.

### 7.2 Shares và reserves

Debt của borrower được biểu diễn bằng debt shares nhân borrow index. Supplier giữ liquidity shares và claim tỷ lệ trên `cash + borrows - reserves`. Reserve factor tách một phần interest vào protocol reserves. Khi pool assets về zero nhưng share cũ còn, liquidity-loss epoch phải tiến trước recapitalization để vốn mới không hồi sinh claim đã write-off.

Rounding là một phần semantics. Project mint/burn shares theo hướng đã chọn và có bounded invariant tolerance; không nên tuyên bố ERC-4626 compliance vì pool không triển khai interface ERC-4626 dùng chung.

### 7.3 Collateral, health factor và liquidation

Hai ngưỡng tách biệt:

- collateral factor giới hạn origination/borrow capacity;
- liquidation threshold xác định khi position có thể bị liquidate.

```text
healthFactor = collateralValueAfterHaircut * liquidationThreshold / debtValue
```

Không có debt thì health factor là vô cùng. Dưới `1e18` là liquidatable. Close factor giới hạn debt có thể repay trong một lần; liquidation bonus tăng collateral seize cho liquidator. Contract kiểm aggregate haircut/threshold/bonus invariant và chỉ cho preview executable khi partial liquidation không làm health factor xấu hơn.

Policy cap của project là unpaid **origination principal**, không phải tổng accrued debt exposure. Repayment xử lý accrued interest trước khi giải phóng principal capacity. Write-off đặt account vào defaulted state cho tới governed resolution.

## 8. Identity, policy và governance

Identity có active/expired/suspended/terminally-revoked semantics. Expiry được tính theo thời gian; suspension có thể phục hồi theo quyền; terminal revocation không được guardian tự re-activate.

Policy engine fail-closed khi identity registry được cấu hình, đồng thời theo dõi allowlist, asset/source-chain controls, velocity và exposure/principal. Governance timelock tách người đề xuất, người thực thi và delay. Timelock chỉ tạo thời gian quan sát/phản ứng; nếu proposer/executor/admin bị compromise theo cùng trust domain, delay không tự chữa rủi ro custody.

Emergency pause được thiết kế theo risk direction: guardian có thể chặn borrow và withdrawal làm tăng rủi ro, trong khi repay/collateral top-up có thể tiếp tục. Resume thuộc governance thay vì guardian.

## 9. Durability, idempotency và crash recovery

Ba khái niệm cần phân biệt:

- **Idempotency key** bind request ID với action/amount/lane.
- **Durable outbox** lưu exact signed raw transaction, hash, chain, signer và nonce trước broadcast.
- **On-chain replay guard** là receipt/message state tại contract.

Sau crash, runtime reconcile receipt/nonce và chỉ rebroadcast cùng raw transaction. Nó không tự sinh transaction khác ở nonce mới khi kết quả cũ mơ hồ. Đây là local-singleton safety; multi-process production cần transactional shared database/CAS.

Journal và evidence lock ghi/sync owner metadata hoàn chỉnh trước rồi mới atomic-publish public lock path. Lần chạy tiếp theo chỉ reclaim khi record hợp lệ, cùng host/platform và OS xác nhận PID đã chết. Lock malformed, foreign, live hoặc process probe không chắc chắn vẫn fail-closed; tuổi file không được dùng làm bằng chứng mồ côi.

Relay journal dùng lease heartbeat và monotonic fencing token: worker cũ hết lease không thể commit sau khi worker mới takeover. Restart validation tái tính protocol message ID, kiểm width số nguyên, block, transaction, retry, lease, timestamp và history; corruption fail trước khi relay tiếp tục.

## 10. Evidence và ngôn ngữ học thuật

| Từ | Điều kiện dùng |
| --- | --- |
| Enforced on-chain | Guard/invariant nằm trên execution path |
| Tested | Test xác định scope và budget đang pass |
| Observed | Report của một run có runtime, timestamp và provenance |
| Configured | Chỉ là intended config, chưa suy ra runtime health |
| Formally verified | Có formal model/tool/proof và scope công bố; project hiện không claim |

Line coverage 90%+, bốn selected mutants và bounded stateful runs tăng confidence nhưng không chứng minh không có bug. Live Besu proof cho thấy một client family tạo payload mà production gateway path chấp nhận trong run đó; nó không chứng minh Geth/Nethermind equivalence. SHA-256 report checksum phát hiện inconsistency trên host được tin, không phải third-party signed attestation.

## 11. Câu hỏi bảo vệ thường gặp

**Vì sao cần proof nếu attestor đã ký?** Attestor chỉ authorize root. Proof cho phép contract tự kiểm tra value cụ thể dưới root đó; relayer không được yêu cầu tin cậy về nội dung message.

**Tại sao không gọi hệ thống là trustless bridge?** Destination tin quorum attestor và governance thay vì tự verify consensus/validator-set transition của source chain.

**Nếu relayer gửi hai lần thì sao?** Gateway receipt và terminal state chặn successful effect lần hai; durable journal/outbox giảm duplicate submission nhưng contract là safety boundary cuối.

**Tại sao 3-of-4 attestor và 4 QBFT validator là hai quorum khác nhau?** Validator quorum finalize source ledger; attestor quorum authorize root cho checkpoint client ở destination. Chúng có thể dùng cùng con số nhưng khác role, key và trust assumption.

**Timeout có thể refund trong khi destination đã mint không?** Không nếu receipt đã tồn tại dưới checkpoint được proof; timeout path yêu cầu absence proof và terminal states loại trừ nhau. Liveness của việc thu thập checkpoint vẫn là giả định vận hành.

**Health factor khác borrow capacity thế nào?** Borrow capacity dùng collateral factor thận trọng cho origination; health factor dùng liquidation threshold để xác định liquidation. Tách hai ngưỡng tạo buffer rủi ro.

**Điểm yếu lớn nhất còn lại?** Single-client/single-host evidence, manual oracle, local JSON singleton journals, local keys, không formal verification/external audit và chưa có production organizational separation.

## 12. Nguồn chính đã đối chiếu

- [Ethereum Yellow Paper](https://ethereum.github.io/yellowpaper/paper.pdf) — account state, Merkle Patricia Trie và RLP.
- [EIP-1186: RPC method to get Merkle proofs](https://eips.ethereum.org/EIPS/eip-1186) — account/storage proof shape và status của EIP.
- [EIP-712: Typed structured data hashing and signing](https://eips.ethereum.org/EIPS/eip-712) — domain separation và security considerations.
- [EEA QBFT specification](https://entethalliance.github.io/client-spec/qbft_spec.html) và [Besu QBFT configuration](https://github.com/besu-eth/besu-docs/blob/main/docs/private-networks/how-to/configure/consensus/qbft.md) — quorum, validator topology và configuration.
- [IBFT 2.0 paper](https://arxiv.org/abs/2002.03613) — safety/liveness reasoning cho họ Istanbul BFT.
- [Besu 26.8.1 release](https://github.com/besu-eth/besu/releases/tag/26.8.1) — client fixes làm cơ sở cho pin hiện tại.
- [SoK: Communication Across Distributed Ledgers](https://eprint.iacr.org/2019/1128) — phân loại cross-chain communication và trust assumptions.
- [Compound whitepaper](https://compound.finance/documents/Compound.Whitepaper.v04.pdf) và [Compound III specification](https://github.com/compound-finance/comet/blob/main/SPEC.md) — utilization, indices, reserves và lending accounting tham chiếu.
- [Aave health factor and liquidations](https://aave.com/help/borrowing/liquidations) — thuật ngữ health factor/liquidation để đối chiếu; formula cụ thể của project vẫn do code project quy định.
- [ERC-4626 tokenized vault standard](https://eips.ethereum.org/EIPS/eip-4626) — share/asset rounding conventions; project chỉ tham chiếu, không claim interface compliance.
- [OpenZeppelin access control](https://docs.openzeppelin.com/contracts/5.x/access-control) — roles, default admin risk và timelock control.
- [Solidity security considerations](https://docs.soliditylang.org/en/latest/security-considerations.html) — checks-effects-interactions, reentrancy và defensive design.
- [Node.js file-system promises](https://nodejs.org/api/fs.html#promises-api) — ordering/durability assumptions cho journal và process lock.
- [NIST SSDF 1.1](https://csrc.nist.gov/pubs/sp/800/218/final) và [SLSA provenance v1.2](https://slsa.dev/spec/v1.2/provenance) — secure development, provenance và giới hạn của evidence.
