# kd-eo3w — host vitest fixture-dependent test verification

Proves that `scripts/prepare-vitest-fixtures.sh` produces fixtures that the
host vitest gate actually consumes (these tests `skipIf(...)` themselves when
the fixtures are absent, so before the bootstrap they silently skipped).

Command (in dev shell, after `bash scripts/prepare-vitest-fixtures.sh`):

```
cd host && npx vitest run test/getpwent.test.ts test/node-host-mounts.test.ts test/wasm64.test.ts
```

## Result — 3 files, 11 tests, all PASSED (0 skipped, 0 failed)

| Test file | fixture exercised | tests | outcome |
|---|---|---|---|
| test/wasm64.test.ts | local-binaries/programs/wasm64/hello64.wasm | 3 | passed (incl. "hello64: LP64 type sizes") |
| test/getpwent.test.ts | host/wasm/rootfs.vfs | 3 | passed (incl. "iterates all 7 /etc/passwd entries") |
| test/node-host-mounts.test.ts | host/wasm/rootfs.vfs | 5 | passed (incl. "read /etc/services from the mounted rootfs image") |

- passed: 11
- failed: 0
- skipped: 0

Vitest reported `Test Files 3 passed (3)` / `Tests 11 passed (11)`.

## Scope note

This verifies the fixture-dependent slice of the host vitest gate, which is
what this bead's fixtures feed. It does not claim the full `cd host && npx
vitest run` (all ~392 tests) was executed; that broader gate additionally
requires root `npm ci` and is outside this bead's fixture-bootstrap scope.

## Pre-existing, out-of-scope observation

Vitest is now v4.1.9; `host/vitest.config.ts` still uses `test.poolOptions`
(removed in Vitest 4), which prints a deprecation warning but does not fail the
run. Unrelated to fixture bootstrap; left for a separate change.
