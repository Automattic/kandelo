# Fork-Instrument Switch-Dispatch Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` or `superpowers:subagent-driven-development` to implement this plan task-by-task.

**Goal:** Re-architect `crates/fork-instrument` so that REWINDING in a fork child jumps directly to the post-active-call-site label (asyncify-style switch dispatch) rather than re-executing the function body from the top with side-effects gated. This fixes both classes of bug proven in the 2026-04-22 debug session — non-fork-path direct calls re-firing during rewind (waitpid-class) and shadow-stack drift inside re-executed pre-call bodies (posix_spawn-class) — and closes the 8 sortix fork-semantic regressions tracked at [`memory/fork-instrument-phase7-debug-evidence.md`](../../../.claude/projects/-Users-brandon-ai-src-kandelo/memory/fork-instrument-phase7-debug-evidence.md) without reintroducing the 35 timeouts that the naive "gate every non-fork-path direct call" attempt produced.

**Architecture:** Per-function transform changes shape. Before: preamble → top-to-bottom wrapper block with every fork-path call and every side-effect op individually gated by the state global. After: preamble → nested dispatch blocks containing a single `br_table` keyed on `call_idx_local` that lands execution exactly at the post-active-call-site label; the body between dispatch labels runs *only* on normal flow, never on REWINDING. The host-side ABI (`wpk_fork_unwind_begin`/`wpk_fork_unwind_end`/`wpk_fork_rewind_begin`/`wpk_fork_rewind_end`/`wpk_fork_state`), the save-buffer layout, and the frame layout stay bit-identical — only the per-function transform is rewritten. `crates/fork-instrument/src/call_graph.rs` and `crates/fork-instrument/src/runtime.rs` are kept verbatim; the rewrite is concentrated in `crates/fork-instrument/src/instrument.rs`. Because the instrumented wasm's shape changes, `ABI_VERSION` is bumped 4 → 5 to force a clean rebuild and refuse any stale old-shape binaries that might live in build caches.

**Tech Stack:** Rust (walrus 0.26, anyhow, clap), TypeScript host (only the ABI-version constant bumps; no fork-loop changes absent a spike surprise), wasmparser + walrus for validation, wasm-tools for hand-authored fixtures.

**Worktree:** New worktree `phase-7-switch-dispatch` created off `phase-7-rollout`. Do NOT rebase onto the current fork-instrument shape — this is a full redesign that deserves its own branch history. The 12 Phase-7 commits on `phase-7-rollout` stay intact; merge order is "land this PR → fast-forward or rebase Phase 7 on top."

**Authoritative context:**
- [`memory/fork-instrument-phase7-debug-evidence.md`](../../../.claude/projects/-Users-brandon-ai-src-kandelo/memory/fork-instrument-phase7-debug-evidence.md) — disasm-level confirmation of the root cause, the 2026-04-22 naive fix attempt, and the two refined-fix proposals (narrower syscall gate vs. switch-dispatch). This plan implements proposal #2.
- [`memory/fork-instrument-project.md`](../../../.claude/projects/-Users-brandon-ai-src-kandelo/memory/fork-instrument-project.md) — project state and design-decision history.
- [`docs/plans/2026-04-21-fork-instrument-phase-7-rollout-plan.md`](2026-04-21-fork-instrument-phase-7-rollout-plan.md) § "Next-session debugging playbook" — test list + debug entry points.
- [`docs/plans/2026-04-20-fork-instrumentation-design.md`](2026-04-20-fork-instrumentation-design.md) — the design this plan *replaces* for the per-function transform. The non-transform sections (state machine, exported ABI, save-buffer format, frame format, ref-typed-local handling, call-graph discovery) remain authoritative.
- [`docs/fork-instrumentation.md`](../fork-instrumentation.md) — current 593-line user-facing reference; rewritten in this same PR.

---

## Guiding conventions

- **Commit cadence:** one task = one commit unless explicitly noted. Keep diffs small so bisection remains useful even for the bulk-rewrite task.
- **TDD:** every production change is preceded by a failing test that captures the change, then the minimal edit that turns it green.
- **Never push to main.** All work on branch `phase-7-switch-dispatch` → PR → merge via PR.
- **Opus 4.6 for subagents.**
- **Fuzz on macOS arm64:** pass `--sanitizer=none`; `scripts/run-fork-instrument-fuzz.sh` sets this already.
- **`cargo test -p fork-instrument --target aarch64-apple-darwin`** — the repo's default target is `wasm64-unknown-unknown`, which cannot build host crates. Always pass the explicit target when running unit tests.
- **Tool rebuild + install** after any source change: `cargo build -p fork-instrument --release --target aarch64-apple-darwin && cp target/aarch64-apple-darwin/release/wasm-fork-instrument tools/bin/wasm-fork-instrument`.
- **Bulk rewrite, not incremental.** `crates/fork-instrument/src/instrument.rs` is rewritten as one atomic change (Task 7). The preceding tasks set up infrastructure (spike, worktree, ABI-version bump, new-shape unit-test scaffolding) so the rewrite can be self-contained. After Task 7, the 43 pre-redesign `tests/instrument.rs` test assertions are gone — replaced wholesale. Reasoning: 4c-wrapping, 4g-gating, and the 6d `$outer/$capture` injection intertwine deeply; piecemeal removal would require maintaining two transforms side-by-side, doubling the test surface and creating cross-contamination risk.

---

## New design: per-function transform in IR terms

### State machine, exported ABI, save buffer — unchanged

`_wpk_fork_state` (i32 mutable global, `NORMAL=0`/`UNWINDING=1`/`REWINDING=2`) and `_wpk_fork_buf` (pointer-width mutable global) stay. The five exported functions keep their names and semantics. The save-buffer layout — `current_pos` at `+0`, `end_pos` at `+P`, `saved_globals[]` at `+2P`, frames growing upward from `frames_start_offset` — stays byte-identical. The frame layout — `func_index`/`call_index`/`catch_region_id`/`exnref_slot` header plus scalar-locals region — stays byte-identical.

### Frame-header semantics: still the same four fields

- `func_index` — which function emitted this frame (for host debugging only; tool ignores on reload).
- `call_index` — which call site within the function to dispatch to during REWINDING.
- `catch_region_id` — non-zero iff the frame was unwound from inside a `try_table` body. Routing of REWINDING dispatch for non-zero values is handled by the Phase-6-style `throw_ref` mechanism (kept from the current design).
- `exnref_slot` — aux-table slot holding the exnref captured at the enclosing catch handler; still populated by the Phase-6e call-site writes.

### Per-function transform — new shape

Each fork-path function's body is rewritten as:

