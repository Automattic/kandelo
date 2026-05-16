# QuickJS-NG Node Compat — `npm install` Track — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Companion to:** [`docs/plans/2026-04-28-quickjs-node-compat-design.md`](./2026-04-28-quickjs-node-compat-design.md). Read the design first; this plan is the executable counterpart.

**Goal:** Get `npm install` of real-world multi-dep packages running on `node.wasm` (QuickJS-NG-based Node compat binary), inside our kernel sandbox — with no "external Node process" escape hatch.

**Architecture (recap from design §5):**

```
   user JS (npm, lodash, vite, …)
        │  require('crypto') / require('https') / require('zlib')
        ▼
   bootstrap.js (Node-compat shim, in-tree, pure JS)
        │  delegates to globalThis._nodeNative.* when present
        ▼
   qjs:node native module  (NEW — single C archive)
        │
   ┌────┴────┬─────────┬────────┐
   ▼         ▼         ▼        ▼
   libcrypto libssl    libz     kernel syscalls
   (SHA/HMAC)(TLS)     (gzip)   (socket/connect/poll/getaddrinfo)
```

The bridge is **one** new QuickJS C native module exposing four namespaces (`hash`, `tls`, `socket`, `zlib`) wired into `node-main.c` alongside the existing `qjs:std` / `qjs:os` / `qjs:bjson` registrations. bootstrap.js gates each subsystem on `typeof globalThis._nodeNative !== 'undefined'` so partial builds and existing tests never regress.

**Tech Stack:**
- C (QuickJS native module, against our `wasm32posix-cc` SDK)
- OpenSSL 3.x (already builds, `examples/libs/openssl/build-openssl.sh`)
- zlib (already builds, `examples/libs/zlib/build-zlib.sh`)
- TypeScript host runtime (vitest integration tests)
- QuickJS-NG v0.12.1 (cloned by `build-quickjs.sh`, no upstream patches — native-module API only)

**PR series (target order, each upstream-shippable on its own):**

| # | Phase | Title (matches existing commit style) |
|---|-------|---------------------------------------|
| 0a | 0 | `fix(build): restore build under current nightly toolchain` |
| 0b | 0 | `fix(quickjs): drop nonexistent cutils.c refs from build-quickjs.sh` |
| 0c | 0 | `fix(kernel): restore JS_Eval — root-cause QuickJS stack overflow` |
| 0d | 0 | `docs(plan): QuickJS-NG Node compat — Phase 0 verification` |
| 1  | 1 | `feat(quickjs-node): real SHA-256/512 via libcrypto` |
| 2  | 2 | `feat(quickjs-node): real gzip/inflate via libz` |
| 3  | 3 | `feat(quickjs-node): real AF_INET sockets + event-loop fd-watch` |
| 4  | 4 | `feat(quickjs-node): TLS via OpenSSL — https.get works` |
| 5  | 5 | `feat(quickjs-node): npm install of zero-dep package` |
| 6  | 6 | `feat(quickjs-node): npm install of express + vite` |
| 7+ | 7+ | (decision point — see Phase 7) |

Each PR opens its own focused branch off `main` (or, where it stacks, off the predecessor). None is rolled into another. `XFAIL` / `TIME` are tolerated; any new `FAIL` is a regression.

**Verification gauntlet (CLAUDE.md, applies to every PR):**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib   # 539+ pass, 0 fail
(cd host && npx vitest run)                                            # all files pass
scripts/run-libc-tests.sh                                              # 0 unexpected FAIL
scripts/run-posix-tests.sh                                             # 0 FAIL
bash scripts/check-abi-version.sh                                      # exit 0
```

ABI snapshot regen + `ABI_VERSION` bump if any kernel/shared/struct surface moves (see CLAUDE.md "Kernel ABI stability").

---

## Phase 0 — Foundation fixes & verification

Phase 0 fixes blockers found before any feature work can land. **Four sub-PRs**, each focused, each upstream-shippable. Order matters — the stack-overflow bisect (0c) requires a working build (0a) and a working `build-quickjs.sh` on a fresh clone (0b).

### Phase 0a — `fix(build): restore build under current nightly toolchain`

**Symptom:** Every kernel-build entrypoint fails on `cargo build … -Z build-std-features=panic_immediate_abort`. Current nightly removed the build-std-feature; `panic_immediate_abort` is now a real panic strategy. The compiler error itself prescribes the new spelling:

> `panic_immediate_abort` is now a real panic strategy! Enable it with `panic = "immediate-abort"` in Cargo.toml, or with the compiler flags `-Zunstable-options -Cpanic=immediate-abort`. In both cases, you still need to build core, e.g. with `-Zbuild-std`.

**Three call sites are affected**, not one (verified by `grep -nE "build-std-features=panic_immediate_abort"`):

- `build.sh:7` — main build entrypoint
- `run.sh:107` — demo runner's `need_kernel()`
- `scripts/check-abi-version.sh:36` — the ABI snapshot script invoked by step 5 of the verification gauntlet itself

A PR that updates only `build.sh` would leave `run.sh` broken **and would fail its own verification gauntlet** because step 5 invokes the still-broken `scripts/check-abi-version.sh`. All three must move together.

**Approach.** Do **both** — update flags *and* pin the toolchain — for two independent reasons:

1. **Update the flag form** in all three scripts to `RUSTFLAGS="-Zunstable-options -Cpanic=immediate-abort"`. This is the minimum to unblock current nightly.
2. **Pin `rust-toolchain.toml` to a specific dated nightly** (today: `nightly-2026-04-27`, the one that produces the new error message). The current pin is open-ended `channel = "nightly"` — which is precisely what let three scripts silently break the moment upstream rust shipped a breaking change. Without a date pin, this exact PR happens again the next time upstream churns.

The original plan picked "Approach 1 alone" with the rationale that it tracks upstream rust. Investigation revised this: tracking upstream means tracking *any* breaking change in the build-std flag surface, with no firewall. A dated pin makes future upstream churn an explicit decision (bump the date, see what breaks, fix or revert) rather than a surprise broken `main`.

#### Task 0a.1 — Probe the right invocation under current nightly *(verified)*

Already executed during plan revision. Recorded outcome:

```bash
$ rustc --version
rustc 1.97.0-nightly (52b6e2c20 2026-04-27)

$ RUSTFLAGS="-Zunstable-options -Cpanic=immediate-abort" \
  cargo build --release -p wasm-posix-kernel -Z build-std=core,alloc
…
Finished `release` profile [optimized] target(s) in 6.96s

$ stat -f "%z" target/wasm64-unknown-unknown/release/wasm_posix_kernel.wasm
416242                                  # fresh build
$ stat -f "%z" host/wasm/wasm_posix_kernel.wasm
441836                                  # committed
```

**Wasm size drifted ~25 KB** (~6%) vs. the committed binary, exceeding the original "~5 KB" tolerance. The drift is almost certainly codegen — `lto = true` + `opt-level = "s"` + a newer nightly's compiler_builtins emit different bytes — but only the ABI snapshot check (Task 0a.5) can confirm that no structural surface (channel layout, syscall numbers, marshalled structs, kernel-wasm exports) shifted.

#### Task 0a.2 — Update all three cargo call sites

**Files (all three must change in one PR):**
- Modify: `build.sh`
- Modify: `run.sh`
- Modify: `scripts/check-abi-version.sh`

For each, replace the existing block:

```bash
cargo build --release -p wasm-posix-kernel \
  -Z build-std=core,alloc \
  -Z build-std-features=panic_immediate_abort
```

with:

```bash
RUSTFLAGS="-Zunstable-options -Cpanic=immediate-abort" \
cargo build --release -p wasm-posix-kernel \
  -Z build-std=core,alloc
```

(Keep the `RUSTFLAGS=` inline so it doesn't leak into other cargo invocations later in each script.)

**Verify the grep is clean afterwards:**
```bash
grep -rnE "build-std-features=panic_immediate_abort" build.sh run.sh scripts/
```
Expected: no matches.

#### Task 0a.3 — Pin the nightly date in `rust-toolchain.toml`

**File:** `rust-toolchain.toml`

Current contents:
```toml
[toolchain]
channel = "nightly"
targets = ["wasm32-unknown-unknown"]
```

New contents:
```toml
[toolchain]
channel = "nightly-2026-04-27"
targets = ["wasm32-unknown-unknown"]
```

Use whichever nightly date the developer running 0a actually has installed and has verified produces a green build. Future toolchain bumps become a one-line edit + verification gauntlet, never a silent break.

(The repo has no `rust-toolchain` plain-text file — only `.toml` — so no second file to update.)

#### Task 0a.4 — Document the change

**Files:**
- Inspect: `docs/posix-status.md`, `README.md`, `docs/architecture.md`
- Modify only if any of them quote the cargo flag verbatim.

Most likely no doc changes needed — the build flag is internal. The historical plan files under `docs/plans/2026-03-08-*.md` reference the old flag in build invocations; these are historical records of past sessions and should **not** be retroactively edited.

#### Task 0a.5 — Run the full verification gauntlet

```bash
bash build.sh                                                          # exit 0
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib    # 539+ pass, 0 fail
(cd host && npx vitest run)                                            # all files pass
scripts/run-libc-tests.sh                                              # 0 unexpected FAIL
scripts/run-posix-tests.sh                                             # 0 FAIL
bash scripts/check-abi-version.sh                                      # exit 0
```

**Handling the 25 KB wasm drift:**

1. Run `bash scripts/check-abi-version.sh` (now using the new flag form).
2. If it reports drift in `abi/snapshot.json`:
   - Run `bash scripts/check-abi-version.sh update` to regenerate.
   - `git diff abi/snapshot.json` and inspect.
   - **Codegen-only drift** (different LTO output, no change to channel header, syscall numbers, struct layouts, or export list) → commit the regenerated snapshot **without** bumping `ABI_VERSION`. Add a one-line note in the PR body.
   - **Structural drift** (any change to the surfaces enumerated in CLAUDE.md "Kernel ABI stability") → bump `ABI_VERSION` in `crates/shared/src/lib.rs` in the same commit.
3. Re-run `bash scripts/check-abi-version.sh` — must exit 0 before proceeding.

Also commit the rebuilt `host/wasm/wasm_posix_kernel.wasm` if its bytes changed. Treat the new bytes as the canonical reference for downstream work.

#### Task 0a.6 — Commit & PR

```bash
git checkout -b fix-build-toolchain origin/main
git add build.sh run.sh scripts/check-abi-version.sh rust-toolchain.toml
# Plus host/wasm/wasm_posix_kernel.wasm and abi/snapshot.json IF they changed.
# Plus crates/shared/src/lib.rs IF ABI_VERSION bumped.
git commit -m "fix(build): restore build under current nightly toolchain"
git push -u origin fix-build-toolchain
gh pr create --base main \
  --title "fix(build): restore build under current nightly toolchain" \
  --body "..." # see template below
