# Fork-Instrument Recursive Bucketing — Implementation Plan

> **For Claude (future-self):** Pick up at Task 3 (the implementation). Tasks 1–2 are already done and committed-in-context: the reproduction test exists at `crates/fork-instrument/tests/large_dispatcher.rs` and the root cause is fully identified. Read the **Findings already established** section first; do not re-derive.

**Goal:** Fix kandelo issue [#631](https://github.com/Automattic/kandelo/issues/631). Replace `populate_dispatch_structure`'s linear N-deep nesting with a recursive bucketed dispatch whose worst-case nesting depth is `O(M · log_M(N))` for `N` fork-path call sites and bucket size `M`. Eliminates the V8 "Maximum call stack size exceeded" failure on dispatcher-shaped LLVM helpers (e.g. PHP-FPM ~1015 indirect call sites in one function) and removes the need for the downstream `MAX_FORK_PATH_CALL_SITES` workaround in [WordPress/wordpress-playground#3635](https://github.com/WordPress/wordpress-playground/pull/3635) entirely.

**Branch:** `fix-issue-631-fork-instrument-skip` (already created from `upstream/main` in worktree at `/Users/mho/emdash/worktrees/wasm-posix-kernel/fix-fork-instrumentation/`). The original `fix-fork-instrumentation` branch was a misnamed fbdoom worktree — do NOT use it.

**ABI impact:** None. The frame's `call_index` field still stores a flat call-site index. The dispatch decodes `(level_0_idx, level_1_idx, …)` from the flat index at REWIND time. `_wpk_fork_buf`, save-buffer layout, `_wpk_fork_state` semantics, and all five exported runtime functions stay byte-identical. **No `ABI_VERSION` bump required.** The structural snapshot may change (different inner block topology); verify after implementation and treat as additive-compatible per CLAUDE.md.

**Authoritative context:**
- [`docs/plans/2026-04-22-fork-instrument-switch-dispatch-redesign.md`](2026-04-22-fork-instrument-switch-dispatch-redesign.md) — the switch-dispatch design this plan extends. The state machine, frame layout, ABI, and per-call-site emit logic stay intact; only the *dispatch shape* changes.
- [`docs/fork-instrumentation.md`](../fork-instrumentation.md) — user-facing reference; update the "dispatch shape" section after implementation.
- `crates/fork-instrument/src/instrument.rs:1784` — `populate_dispatch_structure`, the single function that owns the linear-nest shape.
- `crates/fork-instrument/tests/large_dispatcher.rs` — the reproduction test added in this branch.

---

## Findings already established (do not re-derive)

### 1. Root cause is structural, not size

`populate_dispatch_structure` builds the dispatch as **N strictly-nested blocks** (one per fork-path call site):

```
(block $unwind_save              ; depth 1
  (block $POST_{N-1}             ; depth 2
    ...
      (block $POST_0             ; depth N+1
        (block $dispatch_normal  ; depth N+2  → contains br_table $POST_0 … $POST_{N-1}
        )
        chunk 0 ; spill 0 ;
      )
      reload 0 ; call 0 ; chunk 1 ; spill 1 ;
    …
  )
)
```

The nesting is load-bearing: `br_table` with N targets requires those N labels to be enclosing structured-control labels (wasm spec). Each fork-path call site contributes exactly one `POST_K` block, so depth grows linearly with call-site count.

### 2. Reproduction proven by test

`crates/fork-instrument/tests/large_dispatcher.rs` is committed in-branch. Two tests:

- `direct_dispatcher_nesting_depth_scales_with_call_count` — fixture with N consecutive direct `call $fork` sites in one function.
- `indirect_dispatcher_nesting_depth_scales_with_call_count` — wordpress-playground-shape fixture: one `$fork_target` in a table, dispatcher with N `call_indirect` sites whose `(table, sig)` resolve to `$fork_target` via the indirect closure.

**Current behavior** (verified by running `cargo test -p fork-instrument --target aarch64-apple-darwin --test large_dispatcher`):

| N (fork-path calls) | Observed depth | Threshold | Result |
|---------------------|----------------|-----------|--------|
| 8                   | 11             | ≤ 64      | passes |
| 16                  | 19             | ≤ 64      | passes |
| 32                  | 35             | ≤ 64      | passes |
| 64                  | 67             | ≤ 64      | **FAILS** ← test fails here today |
| 100                 | 103            | ≤ 64      | **FAILS** |

Linear scaling confirmed: depth = N + 3 (the +3 is `$unwind_save`, `$dispatch_normal`, and the preamble `IfElse` consequent).

Production PHP-FPM has ~1015 call sites in its largest dispatcher → depth ~1018, exceeding V8's wasm-decoder control-flow limit (~1024) and well past the Liftoff compiler's recursion budget.

### 3. Why the asyncify-style "gate every call site with an if" approach is rejected

Re-executing the function body top-to-bottom during REWIND with per-op state gates re-fires every non-fork-path direct call (e.g. `setpgid`, `dup3`, `kill`) and re-runs shadow-stack arithmetic before the resumed call site. This causes user-visible fork-semantic bugs. See the 2026-04-22 redesign plan, section *Why this fixes the 2026-04-22 regressions*. **Switch dispatch's skip-the-pre-call-body semantics are non-negotiable.**

### 4. Why the downstream WP skip filter is unsafe

`MAX_FORK_PATH_CALL_SITES` drops fork-path entries post-closure. `call_graph::reaching_closure` had already marked the dropped function as reachable via `(table, sig)` matching; instrumented callers still emit `call_indirect (table=0, sig=X)` wrapped by the state machine and expect the target to also be wrapped. When `call_indirect` resolves to the un-wrapped (dropped) target, the runtime traps with `null function or function signature mismatch`. **Recursive bucketing eliminates the need for that filter entirely**, so the downstream PR #3635 can drop the threshold once this lands.

### 5. Existing test infrastructure is reusable

`crates/fork-instrument/tests/instrument.rs` lines 27–207 contain helpers: `parse_wat`, `instrument_wat`, `validate`, `func_by_name`, `local_func`, `entry_instr_kinds`, `seq_kinds`, `entry_wrapper_seq`, `entry_preamble_and_postamble`, plus the `InstrKind` enum and `walk_all`/`nested_of` walkers. Use these — don't duplicate.

---

## Design: recursive bucketed dispatch

### Tree partition

For `N` call sites and a fixed leaf bucket size `M` (config constant, default `32`):

- If `N ≤ M`: the dispatch is a single leaf — current `populate_dispatch_structure` shape, exactly today's emit. **Zero diff for the common case** (almost all real binaries).
- Else: split call sites into `B = ceil(N / M)` consecutive groups of ≤ `M` calls each. Each group becomes a child node. If `B > M`, the children are themselves recursively bucketed.

The result is a **balanced k-ary tree** of bucket nodes:

- Leaf node: contains `≤ M` consecutive call sites and the chunks/spills/calls bracketing them. Emits an inner br_table over its calls.
- Internal node: contains `≤ M` child nodes. Emits an outer br_table that picks the child based on the resumed `call_idx`'s position within the node's range.

Worst-case depth: `M · ⌈log_M(N)⌉`. For `M=32`:
- `N=1015` → depth ≈ 64 (two levels: one outer of 32 buckets, one inner of 32 calls).
- `N=1,000,000` → depth ≈ 128 (four levels).
- `N=1,000,000,000` → depth ≈ 192 (six levels).

All comfortably under V8's wasm-decoder limit (~1024) for arbitrary N.

### IR shape at each tree node

#### Leaf node (≤ M calls): unchanged from today

This is exactly the current `populate_dispatch_structure` body. Reuse it verbatim by factoring out an `emit_leaf_dispatch(node, chunks, calls, ...)` from the current code. **No semantic change at the leaf** — just delimit which call sites it handles.

#### Internal node (children C_0 … C_{B-1}):

```wat
(block $node_exit                       ;; exit point: same role as $unwind_save at the leaf level
  (block $child_{B-1}                   ;; one block per child
    ...
      (block $child_0
        (block $node_dispatch
          ;; if state == REWINDING:
          ;;   compute child_idx = (call_idx_local - this_node.first_call) / sub_node_span
          ;;   br_table $child_0 … $child_{B-1} $node_exit
          ;; (Fall-through to child 0 on NORMAL.)
        )
        ;; emit child 0 (recursively — internal node OR leaf)
      )
      ;; post-child-0 code: nothing! The chunks/spills/calls are *inside* the child node.
      ;; The internal node only routes; child runs the body.
    )
    ;; emit child 1
  )
  …
  ;; emit child B-1
)
```

**Key invariants** (assumptions to be proven by tests in Task 5/6):

1. On NORMAL, fall-through visits child 0, then exits via `$node_exit`. Child 0 must in turn fall through to child 1 (so its `$node_exit` must `br` to the enclosing internal node's child-1 dispatch position). **This is the trickiest invariant** — the natural shape has each child exit AT THE END of its enclosing block; the next sibling lives outside that block. So fall-through from child 0 lands at "after `(block $child_0)`'s end", which is exactly where child 1's emission starts. ✓
2. On REWIND with `call_idx = K`, the outer dispatch lands at `$child_J` where J is the child containing call K. From inside child J, the recursive dispatch routes to the exact POST label. ✓
3. The exit `br` semantics propagate: leaf-level UNWIND propagation does `br $unwind_save`; at internal-node depth, it must do `br $node_exit` of the appropriate ancestor. Since the dispatch is recursive, the existing leaf code's "br to escape" needs to br to the OUTERMOST `$node_exit` (the function-level one). **Verify with a test** (Task 5) that UNWIND propagation still escapes the entire dispatch in one branch.

### Call-idx encoding

The frame still stores a single flat `call_index` (`i32`). The tree dispatch decodes the position recursively:

- At the root, given flat `call_idx`, compute `child_idx = call_idx / sub_node_span`, where `sub_node_span` = size of one child subtree (e.g. M^depth_remaining).
- The root br_table uses `child_idx` as its index.
- Each level peels one bucket index. Inside the leaf, the remainder `call_idx mod M` indexes the leaf's br_table.

For balanced trees, span values are powers of M and computable at instrument time. Bake them as constants into the dispatch wat.

**No new frame field.** No ABI change. The decoder lives entirely in the dispatch wat.

### When to bucket vs. stay flat

Add a config constant `BUCKET_SIZE: usize = 32` at the top of `instrument.rs`. The transform:

```rust
fn build_dispatch_tree(n: usize, bucket_size: usize) -> DispatchTree { … }
```

returns a leaf when `n ≤ bucket_size`, recurses otherwise. Existing single-leaf path is the `n ≤ bucket_size` case — **no diff for ~all binaries**.

---

## Tasks

Tasks are ordered. **One task = one commit** unless noted. Run `cargo test -p fork-instrument --target aarch64-apple-darwin --test large_dispatcher` after each task that touches emit logic to catch regressions early.

### ✅ Task 1 (DONE): Reproduction test

Added `crates/fork-instrument/tests/large_dispatcher.rs`. Two tests assert max nesting depth ≤ 64 for N ∈ {8, 16, 32, 64, 100}. Both fail today at N=64 (depth=67). Test file already documents the bug and expected fix in its module doc. **Already committed in this branch's working tree; not yet `git add`-ed.**

### ✅ Task 2 (DONE): Root-cause investigation

Found at `crates/fork-instrument/src/instrument.rs:1784` (`populate_dispatch_structure`). Linear nest construction is at lines 1813–1857. Findings captured above in §Findings.

### Task 3: Factor leaf emission out of `populate_dispatch_structure`

Refactor without behavior change: extract the current body of `populate_dispatch_structure` (the per-call-site nested-block loop) into a function `emit_leaf_dispatch(local, exit_seq, dispatch_normal, post_seqs, chunks, call_sites, arg_spills, …)`. `populate_dispatch_structure` now just calls `emit_leaf_dispatch` for the single-leaf case.

**Test:** all existing tests in `crates/fork-instrument/tests/` continue to pass. Add no new tests in this commit. Diff should be ~50 LOC moved + ~10 LOC of new signature.

Expected to be a **pure refactor commit**; reviewer should see no semantic change.

### Task 4: Add `DispatchTree` data structure + builder

In `crates/fork-instrument/src/instrument.rs`, add:

```rust
const BUCKET_SIZE: usize = 32;

enum DispatchTree {
    /// Contiguous range of call sites [start, end) handled in one leaf.
    Leaf { start: usize, end: usize },
    /// Children handle disjoint, contiguous ranges. `span_per_child` is
    /// the (constant) number of call sites covered by each child except
    /// possibly the last (which may be smaller). Baked into the dispatch
    /// const at emit time.
    Internal { children: Vec<DispatchTree>, span_per_child: usize },
}

fn build_dispatch_tree(n_calls: usize, bucket_size: usize) -> DispatchTree { … }
```

**Tests** (`tests/dispatch_tree.rs`, new file): for the pure data-structure logic. Cover:

- `build_dispatch_tree(0, 32)` — degenerate empty leaf (or panic; pick one and test it).
- `build_dispatch_tree(1, 32)` → `Leaf { 0, 1 }`.
- `build_dispatch_tree(32, 32)` → `Leaf { 0, 32 }`. **Boundary**: exactly fills one leaf.
- `build_dispatch_tree(33, 32)` → `Internal` with 2 children: `Leaf { 0, 32 }`, `Leaf { 32, 33 }`. Span_per_child = 32.
- `build_dispatch_tree(64, 32)` → 2 leaves of 32.
- `build_dispatch_tree(1024, 32)` → root with 32 children, each a leaf of 32. Depth ≤ 2.
- `build_dispatch_tree(1025, 32)` → root has 2 internal children (one with 32 leaves of 32 each, one with one leaf of 1). Depth = 3. Span values: outer 1024, inner 32.
- `build_dispatch_tree(2_000_000, 32)` — large case. Depth ≤ 5. Assert tree height bound holds.

**Prove the depth invariant** with a property test that for arbitrary N up to 10⁷, tree.max_depth() ≤ ⌈log_32(N)⌉. Add a `max_depth()` method.

### Task 5: Failing test for recursive emit (TDD anchor)

Before writing emit code, **strengthen** `large_dispatcher.rs`:

- Lower `SAFE_MAX_DEPTH` to `64` for `M=32` × at-most-2-levels (i.e. N ≤ 1024).
- Add a new test with N = 1024 (the largest 2-level case): assert depth ≤ 64.
- Add a new test with N = 1025 (forces 3-level): assert depth ≤ 96 (= 32 × 3).
- Add a structural test that round-trip-validates the instrumented wasm with `wasmparser::Validator` for both N values. **Don't trust nesting depth alone** — validate the module.

These tests should fail until Task 6.

### Task 6: Wire `DispatchTree` into `populate_dispatch_structure`

`populate_dispatch_structure` now:

1. Builds a tree via `build_dispatch_tree(n_calls, BUCKET_SIZE)`.
2. Recursively emits internal nodes wrapping the existing `emit_leaf_dispatch`.

Internal-node emit:

```rust
fn emit_internal_dispatch(
    local: &mut LocalFunction,
    runtime: &Runtime,
    node_exit: InstrSeqId,
    children: &[DispatchTree],
    span_per_child: usize,
    call_range_start: usize,
    chunks: &[Vec<(Instr, InstrLocId)>],
    call_sites: &[CallSiteInfo],
    arg_spills: &[Vec<LocalId>],
    carryover_spills: &[Vec<LocalId>],
    catch_handlers: &[CatchHandlerInfo],
    state_global: GlobalId,
    call_idx_local: LocalId,
    catch_region_id_local: LocalId,
    exnref_slot_local: LocalId,
) { … }
```

The body of `emit_internal_dispatch`:

1. Allocate child seqs (one per child).
2. Allocate node_dispatch seq.
3. Populate node_dispatch: load `call_idx_local`, subtract `call_range_start`, divide by `span_per_child` (i32 divide is fine — span is power-of-M), br_table to children + node_exit.
4. For each child, recursively call `emit_internal_dispatch` or `emit_leaf_dispatch`. The child's "exit seq" is the parent's child block — `br` to it from within propagates correctly because wasm `br N` exits N enclosing blocks.

**Critical:** The leaf-level "escape UNWIND" `br` currently targets `$unwind_save`. After bucketing, the leaf's UNWIND escape must reach the **outermost** dispatch — i.e. the function-level `$unwind_save`, which is at the top of the tree. Since `br N` counts from innermost, the leaf's `br` target index must be computed against the *current ambient depth* at the leaf's emission point.

Mechanically: pass the function-level `$unwind_save` `InstrSeqId` down through recursion; emit `br $unwind_save` at the leaf using that ID — walrus resolves `InstrSeqId`-typed branches to the correct depth at module emit time. **Verify this is the case** (Task 7 test).

### Task 7: Prove UNWIND propagation still works across tree depth

Add a vitest-style integration test in `tests/large_dispatcher.rs`: instrument a fixture with N=33 (forces 2-level tree), then `walk_all` looking for the leaf's UNWIND `br_if` and assert it targets `$unwind_save`. Test the structural property: from anywhere in the tree, `br` on UNWIND escapes the entire dispatch.

Run the existing `tests/switch_dispatch.rs`, `tests/coverage_wat.rs`, `tests/instrument.rs`, `tests/trampoline.rs`, `tests/roundtrip.rs`. Treat any failure as a recursive-bucketing bug.

### Task 8: Span arithmetic correctness tests

The decode `(call_idx - range_start) / span_per_child` must land in the correct child for every K in [start, end).

For each N ∈ {33, 64, 100, 200, 1024, 1025, 2000, 5000}: build the tree, walk the leaves, for every call site K, simulate the tree dispatch and assert it lands in the leaf whose range covers K. This is a pure-Rust test against `DispatchTree`; doesn't require running wasm.

### Task 9: Validate against real instrumented module

Re-run the existing tests under `cargo test -p fork-instrument --target aarch64-apple-darwin`. Add ABI snapshot regen + verification (per CLAUDE.md):

```bash
bash scripts/check-abi-version.sh update
git diff abi/snapshot.json   # Should be additive (no offset shifts in core ABI)
bash scripts/check-abi-version.sh
```

**Expect:** the structural snapshot may shift if it covers `kernel_*` export shapes or `__wpk_fork_*` exports. The five wpk_fork_* function signatures are unchanged. No ABI_VERSION bump needed. **Confirm this assumption** — if the snapshot diff includes any shipped-ABI field, escalate.

### Task 10: End-to-end wasm validation + run real binaries

After unit tests pass:

```bash
# Rebuild kernel + host TS (CLAUDE.md says ABI is unchanged so this is sufficient)
bash build.sh

# Full 5-suite regression matrix per CLAUDE.md:
cargo test -p kandelo --target aarch64-apple-darwin --lib
cd host && npx vitest run; cd ..
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
bash scripts/check-abi-version.sh
```

All five suites must be green before claiming done. The recursive transform must not regress fork semantics on any program that was previously working.

### Task 11: Optional — port the WP skip filter as a no-op flag

To make adoption painless for downstream PR #3635: add a deprecated `--max-fork-path-call-sites` CLI flag that prints a one-line "no longer needed; recursive bucketing handles arbitrary N" warning and ignores its value. Out of scope for the core fix; tag the issue with a follow-up.

---

## Regression gates (must all pass before merge)

- `cargo test -p fork-instrument --target aarch64-apple-darwin` — all green, including new `tests/large_dispatcher.rs` (depth ≤ 64 for N ≤ 1024) and `tests/dispatch_tree.rs`.
- `cargo test -p kandelo --target aarch64-apple-darwin --lib` — 539+ tests, 0 failures.
- `host && npx vitest run` — no regressions.
- `scripts/run-libc-tests.sh` — 0 unexpected `FAIL`s.
- `scripts/run-posix-tests.sh` — 0 `FAIL`s.
- `bash scripts/check-abi-version.sh` — exit 0, snapshot diff (if any) is additive-compatible.
- Manual sanity: instrument an N=2000 fork-path-call dispatcher, validate output with `wasm-validate`, inspect with `wasm2wat` to confirm tree shape.

---

## Open assumptions (must be proven by test, not just reasoned about)

The user explicitly asked: **every assumption gets a test.** Track these:

1. **Tree depth invariant** — `DispatchTree::max_depth() ≤ ceil(log_M(N))` for all N. (Task 4 property test.)
2. **Dispatch decode correctness** — `(call_idx - start) / span_per_child` lands in the correct child for every K. (Task 8 exhaustive test.)
3. **Validator passes** — instrumented module survives `wasmparser::Validator` for N ∈ {1024, 1025, 5000}. (Task 5/Task 9.)
4. **UNWIND escape** — leaf's `br $unwind_save` escapes the full tree depth (walrus resolves by InstrSeqId, but **prove with a structural assertion**). (Task 7.)
5. **No ABI change** — the five wpk_fork_* exports' signatures, save buffer format, and frame layout are byte-identical pre- and post-fix. (Task 9 snapshot check.)
6. **No regression on small N** — for N ≤ 32 the emitted wasm is bit-identical to today's output (since `build_dispatch_tree(n, 32)` returns `Leaf { 0, n }` for n ≤ 32, and `emit_leaf_dispatch` is the factored-out current code). **Diff-test:** instrument a small fixture pre- and post-refactor and assert byte-equal output. (Task 3 commit gate.)
7. **Indirect-closure semantics unchanged** — `call_graph::reaching_closure` still discovers the same fork-path set; we only change the *emit* not the *analysis*. Already covered by existing `tests/call_graph.rs`; confirm those still pass at every commit. (Implicit, but list it.)

---

## Risk: things that could go wrong

- **Walrus's `br` target resolution.** If walrus does not resolve `Instr::Br` / `Instr::BrIf` / `Instr::BrTable` by `InstrSeqId` at emit time (instead requiring a numeric depth), the leaf's "br to outermost $unwind_save" will silently emit a too-shallow depth and the wasm will be broken. **Verify** by reading `walrus::ir::Br` / module-emit logic before Task 6. If walrus uses numeric depth, we have to compute it at each leaf — annoying but tractable.
- **The chunk between bucket boundaries.** Currently each chunk K lives between call K-1's epilogue and call K's spill, *inside* a POST_K block. After bucketing, when call K-1 is the last in bucket B0 and call K is the first in bucket B1, chunk K is INSIDE bucket B1's leaf (it's chunk K, and bucket B1 handles calls K..K+M-1, including their preceding chunks). **Tests at the bucket boundary (N=33, K=32) are critical.**
- **Carryover spills at boundaries.** Sub-commit 2.4c spill semantics may interact with bucket boundaries in subtle ways (an arg computed in chunk K-1 spilled into a local before bucket-B1's leaf entry). Re-read `compute_carryover_types` to confirm locals are function-scoped (they are; walrus stores them on the function), so bucket boundaries don't break this.
- **Test coverage gap.** N=32 (exactly fits a leaf) and N=33 (first non-trivial bucketing) are the boundary cases. Test BOTH explicitly. Likewise N=1024 (exactly 2 levels), N=1025 (first 3-level).

---

## Useful commands

```bash
# Reproduction test (fails today):
cargo test -p fork-instrument --target aarch64-apple-darwin --test large_dispatcher

# Full crate tests:
cargo test -p fork-instrument --target aarch64-apple-darwin

# Run a single test by name:
cargo test -p fork-instrument --target aarch64-apple-darwin -- \
  direct_dispatcher_nesting_depth_scales_with_call_count --nocapture

# Inspect an instrumented module's shape:
cargo run -p fork-instrument --bin wasm-fork-instrument --target aarch64-apple-darwin -- \
  input.wasm -o output.wasm
wasm2wat output.wasm | less
```

---

## End-of-session state (2026-06-05)

- Branch: `fix-issue-631-fork-instrument-skip` (this worktree, off `upstream/main`).
- Reproduction test exists, **uncommitted**, in `crates/fork-instrument/tests/large_dispatcher.rs`. Confirmed failing on N=64.
- Root cause confirmed at `crates/fork-instrument/src/instrument.rs:1784` (`populate_dispatch_structure`).
- Design chosen: recursive bucketed dispatch with `BUCKET_SIZE = 32`. ABI unchanged.
- **Next step:** Task 3 (factor `emit_leaf_dispatch` out, refactor-only commit).