```wat
(func $F (params...) (results...)
  local $call_idx_local         i32
  local $frame_ptr_local        ptr
  local $catch_region_id_local  i32
  local $exnref_slot_local      i32
  local ...user scalar locals (natural)...
  local ...synthetic arg-spill locals, one per arg per fork-path call site...
  local ...catch-region locals (in_catch_K, captured_exnref_K) — Phase 6d...

  ;; === 1. PREAMBLE (unchanged semantically; moved to run before dispatch) ===
  ;; Only fires when state == REWINDING.
  (if (i32.eq (global.get $_wpk_fork_state) (i32.const 2))
    (then
      ;; frame_ptr = *(buf+0) - frame_size
      (local.set $frame_ptr_local
        (<ptr-sub>
          (<ptr-load> (global.get $_wpk_fork_buf))
          (<ptr-const frame_size>)))
      ;; *(buf+0) = frame_ptr
      (<ptr-store>
        (global.get $_wpk_fork_buf)
        (local.get $frame_ptr_local))
      ;; call_idx_local          = frame[+4]
      ;; catch_region_id_local   = frame[+8]
      ;; exnref_slot_local       = frame[+12]
      ;; user scalar locals      ← frame[+16..]
      ;; user ref locals         ← aux_table.get(slot)
    )
  )

  ;; === 2. DISPATCH + WRAPPER + NESTED POST-CALL LABELS ===
  (block $unwind_save
    (block $POST_N
      (block $POST_{N-1}
        ...
          (block $POST_1
            (block $POST_0
              (block $dispatch_normal
                ;; REWINDING at top of function?
                (if (i32.eq (global.get $_wpk_fork_state) (i32.const 2))
                  (then
                    ;; `br_table` targets, in call_idx order:
                    ;;   0 → $POST_0   (skip chunk 0, land just before call 0)
                    ;;   1 → $POST_1   (skip chunks 0..1 + call 0, land just before call 1)
                    ;;   ...
                    ;;   N → $POST_N   (land just before call N)
                    ;;   default → $unwind_save  (defensive: bogus idx traps cleanly later)
                    (local.get $call_idx_local)
                    (br_table $POST_0 $POST_1 ... $POST_N $unwind_save)
                  )
                )
                ;; NORMAL path: fall through out of $dispatch_normal.
              )  ;; end $dispatch_normal
              ;; ← fallthrough for NORMAL execution
              <chunk 0: original body from func entry to first fork-path call>
              ;; At end of chunk 0: call site 0's args are on the operand stack.
              ;; Spill to $arg_local_0_j (synthetic locals, user-visible so the
              ;; frame save/restore sees them). Reload outside this block.
              <spill args for call 0 to locals>
            )  ;; end $POST_0 — landing for call_idx == 0 OR NORMAL fallthrough
            ;; === CALL 0 EXECUTION POINT ===
            ;; Reload args (they were restored by preamble on REWIND; by spill on NORMAL)
            <local.get for each arg_local_0_j>
            ;; On REWIND dispatch, an indirect call's table index must match too.
            (call $callee_0)                        ;; or call_indirect
            ;; Phase 6e — write catch_region_id_local / exnref_slot_local based on
            ;;            currently-active in_catch_K flags (outer-first, innermost wins).
            <Phase 6e overwrite sequence>
            ;; Propagate UNWINDING: if the callee just unwound, persist our
            ;; call_idx and exit via $unwind_save.
            (local.set $call_idx_local (i32.const 0))
            (if (i32.eq (global.get $_wpk_fork_state) (i32.const 1))
              (then (br $unwind_save)))
            <chunk 1: body between call 0 return and call 1>
            <spill args for call 1>
          )  ;; end $POST_1 — landing for call_idx == 1
          <reload args for call 1>
          (call $callee_1)
          <Phase 6e overwrite>
          (local.set $call_idx_local (i32.const 1))
          (if (i32.eq (global.get $_wpk_fork_state) (i32.const 1))
            (then (br $unwind_save)))
          <chunk 2>
          <spill args for call 2>
        ...
      )  ;; end $POST_{N-1}
      <reload args for call N-1>
      (call $callee_{N-1})
      <Phase 6e overwrite>
      (local.set $call_idx_local (i32.const N-1))
      (if (i32.eq ... UNWINDING) (then (br $unwind_save)))
      <chunk N-1>
      <spill args for call N>
    )  ;; end $POST_N
    <reload args for call N>
    (call $callee_N)
    <Phase 6e overwrite>
    (local.set $call_idx_local (i32.const N))
    (if (i32.eq ... UNWINDING) (then (br $unwind_save)))
    <chunk N+1: tail, from last call return to function end>
    ;; Normal-path return values on the operand stack here.
    (return)
  )  ;; end $unwind_save

  ;; === 3. POSTAMBLE (unchanged semantically; reached only via br $unwind_save) ===
  ;; frame_ptr = *(buf + 0)
  ;; frame[+0]  = func_ordinal
  ;; frame[+4]  = call_idx_local
  ;; frame[+8]  = catch_region_id_local
  ;; frame[+12] = exnref_slot_local
  ;; user scalar locals → frame[+16..]
  ;; user ref locals    → aux_table.set(slot, ...)
  ;; *(buf + 0) = frame_ptr + frame_size
  ;; return default values for the function's result types
)
```

### Why this fixes the 2026-04-22 regressions

- **waitpid-class** (non-fork-path direct calls re-fire during rewind): chunks 0..K are *skipped* by `br_table`. A non-fork-path `call $setpgid` inside chunk 0 never re-executes during REWIND dispatch to any call_idx ≥ 0. Root-cause disappears.
- **posix_spawn-class** (shadow-stack/SP arithmetic drift inside re-executed pre-call bodies): there is no re-executed pre-call body. Shadow-stack adjustments in chunk K are made once — on the NORMAL path — and never repeated. Args that were in flight at unwind time were spilled to user-visible scalar locals, serialized into the frame, and reloaded by the preamble; they ride back onto the operand stack *after* the dispatch jump, so no stack arithmetic is re-computed.

### What's deleted

- **Phase 4g side-effect gating** — every `local.set`/`local.tee`/`global.set`/`store`/`memory.grow`/`memory.fill`/`memory.copy`/`memory.init`/`data.drop`/`elem.drop`/`table.set` in a fork-path function body is no longer individually wrapped by `(if state == NORMAL then op else drop+defaults)`. The dispatch mechanism makes these unconditionally safe: they only execute on normal flow. Removing 4g shrinks instrumented modules by a measurable fraction (~3-8% per fork-path function; bash/git biggest winners).
- **Phase 4c's if-else condition** — call sites no longer need `(state == NORMAL) || (state == REWINDING && call_idx == N)`. The normal-flow call-site is a plain `(call ...)` after its arg reload; the REWIND-to-this-call-site path arrives via `br_table` directly.
- **`emit_wrapped_call`'s else branch** — no more synthesizing default return values for skipped calls. A skipped call is literally not in the execution trace.
- **`emit_gated_side_effect`** entirely.

### What survives

- **`crates/fork-instrument/src/call_graph.rs`** verbatim. Fork-path closure (direct + indirect) has nothing to do with the transform shape.
- **`crates/fork-instrument/src/runtime.rs`** verbatim. State machine, exported ABI, save-buffer layout, saved-globals handling, `wpk_fork_unwind_begin`/`rewind_begin` all stay the same.
- **Preamble** (load frame → restore locals → restore call_idx/catch_region_id/exnref_slot) — relocated to run before the dispatch block, but the code is reused.
- **Postamble** (write header → save locals → advance `current_pos`) — unchanged.
- **Phase 4f ref-typed-local spilling** — aux tables still exist, still hold ref-typed user locals across fork. Reload is still from the preamble; spill is still from the postamble.
- **Phase 6a-b-c catch-region plumbing** — `catch_region_id` is still assigned per try_table, still round-tripped through the frame, still drives the `throw_ref` stub at the top of the try_table body (Phase 6c). The mechanism re-enters the catch handler via `throw_ref` on REWIND — unchanged by this redesign.
- **Phase 6d `$outer/$capture` injection** — stays. Catch-handler entry still captures the exnref into the aux table and flips `in_catch_K=1`. The `in_catch_K` flags are still queried at each call site to compute `catch_region_id_local`/`exnref_slot_local` (Phase 6e).
- **Phase 6e** — stays, writing `catch_region_id_local` and `exnref_slot_local` at each call site. Location in the emitted code: between the call instruction and the UNWINDING propagation check, exactly where it is today.

### Dispatch and try_tables — the interaction

`br_table` can only target labels at or above the current nesting depth. A call site *inside* a `try_table` body is enclosed by the try_table; a top-level dispatch `br_table` cannot land there, because entering a try_table from outside via `br` is not a thing in wasm semantics.