```

PR body template:
```
## Summary

Current nightly turned `panic_immediate_abort` from a build-std-feature into a
real panic strategy. The new spelling is `-Zunstable-options -Cpanic=immediate-abort`
via `RUSTFLAGS`. Three scripts hard-coded the old form — `build.sh`, `run.sh`, and
`scripts/check-abi-version.sh` — so a partial fix would leave the verification
gauntlet itself broken.

This PR:
1. Updates all three scripts to the new flag form.
2. Pins `rust-toolchain.toml` to `nightly-2026-04-27` (a specific date), so the
   next breaking upstream change becomes an explicit toolchain bump rather than
   a silent break in main.

Kernel wasm rebuild produced a ~25 KB size delta from the committed binary;
`scripts/check-abi-version.sh` confirms this is codegen-only / ABI-clean
[OR: requires an ABI_VERSION bump because <surface> shifted — pick one in the PR].

## Test plan

- [ ] `bash build.sh` exits 0
- [ ] `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib` — 0 failures
- [ ] `(cd host && npx vitest run)` — all pass
- [ ] `scripts/run-libc-tests.sh` — 0 unexpected FAIL
- [ ] `scripts/run-posix-tests.sh` — 0 FAIL
- [ ] `scripts/check-abi-version.sh` — exit 0 (with regenerated snapshot if codegen drift, or `ABI_VERSION` bump if structural)
```

---

### Phase 0b — `fix(quickjs): drop nonexistent cutils.c refs from build-quickjs.sh`

**Symptom:** On a fresh clone, `bash examples/libs/quickjs/build-quickjs.sh` fails compiling host `qjsc`:
```
clang: error: no such file or directory:
  '.../examples/libs/quickjs/quickjs-src/cutils.c'
```

In quickjs-ng v0.12.1, `cutils.h` is header-only (`static inline`); `cutils.c` was removed upstream.

#### Task 0b.1 — Edit `build-quickjs.sh`

**Files:**
- Modify: `examples/libs/quickjs/build-quickjs.sh`

**Step 1: Remove the host compile (current line 96).**

Delete:
```bash
$HOST_CC $HOST_CFLAGS -c "$SRC_DIR/cutils.c" -o "$HOST_BUILD_DIR/cutils.o"
```

**Step 2: Remove the link entry (current line 105).**

In the `$HOST_CC` link command (lines 98–107), remove:
```bash
"$HOST_BUILD_DIR/cutils.o" \
```

The link command should become:
```bash
$HOST_CC \
    "$HOST_BUILD_DIR/qjsc.o" \
    "$HOST_BUILD_DIR/quickjs.o" \
    "$HOST_BUILD_DIR/dtoa.o" \
    "$HOST_BUILD_DIR/libregexp.o" \
    "$HOST_BUILD_DIR/libunicode.o" \
    "$HOST_BUILD_DIR/quickjs-libc.o" \
    -lm -lpthread \
    -o "$QJSC"
```

**Step 3: Confirm wasm-side build does not reference `cutils.c`.**
```bash
grep -n cutils examples/libs/quickjs/build-quickjs.sh
```
Expected: no remaining matches (the script does not reference `cutils.h` either; clang resolves it via `-I$SRC_DIR`).

#### Task 0b.2 — Verify on a fresh clone

The script clones quickjs-ng on first run. To exercise the cold path:
```bash
rm -rf examples/libs/quickjs/quickjs-src examples/libs/quickjs/bin
bash examples/libs/quickjs/build-quickjs.sh
```

Expected: clones quickjs-ng v0.12.1, builds `qjsc` natively, compiles bootstrap to bytecode, builds `qjs.wasm` and `node.wasm` in `examples/libs/quickjs/bin/`, applies asyncify. Exit 0.

#### Task 0b.3 — Commit & PR

```bash
git checkout -b fix-quickjs-cutils-c origin/main
git add examples/libs/quickjs/build-quickjs.sh
git commit -m "fix(quickjs): drop nonexistent cutils.c refs from build-quickjs.sh"
git push -u origin fix-quickjs-cutils-c
gh pr create --base main \
  --title "fix(quickjs): drop nonexistent cutils.c refs from build-quickjs.sh" \
  --body "..."
```

PR body:
```
## Summary

quickjs-ng v0.12.1 (the tag this script clones) removed `cutils.c`;
`cutils.h` is now header-only (`static inline`). Building host `qjsc` on a
fresh clone fails with `clang: no such file or directory: cutils.c`.

Drop the compile + link references. No functional change for already-built
trees — only fixes cold-start.

## Test plan

- [ ] `rm -rf examples/libs/quickjs/quickjs-src examples/libs/quickjs/bin && bash examples/libs/quickjs/build-quickjs.sh` exits 0
- [ ] `qjs.wasm` + `node.wasm` produced
```

---

### Phase 0c — `fix(kernel): restore JS_Eval — root-cause QuickJS stack overflow`

**Symptom:** Against current HEAD `37814ab5`, every QuickJS code-eval path crashes:
```
$ qjs -e 'print(1)'           → stderr: "Maximum call stack size exceeded"
$ qjs -e "1+1"                → same
$ node -e 'console.log("x")'  → same
$ qjs --help                  → ✓ (no eval)
$ node --version              → ✓ (short-circuits before bootstrap)
```

`qjs.wasm` and `node.wasm` are the same crash. This is **not** a bootstrap.js bug (qjs.wasm has no bootstrap). It is **not** a QuickJS code-path change (no commits touch `examples/libs/quickjs/` since PR #226 / `18bfe4b6`).

The kernel between `18bfe4b6` and `37814ab5` is 106 commits — pthread, signals, AIO, AF_UNIX, framebuffer, and toolchain work. Some commit broke a syscall semantic that QuickJS's exception path depends on. Hypotheses (none verified — bisect confirms which):

1. **`setjmp`/`longjmp` regression.** QuickJS uses `setjmp` for exceptions; `wasm_setjmp_rt.o` lives in our sysroot. A subtle change in the asyncify save/restore could re-enter throw infinitely.
2. **Asyncify import set is too narrow.** `--asyncify-imports@kernel.kernel_fork` wraps only `kernel_fork`. If a syscall newly returns `EAGAIN` where it returned data immediately, the asyncify state machine can re-enter.
3. **Stack-size mismatch.** QuickJS computes its own stack budget from a probe. wasm32 stack pointer / size shifted vs. what QuickJS expects. The CLI flag `--stack-size` would let us probe.
4. **pthread/TLS init.** `JS_HAVE_THREADS=1`. PRs #333 (deferred cancellation), #334 (final AIO XFAIL + pthread_setcanceltype), #356 (AF_UNIX bind FS inode) may have changed TLS init or cancel state in a way that destabilizes early `JS_NewContext`.

#### Task 0c.1 — Establish a deterministic repro

**Files:**
- Create (temporary, not committed): `host/test/_repro-qjs-eval.test.ts`

**Step 1: Build the verification harness.**

```ts
import { describe, it, expect } from 'vitest';
import { runCentralizedProgram } from './centralized-test-helper.js';
import { existsSync } from 'fs';
import { join } from 'path';

const QJS = join(__dirname, '../../examples/libs/quickjs/bin/qjs.wasm');
const HAS_QJS = existsSync(QJS);

