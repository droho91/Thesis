# Phase 5 Readiness

This note explains what "ready to delete the internal compatibility harness" means for this repository.

## The Threshold

Phase 5 should begin only when the canonical Besu-first path is strong enough that the internal harness is no longer needed to complete the thesis demo.

That means:

1. public commands stay Besu-first,
2. canonical relay/controller paths stay storage-first,
3. the public docs tell only one operator story,
4. the internal compatibility harness is no longer needed for normal demo operation,
5. contract and test coverage have moved off the old Merkle packet path.

## Command

Use:

```bash
npm run report:phase5-readiness
```

The report is intentionally honest. It is allowed to say `NOT READY`.

## Why A Report Exists

The repository has gone through a long transition:

- old bridge-like packet-state Merkle path
- Besu-first runtime surface
- storage-proof-first canonical packet path
- internal compatibility harness pushed below the public demo surface

Without an explicit readiness report, it becomes too easy to confuse:

- "cleaner public narrative"
with
- "actually safe to delete the old path"

The report is therefore a guardrail. It tells us whether the repository has merely isolated the old path or whether it is truly ready to remove it.
