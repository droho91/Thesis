# Báo cáo audit kỹ thuật, học thuật và kế hoạch clean-up

## 1. Thông tin audit

- Ngày audit gốc: 2026-07-22; targeted lifecycle/evidence regression audit gần nhất: 2026-09-05
- Phạm vi: toàn bộ source, contracts, services, scripts, UI, tests, config, CI và documentation đang có trong repository
- Quy mô UI snapshot hiện tại: `demo/styles.css` 3.702 dòng, `demo/app.js` 1.205 dòng, `demo/index.html` 497 dòng; các backend monolith đã theo dõi từ Phase 6 giữ nguyên phạm vi cleanup
- Trạng thái Git: worktree đang có thay đổi chưa commit; audit đánh giá đúng snapshot hiện tại và không xem snapshot này là evidence đủ điều kiện bảo vệ
- Phương pháp: static review, đối chiếu contract–runtime–UI–documentation, chạy test hiện có, tái hiện riêng các nghi vấn evidence, và research từ specification/tài liệu/paper gốc của Ethereum, EIP, EEA QBFT, Besu, OpenZeppelin, Solidity, Compound, Aave, NIST và SLSA

### Thang mức độ

| Mức | Ý nghĩa |
| --- | --- |
| Critical | Có thể phá vỡ trust boundary hoặc safety property cốt lõi; phải xử lý trước khi tuyên bố bảo đảm tương ứng |
| High | Có thể gây mất an toàn, lặp giao dịch, evidence sai hoặc thao tác trái ý người dùng trong điều kiện khả thi |
| Medium | Sai semantics, giảm resilience/financial correctness, hoặc tạo rủi ro khi mở rộng/incident |
| Low | Maintainability, consistency, presentation hoặc defense-in-depth |

## 2. Kết luận điều hành

Dự án có nền tảng nghiên cứu tốt và đường chạy chính tương đối rõ: aBANK bị khóa tại Bank A, checkpoint quorum chứng thực một state root đã được QBFT finalize, Bank B kiểm tra EVM account/storage proof rồi phát hành vA, và vA được dùng trong một lending pool có policy/oracle controls. Không phát hiện đường đi thông thường cho phép user không có quyền tự bypass proof hoặc mint tùy ý.

Snapshot hiện tại **chưa nên được mô tả là production-ready hoặc formally verified**. Phase 1 đã khép bốn safety finding ban đầu, Phase 2 đã khép các đường false-positive/unsafe-pass trong evidence pipeline, Phase 3 đã khép các runtime blocker, Phase 4 đã khóa financial semantics, Phase 5 đã xử lý assurance/interface, Phase 6 đã tách các seam maintainability chính, Phase 7 đã khép UI/a11y cleanup, Phase 8 đã triển khai verification-depth gates và Phase 9 đã triển khai live-client/proof capture cùng defense preflight trong phạm vi repository. Các khoảng trống lớn còn lại là:

1. clean local evidence đã được quan sát pass tại commit `9f668609`: Besu trên hai chain, bốn production-accepted proof observations, 14/14 security controls, 100 latency samples và p95 post-inclusion 23,746 giây. Targeted audit hiện tại thay đổi source sau bundle này nên phải commit, restart UI và tạo evidence mới trước khi dùng để bảo vệ; đối chiếu với client family thứ hai và independent review vẫn cần trước external audit;
2. clean hosted Besu evidence job đã được định nghĩa nhưng chưa được quan sát chạy; evidence chính thức theo runtime summary v4, integration report v3 và security report v2 vẫn cần tạo từ clean reviewed commit và live Docker runtime;
3. production deployment vẫn cần transactional database, managed keys, monitoring và independent security review.

Đánh giá tổng thể:

| Hạng mục | Đánh giá | Nhận xét |
| --- | --- | --- |
| Kiến trúc nghiên cứu | Tốt | Trust model consortium-checkpoint được công khai, asynchronous lifecycle hợp lý |
| Smart-contract happy path | Khá tốt | Proof binding, replay protection, atomic callback, MPT branch/extension/inline cùng pinned offline EIP-1186-shaped corpus và role separation có test |
| Incident/recovery safety | Phase 1 remediated | Recovery floor và governed restitution đã có regression tests; vẫn cần independent review |
| Runtime resilience | Khá tốt cho local singleton | Durable transaction outbox, lease fencing, lifetime journal locks, bounded RPC/retry và lifecycle cleanup đã có regression; clustered production vẫn cần transactional database |
| Evidence integrity | Phase 2 remediated | Structured result, hardened profile, report checksum và source applicability đều fail-closed; vẫn phụ thuộc host/toolchain và chưa phải signed attestation |
| Financial model | Phase 4–5 remediated trong scope prototype | Financial semantics, 18-decimal market guard, asset-keyed velocity và supplier-loss epoch có regression/property test; vẫn là single-market model chưa external audit |
| Verification depth | Phase 8 implemented trong repository scope | 4 bounded stateful properties ở 64×64, line coverage 94,15% và 4/4 hand-selected mutants bị giết; đây không phải formal proof, branch coverage hoặc full mutation analysis |
| Live evidence readiness | Clean local run observed for `9f668609`; current rerun pending | Summary v4/integration v3 pass đã được quan sát với pinned Besu identity, deployed-gateway binding, bốn accepted proof observations, 100 samples và 4/4 checksums. Source của Phase 11 hiện dirty nên bundle đó không còn current-applicable |
| UI trình chiếu | Phase 7 remediated, Phase 10 revalidated | Light theme, state-driven motion, exact amount, fail-closed stale state và keyboard/ARIA semantics có automated gate. Axe, overflow và typography chạy trên bốn pinned viewport từ 1100 đến 1920 px; visual regression khóa Identity ở cả bốn viewport và bảy operation-state tại 1600×900 |
| Documentation | Khá tốt và đã khóa claim matrix | README/threat model phân biệt tested/observed/enforced, thu hẹp finality/independence/exactly-once claims; các residual production được công khai |

### Cập nhật remediation Phase 1 — 2026-07-22

Các finding bên dưới được giữ nguyên để bảo toàn audit trail. Trạng thái triển khai hiện tại:

| Finding | Trạng thái | Remediation |
| --- | --- | --- |
| C-01 | Resolved in code | `checkpointAuthorizationFloor` được nâng tại recovery; proof boundary từ chối root dưới floor nhưng dữ liệu lịch sử vẫn query được |
| H-01 | Resolved in code | Terminal-revocation timeout được chuyển vào `InstitutionalRestitutionVault`; release cần timelocked claim admin, case reference, identity và policy approval |
| H-04 | Resolved in code | Attestor fail-closed với allowlist chính xác cặp `(destinationChainId, checkpointClient)` |
| H-08 | Resolved in code | Besu generator canonicalize và chỉ chấp nhận `networks/besu` hoặc direct `.runtime/besu-*`; broad/symlink-escaped targets bị từ chối trước mutation |

### Cập nhật remediation Phase 2 — 2026-07-22

| Finding | Trạng thái | Remediation |
| --- | --- | --- |
| H-02 | Resolved in code | Mỗi scenario dùng exact Solidity signature và structured Hardhat task counts; report v2 kiểm tra manifest, selector, execution count và checksum nội bộ, đồng thời ghi `running`/`failed` trước khi một pass cũ có thể bị tái sử dụng |
| H-03 | Resolved in code | Evidence runner dùng child-environment allowlist, reject unsafe/injection/provenance override trước mutation, force clean compile, ghi security profile SHA-256 trong summary v4 và tách attestor secrets khỏi public evidence root |
| M-09 | Resolved in code | `reportStatus` được tách khỏi `applicableToCurrentSource`; commit mismatch, dirty hoặc unknown source tạo trạng thái `stale` và làm defense readiness fail |
| Phase 2 hardening | Implemented | Global/report locks dùng atomic no-overwrite publication; Phase 10 cho phép restart thu hồi đúng lock cùng host/platform khi OS xác nhận PID đã chết, không dựa vào tuổi file. Provenance đầu/cuối phải ổn định; Git failure/index flags/symlink, malformed component report, incomplete bytecode, unexpected public file và secret trong bundle đều fail-closed; cleanup chỉ nhận đúng Docker resources qua project label. Hardhat chỉ retry có giới hạn cho exact `ENOENT` race của managed UI temp file và ghi số retry vào report; lỗi source/test khác không được retry |

### Cập nhật remediation Phase 3 — 2026-07-22

| Finding | Trạng thái | Remediation |
| --- | --- | --- |
| H-05 | Resolved in code for local singleton | Action journal v3 persist request intent, signer, chain, nonce, exact raw signed transaction và predicted hash trước broadcast; migration v1/v2 có provenance, startup/status tự reconcile hoặc rebroadcast đúng raw transaction, còn global unresolved fence chặn action mới trước prerequisite |
| H-06 | Resolved in code | Relay lease có heartbeat và fencing token; stale worker không thể commit hoặc ghi failure sau takeover |
| H-07 | Resolved in code | Mỗi JSON store có lifetime process lock, canonical target checks và durable atomic replace; shared multi-process deployment fail-closed |
| H-09 | Resolved in code | Mutation API bắt buộc exact Host/Origin, same-origin Fetch Metadata, JSON content type và per-session CSRF token qua HttpOnly SameSite cookie |
| M-10 | Resolved in code | Retry options dùng duy nhất typed `baseMs/maxMs/jitterRatio`; legacy/unknown keys bị từ chối |
| M-11 | Resolved in code | RPC có deadline, nonce chỉ advance sau accepted broadcast, startup/shutdown giải phóng server/journal/provider kể cả partial failure, và UI/static-stream error boundaries có lifecycle tests |

