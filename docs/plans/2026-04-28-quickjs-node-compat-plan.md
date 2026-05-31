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
- OpenSSL 3.x (already builds, `packages/registry/openssl/build-openssl.sh`)
- zlib (already builds, `packages/registry/zlib/build-zlib.sh`)
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
| 4a | 4 | `feat(quickjs): tls.connect via libssl in the wasm sysroot — Phase 4 part 1` |
| 4b | 4 | `feat(quickjs): real http/https + Mozilla cacert.pem at /etc/ssl/cert.pem — Phase 4 part 2` |
| 5  | 5 | `feat(quickjs-node): npm install of zero-dep package` |
| 6  | 6 | `feat(quickjs-node): npm install of express + vite` |
| 7  | 7 | `feat(quickjs-node,browser): node.wasm runs in the browser demo` |
| 8+ | 8+ | (decision point — see Phase 8) |

**Branching convention.** All branches in this track are prefixed `explore-node-wasm-` and **stack on the previous branch in the series**, never on `main`. Nothing in this track lands on `main` directly — each PR is reviewed against its predecessor. The chain so far:

```
main
  └── explore-node-wasm-design                         (PR #2)
        └── explore-node-wasm-plan                     (PR #4)
              └── explore-node-wasm-fix-build-toolchain          (Phase 0a)
                    └── explore-node-wasm-fix-quickjs-cutils-c   (Phase 0b)
                          └── explore-node-wasm-fix-quickjs-eval (Phase 0c — rename to specific cause)
                                └── explore-node-wasm-docs-quickjs-phase0  (Phase 0d)
                                      └── explore-node-wasm-feat-quickjs-node-hashing (Phase 1)
                                            └── … (Phases 2+)
```

Each PR's GitHub base is the predecessor branch (not `main`). `XFAIL` / `TIME` are tolerated; any new `FAIL` is a regression. None is rolled into another.

**Verification gauntlet (CLAUDE.md, applies to every PR):**

```bash
cargo test -p kandelo --target aarch64-apple-darwin --lib   # 539+ pass, 0 fail
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

**Approach.** Pin `rust-toolchain.toml` to `nightly-2026-04-27`, move the panic strategy into `.cargo/config.toml` as `-Zunstable-options -Cpanic=immediate-abort`, add the newer wasm64 `--import-memory` linker arg there, and remove the obsolete `-Z build-std-features=panic_immediate_abort` flag from the kernel build scripts.

**Why keep the toolchain pinned?** Current `main` uses a dated nightly so toolchain churn is an explicit repository change rather than an ambient local-machine setting. The stack originally used `channel = "nightly"` while it was rebased across newer rustc behavior; the monolithic adaptation keeps the current convention and bumps the date alongside the flag change.

**Why not put `panic = "immediate-abort"` in `Cargo.toml`?** The compiler error offers both forms as equivalent. A workspace-level `[profile.release] panic = "immediate-abort"` would apply globally — including to the host-target `xtask` crate, where it's wrong. A per-crate `[profile.release.package.kandelo]` form would work but is a larger change with its own surface area. Keeping the flag in `.cargo/config.toml` scopes it to the wasm64 target and keeps it beside the related wasm linker arguments.

#### Task 0a.1 — Probe the right invocation under current nightly *(verified)*

Already executed during plan revision. Recorded outcome:

```bash
$ rustc --version
rustc 1.97.0-nightly (52b6e2c20 2026-04-27)

$ RUSTFLAGS="-Zunstable-options -Cpanic=immediate-abort" \
  cargo build --release -p kandelo -Z build-std=core,alloc
…
Finished `release` profile [optimized] target(s) in 6.96s

$ stat -f "%z" target/wasm64-unknown-unknown/release/kandelo_kernel.wasm
416242                                  # fresh build
$ stat -f "%z" host/wasm/kandelo-kernel.wasm
441836                                  # committed
```

**Wasm size drifted ~25 KB** (~6%) vs. the committed binary, exceeding the original "~5 KB" tolerance. The drift is almost certainly codegen — `lto = true` + `opt-level = "s"` + a newer nightly's compiler_builtins emit different bytes — but the structural ABI snapshot check (Task 0a.4) is necessary-but-not-sufficient to declare it harmless. CLAUDE.md is explicit that `abi/snapshot.json` does *not* catch semantic changes that don't shift offsets, and 6% is large enough for "pure codegen" that a symbol-level diff (`twiggy diff` or `wasm-tools dump`) is also required before committing the new binary. See Task 0a.4.

#### Task 0a.2 — Update all three cargo call sites

**Files (all three must change in one PR):**
- Modify: `build.sh`
- Modify: `run.sh`
- Modify: `scripts/check-abi-version.sh`

For each, replace the existing block:

```bash
cargo build --release -p kandelo \
  -Z build-std=core,alloc \
  -Z build-std-features=panic_immediate_abort
