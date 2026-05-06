# Prompt: fix broken benchmark suites so the gating CI workflow can ship

## Context

`.github/workflows/benchmarks.yml` (introduced on branch
`ci-workflow-for-performance-benchmarks-on-prs`) is a per-PR gating
workflow that runs all 8 benchmark suites × Node + browser hosts twice
on the same runner (PR base, then PR head) and fails if any metric
regresses by more than 5% or any expected suite returns zero metrics.

The workflow currently cannot pass because **6 of 8 suites silently
skip on a clean checkout** — they look for legacy "build from source"
install layouts (`examples/libs/<name>/<name>-install/...`) that the
package-management system (#365 / #370 / #378) replaced with
content-addressed `.wasm` + `.vfs` archives published in the
`binaries-abi-v<N>` release and pinned by `binaries.lock`.

Your job is to update the suites + browser benchmark page so that all
8 suites produce metrics on both Node and browser hosts after only:

```
bash scripts/fetch-binaries.sh   # pulls binaries.lock-pinned archives
bash scripts/build-programs.sh   # builds benchmarks/wasm/*.wasm
# kernel.wasm built via cargo
```

No `bash examples/libs/<name>/build-<name>.sh` may be required.

## Working / broken inventory

Run `npx tsx benchmarks/run.ts --rounds=1` and
`npx tsx benchmarks/run.ts --host=browser --rounds=1` from a clean
checkout (after `fetch-binaries.sh` + kernel/programs build). You will
see:

| Suite | Node | Browser | Why broken |
|-------|------|---------|------------|
| `syscall-io` | ✅ | ✅ | — |
| `process-lifecycle` | ✅ | ✅ | — |
| `erlang-ring` | ❌ skip | ❌ skip | Expects `examples/libs/erlang/erlang-install/releases/28/start_clean.boot` (legacy install dir) |
| `wordpress` | ❌ skip | ❌ skip | Node expects `examples/libs/php/php-src/sapi/cli/php`; browser expects `examples/nginx/nginx.wasm` |
| `mariadb-aria` | ❌ skip | ❌ skip | Expects `examples/libs/mariadb/mariadb-install/bin/mariadbd` + `share/mysql/*.sql` |
| `mariadb-aria-64` | ❌ skip | ❌ skip | Same, `mariadb-install-64/` |
| `mariadb-innodb` | ❌ skip | ❌ skip | Same |
| `mariadb-innodb-64` | ❌ skip | ❌ skip | Same |

Secondary issue (not blocking but worth fixing while you're here): the
browser dev server's dep-scan pre-bundle fails with `@binaries:
programs/wasm32/mariadb-test.vfs not found` because
`examples/browser/pages/mariadb-test/index.html` statically imports a
binary that isn't part of the durable release. The benchmark page
itself runs anyway, but the noisy startup error shouldn't be there.

## What landed in package management (read these)

- `binaries.lock` pins a release tag + manifest sha; `binaries/` is a
  symlink tree into `~/.cache/wasm-posix-kernel/{libs,programs}/...`
  populated by `scripts/fetch-binaries.sh`.
- The cached layout that matters here:
  - `binaries/programs/wasm32/erlang.wasm`        — BEAM VM
  - `binaries/programs/wasm32/erlang-vfs.vfs`     — OTP runtime tree (16MB)
  - `binaries/programs/wasm32/php/php.wasm`       — PHP CLI
  - `binaries/programs/wasm32/php/php-fpm.wasm`   — PHP-FPM
  - `binaries/programs/wasm32/wordpress.vfs`      — WordPress files (134MB)
  - `binaries/programs/wasm32/mariadb/mariadbd.wasm`
  - `binaries/programs/wasm32/mariadb/mysqltest.wasm`
  - `binaries/programs/wasm32/mariadb-vfs.vfs`    — MariaDB share/ + system-table SQL
  - `binaries/programs/wasm64/mariadb/mariadbd.wasm`, `wasm64/mariadb-vfs.vfs`, etc.
- Resolver: `host/src/binary-resolver.ts` exports `tryResolveBinary`,
  which prefers `local-binaries/` (developer-built override) over
  `binaries/` (cached). Suites should call this rather than hardcoding
  paths.
- VFS mounting reference: see `examples/browser/pages/erlang/main.ts`
  ~line 290:
  ```ts
  const memfs = MemoryFileSystem.fromImage(
    decompressVfsImage(new Uint8Array(vfsImageBuf!)),
    { maxByteLength: 256 * 1024 * 1024 },
  );
  const kernel = new BrowserKernel({ memfs, ... });
  ```
  For the Node host, the equivalent flow lives in
  `host/src/node-kernel-host.ts` — `NodeKernelHost` accepts a `memfs`
  option in the same way (verify by reading the constructor and a
  consuming test like `host/test/erlang.test.ts` if it exists).

## Files to edit

**Node suites** (all in `benchmarks/suites/`):
- `erlang-ring.ts` — drop the `examples/libs/erlang/erlang-install/...`
  existence check; load `erlang-vfs.vfs` via `tryResolveBinary` and
  pass to `NodeKernelHost` as `memfs`. The BEAM args should resolve
  `-root`, `-bindir`, `-boot`, library paths against the VFS layout
  (`/usr/local/lib/erlang/...` per the browser demo's `OTP_ROOT`).
- `wordpress.ts` — replace `phpBinaryPath` (host-fs path) with
  `tryResolveBinary("programs/wasm32/php/php.wasm")`. Replace `wpDir`
  on host-fs with the WP tree mounted from `wordpress.vfs`. The
  `runCentralizedProgram(...)` helper in `host/test/centralized-test-helper.ts`
  may need a `memfs` option; if not, switch to `NodeKernelHost.spawn`
  directly (already used by the http_first_response measurement).
- `mariadb.ts` — replace `installDirFor()` (returns
  `examples/libs/mariadb/mariadb-install`) with paths into
  `binaries/programs/<arch>/mariadb/`. The bootstrap step reads
  `share/mysql/mysql_system_tables*.sql` — those live inside
  `mariadb-vfs.vfs`, so either (a) read them out of the VFS image
  directly using `MemoryFileSystem.fromImage` then `readFile`, or
  (b) include them as resolved-from-cache SQL strings. Option (a) is
  closer to how the live server uses the VFS.

**Browser benchmark page** (`examples/browser/pages/benchmark/main.ts`):
- Replace the `OPTIONAL_URLS` block's legacy-path globs with the cached
  paths (`@binaries/programs/wasm32/{php/php.wasm,php/php-fpm.wasm,
  mariadb/mariadbd.wasm,mariadb/mysqltest.wasm,mariadb-vfs.vfs}` and
  the wasm64 variants). The wordpress browser suite uses nginx +
  PHP-FPM — if nginx isn't in the cache yet, scope it to PHP-only or
  match the Node suite's "PHP built-in server" approach so the metric
  is comparable across hosts.
- Mount `wordpress.vfs` into the kernel for the wordpress suite (same
  pattern as the erlang demo).
- Remove or fix the static `programs/wasm32/mariadb-test.vfs` import in
  `examples/browser/pages/mariadb-test/index.html` (or its main.ts) so
  the dev-server pre-bundle scan stops erroring.

## Definition of done

After your changes, on a fresh worktree (`git worktree add` to a sibling
dir), with no local builds beyond the standard prereqs:

```bash
# Prereqs
bash scripts/build-musl.sh
bash scripts/build-musl.sh --arch wasm64posix
bash scripts/build-libcxx.sh                 # only if any suite needs it
bash scripts/build-libcxx.sh --arch wasm64
cargo build --release -p wasm-posix-kernel \
  -Z build-std=core,alloc -Z build-std-features=panic_immediate_abort
mkdir -p local-binaries
cp target/wasm64-unknown-unknown/release/wasm_posix_kernel.wasm local-binaries/kernel.wasm
bash scripts/build-programs.sh
bash scripts/fetch-binaries.sh
cd host && npm install && cd ..
cd examples/browser && npm install && npx playwright install chromium && cd ../..

# Acceptance test
npx tsx benchmarks/run.ts --rounds=1                   # Node
npx tsx benchmarks/run.ts --host=browser --rounds=1    # browser
```

Both invocations must:
- Print non-empty metric lines under each of the 8 suites
  (`syscall-io`, `process-lifecycle`, `erlang-ring`, `wordpress`,
  `mariadb-aria`, `mariadb-aria-64`, `mariadb-innodb`,
  `mariadb-innodb-64`).
- Exit 0.
- Produce a `benchmark-{node,browser}-*.json` whose `suites` map has
  at least one numeric metric per expected suite.

You can verify the gate side too:

```bash
# After running both rounds above, copy any produced JSON to two slots
# and run gate.ts against itself — should PASS with all-zero deltas:
npx tsx benchmarks/gate.ts \
  --before benchmarks/results/benchmark-node-<X>.json \
  --after  benchmarks/results/benchmark-node-<X>.json \
  --expected syscall-io,process-lifecycle,erlang-ring,wordpress,mariadb-aria,mariadb-aria-64,mariadb-innodb,mariadb-innodb-64 \
  --threshold 5
```

## Working environment

- Spin up a dedicated worktree:
  `git worktree add .superset/worktrees/wasm-posix-kernel/fix-broken-benchmarks origin/main`
  (or use the superpowers using-git-worktrees skill).
- Branch off main, not the `ci-workflow-for-performance-benchmarks-on-prs`
  branch — your work blocks that workflow's first green run, but the
  fix should land first.
- Standard test verification (CLAUDE.md): cargo + vitest + libc-test +
  POSIX + sortix + ABI snapshot must remain green. Benchmark fixes
  shouldn't touch those, but verify before opening a PR.

## Out of scope

- Don't add new metrics or change suite semantics — only re-source
  binaries/data from the cache.
- Don't change `compare.ts` or `gate.ts`.
- Don't touch `.github/workflows/benchmarks.yml`. It's already correct
  for the post-fix world; once your PR merges, the next push to the
  benchmarks branch will run green.
