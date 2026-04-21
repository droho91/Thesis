# Cross-Chain Lending Demo

This repository contains the current Besu-first cross-chain lending prototype only. The active model uses two local permissioned EVM bank chains, a Besu light client, storage-proof packet verification, policy-controlled escrow/voucher transfer, and a lending pool that accepts the verified voucher as collateral.

## Install

```bash
npm install
```

If Hardhat cache/temp writes fail in WSL, run commands with explicit temp paths:

```bash
TMPDIR=/tmp XDG_CACHE_HOME=/tmp/.cache npm run compile
TMPDIR=/tmp XDG_CACHE_HOME=/tmp/.cache npm test
```

## Run Solidity Tests

```bash
npm run compile
npm test
```

`npm test` and `npm run test:solidity` both run the current Solidity test suite.

## Run The Besu Demo

Start two local Besu QBFT bank chains:

```bash
npm run besu:generate
npm run besu:up
```

Start the browser controller:

```bash
npm run demo:ui
```

Open:

```text
http://127.0.0.1:5173/
```

Use `Prepare / Reuse` or `Fresh Reset`, then run the flow step by step or use `Run Full Flow`.

## Run The Demo From Terminal

With Besu running:

```bash
npm run deploy
npm run seed
npm run demo
```

## Run Besu Verification Tests

With Besu running:

```bash
npm run test:besu
```

Individual verification lanes are also available:

```bash
npm run verify:light-client
npm run verify:storage-proof
npm run verify:packet-relay
npm run verify:policy-packet
npm run verify:timeout-height
npm run verify:timeout-timestamp
```

## Stop Besu

```bash
npm run besu:down
```

## Generated Local Files

The demo can generate local runtime files such as `.interchain-lending.local.json`, `demo/latest-run.json`, `demo/latest-run.js`, and verification reports. They are runtime outputs, not source files.