**MVP scope (this PR):**
- Calls *not* inside any try_table body → participate in the top-level dispatch. This covers the 8 failing sortix tests plus the overwhelming majority of fork paths across bash/dash/vim/nginx/etc.
- Calls *inside* a try_table body → keep the Phase 6c `throw_ref`-driven re-entry as today, BUT with a nested dispatch block inside the try_table body that handles the case of multiple fork-path calls inside the same try_table body. Spec:
  - Each try_table body on the fork path gets its own `region_id` and its own nested `(block $POST_region_K_0)(block $POST_region_K_1)...` structure. Calls inside the body participate in the region's dispatch, not the top-level dispatch.
  - At function entry, the preamble checks `catch_region_id_local`:
    - `== 0` → top-level dispatch (br_table to function-level POST_K labels).
    - `!= 0` → fall through (don't dispatch at top level). The first instruction in the relevant try_table body (Phase 6c's `throw_ref` stub) will re-enter the try_table via `throw_ref`. At the try_table body's top, a second dispatch checks `catch_region_id_local == region_id` → if yes, `br_table` into the body-local POST_K labels, which land just before the right call inside the body.
  - If no fork-path call exists inside a given try_table body, no nested dispatch is emitted — the body's top remains the bare Phase 6c stub.
- Calls *inside catch handlers* (fork-from-catch, the B1 follow-up pattern) → still unsupported. Phase 6d continues to inject `$outer/$capture` on catch clauses, but calls inside handlers remain outside the dispatch coverage. Instrument-time detection: if a fork-path call is reachable from inside a catch-handler body, emit a `panic!`/error suggesting the caller set `B1_DEFERRED` in the issue tracker. (Concretely: `crates/fork-instrument/src/instrument.rs` gains a `detect_fork_from_catch()` pre-pass that sets a flag; the dispatch-emitter panics if the flag is set with a clear message.)

**Out-of-scope decision on B1:** does the switch-dispatch redesign make B1 almost-free? *No.* B1 requires dispatch *inside* a catch-handler body, which is a separate nested structure. Implementing nested dispatch in catch handlers is an extension of the same mechanism we'll build for try_table bodies, but it stacks: now each handler has its own region, its own call_idx namespace, its own postamble routing. The spike (Task 1) will tell us whether the dispatch-emitter code generalizes cleanly to `region = {top-level, per-try-body, per-catch-handler-body}` or needs more surgery. If the spike confirms it's a clean generalization, we revisit B1 in a follow-up PR. Default assumption: B1 follow-up budget is unchanged (~1–1.5 weeks, staged 5-step plan per `memory/fork-instrument-b1-followup.md`).

### ABI_VERSION bump: 4 → 5

Even though the host-facing ABI (export names + buffer layout) is unchanged, we bump `ABI_VERSION` for three reasons:

1. **Cache invalidation.** A developer with a build cache containing pre-redesign user-program `.wasm` binaries would silently pick up the old transform if we didn't bump. The old transform has the bug we're fixing; running a mixed-shape binary is a correctness trap with no error message. Bumping makes the host refuse the old binary at process-start with a clear version-mismatch error.
2. **ABI-versioning policy ( `CLAUDE.md` § "Kernel ABI stability").** The snapshot check covers "Kernel-wasm exports (any `kernel_*` function signature change, global type/mutability change, or new/removed export that isn't on the toolchain denylist)." The exports `wpk_fork_*` don't change signatures, but their *semantics* do: behavior at REWINDING-state entry shifts from "re-execute body with gates" to "dispatch and skip." Fork-child reconstruction is load-bearing enough that the policy's intent covers it.
3. **Differentiation during PR review.** A clean ABI_VERSION bump line in the diff makes it unambiguous to reviewers that this is a kernel-user-program contract change, not a pure optimization.

Snapshot regeneration: `bash scripts/check-abi-version.sh update`. Commit `abi/snapshot.json` with the `ABI_VERSION` bump in the same commit as the implementation.

---

## Regression gates (end-to-end, verified in Task 17)

All of these must hold at PR-open time:

- **The 8 sortix FAILs** tracked at [`memory/fork-instrument-phase7-debug-evidence.md`](../../../.claude/projects/-Users-brandon-ai-src-kandelo/memory/fork-instrument-phase7-debug-evidence.md) → PASS:
  - `basic/signal/killpg`
  - `basic/spawn/posix_spawnattr_setpgroup`
  - `basic/sys_wait/waitpid`
  - `io/dup3-clofork-fork`
  - `io/open-clofork-fork`
  - `process/fork-exec-setpgid-in-parent`
  - `process/fork-setsid-setpgid-in-parent`
  - `process/fork-setsid-setpgid-in-parent-move`
- **The 35 sortix tests** that broke under the naive 2026-04-22 gate-all-direct-calls fix → all stay PASS. Full list, for the acceptance checklist:
  - `basic/nl_types/{catclose,catgets,catopen}`
  - `basic/pthread/pthread_atfork`
  - `basic/spawn/posix_spawn`, `basic/spawn/posix_spawn_file_actions_{addchdir,addclose,adddup2,addfchdir,addopen}`, `basic/spawn/posix_spawnp`
  - `basic/stdio/{popen,pclose}`
  - `basic/termios/{tcdrain,tcflow,tcflush,tcgetattr,tcgetsid,tcgetwinsize,tcsendbreak,tcsetattr,tcsetwinsize}`
  - `basic/unistd/{lockf,tcgetpgrp,tcsetpgrp,ttyname,ttyname_r}`
  - `basic/wordexp/{wordexp,wordfree}`
  - `process/fork-setpgid-another-undo-{redo,undo}`
  - `process/waitpid-pgid`, `process/waitpid-pgid-empty-on-setpgid`, `process/waitpid-pgid-empty-on-setpgid-rejoin`, `process/waitpid-pgid-empty-on-setsid`
- **Full 5-suite regression matrix** (from `CLAUDE.md`):
  - `cargo test -p kandelo --target aarch64-apple-darwin --lib` — all pass.
  - `cd host && npx vitest run` — all pass.
  - `scripts/run-libc-tests.sh` — 0 unexpected FAILs. `popen`/`daemon-failure` XFAILs are acceptable (pre-existing).
  - `scripts/run-posix-tests.sh` — 0 FAILs. Pre-existing XFAILs acceptable.
  - `scripts/run-sortix-tests.sh --all` — 0 FAILs, 0 XPASSes.
- **ABI snapshot check:** `bash scripts/check-abi-version.sh` exits 0 with `ABI_VERSION` bumped 4→5 in the same commit as `abi/snapshot.json`.
- **Fork-instrument fuzz gate:** ≥ 10 000 iterations, zero validator failures. On macOS arm64, `scripts/run-fork-instrument-fuzz.sh` already passes `--sanitizer=none`.
- **Benchmark diff:** ±3% per the §5.5 policy in the original design doc — 5 suites × 2 hosts (Node + browser). Syscall-heavy suites (`process-lifecycle`, `erlang-ring`, `wordpress`) are the sensitive ones.

---

## Environmental prereqs (fresh-worktree gotchas)

- `npm install` at the **repo root** (not just `host/`) — without this, `tsx/esm` fails and every test-runner Node invocation errors out with `Cannot find package 'tsx'`.
- After any `ABI_VERSION` change: run `bash scripts/check-abi-version.sh update` **before** `bash scripts/build-programs.sh`, so `glue/abi_constants.h` is fresh when user programs compile against the new version.
- Build the tool for the host triple: `cargo build -p fork-instrument --release --target aarch64-apple-darwin`. The default workspace target (`wasm64-unknown-unknown` from `.cargo/config.toml`) cannot build host crates.
- Install the tool: `cp target/aarch64-apple-darwin/release/wasm-fork-instrument tools/bin/wasm-fork-instrument`. Build scripts call the `tools/bin/` path, not `cargo run`.

---

## Task 1: Spike — hand-authored switch-dispatch WAT fixture

**Why now:** de-risks the walrus IR emission and the try_table/`call_indirect` interaction before writing hundreds of lines of tool code. ~2 hours. If the spike fails (e.g., walrus can't express a nested `br_table` with the shape we want, or the host can't drive a spike binary through a fork cycle), we learn it now rather than in Task 7.

**Files:**
- Create: `crates/fork-instrument/tests/fixtures/spike_switch_dispatch.wat` (new)
- Modify: `crates/fork-instrument/tests/roundtrip.rs` (append spike test)

