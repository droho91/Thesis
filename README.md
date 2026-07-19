# Institutional Cross-Chain Lending

## Lan dau sau khi chuyen tu demo cu

```bash
npm install
npm run demo:fresh
```

Lenh nay thay topology 1-validator cu bang profile 4-validator va mo UI tai `http://127.0.0.1:5173/`.

## Chay UI tu runtime hien tai

```bash
npm run demo:prepare
npm run demo:ui
```

Mo `http://127.0.0.1:5173/`.

`demo:prepare` khoi dong hai chain Besu QBFT, deploy institutional stack, seed tai khoan/thanh khoan va chuyen quyen quan tri sang timelock. UI tu dong khoi dong 4 attestor cung relayer co journal; nguoi dung chi thao tac transfer, lending va settlement.

## Chay mot lenh

```bash
npm run demo:start
```

## Tao runtime sach

```bash
npm run demo:fresh
```

Lenh nay xoa Besu volume hien tai, tao lai runtime, deploy va mo UI.

## Kiem thu

```bash
npm test
npm run institutional:integration
```

## Tao evidence tach biet

```bash
npm run institutional:evidence
```

Evidence chinh thuc yeu cau working tree da duoc review va commit sach. Runner dung topology rieng gom 2 chain, moi chain 4 validator; kiem tra validator outage/recovery, timelock governance, cross-chain transfer, lending, attestor quorum va relayer restart. Bao cao duoc ghi tai `.runtime/evidence/` va khong thay doi runtime UI tren port `8545/9545`.

## Tat runtime

```bash
npm run besu:down
```

Xem them `PROJECT_MAP.md` va `docs/RUNTIME_OPERATIONS.md`.