```

with:

```bash
RUSTFLAGS="-Zunstable-options -Cpanic=immediate-abort" \
cargo build --release -p kandelo \
  -Z build-std=core,alloc
```

(Keep the `RUSTFLAGS=` inline so it doesn't leak into other cargo invocations later in each script.)

**Verify the grep is clean afterwards:**
```bash
grep -rnE "build-std-features=panic_immediate_abort" build.sh run.sh scripts/
```
Expected: no matches.

#### Task 0a.3 — Document the change

**Files:**
- Inspect: `docs/posix-status.md`, `README.md`, `docs/architecture.md`
- Modify only if any of them quote the cargo flag verbatim.

Most likely no doc changes needed — the build flag is internal. The historical plan files under `docs/plans/2026-03-08-*.md` reference the old flag in build invocations; these are historical records of past sessions and should **not** be retroactively edited.

#### Task 0a.4 — Run the full verification gauntlet

Standard CLAUDE.md gauntlet:

```bash
bash build.sh                                                          # exit 0
cargo test -p kandelo --target aarch64-apple-darwin --lib    # 539+ pass, 0 fail
(cd host && npx vitest run)                                            # all files pass
scripts/run-libc-tests.sh                                              # 0 unexpected FAIL
scripts/run-posix-tests.sh                                             # 0 FAIL
bash scripts/check-abi-version.sh                                      # exit 0
```

**Handling the 25 KB wasm drift — three checks, in this order:**

The structural snapshot alone is necessary-but-not-sufficient. Three independent verifications must all pass before the new `host/wasm/kandelo-kernel.wasm` is committed.

**Check 1 — Structural ABI snapshot.**

1. Run `bash scripts/check-abi-version.sh` (now using the new flag form).
2. If it reports drift in `abi/snapshot.json`:
   - Run `bash scripts/check-abi-version.sh update` to regenerate.
   - `git diff abi/snapshot.json` and inspect.
   - **Codegen-only drift** (different LTO output, no change to channel header, syscall numbers, struct layouts, or export list) → proceed to Check 2.
   - **Structural drift** (any change to the surfaces enumerated in CLAUDE.md "Kernel ABI stability") → bump `ABI_VERSION` in `crates/shared/src/lib.rs` in the same commit.
3. Re-run `bash scripts/check-abi-version.sh` — must exit 0 before proceeding.

**Check 2 — Symbol-level size diff.**

`abi/snapshot.json` records offsets and export *signatures*, not function *sizes*. A 25 KB delta on a 416 KB binary is large enough that one or more functions could have changed materially without shifting the structural surface — and CLAUDE.md is explicit that "semantic changes that don't shift offsets" are not caught. Diff symbol sizes between the committed wasm and the rebuilt one:

```bash
# twiggy preferred (clearer summary); wasm-tools dump as fallback.
twiggy diff host/wasm/kandelo-kernel.wasm \
            target/wasm64-unknown-unknown/release/kandelo_kernel.wasm
