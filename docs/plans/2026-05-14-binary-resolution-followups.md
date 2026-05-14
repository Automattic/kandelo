# Binary-resolution-via-index-ledger — follow-up work

Date: 2026-05-14
Branch context: `impl/binary-resolution-via-index-ledger`

Bugs and gaps surfaced by Phase 12.3 verification of the
binary-resolution-via-index-ledger PR. None are blockers for the
PR itself — they're pre-existing or tangential — but each deserves
its own fix once this PR merges.

## 1. opcache.so per-request startup traps in `zend_activate_modules`

**Symptom.** After fixing the SAB/TextDecoder rejection in
`__wasm_dlopen`, PHP-FPM successfully loads `opcache.so` via dlopen.
The crash moves to per-request startup:

```
[process-worker] Centralized worker failed: index out of bounds
  php-fpm.zend_activate_modules @ wasm-function[22982]:0x730a9e
  php-fpm.php_request_startup    @ wasm-function[21669]:0x6ad61c
  php-fpm.main                   @ wasm-function[25414]:0x84fdc0
  php-fpm.libc_start_main_stage2 ...
```

`zend_activate_modules` calls each loaded module's
`request_startup_func`. opcache's per-request init reads from a
wasm address that's out of bounds — a `wasm-trap: index out of
bounds` from linear-memory access beyond the current high water
mark.

**Suspect.** The dylink loader's data-segment placement for
`opcache.so`. Suspect candidates:

- `allocateMemory` in `host/src/worker-main.ts::buildDlopenImports`
  calls `sys_mmap` to reserve a region for the side module's
  data + GOT. If the returned address overshoots the wasm
  memory's current page count, accesses trap. The host doesn't
  grow the wasm memory to cover the new allocation.
- `DynamicLinker.dlopenSync` (host/src/dylink.ts) might compute
  the side module's memory base relative to a stale `memory.size`.
- opcache itself might write into shared-memory globals that the
  wasm port doesn't initialise — opcache's `accel_globals` /
  `ZCG()` macro chain.

**Workaround in place** (commit `188bd0203`): the nginx-php demo's
INI comments out `zend_extension=opcache.so` and forces
`opcache.enable=0`, so PHP-FPM never dlopens opcache and never
reaches the crashing code path. The demo boots cleanly without
opcache.

**Why this surfaced now.** The published `binaries-abi-v8/php-rev2`
archive on the release predates commit `38512c586 build(php):
produce + ship opcache.so as third package output`. Consumers
fetching the indexed rev2 archive run PHP-FPM without opcache.so
at all, so neither the `__wasm_dlopen` TextDecoder bug nor this
per-request trap fire. The binary-resolution-via-index-ledger
Phase 12.3 source-built PHP from current source (cache_key
mismatch with the indexed rev2 archive), and the source build
includes the opcache work — exposing both latent bugs.

**Re-enable after fix.** Revert commit `188bd0203` once the trap
is resolved AND a fresh rev=N PHP archive is republished via
`scripts/index-update.sh` so the indexed flow also exercises the
fixed dlopen path.

## 2. nethack shell demo broken

**Symptom.** The nethack shell command does not work in the
`/pages/shell/` demo as of this branch's Phase 12.3 verification.
Boot reaches the shell prompt; `nethack` invocation fails (mode
TBD — not investigated).

**Suspect.** Could be:

- Stale `binaries/programs/wasm32/nethack/` symlink targeting a
  rev that doesn't match the runtime data files (nethack's
  runtime archive bundling — see memory note
  [binary-runtime-bundling-pattern](../../memory/binary-runtime-bundling-pattern.md)).
- The nethack package's revision in `build.toml` mismatches the
  archive on the release (similar to PHP's recipe drift).
- An unrelated nethack runtime issue.

**Status.** Not blocking Phase 12.3 — flagged for separate
investigation. Run `./run.sh browser` → `/pages/shell/` → type
`nethack` to reproduce. Compare against `origin/main` to see
whether the failure is pre-existing or branch-specific.

## Notes

Both issues were noticed during Phase 12.3 of the
binary-resolution-via-index-ledger PR but are unrelated to that
work's scope. Tracking here so they don't drift past the PR
merge.
