# kd-wgzh — Migrate host/vitest.config.ts off removed `test.poolOptions` (Vitest 4)

Date: 2026-07-01
Branch: `gascity/kd-1mr/kd-wgzh-migrate-vitest.config.ts-off-removed-test.pooloptions-fo`
File changed: `host/vitest.config.ts` (only)

## Problem
The dev shell now installs Vitest 4.1.9, which **removed `test.poolOptions`** (all former
pool options are top-level). `host/vitest.config.ts` still nested `maxForks` under
`test.poolOptions.forks`, so every `cd host && npx vitest run` printed:

```
 DEPRECATED  `test.poolOptions` was removed in Vitest 4. All previous `poolOptions` are now
 top-level options. Please, refer to the migration guide:
 https://vitest.dev/guide/migration#pool-rework
```

Tests still passed (non-blocking noise), but the option is deprecated and may stop working,
and the surrounding comment referenced `vitest 3.2.4` / a "future vitest version (3.2.5+)".

## Change
- `poolOptions.forks.maxForks: process.env.CI ? 1 : 4` → top-level
  `maxWorkers: process.env.CI ? 1 : 4`. `pool: "forks"` and `teardownTimeout` unchanged.
- Refreshed the stale version comments (dropped the `3.2.4` / `3.2.5+`-fix-pending wording;
  noted the observation predates and is retained after the Vitest 4 upgrade) and documented
  the `poolOptions`→`maxWorkers` mapping inline.

Diff: 1 file, +18/-17 (mostly comment rewrap; functional delta is the 5-line
`poolOptions{}` block → single `maxWorkers` line).

## Verification (durable artifacts in this dir)
Run with the pinned toolchain version: `vitest/4.1.9 darwin-arm64 node-v24.15.0`.

| Acceptance criterion | Result | Evidence |
|---|---|---|
| `host/vitest.config.ts` uses the Vitest 4 top-level pool config (no `test.poolOptions`) | MET | the diff; `git grep poolOptions` → only descriptive comment lines remain |
| `cd host && npx vitest run` emits no `poolOptions` deprecation warning | MET | `logs/before-poolOptions-warning.log` (warning present) vs `logs/after-local-no-warning.log` + `logs/after-ci-no-warning.log` (0 matches) |
| CI fork-serialization (`maxForks=1` under CI) preserved | MET | `resolved-config.txt`: CI=1 → `pool:"forks", maxWorkers:1`; CI unset → `pool:"forks", maxWorkers:4` |

Method for the "no warning" checks: `npx vitest run <non-matching-filter>` loads/resolves the
config (emitting any config-load deprecation) then exits on "No test files found" **before**
`globalSetup`, so it needs no wasm toolchain. `resolved-config.txt` was produced via Vitest's
own `createVitest()` API, printing the resolved `pool`/`maxWorkers` — a direct check that the
migrated top-level option reproduces the prior per-pool `maxForks` behavior in both CI states.

Outcome lists: `outcome-lists/{passed,failed,skipped}-checks.tsv` (8 passed, 0 failed, 1 skipped).

## Limitation (recorded, not masked)
The full `cd host && npx vitest run` suite was **not** run locally — see
`outcome-lists/skipped-checks.tsv`. This clean convoy-base checkout has no built wasm
sysroot/kernel/release artifacts, and `global-setup.ts` needs `wasm32posix-cc` + `wat2wasm`
(dev-shell only) plus a built musl sysroot; building them is out of scope for a config rename.
No test case exercises `poolOptions`/`maxWorkers` beyond config resolution (verified above),
and the PR's CI runs the full host suite in the canonical dev-shell environment.

## Scope check
`host/vitest.config.ts` was the sole tracked file using the removed `poolOptions`. The other
vitest configs (`sdk/vitest.config.ts`, `packages/registry/{libxml2,sqlite,zlib,openssl}/vitest.config.ts`)
never set `poolOptions`, so no sibling migration is needed.