```

Expected shape for "pure codegen" drift: many small per-function deltas spread across `core::*`, `compiler_builtins::*`, allocator/panic helpers, and LTO-coalesced inlining sites. **Acceptable.**

**Stop and investigate** if any of:

- A single user-defined kernel function (anything in `kandelo::*` outside the panic-handler family) grew or shrank by >1 KB — that's a real codegen change inside our code, not just stdlib churn.
- A new export appears or an existing export disappears (the structural check would catch this; flagged here as a sanity cross-check).
- Total kernel-crate function size moved >5% in either direction.

In any "stop" case, attach the `twiggy diff` output to the PR and decide before committing the new wasm whether (a) it's still a valid codegen-only change and the threshold was conservative, or (b) something semantic shifted and Phase 0a needs to revert / re-scope / bump `ABI_VERSION`.

**Check 3 — §0c repro on old AND new wasm.**

This is **load-bearing for Phase 0c** and the data point is unrecoverable once 0a lands.

The §0c stack-overflow regression was originally characterised against the *currently-committed* `host/wasm/kandelo-kernel.wasm` at HEAD `37814ab5` (`qjs -e '<expr>'` and `node -e '<expr>'` reliably stack-overflow with "Maximum call stack size exceeded"; `qjs --help` and `node --version` both work because they short-circuit before bootstrap). Phase 0a will replace that binary. If the new toolchain's codegen alone changes the §0c symptom on identical kernel source, the entire 106-commit kernel bisect that 0c.3 sets up is the wrong tool — the regression is environmental (toolchain / wasm-opt / asyncify drift), not a kernel commit. Once 0a is reviewed and the new wasm becomes the canonical reference, the "old toolchain × `37814ab5` source" combination is no longer reachable and that diagnosis becomes much harder.

Procedure, before staging any wasm change:

1. Save the currently-committed binary aside:
   ```bash
   cp host/wasm/kandelo-kernel.wasm /tmp/kandelo.committed.wasm
   ```
2. With `host/wasm/kandelo-kernel.wasm` = the **committed** binary, run the §0c repro (the same command Phase 0c.1 uses; if 0c hasn't authored the test yet, the manual repro `qjs -e '1+1'` against the existing `packages/registry/quickjs/bin/qjs.wasm` is sufficient for this step). Record: pass / "Maximum call stack size exceeded" / other.
3. Replace with the freshly-built binary:
   ```bash
   cp target/wasm64-unknown-unknown/release/kandelo_kernel.wasm host/wasm/kandelo-kernel.wasm
   ```
4. Re-run the same §0c repro. Record: pass / "Maximum call stack size exceeded" / other.

Possible outcomes and what each means for §0c:

| Old wasm | New wasm | Meaning |
|---|---|---|
| crash | crash | §0c is real and toolchain-stable. 0c.2's existing decision tree applies as written. |
| crash | **pass** | §0c is masked by new-toolchain codegen on `37814ab5` source. Skip 0c.3 (kernel bisect) entirely; treat as environmental. Ship 0a, then in 0c just commit the smoke test as a regression guard. |
| pass | pass | §0c was already fixed before this session — verify the original repro instructions and re-evaluate whether 0c is still needed. |
| pass | crash | New toolchain *introduces* the §0c crash. 0a must not ship the new wasm — block on toolchain investigation. |

**Record both outcomes verbatim in the 0a PR body.** Phase 0c.2 keys off this artifact.

After all three checks pass, commit the rebuilt `host/wasm/kandelo-kernel.wasm`. Treat the new bytes as the canonical reference for downstream work.

#### Task 0a.5 — Commit & PR

```bash
git checkout -b explore-node-wasm-fix-build-toolchain explore-node-wasm-plan
git add build.sh run.sh scripts/check-abi-version.sh
# Plus host/wasm/kandelo-kernel.wasm and abi/snapshot.json IF they changed
# (and all three checks above passed).
# Plus crates/shared/src/lib.rs IF ABI_VERSION bumped.
git commit -m "fix(build): restore build under current nightly toolchain"
git push -u origin explore-node-wasm-fix-build-toolchain
gh pr create --base explore-node-wasm-plan \
  --title "fix(build): restore build under current nightly toolchain" \
  --body "..." # see template below
```

PR body template:
```
## Summary

Current nightly turned `panic_immediate_abort` from a build-std-feature into a
real panic strategy. The new spelling is `-Zunstable-options -Cpanic=immediate-abort`.
The adapted PR keeps the repo's dated-nightly convention, stores the wasm64
panic/linker flags in `.cargo/config.toml`, and removes the obsolete
`-Z build-std-features=panic_immediate_abort` flag from `build.sh` and
`scripts/check-abi-version.sh`.

## Wasm drift

Kernel rebuild produced a ~25 KB (~6%) size delta vs. the committed binary.
Verified codegen-only via three independent checks:

- `scripts/check-abi-version.sh`: <PASS / regenerated snapshot, no ABI_VERSION
  bump / regenerated + ABI_VERSION bump because <surface> shifted>.
