# Institutional Cross-Chain Lending

Reference prototype cho nghiệp vụ khóa tài sản thế chấp liên ngân hàng trên hai mạng Besu/QBFT permissioned. aBANK luôn nằm trong escrow tại Bank A; Bank B chỉ phát hành voucher vA sau khi checkpoint quorum và EVM storage proof được kiểm tra. vA sau đó có thể được dùng làm tài sản bảo đảm để vay bCASH.

Incident recovery dùng checkpoint authorization floor để vô hiệu proof từ root trước recovery. Nếu sender bị revoke vĩnh viễn trong lúc message timeout, compensation được giữ trong restitution vault có accounting on-chain và chỉ được release qua governance tới recipient đang đạt identity/policy checks.

> Đây là research prototype theo mô hình consortium-trusted, chưa được external audit, formal verification hoặc chứng nhận production. Xem [Threat Model](docs/THREAT_MODEL.md) trước khi diễn giải các bảo đảm an toàn.

## Khởi chạy lần đầu

Sau khi chuyển từ demo cũ hoặc thay đổi topology/runtime:

```bash
npm install
npm run demo:fresh
```

Lệnh này thay topology một validator bằng hai mạng QBFT, mỗi mạng bốn validator, rồi mở UI tại `http://127.0.0.1:5173/`.

> Cảnh báo: `demo:fresh` xóa Docker volumes và toàn bộ chain state cục bộ hiện tại trước khi tạo lại runtime.

## Dùng lại runtime hiện tại

```bash
npm run demo:prepare
npm run demo:ui
```

Trong terminal thứ hai, kiểm tra trạng thái trước khi trình bày:

```bash
npm run demo:doctor
```

Chỉ bắt đầu demo khi dòng cuối là `READY FOR DEFENSE`.

`demo:prepare` khởi động hai chain Besu/QBFT, deploy institutional stack, seed tài khoản và thanh khoản, rồi chuyển quyền quản trị nhạy cảm sang timelock. UI khởi tạo bốn local attestor service và automatic relayer có journal; người dùng chỉ thao tác lock/issue, lending và settlement.

UI chỉ chấp nhận đúng origin loopback được in khi khởi động. SPA bootstrap một phiên cookie `HttpOnly`, `SameSite=Strict`; CSRF token tương ứng chỉ giữ trong bộ nhớ trình duyệt và bắt buộc trên `POST /api/action`. Host/Origin sai, request không có `Sec-Fetch-Site: same-origin`, Content-Type khác `application/json` hoặc token không khớp đều bị từ chối trước khi runtime thực thi action.

Mỗi action tài chính cần một `requestId`. Trước khi broadcast, runtime ký giao dịch một lần rồi ghi bền vững raw transaction, hash, chain, signer và nonce vào action-journal v3; journal v1/v2 được migration có đánh dấu provenance. Sau restart, worker tự quét action chưa kết thúc, kiểm tra đúng hash trên chain và chỉ phát lại chính raw transaction đã lưu; nó không tạo giao dịch thay thế ở nonce mới cho một kết quả mơ hồ. Trong lúc đó, một global fence chặn mọi action tài chính mới và UI giữ nguyên toàn bộ `{requestId, action, amount}` qua timeout/lỗi transport; cùng ID không thể bị tái dùng với intent khác. Cơ chế này bảo vệ đường action của local singleton runtime; test hiện mô phỏng crash-window và reopen, không phải bằng chứng SIGKILL/DR hay cam kết business-level “exactly once” cho client ngoài hoặc deployment nhiều process.

Mỗi JSON journal giữ một lock file độc quyền trong suốt vòng đời process. Hai process dùng chung journal sẽ fail-closed; một crash không sạch có thể để lại lock cần operator xác minh ownership trước khi gỡ thủ công. Xem [Runtime operations](docs/RUNTIME_OPERATIONS.md) và [Relayer/attestor operations](docs/RELAYER_ATTESTOR_OPERATIONS.md).

