# Demo Runtime Map

This file is a short orientation guide for the local demo/runtime surface. It exists so the demo stack reads like a layered system, not a pile of scripts.

## Canonical Besu-First Surface

Use these entrypoints for the thesis demo:

- `npm run demo:ui`
- `npm run deploy:ibc-lite`
- `npm run seed:ibc-lite`
- `npm run demo:flow`
- `npm run worker:source-commit`
- `npm run worker:client-update`
- `npm run worker:packet-proof`
- `npm run worker:misbehaviour`

These commands assume the canonical runtime story:

1. two local Besu QBFT bank chains,
2. finalized-header progression,
3. trusted remote client update,
4. EVM execution state root,
5. storage proof path as the primary packet-proof route.

## Script Layer Map

### Protocol/runtime helpers

- `scripts/ibc-lite-common.mjs`
  Shared config loading, providers/signers, runtime normalization, packet-path helpers, Besu key support.

- `scripts/ibc-lite-header-progression.mjs`
  Finalized-header lookup, header finalization, and trusted client update relay.

- `scripts/ibc-lite-relay-paths.mjs`
  Packet execution relay paths. In canonical Besu mode this uses storage proofs; the older Merkle path remains compatibility-only.

- `scripts/ibc-lite-safety.mjs`
  Misbehaviour submission and explicit recovery flow.

### Demo/controller helpers

- `scripts/ibc-lite-demo-read-model.mjs`
  Local health probes and assembled UI status snapshot.

- `scripts/ibc-lite-demo-actions.mjs`
  User-facing action orchestration for the browser controller.

- `scripts/ibc-lite-demo-service.mjs`
  Runtime command execution plus payload composition for deploy/seed/status/flow endpoints.

- `scripts/ibc-lite-demo-api.mjs`
  HTTP API routing for the browser UI.

- `scripts/ibc-lite-demo-static-server.mjs`
  Static asset serving for the `demo/` directory.

- `scripts/serve-demo-ui.mjs`
  Thin server shell that wires API requests and static assets together.

### Browser-side modules

- `demo/app.js`
  Fetch/orchestration layer for button clicks and API calls.

- `demo/demo-status-view.js`
  Pure render layer for roadmap, trust, replay, non-membership, and safety state.

## Internal Compatibility Harness

The older compatibility harness remains only for local contract/dev work and is intentionally outside the thesis demo narrative. The canonical commands above are the only public demo path. If you need the compatibility harness for debugging, inspect `package.json` directly rather than treating it as part of the normal operator flow.

## Reading Order

If you want to understand the demo from top to bottom, open files in this order:

1. `scripts/serve-demo-ui.mjs`
2. `scripts/ibc-lite-demo-api.mjs`
3. `scripts/ibc-lite-demo-service.mjs`
4. `scripts/ibc-lite-demo-actions.mjs`
5. `scripts/ibc-lite-demo-read-model.mjs`
6. `scripts/ibc-lite-header-progression.mjs`
7. `scripts/ibc-lite-relay-paths.mjs`
8. `scripts/ibc-lite-safety.mjs`

That order matches the way the browser demo enters the protocol logic.