### Cập nhật remediation Phase 4 — 2026-08-01

| Finding | Trạng thái | Remediation |
| --- | --- | --- |
| M-01 | Resolved in code | Lending pause dùng action bitmask; default emergency mask chỉ chặn borrow và các withdrawal làm tăng rủi ro, còn repay/collateral top-up/liquidity supply/liquidation/bad-debt recognition tiếp tục; guardian chỉ thêm pause, risk governance mới resume |
| M-02 | Resolved in code | Accrual timestamp chỉ advance theo batch thực xử lý; backlog không bị xóa, keeper có bounded `catchUpInterest`, action fail closed khi còn hơn một batch và idle periods không bị áp vào khoản vay mới |
| M-03 | Resolved in code | Application trust được version theo `(chainId, remoteApplication)`; route mới không overwrite trust cũ, timeout tối đa bằng drain period bảy ngày, revoke cần schedule, hết drain và zero local pending count |
| M-05 | Resolved in code | Haircut/threshold/bonus có aggregate validation; partial seize được risk-limit và integer-rounding buffer bảo đảm mọi preview executable có `healthFactorAfter >= healthFactorBefore`; property test chạy 128+ cases trên allowed parameter domain |
| M-06 | Resolved in code | Cap được đổi tên và thực thi đúng origination-principal semantics; account cap cộng gộp qua debt assets, repayment trả interest trước principal, mọi write-off đặt default freeze và chỉ governance resolution có reference mới mở borrowing |

Phạm vi Phase 5 được khóa là Assurance and interface correctness: M-04, M-07, M-08 và M-12 đến M-15.

### Cập nhật remediation Phase 5 — 2026-08-01

| Finding | Trạng thái | Remediation |
| --- | --- | --- |
| M-04 | Resolved in code/docs | `trustingPeriod` được đổi thành `maxCheckpointSubmissionAge` xuyên contract, environment và deployment manifest v2; test chứng minh root đã accept không tự expire, còn conflict quá tuổi hoặc cũ hơn previous epoch không đi qua automatic freeze path |
| M-07 | Resolved in repository assurance scope | Sửa production inline-child RLP bug; thêm canonical RLP/hex-prefix guards, branch/extension/inline/absence corpus, independent reference walker và malformed/mutated differential fuzz. Tại snapshot Phase 5 vẫn thiếu proof capture và đối chiếu từ nhiều live execution clients; Phase 8 sau đó bổ sung corpus offline xác định nhưng không khép residual live-cross-client này |
| M-08 | Resolved in code | Velocity key dùng `(account, asset, day)`; gateway/app bind `block.chainid`; dependencies/oracle cần bytecode; pool công khai và enforce token/oracle scale 18 decimals; zero-asset recapitalization advance supplier-loss epoch trước vốn mới |
| M-12 | Resolved in code/UI | Status tách `runtimeReadable`, observed `chainsProgressing`, `attestorQuorumReady`, heartbeat-based `relayerHealthy`, `governanceEnforced`, `identitiesEligible` và aggregate `laneReady` |
| M-13 | Resolved in code/UI | Token amount dùng normalized decimal string + 18-decimal `BigInt`; uncertain request persist/bind đủ `{requestId, action, amount}` và từ chối intent mismatch |
| M-14 | Resolved in code/UI | Status fetch failure xóa actionable snapshot, render unavailable và khóa toàn bộ form cho tới successful refresh tái lập `laneReady` |
| M-15 | Resolved in schema/wording | Integration report v2 dùng `sourceIncludedAt`/`postSourceInclusionToCompletionMs`, scenario `engineReloadRecovery`; validator availability report v2 ghi rõ single-validator crash/unavailability và không inject Byzantine behavior. Legacy report schema fail closed |

### Cập nhật remediation Phase 6 — 2026-08-02

Phase 6 khóa nguyên tắc không đổi ABI, storage layout, evidence schema hoặc runtime behavior; compatibility exports được giữ tại các façade cũ.

| Hạng mục | Trạng thái | Remediation |
| --- | --- | --- |
| L-01 JavaScript | Resolved for Phase 6 scope | `demo/app.js` giảm 1.184 → 987 dòng; lending validation/health, UI/evidence formatting và workflow/mascot presentation được tách thành ba module pure có 12 test riêng. CSS override/token cleanup được giữ đúng sang Phase 7 |
| L-03 | Resolved | `.env.example` bỏ toàn bộ prototype key không còn được đọc, mô tả các biến Besu/institutional/UI/evidence hiện hành; gate hai chiều từ source phát hiện cả key thừa lẫn key runtime bị thiếu |
| L-04 package | Partially resolved | `ethers` chuyển sang runtime dependency; bỏ TypeScript/types/chai/mocha trực tiếp không được source dùng; package đặt `private`, khóa Node >=22; tại snapshot Phase 6 lockfile có 96 dependencies và `npm audit` báo 0 vulnerability. CI SHA pin, coverage và license alignment vẫn còn |
| L-05 | Substantially resolved | Một shared JSON writer/reader thay các bản sao trong runtime/deploy/UI/evidence; một transaction-receipt boundary dùng chung giữ exact caller wording; durable outbox, manifest, benchmark và validator evidence có module riêng |
| Runtime/deploy/integration | Completed | Runtime chính 1.608 → 1.249 dòng; deploy 773 → 680; integration 756 → 659. Durable action façade re-export binding cũ, integration report v2 giữ nguyên |
| Lending domain | Completed | Pure share/rate/risk/pause math chuyển sang internal `LendingPoolMath`; pool 978 → 934 dòng, ABI/storage không đổi, deployed bytecode 19.234 byte dưới EIP-170 limit |

Tổng kích thước sáu monolith được theo dõi giảm 9.013 → 8.223 dòng (790 dòng, 8,8%); phần logic chuyển ra module được test độc lập thay vì bị xóa không kiểm soát. Tại thời điểm chốt Phase 6, phase kế tiếp được xác định là UI/a11y cleanup.

### Cập nhật remediation Phase 7 — 2026-08-02

| Hạng mục | Trạng thái | Remediation |
| --- | --- | --- |
| L-01 CSS | Resolved trong scope cleanup Phase 7 | `demo/styles.css` giảm 3.714 → 3.142 dòng; raw color được giới hạn trong `:root`, font-size dùng projector type tokens, dead class/unused token và exact selector override đã được loại bỏ. Hai lỗi trình bày phát hiện khi review baseline — metric label bị cắt và primary button thiếu nền sau consolidation — cũng được sửa trước khi khóa ảnh; physical module split chỉ còn là follow-up tùy chọn nếu CSS tiếp tục tăng |
| L-02 accessibility | Resolved | Workflow và lending dùng roving tabs với Arrow/Home/End; panel/disclosure đồng bộ `aria-selected`, `aria-controls`, `hidden`, `inert`, live region và focus restore. Form error/disabled state dùng DOM semantics thay vì chỉ chặn pointer |
| Motion/interaction | Resolved | Ready/verified/healthy mới chạy ring, seal, sheen và meter animation; review/offline xóa verified tone và không chạy decoration; hover/focus transitions vẫn có phản hồi và toàn bộ motion bị tắt khi `prefers-reduced-motion: reduce` |
| Browser gate | 21/21 project-test instances pass | Fixture loopback tổng hợp theo phần shape UI tiêu thụ có 5 integration/14 security entries; Playwright chặn external request và fail với page/console/request error, kiểm axe, overflow và typography trên sáu view ở ba viewport, cùng keyboard, motion, offline reset và reduced motion |
| Visual regression/CI | Implemented | Identity được khóa ở 1366×768, 1600×900, 1920×1080; Transfer, bốn lending modes, Settlement và Evidence có baseline 1600×900. Chromium/Axe được pin chính xác, diff ratio 0,1%, CI pin Ubuntu 24.04 và cài browser dependencies |

Browser review phát hiện hai lỗi runtime thật mà source-only gate không bắt: nhánh `laneReady=false` còn gọi helper `invalid` đã chuyển vào module private ở Phase 6, khiến render fallback ném `ReferenceError`; sau một status-fetch failure, verified tone cũ cũng có thể tiếp tục animation trên snapshot đã stale. Nhánh validation nay dùng `validateAction` public, offline path xóa status tone, và cả hai được khóa bằng browser regression. Fixture pass chỉ phục vụ UI test, không phải defense evidence.

### Cập nhật remediation Phase 8 — 2026-08-03