- `twiggy diff` on committed vs. rebuilt wasm: <summary — paste the top-N
  symbol deltas; confirm spread across stdlib/compiler_builtins, no single
  kernel function moved >1 KB>.
- §0c repro (`qjs -e '1+1'`) against old committed wasm: <result>. Against
  freshly-built wasm: <result>. <Interpretation per the 4-cell matrix in
  plan §0a.4 Check 3>.

## Test plan

- [ ] `bash build.sh` exits 0
- [ ] `cargo test -p kandelo --target aarch64-apple-darwin --lib` — 0 failures
- [ ] `(cd host && npx vitest run)` — all pass
- [ ] `scripts/run-libc-tests.sh` — 0 unexpected FAIL
- [ ] `scripts/run-posix-tests.sh` — 0 FAIL
- [ ] `scripts/check-abi-version.sh` — exit 0 (with regenerated snapshot if codegen drift, or `ABI_VERSION` bump if structural)
- [ ] `twiggy diff` — no kernel function moved >1 KB; total kernel-crate size delta within 5%
- [ ] §0c repro recorded against both old and new wasm — outcome interpreted in PR body
```

---

### Phase 0b — `fix(quickjs): drop nonexistent cutils.c refs from build-quickjs.sh`

**Symptom:** On a fresh clone, `bash packages/registry/quickjs/build-quickjs.sh` fails compiling host `qjsc`:
```
clang: error: no such file or directory:
  '.../packages/registry/quickjs/quickjs-src/cutils.c'
```

In quickjs-ng v0.12.1, `cutils.h` is header-only (`static inline`); `cutils.c` was removed upstream.

#### Task 0b.1 — Edit `build-quickjs.sh`

**Files:**
- Modify: `packages/registry/quickjs/build-quickjs.sh`

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
grep -n cutils packages/registry/quickjs/build-quickjs.sh
```
Expected: no remaining matches (the script does not reference `cutils.h` either; clang resolves it via `-I$SRC_DIR`).

#### Task 0b.2 — Verify on a fresh clone

The script clones quickjs-ng on first run. To exercise the cold path:
```bash
rm -rf packages/registry/quickjs/quickjs-src packages/registry/quickjs/bin
bash packages/registry/quickjs/build-quickjs.sh
```

Expected: clones quickjs-ng v0.12.1, builds `qjsc` natively, compiles bootstrap to bytecode, builds `qjs.wasm` and `node.wasm` in `packages/registry/quickjs/bin/`, applies asyncify. Exit 0.

#### Task 0b.3 — Commit & PR

```bash
git checkout -b explore-node-wasm-fix-quickjs-cutils-c explore-node-wasm-fix-build-toolchain
git add packages/registry/quickjs/build-quickjs.sh
git commit -m "fix(quickjs): drop nonexistent cutils.c refs from build-quickjs.sh"
git push -u origin explore-node-wasm-fix-quickjs-cutils-c
gh pr create --base explore-node-wasm-fix-build-toolchain \
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

- [ ] `rm -rf packages/registry/quickjs/quickjs-src packages/registry/quickjs/bin && bash packages/registry/quickjs/build-quickjs.sh` exits 0
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

`qjs.wasm` and `node.wasm` are the same crash. This is **not** a bootstrap.js bug (qjs.wasm has no bootstrap). It is **not** a QuickJS code-path change (no commits touch `packages/registry/quickjs/` since PR #226 / `18bfe4b6`).

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

const QJS = join(__dirname, '../../packages/registry/quickjs/bin/qjs.wasm');
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

**Pre-check the 0a artifact first.** Phase 0a §0a.4 Check 3 records the §0c repro outcome against both the *old-toolchain*-built committed wasm and the *new-toolchain*-built fresh wasm at HEAD `37814ab5` (identical kernel source). If the 0a PR body shows:

- **old wasm crashed, new wasm passed** → regression is environmental on its own. Skip the rest of 0c.2 and skip 0c.3 entirely; proceed to 0c.4 environmental path (commit a regression smoke test).
- **old wasm passed, new wasm passed** → §0c is no longer reproducible. Confirm the original repro instructions still hold; if not, close out 0c with just the smoke test.
- **old wasm crashed, new wasm crashed** → §0c is toolchain-stable. Continue with the steps below to determine kernel-vs-environmental.
- **old wasm passed, new wasm crashed** → 0a should have blocked on this; if it didn't, halt and re-evaluate before further bisect work.

In the "both crash" case, continue:

**Steps:**
1. Create a sibling worktree off `18bfe4b6` (the merge commit of PR #226):
   ```bash
   git worktree add ../qjs-bisect-base 18bfe4b6
   cd ../qjs-bisect-base
   ```
2. Apply the Phase 0a workaround inline to **both** `build.sh` and `run.sh` in the worktree (sed-replace the old `-Z build-std-features=panic_immediate_abort` block with the new `RUSTFLAGS` form). At `18bfe4b6`, `scripts/check-abi-version.sh` does not yet exist, so only those two files need patching. Do **not** commit the patches — they only need to live in the bisect worktree.
3. Build sysroot + kernel + qjs.wasm:
   ```bash
   git submodule update --init libc/musl
   bash scripts/build-musl.sh
   bash build.sh
   bash packages/registry/quickjs/build-quickjs.sh   # apply Phase 0b cutils.c fix locally
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
  cargo build --release -p kandelo -Z build-std=core,alloc \
  >/dev/null 2>&1 || exit 125  # 125 = skip (build broken on this commit)

