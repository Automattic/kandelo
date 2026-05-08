# libcxx as a published package, with bundled libunwind — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate `scripts/build-libcxx.sh` into the package-management
system as `examples/libs/libcxx/`, and bundle LLVM libunwind into the
resulting `libc++abi.a` so C++ programs that throw exceptions actually
propagate them at runtime (today they hang on `_Unwind_RaiseException`,
which is unresolved).

**Architecture:**
- libcxx becomes the 8th cached binary lib in `binaries-abi-v<N>`.
  Its build script honors the standard package-management contract
  (`WASM_POSIX_DEP_*` env vars, declared `outputs`, `arches`).
- LLVM libunwind is built and linked into `libc++abi.a` via the
  `LIBCXXABI_USE_LLVM_UNWINDER=ON` CMake flag plus
  `libunwind` added to `LLVM_ENABLE_RUNTIMES` and the sparse-checkout.
- A new `programs/cpp_throw_test.cpp` and matching vitest case
  exercise the unwind path on every CI run, regression-gating the
  fix.

**Tech Stack:** Bash build scripts, CMake (LLVM runtimes), Rust
(`cargo xtask build-deps`), TOML manifest, vitest.

**Branch:** `libcxx-pkg-libunwind` (new), based on
`origin/package-management` (`75cff1eb5`).

**Worktree:**
`/Users/brandon/.superset/worktrees/wasm-posix-kernel/libcxx-pkg-libunwind`

---

## Background — what's being changed and why

Today `scripts/build-libcxx.sh` builds libc++.a + libc++abi.a and
installs to `sysroot/lib/`. It's invoked imperatively only by
`examples/libs/mariadb/build-mariadb.sh`. It sits outside the
package-management resolver, so:

- libcxx's outputs aren't cached or published.
- Consumers can't declare `depends_on = ["libcxx@<ver>"]`.
- Sysroot ends up with libc++.a + libc++abi.a but **no libunwind**
  because `LIBCXXABI_USE_LLVM_UNWINDER=OFF` and there's no separate
  libunwind build step. Any C++ program that throws hits an
  unresolved `_Unwind_RaiseException` import and hangs at runtime.

The 2026-04-28 SpiderMonkey EH spike (memory:
`spidermonkey-spike-eh-toolchain-gap.md`) discovered the gap by
running 4 C++ test programs through the kernel: 3 of 4 hung on the
throw. SpiderMonkey, when ported, throws C++ exceptions
constantly through deep call stacks, so this gap blocks the entire
SpiderMonkey effort.

This plan closes both issues in one PR by migrating libcxx into
the package system and bundling libunwind in the same step. After
merge, the SpiderMonkey worktree rebases onto package-management
and continues the spike.

---

## What's NOT in scope

- Migrating libcxx **headers** into `examples/libs/libcxx/include/`
  source-tree. Headers continue to come from Homebrew LLVM at build
  time (the libcxx build copies them from `$LLVM_PREFIX/include/c++/v1`
  into `WASM_POSIX_DEP_OUT_DIR/include/c++/v1`). Sourcing headers
  from upstream tarball is a future cleanup.
- Switching the SDK away from `-mllvm -wasm-use-legacy-eh=true`. That's
  the wasm-EH path (Option B in the brainstorming) and is a separate
  decision tracked in the SpiderMonkey design doc.
- Touching kernel ABI. This is a userspace-toolchain change only.
  ABI snapshot must verify `0` drift; if it doesn't, the change is
  scoped wrong.

---

## Acceptance criteria

Before opening the PR all of the following must be green:

1. `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib`
   — kernel unit tests, 539+ pass.
2. `cd host && npx vitest run` — host integration tests, including
   the new `cpp-throw-test` case (test (b) and (c) of the spike, in
   smaller form).
3. `scripts/run-libc-tests.sh` — 0 unexpected `FAIL`s.
4. `scripts/run-posix-tests.sh` — 0 `FAIL`s.
5. `bash scripts/check-abi-version.sh` — exit 0; no ABI drift.
6. `cargo xtask build-deps resolve libcxx` builds from source on
   first call, returns same path on second call (cache hit).