| Hạng mục | Trạng thái | Remediation / giới hạn |
| --- | --- | --- |
| Pinned MPT corpus | Implemented for deterministic offline assurance | Pin exact `@ethereumjs/trie@6.2.1` cùng npm integrity; 5 generic + 3 account/storage vectors bao phủ membership, absence, branch, extension, leaf, inline và hashed reference. Generator tạo corpus/manifest/Solidity adapter, verifier tái sinh và so byte-exact. Metadata khóa `evidenceEligible=false`, `validatedLiveClients=[]`; đây không phải fresh Besu/Geth hoặc live multi-client corpus |
| Stateful invariants | 4/4 bounded properties pass | Handler có 12 bounded actions, 3 borrowers và 2 suppliers; kiểm token–pool–policy collateral, debt/principal shares, supplier claims và global accounting với 64 runs × depth 64. Không phải exhaustive/formal proof; debt-share rounding tolerance là 10.000 wei |
| Solidity line coverage | Gate pass tại 94,03% | Fresh Hardhat LCOV đạt 1.558/1.657 dòng trên 21 production files; global floor 90%, every-file 50% và 11 critical floors 70–100%. Parser có negative tests cho truncated, duplicate, malformed/counter mismatch, missing critical và threshold regression. LCOV này không đo branch coverage |
| Mutation smoke | 4/4 bounded mutants killed | Sandbox compile hợp lệ rồi exact test giết root/reference MPT, replay receipt persistence, recovery authorization floor và liquidation-risk equality. Report có source/package hashes và `evidenceEligible=false`; 100% chỉ thuộc bốn mutant chọn trước, không phải full-repository mutation score |
| CI supply chain | Implemented, hosted run not observed | GitHub Actions được pin full commit SHA, main job được cấu hình để chạy corpus/coverage/mutation/security/browser và upload assurance reports. Live Besu calibration có Docker preflight, bounded timeout/logs, exact-project cleanup `always()` và chỉ upload public JSON |
| Live Besu calibration | Defined, not executed in this local audit | Local WSL không có Docker nên chỉ static config/workflow gates được kiểm. Hosted job chạy `--allow-dirty`, do đó kết quả tối đa là calibration và không thay clean defense evidence; không claim hosted pass khi chưa có Actions run cụ thể |

Phase 8 đạt exit gate machine-verifiable cho repository coverage/security suite. Hạng mục “live multi-client MPT corpus” ban đầu chỉ được thay bằng một bước trung gian trung thực là pinned deterministic client-neutral corpus; phần live cross-client vẫn là residual pre-audit, nên Phase 8 không được dùng để tuyên bố external validation.

### Cập nhật remediation Phase 9 — 2026-08-03

| Hạng mục | Trạng thái | Remediation / giới hạn |
| --- | --- | --- |
| Live client identity | Implemented; live run not observed | Integration report nâng lên v3, gọi `web3_clientVersion` trên cả hai chain và validator yêu cầu đúng Besu `v24.10.0` phù hợp image đã pin. Đây là một client family, chưa phải multi-client validation |
| Production-accepted proof capture | Implemented; live run not observed | Relay observer chỉ ghi proof sau transaction `receiveMessage`, `acknowledgeMessage` hoặc `timeoutMessage` thành công. Clean evidence yêu cầu đúng bốn commitment/acknowledgement membership observations phủ cả chain 41001/41002, raw account/storage nodes, SHA-256 digest, deployed gateway account và unique accepted transaction |
| Evidence schema/readiness | Implemented and negative-tested | Runtime summary nâng lên v4; integration v2/summary v3 cũ fail closed. `demo:doctor` từ chối evidence không có live-client proof. Git presentation variable như `GIT_PAGER` được strip thay vì làm provenance unknown, trong khi các biến thay đổi repository vẫn bị chặn trước subprocess |
| Browser preflight | Implemented; local runtime passed | Sau khi cài dependencies, gate xác nhận executable, `ldd` và headless launch. Playwright pass 21/21 tại ba desktop viewport; 10 baseline được review trực quan và tái tạo trên Chromium đã pin |
| Defense preflight/matrix | Implemented | `defense:preflight` tách clean source, browser, Docker daemon, Compose và current evidence thành các blocker độc lập. Browser, Docker `29.6.1` và Compose `5.3.0` hiện pass; report còn đúng hai blocker là dirty reviewed source và chưa có current live evidence |
| Hosted live evidence | Defined, not observed | CI chuyển job `--allow-dirty` calibration thành clean evidence, chạy offline verifier, bounded diagnostics và exact-project cleanup rồi upload public JSON. Workflow definition không được tính là pass khi chưa có exact successful Actions run |

Phase 9 hoàn tất repository implementation và targeted negative tests cho đường capture/validation. Chromium dependencies và Docker Desktop WSL integration đã được xác minh; exit gate evidence còn cần commit source đã review và quan sát một clean local hoặc hosted run. Khi run đó pass, claim hợp lệ chỉ là single-client Besu live proof acceptance; live cross-client equivalence vẫn là residual.

### Cập nhật remediation Phase 10 — 2026-09-02

Phase 10 là lượt rà soát mới trên source thực tế và nguồn sơ cấp; các dòng Phase 1–9 được giữ lại như audit trail lịch sử. Không đổi version trong report cũ để giả tạo một live observation chưa xảy ra.

| Finding / tối ưu | Trạng thái | Remediation và evidence |
| --- | --- | --- |
| P10-01 — Besu `24.10.0` đã cũ và bỏ lỡ các BFT/Bonsai fix liên quan | Resolved in source; live evidence pending | Pin `26.8.1` cùng OCI index digest `sha256:6f3f...0042`; image thực trả `besu/v26.8.1`. Upstream release ghi fix Paris-era BFT transaction-selection timeout, QBFT round/vote, BFT withdrawals và Bonsai storage root. Isolated scaffold generation/config validation pass; evidence `24.10.0` trở thành stale theo đúng thiết kế |
| P10-02 — Process có thể chết sau exclusive-create nhưng trước khi lock JSON hoàn chỉnh | Resolved in code | Owner record được write+sync trong private candidate trước atomic no-overwrite hard-link publication. Recovery chỉ nhận exact token-derived candidate/inode pair; concurrent, OS-process-kill và publication-window regressions pass |
| P10-03 — Relay journal v1 chỉ validate state/fencing, có thể chấp nhận message/block/transaction/history bị hỏng | Resolved in code | Restart gate nay validate full durable envelope, protocol `messageId` binding, uint width, ISO timestamps, JSON safety, source transaction binding, lease/fencing và latest history state. Năm corruption fixtures fail closed; duplicate observation có envelope khác cũng bị từ chối |
| P10-04 — Collector chờ cả endpoint thứ tư sau khi đã đủ quorum | Optimized | Validate HTTP(S) endpoint/fetch/threshold trước I/O; verify response theo completion order, return ngay ở 3 unique valid signers, abort straggler và submit exactly threshold signatures. Test endpoint thứ tư treo 60 giây xác nhận không cộng timeout vào checkpoint |
| P10-05 — `RLPDecodeLib.toBytes32` có nhánh short-value shift sai nhưng caller hiện tại chỉ gọi với 32 byte | Resolved before exposure | Thu hẹp helper thành exact 32-byte account `storageRoot` conversion, bỏ dead/incorrect short-value semantics và thêm regression exact/reject-short |
| P10-06 — Escrow/voucher chỉ check dependency khác zero | Resolved in code | Constructor fail-fast nếu local token/policy dependency không có bytecode; không áp check này lên remote canonical-asset identifier |
| P10-07 — Static server chỉ lexical-check path và thiếu browser isolation headers | Resolved in code | `realpath` boundary chặn symlink escape; CSP, frame denial, COOP/CORP, permissions và referrer policy được gửi trên static response. API/static regressions pass |
| P10-08 — Accessibility test bind vào thứ tự HTML attribute | Resolved in test | Assertion nay kiểm semantic `dd` ownership thay vì formatting/attribute order, giữ test nhạy với a11y contract nhưng không brittle với class refactor |
| P10-09 — Evidence/security locks còn buộc xử lý thủ công sau local process crash | Resolved in code | Cả runner chính, bundle reset và security collector bật orphan recovery bảo thủ: chỉ record hợp lệ cùng host/platform và PID được OS xác nhận đã chết mới được thu hồi; age, live, foreign và unverifiable owner vẫn fail closed |

Giới hạn còn mở sau Phase 10: live evidence phải chạy lại trên clean reviewed commit và Besu `26.8.1`; normal demo containers đang chạy `24.10.0` không bị audit tự động xóa; multi-client proof equivalence, external audit/formal verification, production oracle/HSM/mTLS/database/monitoring và organizational independence vẫn chưa có. JSON journal còn là append-retentive singleton với full-file atomic replacement, nên cần archival/transactional database trước long-running production. Root license ISC và contract SPDX MIT vẫn cần một quyết định licensing của chủ sở hữu thay vì audit tự ý đổi.

Dependency review ghi nhận `npm audit` không có advisory trên dependency tree hiện tại. Hardhat `3.15.0`, OpenZeppelin Contracts `5.6.1` và Axe Playwright `4.13.0` đã có bản mới hơn pin hiện tại. Hardhat upstream nêu compile-speed improvement; OpenZeppelin `5.6.1` fix `InteroperableAddress`, component project không import. Audit không nâng toolchain/library chỉ vì version number: Hardhat version là một phần của evidence schema/structured runner, còn OpenZeppelin upgrade thay deployed bytecode. Hai migration này nên là PR riêng với full gate và regenerated clean evidence.

### Cập nhật remediation Phase 11 — 2026-09-05

Phase 11 là targeted regression audit sau hai lỗi chỉ xuất hiện theo thời gian chạy; nó không thay thế external audit hay live multi-client validation.