cp target/wasm64-unknown-unknown/release/kandelo_kernel.wasm host/wasm/kandelo-kernel.wasm

# Rebuild qjs.wasm (cheap — quickjs-src is already cloned & not modified)
bash packages/registry/quickjs/build-quickjs.sh >/dev/null 2>&1 || exit 125

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
- **setjmp/longjmp regression.** Probably a change in `wasm_setjmp_rt.o` or in how the kernel handles the corresponding call. Fix in `crates/kernel/src/…` plus possibly `libc/glue/`.

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

const QJS  = join(__dirname, '../../packages/registry/quickjs/bin/qjs.wasm');
const NODE = join(__dirname, '../../packages/registry/quickjs/bin/node.wasm');
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

```bash
# Branch name should encode the specific cause once known — e.g.
# `explore-node-wasm-fix-quickjs-eval-asyncify-imports` or
# `explore-node-wasm-fix-quickjs-eval-wasm-opt-pin`. Generic placeholder used here:
git checkout -b explore-node-wasm-fix-quickjs-eval explore-node-wasm-fix-quickjs-cutils-c
# git add <files from 0c.4 fix> + host/test/quickjs-eval-smoke.test.ts
git commit -m "fix(kernel): <specific cause> — restore JS_Eval"
git push -u origin explore-node-wasm-fix-quickjs-eval
gh pr create --base explore-node-wasm-fix-quickjs-cutils-c \
  --title "fix(kernel): <specific cause> — restore JS_Eval" \
  --body "..."
```

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
bash build.sh                                           # → host/wasm/kandelo-kernel.wasm
bash packages/registry/openssl/build-openssl.sh             # → libcrypto.a + libssl.a
bash packages/registry/zlib/build-zlib.sh                   # → libz.a
cd sdk && npm install && npm link && cd ..              # wasm32posix-cc on PATH
bash packages/registry/quickjs/build-quickjs.sh             # → qjs.wasm + node.wasm
```

Each step exits 0. Record artifact sizes (KB) into the doc.

#### Task 0d.2 — Run all 12 vitest cases in `node-compat.test.ts`

```bash
cd host && npx vitest run test/node-compat.test.ts
```

Expected: 12/12 pass. (Pre-fix this was 1/12 — the only passing case was `--version` because it short-circuits before `JS_Eval`.)

#### Task 0d.3 — OpenSSL sysroot audit

```bash
ls -lh packages/registry/openssl/openssl-install/lib/{libcrypto.a,libssl.a}
strings packages/registry/openssl/openssl-install/lib/libcrypto.a \
  | grep -E "^OPENSSLDIR|^/etc/ssl"
