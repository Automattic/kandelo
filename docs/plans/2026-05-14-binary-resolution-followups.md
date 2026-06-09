# Binary-resolution-via-index-ledger — follow-up work

Date: 2026-05-14
Branch context: `impl/binary-resolution-via-index-ledger`

Bugs and gaps surfaced by Phase 12.3 verification of the
binary-resolution-via-index-ledger PR. None are blockers for the
PR itself — they're pre-existing or tangential — but each deserves
its own fix once this PR merges.

## 1. opcache.so traps in forked FPM workers — fork doesn't replay parent dlopens

**Symptom.** After fixing the SAB/TextDecoder rejection in
`__wasm_dlopen`, PHP-FPM successfully loads `opcache.so` in the
master process. The crash moves to per-request startup in the
forked workers:

```
[process-worker] Kernel worker failed: table index is out of bounds
RuntimeError: table index is out of bounds
  php-fpm.zend_activate_modules @ wasm-function[22982]:0x730a9e
  php-fpm.php_request_startup    @ wasm-function[21669]:0x6ad61c
  php-fpm.main                   @ wasm-function[25414]:0x84fdc0
  php-fpm.libc_start_main_stage2 …
```

**Root cause.** Fork does not propagate dlopen state.

1. PHP-FPM master starts, dlopens `opcache.so` as a `zend_extension`.
   `host/src/dylink.ts` grows the master's `__indirect_function_table`
   from its module-initial size (10721) to ~10780+ and places
   opcache's 59 functions (plus its exports) into the new slots.
2. opcache's `__wasm_apply_data_relocs` patches its data section so
   that `accel_module_entry.request_startup_func` (offset 36 in
   the struct, data offset 7452 in opcache.so) holds the wasm
   value `__table_base + 34` — the index of `accel_activate` in
   the master's table (e.g. 10721 + 34 = 10755).
3. Master forks workers (`pm = static, pm.max_children = 2`).
   `handleFork` in
   `apps/browser-demos/lib/kernel-worker-entry.ts` (and the Node
   equivalent `host/src/node-kernel-worker-entry.ts`) memcpy's
   the master's linear memory into the child, but the child gets
   a *freshly instantiated* program module. Its
   `__indirect_function_table` is back at the module-initial
   length (10721); it carries no record of the parent's dlopens.
4. When a worker handles its first request, `php_request_startup`
   calls `zend_activate_modules`, which iterates
   `module_request_startup_handlers` (also memcpy'd from the
   master) and `call_indirect`s `accel_module_entry.request_startup_func`.
   The stored index 10755 is `>= child_table.length`, so the
   wasm engine traps with `table index is out of bounds`.

**Fix sketch.** Fork children must replay each parent-loaded side
module *before* asyncify-rewind, so the child's table layout
matches the parent's:

- Persist `linker.loadedLibraries` order + bytes in
  `processes[pid]` (or in a fork-init payload).
- Pass the list to `handleFork` and to the Node-side equivalent.
- In `centralizedWorkerMain`'s fork-child path, after instance
  creation but before calling `_start` / asyncify rewind, replay
  `dlopenSync(name, bytes)` for each library in order. The
  child's `sys_mmap` allocator state was memcpy'd from the
  master, so it returns the same base addresses; tableBase
  matches because both started at the same initial length.
- Add a vitest fixture that forks after a dlopen and exercises a
  call_indirect into the side-module — dual-host (Node + browser)
  per `feedback_dual-host-parity`.

Estimated scope: ~150 LOC across `host/src/dylink.ts`,
`host/src/worker-main.ts`, both kernel-worker-entry trees, and
the corresponding tests.

**Workaround in place** (commit `188bd0203` + this PR's
re-application to `build-wp-vfs-image.ts` /
`build-lamp-vfs-image.ts`): three demos comment out
`zend_extension=opcache.so` and force `opcache.enable=0`, so
PHP-FPM never dlopens opcache. nginx-php boots cleanly after
that workaround.

**WP / LAMP — opcache disable is necessary but NOT sufficient.**
Empirically the WordPress (LEMP-but-SQLite) and WordPress (LEMP)
demos still 502 even with `opcache.so` fully removed from the
VFS image. The wasm trap is identical (`call_indirect` at
`zend_activate_modules` PC `0x730a9e`, same stack), and both
demo workers come up with `table.length=10721 isForkChild=true`
— matching nginx-php's working workers. So the OOB index is
**not** opcache-related there; it's some other module in
`module_request_startup_handlers` whose `request_startup_func`
field holds an OOB value. nginx-php hits the same code path
with the same wasm binary and the same FPM master setup and
does not trap, so the WP/LAMP failure is environment-specific
— most likely related to `wp-config-init` executing dash+sed
before php-fpm, leaving heap/allocator state that influences
the FPM master's data placement, or to a fork-replay subtlety
that only manifests with the WP-specific pre-FPM service
chain. Investigation deferred: the WP/LAMP demos worked
historically (PR #423 landed opcache support; WP regression
likely either started there or earlier and was masked by the
rev2 archive predating opcache). For this PR, disabling
opcache is the minimal change matching nginx-php's shape; the
remaining 502 is a separate live regression to root-cause and
fix in its own PR.

**Why this surfaced now.** The published
`binaries-abi-v8/php-rev2` archive on the release predates
commit `38512c586 build(php): produce + ship opcache.so as third
package output`. Consumers fetching the indexed rev2 archive run
PHP-FPM without `opcache.so` at all, so the fork+dlopen mismatch
is never triggered. The
binary-resolution-via-index-ledger Phase 12.3 source-built PHP
from current source (cache_key mismatch with the indexed rev2
archive), and the source build includes the opcache work —
exposing this latent fork-vs-dlopen interaction.

**Re-enable after fix.** Revert the opcache-disable hunks in all
three vfs-image scripts after fork-replay-dlopen ships AND a
fresh rev=N PHP archive is republished via
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