| Finding / tối ưu | Trạng thái | Remediation và evidence |
| --- | --- | --- |
| P11-01 — Besu có thể trả `missing revert data` trong cửa sổ world-state/head ngắn | Resolved in `9f668609`; live-soak revalidated | Chỉ read-only contract calls dùng bounded transient retry; deterministic revert và transaction ghi không retry. Read-only soak mới đạt 500/500 trên hai chain đang tạo block; 501 RPC attempts cho thấy một lỗi transient thật đã được phục hồi |
| P11-02 — UI process cũ có thể dùng evidence-policy module trước commit mới | Resolved in current source | UI server chụp commit/dirty state khi validator được nạp và so lại tại mỗi evidence request. Commit mismatch, dirty-at-load hoặc unknown provenance tạo `validator-stale`/`UI VALIDATOR RESTART REQUIRED`, không còn bị diễn giải thành report failure |
| P11-03 — `VALIDATION GATES FAILED` không chỉ ra điều kiện nào hỏng | Resolved in current source | Evidence payload xuất 19 named gates và UI liệt kê gate thất bại khi validator hiện hành thực sự reject report |
| P11-04 — lifecycle/lock regression sau sửa | Revalidated | Orphan recovery vẫn chỉ nhận same-host/same-platform/dead-PID owner; live/foreign/tampered lock fail closed. UI alternate-port smoke test khởi động, trả validator provenance và thoát `SIGINT` với code 0 |

Clean evidence quan sát được trước Phase 11 thuộc commit `9f668609`, có 14/14 security controls, 100/100 benchmark samples, p95 post-inclusion 23,746 giây, 4/4 report checksums và bốn accepted proof observations. Vì Phase 11 tạo source revision mới, bundle này chỉ là regression baseline; sau commit phải restart UI, chạy lại `institutional:evidence`, `institutional:evidence:verify` và `demo:doctor` trước khi trình bày.

## 3. Baseline kiểm thử

| Kiểm tra | Kết quả | Ghi chú |
| --- | --- | --- |
| Solidity tests | 140/140 pass | Bao gồm pinned corpus, 4 stateful invariant properties, exact/reject-short RLP regression và constructor guard cho dependency không có bytecode |
| Service tests | 249/249 pass | Bao gồm full durable relay-envelope validation, lock publication/crash recovery, quorum early-return/straggler abort, static-server headers/symlink boundary, RPC retry và stale-validator provenance |
| UI source/read-model checks | Pass | `npm run test:ui` là static gate cho semantic readiness, stale-state action lock, BigInt source usage, summary v4/integration v3, pass/fail/stale, component completeness, bytecode, lock, secret contamination, live-client proof và source applicability; browser behavior được kiểm riêng ở hàng kế tiếp |
| Browser interaction/a11y/visual | 52/52 pass | Chromium run xác nhận keyboard, axe/overflow/typography, motion/CSP regressions, stale-validator restart state và visual baselines trên bốn project viewport 1100, 1366, 1600 và 1920 px |
| Solidity line coverage | 1.560/1.657 (94,15%) | Fresh LCOV trên 21 production files; global, every-file và 11 critical-source floors đều pass; đây là line coverage, không phải branch coverage |
| Mutation smoke | 4/4 killed | Bốn mutant được chọn trước đều bị targeted test giết; không phải full-repository mutation score |
| Security scenario regression | 14/14 pass | Hardhat `3.12.0` được pin chính xác; mỗi scenario chạy bằng exact full Solidity signature và structured `passed/failed/skipped/todo` counts; fuzz repayment chạy 128 lượt |
| Live Besu integration | Không chạy trong audit này | Cần prepared Docker runtime; report lịch sử không được dùng thay kết quả mới |
| Evidence acceptance run | Chưa chạy lại có chủ đích | Evidence-eligible run yêu cầu clean reviewed commit; offline verifier hiện từ chối đúng bundle legacy/stale và secret artifact cũ thay vì tái sử dụng pass lịch sử |

Lượt chốt Phase 10 pass toàn bộ `npm test`: 140 Solidity tests, 240 service tests và institutional UI source/read-model gate. Browser suite pass 44/44 trên bốn viewport; coverage đạt 1.560/1.657 dòng (94,15%), mutation 4/4 và security scenarios 14/14. Docker runtime quan sát hiện vẫn là scaffold Besu `24.10.0`; audit không tự xóa volumes đang chạy, nên kết quả runtime lịch sử không thay cho clean evidence run bằng pin `26.8.1`.

## 4. Những điểm đang làm tốt

### Protocol và contracts

- EIP-712 domain bind chữ ký checkpoint với destination chain và checkpoint-client contract.
- Signer/attestor được sắp thứ tự nghiêm ngặt, chặn duplicate signer và ambiguity.
- Gateway bind chain, gateway, application, payload, nonce, timeout, account, slot và value.
- Receipt được ghi trước callback trong cùng transaction; callback revert kéo receipt revert theo.
- `Completed` và `TimedOut` loại trừ nhau; acknowledgement và timeout đều cần proof.
- SafeERC20 exact-balance checks từ chối fee-on-transfer accounting drift.
- Identity có expiry động, suspension và terminal revocation; guardian không thể tự reactivate.
- Governance handoff grant role cho timelock trước khi bootstrap admin renounce và có verification lại.
- Lending có oracle freshness, borrow/liquidation thresholds riêng, lender/debt shares, reserves và bad-debt accounting.

### Runtime và vận hành

- Attestor kiểm tra source chain ID, block hash, state root, timestamp và post-inclusion depth trước khi ký.
- Collector tự verify EIP-712, membership, duplicate và sort chữ ký.
- Atomic JSON store dùng lifetime process lock, exclusive random temporary file, `fsync`, atomic rename và parent-directory sync khi platform hỗ trợ.
- Relay cursor chỉ advance sau khi observation được ghi; on-chain state là lớp idempotency cuối.
- Besu default dùng random keys, pinned image digest, loopback RPC, isolated key mount và `no-new-privileges`.
- Evidence có source/package digests, deployed bytecode hashes và component checksums.

### UI và tài liệu

- Light theme, workflow rail, mascot, state feedback và reduced-motion tạo nhận diện tốt cho buổi bảo vệ.
- Threat model nói rõ đây không phải trustless bridge, chưa audit và chưa production-ready.
- Protocol spec phân biệt asynchronous compensation với synchronous atomicity.
- Runtime docs tách local observation khỏi production SLA.

## 5. Findings chi tiết

### Critical

#### C-01 — Recovery kích hoạt lại checkpoint root cũ — Resolved in Phase 1

Evidence:

- `contracts/gateway/InstitutionalCheckpointClient.sol:134-140`: conflict chỉ freeze client; root đã trust vẫn được lưu.
- `contracts/gateway/InstitutionalCheckpointClient.sol:175-180`: recovery ghi root mới và bật `Active` nhưng không đặt revocation floor.
- `contracts/gateway/InstitutionalEVMProofBoundary.sol:51-54`: proof chấp nhận mọi stored root khi client đang active.
- `test/gateway/InstitutionalCheckpointClient.t.sol:153-169`: chưa test root cũ bị từ chối sau recovery.

Tác động: một root cũ thuộc incident có thể lại dùng để authorize membership/absence proof sau recovery.

Yêu cầu xử lý:

- thêm `minimumUsableCheckpointHeight` hoặc `invalidatedThroughHeight` theo source;
- recovery đặt floor và proof boundary enforce floor;
- giữ dữ liệu root cũ chỉ để audit, không dùng authorization;
- thêm end-to-end regression test trước-freeze, frozen, recovered-old-root-rejected và recovered-new-root-accepted.

Remediation đã triển khai đúng yêu cầu trên: recovery nâng `checkpointAuthorizationFloor` tới recovery height, proof boundary enforce floor và regression test xác nhận root cũ chỉ còn giá trị audit.

### High

#### H-01 — Terminal revocation có thể khóa compensation vĩnh viễn — Resolved in Phase 1

- `InstitutionalCollateralApp.sol:264-285` gọi policy-controlled unlock/remint khi timeout.
- `PolicyControlledEscrowVault.sol:97-105` và `PolicyControlledVoucherToken.sol:79-84` yêu cầu account eligible.
- `InstitutionalIdentityRegistry.sol:87-95` làm `Revoked` terminal.
- Test hiện chỉ cover `Suspended` rồi reactivate.

Không nên sửa bằng cách bypass compliance. Cần restricted-claims/quarantine vault hoặc governance adjudication có reason code, audit event và timelock. Test cả lock–mint timeout lẫn burn–unlock timeout khi account đã revoked.

Remediation dùng restricted custody: cả canonical và voucher timeout của terminally revoked sender được ghi theo message ID trong restitution vault. Release không trả trực tiếp cho account revoked; nó cần `CLAIM_ADMIN_ROLE`, adjudication reference, active identity và bank-policy approval của recipient.

#### H-02 — Security evidence có thể báo pass cho test không tồn tại — Resolved in Phase 2

- `scripts/verification/security-scenarios.mjs:93-102` dùng `execution.output.includes(scenario.test)`.
- `npm run` tự echo toàn bộ chuỗi `--grep`, nên tên test luôn có trong stdout.
- Đã tái hiện bằng sentinel không tồn tại: command exit 0, `0 passing`, nhưng sentinel vẫn có trong output.

Phải dùng reporter machine-readable, match test ID từ result event, và fail nếu executed/pass count khác expected.

Remediation không còn suy luận từ stdout. Runner chọn riêng từng source và exact ABI signature, giải bọc task envelope rồi lấy structured Solidity counters trực tiếp từ Hardhat, yêu cầu chính xác `passed=1, failed=0, skipped=0, todo=0`, rồi tự kiểm tra report v2. Missing, duplicate, wrong identity, non-exact selector, malformed envelope/counter và checksum mismatch đều có negative test.