```

Confirm:
- `libcrypto.a` ~5 MB, `libssl.a` ~1 MB
- `OPENSSLDIR: "/etc/ssl"`
- Strings include `/etc/ssl/cert.pem`, `/etc/ssl/certs`

#### Task 0d.4 — zlib sysroot audit

```bash
ls -lh packages/registry/zlib/zlib-install/lib/libz.a
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
| kernel              | host/wasm/kandelo-kernel.wasm | <kb> KB | ✓ |
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
git checkout -b explore-node-wasm-docs-quickjs-phase0 explore-node-wasm-fix-quickjs-eval
git rm docs/plans/2026-04-28-quickjs-node-compat-session-notes.md
git add docs/plans/2026-04-28-quickjs-node-compat-phase0.md
git commit -m "docs(plan): QuickJS-NG Node compat — Phase 0 verification"
git push -u origin explore-node-wasm-docs-quickjs-phase0
gh pr create --base explore-node-wasm-fix-quickjs-eval \
  --title "docs(plan): QuickJS-NG Node compat — Phase 0 verification" \
  --body "..."
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
- Create: `packages/registry/quickjs/node-compat-native/` (directory)
- Create: `packages/registry/quickjs/node-compat-native/node-native.h`
- Create: `packages/registry/quickjs/node-compat-native/node-native.c`

**Step 1: header — module-init declaration.**

`node-native.h`:
```c
/*
 * qjs:node — Node.js-compat native bindings for QuickJS-NG.
 *
 * Provides typed JS bindings to libcrypto, libssl, libz, and AF_INET sockets.
 * Used by packages/registry/quickjs/node-compat/bootstrap.js to back its
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
- Create: `packages/registry/quickjs/node-compat-native/hash.c`

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
- Modify: `packages/registry/quickjs/node-main.c`

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
- Modify: `packages/registry/quickjs/node-compat/bootstrap.js`

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
- Modify: `packages/registry/quickjs/build-quickjs.sh`

**Step 1: Path constants** (near `SRC_DIR`):
```bash
NATIVE_DIR="$SCRIPT_DIR/node-compat-native"
OPENSSL_INSTALL="$REPO_ROOT/packages/registry/openssl/openssl-install"
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
    echo "ERROR: libcrypto.a not found. Run packages/registry/openssl/build-openssl.sh first."
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
cargo test -p kandelo --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
bash scripts/check-abi-version.sh
```

`ABI_VERSION` does **not** bump (no kernel surface touched).

### Task 1.8 — Commit & PR

```bash
git checkout -b explore-node-wasm-feat-quickjs-node-hashing explore-node-wasm-docs-quickjs-phase0
git add packages/registry/quickjs/node-compat-native/
git add packages/registry/quickjs/build-quickjs.sh
git add packages/registry/quickjs/node-main.c
git add packages/registry/quickjs/node-compat/bootstrap.js
git add host/test/node-compat.test.ts
git commit -m "feat(quickjs-node): real SHA-256/512 via libcrypto"
git push -u origin explore-node-wasm-feat-quickjs-node-hashing
gh pr create --base explore-node-wasm-docs-quickjs-phase0 --title "feat(quickjs-node): real SHA-256/512 via libcrypto" --body "..."
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
- Create: `packages/registry/quickjs/node-compat-native/zlib.c`

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
- Modify: `packages/registry/quickjs/node-compat-native/node-native.c`

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
- Modify: `packages/registry/quickjs/node-compat/bootstrap.js`

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
- Modify: `packages/registry/quickjs/build-quickjs.sh`

**Step 1: Path constants.**
```bash
ZLIB_INSTALL="$REPO_ROOT/packages/registry/zlib/zlib-install"
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
- Create: `packages/registry/quickjs/node-compat-native/socket.c`

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
- Modify (or create): `packages/registry/quickjs/node-main.c` — call `js_node_socket_dispatch` in the main loop

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
- Modify: `packages/registry/quickjs/node-compat/bootstrap.js`

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
- Modify: `packages/registry/quickjs/build-quickjs.sh`

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
strings packages/registry/openssl/openssl-install/lib/libcrypto.a | grep -E "/etc/ssl"
```

### Task 4.2 — `tls.c`: TlsSocket wrapper

**Files:**
- Create: `packages/registry/quickjs/node-compat-native/tls.c`

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
- Modify: `packages/registry/quickjs/node-compat/bootstrap.js`

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
- Modify: `packages/registry/quickjs/build-quickjs.sh`

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

### Task 5.2 — `package.json exports`/`imports` field resolution

Split into two halves: CommonJS `require()` (5.2a) and ESM dynamic `import()` (5.2b). The two paths share the algorithm but live on different sides of the C/JS boundary, so they're separate work items.

#### Task 5.2a — CommonJS side

**Files:**
- Modify: `packages/registry/quickjs/node-compat/bootstrap.js` — `_resolveFile`