describe.skipIf(!HAS_QJS)('qjs-eval-repro', () => {
  it('qjs -e "1+1" exits 0 with output 2', async () => {
    const r = await runCentralizedProgram({
      programPath: QJS,
      argv: ['qjs', '-e', 'print(1+1)'],
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('2');
    expect(r.stderr).not.toContain('Maximum call stack');
  });
});
```

**Step 2: Confirm it fails on HEAD.**
```bash
cd host && npx vitest run test/_repro-qjs-eval.test.ts
```
Expected: 1 fail. The repro is now deterministic and machine-checkable.

#### Task 0c.2 — Probe the PR #226 baseline

**Goal:** Determine whether the regression is in a kernel commit or in the toolchain / build environment.

**Steps:**
1. Create a sibling worktree off `18bfe4b6` (the merge commit of PR #226):
   ```bash
   git worktree add ../qjs-bisect-base 18bfe4b6
   cd ../qjs-bisect-base
   ```
2. Apply the Phase 0a workaround inline to **both** `build.sh` and `run.sh` in the worktree (sed-replace the old `-Z build-std-features=panic_immediate_abort` block with the new `RUSTFLAGS` form). At `18bfe4b6`, `scripts/check-abi-version.sh` does not yet exist, so only those two files need patching. Do **not** commit the patches — they only need to live in the bisect worktree.
3. Build sysroot + kernel + qjs.wasm:
   ```bash
   git submodule update --init musl
   bash scripts/build-musl.sh
   bash build.sh
   bash examples/libs/quickjs/build-quickjs.sh   # apply Phase 0b cutils.c fix locally
   ```
4. Run the repro:
   ```bash
   cd host && npx vitest run test/_repro-qjs-eval.test.ts
   ```

**Decision point:**
- **Repro PASSES at `18bfe4b6`** → regression is in a kernel commit between `18bfe4b6` and `37814ab5`. Proceed to Task 0c.3 (bisect).
- **Repro FAILS at `18bfe4b6`** → regression is environmental (toolchain version / wasm-opt version / asyncify pass behavior). Skip Task 0c.3; proceed to Task 0c.4 (environmental triage).

#### Task 0c.3 — Bisect kernel commits (only if 0c.2 says kernel regression)

**Tool:** `git bisect run`.

**Step 1: Author a bisect script.**

```bash
#!/bin/bash
# scripts/bisect-qjs-eval.sh — exit 0 if qjs eval works, 1 if it crashes
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Apply Phase 0a + 0b workarounds inline — bisect commits predate those fixes.
RUSTFLAGS="-Zunstable-options -Cpanic=immediate-abort" \
  cargo build --release -p wasm-posix-kernel -Z build-std=core,alloc \
  >/dev/null 2>&1 || exit 125  # 125 = skip (build broken on this commit)

cp target/wasm64-unknown-unknown/release/wasm_posix_kernel.wasm host/wasm/

# Rebuild qjs.wasm (cheap — quickjs-src is already cloned & not modified)
bash examples/libs/quickjs/build-quickjs.sh >/dev/null 2>&1 || exit 125

cd host
if npx vitest run test/_repro-qjs-eval.test.ts >/dev/null 2>&1; then
  exit 0   # good
else
  exit 1   # bad
fi
```

`chmod +x scripts/bisect-qjs-eval.sh`. Do **not** commit this script — it lives only on the bisect branch.

**Step 2: Run bisect.**

```bash
git bisect start
git bisect bad 37814ab5
git bisect good 18bfe4b6
git bisect run scripts/bisect-qjs-eval.sh
```

Expected: ~7 build cycles. `git bisect` reports the first bad commit.

**Step 3: Inspect the first bad commit.**

`git show <sha>` — read the commit, identify the change to syscall semantics, asyncify behavior, signal masks, pthread TLS, or whatever specific surface QuickJS depends on.

**Step 4: Reset.**
```bash
git bisect reset
```

#### Task 0c.4 — Either kernel fix (from 0c.3) or environmental fix (from 0c.2 fall-through)

**Two independent paths. Take whichever 0c.2 dictated.**

##### Kernel-regression path

The fix depends entirely on what 0c.3 found. Likely shapes:

- **Asyncify import widening.** Add the offending syscall to `--pass-arg=asyncify-imports@…` in `build-quickjs.sh`. Document the new import in a comment.
- **Syscall semantic restoration.** A kernel commit changed e.g. `read` to return `EAGAIN` where it formerly returned data. Either revert the semantic for the affected fd type, or add a path-specific override. **Bumps `ABI_VERSION`** if the restored semantic is part of the marshalled struct surface.
- **setjmp/longjmp regression.** Probably a change in `wasm_setjmp_rt.o` or in how the kernel handles the corresponding call. Fix in `crates/kernel/src/…` plus possibly `glue/`.

The fix's PR is its own thing — title `fix(kernel): <specific cause> — restore JS_Eval`. Do **not** roll into Phase 1.

##### Environmental path

Likely diagnosis: wasm-opt version drift OR clang/llvm version drift changing how `-mllvm -wasm-enable-sjlj` lays out save state.

**Steps:**
1. Pin `wasm-opt` version in `build-quickjs.sh` (require >= a known-good binaryen release, fail with a clear message otherwise).
2. Pin clang version OR add a workaround flag (e.g. additional `-mllvm` flag).
3. Add a regression test (the `_repro-qjs-eval.test.ts` from Task 0c.1, but committed as `node-compat-eval-smoke.test.ts`).

#### Task 0c.5 — Promote the repro to a permanent regression test

**Files:**
- Create: `host/test/quickjs-eval-smoke.test.ts` (move from `_repro-qjs-eval.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { runCentralizedProgram } from './centralized-test-helper.js';
import { existsSync } from 'fs';
import { join } from 'path';

const QJS  = join(__dirname, '../../examples/libs/quickjs/bin/qjs.wasm');
const NODE = join(__dirname, '../../examples/libs/quickjs/bin/node.wasm');
const HAS_QJS  = existsSync(QJS);
const HAS_NODE = existsSync(NODE);

describe.skipIf(!HAS_QJS)('qjs.wasm eval smoke', () => {
  it.each([
    ['print(1+1)',                   '2'],
    ['print("hello")',               'hello'],
    ['print([1,2,3].map(x=>x*2).join(","))', '2,4,6'],
  ])('qjs -e %s prints %s', async (src, expected) => {
    const r = await runCentralizedProgram({
      programPath: QJS,
      argv: ['qjs', '-e', src],
    });
    expect(r.stderr).not.toContain('Maximum call stack size');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(expected);
  });
});

describe.skipIf(!HAS_NODE)('node.wasm eval smoke', () => {
  it('node -e console.log(1+1) prints 2', async () => {
    const r = await runCentralizedProgram({
      programPath: NODE,
      argv: ['node', '-e', 'console.log(1+1)'],
    });
    expect(r.stderr).not.toContain('Maximum call stack size');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('2');
  });
});
```

This test is the floor. Phase 1+ all assume it passes.

#### Task 0c.6 — Commit & PR

PR body:
```
## Summary

`qjs -e '<expr>'` and `node -e '<expr>'` reliably stack-overflow against
HEAD <sha>. Bisect / triage identifies <root cause>. Fix <details>.

Promotes the failing repro to a permanent regression test
(`host/test/quickjs-eval-smoke.test.ts`).

## Root cause

<bisect output / environmental finding>

## Test plan

- [ ] `cargo test … --lib` — 0 failures
- [ ] `(cd host && npx vitest run test/quickjs-eval-smoke.test.ts)` — all pass
- [ ] full vitest — pass
- [ ] libc-test — 0 unexpected FAIL
- [ ] POSIX test suite — 0 FAIL
- [ ] ABI snapshot — clean (or bumped with reason)
```

---

### Phase 0d — `docs(plan): QuickJS-NG Node compat — Phase 0 verification`

**Goal:** With 0a/0b/0c landed, walk the full build chain and produce the formal Phase 0 doc the design references.

#### Task 0d.1 — Cold-start the full build chain

```bash
git submodule update --init --recursive
bash scripts/build-musl.sh                              # → sysroot/lib/libc.a
bash build.sh                                           # → host/wasm/wasm_posix_kernel.wasm
bash examples/libs/openssl/build-openssl.sh             # → libcrypto.a + libssl.a
bash examples/libs/zlib/build-zlib.sh                   # → libz.a
cd sdk && npm install && npm link && cd ..              # wasm32posix-cc on PATH
bash examples/libs/quickjs/build-quickjs.sh             # → qjs.wasm + node.wasm
```

Each step exits 0. Record artifact sizes (KB) into the doc.

#### Task 0d.2 — Run all 12 vitest cases in `node-compat.test.ts`

```bash
cd host && npx vitest run test/node-compat.test.ts
```

Expected: 12/12 pass. (Pre-fix this was 1/12 — the only passing case was `--version` because it short-circuits before `JS_Eval`.)

#### Task 0d.3 — OpenSSL sysroot audit

```bash
ls -lh examples/libs/openssl/openssl-install/lib/{libcrypto.a,libssl.a}
strings examples/libs/openssl/openssl-install/lib/libcrypto.a \
  | grep -E "^OPENSSLDIR|^/etc/ssl"
```

Confirm:
- `libcrypto.a` ~5 MB, `libssl.a` ~1 MB
- `OPENSSLDIR: "/etc/ssl"`
- Strings include `/etc/ssl/cert.pem`, `/etc/ssl/certs`

#### Task 0d.4 — zlib sysroot audit

```bash
ls -lh examples/libs/zlib/zlib-install/lib/libz.a
```

Confirm `libz.a` ~100 KB.

#### Task 0d.5 — Tarball roundtrip sanity check

```bash
mkdir -p /tmp/lodash-probe
curl -sSL https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz \
  -o /tmp/lodash-probe/lodash.tgz
file /tmp/lodash-probe/lodash.tgz       # gzip compressed data
sha256sum /tmp/lodash-probe/lodash.tgz  # known value
```

Confirm the tarball has the expected sha256 (`shrug-emoji.npmjs.org` is HTTPS-fetched here for convenience; in-kernel verification comes in Phase 5).

#### Task 0d.6 — Author the verification doc

**File:** `docs/plans/2026-04-28-quickjs-node-compat-phase0.md`

Structure:
```
# QuickJS-NG Node Compat — Phase 0 Verification

Date: <date>
Branch: <branch>

## Build chain — all green
| Step | Output | Size | Status |
|------|--------|------|--------|
| musl                | sysroot/lib/libc.a       | 1.4 MB | ✓ |
| kernel              | host/wasm/wasm_posix_kernel.wasm | <kb> KB | ✓ |
| OpenSSL             | libcrypto.a + libssl.a   | 5 MB + 1 MB | ✓ |
| zlib                | libz.a                   | 100 KB | ✓ |
| qjs.wasm            | bin/qjs.wasm             | <kb> KB | ✓ |
| node.wasm           | bin/node.wasm            | <kb> KB | ✓ |

## Vitest — node-compat.test.ts
12/12 pass.

## Eval smoke
qjs -e / node -e roundtrip — see host/test/quickjs-eval-smoke.test.ts.

## OpenSSL audit
…

## zlib audit
…

## Tarball roundtrip
…

## Foundation fixes shipped
- fix(build): restore build under current nightly toolchain (#…)
- fix(quickjs): drop nonexistent cutils.c refs from build-quickjs.sh (#…)
- fix(kernel): restore JS_Eval — root-cause QuickJS stack overflow (#…)
```

#### Task 0d.7 — Delete the session-notes scratch file

`docs/plans/2026-04-28-quickjs-node-compat-session-notes.md` was working scratch for this plan; now superseded by the formal Phase 0 doc. Delete on the same PR.

#### Task 0d.8 — Commit & PR

```bash
git checkout -b docs-quickjs-phase0 origin/main
git rm docs/plans/2026-04-28-quickjs-node-compat-session-notes.md
git add docs/plans/2026-04-28-quickjs-node-compat-phase0.md
git commit -m "docs(plan): QuickJS-NG Node compat — Phase 0 verification"
```

PR body:
```
## Summary

Records that Phase 0 of the QuickJS-NG Node compat track is complete:
build chain green end-to-end, eval-smoke regression test in place,
OpenSSL/zlib sysroot audited.

Supersedes the session-notes scratch file (deleted on this PR).

## Test plan

- [ ] All 5 verification suites pass per CLAUDE.md
- [ ] `host/test/quickjs-eval-smoke.test.ts` passes
- [ ] `host/test/node-compat.test.ts` — 12/12 pass
```

---

## Phase 1 — Hashing — `feat(quickjs-node): real SHA-256/512 via libcrypto`

**Goal:** Replace bootstrap.js's XOR-stub `crypto.createHash` (L2089–2148) with real OpenSSL-backed hashes. First touch of the new `qjs:node` native module + its build wiring.

**Estimate:** 2–3 days.

**Acceptance:**
```js
require('crypto').createHash('sha256').update('').digest('hex')
// === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
```

### Task 1.1 — Scaffold `node-compat-native/` directory

**Files:**
- Create: `examples/libs/quickjs/node-compat-native/` (directory)
- Create: `examples/libs/quickjs/node-compat-native/node-native.h`
- Create: `examples/libs/quickjs/node-compat-native/node-native.c`

**Step 1: header — module-init declaration.**

`node-native.h`:
```c
/*
 * qjs:node — Node.js-compat native bindings for QuickJS-NG.
 *
 * Provides typed JS bindings to libcrypto, libssl, libz, and AF_INET sockets.
 * Used by examples/libs/quickjs/node-compat/bootstrap.js to back its
 * crypto / net / http / https / zlib stubs with real implementations.
 */
#ifndef QJS_NODE_NATIVE_H
#define QJS_NODE_NATIVE_H

#include "quickjs.h"

JSModuleDef *js_init_module_node(JSContext *ctx, const char *module_name);

#endif
```

**Step 2: top-level module file — registers exports.**

`node-native.c` — initial skeleton (will gain `hash`, `zlib`, `socket`, `tls` namespaces phase by phase):
```c
#include "node-native.h"

/* Phase 1: hash bindings live in hash.c */
extern int js_node_hash_register(JSContext *ctx, JSModuleDef *m);

static int js_node_init(JSContext *ctx, JSModuleDef *m) {
    return js_node_hash_register(ctx, m);
    /* Phase 2 will append: js_node_zlib_register(ctx, m); etc. */
}

JSModuleDef *js_init_module_node(JSContext *ctx, const char *module_name) {
    JSModuleDef *m = JS_NewCModule(ctx, module_name, js_node_init);
    if (!m) return NULL;
    /* Exports declared by each sub-register so this stays cohesive. */
    js_node_hash_register(ctx, m); /* declare-only call to JS_AddModuleExport */
    return m;
}
```

The double-call pattern (declare in `init_module_node`, populate in `js_node_init`) is required by QuickJS-NG's two-phase module init. `js_node_hash_register` distinguishes phases by checking whether `m` is already populated.

### Task 1.2 — `hash.c`: SHA-1 / SHA-256 / SHA-512 / MD5 bindings

**Files:**
- Create: `examples/libs/quickjs/node-compat-native/hash.c`

**Design:**
- Each algorithm exposed as a JS class: `Sha1`, `Sha256`, `Sha512`, `Md5`.
- Each class: `new Sha256()` → opaque object; `.update(buf)` → returns `this` (chainable); `.digest('hex' | 'base64' | undefined)` → `Uint8Array` or string.
- HMAC: `Hmac` class with `(algo, key)` constructor.
- Internal state: opaque pointer to `EVP_MD_CTX *`.

**Step 1: Inclusion + class IDs.**

```c
#include <openssl/evp.h>
#include <string.h>
#include "node-native.h"

static JSClassID js_node_hash_class_id;

typedef struct {
    EVP_MD_CTX *ctx;
    const EVP_MD *md;     /* SHA256, etc. */
    int finalized;
} JSNodeHash;
```

**Step 2: GC finalizer — `EVP_MD_CTX_free`.**

```c
static void js_node_hash_finalizer(JSRuntime *rt, JSValue val) {
    JSNodeHash *h = JS_GetOpaque(val, js_node_hash_class_id);
    if (h) {
        if (h->ctx) EVP_MD_CTX_free(h->ctx);
        js_free_rt(rt, h);
    }
}

static const JSClassDef js_node_hash_class = {
    "Hash", .finalizer = js_node_hash_finalizer,
};
```

**Step 3: Constructor — `new Sha256()` etc.**

```c
static JSValue js_node_hash_ctor(JSContext *ctx, JSValueConst new_target,
                                 int argc, JSValueConst *argv,
                                 const EVP_MD *md) {
    JSNodeHash *h = js_malloc(ctx, sizeof(*h));
    if (!h) return JS_EXCEPTION;
    h->ctx = EVP_MD_CTX_new();
    h->md = md;
    h->finalized = 0;
    if (!h->ctx || EVP_DigestInit_ex(h->ctx, md, NULL) != 1) {
        if (h->ctx) EVP_MD_CTX_free(h->ctx);
        js_free(ctx, h);
        return JS_ThrowInternalError(ctx, "EVP_DigestInit_ex failed");
    }
    JSValue obj = JS_NewObjectClass(ctx, js_node_hash_class_id);
    if (JS_IsException(obj)) {
        EVP_MD_CTX_free(h->ctx);
        js_free(ctx, h);
        return obj;
    }
    JS_SetOpaque(obj, h);
    return obj;
}

#define DEFINE_CTOR(name, evp)                                              \
    static JSValue js_node_hash_##name(JSContext *ctx, JSValueConst nt,     \
                                       int argc, JSValueConst *argv) {     \
        return js_node_hash_ctor(ctx, nt, argc, argv, evp());               \
    }

DEFINE_CTOR(sha1,   EVP_sha1)
DEFINE_CTOR(sha256, EVP_sha256)
DEFINE_CTOR(sha512, EVP_sha512)
DEFINE_CTOR(md5,    EVP_md5)
```

**Step 4: `update(buf)` — feed bytes.**

```c
static JSValue js_node_hash_update(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv) {
    JSNodeHash *h = JS_GetOpaque(this_val, js_node_hash_class_id);
    if (!h || h->finalized) return JS_ThrowTypeError(ctx, "invalid Hash state");

    size_t size;
    uint8_t *data = JS_GetArrayBuffer(ctx, &size, argv[0]);
    if (!data) {
        /* Maybe a typed array view */
        JSValue ab = JS_GetTypedArrayBuffer(ctx, argv[0], NULL, &size, NULL);
        if (JS_IsException(ab)) return ab;
        data = JS_GetArrayBuffer(ctx, &size, ab);
        JS_FreeValue(ctx, ab);
    }
    if (!data) return JS_ThrowTypeError(ctx, "Hash.update: expected ArrayBuffer or view");

    if (EVP_DigestUpdate(h->ctx, data, size) != 1)
        return JS_ThrowInternalError(ctx, "EVP_DigestUpdate failed");
    return JS_DupValue(ctx, this_val); /* chainable */
}
```

**Step 5: `digest(encoding?)` — finalize and return.**

```c
static JSValue js_node_hash_digest(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv) {
    JSNodeHash *h = JS_GetOpaque(this_val, js_node_hash_class_id);
    if (!h || h->finalized) return JS_ThrowTypeError(ctx, "invalid Hash state");

    uint8_t out[EVP_MAX_MD_SIZE];
    unsigned int out_len = 0;
    if (EVP_DigestFinal_ex(h->ctx, out, &out_len) != 1)
        return JS_ThrowInternalError(ctx, "EVP_DigestFinal_ex failed");
    h->finalized = 1;

    if (argc < 1 || JS_IsUndefined(argv[0])) {
        /* No encoding: return raw bytes as ArrayBuffer */
        return JS_NewArrayBufferCopy(ctx, out, out_len);
    }
    const char *enc = JS_ToCString(ctx, argv[0]);
    if (!enc) return JS_EXCEPTION;
    JSValue result;
    if (strcmp(enc, "hex") == 0) {
        char *hex = js_malloc(ctx, out_len * 2 + 1);
        for (unsigned i = 0; i < out_len; i++)
            snprintf(hex + i * 2, 3, "%02x", out[i]);
        result = JS_NewString(ctx, hex);
        js_free(ctx, hex);
    } else if (strcmp(enc, "base64") == 0) {
        /* Use OpenSSL's BIO base64 — see EVP_EncodeBlock for one-shot */
        size_t b64_len = 4 * ((out_len + 2) / 3);
        char *b64 = js_malloc(ctx, b64_len + 1);
        EVP_EncodeBlock((unsigned char *)b64, out, (int)out_len);
        b64[b64_len] = 0;
        result = JS_NewString(ctx, b64);
        js_free(ctx, b64);
    } else {
        result = JS_ThrowTypeError(ctx, "unsupported encoding: %s", enc);
    }
    JS_FreeCString(ctx, enc);
    return result;
}
```

**Step 6: HMAC — `Hmac(algo, key)` class.**

Mirrors `Hash` but uses `EVP_MAC` / `EVP_MAC_CTX`. Pseudocode:

```c
static JSValue js_node_hmac_ctor(JSContext *ctx, JSValueConst nt,
                                 int argc, JSValueConst *argv) {
    /* argv[0] = algo string ("sha256"), argv[1] = key (ArrayBuffer or view) */
    /* EVP_MAC_fetch + EVP_MAC_CTX_new + EVP_MAC_init */
    ...
}
```

Drop in HMAC sha1/sha256/sha512 as a single `Hmac` class parameterized by algo string (Node's `crypto.createHmac` API takes the algo by name). Uses `EVP_MAC_fetch(NULL, "HMAC", NULL)`.

**Step 7: Class + constructor registration via `js_node_hash_register`.**

```c
static const JSCFunctionListEntry js_node_hash_proto_funcs[] = {
    JS_CFUNC_DEF("update", 1, js_node_hash_update),
    JS_CFUNC_DEF("digest", 1, js_node_hash_digest),
};

int js_node_hash_register(JSContext *ctx, JSModuleDef *m) {
    if (!m) {
        /* Phase 1 of init — just declare the exports. */
        JS_AddModuleExport(ctx, m, "Sha1");
        JS_AddModuleExport(ctx, m, "Sha256");
        JS_AddModuleExport(ctx, m, "Sha512");
        JS_AddModuleExport(ctx, m, "Md5");
        JS_AddModuleExport(ctx, m, "Hmac");
        return 0;
    }
    /* Phase 2 — populate. */
    JS_NewClassID(&js_node_hash_class_id);
    JS_NewClass(JS_GetRuntime(ctx), js_node_hash_class_id, &js_node_hash_class);

    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, js_node_hash_proto_funcs,
                               countof(js_node_hash_proto_funcs));
    JS_SetClassProto(ctx, js_node_hash_class_id, proto);

#define EXPORT(name, fn)                                                    \
    do {                                                                    \
        JSValue ctor = JS_NewCFunction2(ctx, fn, name, 0,                    \
                                        JS_CFUNC_constructor, 0);            \
        JS_SetConstructor(ctx, ctor, JS_DupValue(ctx, proto));               \
        JS_SetModuleExport(ctx, m, name, ctor);                              \
    } while (0)
    EXPORT("Sha1",   js_node_hash_sha1);
    EXPORT("Sha256", js_node_hash_sha256);
    EXPORT("Sha512", js_node_hash_sha512);
    EXPORT("Md5",    js_node_hash_md5);
    /* Hmac registered similarly */
#undef EXPORT
    return 0;
}
```

(Note the two-phase pattern: `js_init_module_node` calls `js_node_hash_register(ctx, NULL)` to declare exports; `js_node_init` calls it with the populated `m`. Refactor to take a phase flag if cleaner — what matters is QuickJS's `JS_AddModuleExport` runs before `JS_SetModuleExport`.)

### Task 1.3 — Wire `qjs:node` into `node-main.c`

**Files:**
- Modify: `examples/libs/quickjs/node-main.c`

**Step 1: Include the new header (top of file, after `quickjs-libc.h`).**
```c
#include "node-compat-native/node-native.h"
```

**Step 2: Register the module after std/os/bjson.**

Find the block (current lines 49–51):
```c
    js_init_module_std(ctx, "qjs:std");
    js_init_module_os(ctx, "qjs:os");
    js_init_module_bjson(ctx, "qjs:bjson");
```

Append:
```c
    js_init_module_node(ctx, "qjs:node");
```

### Task 1.4 — Bootstrap-side wiring: stitch `globalThis._nodeNative` from `qjs:node`

**Files:**
- Modify: `examples/libs/quickjs/node-compat/bootstrap.js`

**Step 1: Top of the bootstrap (after the existing `qjs:os` / `qjs:std` imports), add:**

```js
// Native bindings — present when the qjs:node native module is registered.
let _nodeNative;
try {
    const nodeMod = await import('qjs:node');
    _nodeNative = {
        hash: {
            Sha1:   nodeMod.Sha1,
            Sha256: nodeMod.Sha256,
            Sha512: nodeMod.Sha512,
            Md5:    nodeMod.Md5,
            Hmac:   nodeMod.Hmac,
        },
        // zlib, socket, tls — populated by their respective phases.
    };
    globalThis._nodeNative = _nodeNative;
} catch (e) {
    // Phase 0/early bootstrap may not have qjs:node — leave _nodeNative undefined.
    // bootstrap.js falls back to its existing stubs.
}
```

If top-level await isn't available in the bytecode-compiled context, hoist this into an IIFE returning a promise and resolve before the rest of bootstrap runs. (QuickJS-NG supports module-level await in modules; bootstrap is compiled with `qjsc -m`.)

**Step 2: Patch `crypto.createHash` (current L2115–2134).**

Replace:
```js
    function createHash(algorithm) {
        const chunks = [];
        return {
            update(data) { ... },
            digest(encoding) {
                // TODO: implement actual hashing
                ...
            },
        };
    }
```

With:
```js
    function createHash(algorithm) {
        if (globalThis._nodeNative && globalThis._nodeNative.hash) {
            const cls = {
                'sha1': _nodeNative.hash.Sha1,
                'sha256': _nodeNative.hash.Sha256,
                'sha512': _nodeNative.hash.Sha512,
                'md5': _nodeNative.hash.Md5,
            }[String(algorithm).toLowerCase()];
            if (!cls) throw new Error(`Unsupported hash algorithm: ${algorithm}`);
            const inner = new cls();
            return {
                update(data) {
                    const buf = typeof data === 'string'
                        ? Buffer.from(data).buffer
                        : (data instanceof ArrayBuffer ? data : data.buffer);
                    inner.update(buf);
                    return this;
                },
                digest(encoding) {
                    const out = inner.digest(encoding);
                    return encoding ? out : Buffer.from(out);
                },
            };
        }
        // Fallback: keep the XOR stub for environments without qjs:node
        // ...existing stub code...
    }
```

**Step 3: Patch `crypto.createHmac` (current L2136–2138).**

Same pattern: prefer `_nodeNative.hash.Hmac`, fall back to current stub.

### Task 1.5 — Update `build-quickjs.sh` to compile + link `node-compat-native`

**Files:**
- Modify: `examples/libs/quickjs/build-quickjs.sh`

**Step 1: Path constants** (near `SRC_DIR`):
```bash
NATIVE_DIR="$SCRIPT_DIR/node-compat-native"
OPENSSL_INSTALL="$REPO_ROOT/examples/libs/openssl/openssl-install"
OPENSSL_INCLUDE="$OPENSSL_INSTALL/include"
OPENSSL_LIB="$OPENSSL_INSTALL/lib"
```

**Step 2: Compile native sources** (after Step 5 — node CLI compile, before link):
```bash
echo "Compiling node-compat-native (qjs:node)..."
NATIVE_OBJS=()
for src in node-native.c hash.c; do
    obj="$BIN_DIR/$(basename "${src%.c}.o")"
    $CC "${CFLAGS[@]}" -I"$OPENSSL_INCLUDE" \
        -c "$NATIVE_DIR/$src" -o "$obj"
    NATIVE_OBJS+=("$obj")
done
```

**Step 3: Append to node link.**
```bash
echo "Linking node..."
$CC "${NODE_OBJS[@]}" "${NATIVE_OBJS[@]}" "${OBJS[@]}" \
    -L"$OPENSSL_LIB" -lcrypto \
    -lm -o "$BIN_DIR/node.wasm"
```

**Step 4: Guard the OpenSSL dependency.**
```bash
if [ ! -f "$OPENSSL_LIB/libcrypto.a" ]; then
    echo "ERROR: libcrypto.a not found. Run examples/libs/openssl/build-openssl.sh first."
    exit 1
fi
```

**Step 5:** Phase 1 only patches `node.wasm`. `qjs.wasm` does not need OpenSSL — leave its build path unchanged.

### Task 1.6 — Test vectors

**Files:**
- Modify: `host/test/node-compat.test.ts`

Add a `describe('crypto', ...)` block. Cover NIST-vectored SHA-1 / SHA-256 / SHA-512 / MD5, plus HMAC-SHA-256 with a known key.

```ts
describe.skipIf(!HAS_NODE)('node.wasm — crypto', () => {
  it.each([
    ['sha1',   '',           'da39a3ee5e6b4b0d3255bfef95601890afd80709'],
    ['sha256', '',           'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['sha256', 'abc',        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['sha512', '',           'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e'],
    ['md5',    '',           'd41d8cd98f00b204e9800998ecf8427e'],
  ])('%s("%s") === %s', async (algo, input, expected) => {
    const r = await runCentralizedProgram({
      programPath: NODE,
      argv: ['node', '-e',
        `console.log(require('crypto').createHash('${algo}').update(${JSON.stringify(input)}).digest('hex'))`,
      ],
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(expected);
  });

  it('hmac-sha256 with key matches reference vector', async () => {
    const r = await runCentralizedProgram({
      programPath: NODE,
      argv: ['node', '-e',
        `const h = require('crypto').createHmac('sha256', 'key');
         console.log(h.update('The quick brown fox jumps over the lazy dog').digest('hex'))`,
      ],
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(
      'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8'
    );
  });
});
```

### Task 1.7 — Verification gauntlet

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
bash scripts/check-abi-version.sh
```

`ABI_VERSION` does **not** bump (no kernel surface touched).

### Task 1.8 — Commit & PR

```bash
git checkout -b feat-quickjs-node-hashing origin/main
git add examples/libs/quickjs/node-compat-native/
git add examples/libs/quickjs/build-quickjs.sh
git add examples/libs/quickjs/node-main.c
git add examples/libs/quickjs/node-compat/bootstrap.js
git add host/test/node-compat.test.ts
git commit -m "feat(quickjs-node): real SHA-256/512 via libcrypto"
git push -u origin feat-quickjs-node-hashing
gh pr create --base main --title "feat(quickjs-node): real SHA-256/512 via libcrypto" --body "..."
```

PR body:
```
## Summary

Replaces the XOR stub in bootstrap.js's `crypto.createHash` (L2089–2148)
with real OpenSSL-backed SHA-1/256/512, MD5, and HMAC. Adds the
`qjs:node` native module — first of four namespaces (hash, zlib,
socket, tls). bootstrap.js falls back to the prior stub if the module
isn't registered (e.g. partial builds without OpenSSL).

## Test plan

- [ ] `(cd host && npx vitest run test/node-compat.test.ts)` — crypto block all green
- [ ] All 5 verification suites pass per CLAUDE.md
- [ ] ABI snapshot — clean (no kernel surface touched)
- [ ] node.wasm size growth ≤ ~250 KB (libcrypto static link)
```

---

## Phase 2 — Compression — `feat(quickjs-node): real gzip/inflate via libz`

**Goal:** Replace bootstrap.js's pass-through `zlib` (L2284–2293) with real libz inflate / deflate. Unlocks tarball extraction in Phase 5.

**Estimate:** 2–3 days.

**Acceptance:**
```js
zlib.gunzipSync(fs.readFileSync('lodash-4.17.21.tgz'))
// → first 5 bytes are "packa" (start of "package/" tar header)
```

### Task 2.1 — `zlib.c`: Inflate / Deflate / Gzip / Gunzip classes + sync helpers

**Files:**
- Create: `examples/libs/quickjs/node-compat-native/zlib.c`

**Design:**
- One opaque class `ZlibStream` with `mode` (deflate vs inflate) and `format` (raw / zlib / gzip).
- Methods: `write(buf, finalFlag)` → returns ArrayBuffer of output, `end()` → final flush + close.
- One-shot helpers: `inflateSync`, `deflateSync`, `gzipSync`, `gunzipSync` exported as standalone functions for the `*Sync` Node API. These wrap the streaming class internally.

**Step 1: Includes + class definition.**

```c
#include <zlib.h>
#include <string.h>
#include "node-native.h"

static JSClassID js_node_zlib_class_id;

typedef struct {
    z_stream zs;
    int mode;     /* 0 = deflate, 1 = inflate */
    int finished;
} JSNodeZlib;
```

**Step 2: Constructor + finalizer.**

Constructor takes `(format, level?)` where `format ∈ {'raw', 'deflate', 'gzip'}` (windowBits = -15 / 15 / 31). Finalizer calls `deflateEnd` / `inflateEnd`.

**Step 3: `write(input, finalFlag)`.**

Inputs as ArrayBuffer or view. Loops calling `deflate` / `inflate` with growing output buffer until `Z_STREAM_END` (when final) or `avail_in == 0`. Returns concatenated output as ArrayBuffer.

**Step 4: One-shot wrappers.**

```c
static JSValue js_node_zlib_gunzipSync(JSContext *ctx, JSValueConst this_val,
                                       int argc, JSValueConst *argv) {
    /* Internally: new JSNodeZlib(inflate, gzip-windowBits=31), write(input, true) */
}
```

Plus `gzipSync`, `inflateSync`, `deflateSync` (mirrored).

**Step 5: Module export registration.**

`js_node_zlib_register(ctx, m)` — same two-phase pattern as `hash`. Exports: `Inflate`, `Deflate`, `Gzip`, `Gunzip`, `inflateSync`, `deflateSync`, `gzipSync`, `gunzipSync`.

### Task 2.2 — Wire `js_node_zlib_register` into `node-native.c`

**Files:**
- Modify: `examples/libs/quickjs/node-compat-native/node-native.c`

```c
extern int js_node_zlib_register(JSContext *ctx, JSModuleDef *m);

static int js_node_init(JSContext *ctx, JSModuleDef *m) {
    js_node_hash_register(ctx, m);
    js_node_zlib_register(ctx, m);
    return 0;
}

JSModuleDef *js_init_module_node(JSContext *ctx, const char *module_name) {
    JSModuleDef *m = JS_NewCModule(ctx, module_name, js_node_init);
    if (!m) return NULL;
    js_node_hash_register(ctx, NULL);   /* declare-only path: m=NULL */
    js_node_zlib_register(ctx, NULL);
    return m;
}
```

(Adjust `js_node_*_register` to accept `m == NULL` as the declare phase.)

### Task 2.3 — Patch bootstrap.js zlib stubs (L2284–2293)

**Files:**
- Modify: `examples/libs/quickjs/node-compat/bootstrap.js`

**Step 1: Extend the early `_nodeNative` import to include zlib.**

```js
_nodeNative.zlib = {
    Inflate: nodeMod.Inflate,
    Deflate: nodeMod.Deflate,
    Gzip:    nodeMod.Gzip,
    Gunzip:  nodeMod.Gunzip,
    inflateSync: nodeMod.inflateSync,
    deflateSync: nodeMod.deflateSync,
    gzipSync:    nodeMod.gzipSync,
    gunzipSync:  nodeMod.gunzipSync,
};
```

**Step 2: Replace the `zlib` builtin entry (L2284–2293).**

```js
'zlib': (() => {
    if (globalThis._nodeNative && _nodeNative.zlib) {
        const z = _nodeNative.zlib;
        const wrap = (Cls) => class extends stream.Transform {
            constructor(opts) {
                super(opts);
                this._inner = new Cls(opts?.windowBits ? 'raw' : 'gzip');
            }
            _transform(chunk, _enc, cb) {
                cb(null, Buffer.from(this._inner.write(chunk.buffer ?? chunk, false)));
            }
            _flush(cb) {
                cb(null, Buffer.from(this._inner.write(new ArrayBuffer(0), true)));
            }
        };
        return {
            createGzip:    () => new (wrap(z.Gzip))(),
            createGunzip:  () => new (wrap(z.Gunzip))(),
            createDeflate: () => new (wrap(z.Deflate))(),
            createInflate: () => new (wrap(z.Inflate))(),
            gzipSync:    (b) => Buffer.from(z.gzipSync(b.buffer ?? b)),
            gunzipSync:  (b) => Buffer.from(z.gunzipSync(b.buffer ?? b)),
            deflateSync: (b) => Buffer.from(z.deflateSync(b.buffer ?? b)),
            inflateSync: (b) => Buffer.from(z.inflateSync(b.buffer ?? b)),
        };
    }
    /* fall back to PassThrough stubs */
    return { /* original stub object */ };
})(),
```

### Task 2.4 — Update `build-quickjs.sh` for libz

**Files:**
- Modify: `examples/libs/quickjs/build-quickjs.sh`

**Step 1: Path constants.**
```bash
ZLIB_INSTALL="$REPO_ROOT/examples/libs/zlib/zlib-install"
ZLIB_INCLUDE="$ZLIB_INSTALL/include"
ZLIB_LIB="$ZLIB_INSTALL/lib"
```

**Step 2: Add `zlib.c` to the native sources list.**
```bash
for src in node-native.c hash.c zlib.c; do
    obj="$BIN_DIR/$(basename "${src%.c}.o")"
    $CC "${CFLAGS[@]}" -I"$OPENSSL_INCLUDE" -I"$ZLIB_INCLUDE" \
        -c "$NATIVE_DIR/$src" -o "$obj"
    NATIVE_OBJS+=("$obj")
done
```

**Step 3: Add `-lz` to the node link.**
```bash
$CC "${NODE_OBJS[@]}" "${NATIVE_OBJS[@]}" "${OBJS[@]}" \
    -L"$OPENSSL_LIB" -lcrypto \
    -L"$ZLIB_LIB" -lz \
    -lm -o "$BIN_DIR/node.wasm"
```

**Step 4: Guard libz dependency.**

### Task 2.5 — Tests

**Files:**
- Modify: `host/test/node-compat.test.ts`

Add a `describe('zlib', ...)` block:
```ts
it('roundtrip: gzipSync + gunzipSync', async () => {
  const r = await runCentralizedProgram({
    programPath: NODE,
    argv: ['node', '-e', `
      const zlib = require('zlib');
      const input = Buffer.from('hello world');
      const gz = zlib.gzipSync(input);
      const out = zlib.gunzipSync(gz);
      console.log(out.toString());
    `],
  });
  expect(r.stdout.trim()).toBe('hello world');
});

it('decompresses lodash tarball — first entry is package/', async () => {
  // Tarball pre-fetched into a fixtures dir at test setup time.
  // Confirms the .tgz parses (gzip header + tar magic).
  ...
});
```

### Task 2.6 — Verification gauntlet & commit

Same 5-suite gauntlet. PR body mirrors Phase 1's structure.

---

## Phase 3 — Sockets + event-loop integration — `feat(quickjs-node): real AF_INET sockets + event-loop fd-watch` ★ DESIGN RISK

**Goal:** Replace `net.Socket` (L2152–2222) with a real Duplex stream over an AF_INET socket fd. Add an fd-watch table to the QuickJS event loop so reads progress without blocking.

**Estimate:** 1–1.5 weeks. This is the spike phase — risk lives here.

**Acceptance:**
```js
require('net').connect(80, 'example.com').on('connect', () => {
  /* writes "GET / HTTP/1.0\r\n\r\n", reads back HTML */
});
```

### Risks (worth re-stating up front)

1. **`js_std_loop` may not be extensible.** QuickJS-NG's main loop pumps `os.setTimeout` and `os.signal` only. It doesn't expose a hook for external pollables. If patching the upstream loop is unacceptable, fork the loop into our native module (`js_std_loop_with_fdwatch`) and have `node-main.c` call ours instead.
2. **Asyncify × callbacks.** `node.wasm` is asyncified for `kernel_fork`. If a socket callback fires while a fork is mid-flight, asyncify state must be coherent. Mitigation: forbid `fork()` from inside socket callbacks; surface as `EAGAIN` if attempted.
3. **Backpressure.** Writes to a full kernel pipe return `EAGAIN`. The JS-side `Socket._write` must queue and retry on the next loop iteration.
4. **Reentrancy.** Socket callbacks must not re-enter a syscall that's still suspended.

### Task 3.1 — `socket.c`: low-level fd bindings

**Files:**
- Create: `examples/libs/quickjs/node-compat-native/socket.c`

**API surface** (raw fd-shaped, intentionally not Node-shaped — Node API lives in bootstrap.js):

| JS function | Calls |
|---|---|
| `connect(host, port)` (returns `Promise<fd>`) | `getaddrinfo` + `socket(AF_INET, SOCK_STREAM)` + `connect()` |
| `read(fd, n)` (returns `Promise<ArrayBuffer>`) | non-blocking `read`, registers fd with watch table on `EAGAIN` |
| `write(fd, buf)` (returns `Promise<n>`) | non-blocking `write`, queues on `EAGAIN` |
| `close(fd)` | `close` syscall + watch-table cleanup |

The `Promise` returns are surfaced via QuickJS's `JS_NewPromiseCapability`.

**Step 1: fd-watch table + structures.**

```c
typedef enum { WATCH_NONE = 0, WATCH_READ = 1, WATCH_WRITE = 2 } WatchKind;

typedef struct WatchEntry {
    int fd;
    WatchKind kind;
    JSValue resolve;     /* promise resolution funcs */
    JSValue reject;
    JSContext *ctx;
    /* For read: target buffer + max length. For write: source + length, offset. */
    void *buf;
    size_t buf_len;
    size_t buf_off;
    struct WatchEntry *next;
} WatchEntry;

static WatchEntry *watch_head = NULL;  /* singly-linked list */
```

**Step 2: `connect(host, port)` — uses kernel `getaddrinfo`.**

Call `getaddrinfo(host, NULL, hints, &res)`, pick first `AF_INET` answer, create socket with `SOCK_NONBLOCK`, call `connect()`. If `EINPROGRESS`, register fd for write-readiness; on writable, check `SO_ERROR`. Resolve / reject promise accordingly.

**Step 3: `read(fd, n)`.**

Allocate `n`-byte buffer. Try non-blocking `read()`. If success → resolve with ArrayBuffer. If `EAGAIN` → register fd for read-readiness, queue resolution. If `0` → resolve with empty ArrayBuffer (EOF).

**Step 4: `write(fd, buf)`.**

Try non-blocking `write()`. Track `buf_off`; if partial, register fd for write-readiness and continue on next dispatch.

**Step 5: `close(fd)`.**

Walk watch list, reject any pending promises with `Error('socket closed')`, call `close()`, free entries.

**Step 6: poll + dispatch entry point.**

```c
/* Called from the patched js_std_loop on each iteration. */
int js_node_socket_dispatch(JSContext *ctx, int timeout_ms) {
    /* Build pollfd[] from watch_head */
    int n = poll(fds, count, timeout_ms);
    /* For each ready fd: complete read / complete connect / drain write queue */
    /* Resolve / reject promises; free entries */
    return n;
}
```

### Task 3.2 — Patch `js_std_loop` (or fork it)

**Files:**
- Modify (or create): `examples/libs/quickjs/node-main.c` — call `js_node_socket_dispatch` in the main loop

**Approach (preferred — fork the loop):**

QuickJS's `js_std_loop` lives in `quickjs-libc.c`. We don't fork that file; we copy its body into a new function in `node-main.c` and call our `js_node_socket_dispatch` between timer dispatches.

```c
static int js_node_loop(JSContext *ctx) {
    JSRuntime *rt = JS_GetRuntime(ctx);
    JSValue err;

    for (;;) {
        /* Run pending jobs (microtasks). */
        for (;;) {
            int r = JS_ExecutePendingJob(rt, &err_ctx);
            if (r <= 0) {
                if (r < 0) /* error */ js_std_dump_error(ctx);
                break;
            }
        }
        /* Run our fd-watch dispatch with computed timeout. */
        int timeout_ms = js_node_compute_timeout(ctx);  /* derived from os.setTimeout queue */
        if (js_node_socket_dispatch(ctx, timeout_ms) == 0
            && js_node_no_pending_work(ctx)) {
            break;
        }
    }
    return 0;
}
```

Replace the `js_std_loop(ctx)` call near the end of `node-main.c`'s `main()` with `js_node_loop(ctx)`.

### Task 3.3 — Bootstrap-side: real `net.Socket`

**Files:**
- Modify: `examples/libs/quickjs/node-compat/bootstrap.js`

Replace the entire `net` IIFE (L2152–2222). New `Socket` extends `stream.Duplex`, holds `_fd`, drives reads and writes via `_nodeNative.socket.read` / `.write` / `.close`.

```js
class Socket extends stream.Duplex {
    constructor(opts) {
        super(opts);
        this._fd = opts?.fd ?? -1;
    }
    connect(port, host, cb) {
        if (typeof host === 'function') { cb = host; host = 'localhost'; }
        if (cb) this.once('connect', cb);
        _nodeNative.socket.connect(host, port).then(
            (fd) => {
                this._fd = fd;
                this.connecting = false;
                this.emit('connect');
                this._scheduleRead();
            },
            (err) => this.destroy(err),
        );
        this.connecting = true;
        return this;
    }
    _scheduleRead() {
        if (this._fd < 0 || this._destroyed) return;
        _nodeNative.socket.read(this._fd, 64 * 1024).then(
            (ab) => {
                if (ab.byteLength === 0) {
                    this.push(null); /* EOF */
                    return;
                }
                this.push(Buffer.from(ab));
                this._scheduleRead();
            },
            (err) => this.destroy(err),
        );
    }
    _read() { /* readable side pulls; we proactively schedule */ }
    _write(chunk, _enc, cb) {
        _nodeNative.socket.write(this._fd, chunk.buffer ?? chunk).then(
            () => cb(null),
            cb,
        );
    }
    _destroy(err, cb) {
        if (this._fd >= 0) _nodeNative.socket.close(this._fd);
        this._destroyed = true;
        cb(err);
    }
}
```

### Task 3.4 — Wire `socket` into the build

**Files:**
- Modify: `examples/libs/quickjs/build-quickjs.sh`

Add `socket.c` to native sources. No new linker flags — sockets are syscalls, our musl provides them.

### Task 3.5 — Tests

**Files:**
- Create: `host/test/quickjs-node-net.test.ts`

Tests:
1. `net.connect` to a local server (vitest spins up a TCP server on `localhost`, asserts the byte echo).
2. EOF detection: server closes after 1 byte, client sees `'end'`.
3. Backpressure: server reads slowly; client's `write()` accumulates and drains.
4. Concurrent: 4 sockets in flight to the same local server, all complete.

These tests don't need real internet — vitest's local server is enough.

### Task 3.6 — Verification gauntlet & commit

Same 5-suite gauntlet. The PR almost certainly bumps `node.wasm` size by ~5–10 KB. No `ABI_VERSION` bump (sockets and `getaddrinfo` are pre-existing kernel surface).

---

## Phase 4 — TLS — `feat(quickjs-node): TLS via OpenSSL — https.get works`

**Goal:** Real `https`. Layer libssl over the AF_INET sockets from Phase 3.

**Estimate:** 1 week.

**Acceptance:**
```js
require('https').get('https://registry.npmjs.org/lodash/4.17.21', r => {
  let buf = '';
  r.on('data', d => buf += d);
  r.on('end', () => console.log(JSON.parse(buf).version)); // "4.17.21"
});
```

### Task 4.1 — Ship `cacert.pem` in the kernel VFS

**Files:**
- Create: `host/wasm/etc/ssl/cert.pem` (or wherever the kernel VFS image is staged)
- Modify: kernel VFS image build — include `cacert.pem` at `/etc/ssl/cert.pem`

**Source:** Mozilla's curated bundle from <https://curl.se/ca/cacert.pem>. Vendored in-tree (not fetched at build) — pin a date.

Confirm OpenSSL probes `/etc/ssl/cert.pem`:
```bash
strings examples/libs/openssl/openssl-install/lib/libcrypto.a | grep -E "/etc/ssl"
```

### Task 4.2 — `tls.c`: TlsSocket wrapper

**Files:**
- Create: `examples/libs/quickjs/node-compat-native/tls.c`

**Design:** Takes an existing fd (from socket.c) + hostname for SNI. Runs `SSL_set_fd`, `SSL_connect`. Then exposes `read` / `write` over `SSL_read` / `SSL_write` on the same fd.

**Important pieces:**
- `SSL_CTX *` shared across all TLS sockets (cached at first use). `SSL_CTX_set_default_verify_paths` to use `/etc/ssl/cert.pem`.
- `SNI`: `SSL_set_tlsext_host_name(ssl, hostname)`.
- Cert verify on by default. Fail closed on bad chain.
- Non-blocking handshake: `SSL_connect` returning `SSL_ERROR_WANT_READ` / `WANT_WRITE` registers the underlying fd in the watch table from Phase 3 — same dispatch loop drives both raw sockets and TLS handshakes.

```c
typedef struct {
    SSL *ssl;
    int fd;
    int handshake_done;
} JSNodeTls;
```

`js_node_tls_register` exports: `connect(fd, hostname) -> Promise<TlsHandle>`, `read(handle, n)`, `write(handle, buf)`, `close(handle)`.

### Task 4.3 — Bootstrap-side: split `https` from `http`

**Files:**
- Modify: `examples/libs/quickjs/node-compat/bootstrap.js`

Currently `https = http` (alias at L2283). Split:

1. Implement a real `http` module on top of `net` (HTTP/1.1 framing, chunked encoding, pipelining-light) — ~200 LOC. This was a TODO until Phase 3 made `net` real.
2. `https` wraps the `net.Socket` instance in a `tls.connect()` call before handing it to the HTTP parser.

The `http` work isn't trivial — it's its own ~200-line block. Plan:
- HTTP/1.1 request line + headers serialization
- Response parser: status line, headers (case-insensitive), body
- Body modes: `Content-Length`, `Transfer-Encoding: chunked`, connection close
- Streaming via `stream.Readable` for the response body
- `request.write()` / `.end()` for upload bodies
- 301 / 302 redirects: follow up to N hops

### Task 4.4 — Update build for libssl

**Files:**
- Modify: `examples/libs/quickjs/build-quickjs.sh`

Append `tls.c` to native sources. Link `-lssl` (already have `-lcrypto`).

### Task 4.5 — Tests

**Files:**
- Create: `host/test/quickjs-node-https.test.ts`

Tests (use vitest's TLS server fixture, not the public internet):
1. `https.get` to a local TLS server with a self-signed cert (tests need to trust the local CA — fixture writes it to `/etc/ssl/cert.pem` in the VFS at test setup).
2. Handles redirects.
3. `Content-Length` body parsing.
4. `Transfer-Encoding: chunked` body parsing.
5. Bad cert → fail (doesn't silently succeed).

A separate **manual** test (not in CI by default) hits `https://registry.npmjs.org/lodash/4.17.21` — this is the design's stated acceptance.

### Task 4.6 — Verification gauntlet & commit

`node.wasm` likely jumps ~1.5 MB on this PR (libssl static link). Document in PR body.

---

## Phase 5 — npm bootstrap — `feat(quickjs-node): npm install of zero-dep package`

**Goal:** Bundle npm itself into the kernel VFS, get `npm install lodash` to exit 0 against a fresh node_modules.

**Estimate:** 1–2 weeks. **Exploratory** — surfaces gaps we patch as we hit them.

**Acceptance:** `npm install lodash` from a fresh tmp directory exits 0; `node_modules/lodash/package.json` has `"version": "4.17.21"` (or whatever current).

### Task 5.1 — Bundle npm into the kernel VFS

npm 10.x is ~12 MB unpacked of pure JS (no native runtime deps). Ship as a lazy archive (same pattern as vim / nethack — see `docs/plans/2026-04-20-nethack-shell-demo-design.md`).

**Files:**
- Create: build script under `scripts/` to download a pinned npm tarball, validate sha256, unpack
- Modify: kernel VFS image build to include the unpacked npm tree (or the .zip + lazy-extract plumbing)

Pin a single npm version. Document in `docs/porting-guide.md`.

### Task 5.2 — `package.json exports` field resolution in CommonJS

**Files:**
- Modify: `examples/libs/quickjs/node-compat/bootstrap.js` — `_resolveFile` (around L2369–2480)

Implement `package.json#exports` lookup:
1. If `exports` is a string → use it
2. If `exports['.']` exists → resolve subpath `.`
3. If `exports[subpath]` exists → resolve subpath (`./util`, `./package.json`, etc.)
4. Fall back to `main` field (current behaviour)
5. Conditional exports: `default`, `node`, `import`, `require` — pick `require` for CJS path, `import` for ESM path.

This is a real Node feature; spec at <https://nodejs.org/api/packages.html#exports>. Implement enough to handle the npm + lodash + chalk class of packages.

### Task 5.3 — Surface gaps as errors, not silent failures

When npm hits an unimplemented Node API, surface a clean stack trace. Catch and patch each one in bootstrap.js. Expect ~5–15 small bootstrap.js patches as part of this PR.

### Task 5.4 — Tests

**Files:**
- Create: `host/test/quickjs-node-npm.test.ts`

```ts
it('npm install lodash → exit 0', async () => {
  const tmp = mkdtempSync('/tmp/npm-test-');
  writeFileSync(join(tmp, 'package.json'), '{"name":"t","version":"0.0.1"}');
  const r = await runCentralizedProgram({
    programPath: NODE,
    argv: ['node', '/usr/lib/npm/bin/npm-cli.js', 'install', 'lodash'],
    cwd: tmp,
  });
  expect(r.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(join(tmp, 'node_modules/lodash/package.json'),
    'utf8')).version).toMatch(/^4\./);
});
```

### Task 5.5 — Verification & commit

The PR may surface unexpected long-tail issues (postinstall, bin links). Iterate. Ship when lodash works end-to-end.

---

## Phase 6 — Real-world multi-dep — `feat(quickjs-node): npm install of express + vite`

**Goal:** Run `npm install` against `express` (~30 deps), then `vite` (~50 deps with bin links and postinstall). Catch and fix surfaced gaps.

**Estimate:** 1–2 weeks. **Exploratory** — every failed dep teaches us something.

**Acceptance:** `node_modules/.bin/vite --help` runs.

### Task 6.1 — `express` first

`npm install express` exercises:
- Multi-dep tree resolution
- Postinstall hooks
- bin links
- File modes (`chmod +x` on bin scripts)

Iterate on bootstrap.js until exit 0. Each fix is a focused commit; the whole batch is one PR if small enough, or split into two if a single change is large (e.g. bin-links subsystem).

### Task 6.2 — `vite`

vite tests:
- Native-addon-adjacent territory (esbuild, rollup, @swc/core have native bindings)
- If vite chokes on a missing `.node` file, this is the design's documented v1 non-goal — surface it cleanly, document, move on.

### Task 6.3 — Document known limitations

**Files:**
- Modify: `docs/porting-guide.md` — add a "QuickJS Node compat: known npm-install limitations" section

List packages that fail and why (native addons, worker_threads, etc.). Set expectations; reference the design doc's non-goals.

### Task 6.4 — Verification & commit

---

## Phase 7+ — Decision point

**Goal:** Decide whether QuickJS-NG is fit-for-purpose for the long term, or whether the SpiderMonkey-jitless escape hatch becomes necessary.

### When to consider switching

1. **Performance cliff.** If `npm install lodash` takes > 5 minutes after Phase 5, QuickJS may simply be too slow.
2. **ES2024+ feature gaps.** If real-world deps use decorators, `using` declarations, or RegExp `v` flag features that QuickJS-NG hasn't shipped, we hit a wall not fixable in our layer.
3. **GC pause issues.** QuickJS uses reference counting — no GC pauses, but cycle handling is manual. If a benchmark surfaces RC-related throughput issues we can't fix, that's data.

### What survives a switch

The native bindings written in Phases 1–4 are reusable. The C surface (`hash.c`, `zlib.c`, `socket.c`, `tls.c`) is engine-agnostic — they call OpenSSL / libz / kernel syscalls directly, not QuickJS internals. They get re-bound in SpiderMonkey via JSAPI.

bootstrap.js is mostly Node-API shim and is engine-agnostic at the JS level, except for the `qjs:os` calls. Those become SpiderMonkey-specific shims.

### Tasks (only if we switch)

- Task 7.1: SpiderMonkey jitless build script (`examples/libs/spidermonkey/`)
- Task 7.2: Port `node-main.c` to SpiderMonkey JSAPI
- Task 7.3: Re-bind the four native namespaces in JSAPI
- Task 7.4: Re-run all phase tests on the new binary

This is its own multi-week track and gets its own design + plan PR pair.

---

## Cross-cutting concerns (apply to every phase)

### ABI

`ABI_VERSION` bumps **only** if a phase touches kernel surface — channel layout, syscall numbers, marshalled structs, kernel-wasm exports. Phases 1, 2, 4 are pure userspace (native module + bootstrap); they do **not** bump. Phases 3, 5, 6 may touch kernel if a missing syscall surfaces (e.g. `EAGAIN` semantics on a specific fd type) — bump in that phase's PR with a clear rationale.

### Documentation per-PR

Every PR updates the relevant doc per CLAUDE.md:

| Change kind | Doc to update |
|---|---|
| New native namespace | `docs/porting-guide.md` (note the new C surface) |
| Bootstrap.js shim swap | `docs/porting-guide.md` (track which APIs are real vs. stub) |
| New kernel surface | `docs/architecture.md`, `docs/posix-status.md` |
| Browser-only behaviour | `docs/browser-support.md` |
| Major user-visible feature | `README.md` |

### Test layering

Each phase's tests live alongside the existing `host/test/node-compat.test.ts`:

- **Eval smoke** (`quickjs-eval-smoke.test.ts`) — Phase 0c, never deleted
- **Per-phase** (`quickjs-node-{crypto,zlib,net,https,npm}.test.ts`) — added per phase
- `node-compat.test.ts` — the original 12 cases stay; each new feature lifts one or more from "stubbed" to "real" without breaking the existing assertions

### Bench discipline

The design doesn't introduce a new bench suite — `npm install` is itself the long-loop benchmark. After Phase 5, run `npx tsx benchmarks/run.ts --rounds=3` on Node and browser to confirm no regressions in `syscall-io` / `process-lifecycle` from the Phase 3 fd-watch loop changes.

---

## Phase boundaries — what stays out

The following are **not in scope** for this plan, by design:

- Native addons (`.node` files / `bindings`-style packages) — accept as v1 non-goal
- HTTP/2, HTTP/3 — npm registry serves HTTP/1.1 fine
- WASI compatibility — explicitly not WASI
- Inspector / debugger
- Real worker_threads parallelism — single-threaded JS only
- Intl
- Forking the QuickJS-NG upstream — stay on the C native-module API

---

## When this plan changes

If a phase surfaces a finding that changes the design (not just an implementation gotcha), update the design doc in a small follow-up PR and re-anchor this plan to it. Do **not** silently revise the design.

If a phase splits in two or three PRs (likely for Phase 3, possibly for Phase 5), update the PR series table at the top of this doc on whichever PR makes the split — never let the table drift from reality.