Financial semantics Phase 4 tách emergency pause theo từng action: guardian mặc định chặn origination và các withdrawal làm tăng rủi ro, nhưng repayment, collateral top-up, liquidity supply, liquidation và bad-debt recognition vẫn hoạt động; governance có thể dừng từng lớp riêng. Accrual trên một năm được giữ thành backlog và xử lý theo batch thay vì xóa thời gian dư. Application route được version theo `(chainId, remoteApplication)`, có transfer lifetime tối đa bảy ngày và chỉ revoke sau drain window cùng pending-count bằng không.

Policy cap được định nghĩa rõ là **origination principal**, không phải accrued debt exposure: cap theo account cộng gộp qua mọi debt asset, cap theo asset được theo dõi riêng, và repayment trả accrued interest trước khi giải phóng principal capacity. Bất kỳ debt write-off nào cũng đặt account vào trạng thái defaulted; borrowing chỉ mở lại sau một governance resolution có reference. Liquidation config kiểm tra invariant tổng hợp giữa haircut, threshold và bonus; preview/execution giới hạn collateral seize để health factor sau một partial liquidation không thấp hơn trước.

Phase 5 khóa tiếp các semantics assurance/interface. `maxCheckpointSubmissionAge` chỉ giới hạn tuổi checkpoint lúc gửi, không làm root đã chấp nhận tự hết hạn. Proof suite có corpus branch/extension/inline node, canonical RLP/hex-prefix guards, malformed/mutated fuzz và verifier đối chiếu độc lập; live integration vẫn dùng proof EIP-1186 từ Besu, nhưng đây không thay thế external audit hoặc formal proof. Outbound velocity được tách theo `(account, asset, day)`; gateway/application bind đúng `block.chainid`; lending market hiện từ chối token khác 18 decimals, yêu cầu dependency/oracle có bytecode và dùng supplier-loss epoch trước recapitalization khi assets đã về zero.

Phase 6 giữ nguyên hành vi nhưng tách các seam lớn thành module: durable action/outbox, deployment manifest, benchmark/validator evidence, shared JSON/transaction receipt, lending pure math và ba UI domain/presentation module. Sáu monolith được theo dõi giảm tổng cộng 790 dòng; compatibility exports, contract ABI/storage và report schema được giữ nguyên. `.env.example` giờ chỉ chứa key source thực sự đọc và có automated drift gate; dependency trực tiếp không dùng đã được loại bỏ.

Phase 7 hoàn thiện lớp trình chiếu desktop: light-theme tokens được gom về một nguồn, CSS override/dead selector được loại bỏ, cỡ chữ hiển thị có floor kiểm thử, workflow và lending tab dùng roving keyboard semantics, disclosure quản lý focus/`hidden`/`inert`, còn motion chỉ chạy ở trạng thái phù hợp và tôn trọng `prefers-reduced-motion`. Browser gate chạy axe, overflow và projector-typography checks trên cả sáu workflow tab-state ở ba desktop viewport. Visual regression gồm 10 baseline: Identity ở cả ba viewport, cùng Transfer, bốn lending modes, Settlement và Evidence tại `1600×900`.

Phase 8 tăng độ sâu verification mà không thay đổi protocol semantics. Corpus cố định gồm 5 vector trie tổng quát và 3 vector account/storage theo wire format tương thích EIP-1186; artifact được tạo xác định bằng `@ethereumjs/trie@6.2.1` cùng npm integrity đã pin rồi so sánh byte-exact khi verify. Corpus này là fixture offline với `evidenceEligible=false` và `validatedLiveClients=[]`, không phải proof capture từ Besu/Geth đang chạy. Stateful lending harness khám phá 12 bounded actions và kiểm tra 4 accounting properties với budget 64 runs × 64 calls; kết quả chỉ có nghĩa chưa tìm thấy counterexample trong budget đó, không phải formal proof.

Phase 9 đóng khoảng trống giữa “có integration path” và “có live observation”. Integration report v3 ghi `web3_clientVersion` của cả hai bank chain và giữ một tập bounded gồm commitment/acknowledgement membership proof từ mỗi chain; proof chỉ được ghi nhận sau khi transaction qua `InstitutionalCrossChainGateway` thành công. Validator yêu cầu đúng Besu `v24.10.0` trong cả dạng client string chuẩn lẫn dạng có node identity, `eth_getProof`, deployed gateway account, raw proof nodes, digest và bốn tổ hợp kind/chain. Summary v4 và `demo:doctor` từ chối report cũ hoặc report không có live-client proof. Đây vẫn là single-client Besu evidence, không phải multi-client validation.