7. Sortix tests not regressed (`scripts/run-sortix-tests.sh --all` —
   memory says 4827 PASS / 0 FAIL is current baseline; after this
   change must be ≥ 4827 PASS / 0 FAIL).
8. `bash examples/libs/mariadb/build-mariadb.sh` succeeds end-to-end
   (it's the existing libcxx consumer; verifies the migration didn't
   break it).
9. The new `programs/cpp_throw_test.wasm` runs through the kernel
   and prints the expected throw → catch sequence (no hang).

---

## Task 0: Confirm baseline is clean before changing anything

Run the test suites against unmodified `package-management` HEAD so we
know any later regression is ours, not pre-existing.

**Files touched:** none.

**Step 1: Build kernel + sysroot**

Run:
```
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/libcxx-pkg-libunwind
bash build.sh
```
Expected: completes cleanly, `local-binaries/kernel.wasm` written,
host TypeScript built.

**Step 2: Build user programs**

Run:
```
bash scripts/build-programs.sh
```
Expected: programs built into `host/wasm/`, `examples/`,
`benchmarks/wasm/`. Existing fork-instrumented programs OK.

**Step 3: Run cargo tests**

Run:
```
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib 2>&1 | tail -10
```
Expected: `test result: ok. NNN passed; 0 failed`.

**Step 4: Run vitest**