#### H-03 — Evidence-eligible run có thể dùng unsafe Besu profile — Resolved in Phase 2

- `institutional-evidence.mjs:16-38` kế thừa toàn bộ `process.env` và không ép `UNSAFE_LOCAL_DEMO=false`.
- `generate.mjs:11,195-208,341-346` bật deterministic keys, ADMIN/DEBUG RPC và wildcard CORS/hosts khi flag này true.
- `validate-config.mjs:6,23-27` bỏ qua hardening checks dưới cùng flag.
- Đã tái hiện validator exit 0 với thông báo hardening bị skip.

Evidence runner phải tạo allowlisted environment sạch, reject unsafe flags tuyệt đối và ghi effective security profile vào summary/checksum.

Remediation dùng fixed managed profile cùng một allowlist hẹp cho host environment và safe bounded tunables. `UNSAFE_LOCAL_DEMO`, ADMIN/DEBUG RPC, image, topology, RPC, proof policy và governance parameters không thể bị nới lỏng; process-injection và provenance-altering variables bị từ chối trước mutation. Summary v3 ghi canonical profile checksum, artifact classification và report completeness; local attestor secrets nằm ngoài public evidence root. Runner force-compile contracts/tests, dùng hai cooperative exclusive locks, so sánh provenance đầu/cuối, từ chối Git lookup/index flags/symlink bất thường, chỉ cleanup đúng Docker resources qua fixed project label và verifier kiểm lại nội dung component reports, exact deployed-bytecode set lẫn exact public-bundle allowlist. Đây vẫn là local reproducible evidence dưới trust boundary của host/toolchain, không phải signed attestation.

#### H-04 — Attestor chưa allowlist signing domain đích — Resolved in Phase 1

- `checkpoint-attestor.mjs:33-48` kiểm tra source nhưng ký `destinationChainId` và `checkpointClient` do requester gửi.
- `service-config.mjs:28-43` không có allowed destination domains.

Thêm allowlist cặp `(destinationChainId, checkpointClient)`, validate config fail-closed và test wrong-chain/wrong-client rejection.

Remediation đã thêm normalize/duplicate/malformed checks, exact-pair allowlist và từ chối domain ngoài phạm vi trước khi đọc source RPC, ký hoặc ghi journal.

#### H-05 — Crash trước khi journal transaction hash có thể lặp action — Resolved in Phase 3

- `institutional-demo-runtime.mjs:421-425,449-474` broadcast transaction trước khi gọi `#recordSubmitted`.
- Bridge có on-chain client reference nhưng Bank B deposit/borrow/repay/withdraw không có request ID on-chain.
- `action-journal.test.mjs:69-91` chỉ cover uncertain state sau khi hash đã được lưu.

Cần durable outbox: persist nonce/raw signed transaction/hash trước broadcast, reconcile receipt khi restart, và thêm idempotency key cho action tài chính hoặc transaction manager có fencing.

Remediation dùng action journal v3 làm durable transaction outbox, migration v1/v2 với explicit transaction provenance và state-transition matrix chặn fresh action bỏ qua outbox. Runtime lấy explicit latest/pending nonce, ký một raw transaction duy nhất, persist request identity, action/amount/lane, signer/chain/nonce, destination, calldata hash, raw bytes và predicted transaction hash trước lần broadcast đầu. Startup/status worker tự kiểm tra receipt/pending transaction rồi chỉ rebroadcast đúng raw bytes/hash đã lưu; lỗi lặp lại dùng bounded exponential backoff. Một unresolved action tạo global fence trước allowance/prerequisite, client phải cung cấp request ID, reuse khác intent bị từ chối và completed keys không bị prune. Regression tests mô phỏng crash sau durable stage, crash sau broadcast trước submitted write, close/reopen recovery, duplicate concurrent request, mined receipt không rebroadcast và reverted receipt thành definite failure. Đây chưa phải `SIGKILL`/fresh-process DR exercise, production exactly-once hoặc clustered-runtime proof; trạng thái không thể reconcile vẫn fail-closed và cần operator workflow ở phase production.

#### H-06 — Relay lease có thể hết hạn giữa một workflow step — Resolved in Phase 3

- `relay-engine.mjs:59-91` claim lease rồi chờ toàn bộ `workflow.step()`.
- Lease mặc định 15–30 giây trong khi transaction timeout là 90–120 giây.
- Khi transition fail do lease hết, catch tiếp tục gọi failure record bằng lease đã hết và có thể làm `tick/run` thoát.

Thêm lease heartbeat/renewal, fencing token, test step dài hơn lease và bảo đảm worker cũ không commit sau khi mất lease.

Remediation đã thêm heartbeat theo một phần ba lease, fencing token tăng đơn điệu trên mỗi claim và bắt buộc exact token cho renew/transition/failure write. Kết quả của worker mất lease bị bỏ thay vì ghi đè hoặc làm `tick/run` thoát; regression tests cover step dài hơn lease, stale-token takeover và failure path khi lease đã hết.

#### H-07 — JSON journal không an toàn cho hai process dùng chung file — Resolved in Phase 3

`AtomicJsonStore` chỉ serialize trong một process; hai process giữ snapshot riêng có thể ghi đè nhau. Hoặc enforce singleton bằng lock file rõ ràng, hoặc dùng SQLite/PostgreSQL với transaction/CAS. Documentation phải nói rõ shared file không phải clustered store.

Remediation enforce một owner cho mỗi JSON store bằng lifetime `<journal>.lock`. Owner record được write+sync trong private candidate rồi publish bằng atomic no-overwrite hard link; store canonicalize parent, reject symbolic/multi-hard-link target, ghi state qua crypto-random `wx` temporary file, sync file rồi rename và sync parent directory khi platform hỗ trợ. Normal close chỉ unlink sau khi kiểm tra file identity và random ownership token; process thứ hai fail-closed và regression dùng child process thật. Sau crash, restart chỉ reclaim record hợp lệ cùng host/platform khi OS xác nhận PID đã chết, không bao giờ theo tuổi file. Clustered deployment vẫn phải dùng transactional database/CAS có fencing thay vì share JSON file.

#### H-08 — Besu generator có thể xóa nhầm repository — Resolved in Phase 1

- `generate.mjs:5` nhận `BESU_NETWORK_ROOT` tùy ý.
- `generate.mjs:350-351` gọi recursive `rm(ROOT)`.

`BESU_NETWORK_ROOT=.` có thể nhắm workspace root. Phải canonicalize path, reject `/`, home, workspace root, symlink bất thường và chỉ cho target nằm trong allowlisted runtime parent. Viết destructive-path safety test trước khi refactor.

Remediation đã tách safe-root resolver, chỉ chấp nhận hai pattern runtime hẹp và có positive/negative tests trên temporary workspace, bao gồm symlink escape.

#### H-09 — Localhost action API có CSRF surface — Resolved in Phase 3

- `scripts/ui/serve.mjs:20-24,47` bind loopback nhưng nhận request từ browser.
- `scripts/ui/api.mjs:18-20,40-58` không kiểm tra Origin/Host/Fetch Metadata/CSRF token/Content-Type.

CORS không ngăn side effect của simple cross-origin POST. Bắt buộc same-origin Host/Origin, `application/json`, `Sec-Fetch-Site`, per-session CSRF token và test cross-site rejection.

Remediation bind mutation với exact UI authority: Host và Origin phải khớp, `Sec-Fetch-Site` phải là `same-origin`, body phải là `application/json`, và request cần per-session CSRF token gắn với HttpOnly `SameSite=Strict` cookie. Duplicate/malformed authority, missing Origin/Fetch Metadata/token, simple content type và cross-site POST đều có negative integration test.

### Medium — Protocol và financial semantics

#### M-01 — Lending pause chặn cả hành vi giảm rủi ro — Resolved in Phase 4

`PolicyControlledLendingPool.sol:223-385` chặn repay, collateral top-up, liquidity deposit, liquidation và bad-debt absorption trong khi `accrueInterest()` vẫn chạy. Tách pause flags: chặn borrow/withdraw trước; mặc định cho repay/top-up; liquidation và supplier operations có policy riêng.

Remediation dùng action bitmask thay cho một `whenNotPaused` đồng nhất. Default emergency mask chặn borrow, collateral/liquidity withdrawal và reserve withdrawal; repayment và collateral top-up không có pause path, còn supply, liquidation và bad-debt absorption có flag riêng. Guardian chỉ có thể thêm flag; `RISK_ADMIN_ROLE` mới được clear.

#### M-02 — Accrual trên 365 ngày bị bỏ mất phần thời gian dư — Resolved in Phase 4

`PolicyControlledLendingPool.sol:583-600` cap elapsed rồi đặt `lastAccrualTimestamp = block.timestamp`; test hiện đóng đinh hai năm chỉ tính một năm. Cập nhật timestamp theo phần đã xử lý và cho keeper catch up theo batch, hoặc ghi rõ đây là debt holiday có chủ đích.

Remediation chỉ cộng timestamp bằng elapsed đã xử lý, giữ phần dư thành backlog, cung cấp `catchUpInterest(maxBatches)` giới hạn 32 batch/call và fail closed financial actions khi backlog còn lớn hơn một batch. Khi chưa có debt, idle time được advance thẳng tới hiện tại để khoản vay mới không nhận lãi lịch sử. Regression hai năm chứng minh cả hai batch được ghi nhận thay vì debt holiday.

