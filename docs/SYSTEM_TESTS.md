# Cross-Chain Lending System Test Plan

Tai lieu nay chi tap trung vao **test he thong**:

- test end-to-end
- test tich hop giua contracts + workers + UI
- test hanh vi o muc market / actor / workflow

No khac voi `docs/TEST_CASES.md`:

- `TEST_CASES.md` = test matrix tong hop cho tung contract, tung nut, tung edge case
- `SYSTEM_TESTS.md` = test he thong tu dau toi cuoi, theo actor va theo flow nghiep vu

## 1. Muc tieu cua test he thong

Can xac minh 5 dieu:

1. lock / mint / burn / unlock flow hoat dong xuyen 2 chain
2. lending flow hoat dong dung tren lending chain
3. owner controls tac dong dung len state he thong
4. workers bridge xu ly message dung va khong replay sai
5. UI hien thi dung semantics cua state sau moi flow lon

## 2. Pham vi

System test nay cover:

- `Chain A`
- `Chain B`
- `deploy:multichain`
- `seed:multichain`
- `worker:hub`
- `user.html`
- `owner.html`

Khong cover production concerns nhu:

- RPC outage handling phuc tap
- Byzantine validator behavior that su
- fork / reorg / cross-chain proof verification

## 3. Dieu kien tien de

## 3.1 Chay he thong

Mo cac terminal:

### Terminal 1

```bash
npm run node:chainA
```

### Terminal 2

```bash
npm run node:chainB
```

### Terminal 3

```bash
npm run deploy:multichain
```

### Terminal 4

```bash
npm run seed:multichain
```

### Terminal 5

```bash
npm run worker:hub
```

### Terminal 6

```bash
cd demo
py -m http.server 5500
```

Mo:

- `http://localhost:5500/user.html`
- `http://localhost:5500/owner.html`

## 3.2 MetaMask

Them 2 network:

- Chain A: `31337`
- Chain B: `31338`

Import:

- `Account #0` = owner
- `Account #2` = user

## 3.3 Baseline owner config

Cho ca `A -> B` va `B -> A`, dat:

- `Collateral factor = 5000`
- `Loan duration = 72 hours`
- `Overdue penalty = 500`
- `Liquidation bonus = 500`
- `wrapped price = 1`
- `stable price = 1`

## 4. Tieu chi pass / fail

Moi system test duoc xem la pass khi:

1. transaction thanh cong dung thu tu mong doi
2. worker logs phan ung dung voi event
3. UI state sau refresh phu hop voi state on-chain
4. khong co state mau thuan giua:
   - debt
   - collateral in pool
   - wrapped wallet
   - locked source collateral

## 5. Test he thong chinh

## ST-01 Cold boot system

### Muc dich

Xac minh he thong co the khoi dong sach tu dau.

### Preconditions

- chua co process nao dang chay

### Steps

1. start Chain A
2. start Chain B
3. run `deploy:multichain`
4. run `seed:multichain`
5. run `worker:hub`
6. mo `user.html`
7. mo `owner.html`

### Expected

- deploy thanh cong
- `demo/multichain-addresses.json` duoc tao moi
- seed thanh cong
- worker hub start 3 validators + 1 executor
- user portal load khong JS error
- owner portal load khong JS error

### Fail signs

- `CALL_EXCEPTION` khi deploy
- `missing revert data` tren deploy
- worker `ECONNRESET` lap lai lien tuc
- UI khong load state / labels sai / JS crash

## ST-02 Owner baseline configuration

### Muc dich

Xac minh owner portal co the dat market baseline va gia oracle mock.

### Steps

1. owner connect `owner.html`
2. chon market `A -> B`
3. nhap baseline
4. bam `Apply Baseline`
5. refresh

### Expected

- contract params update thanh cong
- wrapped price va stable price = 1
- owner metrics cap nhat

### Verify

- `collateral factor`
- `loan duration`
- `penalty`
- `bonus`
- prices

## ST-03 A -> B bridge mint flow

### Muc dich

Xac minh lock tren source chain tao wrapped token tren destination chain.

### Steps

1. user connect `user.html`
2. market = `A -> B`
3. tren Chain A, `Lock 40 aCOL`
4. doi worker xu ly
5. bam `Refresh`

### Expected

- user `aCOL wallet` giam 40
- `Locked aCOL` tang 40
- worker logs co:
  - `A_TO_B lock attest`
  - `A_TO_B execute mint`
- `wA wallet` tren Chain B tang 40

### Pass conditions

- mint xuat hien ma khong can thao tac tay tren bridge

## ST-04 A -> B lending happy path with wallet repay

### Muc dich

Xac minh full clean lifecycle khi user repay bang stable trong vi.

### Steps

1. tiep tuc tu `ST-03`
2. deposit `40 wA`
3. borrow `15 sB`
4. owner mint them `15 sB` cho user neu can
5. user `Repay All`
6. user `Withdraw Max`
7. user `Burn Max`
8. doi worker xu ly unlock
9. refresh