**Step 1: Author the spike WAT.**

Write a minimal wasm32 module that:
1. Imports `(import "kernel" "kernel_fork" (func (result i32)))`.
2. Imports `(import "kernel" "side_effect" (func (param i32)))` — a stand-in for a non-fork-path direct call that must NOT re-fire on rewind.
3. Defines one local function `main` that calls `side_effect(42)`, then calls `kernel_fork()`, then calls `side_effect(99)` with the fork result, then returns. Target the new dispatch shape by hand — one `$POST_0` block around the first fork-path call site, preamble at function entry reading `call_idx_local` from a fixed buffer offset, dispatch `br_table $POST_0 $unwind_save` inside an `if state == REWINDING`.
4. Re-use the runtime-emitted globals/exports from `runtime::inject_runtime` — or, simpler: emit the five `wpk_fork_*` exports and two globals by hand in the WAT. Match the signatures exactly so the host runtime's lookups succeed.

Save to `crates/fork-instrument/tests/fixtures/spike_switch_dispatch.wat`.

**Step 2: Write the failing test.**

Append to `crates/fork-instrument/tests/roundtrip.rs`:

```rust
#[test]
fn spike_switch_dispatch_validates() {
    let wat = include_str!("fixtures/spike_switch_dispatch.wat");
    let bytes = wat::parse_str(wat).expect("wat parse");
    walrus::Module::from_buffer(&bytes).expect("walrus validates");
    wasmparser::validate(&bytes).expect("wasmparser validates");
}
```

**Step 3: Run; confirm it passes.**

Run: `cargo test -p fork-instrument --target aarch64-apple-darwin spike_switch_dispatch_validates`
Expected: PASS.

If FAIL due to walrus rejecting the shape, this is the signal to revise the design before going further.

**Step 4: Wire through host runtime end-to-end.**

In a throwaway script (do not commit):

```bash
# Build the spike binary
wat2wasm crates/fork-instrument/tests/fixtures/spike_switch_dispatch.wat -o /tmp/spike.wasm

# Exercise via run-example.ts
timeout 20 node --experimental-wasm-exnref --import tsx/esm \
  examples/run-example.ts /tmp/spike.wasm
```

Expected: spike binary runs, forks once, child returns 0, parent returns a pid, both exit cleanly. `side_effect` should be invoked exactly 3 times total (parent: 42, 99; child: 99). If child also invokes `side_effect(42)`, the spike's dispatch is wrong — fix before moving on.

**Step 5: Commit.**

```bash
git add crates/fork-instrument/tests/fixtures/spike_switch_dispatch.wat \
        crates/fork-instrument/tests/roundtrip.rs
git commit -m "test(fork-instrument): spike fixture for switch-dispatch shape"
```

---

## Task 2: Create the `phase-7-switch-dispatch` worktree

**Why now:** from this task forward, work moves to the new branch. Keeps `phase-7-rollout`'s 12 commits untouched.

**Step 1: Verify you're at `phase-7-rollout` HEAD in the phase-7-rollout worktree.**

Run from `/Users/brandon/.superset/worktrees/kandelo/phase-7-rollout`:

```bash
git rev-parse --abbrev-ref HEAD
# expected: phase-7-rollout
git log -1 --format='%H %s'
# expected: the most recent commit per memory/fork-instrument-project.md (e.g., d62e8cbb0)
```

**Step 2: Create worktree.**

```bash
cd /Users/brandon/.superset/worktrees/kandelo/phase-7-rollout
git worktree add \
  -b phase-7-switch-dispatch \
  /Users/brandon/.superset/worktrees/kandelo/phase-7-switch-dispatch \
  phase-7-rollout
cd /Users/brandon/.superset/worktrees/kandelo/phase-7-switch-dispatch
git submodule update --init musl os-test libc-test
npm install                   # root-level, for tsx/esm
cd host && npm install && cd ..
```

**Step 3: Copy the spike fixture and test from `phase-7-rollout` (Task 1 lives there).**

Already on the branch, since Task 1 was committed to `phase-7-rollout`. No action needed — the new worktree inherits.

**Step 4: Smoke test.**

```bash
cargo build -p fork-instrument --release --target aarch64-apple-darwin
cargo test -p fork-instrument --target aarch64-apple-darwin
```

Expected: 74 tests pass (same as `phase-7-rollout` baseline).

**No commit this task.** The worktree creation is a local state change.

---

## Task 3: Copy this plan file into the new worktree & commit

**Files:**
- Modify: `docs/plans/2026-04-22-fork-instrument-switch-dispatch-redesign.md` (already created in phase-7-rollout; committed on the new branch here)

**Step 1: Verify the plan file exists in the new worktree.**

```bash
cd /Users/brandon/.superset/worktrees/kandelo/phase-7-switch-dispatch
ls -la docs/plans/2026-04-22-fork-instrument-switch-dispatch-redesign.md
```

If absent, copy from `phase-7-rollout`:

```bash
cp ../phase-7-rollout/docs/plans/2026-04-22-fork-instrument-switch-dispatch-redesign.md \
   docs/plans/
```

**Step 2: Commit the plan on the new branch.**

```bash
git add docs/plans/2026-04-22-fork-instrument-switch-dispatch-redesign.md
git commit -m "docs: add switch-dispatch redesign implementation plan"
```

---

## Task 4: ABI_VERSION bump + snapshot update (empty delta)

**Why now:** isolates the ABI version change from the code rewrite so the snapshot diff is easy to review (empty structural delta, just version bump). Later tasks ride on this.

**Files:**
- Modify: `crates/shared/src/lib.rs` — find `pub const ABI_VERSION: u32 = 4;`, change to `5`.
- Modify: `abi/snapshot.json` — regenerate via script.

**Step 1: Bump the constant.**

Find `ABI_VERSION` in `crates/shared/src/lib.rs`. Change `4` → `5`. Update the accompanying comment with a one-line note: `// 5: fork-instrument switch-dispatch redesign (2026-04-22)`.

**Step 2: Regenerate the snapshot.**

```bash
bash scripts/check-abi-version.sh update
git diff abi/snapshot.json
```

Expected diff: only the `abi_version` field changes `4` → `5`. No structural churn. If anything else drifts, stop — snapshot generation picked up an unrelated change; inspect before proceeding.

**Step 3: Verify the check passes.**

```bash
bash scripts/check-abi-version.sh
```

Expected: exit 0.

**Step 4: Commit.**

```bash
git add crates/shared/src/lib.rs abi/snapshot.json
git commit -m "feat(abi)!: bump ABI_VERSION 4→5 for fork-instrument switch-dispatch

The kernel-user-program contract's fork-reconstruction semantics change
in the next commit. Bumping so the host refuses stale old-transform
binaries from build caches."
```

---

## Task 5: Failing regression tests — the 8 sortix FAILs as fast-fail unit tests

**Why now:** capture the bugs as unit-testable assertions in the tool. We won't run full sortix on every save, but we can build a minimal C program that replicates the waitpid-class bug and instrument it, then decompile the instrumented output and assert the desired shape (br_table dispatch, chunk 0 outside $POST_0, non-fork-path calls not re-executed). Rapid iteration beats running full sortix for 30 minutes per trial.

**Files:**
- Create: `crates/fork-instrument/tests/switch_dispatch.rs` (new test file; MVP empty for now)
- Create: `crates/fork-instrument/tests/fixtures/switch_dispatch/waitpid_class.wat` — hand-written wasm module mimicking `os-test/basic/sys_wait/waitpid.c`'s compiled shape at the instrumented-call-site level.
- Create: `crates/fork-instrument/tests/fixtures/switch_dispatch/posix_spawn_class.wat` — hand-written module mimicking a posix_spawn-class shadow-stack pattern.

**Step 1: Author the fixtures.**