#### M-03 — Application route migration làm message in-flight bị từ chối — Resolved in Phase 4

`InstitutionalCollateralApp` chỉ có một route mỗi chain và overwrite route cũ, trong khi gateway hỗ trợ trust endpoint cũ khi migration. Dùng versioned allowlist `(chainId, remoteApplication)` và drain in-flight messages trước revoke.

Remediation giữ một current outbound route nhưng trust inbound theo từng `(chainId, remoteApplication)` version bất biến. Kích hoạt version mới không xóa version cũ; pending outbound được đếm theo version. Transfer timeout bị giới hạn bảy ngày, đúng bằng drain period; old version chỉ revoke sau schedule, hết window và pending count bằng không. Tests cover old-source acceptance trong migration, early/pending revocation rejection và post-drain rejection.

#### M-04 — Conflict/trusting-period wording rộng hơn code — Resolved in Phase 5

- Historical conflict ngoài submission-age hoặc ngoài current/previous epoch không thể freeze client.
- `trustingPeriod` chỉ là maximum submission age; root đã accept không tự expire.

Đổi tên thành `maxCheckpointSubmissionAge`, giới hạn claim documentation, hoặc bổ sung historical conflict/freshness semantics thật.

Remediation đổi contract getter, constructor input, revert reason, deployment environment và security-profile field sang maximum-submission-age semantics. Root đã accept tiếp tục query/authorize khi client active; test khóa rõ việc không có TTL. Automatic conflict freeze chỉ áp dụng khi conflicting checkpoint còn trong submission window và dùng current/previous epoch; historical evidence ngoài cửa sổ cần guardian freeze và governed recovery như protocol/threat-model đã ghi.

#### M-05 — Liquidation parameters thiếu cross-invariant — Resolved in Phase 4

Haircut, liquidation threshold và bonus được cấu hình riêng; chưa prove liquidation không làm health factor xấu hơn trong mọi allowed config. Thêm validation tổng hợp và property test trên toàn parameter domain.

Remediation validate tích `haircut × threshold × (1 + bonus)` tại mọi setter liên quan. Với partial liquidation sâu dưới nước, nominal bonus seize bị cap theo tỷ lệ debt repaid; một rounding buffer chỉ áp dụng nếu nested integer valuation vẫn làm health giảm. `executable` yêu cầu health sau không thấp hơn trước, còn full collateral exhaustion atomically ghi phần dư thành bad debt/default. Fuzz test bao phủ allowed haircut/threshold/bonus/close-factor/price/repay domain.

#### M-06 — Debt cap đang theo origination principal, không phải accrued debt exposure — Resolved in Phase 4

Interest không đi vào policy outstanding; repayment giảm principal counter trước. `accountBorrowCap` cũng đang theo account–debt-asset pair. Chọn rõ semantics và đổi tên `originationPrincipalCap`, hoặc đồng bộ accrued exposure. Sau write-off cần default/frozen-credit status trước khi account có thể vay lại.

Remediation chọn và công khai origination-principal semantics: ABI, state, event và policy code đều mang tên tương ứng; asset cap theo từng debt asset, account cap cộng gộp principal qua mọi asset. Repayment phân bổ vào accrued interest trước rồi mới giải phóng principal capacity. Mọi nonzero debt write-off đặt `accountDefaulted`; `canBorrow` fail closed cho đến khi policy governance ghi một nonzero resolution reference. Accrued exposure vẫn hiển thị/giám sát riêng và không bị gọi nhầm là cap utilization.

#### M-07 — MPT/RLP assurance chưa tương xứng với security boundary — Resolved in Phase 5 within repository scope

Unit proof chủ yếu dùng synthetic single-leaf trie; thiếu branch/extension/inline-node corpus, malformed-RLP fuzz và differential verification với client/reference implementation. Đây là test gap quan trọng trước external audit.

Remediation phát hiện và sửa một lỗi thật: nested RLP list từng bị strip outer prefix nên canonical inline child proof bị từ chối. Decoder hiện preserve complete inline node và reject trailing bytes/non-canonical single byte/long form/leading-zero length; hex-prefix reject invalid flag/padding. Test-only corpus tự encode branch, extension→branch, inline child và ba absence witness; một parser/walker độc lập đối chiếu production result trên corpus, 128 malformed fuzz runs và 129 mutated-corpus runs. Phase 8 bổ sung 5 generic + 3 account/storage vectors sinh offline bằng exact EthereumJS Trie, manifest/tool integrity, byte-exact drift gate và generated adapter chạy qua production boundary. Existing live Besu EIP-1186 integration path vẫn được giữ, nhưng corpus Phase 8 có `validatedLiveClients=[]`. Đây là repository differential assurance, không phải formal proof, fresh live multi-client validation hay independent audit.

#### M-08 — Multi-asset và deployment guards chưa hoàn chỉnh — Resolved in Phase 5

- daily consumption key chưa chứa asset dù limit key có asset;
- gateway/app không assert `localChainId_ == block.chainid`;
- oracle setter không kiểm tra bytecode;
- lending math ngầm định token/price 18 decimals;
- recapitalization khi assets bằng 0 nhưng shares cũ còn tồn tại chưa có loss-epoch policy.

Remediation key consumption theo `(account, canonicalAsset, day)` và có isolation regression giữa account/asset/day. Gateway và application require configured local chain bằng `block.chainid`; checkpoint client/app dependencies và valuation oracle phải có bytecode. Single-market lending cố ý chỉ hỗ trợ collateral/debt token 18 decimals và oracle scale 18 decimals, reject metadata khác thay vì âm thầm tính sai. Khi total assets về zero với shares còn lại, pool advance epoch, set active total shares về zero và làm legacy user claims không còn hiệu lực trước deposit recapitalization.

### Medium — Runtime, evidence và UI logic

#### M-09 — Evidence status và source applicability đang trộn nhau — Resolved in Phase 2

`scripts/ui/evidence.mjs:80-100` tính `sourceMatches` nhưng không đưa vào `status`. Report cũ có thể vẫn là `passed` dù source hiện tại khác. Tách `reportStatus` khỏi `applicableToCurrentSource`; UI không được hiển thị current-pass khi applicability false.

Remediation giữ historical `reportStatus` để audit nhưng chỉ đặt compatibility `status=passed` khi report pass và source hiện tại còn applicable. Commit mismatch, dirty tree và Git lookup failure trở thành `stale`; UI hiển thị recorded-only, còn `demo:doctor` và offline verifier trả `NOT READY`/exit code khác 0.

#### M-10 — Retry option bị truyền sai tên — Resolved in Phase 3

Runtime/integration dùng `initialMs/maximumMs`, trong khi retry helper nhận `baseMs/maxMs`; tuning đang bị bỏ qua. Thêm typed config/schema test.

Remediation chuẩn hóa duy nhất `baseMs/maxMs/jitterRatio`, giới hạn timer/range, từ chối unknown và legacy keys ở config/engine thay vì âm thầm dùng default, đồng thời sửa caller theo đúng schema.

#### M-11 — RPC, nonce và lifecycle error boundaries còn thiếu — Resolved in Phase 3

- scan RPC transient error dừng toàn relay loop;
- RPC fetch không có AbortSignal timeout;
- custom nonce manager tăng nonce trước broadcast và có thể tạo gap;
- partial attestor initialization có thể rò server;
- port UI bị chiếm sau runtime init có thể để background service sống;
- static stream error sau response header chưa được bắt.

Remediation bao phủ toàn bộ nhóm lỗi: relay scan cô lập transient RPC error theo lane và retry với bounded backoff; fetch/block/code reads có deadline và bounded retry; nonce manager serialize send, chỉ advance sau accepted broadcast và reset về network reconciliation khi kết quả mơ hồ. Embedded attestor/relay/action journals, servers và mọi provider được giải phóng khi startup dở dang hoặc shutdown; shutdown đợi action đang chạy kể cả khi một concurrent busy request đã reject. UI listen trước runtime initialization, startup failure cleanup toàn bộ resource, còn static stream/API response xử lý cả lỗi trước và sau khi header được gửi. Regression tests cover transient recovery, stalled RPC, ambiguous send, occupied port, partial listen/lane failure, idempotent close và active-action shutdown ordering.

#### M-12 — Health/readiness labels chưa phản ánh liveness thật — Resolved in Phase 5

- chain `healthy: true` chỉ vì đọc được block, chưa chứng minh block đang tiến;
- relay `online` chỉ cần một attestor, chưa phải quorum/relayer heartbeat;
- runtime `ready` chỉ là read-model readable.

Model status cần tách `runtimeReadable`, `chainsProgressing`, `attestorQuorumReady`, `relayerHealthy`, `governanceEnforced`, `identitiesEligible` và `laneReady`.

Remediation triển khai đúng bảy signal trên. Chain progress cần ít nhất hai observation và expire theo bounded staleness; attestor quorum so active count với configured threshold; relay health dựa recent successful heartbeat và không có current error; governance kiểm tra mode cùng delay của cả hai chain. Compatibility `ready` bằng `laneReady`, còn UI/doctor dùng semantic fields trực tiếp.

#### M-13 — UI dùng floating-point cho token amount — Resolved in Phase 5

`demo/app.js` dùng JavaScript `Number`, epsilon và tối đa tám chữ số hiển thị trong validation/fill. Điều này có thể tạo rounding/dust hoặc mismatch với backend 18 decimals. Dùng decimal string + `BigInt` units xuyên suốt; lưu `{requestId, action, amount}` cho uncertain retry.