### Expected

- debt = 0
- collateral in pool = 0
- wrapped wallet = 0
- `Locked aCOL = 0`
- `aCOL wallet` quay ve muc da unlock day du
- position summary khong con active debt

### Worker logs expected

- `A_TO_B burn attest`
- `A_TO_B execute unlock`

### Muc dich he thong duoc xac minh

- lock -> mint -> deposit -> borrow -> repay -> withdraw -> burn -> unlock

## ST-05 A -> B close debt by collateral sale

### Muc dich

Xac minh user co the dong debt bang collateral trong pool ma khong can stable trong vi.

### Steps

1. lock `50 aCOL`
2. worker mint `50 wA`
3. deposit `20 wA`
4. borrow `10 sB`
5. user bam `Auto Close Debt`
6. user `Withdraw Max`
7. user `Burn Max`
8. refresh

### Expected

- debt = 0
- pool collateral giam do da bi ban mot phan
- borrower khong reclaim duoc full `50 aCOL`
- UI outcome card phai giai thich:
  - phan nao con borrower reclaim duoc
  - phan nao la residual locked backing

### Muc dich he thong duoc xac minh

- `repayWithCollateral` hoat dong
- UI semantics sau collateral sale dung

## ST-06 B -> A symmetry flow

### Muc dich

Xac minh architecture hoat dong doi xung o market nguoc lai.

### Steps

1. chon market `B -> A`
2. owner apply baseline
3. user lock `40 bCOL`
4. worker mint `wB` tren Chain A
5. user deposit `wB`
6. user borrow `sA`
7. repay theo wallet path
8. withdraw max
9. burn max
10. worker unlock tren Chain B

### Expected

- cac buoc hoat dong doi xung voi market `A -> B`
- khong co leak state giua 2 market

## ST-07 Overdue without penalty

### Muc dich

Xac minh khi qua han, borrower bi block borrow/withdraw nhung debt chua bi phat ngay lap tuc.

### Steps

1. open mot position dang co debt
2. owner `Advance +1 Day` lap lai toi khi qua `loanDuration`
3. refresh user portal

### Expected

- status chip = `Overdue`
- user khong borrow them duoc
- user khong withdraw duoc
- user van co the repay
- penalty chua tang neu owner chua bam `Apply Penalty`

## ST-08 Apply overdue penalty

### Muc dich

Xac minh owner co the cong phat mot lan cho position overdue.

### Steps

1. bat dau tu `ST-07`
2. owner bam `Apply Penalty`
3. refresh ca owner va user portal

### Expected

- `Penalty` > 0
- total debt tang
- penalty chi duoc ap mot lan cho cycle overdue hien tai

### Negative check

4. bam `Apply Penalty` lan hai

### Expected

- fail

## ST-09 Liquidate overdue user

### Muc dich

Xac minh liquidate path cho overdue position.

### Steps

1. tao position co debt
2. advance time den overdue
3. co the apply penalty hoac bo qua
4. owner bam `Liquidate User`
5. refresh

### Expected

- owner/liquidator tra stable vao pool
- borrower mat mot phan hoac toan bo collateral
- debt giam manh hoac ve 0
- neu debt ve 0 thi due state reset
- neu van con dust debt do collateral-value cap thi UI phai phan anh dung semantics

### Quan sat can ghi nhan

- `Total Debt`
- `Penalty`
- `Collateral in Pool`
- `Unlocked source collateral`
- `Locked residual backing`

## ST-10 Price-drop liquidation

### Muc dich

Xac minh liquidation co the kich hoat boi price shock ma chua can overdue.

### Steps

1. tao position:
   - deposit wrapped
   - borrow gan muc toi da
2. owner giam `wrapped price`
3. refresh
4. quan sat `health factor`
5. owner bam `Liquidate User`

### Expected

- health factor giam xuong < 1
- position tro thanh liquidatable
- liquidation tuan theo close factor va collateral value cap

## ST-11 Repay wallet max no dust preview regression

### Muc dich

Xac minh `Repay Wallet Max` khong phu thuoc vao preview stale o UI.

### Steps

1. tao position co debt va stable wallet du
2. bam `Repay Wallet Max`
3. refresh

### Expected

- neu wallet stable du, debt ve 0 trong 1 tx
- khong can nhan nut nhieu lan chi vi stale preview

### Regression being tested

- `repayAvailable()` phai lay wallet stable on-chain trong transaction

## ST-12 Withdraw max no stale exact regression

### Muc dich

Xac minh `Withdraw Max` la direct action, khong con can fill exact amount roi moi rut.

### Steps

1. tao position sao cho co collateral rut duoc
2. bam `Withdraw Max`
3. refresh

### Expected

- collateral rut dung max on-chain
- khong can nhap input
- khong fail chi vi state drift sau khi preview

## ST-13 Burn max direct release regression

### Muc dich