`waitpid_class.wat` shape:
- Imports `kernel.kernel_fork`.
- One function `main` that:
  - Calls an imported `kernel.setpgid` (stand-in for a non-fork-path direct call) with args `(0, 0)`.
  - Four unrolled `call $kernel_fork` sites (matching LLVM's unrolling of the os-test loop), each followed by a pseudo-waitpid check.
- Exports `_start` → `main`.

`posix_spawn_class.wat` shape:
- Imports `kernel.kernel_fork`, `kernel.write_through_pointer` (takes `i32 ptr`, `i32 value`).
- Main allocates on the shadow stack (simulated via `global.set $__stack_pointer` operations): reserves 16 bytes, stores a magic number, calls `write_through_pointer(sp, magic)` to force the kernel to observe the stack state, then calls `kernel_fork`, then `write_through_pointer(sp, magic)` again with the same pointer.
- Parent expects to see the same magic both times; child expects to NOT see the first write replay.

**Step 2: Write the failing tests.**

In `crates/fork-instrument/tests/switch_dispatch.rs`:

```rust
//! Regression tests for the switch-dispatch redesign.
//!
//! These tests codify the two classes of fork-semantic bug proven in
//! the 2026-04-22 debug session (see
//! memory/fork-instrument-phase7-debug-evidence.md):
//!
//! - waitpid-class: non-fork-path direct calls must NOT re-fire during
//!   REWINDING.
//! - posix_spawn-class: code between call sites must NOT re-execute,
//!   including shadow-stack manipulation.
//!
//! They are expected to FAIL until Task 7 lands the new transform.

use fork_instrument::{instrument, Options};

#[test]
fn waitpid_class_non_fork_path_call_skipped_on_rewind() {
    let wat = include_str!("fixtures/switch_dispatch/waitpid_class.wat");
    let input = wat::parse_str(wat).unwrap();
    let output = instrument(&input, &Options::default()).unwrap();
    let module = walrus::Module::from_buffer(&output).unwrap();

    // Assert: `main`'s body contains a `br_table` at the top (within
    // the REWINDING guard), and the call to `kernel.setpgid` is NOT
    // inside any `$POST_K` landing-block.
    assert!(has_top_level_br_table_dispatch(&module, "main"));
    assert!(!call_appears_inside_dispatch_body(&module, "main", "kernel.setpgid"));
}

#[test]
fn posix_spawn_class_shadow_stack_not_duplicated() {
    let wat = include_str!("fixtures/switch_dispatch/posix_spawn_class.wat");
    let input = wat::parse_str(wat).unwrap();
    let output = instrument(&input, &Options::default()).unwrap();
    let module = walrus::Module::from_buffer(&output).unwrap();

    // Assert: the global.set $__stack_pointer sequence appears exactly
    // once in main's emitted body (not wrapped, not duplicated).
    let count = count_global_set(&module, "main", "__stack_pointer");
    assert_eq!(count, 1, "shadow-stack adjustment must appear exactly once");
}

// Helper predicates — implemented against walrus IR.
// See the Task 5 Step 3 reference implementation block below.
fn has_top_level_br_table_dispatch(m: &walrus::Module, func_name: &str) -> bool { todo!() }
fn call_appears_inside_dispatch_body(m: &walrus::Module, func_name: &str, import: &str) -> bool { todo!() }
fn count_global_set(m: &walrus::Module, func_name: &str, global_name: &str) -> usize { todo!() }
```

**Step 3: Implement the walrus-based predicate helpers as stubs that assert.**

Leave `todo!()` for now — filling them in after Task 7 when the new shape exists makes the helpers easier to calibrate. The tests fail loudly on `todo!()` until Task 7.

**Step 4: Run; confirm it fails.**

```bash
cargo test -p fork-instrument --target aarch64-apple-darwin switch_dispatch
```

Expected: 2 tests FAIL with `not implemented` from `todo!()`. This is the intended failure — it gates Task 7's completion.

**Step 5: Commit.**

```bash
git add crates/fork-instrument/tests/switch_dispatch.rs \
        crates/fork-instrument/tests/fixtures/switch_dispatch/
git commit -m "test(fork-instrument): failing regression tests for switch-dispatch

- waitpid-class: non-fork-path direct calls must be skipped on rewind
- posix_spawn-class: pre-call body code must not be re-executed

Both tests todo!() through helper predicates until the transform
lands. They serve as the executable checklist for Task 7."
```

---

## Task 6: Delete the 4g side-effect gate test suite

**Why now:** these tests assert the shape that's about to go away. Removing them first keeps the Task 7 diff focused on the transform rewrite, not on test churn.

**Files:**
- Modify: `crates/fork-instrument/tests/instrument.rs` — delete 4g-gating tests and their fixture helpers.

**Step 1: Identify the 4g tests to delete.**

Candidates (grep inside the file for `4g` or `side_effect` or `gated`):

```bash
grep -n '4g\|side[_-]effect\|gated\|NORMAL[_-]gated' crates/fork-instrument/tests/instrument.rs | head -30
```

Expected: ~10 tests, ~400–600 lines. Typical names: `local_set_is_gated`, `store_is_gated`, `memory_grow_is_gated`, `table_set_is_gated`, `global_set_is_gated_but_state_global_exempt`, etc.

**Step 2: Delete the test functions and any 4g-specific helper functions in the file.**

Keep structural/4b/4c/4d/4f tests intact — they'll be rewritten in Task 7 but the delete-then-rewrite rhythm is cleaner done piecewise. For this task, delete ONLY the 4g tests.

**Step 3: Verify build still passes.**

```bash
cargo test -p fork-instrument --target aarch64-apple-darwin
```

Expected: 74 − <4g count> tests pass. No failures.

**Step 4: Commit.**

```bash
git add crates/fork-instrument/tests/instrument.rs
git commit -m "test(fork-instrument): remove 4g side-effect gate tests

These tests assert the preamble + per-op-gated body shape that the
switch-dispatch redesign obsoletes. The new transform skips all code
between dispatch landing points on REWIND, so per-op gating is
unneeded. Tests for the new shape land in Task 7."
```

---

## Task 7: Bulk rewrite of `crates/fork-instrument/src/instrument.rs`

**This is the core task.** Expected LoC delta: ~ −500 to +300 net, settling around 1700–1900 lines (vs. 2051 today). The new transform is STRUCTURALLY simpler than the old (no 4g gating, no per-call-site if-else around the call instr, simpler 6c integration).

**Commit policy:** one atomic commit. Do not split into sub-tasks — the per-function transform is a cohesive redesign; a half-done state has no useful test surface.

**Files:**
- Modify: `crates/fork-instrument/src/instrument.rs` — rewrite `instrument_one_function` and all its helpers.
- Leave untouched: `crates/fork-instrument/src/call_graph.rs`, `crates/fork-instrument/src/runtime.rs`, `crates/fork-instrument/src/lib.rs`, `crates/fork-instrument/src/main.rs`.
- Modify: `crates/fork-instrument/tests/instrument.rs` — rewrite existing tests that asserted the old 4b/4c/4d shape.

**Step 1: Write the new per-function transform.**

Structure the new `instrument_one_function` around these helpers:

```rust
#[allow(clippy::too_many_arguments)]
fn instrument_one_function(...) {
    // 1. Collect user locals + ref locals, same as today.
    // 2. Plan aux tables + catch-handler locals, same as today.
    // 3. Discover call sites:
    //    - Top-level calls (not inside any try_table body).
    //    - Per-region calls (calls inside try_table body K).
    //    Assign stable call_idx per region, starting at 0 per region.
    // 4. Build synthetic per-call arg-spill locals (one per arg, per call site).
    // 5. Emit preamble: if REWINDING, pop frame + restore call_idx_local +
    //    restore user locals (scalar + ref) + restore arg-spill locals.
    // 6. Emit top-level dispatch-and-wrapper structure:
    //    - Outer $unwind_save block (br target for UNWINDING).
    //    - Nested $POST_0..$POST_N blocks (one per top-level call site).
    //    - Inner $dispatch_normal block containing the REWINDING check +
    //      br_table.
    //    - Body chunks interleaved with calls, spills, post-call handling
    //      (Phase 6e + UNWINDING propagation + call_idx set).
    // 7. For each try_table body containing fork-path calls, do the same
    //    structure nested inside its body (after the Phase 6c stub).
    // 8. Emit postamble (unchanged from current design).
}
```

Key implementation pivots:

- **Call-site classification.** Before emitting the dispatch, walk the body to classify each call as "top-level" or "inside try_table body K." Collect into `Vec<Vec<CallSiteInfo>>` indexed by region (region 0 = top-level, regions 1..N = per-try-table-body). Store `body_seq_id` for each call site so the body-emitter can later inject the call at the right seq.

- **Chunking.** Between call sites, the body is divided into "chunks" — spans of original instructions with no fork-path calls. A chunk may contain non-fork-path calls, side-effect ops, nested blocks/loops/ifs, and even try_tables (if a try_table has no fork-path calls inside it, it's just part of the chunk). Chunks are preserved verbatim in the emitted body — no wrapping, no gating.

- **Argument spilling.** Before each fork-path call, the chunk's last operation leaves args on the operand stack. Spill those to fresh user-visible scalar locals *inside* the chunk (so they're visible to the frame save/restore). Reload them after the `$POST_K` block closes. Critical: `local.set` for args happens on the NORMAL path (inside the chunk, before the `)` of $POST_K); during REWIND dispatch, the preamble already restored them from the frame. The reload (`local.get`) happens right before the call — on both paths.

- **Indirect calls.** Treat the table index as an additional arg (append to arg_types), spill it to an i32 local. No special-casing beyond that.

- **Phase 6e integration.** Between the `call` instruction and the UNWINDING-propagation br_if, emit the Phase 6e sequence (iterate `catch_handlers`; for each handler K, `if (in_catch_K) { catch_region_id_local := K; exnref_slot_local := slot_K }`). Same as today — just the *location* moves slightly because the call-site scaffolding is different.

- **UNWINDING propagation.** After the call: `local.set $call_idx_local = N` (so the postamble records this function-call pair). Then `global.get $_wpk_fork_state; i32.const UNWINDING; i32.eq; br_if $unwind_save`.

- **`$dispatch_normal` block.** Emit as `InstrSeqType::Simple(None)`. The REWINDING check and br_table live inside; NORMAL path falls through out the end of the block. The br_table's `default` label should be `$unwind_save` (defensive: a bogus call_idx traps cleanly via the postamble's `unreachable` for non-nullable-ref results, or via the later defaulted returns).

