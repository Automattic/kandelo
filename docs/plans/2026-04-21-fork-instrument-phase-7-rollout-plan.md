# Fork-Instrument Phase 7 Rollout — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Flip the entire fork-instrumentation pipeline off Binaryen's `wasm-opt --asyncify` and onto the in-tree `wasm-fork-instrument` tool, in a single flag-day PR.

**Architecture:** Phase 7 is the production rollout of a project whose tool (`crates/fork-instrument/`) is already feature-complete through Phase 6 (catch-handler resume) and has passed a 10 000-iteration fuzz gate on 2026-04-21. This plan performs the surgical host runtime rename (`asyncify_*` → `wpk_fork_*`), edits all 10 fork-using build scripts, rebuilds the committed `.wasm` artifacts, regenerates the ABI snapshot, bumps `ABI_VERSION`, removes the now-unused `third_party/binaryen` submodule, and updates docs. Fork-from-catch (B1) is deferred as an unsupported pattern — see `memory/fork-instrument-b1-followup.md`.

**Tech Stack:** Rust (crates/fork-instrument uses walrus + clap), TypeScript (host runtime), Bash (build scripts), musl/LLVM 21 cross-compilation.

**Worktree:** `/Users/brandon/.superset/worktrees/wasm-posix-kernel/phase-7-rollout` — branched off `fierce-wire`. PR targets `main`; rebase when #307 lands.

**Authoritative design:** `docs/plans/2026-04-20-fork-instrumentation-design.md`. This plan implements §4 Phase 7 + §6 doc deliverables.

---

## Guiding conventions