Run:
```
cd host && npx vitest run 2>&1 | tail -20
```
Expected: all tests pass (PHP tests skip if PHP wasm absent — that's fine).

**Step 5: Run libc-test + POSIX**

Run:
```
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/libcxx-pkg-libunwind
scripts/run-libc-tests.sh 2>&1 | tail -5
scripts/run-posix-tests.sh 2>&1 | tail -5
```
Expected: 0 unexpected FAILs in libc-test; 0 FAIL in POSIX.

**Step 6: ABI snapshot**

Run:
```
bash scripts/check-abi-version.sh
```
Expected: exits 0.

**Step 7: Capture baseline numbers**

Save the test counts from steps 3–6 as `BASELINE.txt` in worktree
root for comparison after the change. **Do not commit it** — it's a
workspace note, not a deliverable.

---

## Task 1: Add the C++ throw-and-catch regression test (TDD: failing first)

Write the test before any libcxx changes so we observe the failure
mode and prove the fix works against a concrete signal.

**Files:**
- Create: `programs/cpp_throw_test.cpp`
- Create: `host/test/cpp-throw-test.test.ts`

**Step 1: Write the test program**

Create `programs/cpp_throw_test.cpp`:

```cpp
// Regression test for C++ exception unwinding under the wasm-posix-kernel.
// Runs three sub-tests:
//   1. throw int caught by typed catch
//   2. throw int caught by catch-all
//   3. throw across one frame of stack
// Each sub-test prints PASS or FAIL; the program returns 0 only if all
// three print PASS.

#include <cstdio>
#include <cstdlib>

static void thrower(int x) { throw x; }

int main() {
    int passes = 0;

    try { throw 42; } catch (int e) {
        if (e == 42) { printf("PASS: typed catch\n"); ++passes; }
        else         { printf("FAIL: typed catch wrong value %d\n", e); }
    }

    try { throw 7; } catch (...) {
        printf("PASS: catch-all\n"); ++passes;
    }

    try { thrower(99); } catch (int e) {
        if (e == 99) { printf("PASS: cross-frame\n"); ++passes; }
        else         { printf("FAIL: cross-frame wrong value %d\n", e); }
    }

    fflush(stdout);
    return (passes == 3) ? 0 : 1;
}
```

**Step 2: Wire the build**

`scripts/build-programs.sh` currently iterates `programs/*.c` only.
Inspect:
```
grep -n 'programs/' scripts/build-programs.sh | head -10
```

If C++ files aren't picked up, extend the loop. Look for the `.c` glob
and add a parallel `.cpp` block that uses `wasm32posix-c++` plus
`-lc++ -lc++abi`. Build flags should mirror the `.c` block exactly
(same `-O2 -matomics -mbulk-memory`, same fork-instrument step at
the end).

(Implementer: read the script first; the structure may already have
a hook. Don't restructure beyond what's needed.)

**Step 3: Confirm the test program builds, but FAILS at runtime**

Run:
```
bash scripts/build-programs.sh 2>&1 | grep -i 'cpp_throw'
```
Expected: `Compiling cpp_throw_test...` line appears, no errors.

Run:
```
TIMEOUT=10000 npx tsx examples/run-example.ts host/wasm/cpp_throw_test.wasm 2>&1 | tail -10
```
Expected: **HANG** with timeout error after ~10s. This proves the
unwind path is broken before the fix lands. (Document the observed
output in the commit message.)

**Step 4: Write the vitest case**

Create `host/test/cpp-throw-test.test.ts` modeled on the existing
single-program test pattern (find one to copy from with
`ls host/test/ | grep -E 'fork|exec|hello'` and pick the closest
fit). The test should:

1. Spawn `host/wasm/cpp_throw_test.wasm` via the centralized test
   helper.
2. Assert exit code 0.
3. Assert stdout contains `PASS: typed catch`, `PASS: catch-all`,
   `PASS: cross-frame`.
4. Have a 15s test-level timeout so it fails-as-test rather than
   hanging the suite.

Example skeleton (adapt to the helper API actually used by sibling
tests):

```typescript
import { describe, it, expect } from 'vitest';
import { runWasmProgram } from './centralized-test-helper';

describe('cpp_throw_test', () => {
    it('propagates and catches C++ exceptions', async () => {
        const result = await runWasmProgram('host/wasm/cpp_throw_test.wasm', {
            timeoutMs: 15_000,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('PASS: typed catch');
        expect(result.stdout).toContain('PASS: catch-all');
        expect(result.stdout).toContain('PASS: cross-frame');
    }, 20_000);
});
```

**Step 5: Run the new test, watch it fail**

Run:
```
cd host && npx vitest run cpp-throw-test 2>&1 | tail -20
```
Expected: vitest reports `1 failed` due to either timeout or
non-zero exit. **This is the desired pre-fix state.**

**Step 6: Commit the failing test**

```
git add programs/cpp_throw_test.cpp host/test/cpp-throw-test.test.ts \
        scripts/build-programs.sh
git commit -m "test(cpp): add cpp_throw_test as failing regression gate

Currently hangs because libunwind is missing from the sysroot. Will
pass once libcxxabi bundles libunwind via LIBCXXABI_USE_LLVM_UNWINDER=ON
in the next commit.

Refs spike: memory/spidermonkey-spike-eh-toolchain-gap.md
"
```

---

## Task 2: Migrate scripts/build-libcxx.sh into examples/libs/libcxx/

Move the existing build script into the package-management layout,
adapt it to the resolver contract. Library content unchanged this
task — only location, manifest, and env-var contract.

**Files:**
- Create: `examples/libs/libcxx/deps.toml`
- Create: `examples/libs/libcxx/build-libcxx.sh` (moved from
  `scripts/build-libcxx.sh`, adapted)
- Create: `examples/libs/libcxx/package.json` (matches sibling lib
  pattern — minimal `{"name":"...","scripts":{"build-libcxx":"..."}}`)
- Delete: `scripts/build-libcxx.sh`
- Modify: `examples/libs/mariadb/build-mariadb.sh:184-189` (replace
  direct call with `cargo xtask build-deps resolve libcxx` pattern)

**Step 1: Read and copy the existing script**

```
cp scripts/build-libcxx.sh examples/libs/libcxx/build-libcxx.sh
```
Then adapt the new copy:

- Add the standard 4-line resolver header at the top:
  ```bash
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
  source "$REPO_ROOT/sdk/activate.sh"
  ```

- Replace `SYSROOT="$REPO_ROOT/sysroot"` (or `sysroot64/`) with
  reading `WASM_POSIX_DEP_OUT_DIR`. The build still consumes a
  sysroot for sysroot-dependent steps (musl headers, libc.a) — that
  comes from `WASM_POSIX_SYSROOT` (set by the resolver) which
  remains the in-tree `sysroot/`. The new bit is that
  `libc++.a`/`libc++abi.a` install into `$WASM_POSIX_DEP_OUT_DIR/lib/`
  rather than `$SYSROOT/lib/`. Headers go into
  `$WASM_POSIX_DEP_OUT_DIR/include/c++/v1/`.

- Drop the "skip if already built" block at the top — the resolver
  cache handles that, and the script must always do a full clean
  build when invoked.

- After `cmake` + `make`, the install step now copies the build
  output into `WASM_POSIX_DEP_OUT_DIR` instead of the sysroot.
  Layout to produce:
  ```
  $WASM_POSIX_DEP_OUT_DIR/
    lib/libc++.a
    lib/libc++abi.a
    include/c++/v1/__config_site
    include/c++/v1/...           ← copied from $LLVM_PREFIX/include/c++/v1
  ```

- Look at how openssl's `build-openssl.sh` handles the
  `WASM_POSIX_DEP_OUT_DIR=…install` pattern. Copy that shape.

**Step 2: Write the manifest**

Create `examples/libs/libcxx/deps.toml`:

```toml
# Per-library manifest for libc++ and libc++abi (with bundled
# LLVM libunwind). See docs/package-management.md.
#
# This package replaces the in-tree scripts/build-libcxx.sh.
# It builds libc++.a, libc++abi.a (with libunwind statically linked
# in via LIBCXXABI_USE_LLVM_UNWINDER=ON), and installs the libc++
# v1 headers from the host LLVM toolchain.

kind = "library"

name = "libcxx"
# LLVM major version. The build script clones release/<MAJOR>.x
# and compiles libcxx + libcxxabi + libunwind from that branch.
version = "21"
revision = 1
depends_on = []
# Both wasm32 (everyone) and wasm64 (MariaDB, PHP) currently
# need libcxx, so we opt into both.
arches = ["wasm32", "wasm64"]

# Source: the upstream LLVM project. The build script clones
# sparse against release/${VERSION}.x; we don't pin a tarball
# because LLVM's release artifacts don't include source-only
# archives at the granularity we want. SHA validation is
# delegated to the build script's `git rev-parse` after clone.
[source]
url = "https://github.com/llvm/llvm-project.git"
sha256 = ""

[license]
spdx = "Apache-2.0 WITH LLVM-exception"
url = "https://github.com/llvm/llvm-project/blob/main/LICENSE.TXT"

[outputs]
libs = ["lib/libc++.a", "lib/libc++abi.a"]
headers = ["include/c++/v1"]
```

(Schema check: `cargo xtask build-deps parse libcxx` should print this
back without error after Step 4.)

**Step 3: Add package.json shim**

Create `examples/libs/libcxx/package.json`:

```json
{
  "name": "wasm-posix-libcxx",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "build-libcxx": "bash build-libcxx.sh"
  }
}
```

(Match what other libs ship — `cat examples/libs/openssl/package.json`
for reference.)

**Step 4: Update mariadb's call site**

Find: `examples/libs/mariadb/build-mariadb.sh:184-189` (the block that
checks for `$SYSROOT/lib/libc++.a` and runs `bash $REPO_ROOT/scripts/build-libcxx.sh`).

Replace with the standard resolve pattern:

```bash
LIBCXX_PREFIX="${WASM_POSIX_DEP_LIBCXX_DIR:-}"
if [ -z "$LIBCXX_PREFIX" ]; then
    echo "==> Resolving libcxx via cargo xtask build-deps..."
    LIBCXX_PREFIX="$(resolve_dep libcxx)"
fi
[ -f "$LIBCXX_PREFIX/lib/libc++.a" ] || {
    echo "ERROR: libcxx resolve missing libc++.a at $LIBCXX_PREFIX" >&2
    exit 1
}
# MariaDB's existing logic expects libc++.a/libc++abi.a in the
# sysroot. Symlink rather than copy — keeps the sysroot a pure
# index of cache contents.
ln -sf "$LIBCXX_PREFIX/lib/libc++.a"    "$SYSROOT/lib/libc++.a"
ln -sf "$LIBCXX_PREFIX/lib/libc++abi.a" "$SYSROOT/lib/libc++abi.a"
mkdir -p "$SYSROOT/include/c++"
ln -sfn "$LIBCXX_PREFIX/include/c++/v1" "$SYSROOT/include/c++/v1"
```

(Add `depends_on = ["libcxx@21"]` to mariadb's `deps.toml`.)

**Step 5: Delete the old script**

```
git rm scripts/build-libcxx.sh
```

**Step 6: Resolve libcxx for the first time**

```
cargo xtask build-deps resolve libcxx 2>&1 | tail -10
```
Expected: builds from source, prints cache path
(`~/.cache/wasm-posix-kernel/libs/libcxx-21-rev1-XXXXXXXX/`).
First call takes 5–15 minutes depending on host.

**Step 7: Resolve again — should be a cache hit**

```
cargo xtask build-deps resolve libcxx 2>&1 | tail -3
```
Expected: prints same path immediately, no rebuild.

**Step 8: Run mariadb build to verify the migration**

```
bash examples/libs/mariadb/build-mariadb.sh 2>&1 | tail -10
```
Expected: succeeds (it's a long build — set aside ~10–20 minutes).
This validates the resolver-pattern adaptation.

**Step 9: Commit Task 2**

```
git add examples/libs/libcxx/ examples/libs/mariadb/
git rm scripts/build-libcxx.sh
git commit -m "deps(libcxx): migrate libcxx into the package-management system

Move scripts/build-libcxx.sh to examples/libs/libcxx/build-libcxx.sh
and add deps.toml so libcxx is resolved through cargo xtask build-deps
like every other library. mariadb's call site updated to consume via
the resolver. No behavior change in this commit — libunwind bundling
arrives in the next.
"
```

---

## Task 3: Bundle LLVM libunwind into libc++abi.a

Flip the CMake flags + sparse-checkout so libunwind is built and
statically linked into libc++abi.a. This is the actual functional
fix.

**Files:**
- Modify: `examples/libs/libcxx/build-libcxx.sh`
- Modify: `examples/libs/libcxx/deps.toml` (bump `revision` from 1 to 2)

**Step 1: Update sparse-checkout list**

In `build-libcxx.sh`, find the `git sparse-checkout set` line (was
line 92 in the original). Add `libunwind`:

```bash
git sparse-checkout set libcxx libcxxabi libunwind runtimes cmake llvm/cmake llvm/utils/llvm-lit libc
```

**Step 2: Add libunwind to CMake runtimes**

Find:
```
-DLLVM_ENABLE_RUNTIMES="libcxx;libcxxabi" \
```

Replace with:
```
-DLLVM_ENABLE_RUNTIMES="libcxx;libcxxabi;libunwind" \
```

**Step 3: Flip LIBCXXABI_USE_LLVM_UNWINDER and add libunwind config**

Find:
```
-DLIBCXXABI_USE_LLVM_UNWINDER=OFF \
```

Replace with:
```
-DLIBCXXABI_USE_LLVM_UNWINDER=ON \
-DLIBCXXABI_STATICALLY_LINK_UNWINDER_IN_STATIC_LIBRARY=ON \
-DLIBUNWIND_ENABLE_SHARED=OFF \
-DLIBUNWIND_ENABLE_STATIC=ON \
-DLIBUNWIND_ENABLE_THREADS=ON \
-DLIBUNWIND_USE_COMPILER_RT=OFF \
-DLIBUNWIND_INCLUDE_TESTS=OFF \
```

The `STATICALLY_LINK_UNWINDER_IN_STATIC_LIBRARY=ON` is what bundles
libunwind's archive contents into libc++abi.a so consumers do not
need a separate `-lunwind` flag. Verify post-build with:
```
wasm32posix-nm "$WASM_POSIX_DEP_OUT_DIR/lib/libc++abi.a" \
    | grep -E '_Unwind_RaiseException' | head
```
Should show the symbol *defined* (T) inside libc++abi.a, not
undefined (U).

**Step 4: Build the make target**

The current line is:
```
make -j"$NPROC" cxx cxxabi 2>&1 | tail -10
```

Add `unwind` to the list:
```
make -j"$NPROC" cxx cxxabi unwind 2>&1 | tail -10
```

(Required because `make cxx cxxabi` with libunwind enabled doesn't
implicitly build the unwind archive. CMake creates the targets but
the user-supplied target list controls what `make` runs.)

**Step 5: Bump revision**

In `examples/libs/libcxx/deps.toml`:
```
revision = 2
```

This invalidates the cache so the resolver rebuilds with the new flags.

**Step 6: Resolve libcxx with the new flags**

```
cargo xtask build-deps resolve libcxx 2>&1 | tail -10
```
Expected: rebuilds (cache miss because revision bumped). New path
ends in `…libcxx-21-rev2-YYYYYYYY/`.

**Step 7: Verify libunwind is bundled**

```
LIBCXX_PREFIX="$(cargo xtask build-deps path libcxx)"
wasm32posix-nm "$LIBCXX_PREFIX/lib/libc++abi.a" \
    | grep -E '_Unwind_RaiseException|_Unwind_Resume' | head
```
Expected: at least the two symbols above appear with a `T` (defined
in text section).

**Step 8: Re-link the cpp_throw_test program**

```
bash scripts/build-programs.sh 2>&1 | grep cpp_throw
wasm-objdump -x host/wasm/cpp_throw_test.wasm 2>&1 \
    | grep -E '<env\._Unwind' | head
```
Expected: zero `env._Unwind*` imports (libunwind is now resolved
internally inside the wasm binary).

**Step 9: Run the failing test, watch it pass**

```
TIMEOUT=10000 npx tsx examples/run-example.ts host/wasm/cpp_throw_test.wasm
```
Expected output:
```
PASS: typed catch
PASS: catch-all
PASS: cross-frame
```
Exit code 0.

```
cd host && npx vitest run cpp-throw-test
```
Expected: `1 passed`.

**Step 10: Commit Task 3**

```
git add examples/libs/libcxx/build-libcxx.sh examples/libs/libcxx/deps.toml
git commit -m "deps(libcxx): bundle LLVM libunwind into libc++abi.a

Build LLVM libunwind alongside libcxx + libcxxabi via
LLVM_ENABLE_RUNTIMES=libcxx;libcxxabi;libunwind, link statically
into libc++abi.a with LIBCXXABI_USE_LLVM_UNWINDER=ON +
LIBCXXABI_STATICALLY_LINK_UNWINDER_IN_STATIC_LIBRARY=ON.

C++ throws now propagate end-to-end. cpp_throw_test passes.
Bumps libcxx revision 1 → 2 to invalidate the cache.
"
```

---

## Task 4: Run the full 5-suite test gate

CLAUDE.md is explicit: 5 suites + ABI + sortix must pass. This task
runs them all and inspects diffs from the pre-change baseline.

**Files touched:** none.

**Step 1: cargo tests**

Run:
```
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib 2>&1 | tail -5
```
Expected: same pass count as Task 0 baseline. 0 failures.

**Step 2: vitest**

Run:
```
cd host && npx vitest run 2>&1 | tail -10
```
Expected: same as baseline + 1 new test (cpp-throw-test) passing.

**Step 3: libc-test**

Run:
```
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/libcxx-pkg-libunwind
scripts/run-libc-tests.sh 2>&1 | tail -5
```
Expected: 0 unexpected FAILs. Same XFAIL count as baseline.

**Step 4: POSIX**

Run:
```
scripts/run-posix-tests.sh 2>&1 | tail -5
```
Expected: 0 FAIL. Same UNRES/SKIP counts as baseline.

**Step 5: Sortix**

Run:
```
scripts/run-sortix-tests.sh --all 2>&1 | tail -10
```
Expected: ≥ 4827 PASS / 0 FAIL / 0 XPASS (current memory baseline).

**Step 6: ABI snapshot**

Run:
```
bash scripts/check-abi-version.sh
```
Expected: exits 0. **No drift.** This change is userspace-only and
must not bump ABI_VERSION.

**Step 7: If any suite regresses**

Stop. Investigate. Do NOT proceed to Task 5 until clean. Document
the regression and the root cause in a follow-up task on this plan.

---

## Task 5: Stage the binary archive (dry-run)

Confirm the libcxx artifact stages correctly into the
`binaries-abi-v<N>` archive shape. Don't publish — that's a
post-merge step.

**Files touched:** none directly; produces output under
`local-binaries/` or temp dir.

**Step 1: List existing staging command**

Run:
```
cargo xtask --help 2>&1 | grep -E 'stage|publish' | head
```

Look for `stage-release` or similar. Use it with `--dry-run` if
available, else with a temp output dir.

**Step 2: Stage libcxx**

Run (adjust syntax to actual help output):
```
cargo xtask stage-release --only libcxx --output /tmp/stage-libcxx 2>&1 | tail
ls /tmp/stage-libcxx
```
Expected: a `.tar.zst` named like
`libcxx-21-rev2-abi<N>-wasm32-<shortsha>.tar.zst` (and the wasm64
variant). Each archive contains `lib/libc++.a`, `lib/libc++abi.a`,
and `include/c++/v1/` populated.

**Step 3: Verify archive contents**

```
zstd -dc /tmp/stage-libcxx/libcxx-*-wasm32-*.tar.zst | tar -tf - | head -20
```
Expected: paths begin with `lib/` and `include/c++/v1/`.

**Step 4: Skip publish**

The actual `binaries-abi-v<N>` GitHub release update is a CI/release
engineer task post-merge. Note in the PR body that the next
`binaries-abi-v<N+1>` cut should include libcxx.

---

## Task 6: Documentation

Update the docs that change because of this PR.

**Files:**
- Modify: `docs/posix-status.md` — add a "C++ exception support"
  paragraph noting full unwind via bundled libunwind.
- Modify: `docs/package-management.md` — add libcxx to any list of
  cached libs (search for `7 libs` or similar; bump to `8 libs`).
- Modify: `docs/sdk-guide.md` — add a "Linking C++ programs"
  paragraph: `wasm32posix-c++ src.cpp -lc++ -lc++abi -o out.wasm`
  works out of the box, libunwind is included.
- Modify: `docs/architecture.md` — if it lists toolchain pieces,
  mention libunwind is now available.
- Modify: `README.md` — only if it currently lists what's in the
  toolchain.

**Step 1: Make the edits**

Each file gets one or two paragraphs. Keep it terse. Cross-reference
the spike memory file
(`memory/spidermonkey-spike-eh-toolchain-gap.md`)
in `docs/posix-status.md` so the trail from "no C++ EH" to "fixed"
is documented.

**Step 2: Commit Task 6**

```
git add docs/ README.md
git commit -m "docs: document libcxx package + libunwind support"
```

---

## Task 7: Open the PR

Push and open the PR. Per project memory: never push to main; always
PR. Per CLAUDE.md: don't host images via release tags; let the user
handle screenshots.

**Step 1: Push**

```
git push -u origin libcxx-pkg-libunwind
```

**Step 2: Open PR**

Use `gh pr create`:

```
gh pr create --base package-management --title "deps(libcxx): publish libcxx as a package, bundle libunwind" --body "$(cat <<'EOF'
## Summary

- Migrate `scripts/build-libcxx.sh` → `examples/libs/libcxx/` (deps.toml + build script + package.json), making libcxx the 8th cached binary lib in the package-management system.
- Set `LIBCXXABI_USE_LLVM_UNWINDER=ON` and bundle libunwind statically into `libc++abi.a` so C++ programs that throw exceptions actually propagate them at runtime. Closes a gap discovered by the SpiderMonkey EH spike on 2026-04-28.
- Add `programs/cpp_throw_test.cpp` + matching vitest case as a permanent regression gate.
- mariadb's libcxx call site moved onto the standard resolver pattern; declares `depends_on = ["libcxx@21"]`.

## Background

The 2026-04-28 spike found that `_Unwind_RaiseException` was an unresolved import in every C++ program — libunwind was never built for the sysroot. Three of four spike test programs hung on the first throw. Without this fix, SpiderMonkey (which throws C++ exceptions through deep call stacks) cannot run inside the kernel.

## Test plan

- [ ] `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib` — 0 failures
- [ ] `cd host && npx vitest run` — including new cpp-throw-test
- [ ] `scripts/run-libc-tests.sh` — 0 unexpected FAIL
- [ ] `scripts/run-posix-tests.sh` — 0 FAIL
- [ ] `scripts/run-sortix-tests.sh --all` — ≥ 4827 PASS / 0 FAIL
- [ ] `bash scripts/check-abi-version.sh` — exits 0 (no drift)
- [ ] `cargo xtask build-deps resolve libcxx` — builds, then cache-hits
- [ ] `bash examples/libs/mariadb/build-mariadb.sh` — succeeds
- [ ] `cpp_throw_test.wasm` runs in the kernel, exit 0, three PASSes

## Follow-up

- The `binaries-abi-v<N+1>` release cut should include libcxx archives.
- The SpiderMonkey worktree (`node.js-wasm-runtime-for-kernel-with-builtin-modul`) will rebase onto package-management after this merges, then re-run the four-test EH spike to validate fork-instrument vs C++ EH on real wasm-EH-or-libunwind output.
EOF
)"
```

---

## Task 8: Update memory

After PR is open (or merged), refresh the project memory.

**Files touched:** memory directory (under
`/Users/brandon/.claude/projects/-Users-brandon-ai-src-wasm-posix-kernel/memory/`).

**Step 1: Update `MEMORY.md` index** — add an entry for the libcxx
package work, link to a new file
`memory/libcxx-package-with-libunwind.md` capturing:
- Branch + PR link
- That libunwind is now bundled in libc++abi.a (consumers don't
  need `-lunwind`)
- That `scripts/build-libcxx.sh` is gone
- Trigger conditions (someone wonders why C++ throws "just work" now)

**Step 2: Update `spidermonkey-spike-eh-toolchain-gap.md`**

When this PR merges, add a "RESOLVED via PR #<num>" header at the
top noting C++ exceptions now work via bundled libunwind, and that
the SpiderMonkey worktree can re-run the spike.

---

## Risks and gotchas

- **LLVM source clone size.** `git sparse-checkout` plus
  `libunwind` should still keep the source tree to ~50MB. If it
  balloons, adjust the sparse-checkout list.
- **Header sourcing.** This PR continues to copy libc++ headers from
  Homebrew LLVM at build time. If a developer doesn't have Homebrew
  LLVM 21+ installed, the build fails with a clear message — same
  precondition as before. Flagged in the PR body, not a regression.
- **Symlinks in mariadb's sysroot setup.** `ln -sfn` is used so the
  sysroot is a thin index. If a developer's filesystem doesn't
  support symlinks (rare), fall back to `cp -a`. Not a typical case.
- **Test (b)/(c) of the spike (post-fork throws).** This PR does NOT
  re-run the SpiderMonkey spike. That happens on the SpiderMonkey
  worktree after rebase. cpp_throw_test only validates the
  throw-without-fork path, which is sufficient to prove libunwind
  is wired up. Fork × EH interaction is a separate question.