- **Nested try_table dispatch.** For each try_table body with fork-path calls, after the Phase 6c stub, emit a second dispatch structure inside the body:
  ```wat
  (block $region_K_POST_{L-1}
    ...
      (block $region_K_POST_0
        (block $region_K_dispatch_normal
          (if (and (state == REWINDING) (catch_region_id_local == K))
            (then (br_table $region_K_POST_0 ... $region_K_POST_{L-1} (call_idx_local))))
        )
        <region K chunk 0>
        <spill args for region K call 0>
      )
      <reload args>
      (call $callee)
      ...
    ...
  )
  ```
  The call_idx_local is shared across all regions in the function — different regions' postamble and body-top guards make sure it's only interpreted in its correct region. Alternative: per-region call_idx locals. For MVP, share one local (simpler); optimize to per-region if fuzz surfaces ambiguity.

- **Fork-from-catch detection.** Add a pre-pass `detect_fork_from_catch(module, func_id, fork_path) -> bool`. If any fork-path call is reachable from inside a catch-handler body (not body — *handler*), emit an error-return or `panic!` with a message pointing at `memory/fork-instrument-b1-followup.md`. We detect rather than silently mis-instrument: B1 is the staged follow-up.

**Step 2: Rewrite the structural tests in `tests/instrument.rs`.**

Update test assertions to match the new shape. Roughly:

- **Keep:** tests asserting the presence of `_wpk_fork_state`, `_wpk_fork_buf`, and the five exports. These assert on runtime.rs output, not the transform.
- **Keep:** tests asserting aux-table injection for ref locals. Phase 4f behavior is unchanged.
- **Rewrite:** any test whose body was "inside the wrapper block, the Nth instruction is a state==NORMAL if-else" — new assertion should be "inside the function, the Nth top-level instruction is a `block $unwind_save` containing `block $POST_K` nested structure with a br_table inside."
- **Rewrite:** tests for call-site wrapping. New assertion: the call instruction appears immediately after `end $POST_K` in the emitted seq; no surrounding if-else.
- **Rewrite:** tests for Phase 6c/6d/6e. Most of their shape-assertions still hold (throw_ref stub at try_table body entry, $outer/$capture injection), but the 6e writes are now in the post-call chunk of the dispatch structure rather than inside an if-else.

Helper approach: build three or four small walrus traversal helpers (`find_function`, `body_contains_block_with_label`, `count_calls_to`, `count_global_sets_of`) that make assertions readable. Reuse these in the Task 5 regression tests' `todo!()` stubs.

**Step 3: Fill in the Task 5 regression test `todo!()` helpers.**

With the new shape now in place, implement `has_top_level_br_table_dispatch`, `call_appears_inside_dispatch_body`, `count_global_set` against walrus IR.

**Step 4: Run the full crate test suite.**

```bash
cargo test -p fork-instrument --target aarch64-apple-darwin
```

Expected: **all tests pass**, including the Task 5 regression tests. If any fail, diagnose before moving on. Especially:
- `spike_switch_dispatch_validates` should still pass (the hand-authored fixture is a superset of what the tool produces).
- `switch_dispatch::waitpid_class_non_fork_path_call_skipped_on_rewind` must PASS.
- `switch_dispatch::posix_spawn_class_shadow_stack_not_duplicated` must PASS.

**Step 5: Install the new tool binary and smoke-test against a tiny fork program.**

```bash
cargo build -p fork-instrument --release --target aarch64-apple-darwin
cp target/aarch64-apple-darwin/release/wasm-fork-instrument tools/bin/

# Compile a small C fork test
bash scripts/build-programs.sh simple/fork-simple  # or the nearest existing target

# Run end-to-end
timeout 20 node --experimental-wasm-exnref --import tsx/esm \
  examples/run-example.ts build/simple/fork-simple.wasm
```

Expected: fork works, exit 0. If this fails, the transform has a wasm-level correctness bug — do not commit; debug first.

**Step 6: Commit.**

```bash
git add crates/fork-instrument/src/instrument.rs \
        crates/fork-instrument/tests/instrument.rs \
        crates/fork-instrument/tests/switch_dispatch.rs \
        tools/bin/wasm-fork-instrument     # if .gitignore doesn't already exclude it
git commit -m "feat(fork-instrument)!: switch-dispatch transform

Re-architect instrument_one_function to use nested \$POST_K blocks
around a REWINDING-guarded br_table dispatch (asyncify-style). REWIND
now jumps directly to the post-active-call-site label rather than
re-executing the body top-to-bottom with state-gated side effects.

Fixes two classes of bug proven in the 2026-04-22 debug session:
- waitpid-class: non-fork-path direct calls (setpgid, dup3, open,
  kill, pipe, etc.) no longer re-fire during child rewind.
- posix_spawn-class: shadow-stack manipulation and pre-call arg setup
  no longer re-execute during rewind.

Deletes Phase 4g (per-op side-effect gating) — dispatch skips all
code between landing points, making per-op gates redundant.

Keeps verbatim: crates/fork-instrument/src/call_graph.rs,
crates/fork-instrument/src/runtime.rs, the 5 exported wpk_fork_*
functions, save-buffer layout, frame layout. Host runtime
(worker-main.ts) is unchanged.

Calls inside try_table bodies use a nested per-region dispatch inside
the body, gated by catch_region_id. Fork-from-catch remains
unsupported (B1 follow-up tracked in memory/).

Refs: docs/plans/2026-04-22-fork-instrument-switch-dispatch-redesign.md"
```

---