Status UI không còn suy `healthy/online/ready` từ một RPC read hoặc một attestor. Snapshot tách `runtimeReadable`, `chainsProgressing`, `attestorQuorumReady`, `relayerHealthy`, `governanceEnforced`, `identitiesEligible` và `laneReady`; action chỉ mở khi lane hiện tại sẵn sàng. Amount được parse thành decimal string/`BigInt` đủ 18 decimals. Nếu refresh thất bại, snapshot thao tác bị xóa và form khóa tới lần đọc thành công tiếp theo.

Có thể chạy toàn bộ luồng bằng một lệnh:

```bash
npm run demo:start
```

## Kiểm thử

Unit, service và UI source checks:

```bash
npm test
```

Các gate verification-depth có thể chạy riêng hoặc theo nhóm:

```bash
npm run mpt:corpus:verify
npm run test:invariants
npm run test:coverage
npm run test:mutation
npm run test:verification-depth
```

Coverage gate đo line coverage của deployable protocol sources, yêu cầu global tối thiểu 90%, từng file tối thiểu 50% và floor riêng 70–100% cho 11 trust-boundary files. Mutation smoke dùng đúng bốn mutation có chủ đích tại MPT root binding, replay receipt, recovery authorization floor và liquidation-risk boundary. `4/4 killed` chỉ là 100% của tập bounded này, không phải full mutation coverage của repository. Cả coverage report và mutation report đều là test assurance, không phải live Besu defense evidence.

Browser accessibility, keyboard, projector typography, overflow, motion và visual regression là gate riêng vì cần Chromium cùng thư viện hệ thống:

```bash
npx playwright install --with-deps chromium
npm run test:browser:preflight
npm run test:browser
```

Preflight xác minh executable, Linux shared libraries và một lần headless launch trước khi Playwright chạy; report chẩn đoán được ghi tại `.runtime/verification/browser-runtime-preflight.json` với `evidenceEligible=false`. Môi trường baseline chuẩn là Chromium được khóa bởi `package-lock.json` trên Ubuntu 24.04, light theme, locale `en-US`, timezone UTC và ba viewport `1366×768`, `1600×900`, `1920×1080`. CI workflow được cấu hình để chạy lại gate này. Khi thay đổi UI có chủ đích, chỉ cập nhật ảnh sau khi review trực quan đủ 10 baseline: ba ảnh Identity theo viewport và bảy ảnh operation-state tại `1600×900`:

```bash
npm run test:visual:update
```

Dữ liệu tại `test/ui/fixture-data.mjs` là fixture tổng hợp theo đúng phần shape mà UI tiêu thụ, gồm 5 integration và 14 security entries với nội dung đủ dài để kiểm layout. Các nhãn pass trong fixture **không phải** validation evidence của runtime, không chứng minh Besu đang chạy và không được dùng làm evidence khi bảo vệ; evidence thật vẫn phải đến từ isolated run trên clean reviewed commit.

Live integration tự kiểm tra runtime, deploy, governance và chạy luồng hai chain:

```bash
npm run institutional:test
```

## Tạo defense validation evidence

Kiểm tra trước các blocker môi trường và source:

```bash
npm run defense:preflight
```

Preflight này kiểm clean Git provenance, Chromium launch, Docker/Compose và existing evidence applicability. Nó chỉ là diagnostic report, không thay thế live evidence run.

```bash
npm run institutional:evidence
```

Evidence runner dùng topology tách biệt gồm hai chain, mỗi chain bốn validator; kiểm tra validator unavailability/recovery, timelock governance, cross-chain lifecycle, lending, attestor quorum, same-process relay-engine reload, source provenance và latency acceptance gate. Báo cáo được ghi tại `.runtime/evidence/` và không thay đổi runtime UI trên port `8545/9545`. Scenario reload không được diễn giải thành OS-process crash/restart; validator scenario là crash-fault availability, không phải Byzantine injection.

Phase 2 hardens đường tạo evidence theo cơ chế fail-closed:

- Contracts và tests được compile sạch bằng `--force` trước khi chạy với Hardhat `3.12.0` được pin chính xác. Mỗi security scenario được chọn bằng đúng source file và full Solidity test signature; security report v2 lấy structured Solidity counts `passed`, `failed`, `skipped`, `todo` và chỉ chấp nhận `passed=1`, mọi count còn lại bằng 0.
- Mọi subprocess dùng một environment allowlist. Unsafe Besu/profile flags, process-injection variables và provenance-altering overrides bị từ chối trước khi Docker khởi động hoặc evidence/runtime cũ bị xóa.
- Toàn bộ run giữ global exclusive lock `.runtime/locks/institutional-evidence.lock`; security reporter giữ thêm `.runtime/locks/security-scenarios.lock`. Lock đang tồn tại, kể cả lock có vẻ stale, không bị tự động reclaim. Provenance được chụp ở đầu và cuối run và phải giữ nguyên; lỗi Git lookup, cờ `assume-unchanged`/`skip-worktree`, mâu thuẫn HEAD diff hoặc symlink trong source inputs là lỗi fail-closed.
- Runtime summary v4 ghi effective security profile, policy provenance và canonical SHA-256 checksum. Integration report v3 phải nhận diện Besu `v24.10.0` trên hai chain và chứa bốn production-accepted live proof observations; năm integration scenarios, validator-availability evidence và component report checksums cũng phải đầy đủ.
- Verifier yêu cầu đúng tập deployed-bytecode theo deployment manifest và cả hai evidence lock đều vắng mặt; thiếu/thừa contract, sai address, hash/byte length không hợp lệ hoặc lock còn tồn tại đều là `NOT READY`.
- Public bundle chỉ được chứa đúng năm report được quản lý trong `.runtime/evidence/`; file thừa cũng làm verification fail. Attestor private keys nằm riêng tại `.runtime/besu-qbft-evidence/private/` và không thuộc evidence bundle.

Sau khi tạo evidence, kiểm tra report và khả năng áp dụng với source hiện tại:

```bash
npm run institutional:evidence:verify
```

Chỉ dùng evidence khi verifier pass và `demo:doctor` trả `READY FOR DEFENSE`. Report đã pass nhưng commit không khớp, source hiện tại dirty hoặc current-source provenance không xác định sẽ có trạng thái `stale` và bị xem là `NOT READY`. Report được ghi từ dirty tree không đủ điều kiện pass ngay từ đầu.

Evidence đủ điều kiện trình bày yêu cầu một Git commit sạch, đã review và khớp source provenance. `--allow-dirty` chỉ tạo `calibration-passed`, không evidence-eligible. Các checksum cung cấp kiểm tra tính nhất quán dưới giả định host và toolchain đáng tin cậy; chúng không phải chữ ký độc lập, formal verification, external audit hoặc production SLA.

GitHub Actions định nghĩa thêm một clean hosted Besu evidence job trên Ubuntu 24.04, có Docker preflight, command budget 85 phút trong job budget 100 phút, diagnostics giới hạn, offline verifier và cleanup `always()`. Khoảng cách 15 phút giữ thời gian cho verifier, diagnostics và cleanup sau command. Workflow không dùng `--allow-dirty`; tuy vậy, việc job được định nghĩa hoặc upload được JSON vẫn không chứng minh nó đã pass. Chỉ sử dụng artifact khi exact Actions run xanh, summary v4 có status `passed`, verifier pass và commit khớp source đã review.

## Tắt runtime

```bash
npm run besu:down
```

Lệnh này xóa Docker volumes của normal demo runtime.

## Tài liệu

- [Project map](PROJECT_MAP.md)
- [Defense evidence matrix](docs/DEFENSE_EVIDENCE_MATRIX.md)
- [Technical and academic audit](TECHNICAL_ACADEMIC_AUDIT.md)
- [Protocol specification](docs/INSTITUTIONAL_PROTOCOL_SPEC.md)
- [Runtime operations](docs/RUNTIME_OPERATIONS.md)
- [Defense runbook](docs/DEFENSE_RUNBOOK.md)
- [Threat model](docs/THREAT_MODEL.md)