Xac minh `Burn Max` dot toan bo wrapped dang nam trong vi.

### Steps

1. dam bao user dang co wrapped token trong vi
2. bam `Burn Max`
3. doi worker xu ly
4. refresh

### Expected

- wrapped wallet ve 0
- burn request xuat hien
- local collateral unlock tuong ung neu worker xu ly thanh cong

## ST-14 Liquidation no-preview-dust regression

### Muc dich

Xac minh UI liquidate khong gui exact `previewDebt` cu, ma gui max amount de giam residual dust do stale preview.

### Steps

1. tao position overdue
2. owner bam `Liquidate User`
3. refresh

### Expected

- khong con case debt nho con lai chi vi UI preview stale
- neu van con debt thi ly do phai la:
  - collateral value cap
  - insolvency
  - close factor logic

## ST-15 User state after liquidation

### Muc dich

Xac minh UI khong gay hieu nham sau liquidation.

### Steps

1. tao va liquidate 1 position
2. mo `user.html`
3. refresh

### Expected

- UI khong duoc hien thi nhu borrower van reclaim duoc toan bo locked source collateral
- outcome card phai tach:
  - `User-Releasable Source Collateral`
  - `Locked Source Backing Not Held by Borrower`

## ST-16 Cross-market isolation

### Muc dich

Xac minh state `A -> B` khong lam hong state `B -> A`.

### Steps

1. tao mot position nho o `A -> B`
2. tao mot position nho khac o `B -> A`
3. thuc hien thao tac repay / withdraw tren mot market
4. refresh market con lai

### Expected

- market con lai khong bi doi state sai
- labels, balances, max borrow dung theo market dang chon

## ST-17 Worker restart tolerance

### Muc dich

Xac minh worker co the restart ma khong lam hu flow pending.

### Steps

1. tao lock event
2. dung `worker:hub`
3. restart `worker:hub`
4. refresh

### Expected

- worker tiep tuc xu ly pending message
- khong execute replay
- khong mat message state

## ST-18 Full smoke demo suite

### Muc dich

Day la smoke test truoc khi demo / bao ve.

### Steps

1. cold boot system
2. owner baseline `A -> B`
3. `A -> B` full clean wallet-repay path
4. `A -> B` collateral-sale path
5. overdue + penalty
6. liquidation path
7. owner baseline `B -> A`
8. `B -> A` symmetry path

### Expected

- tat ca flow lon thanh cong
- khong co nut max nao buoc user phai nhan nhieu lan chi vi stale preview
- UI semantics dung sau liquidation va collateral sale

## 6. Negative system tests

## ST-N01 Workers down during lock

### Steps

1. stop `worker:hub`
2. user lock collateral
3. refresh

### Expected

- source collateral lock thanh cong
- wrapped token chua duoc mint
- UI / bridge queue phan anh message dang pending

## ST-N02 Workers down during burn

### Steps

1. tao wrapped token
2. user burn wrapped
3. stop workers hoac workers dang down

### Expected

- burn request ton tai
- local collateral chua unlock
- khi worker chay lai, unlock tiep tuc

## ST-N03 Wrong chain selected in MetaMask

### Steps

1. o user portal, thu lock / deposit / borrow tren chain sai

### Expected

- UI yeu cau switch chain
- sau switch chain moi tiep tuc

## ST-N04 User spam nut khi tx pending

### Steps

1. bam lien tuc mot nut action

### Expected

- duplicate submit bi block
- khong tao state rung lac do multi-submit

## ST-N05 Dirty demo session

### Muc dich

Xac minh he thong van phan anh state nhat quan du session da co nhieu cycle truoc.

### Steps

1. chay nhieu flow lien tiep
2. liquidate mot position
3. burn mot phan collateral khac
4. doi market

### Expected

- UI van doc dung state hien tai
- bridge queue, debt, collateral khong mau thuan ro rang

## 7. Mau ghi nhan ket qua test

Cho moi test system, nen ghi:

- `Test ID`
- `Date / build`
- `Actors used`
- `Market`
- `Preconditions`
- `Actions`
- `Observed result`
- `Expected result`
- `Pass / Fail`
- `Notes / screenshots / tx hashes / worker logs`

Mau ngan:

```text
Test ID: ST-04
Market: A -> B
Build: local deploy 2026-03-25
Result: PASS
Observed:
- lock tx success
- mint worker executed
- deposit success
- borrow success
- repay all success
- withdraw max success
- burn max success
- unlock executed
Notes:
- tx hashes attached
- worker logs attached
```

## 8. Thu tu uu tien khi thoi gian gap

Neu ban khong co nhieu thoi gian, uu tien chay:

1. `ST-01`
2. `ST-04`
3. `ST-05`
4. `ST-08`
5. `ST-09`
6. `ST-10`
7. `ST-11`
8. `ST-12`
9. `ST-13`
10. `ST-15`

Day la tap con cho bao ve va demo thuc te.

