# kd-n6vr — perl-vfs image build VFS parent-dir write error

**Disposition:** FIXED — root cause is a **product bug** in the VFS image
builder, not a perl-src-state artifact. `apps/browser-demos/public/perl.vfs.zst`
is now produced from the exact input that previously crashed.

## Summary

`images/vfs/scripts/build-perl-vfs-image.ts` allocated a **fixed, non-growable
16 MiB** `SharedArrayBuffer` for the in-memory VFS. The Perl 5.40.3 stdlib
payload it writes is **~25.68 MiB across 1288 files** (plus 238 directories),
so the memfs ran **out of space mid-write**. The out-of-space error (`ENOSPC`)
raised by `mkdir` inside the parent-dir loop was **silently swallowed** by
`ensureDir`, so the directory was never created, and the failure resurfaced far
away as a confusing `SFSError: No such file or directory` (`ENOENT`, code -2) at
`SharedFS.pathResolveParent` when the next file write could not resolve its
missing parent. That masked error is exactly what kd-gtxa observed.

## Root cause (two defects, one symptom)

1. **Undersized buffer (`build-perl-vfs-image.ts`).** 16 MiB cannot hold a
   ~26 MiB payload. Sibling builders that handle large payloads
   (`build-mariadb-vfs-image.ts`, `build-redis-vfs-image.ts`,
   `build-sqlite-test-vfs-image.ts`) already use a **growable** SAB
   (`new SharedArrayBuffer(N, { maxByteLength: M })` + `create(sab, M)`);
   perl/erlang/python used the fragile fixed pattern.
2. **Error masking (`host/src/vfs/image-helpers.ts:ensureDir`).**
   `try { fs.mkdir(path); } catch { /* exists */ }` swallowed **every** error,
   not just `EEXIST`. This converted a precise `ENOSPC` at the real failing
   `mkdir` into a misleading `ENOENT` at an unrelated later write — violating
   CLAUDE.md's "prefer truthful failure over convenient illusion." The identical
   pattern in the neighbouring `symlink` helper was fixed for consistency.

### Ruled out: perl-src-state artifact / name collision

Static analysis of the merged `PRIVLIB` namespace (all files scanned from
`lib`, `cpan/*/lib`, `dist/*/lib`, `ext/*/lib`, applying the script's exact
include/exclude rules) reproduced **exactly 1288 included paths** (matching the
build log) and found **zero** file/dir name collisions (no path is both a file
and a directory needed by another file). The failure is a capacity overflow,
not a layout conflict. `pathResolveParent` threw code **-2 (ENOENT)** from the
parent-path resolve (line 1141), not **-20 (ENOTDIR)** — consistent with a
parent directory that was never created (masked `mkdir`), not a file-in-the-way.

## The fix

- `images/vfs/scripts/build-perl-vfs-image.ts`: allocate a growable
  `SharedArrayBuffer(64 MiB, { maxByteLength: 256 MiB })` +
  `MemoryFileSystem.create(sab, 256 MiB)`. 64 MiB comfortably holds the current
  ~26 MiB payload without needing to grow; the 256 MiB ceiling is headroom for
  future stdlib growth. The empty tail compresses away in `saveImage`'s zstd
  pass (64 MiB raw → 3.4 MiB on disk).
- `host/src/vfs/image-helpers.ts`: `ensureDir` and `symlink` now swallow **only
  `EEXIST`** and rethrow every other error, so a future overflow (or any real
  failure) is reported loudly at its true origin.
- `host/test/vfs-image.test.ts`: 4 regression tests pinning the honest-failure
  contract (see Verification).

## Verification (reproducible in this worktree)

Environment: `bash scripts/dev-shell.sh` (LLVM 21.1.7, Node 24). perl-src staged
into `packages/registry/perl/perl-src` (the same tree that produced the crash,
sourced from the kd-gtxa worktree). Sysroot built via `scripts/build-musl.sh`.

1. **Original crash reproduced in-worktree** (all changes stashed → original
   code): `bash images/vfs/scripts/build-perl-vfs-image.sh` →
   `SFSError: No such file or directory at SharedFS.pathResolveParent
   (...sharedfs-vendor.ts:1141), code: -2` while "Writing 1288 files to VFS" —
   byte-for-byte the kd-gtxa failure.
2. **Fix produces the image:** with the fix, the same build wrote all 1288
   files and produced `apps/browser-demos/public/perl.vfs.zst`
   (`VFS image: 64.0 MB raw → 3.4 MB zstd (5.3%)`). Build log:
   `test-runs/kd-n6vr/perl-vfs-build-fixed.log`.
3. **Regression tests (host vitest):** all 4 new tests pass —
   - `ensureDir swallows EEXIST so repeated creation is idempotent`
   - `ensureDir rethrows a missing-parent failure instead of masking it` (ENOENT)
   - `surfaces an out-of-space overflow as ENOSPC, not a masked parent-dir ENOENT`
   - `symlink swallows EEXIST but rethrows a missing-parent failure` (ENOENT)
4. **Full host vitest gate — no regressions.** `cd host && npx vitest run`:
   - With fix: **586 passed / 29 failed / 204 skipped** (819 tests, 16 files failed).
   - Clean baseline (changes stashed): **582 passed / 29 failed / 201 skipped**.
   - Delta = **+4 passed** (my new tests), **0 new failures**. The 29 failures
     are an **identical** pre-existing set (kernel/spawn/pthread/wasm/wasi/
     networking suites that require a built `kernel.wasm`, fork-instrumented and
     wasm64 example binaries — artifacts not present in this convoy-base
     worktree). They are unrelated to this change; none touch VFS image helpers.

### Outcome lists
- `test-runs/kd-n6vr/outcome-lists/passed-tests.tsv` (586)
- `test-runs/kd-n6vr/outcome-lists/failed-tests.tsv` (29 — all pre-existing)
- `test-runs/kd-n6vr/outcome-lists/skipped-tests.tsv` (204 —
  `reason:unavailable(vitest-json-omits-skip-reason;explicit-skip-or-env-gated)`;
  vitest's JSON reporter does not emit per-skip reasons)

## Limitations / follow-ups

- **Browser runtime not exercised here.** This fixes *building* `perl.vfs.zst`;
  booting perl from it in the browser is the separate kd-yuef/kd-gtxa scope and
  still gated on the trusted-CI GHCR bottle publish (an @brandon action). No
  browser smoke was run for this bead.
- **Sibling builders share the fixed-buffer fragility.** `erlang` (16 MiB) and
  `python` (32 MiB) VFS builders still use non-growable buffers. With the now-
  honest `ensureDir`, a future overflow there will fail *loudly* as `ENOSPC`
  rather than a masked `ENOENT` — an improvement, but they should adopt the
  growable pattern proactively. Candidate follow-up (not filed unilaterally).
- **`memory-fs.ts` has the same swallow-all `mkdir` pattern** in its lazy-file
  and zip-extract loops (lines ~478, ~565). Out of scope for kd-n6vr; noted for
  a future honesty sweep.