Implement `package.json#exports` lookup in `_resolveFile`:
1. If `exports` is a string → use it.
2. If `exports['.']` exists → resolve subpath `.`.
3. If `exports[subpath]` exists → resolve subpath (`./util`, `./package.json`, etc.).
4. Fall back to `main` field (current behaviour).
5. Conditional exports: `default`, `node`, `require` — pick `require` (CJS path).

Spec at <https://nodejs.org/api/packages.html#exports>.

#### Task 5.2b — ESM dynamic-import side (live blocker for `npm --version`)

**Files:**
- Modify: `packages/registry/quickjs/node-main.c` — install a `JSModuleNormalizeFunc`/`JSModuleLoaderFunc2` pair via `JS_SetModuleLoaderFunc2`.
- Modify: `packages/registry/quickjs/node-compat-native/node-native.c` — expose `evalWithFilename(source, filename)` so the bootstrap's CJS loader can pass the resolved path through to QuickJS's `JS_GetScriptOrModuleName`. Without this, dynamic `import()` from `new Function` bodies has an empty base and bare-specifier resolution can't tell which `node_modules/` tree to walk.
- Modify: `packages/registry/quickjs/node-compat/bootstrap.js` — switch `_makeRequire` from `new Function(...)` to the new native eval so module bodies have a real script identity.

Algorithm in the C normalizer:
1. `qjs:`, `node:` → pass through.
2. Relative/absolute → default-style relative resolve, plus directory → `package.json#main` if applicable.
3. `#subpath` → look up base file's package.json `imports` field; resolve conditionally.
4. Bare specifier → walk `node_modules/<name>` upward from `dirname(base)`; resolve `exports`/`main` conditionally.

Conditional priority for ESM: `node`, `import`, `default`.

Loader hook for `node:foo`: synthesize `const _m = globalThis.require('foo'); export default _m;` and compile as a module. This is enough for default imports (which is what chalk/supports-color need); named imports of `node:` builtins are out of scope until a user surface needs them.

This is the same algorithm as 5.2a but on the C side because dynamic `import()` reaches QuickJS's module loader before any JS code runs. Sharing the algorithm in JS is tempting but the C normalizer can read `package.json` directly without round-tripping through globals.

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

## Phase 7 — Browser demo — `feat(quickjs-node,browser): node.wasm runs in the browser demo`

**Goal:** Land a `./run.sh browser`-reachable demo that boots `node.wasm` in `BrowserKernel` and exercises the full Node-compat surface from a web page, including `https.get`. The kernel + wasm sysroot is already browser-portable (the kernel runs in a Web Worker on every host, and Slice 4b moved the trust store from host fs into a synthetic kernel file). The remaining gap is the host-delegated TCP transport — `NodePlatformIO` proxies sockets to Node's `net.Socket`, but `BrowserKernel` has no equivalent.

**Estimate:** 1.5 weeks. Two distinct sub-tasks; the bridge is the load-bearing one.

**Branch:** `explore-node-wasm-feat-browser-demo`, stacked on `explore-node-wasm-feat-npm-real` (Phase 6).

### Task 7.1 — Smoke: boot node.wasm in `BrowserKernel`

**Files:**
- Modify: `host/src/browser-host.ts` (or wherever `BrowserKernel` lives) — surface the same `_nodeNative` shape that `NodePlatformIO` exposes, with the `socketConnect` / `tlsConnect` family stubbed to reject so any non-network code path works.
- Create: `examples/node-browser/` — minimal HTML+JS demo page that boots `node.wasm`, accepts a JS snippet from a textarea, and pipes stdout/stderr to a console area.
- Modify: `run.sh` (or the demo registry) — add `node-browser` so `./run.sh browser` lists it.