- **Commit cadence:** one task = one commit, except the "flag-day flip" in Task 7, which is atomic (host rename + build-script flips + rebuilt wasm artifacts + onlylist deletions + ABI bump in a single commit so the branch is never in a state where integration tests can't run).
- **Never push to main.** All work on branch `phase-7-rollout` → PR → merge.
- **Opus 4.6 for subagents** (per user standing pref).
- **Use `--sanitizer=none`** if re-running `scripts/run-fork-instrument-fuzz.sh` on macOS arm64.
- **Build verifier:** `cargo test -p fork-instrument --target aarch64-apple-darwin` must stay green after Tasks 1 and 7. The repo default target is wasm64, which cannot build host crates; always pass the explicit target.
- **All testing gated on the 6-suite regression matrix** (Task 14). Libc-test `popen` and `daemon-failure` XFAILs are pre-existing — acceptable.

---

## Task 1: Extend `wpk_fork_unwind_begin` to self-initialize `*(buf + 0) = frames_start_offset`

**Why now:** Decouples host from buffer geometry. After this lands, the host no longer needs to know where frames start — the tool writes that offset at instrument time. This must precede Task 7 (host rename) so the rewrite can delete the relevant host-side bookkeeping in one pass.

**Files:**
- Modify: `crates/fork-instrument/src/runtime.rs` — `emit_unwind_begin()` (~lines 239-272)
- Test: `crates/fork-instrument/tests/runtime.rs` (append 2 cases)

**Step 1: Write the failing tests.**

Add to `crates/fork-instrument/tests/runtime.rs`:

1. A wasm32 fixture that calls the emitted `wpk_fork_unwind_begin(0x1000)` in a walrus-validated + wasmparser-validated module, reads back `*(buf + 0)` via a helper export, and asserts it equals the runtime's `frames_start_offset`.
2. A wasm64 fixture with the same assertion but pointer type `i64`.

**Step 2: Run tests; confirm they fail.**

```
cargo test -p fork-instrument --target aarch64-apple-darwin test_unwind_begin_writes_frames_start_offset -- --nocapture
```
Expected: FAIL (the emitted function does not write frames_start_offset today).

**Step 3: Implement.**

In `emit_unwind_begin()`, between the `state := UNWINDING` / `buf := buf` stores and the existing `emit_save_globals()` call, emit:

```
local.get buf        ;; base
i32.const 0          ;; offset 0
<width store>        ;; i32.store for wasm32, i64.store for wasm64
```

where the stored value is `frames_start_offset` — a u32 constant (for wasm32 store as i32; for wasm64 widen to i64 via `i64.extend_i32_u` or store as i64 directly). Match the existing pattern used by `emit_save_globals`.

**Step 4: Run tests; confirm they pass.**

```
cargo test -p fork-instrument --target aarch64-apple-darwin
```
Expected: all 72 existing tests + 2 new tests pass. (74 total.)

**Step 5: Commit.**

```
git add crates/fork-instrument/src/runtime.rs crates/fork-instrument/tests/runtime.rs
git commit -m "feat(fork-instrument): unwind_begin self-initializes frames_start_offset"
```

---

## Task 2: Add `wasm-fork-instrument` build + installation to root `build.sh`

**Why now:** Build scripts in Task 6 will invoke `$REPO_ROOT/tools/bin/wasm-fork-instrument`. It needs to exist before those scripts can be smoke-tested.

**Files:**
- Modify: `build.sh` (repo root)
- Create: `tools/bin/` (via script)

**Step 1: Edit `build.sh`.**

After the existing `cargo build --release -p wasm-posix-kernel …` block, add:

```
echo "Building wasm-fork-instrument host tool…"
cargo build --release \
  --target aarch64-apple-darwin \
  -p fork-instrument \
  --bin wasm-fork-instrument
mkdir -p tools/bin
cp target/aarch64-apple-darwin/release/wasm-fork-instrument tools/bin/wasm-fork-instrument
```

On non-arm64-darwin hosts, detect and pick the correct target triple (check what `build.sh` already does for host vs wasm cross-compile — mirror that logic rather than hardcoding aarch64).

**Step 2: Run `bash build.sh` end-to-end.**

Expected: kernel wasm + musl sysroot build unchanged; `tools/bin/wasm-fork-instrument` exists afterward.

**Step 3: Smoke test the installed binary.**

```
tools/bin/wasm-fork-instrument --help
```
Expected: CLI help prints the same usage as `cargo run -p fork-instrument -- --help`.

**Step 4: Add `tools/bin/` to `.gitignore`.**

Confirm: `tools/bin/*` is listed so the binary is not checked in.

**Step 5: Commit.**

```
git add build.sh .gitignore
git commit -m "build: install wasm-fork-instrument to tools/bin/ via build.sh"
```

---

## Task 3: Add TypeScript host wrapper symbols (no behavior change yet)

**Why:** The host needs both old (`asyncify_*`) and new (`wpk_fork_*`) call sites understood before Task 7 atomic flip. This task is optional if Task 7 is done in a single sitting — skip if executing linearly. Documented here in case the flip needs to be staged.

**Decision point:** SKIP if executing Task 7 same-session. Continue to Task 4.

---

## Task 4: Verify all 10 build scripts' fork import and asyncify invocation lines

**Why now:** Paranoia step before Task 6 flips them. Produce a ground-truth mapping so Task 6 can be parallel-dispatched to subagents without surprises.

**Files read-only:**
- `examples/libs/bash/build-bash.sh:395` (full-module)
- `examples/libs/dash/build-dash.sh:143` (full-module)
- `examples/libs/git/build-git.sh:212` + `:227` (full-module, two outputs: main + git-remote-http)
- `examples/libs/quickjs/build-quickjs.sh:156` + `:186` (full-module, two outputs: qjs + node)
- `examples/libs/sqlite/build-testfixture.sh:260` (full-module)
- `examples/libs/tcl/build-tcl.sh:168` (full-module)
- `examples/libs/vim/build-vim.sh:179` (onlylist)
- `examples/nginx/build.sh:404-406` (full-module)
- `examples/nginx/build-php-fpm.sh:179-181` (onlylist — `asyncify-fpm-onlylist.txt`)
- `examples/libs/ruby/build-ruby.sh` — **no asyncify call found**. Confirm Ruby does not use fork, or that asyncify is invoked in a different build path. If Ruby does use fork, add an asyncify call OR mark it as out-of-scope for Phase 7 in the PR description.

**Step 1: Re-grep to confirm.** No edits; just read.

**Step 2: Record any surprises in the plan doc itself.**

Append findings to this plan file under "Execution notes" at the bottom. Do not commit yet.

---

## Task 5: Discover any fork-path onlylist files beyond the 3 originally inventoried

**Files to delete (confirmed):**
- `examples/libs/vim/asyncify-onlylist.txt` (69 lines)
- `examples/libs/bash/asyncify-onlylist.txt` (76 lines)
- `examples/libs/git/asyncify-onlylist.txt` (309 lines)
- `examples/nginx/asyncify-fpm-onlylist.txt` (48 lines) — **not in original inventory; discovered during Task 4**

**Step 1: `find examples -name 'asyncify*.txt'`** to confirm no others.

**Step 2: Record count in Execution notes.** Do not delete yet — done as part of Task 6 per-script edits.

---

## Task 6: Tool tweak to self-initialize `current_pos` — confirm the host can rely on it

**Files read-only:**
- `crates/fork-instrument/src/runtime.rs` — confirm Task 1 landed the write.
- `host/src/worker-main.ts` around lines 629-631 — where host today writes `current_pos = bufferSize` or similar before calling `asyncify_start_unwind`.

**Step 1: Read `worker-main.ts:600-690`** to locate the exact code path the host uses to populate the asyncify buffer header today. Record that call site's line range — Task 7 will delete it.

---

## Task 7: Flag-day atomic flip — host rename + build scripts + onlylists + ABI bump + rebuilt wasm artifacts

This is the big one. Split into sub-steps but commit as one.

### 7.a Host runtime rename (TypeScript)

**Files:**
- Modify: `host/src/worker-main.ts`
- Modify: `host/src/worker-protocol.ts` (line 41: `asyncifyBufAddr` → `forkBufAddr`)
- Modify: `host/src/node-kernel-worker-entry.ts` (lines 283, 293: field rename)
- Modify: `host/src/kernel-worker.ts` (any asyncify references — check)
- Modify: `host/test/nginx.test.ts` (lines 119, 128)
- Modify: `host/test/git.test.ts` (lines 67-68 — comments)
- Modify: `host/test/centralized-test-helper.ts` (lines 244, 256)

**Sub-step 7.a.1: Rename imports and field.**

Replace every occurrence in `host/src/` and `host/test/`:

- `asyncify_start_unwind` → `wpk_fork_unwind_begin`
- `asyncify_stop_unwind` → `wpk_fork_unwind_end`
- `asyncify_start_rewind` → `wpk_fork_rewind_begin`
- `asyncify_stop_rewind` → `wpk_fork_rewind_end`
- `asyncify_get_state` → `wpk_fork_state`
- `asyncifyBufAddr` → `forkBufAddr`
- `asyncifyBuf` (variable names) → `forkBuf`
- `saveParentTls` → `saveParentForkGlobals` (function no longer writes only TLS — renaming clarifies)

**Sub-step 7.a.2: Delete `__stack_pointer` / `__tls_base` special-case restoration.**

In `host/src/worker-main.ts`, delete the block at lines 648-684 that restores `__tls_base` from `asyncifyBufAddr - 4/-8` and `__stack_pointer` from `asyncifyBufAddr - 8/-16`. These globals are now in `saved_globals[]` and are restored automatically by `wpk_fork_rewind_begin`.

Delete correspondingly the writes in `saveParentTls()` (renamed above). The new `saveParentForkGlobals` is essentially a no-op — the tool's `wpk_fork_unwind_begin` handles it. The function body shrinks to just setting `forkBufAddr` on init data for the child worker.

Net LoC delta: approximately −40 LoC in `worker-main.ts` per the memory note.

**Sub-step 7.a.3: Rearrange `setupChannelBase` call.**

The fork-child branch in `worker-main.ts` currently calls `setupChannelBase` at ~line 687, **after** the (about-to-be-deleted) manual `__tls_base` restoration. It must now be called **after** `wpk_fork_rewind_begin` returns, because `wpk_fork_rewind_begin` is what restores `__tls_base` now, and `setupChannelBase` reads `__tls_base`.

Walk the fork child path:

1. Instantiate module with imports.
2. Read `forkBufAddr` from init data.
3. Call `wpk_fork_rewind_begin(forkBufAddr)` — this restores all mutable globals including `__tls_base` and `__stack_pointer`.
4. *Now* call `setupChannelBase` — `__tls_base` is live.
5. Enter `_start` / user main so the rewind machinery resumes frames.

Add an inline comment at the `setupChannelBase` call site explaining the dependency on rewind ordering (the *why* — future readers won't know).

**Sub-step 7.a.4: Host-side buffer initialization change.**

Today, before calling `asyncify_start_unwind`, the host writes `*(asyncifyBufAddr + 0) = asyncifyBufAddr + headerSize` (i.e., it pre-seeds `current_pos`). After Task 1, `wpk_fork_unwind_begin` writes `*(buf + 0) = frames_start_offset` itself. The host's pre-seed code can be **deleted**. Confirm its exact line(s) and remove.

### 7.b Rename kernel expected-exports list

**Files:**
- Modify: `crates/shared/src/lib.rs` (or `crates/shared/src/abi.rs` if split)

Find `PROCESS_EXPECTED_EXPORTS` / `KERNEL_EXPECTED_EXPORTS` (or similar names). Replace asyncify-prefixed names with the five `wpk_fork_*` exports per design §3.2.

Also find `ASYNCIFY_SAVE_SLOTS` (lib.rs:917-934 per inventory). This constant describes `__tls_base` and `__stack_pointer` slots at negative offsets. These slots are **gone** — the tool inlines both globals into `saved_globals[]`. Delete the constant entirely and all its references.

### 7.c Flip all 10 build scripts

**Subagent-parallel candidate.** Dispatch one Opus 4.6 subagent per script. Each subagent performs:

1. Locate the `wasm-opt --asyncify ...` line(s).
2. Replace the entire invocation with `"$REPO_ROOT/tools/bin/wasm-fork-instrument" <input> -o <output>` (no `--asyncify-imports` flag; the tool defaults to `kernel.kernel_fork`).
3. Confirm the call comes **after** any `wasm-opt -O2` invocation. If ordering is wrong, swap so `wasm-fork-instrument` runs **last** (tool hardcodes global offsets at instrument time; any later pass reordering globals corrupts the fork buffer).
4. Delete the associated `asyncify-onlylist.txt` / `asyncify-fpm-onlylist.txt` file if any.
5. Delete the loading logic for the onlylist (`ONLY_FUNCS=$(cat ...)` etc.).
6. For bash and git: delete the "full-module carve-out" comment + the reason. The new tool auto-discovers the call graph.
7. Run the build script end-to-end. Verify the output wasm validates (`wasm-validate output.wasm` or `wasm2wat` round-trip).

Scripts:
1. `examples/libs/bash/build-bash.sh:395` + delete `asyncify-onlylist.txt`
2. `examples/libs/dash/build-dash.sh:143`
3. `examples/libs/git/build-git.sh:212,:227` + delete `asyncify-onlylist.txt`
4. `examples/libs/quickjs/build-quickjs.sh:156,:186`
5. `examples/libs/sqlite/build-testfixture.sh:260`
6. `examples/libs/tcl/build-tcl.sh:168`
7. `examples/libs/vim/build-vim.sh:179` + delete `asyncify-onlylist.txt`
8. `examples/nginx/build.sh:404-406`
9. `examples/nginx/build-php-fpm.sh:179-181` + delete `asyncify-fpm-onlylist.txt`
10. `examples/libs/ruby/build-ruby.sh` — per Task 4 finding, possibly no-op.

Subagents report back: did their build script succeed? Size delta before/after?

### 7.d Rebuild committed wasm artifacts

`git status` at the start of this session showed modified `host/wasm/fork-exec.wasm` and `host/wasm/wasm_posix_kernel.wasm`. These are checked-in binaries used by vitest. After Task 7.a–c, rebuild them:

```
bash build.sh
scripts/build-programs.sh
```

Also rebuild every ported program's wasm artifact that's checked into `host/wasm/` or committed under `examples/*/out/`. Grep for `.wasm` committed under those paths and rebuild each one that comes from a flipped build script.

### 7.e ABI_VERSION bump + snapshot regen

**Files:**
- Modify: `crates/shared/src/lib.rs` — `ABI_VERSION: u32 = 2` → `ABI_VERSION: u32 = 3`
- Modify: `abi/snapshot.json` — regenerate via script

Run:

```
bash scripts/check-abi-version.sh update
git diff abi/snapshot.json
```

Expected diff: `asyncify_save_slots` key removed (or renamed to an empty array if it's still referenced by the schema); kernel expected-exports list changes `asyncify_*` → `wpk_fork_*`. Confirm the diff is exactly what ABI_VERSION=3 should describe — no other drift.

Then:

```
bash scripts/check-abi-version.sh
```

Expected: exit 0 (version-bump-and-snapshot-commit pair satisfied).

### 7.f Commit everything from 7.a–e as one commit

```
git add -A   # includes wasm binaries, deleted onlylists, host rename, ABI bump, snapshot
git commit -m "feat(fork-instrument)!: flag-day rollout — replace --asyncify with wasm-fork-instrument

Phase 7 of the fork-instrumentation project. Flips all 10 fork-using build scripts
and host runtime to wasm-fork-instrument. Renames kernel ABI exports
asyncify_* → wpk_fork_*. Deletes per-program asyncify-onlylist files.
Removes host-side __tls_base / __stack_pointer special-case restoration.

ABI_VERSION bumped to 3. Old fork-using binaries will not run on this kernel.

Fork-from-catch (a C++/Ruby EH pattern) is documented as unsupported;
see docs/posix-status.md. The deferred follow-up is tracked in
memory/fork-instrument-b1-followup.md.

Refs: docs/plans/2026-04-20-fork-instrumentation-design.md §4 Phase 7"
```

The `!` in the commit type marks this as a breaking change per Conventional Commits.

---

## Task 8: Remove `third_party/binaryen` submodule

**Files:**
- Modify: `.gitmodules` (remove block)
- Modify: `.git/config` (automatically by `git submodule deinit`)
- Delete: `third_party/binaryen/` directory

**Step 1: Deinit.**

```
git submodule deinit -f third_party/binaryen
git rm -f third_party/binaryen
rm -rf .git/modules/third_party/binaryen   # stale submodule dir
```

**Step 2: Search for any remaining `wasm-opt` references.**

`wasm-opt -O2` may still be used as a post-optimizer in some scripts. That is fine — any stock `wasm-opt` works (the user may have it from Homebrew). Only the in-tree build of Binaryen is removed.

Grep for `third_party/binaryen` and `BINARYEN_DIR` across `build.sh`, `scripts/`, and `examples/`. Remove any reference to the in-tree path. If scripts relied on the in-tree `wasm-opt` built from the submodule, have them fall back to `$(which wasm-opt)` or fail with a clear error.

**Step 3: Confirm `build.sh` still succeeds.**

```
bash build.sh
```

Expected: full rebuild passes without the submodule.

**Step 4: Commit.**

```
git add -A
git commit -m "build: remove third_party/binaryen submodule

No longer needed after Phase 7 — wasm-fork-instrument replaces
--asyncify, and any stock wasm-opt suffices for optional -O2 passes.

The upstream PR reviving Asyncify + try_table
(docs/plans/2026-04-20-binaryen-asyncify-try-table-design.md) still
stands on its own merits; it is no longer consumed by this repo."
```

---

## Task 9: Create `docs/fork-instrumentation.md`

**Why:** Design §6 names this the new reference for future readers. Absent today.

**File:** `docs/fork-instrumentation.md` (new)

**Content outline (write in this order):**

1. **Summary** — 3-4 sentences. What `wasm-fork-instrument` is, why it replaces `--asyncify`, where the tool lives, how build scripts invoke it.
2. **State machine** — the three states (NORMAL/UNWINDING/REWINDING) and their transitions, one short ASCII diagram.
3. **Exported ABI** — the five `wpk_fork_*` functions with preconditions/postconditions (copy from design §3.2).
4. **Save buffer format** — byte-level layout. Table like design §3.2 with explicit wasm32 and wasm64 widths.
5. **Frame format** — layout of a single frame, per-call-depth.
6. **Per-function transform — before/after WAT** — pick two or three minimal fixtures from `crates/fork-instrument/tests/instrument.rs` and render them as before/after WAT blocks with annotations. Show: (a) a leaf function with one direct call, (b) a function with try_table + catch-handler, (c) an indirect call site.
7. **Auxiliary tables** — funcref/externref/exnref stashes, how slots are assigned.
8. **Catch-handler resume** — the throw_ref-during-rewind trick. Diagram from design §3.6.
9. **Guarantees and non-guarantees** — what the tool handles, what it rejects (wasm-GC refs, atomic RMW, throw/throw_ref as side-effects outside instrumented regions), and explicitly the fork-from-catch deferral with a forward reference to `memory/fork-instrument-b1-followup.md`.
10. **Performance envelope** — benchmark results once Task 14 runs them.
11. **Maintainer notes** — how to add support for a new ref-type (edit `classify_ref` in `instrument.rs`), how to extend side-effect gating, how to run the fuzz gate.

Target length: 400-600 lines. Not longer than the design doc.

**Step: Commit.**

```
git add docs/fork-instrumentation.md
git commit -m "docs: add fork-instrumentation.md reference"
```

---

## Task 10: Update existing docs per design §6

**Files:**

- `docs/architecture.md` fork section (lines 202-213): replace Asyncify description with two sentences pointing to `wasm-fork-instrument` and `docs/fork-instrumentation.md`.
- `docs/porting-guide.md`: remove the `asyncify-onlylist.txt` workflow. Replace with "fork paths are auto-discovered — nothing for the porter to do beyond linking against the standard sysroot."
- `docs/posix-status.md`:
  - Add entry under "Unsupported patterns": `fork()` called from within a C++/Ruby exception catch handler (fork-from-catch). Link to `memory/fork-instrument-b1-followup.md`'s staged plan as the forward path.
  - Add entry: `ucontext` / `makecontext` / `swapcontext` / `getcontext` / `setcontext` — explicitly unsupported, no roadmap.
- `docs/abi-versioning.md`: add save-buffer format (per design §3.2) to the list of ABI-versioned items. Note `ABI_VERSION` is now 3.

**Step: Commit.**

```
git add docs/
git commit -m "docs: update fork references for wasm-fork-instrument rollout"
```

---

## Task 11: Update `CLAUDE.md` (repo) and user `MEMORY.md`

**Files:**
- Modify: `CLAUDE.md` (repo root)
- Modify: `/Users/brandon/.claude/projects/-Users-brandon-ai-src-wasm-posix-kernel/memory/MEMORY.md`

**CLAUDE.md:** No "Asyncify onlylist preferred" paragraph exists in the current `CLAUDE.md` per inventory (the preference lives in `MEMORY.md`'s User Preferences). But `CLAUDE.md` does list `ASYNCIFY_SAVE_SLOTS` as ABI-versioned. Update that line to describe `wpk_fork_*` save slots instead.

**MEMORY.md:** Remove the "Asyncify onlylist preferred" User Preference bullet. Replace with a `wasm-fork-instrument` bullet that reads:

> - **wasm-fork-instrument replaces asyncify**: fork-path instrumentation is done via `tools/bin/wasm-fork-instrument` (built from `crates/fork-instrument/`) as the last pipeline step in every build script. Do not add `wasm-opt --asyncify` to new builds. The tool auto-discovers fork paths from the call graph — no onlylist files. Source: `docs/fork-instrumentation.md` and `docs/plans/2026-04-20-fork-instrumentation-design.md`.

Also update the project overview entry for Phase 7 status.

**Step: Commit CLAUDE.md only** (MEMORY.md is outside the repo; update via the auto-memory system after the branch merges).

```
git add CLAUDE.md
git commit -m "docs: refresh CLAUDE.md for wasm-fork-instrument rollout"
```

---

## Task 12: Smoke-test fork-using programs locally

Run the fastest fork-exercising integration tests before firing the full regression matrix:

```
# Host integration tests that exercise fork directly
cd host && npx vitest run nginx.test.ts
cd host && npx vitest run git.test.ts
cd host && npx vitest run fork.test.ts    # if exists
```

Expected: all pass. If any fail, do NOT proceed to Task 13 — investigate (typical cause: a build script's output didn't get rebuilt; run `bash scripts/build-programs.sh` and re-verify).

---

## Task 13: Run the fork-instrument fuzz gate against the tweaked tool

**Why:** Task 1 modified the tool. Re-run the 10 000-iter fuzz gate to confirm no regression.

```
FUZZ_RUNS=10000 scripts/run-fork-instrument-fuzz.sh --sanitizer=none
```

Expected: `#10000 DONE` with zero validator failures. Record the exec/s and coverage metrics in the PR description.

---

## Task 14: Full 6-suite regression matrix

**All must pass:**

```
# 1. Rust kernel unit tests
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib

# 2. Host integration tests
cd host && npx vitest run

# 3. musl libc-test
scripts/run-libc-tests.sh

# 4. Open POSIX Test Suite
scripts/run-posix-tests.sh

# 5. sortix tests
scripts/run-sortix-tests.sh --all

# 6. ABI snapshot check
bash scripts/check-abi-version.sh
```

Acceptable:
- libc-test `popen` and `daemon-failure` XFAILs (pre-existing).
- sortix XFAIL at 18 (architectural blockers, unchanged).
- POSIX XFAIL at 1 (unchanged).

Any new FAIL (non-XFAIL) blocks the PR.

---

## Task 15: Benchmark diff

Per design §5.5 item 8: run the 5-suite benchmark on Node + browser before merging, compare against a `fierce-wire` baseline.

```
# Baseline (checkout fierce-wire, build, bench)
git worktree add /tmp/bench-baseline fierce-wire
cd /tmp/bench-baseline && bash build.sh && scripts/build-programs.sh
cd /tmp/bench-baseline && npx tsx benchmarks/run.ts --rounds=3 --output=/tmp/before.json
cd /tmp/bench-baseline && npx tsx benchmarks/run.ts --host=browser --rounds=3 --output=/tmp/before-browser.json

# After (phase-7-rollout worktree)
npx tsx benchmarks/run.ts --rounds=3 --output=/tmp/after.json
npx tsx benchmarks/run.ts --host=browser --rounds=3 --output=/tmp/after-browser.json

npx tsx benchmarks/compare.ts /tmp/before.json /tmp/after.json
npx tsx benchmarks/compare.ts /tmp/before-browser.json /tmp/after-browser.json
```

Expected: fork-heavy suites (wordpress, erlang-ring, process-lifecycle) within ±3%. Include the numbers in the PR description. Any regression >3% triggers investigation before merge (per design §7.1).

---

## Task 16: Open PR

```
git push -u origin phase-7-rollout

gh pr create \
  --base main \
  --title "feat(fork-instrument)!: Phase 7 — replace --asyncify with wasm-fork-instrument" \
  --body "$(cat <<'EOF'
## Summary
- Flag-day flip of all fork-using programs from Binaryen's \`--asyncify\` to the in-tree \`wasm-fork-instrument\` tool.
- Kernel ABI breaking change: exports renamed \`asyncify_*\` → \`wpk_fork_*\`. \`ABI_VERSION\` bumped 2 → 3. Old fork-using binaries will not run on this kernel.
- Host simplification: deletes ~40 LoC of \`__stack_pointer\`/\`__tls_base\` special-case restoration (now handled inside instrumented user code via \`saved_globals[]\`).
- Removes \`third_party/binaryen\` submodule.

## Affected programs (10)
bash, dash, git, quickjs, ruby (if applicable), sqlite-testfixture, tcl, vim, nginx, nginx-php.

## Test plan
- [x] \`cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib\`
- [x] \`cd host && npx vitest run\`
- [x] \`scripts/run-libc-tests.sh\` — 0 unexpected failures
- [x] \`scripts/run-posix-tests.sh\`
- [x] \`scripts/run-sortix-tests.sh --all\`
- [x] \`bash scripts/check-abi-version.sh\`
- [x] Fork-instrument fuzz: 10 000 iters clean
- [x] Benchmark diff: fork-heavy suites within ±3% (see attached)

## Known unsupported pattern (tracked follow-up)
Fork-from-catch (fork() called from within a C++/Ruby exception handler) is unsupported — the child traps on rewind with an empty exnref stash. None of the 10 ported programs above exercise this pattern. Follow-up tracked at \`memory/fork-instrument-b1-followup.md\` — staged PR will land after this one ships.

## Design reference
\`docs/plans/2026-04-20-fork-instrumentation-design.md\`, \`docs/fork-instrumentation.md\` (new in this PR).

## Not in this PR
- Fork-from-catch (B1) — separate staged PR (1–1.5 weeks).
- Upstream Binaryen Asyncify + try_table patch — lives on its own branch; no longer consumed by this repo but still valuable to upstream community.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**If PR #307 has merged to `main` before this PR is opened:** the branch is already up-to-date (it was built off `fierce-wire`, which #307 contains). Just `git pull origin main` into the branch and push.

**If PR #307 has not merged:** target `main` but note in the PR body that the branch must be rebased once #307 lands. The review can proceed in parallel.

---

## Execution notes (populated during Tasks 4–5 and as issues surface)

- **Task 1 complete** at commit `b88691ea9` — 74/74 tests passing. `emit_unwind_begin` now writes `frames_start_offset` to `*(buf + 0)`.
- **Task 2 complete** at commit `36454b838` — `build.sh` now installs `tools/bin/wasm-fork-instrument` using host-triple detection via `rustc -vV`.
- **Pre-existing TS DTS build error surfaced during Task 2 verification** (NOT caused by Phase 7 work): `host/src/vfs/memory-fs.ts:430` calls `new SharedArrayBuffer(sabLen, sabOptions)` — the 2-arg growable-SAB constructor. On fresh `npm install` against the current host package.json, TypeScript rejects with `TS2554: Expected 0-1 arguments, but got 2`. The same line exists verbatim on `fierce-wire`; that branch's `host/dist/` predates whatever tsc/lib update caused this. Implication: the `npm run build` tail of `build.sh` fails on a cold worktree. Vitest likely still passes (esbuild transpile, not DTS-gated), but this must be resolved before Task 14 regression matrix can declare success. Likely fix: widen `lib` in `host/tsconfig.json` or add a narrow `as any` / typed wrapper at the call site. Track as a pre-Task-14 blocker.
- Tasks 4-5 inventory (read-only): filled below as they complete.

---

## Out of scope / explicit deferrals

- **Fork-from-catch (B1)** — deferred. Tracked in `memory/fork-instrument-b1-followup.md`.
- **Wasm-GC ref support in the instrumentation** — tool panics in `classify_ref` for GC abstract types (any/eq/struct/array/i31). Add when a real program requires it.
- **Multi-target `*_ref` try_tables** — Phase 6d currently skips these. Revisit when a real program forces the issue.
- **Atomic RMW / memory.atomic.** side-effect gating — not emitted today. Add when a fork-using program with atomics is ported.