## Task 8: Rebuild committed wasm artifacts + run fork-instrument fuzz gate

**Why now:** the tool's output shape changed. Every committed `.wasm` in `host/wasm/` (and any `examples/*/out/`) needs a rebuild against the new instrumentation. Fuzzing catches wasm-validator divergences on synthesized shapes.

**Step 1: Rebuild kernel + user programs.**

```bash
bash build.sh
scripts/build-programs.sh
```

Expected: kernel unchanged. User programs rebuilt; new transform applied. `git status` will show modified `.wasm` files.

**Step 2: Fuzz gate.**

```bash
FUZZ_RUNS=10000 scripts/run-fork-instrument-fuzz.sh --sanitizer=none
```

Expected: `#10000 DONE` with zero validator failures. Record exec/s and coverage in the eventual PR description.

If fuzz surfaces a validator failure, triage:
- WAT fixture → instrumented wasm → walrus validates but wasmparser rejects (or vice-versa): there's a specific shape the tool emits that's ill-formed. Minimize with `cargo fuzz cmin`, fix the emitter, re-run.

**Step 3: Commit the rebuilt artifacts.**

```bash
git add host/wasm/ examples/
git commit -m "build: rebuild wasm artifacts against switch-dispatch tool"
```

---

## Task 9: Host integration tests (vitest) smoke pass

**Why now:** fastest feedback on fork semantics. Vitest catches cross-process regressions (pipes, fork+exec) in seconds.

```bash
cd host && npx vitest run
```

Expected: all tests pass. Git tests may skip if `host/wasm/git.wasm` is absent — acceptable; Task 10 rebuilds full programs.

If any fork-touching test fails, triage *before* running the longer regression suites.

**No commit** — Task 9 is verification.

---

## Task 10: Rebuild all fork-using programs from their build scripts

**Why now:** every ported program with fork on its call path must be rebuilt against the new tool for its binary to be valid. This task is a long-running rebuild sweep.

**Files to invoke (from `memory/fork-instrument-project.md` and the current `phase-7-rollout` inventory):**

- `examples/libs/bash/build-bash.sh`
- `examples/libs/dash/build-dash.sh`
- `examples/libs/git/build-git.sh`
- `examples/libs/quickjs/build-quickjs.sh`
- `examples/libs/sqlite/build-testfixture.sh`
- `examples/libs/tcl/build-tcl.sh`
- `examples/libs/vim/build-vim.sh`
- `examples/nginx/build.sh`
- `examples/nginx/build-php-fpm.sh`
- (Ruby: see notes — currently uses WASI-generated POSTLINK; may no-op.)

**Step 1: Rebuild in sequence (can be parallelized later if time permits).**

```bash
for script in \
  examples/libs/bash/build-bash.sh \
  examples/libs/dash/build-dash.sh \
  examples/libs/git/build-git.sh \
  examples/libs/quickjs/build-quickjs.sh \
  examples/libs/sqlite/build-testfixture.sh \
  examples/libs/tcl/build-tcl.sh \
  examples/libs/vim/build-vim.sh \
  examples/nginx/build.sh \
  examples/nginx/build-php-fpm.sh; do
  echo "=== $script ==="
  bash "$script" || { echo "FAIL: $script"; exit 1; }
done
```

Each script should succeed. Measure and record approximate binary-size deltas vs. `phase-7-rollout` baseline — expected shrinkage (4g gating removed).

**Step 2: Commit rebuilt artifacts.**

```bash
git add examples/ host/wasm/
git commit -m "build: rebuild all fork-using programs against switch-dispatch"
```

---

## Task 11: Full 5-suite regression matrix

Run all five suites from `CLAUDE.md`. This is the big gate.

### 11.1 Cargo unit tests

```bash
cargo test -p kandelo --target aarch64-apple-darwin --lib
```

Expected: 539+ tests pass, 0 failures.

### 11.2 Host integration tests (already run in Task 9; re-run for clean matrix)

```bash
cd host && npx vitest run
```

### 11.3 libc-test

```bash
scripts/run-libc-tests.sh
```

Expected: 0 unexpected FAILs. `XFAIL` and `TIME` acceptable. Baseline on `phase-7-rollout`: `popen` and `daemon-failure` XFAILs. No new FAILs.

### 11.4 Open POSIX Test Suite

```bash
scripts/run-posix-tests.sh
```

Expected: 0 FAILs. `UNRES` and `SKIP` acceptable.

### 11.5 sortix

```bash
scripts/run-sortix-tests.sh --all
```