Remediation tách `demo/token-amount.js`: parse/normalize/compare bằng exact 18-decimal `BigInt`, chỉ convert phần trăm trình bày sau khi domain calculation đã integer-safe. Input, limit, dust và repay-all giữ exact decimal string. Action request store persist complete normalized tuple; unresolved same-action request với amount khác fail closed thay vì tái dùng ID.

#### M-14 — Status fetch failure vẫn giữ snapshot cũ có thể thao tác — Resolved in Phase 5

Khi refresh fail, `currentStatus` cũ còn tồn tại và forms không chắc bị khóa. Xóa active snapshot, disable actions và yêu cầu successful refresh mới trước POST.

Remediation catch path đặt `currentStatus = null`, render runtime failure và disable mọi primary action. Validation/submit đều cần current `laneReady`; chỉ một status refresh thành công mới khôi phục actionable snapshot.

#### M-15 — Benchmark/restart wording chưa đúng phép đo — Resolved in Phase 5

- `sourceFinalizedAt` hiện được ghi ngay sau inclusion; metric `postSourceFinality` đặt sai tên.
- “relayer restart” chỉ reload engine/journal trong cùng process, chưa phải OS-process crash/restart với key/provider lifecycle mới.
- validator test chỉ là unavailable/crash, không phải Byzantine injection.

Remediation bump integration schema lên `institutional-integration-report-v2`: receipt observation dùng `sourceIncludedAt`, metric dùng `postSourceInclusionToCompletionMs`, summary dùng `postSourceInclusionToCompletion`. Scenario đổi thành `engineReloadRecovery.reloadState` và mô tả đúng việc close/reopen engine+journal cùng process. QBFT report đổi thành `besu-qbft-validator-availability-report-v2`, fields `validatorUnavailable`/`duringUnavailability` và bắt buộc `testModel` nói rõ không inject Byzantine behavior. Validator từ chối legacy schema fail closed; operational filename/env và command alias cũ chỉ được giữ để migration không làm gãy automation.

### Low / maintainability / consistency

#### L-01 — UI files quá lớn và override chồng lớp — Resolved trong scope cleanup Phase 7

- CSS 3.714 dòng với base, `Luminous Ledger` và interaction override layers; nhiều selector lặp 3–5 lần.
- Khoảng 110 hex và 66 rgba values làm theme token không còn là nguồn duy nhất.
- 11 class cũ không còn được markup dùng; logo cũ không còn reference.
- `app.js` trộn API, state, decimal/domain logic, rendering, interaction và copy.

Remediation Phase 6 tách lending domain, generic/evidence presentation và workflow presentation khỏi controller. Phase 7 tiếp tục gom palette/type/shape/shadow thành token, xóa dead selector, unused token và override chắc chắn, đưa CSS từ 3.714 xuống 3.142 dòng. `app.js` tăng từ snapshot Phase 6 do bổ sung explicit keyboard/disclosure/focus/offline-reset semantics, không đưa pure domain logic trở lại controller; tab index calculation nằm trong module test độc lập. Việc tách vật lý CSS/controller thành nhiều file chỉ còn là follow-up tùy chọn nếu kích thước tiếp tục tăng, không phải finding Phase 7 còn mở.

#### L-02 — Accessibility/projector quality chưa có automated gate — Resolved in Phase 7

- Nhiều metadata vẫn 10–12 px; contrast của subtle text/focus ring chưa đạt AA cho text nhỏ.
- Popover/detail ẩn bằng opacity nhưng còn trong accessibility tree.
- Tab roles/aria-selected/aria-controls chưa đầy đủ.
- Form error chưa là live region; pointer-events không chặn keyboard.
- Motion vẫn chạy ở trạng thái warning/offline và có nhiều box-shadow repaint.

Remediation dùng semantic tablists/tabpanels, roving tabindex, keyboard wrap/Home/End, disclosure focus management, `hidden`/`inert`, native disabled state và live form feedback. Type tokens có floor 12px, interactive controls tối thiểu 13px và body 14px; browser scan kiểm computed size thay vì chỉ source declaration. Axe chạy trên đủ sáu view ở ba desktop viewport; state-driven motion có regression cho ready, review, offline reset và reduced-motion. Mười Chromium baselines khóa Identity ở ba width cùng mọi operation panel/mode tại canonical 1600px.

#### L-03 — `.env.example` bị drift khỏi runtime — Resolved in Phase 6

Nhiều biến `DEMO_FORWARD_AMOUNT`, `DEMO_LIGHT_CLIENT_*`, packet/header gap, retry/TTL cũ không còn được source đọc; ngược lại nhiều `INSTITUTIONAL_*` và `BESU_*` thực tế không được mô tả. Sinh config reference từ schema hoặc có test phát hiện biến example không được dùng.

Remediation thay toàn bộ example bằng current runtime profile và thêm automated bidirectional source-key gate. Hai compatibility alias cũ được ghi chú nhưng không gán để không che key canonical.

#### L-04 — Package, CI và license chưa thống nhất — Substantially remediated through Phase 8

- `ethers` từng nằm sai trong `devDependencies`; đã chuyển sang runtime dependency ở Phase 6.
- TypeScript/ts-node/@types/chai/mocha trực tiếp không có consumer; đã được gỡ ở Phase 6.
- `private` và Node engine đã có; coverage/mutation scripts được thêm ở Phase 8, còn lint/format/typecheck chưa có.
- GitHub Actions trước Phase 8 dùng floating tags và chưa enforce verification depth.
- Contracts dùng SPDX MIT trong khi root `LICENSE` và `package.json` là ISC.

Remediation package đã chuyển `ethers`, loại direct dependency không dùng, thêm `private`/Node engine, pin Hardhat `3.12.0` cùng Playwright/Axe và EthereumJS Trie bằng exact versions; lockfile hiện có `npm audit` 0 vulnerability. Phase 8 thêm scripts corpus/invariant/coverage/mutation và SHA-pin toàn bộ GitHub Actions. Phase 9 thêm browser/defense preflight và chuyển hosted Besu calibration thành clean evidence + verifier; hosted job chưa được quan sát chạy trong audit này. Lint/format/typecheck và quyết định thống nhất root ISC với contract SPDX MIT vẫn là residual policy scope.

#### L-05 — Helper và domain code bị lặp — Substantially remediated in Phase 6

`writeJsonAtomic`, `waitForTx`, `readJsonIfExists`, allowance, error normalization và runtime setup lặp ở nhiều scripts. Runtime, deploy và integration nên dùng shared modules thay vì copy/paste rồi drift.

Remediation tạo shared JSON I/O và transaction receipt, đồng thời tách durable action runtime, deployment manifest, integration benchmark/validator evidence, UI domain/presentation và lending pure math. Allowance/error normalization còn có thể hội tụ thêm khi xuất hiện consumer thứ ba có cùng semantics; Phase 6 không ép abstraction cho helper chỉ giống bề ngoài.

## 6. Wording và claim matrix chuẩn

### Claim levels

| Từ được phép | Chỉ dùng khi |
| --- | --- |
| Enforced on-chain | Có exact contract guard/invariant trên execution path |
| Tested | Có automated test cụ thể đang pass |
| Observed | Có report từ một run, timestamp, topology và provenance rõ |
| Configured | Chỉ phản ánh config/manifest, không suy ra health |
| Live | Có heartbeat/progress measurement còn mới |
| Formally verified | Chỉ khi có model checker/proof assistant/symbolic proof với scope được công bố; hiện chưa có |

### Glossary khóa cho toàn dự án

| Thuật ngữ | Nghĩa chuẩn |
| --- | --- |
| aBANK | Canonical asset; luôn ở Bank A và bị khóa trong escrow khi chuyển claim |
| vA | Policy-controlled voucher/claim 1:1 được phát hành trên Bank B sau proof verification |
| bCASH | Debt asset được pool disburse; khác với borrower debt liability |
| QBFT validator | Thành phần consensus; committed QBFT block có immediate finality |
| Checkpoint confirmation depth | Khoảng đợi bảo thủ sau source inclusion/finality trước khi attestor ký |
| Checkpoint attestor | Chứng thực state root đã quan sát; không tạo QBFT finality |
| Relayer | Vận chuyển checkpoint/proof/transaction; ảnh hưởng liveness, không tự tạo authority |
| Message receipt | Gateway replay-protection record; không phải collateral voucher |
| At-most-once effect | On-chain receipt chặn successful callback lần hai; không đồng nghĩa delivery luôn hoàn tất |
| Validation evidence | Test, scenario, benchmark, provenance và checksum; không phải formal verification |

### Các thay đổi wording đã thực hiện trong audit

- Bỏ `FORMAL VERIFICATION` khỏi UI và thay bằng `REPRODUCIBLE VALIDATION`/`VALIDATION EVIDENCE`.
- `finality depth 2` được trình bày là post-inclusion checkpoint wait.
- `Transfer canonical collateral` đổi thành `Lock aBANK and issue vA`.
- Phân biệt `outstanding debt`, `borrowing capacity` và `wallet bCASH balance`.
- `independent attestors` trong local profile đổi thành distinct configured attestors.
- Runtime status đổi từ `All systems operational` thành runtime snapshot/readability wording.
- Các nhãn rộng như `Verified liquidity`, `Verified burn`, `Credit amount` và evidence `Verified` được thu hẹp thành proof-backed, voucher burn, borrow amount và current/recorded pass.
- README được viết lại có dấu, thêm scope, destructive warning, test modes và prototype disclaimer.
- Demo flow/runbook được đồng bộ theo evidence-first presentation sequence.
- Threat model ghi rõ terminal-revocation compensation gap thay vì claim tuyệt đối “no asset is lost”.