**Acceptance:**
- `node.wasm` evaluates JS, `require('fs')` reads/writes synthetic + OPFS-backed paths, `require('crypto')` produces the same SHA-256 as the Node host, `require('zlib')` round-trips a payload, `require('os').platform()` returns the wasm-side value (not the browser's).
- A snippet that calls `https.get(...)` fails with a clear "no TCP transport on browser host" error — *not* a hang.

This is a deliberate "everything except sockets" milestone — most of the value (REPL, fs, crypto, zlib, util, stream) ships here without needing the bridge.

### Task 7.2 — WebSocket TCP-bridge for `net` and `tls`

**Files:**
- Create: `examples/node-browser/tcp-bridge.ts` (Node side) — a tiny WebSocket server that accepts `{ host, port }` framing and brokers a TCP socket per connection. ~80 LOC. Runs alongside the existing `./run.sh browser` dev server.
- Modify: `host/src/browser-host.ts` — implement `socketConnect` / `socketRead` / `socketWrite` / `socketClose` against a `WebSocket` to the bridge URL (configurable; default `ws://localhost:5198/_tcp`). The wire framing on the WS connection is `[u32 length][bytes]`. TLS is unchanged: `tlsConnect` still runs libssl in-wasm and gets bytes via the same socket bindings, so the bridge sees only opaque ciphertext.
- Modify: `examples/node-browser/index.html` — add a "Try `https.get`" snippet that hits a real URL through the bridge.

**Why a Node-side bridge and not direct browser→TCP**: browsers can't open arbitrary TCP sockets. `WebTransport` is browser-only and not yet broadly shipped; a WebSocket bridge is the smallest portable thing that works in every modern browser today and degrades to a clear error if the bridge isn't running.

**Security note for the demo body:** the bridge is for the local dev demo only. A production deployment of this technique needs an allow-list, rate-limiting, and an authenticated path — `docs/browser-support.md` should call this out.

### Task 7.3 — Tests

**Files:**
- Create: `host/test/quickjs-node-browser.test.ts` — Playwright-driven, mirrors the existing browser tests (`scripts/run-browser-libc-tests.sh` shape). Cases:
  1. Boot smoke: `node -e "console.log(1+1)"` in browser → `2`.
  2. fs + crypto: write a Buffer, read it back, hash it, compare with the Node host's hash for the same input.
  3. zlib gzip round-trip in the browser.
  4. `https.get` through the bridge against a self-signed local TLS server (same fixture pattern as `quickjs-node-https.test.ts`). Skips if the bridge isn't running, the same way `pickWasmDialHost` skips today.

### Task 7.4 — Documentation

- `docs/browser-support.md` — new "Node compat in the browser" section. Document the bridge, its security limits, and which `_nodeNative` calls work / don't.
- `docs/architecture.md` — add a short section on the WebSocket TCP-bridge and how it slots into the kernel-host split.
- `README.md` — add the new demo to the demo list.
- `docs/porting-guide.md` — note the `socketConnect`/`tlsConnect` ABI is shared between Node and browser hosts so future native modules don't have to special-case.

### Task 7.5 — Verification gauntlet & commit

Standard gauntlet (`cargo test`, `npm exec vitest -- run`, libc-test, posix-test, ABI check). Plus the new browser tests via `./run.sh browser` and the Playwright suite.

**ABI:** none. Browser host is a JS-side change; the native module + bootstrap.js stays untouched. No `ABI_VERSION` bump.

---

## Phase 8+ — Decision point

**Goal:** Decide whether QuickJS-NG is fit-for-purpose for the long term, or whether the SpiderMonkey-jitless escape hatch becomes necessary.

### When to consider switching

1. **Performance cliff.** If `npm install lodash` takes > 5 minutes after Phase 5, QuickJS may simply be too slow.
2. **ES2024+ feature gaps.** If real-world deps use decorators, `using` declarations, or RegExp `v` flag features that QuickJS-NG hasn't shipped, we hit a wall not fixable in our layer.
3. **GC pause issues.** QuickJS uses reference counting — no GC pauses, but cycle handling is manual. If a benchmark surfaces RC-related throughput issues we can't fix, that's data.

### What survives a switch

The native bindings written in Phases 1–4 are reusable. The C surface (`hash.c`, `zlib.c`, `socket.c`, `tls.c`) is engine-agnostic — they call OpenSSL / libz / kernel syscalls directly, not QuickJS internals. They get re-bound in SpiderMonkey via JSAPI.

bootstrap.js is mostly Node-API shim and is engine-agnostic at the JS level, except for the `qjs:os` calls. Those become SpiderMonkey-specific shims.

### Tasks (only if we switch)

- Task 8.1: SpiderMonkey jitless build script (`packages/registry/spidermonkey/`)
- Task 8.2: Port `node-main.c` to SpiderMonkey JSAPI
- Task 8.3: Re-bind the four native namespaces in JSAPI
- Task 8.4: Re-run all phase tests on the new binary

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
