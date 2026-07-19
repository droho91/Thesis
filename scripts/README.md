# Script Map

Scripts are operational entrypoints and verification tooling. Cross-chain validity remains enforced by checkpoint, proof, gateway, identity, policy, custody, and lending contracts.

## Modules

| Module | Responsibility |
| --- | --- |
| `ops/besu/` | Generate, validate, start-check, inspect, and clean the 4-validator QBFT networks |
| `ops/deployment/` | Deploy the institutional stack and transfer administration to timelocks |
| `ui/` | Read on-chain state and expose the local institutional operations UI |
| `verification/` | Run UI checks, live integration, validator fault tests, and isolated evidence |

Long-running protocol actors are under `services/`:

```text
services/institutional-relay/       proof relay, journals, attestor quorum
services/run-checkpoint-attestor.mjs
services/run-institutional-relayer.mjs
```

## Public Commands

Use npm commands instead of invoking internal files directly:

```bash
npm run besu:up
npm run demo:prepare
npm run demo:ui
npm test
npm run institutional:evidence
```

`ops/besu/start.mjs` starts and proves one four-validator bank chain before starting the other, which avoids simultaneous genesis initialization across eight JVMs.

`ops/besu/health.mjs` has two internal modes:

- `--startup`: uses the extended startup timeout for isolated evidence checks.
- `--quick`: validates the existing topology and world state before deploy, governance, or integration commands.