Expected: 0 FAILs, 0 XPASSes. Baseline on `phase-7-rollout`: 8 FAILs (the ones we're fixing) + 18 XFAILs (architectural).

**The 8 FAILs must now PASS.** If any fail, the switch-dispatch implementation has a gap for that specific test pattern — triage before moving on. Use the single-test repro from `memory/fork-instrument-phase7-debug-evidence.md`:

```bash
timeout 20 node --experimental-wasm-exnref --import tsx/esm \
  examples/run-example.ts os-test/build/basic/sys_wait/waitpid.wasm
```

**The 35 previously-regressed tests must all PASS.** If ANY regressed, the dispatch has an over-eager skip — specifically, a posix_spawn-adjacent pattern. Build `/tmp/test-spawn5.c` per the 2026-04-22 session transcript as the minimal repro.

### 11.6 ABI snapshot

```bash
bash scripts/check-abi-version.sh
```

Expected: exit 0.

---

## Task 12: Benchmark diff vs. `phase-7-rollout` baseline

Per the design doc's §5.5 policy: ±3% for fork-heavy suites on both Node and browser hosts.

**Step 1: Establish baseline from `phase-7-rollout` worktree.**

```bash
cd /Users/brandon/.superset/worktrees/kandelo/phase-7-rollout
bash build.sh && scripts/build-programs.sh
npx tsx benchmarks/run.ts --rounds=3 --output=/tmp/bench-before-node.json
npx tsx benchmarks/run.ts --host=browser --rounds=3 --output=/tmp/bench-before-browser.json
```

(These runs can take 10–30 minutes each. Run in background if feasible.)

**Step 2: Run after (in the new worktree).**

```bash
cd /Users/brandon/.superset/worktrees/kandelo/phase-7-switch-dispatch
npx tsx benchmarks/run.ts --rounds=3 --output=/tmp/bench-after-node.json
npx tsx benchmarks/run.ts --host=browser --rounds=3 --output=/tmp/bench-after-browser.json
```

**Step 3: Compare.**

```bash
npx tsx benchmarks/compare.ts /tmp/bench-before-node.json /tmp/bench-after-node.json
npx tsx benchmarks/compare.ts /tmp/bench-before-browser.json /tmp/bench-after-browser.json
```

Expected: syscall-io, process-lifecycle, erlang-ring, wordpress, mariadb all within ±3%. Expectation is a small *improvement* (removing 4g per-op gating removes runtime branches).

Any suite regression > 3% → do not open PR. Triage the transform; likely candidate: dispatch blocks adding iCache pressure to hot paths.

---

## Task 13: Rewrite `docs/fork-instrumentation.md`

**Why now:** the 593-line user-facing reference describes the old transform (preamble + top-to-bottom wrapper + per-op gating). Must be current at merge time per `CLAUDE.md` documentation policy.

**File:**
- Modify: `docs/fork-instrumentation.md` — full rewrite preserving the sections that haven't changed.

**Content outline (preserving section names from the current doc where applicable):**

1. **Summary** — 3–4 sentences. What the tool is, where it lives, how it's invoked. Note the switch-dispatch shape as of `ABI_VERSION=5`.
2. **State machine** — unchanged from current doc.
3. **Exported ABI** — unchanged. Note that precondition/postcondition semantics are stable; the internal wasm shape changed.
4. **Save buffer format** — unchanged (byte-level layout still `current_pos` / `end_pos` / `saved_globals[]` / frame data).
5. **Frame format** — unchanged (`func_index`, `call_index`, `catch_region_id`, `exnref_slot`, scalar locals).
6. **Per-function transform — before/after WAT** — REWRITTEN. Show:
   - (a) Leaf function with one direct call: before (trivial) → after (dispatch + single `$POST_0` block).
   - (b) Function with two fork-path call sites: before (trivial) → after (dispatch + `$POST_0` + `$POST_1` nested).
   - (c) Function with `try_table` containing a fork-path call: before (trivial) → after (top-level dispatch + per-region dispatch inside try_table body).
   - (d) Function with indirect call via `call_indirect`: before → after.
   Pick fixtures from `crates/fork-instrument/tests/instrument.rs` (new-shape fixtures after Task 7).
7. **Auxiliary tables** — unchanged.
8. **Catch-handler resume** — mostly unchanged prose (the `throw_ref`-during-rewind trick is preserved); add a paragraph on nested per-region dispatch inside try_table bodies.
9. **Guarantees and non-guarantees** — UPDATE the non-guarantees list to drop "per-op side effects must be NORMAL-gated by the tool" (moot now) and keep "fork-from-catch-handler unsupported" (forward link to `memory/fork-instrument-b1-followup.md`).
10. **Performance envelope** — UPDATE with numbers from Task 12.
11. **Maintainer notes** — UPDATE:
    - How to add a new ref-type: unchanged.
    - How to add support for new side-effect ops: **section deleted** (4g is gone).
    - How to extend dispatch to new control structures (e.g., wasm-GC `struct.get_with_effect`): new section.
    - How to run the fuzz gate: unchanged.

Target length: 500–700 lines. May be slightly longer than current due to the new before/after fixtures.

**Step: Commit.**

```bash
git add docs/fork-instrumentation.md
git commit -m "docs: rewrite fork-instrumentation.md for switch-dispatch transform"
```

---

## Task 14: Update pointers in `docs/architecture.md`, `docs/porting-guide.md`, `docs/posix-status.md`, `CLAUDE.md`

**Files:**

- `docs/architecture.md` — fork section: mention switch-dispatch as the mechanism; link to `docs/fork-instrumentation.md`.
- `docs/porting-guide.md` — if it mentions per-op gating, remove. Auto-discovery of fork paths is unchanged.
- `docs/posix-status.md` — ensure "fork-from-catch is unsupported" entry is current; link to `memory/fork-instrument-b1-followup.md`.
- `CLAUDE.md` — if it mentions `ASYNCIFY_SAVE_SLOTS` or describes the transform shape, update. At minimum, bump the `ABI_VERSION` reference if present.

**Step 1: Grep for stale references.**

```bash
grep -rn 'side.effect.gating\|Phase 4g\|NORMAL-gated\|ABI_VERSION\|asyncify' docs/ CLAUDE.md
```

Review each hit; edit or leave per context.

**Step 2: Commit.**

```bash
git add docs/ CLAUDE.md
git commit -m "docs: refresh pointers for switch-dispatch fork-instrument"
```

---

## Task 15: Final regression pass + PR open

**Step 1: Re-run the Task 11 matrix once more** to confirm nothing drifted during Tasks 13–14 (doc-only changes shouldn't, but this is a paranoia gate).

**Step 2: Push branch and open PR.**

```bash
git push -u origin phase-7-switch-dispatch

gh pr create \
  --base main \
  --title "feat(fork-instrument)!: switch-dispatch transform redesign" \
  --body "$(cat <<'EOF'
## Summary
- Re-architect `crates/fork-instrument` per-function transform to use asyncify-style switch dispatch. REWIND now jumps directly to the post-active-call-site label via a `br_table` inside a REWINDING guard, rather than re-executing the function body top-to-bottom with per-op side-effect gates.
- Fixes 8 sortix fork-semantic regressions (`basic/signal/killpg`, `basic/spawn/posix_spawnattr_setpgroup`, `basic/sys_wait/waitpid`, `io/dup3-clofork-fork`, `io/open-clofork-fork`, `process/fork-exec-setpgid-in-parent`, `process/fork-setsid-setpgid-in-parent`, `process/fork-setsid-setpgid-in-parent-move`) that blocked Phase 7 PR.
- Deletes Phase 4g (per-op side-effect gating). Dispatch skips all code between landing points, making per-op gates redundant. Net simplification + binary-size reduction.
- Bumps `ABI_VERSION` 4→5 (cache invalidation; old-transform binaries refused on load).

## Root cause (why the old shape was wrong)
See `memory/fork-instrument-phase7-debug-evidence.md` for disasm-level evidence. Short version: non-fork-path direct calls (`setpgid`, `dup3`, `open`, `kill`, `pipe`, etc.) were not wrapped by Phase 4c (4c wraps only fork-path callees) and not gated by Phase 4g (4g gates side-effect *ops*, not calls). During REWINDING, those calls re-executed, re-triggering kernel-visible side effects like moving a child process out of its parent's pgid. A naive "gate every non-fork-path direct call" fix resolved 6/8 but introduced 35 new posix_spawn-class regressions (shadow-stack arithmetic divergence in re-executed pre-call bodies).

Switch dispatch sidesteps both problems: no body code runs during REWIND except the chosen call site + post-call handling.

## What survives
- `crates/fork-instrument/src/call_graph.rs` — verbatim.
- `crates/fork-instrument/src/runtime.rs` — verbatim.
- Exported ABI (`wpk_fork_unwind_begin`/`wpk_fork_unwind_end`/`wpk_fork_rewind_begin`/`wpk_fork_rewind_end`/`wpk_fork_state`).
- Save-buffer layout, frame layout — byte-identical.
- Ref-typed-local spilling via aux tables (Phase 4f).
- Try_table catch-handler `throw_ref`-on-REWIND mechanism (Phase 6c).
- `$outer/$capture` catch-ref injection + in_catch_K flags (Phase 6d/6e).
- Host-side `worker-main.ts` fork loop — unchanged.

## Test plan
- [x] `cargo test -p kandelo --target aarch64-apple-darwin --lib` — all pass.
- [x] `cd host && npx vitest run` — all pass.
- [x] `scripts/run-libc-tests.sh` — 0 unexpected FAILs.
- [x] `scripts/run-posix-tests.sh` — 0 FAILs.
- [x] `scripts/run-sortix-tests.sh --all` — 0 FAILs, 0 XPASSes. All 8 previously-FAIL tests now PASS; all 35 previously-regressed tests still PASS.
- [x] `bash scripts/check-abi-version.sh` — exit 0, `ABI_VERSION=5`.
- [x] Fork-instrument fuzz: 10 000 iterations, zero validator failures.
- [x] Benchmark diff: all 5 suites × Node + browser within ±3%. (Details attached.)

## Known unsupported patterns
- Fork-from-catch (C++/Ruby EH → `fork()` inside a catch handler). Detected at instrument time; tool returns an error. Staged follow-up: `memory/fork-instrument-b1-followup.md`.
- `ucontext`/`makecontext`/`swapcontext`/`getcontext`/`setcontext` — unchanged from prior policy.

## Design reference
`docs/plans/2026-04-22-fork-instrument-switch-dispatch-redesign.md`. Rewritten user-facing reference: `docs/fork-instrumentation.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Return the PR URL to the user.

---

## Execution notes (populated during implementation)

- (populated as tasks progress)

## Out of scope / explicit deferrals

- **Fork-from-catch (B1)** — still deferred. Tool detects and errors; see `memory/fork-instrument-b1-followup.md` for the staged 5-step plan.
- **Atomic RMW / `memory.atomic.*`** — not gated today, still not gated. Add when a fork-using program exercises them.
- **Wasm-GC ref support** — still panics in `classify_ref` for abstract types. Add when a real program requires.
- **Multi-target `*_ref` try_tables** — Phase 6d still skips. Revisit when a real program forces the issue.
- **Per-region call_idx locals** — current MVP shares one `call_idx_local` across top-level and nested regions, disambiguated by `catch_region_id_local`. Split if fuzz surfaces ambiguity.