Tên schema/function nội bộ như `formalEvidenceEligible`, `formalEvidencePayload` và `finalityDepth` được giữ tạm để tránh breaking change; rename có migration alias nằm trong cleanup roadmap.

## 7. Cơ hội cải thiện và phát triển

Chỉ nên triển khai các hướng sau sau khi P0/P1 correctness hoàn tất:

1. Production-grade attestation: HSM-backed keys, mTLS, organization-separated operators, domain allowlist và monitored signing policy.
2. Transactional relay: PostgreSQL/SQLite adapter, fencing, outbox, metrics, tracing, replay dashboard và disaster-recovery drill.
3. Oracle/risk: production oracle adapter, multi-source price validation, per-market decimal metadata, default workflow và portfolio-wide limits.
4. Multi-market: nhiều collateral/debt assets với explicit decimal normalization, isolated risk pools, portfolio aggregation và migration/versioning; asset-keyed daily velocity đã có ở application layer.
5. Privacy/compliance: credential disclosure minimization, selective disclosure/ZK research, retention policy và governed restricted-claims workflow.
6. Trust minimization research: validator-set-aware client hoặc formally specified checkpoint protocol; so sánh cost/assumption với current consortium model.
7. Defense UX: transaction timeline với source tx, checkpoint/root, proof source, destination tx, acknowledgement, duration và data-source badges.
8. Benchmark science: monotonic timing, warm-up, hardware profile, confidence interval, throughput/soak và production-like network latency.

## 8. Cleanup roadmap

Ước lượng dưới đây là engineering days cho một người đã hiểu codebase; không bao gồm external audit.

| Phase | Ưu tiên | Thời lượng | Công việc chính | Exit gate |
| --- | --- | ---: | --- | --- |
| 0. Freeze semantics — completed | P0 | 1–2 ngày | Khóa glossary/claim matrix, mở issue theo ID audit, lưu baseline | Không còn claim formal/finality/independent sai; backlog có owner/test |
| 1. Safety blockers — completed | P0 | 4–7 ngày | Recovery floor, revoked restitution, destructive-path guard, attestor domain allowlist | Regression tests mới pass; threat model khớp code |
| 2. Evidence integrity — completed | P0 | 2–4 ngày | Structured reporter, hardened env allowlist, applicability status, evidence self-test | Missing test/unsafe env/source mismatch đều fail đúng |
| 3. Runtime correctness — completed | P1 | 5–8 ngày | Durable outbox, idempotency, lease renewal/fencing, singleton journal, CSRF, timeout/error boundaries | Crash/lease/multi-worker/CSRF/lifecycle integration tests pass; production clustering vẫn cần DB/CAS |
| 4. Financial semantics — completed | P1 | 5–8 ngày | Granular pause, accrual catch-up, versioned routes, cap/default semantics, liquidation invariant | Stateful/fuzz tests pass; accounting spec cập nhật |
| 5. Assurance/interface correctness — completed | P1 | 4–7 ngày | Checkpoint-age wording, MPT corpus/reference/fuzz, multi-asset/deployment guards, semantic readiness, BigInt/retry/stale UI, evidence metric/schema wording | 127 Solidity + 161 service tests và UI gate pass; docs/schema khớp; live evidence còn cần clean run |
| 6. Modular cleanup — completed | P1 | 4–7 ngày | Shared IO/tx/config modules, split runtime/deploy/integration/lending/UI domain code, dead-code removal | 131 Solidity + 193 service tests và UI gate pass; six-monolith footprint giảm 790 dòng; ABI/storage/schema giữ nguyên |
| 7. UI/a11y cleanup — completed | P1 | 4–6 ngày | CSS tokens/modules, ARIA, contrast, projector typography, keyboard semantics, state-driven motion | 21/21 Playwright project-test instances; keyboard + axe + 3 desktop viewport + 10 visual baselines pass |
| 8. Verification depth — repository scope completed; live cross-client residual | P2 | 7–12 ngày | Pinned deterministic offline MPT corpus, stateful invariants, line coverage, bounded mutation và hosted Besu calibration definition | 139 Solidity; 94,03% line coverage; 4/4 bounded mutants; security suite machine-verifiable. `validatedLiveClients=[]` và hosted Besu run chưa được quan sát |
| 9. Live evidence and defense readiness — repository scope completed; clean run pending | P2 | 4–7 ngày | Live Besu client/proof capture, summary v4/integration v3, clean hosted evidence, browser/defense preflight và claim matrix | 139 Solidity + 228 service + UI gate + 21 browser tests pass; browser và Docker prerequisites đạt. Clean live/hosted observation và multi-client validation vẫn chưa được claim ở snapshot trước evidence run |
| 10. Production extensions | P3 | Theo scope | HSM/mTLS/multisig, production DB/oracle/monitoring/privacy/legal review | Chỉ gắn production claim sau independent review |

### Thứ tự file cleanup đề xuất

1. `scripts/verification/security-scenarios.mjs`, `institutional-evidence.mjs`, `validate-config.mjs`.
2. `InstitutionalCheckpointClient.sol`, `InstitutionalEVMProofBoundary.sol`, `InstitutionalCollateralApp.sol` và compensation contracts.
3. `checkpoint-attestor.mjs`, relay engine/journal, action journal/runtime API.
4. `PolicyControlledLendingPool.sol`, `BankPolicyEngine.sol` và financial property tests.
5. Shared `config`, `atomic-store`, `transaction-manager`, `evidence-schema` modules.
6. Theo dõi tăng trưởng `demo/app.js` và `demo/styles.css`; chỉ tách vật lý theo domain/component/state/motion khi có thêm consumer hoặc kích thước lại vượt ngưỡng review.
7. README, ADR, protocol spec, runbooks và SVG được kiểm tra drift trong CI.

## 9. Definition of Done cho cleanup

Một phase chỉ được coi là xong khi:

- có test tái hiện bug trước fix và pass sau fix;
- documentation/threat model mô tả đúng semantics sau fix;
- không dùng `passed`, `verified`, `live`, `independent` hoặc `exactly once` ngoài scope bằng chứng;
- `npm test`, config safety checks và relevant integration tests pass;
- `git diff --check` sạch;
- không thêm secret/generated runtime state vào Git;
- security-sensitive migration có backward-compatibility hoặc explicit reset plan;
- report/evidence ghi commit, dirty state, effective config và tool versions;
- UI state lỗi không cho phép action dựa trên stale snapshot;
- destructive command có validated, narrow target và negative safety tests.

## 10. Câu mô tả bảo vệ đã hiệu chỉnh

> Hệ thống là một consortium-trusted reference prototype. QBFT tạo finality cho từng bank ledger; một attestor quorum 3-of-4 cho phép destination checkpoint client chấp nhận state root đã quan sát, sau đó destination gateway tự kiểm tra EVM storage proof và bảo đảm at-most-once on-chain effect. Relayer chỉ vận chuyển evidence và ảnh hưởng liveness. Identity, policy, custody và lending controls tiếp tục được enforce on-chain. Automated tests và isolated runtime reports là reproducible validation evidence, không phải formal verification, external audit hoặc production SLA.

## 11. Nguồn lý thuyết chính

- [Ethereum Yellow Paper](https://ethereum.github.io/yellowpaper/paper.pdf)
- [EEA QBFT specification](https://entethalliance.github.io/client-spec/qbft_spec.html)
- [Besu QBFT configuration](https://github.com/besu-eth/besu-docs/blob/main/docs/private-networks/how-to/configure/consensus/qbft.md)
- [Besu 26.8.1 release notes](https://github.com/besu-eth/besu/releases/tag/26.8.1)
- [IBFT 2.0 paper](https://arxiv.org/abs/2002.03613)
- [EIP-712 typed structured data](https://eips.ethereum.org/EIPS/eip-712)
- [EIP-1186 account/storage proof RPC](https://eips.ethereum.org/EIPS/eip-1186)
- [ERC-4626 tokenized vault standard](https://eips.ethereum.org/EIPS/eip-4626)
- [SoK: Communication Across Distributed Ledgers](https://eprint.iacr.org/2019/1128)
- [Compound protocol whitepaper](https://compound.finance/documents/Compound.Whitepaper.v04.pdf)
- [Compound III specification](https://github.com/compound-finance/comet/blob/main/SPEC.md)
- [Aave health factor and liquidations](https://aave.com/help/borrowing/liquidations)
- [Hardhat 3 Solidity invariant and coverage configuration](https://hardhat.org/docs/reference/configuration)
- [OpenZeppelin access control and timelock](https://docs.openzeppelin.com/contracts/5.x/access-control)
- [Solidity security considerations](https://docs.soliditylang.org/en/latest/security-considerations.html)
- [Node.js file-system promises](https://nodejs.org/api/fs.html#promises-api)
- [NIST Secure Software Development Framework 1.1](https://csrc.nist.gov/pubs/sp/800/218/final)
- [SLSA provenance 1.2](https://slsa.dev/spec/v1.2/provenance)

Bản giải thích có công thức, trust boundaries và câu hỏi bảo vệ được lưu tại [Defense teaching guide](docs/DEFENSE_TEACHING_GUIDE.md).
