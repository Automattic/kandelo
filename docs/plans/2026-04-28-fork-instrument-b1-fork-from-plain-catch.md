# Fork-instrument B1 — fork from plain `catch` handler — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `fork()` work when called from inside a plain `catch` handler (no exnref). Currently traps; B1 lifts that limitation by saving tag identity + operand values at unwind, re-throwing the matching tag with saved operands at rewind so the wasm exception machinery re-enters the handler.

**Architecture:** Mirror the existing Phase 6 catch_ref pipeline (capture-block rewrite + rewind-throw stub) but with operand-value save/restore instead of exnref stash. Add per-(region, arm) scratch storage in the save buffer that holds `(tag_id, operand_0, ..., operand_N-1)` tuples. Extend the buffer header with a scratch base offset; `wpk_fork_unwind_begin` initializes the scratch base alongside `current_pos`.

**Tech Stack:** Rust (walrus IR), WebAssembly EH proposal (try_table / catch / throw), per-existing instrument.rs scaffolding.

---

## Pre-flight verification

Before starting, verify the foundation is intact:

```bash
cd /Users/brandon/.superset/worktrees/kandelo/phase-7-switch-dispatch
cargo test -p fork-instrument --target aarch64-apple-darwin --lib --tests 2>&1 | tail -3
```
Expected: all tests pass (current count ~75).

```bash
grep -nE "^fn (apply_catch_ref_handlers|inject_rewind_throw_stubs|plan_and_inject_aux_tables|discover_try_table_bodies)" crates/fork-instrument/src/instrument.rs
```
Expected: 4 matches confirming the Phase 6 functions B1 extends are present.

---

## Stage 1 — Infrastructure (target: 1 day, ~200-300 LoC)

Goal: data structures, discovery, scratch-area allocation. **No behavioral change** — instrumented modules should remain functionally identical until Stage 2 wires the scratch area into the unwind/rewind paths.

### Task 1.1: Add `PlainCatchArm` struct + classification helper

**Files:**
- Modify: `crates/fork-instrument/src/instrument.rs` (insert after line 1946, near `CatchRegionPlan`)
- Modify: `crates/fork-instrument/tests/instrument.rs` (append new test)

**Step 1: Write the failing test**

Append to `crates/fork-instrument/tests/instrument.rs`:

```rust
#[test]
fn plain_catch_arms_discovered_for_fork_path_handler() {
    // try_table with plain catch where the handler body contains a
    // fork-path call. Stage 1 must enumerate this arm.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn (param i32))
          (func $caller (export "caller") (result i32)
            (block $h (param i32) (result i32)
              (try_table (result i32) (catch $exn $h)
                i32.const 0
                drop
                i32.const 7))
            ;; handler body: receives i32 from $exn payload
            ;; then forks
            drop
            call $fork)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    // Stage 1 only validates planning; no runtime assertion yet.
    // Once Stage 2 lands we'll assert the saved-operand path.
}
```

**Step 2: Run test, expect compile failure or "not found"**

```bash
cargo test -p fork-instrument --target aarch64-apple-darwin --test instrument plain_catch_arms_discovered_for_fork_path_handler
```
Expected: PASS (this fixture should already validate post-instrumentation today — Stage 1 doesn't change behavior, just adds discovery internals). If it fails post-instrumentation, the test exposes a real bug we need to address.

**Step 3: Add `PlainCatchArm` struct in instrument.rs after the existing `CatchRegionPlan` (line 1946)**

```rust
/// Stage 1 (B1) — describes a single `catch $tag $label` clause in a
/// fork-path try_table whose handler body (label target) reaches a
/// fork-path call. Discovered alongside `CatchRegionPlan` and recorded
/// per-region.
#[derive(Debug, Clone)]
pub struct PlainCatchArm {
    /// Index of this arm within its try_table's `catches` list.
    pub arm_idx: u32,
    /// Tag this arm catches.
    pub tag: walrus::TagId,
    /// Label the arm branches to on catch (target block id).
    pub label: walrus::ir::InstrSeqId,
    /// Tag's operand types (matches `module.tags.get(tag).ty.params`).
    /// Cached at discovery time so we don't re-look-up on emission.
    pub operand_tys: Vec<ValType>,
}
```

**Step 4: Add discovery helper after `discover_try_table_bodies` (line 1948)**

```rust
/// Returns `(body_seq, plain_catch_arms)` for each fork-path try_table
/// in `func_id` whose body contains, transitively, code paths reaching
/// any of the try_table's plain-catch labels with a fork-path call
/// downstream of the label.
///
/// Phase 6 (catch_ref) handles try_tables where catch_ref/catch_all_ref
/// clauses target a label whose downstream code forks. B1 adds plain
/// `catch $tag` clauses to that capability. A try_table can mix both;
/// B1 returns only the plain-catch arms here. The catch_ref ones
/// continue to flow through Phase 6.
///
/// Returns `Vec<(InstrSeqId, Vec<PlainCatchArm>)>` paralleling
/// `discover_try_table_bodies`'s output order.
fn discover_plain_catch_arms(
    module: &Module,
    func_id: FunctionId,
    fork_path: &HashSet<FunctionId>,
) -> Vec<(InstrSeqId, Vec<PlainCatchArm>)> {
    let local = match &module.funcs.get(func_id).kind {
        FunctionKind::Local(l) => l,
        _ => return Vec::new(),
    };
    let mut out = Vec::new();
    visit_for_plain_catch(module, local, local.entry_block(), fork_path, &mut out);
    out
}

fn visit_for_plain_catch(
    module: &Module,
    f: &LocalFunction,
    seq: InstrSeqId,
    fork_path: &HashSet<FunctionId>,
    out: &mut Vec<(InstrSeqId, Vec<PlainCatchArm>)>,
) {
    for (instr, _) in &f.block(seq).instrs {
        if let Instr::TryTable(tt) = instr {
            let mut arms: Vec<PlainCatchArm> = Vec::new();
            for (i, c) in tt.catches.iter().enumerate() {
                let (tag, label) = match c {
                    TryTableCatch::Catch { tag, label } => (*tag, *label),
                    _ => continue, // catch_ref / catch_all / catch_all_ref handled elsewhere
                };
                if !label_reaches_fork_call(f, label, fork_path) {
                    continue;
                }
                let operand_tys: Vec<ValType> =
                    module.tags.get(tag).ty().params().to_vec();
                arms.push(PlainCatchArm {
                    arm_idx: i as u32,
                    tag,
                    label,
                    operand_tys,
                });
            }
            if !arms.is_empty() {
                out.push((tt.seq, arms));
            }
        }
        for child in nested_seqs(instr) {
            visit_for_plain_catch(module, f, child, fork_path, out);
        }
    }
}

/// Returns true iff there is a fork-path Call/CallIndirect at or
/// downstream of `label`'s target block (in lexical-scope reachable code).
/// Approximation: walks the block at `label` and any blocks containing
/// it for fork calls. False positives are safe (they just cause
/// instrumentation we don't strictly need); false negatives would miss
/// real B1 cases.
fn label_reaches_fork_call(
    f: &LocalFunction,
    label: InstrSeqId,
    fork_path: &HashSet<FunctionId>,
) -> bool {
    subtree_contains_fork_call(f, label, fork_path)
}
```

**Step 5: Run cargo test — verify it builds and the new test passes**

```bash
cargo test -p fork-instrument --target aarch64-apple-darwin --test instrument 2>&1 | tail -5
```
Expected: PASS, no regressions in existing tests.

**Step 6: Commit**

```bash
git add crates/fork-instrument/src/instrument.rs crates/fork-instrument/tests/instrument.rs
git commit -m "feat(fork-instrument): B1 stage 1 — discover plain-catch arms reaching fork

Adds PlainCatchArm struct and discover_plain_catch_arms helper that
walks each fork-path try_table's plain catch clauses and identifies
arms whose handler body reaches a fork-path call. Foundation for
B1 (fork from plain catch handler); no behavior change yet."
```

---

### Task 1.2: Plan per-arm scratch offsets

**Files:**
- Modify: `crates/fork-instrument/src/instrument.rs` near `plan_and_inject_aux_tables` (line 1818)

**Step 1: Add `PlainCatchArmSlot` struct and `B1ScratchPlan`**

After `CatchRegionPlan` (post-line 1946):

```rust
/// Stage 1 (B1) — per-arm scratch slot.
#[derive(Debug, Clone)]
pub struct PlainCatchArmSlot {
    pub arm: PlainCatchArm,
    /// Byte offset within the B1 scratch area at which this arm's
    /// (arm_id, operand_0..N) tuple is stored.
    pub scratch_offset: u32,
    /// Total size in bytes of this arm's saved tuple
    /// (4 bytes arm_id + sum-of-operand-sizes).
    pub tuple_size: u32,
}

/// Stage 1 (B1) — module-wide plain-catch scratch plan.
#[derive(Debug, Clone, Default)]
pub struct B1ScratchPlan {
    /// Total bytes the B1 scratch area occupies in the save buffer,
    /// after `frames_start_offset`'s saved-globals region.
    pub total_bytes: u32,
    /// Per-function per-region per-arm slot assignments.
    pub per_function:
        std::collections::HashMap<FunctionId, Vec<(InstrSeqId, Vec<PlainCatchArmSlot>)>>,
}
```

**Step 2: Add planning function**

```rust
/// Stage 1 (B1) — assigns scratch offsets for every plain-catch arm
/// across all fork-path functions. The scratch area sits in the save
/// buffer between saved_globals and frame data; its base is
/// `frames_start_offset_pre_b1` (which the runtime tracks separately
/// once Stage 1 ships) and its total size is returned in
/// `B1ScratchPlan.total_bytes`.
///
/// Scratch tuple layout per arm:
///   +0    4    arm_id (i32)
///   +4    var  operand_0 ... operand_N-1, naturally aligned
///
/// Operand types are restricted to scalar (i32/i64/f32/f64/v128) at
/// this stage. Ref-typed operands (externref/funcref/exnref/GC refs)
/// would require aux-table spilling — future B2 carve-out. We
/// detect-and-reject in Stage 2 when emission is wired.
pub fn plan_b1_scratch(
    module: &Module,
    targets: &[FunctionId],
    fork_path: &HashSet<FunctionId>,
) -> B1ScratchPlan {
    let mut plan = B1ScratchPlan::default();
    let mut cursor: u32 = 0;
    for &fid in targets {
        let arms = discover_plain_catch_arms(module, fid, fork_path);
        if arms.is_empty() {
            continue;
        }
        let mut per_func: Vec<(InstrSeqId, Vec<PlainCatchArmSlot>)> =
            Vec::with_capacity(arms.len());
        for (body_seq, arm_list) in arms {
            let mut slots: Vec<PlainCatchArmSlot> = Vec::with_capacity(arm_list.len());
            for arm in arm_list {
                let payload_size: u32 = arm
                    .operand_tys
                    .iter()
                    .map(|t| scalar_size_b1(*t))
                    .sum();
                let tuple_size = 4 + payload_size;
                // Align cursor to 8 bytes for safe i64/f64 storage in
                // first-operand position (offset +4 isn't 8-aligned but
                // we only use natural alignment per-operand, so this
                // outer alignment is for the start of the tuple).
                let aligned = (cursor + 7) & !7u32;
                slots.push(PlainCatchArmSlot {
                    arm,
                    scratch_offset: aligned,
                    tuple_size,
                });
                cursor = aligned + tuple_size;
            }
            per_func.push((body_seq, slots));
        }
        plan.per_function.insert(fid, per_func);
    }
    plan.total_bytes = cursor;
    plan
}

fn scalar_size_b1(ty: ValType) -> u32 {
    match ty {
        ValType::I32 | ValType::F32 => 4,
        ValType::I64 | ValType::F64 => 8,
        ValType::V128 => 16,
        ValType::Ref(_) => panic!(
            "B1 plan_b1_scratch: ref-typed catch operand encountered. \
             Caller must filter via classify_operand_supportability before \
             scratch allocation. (See Stage 2 carve-out.)"
        ),
    }
}
```

**Step 3: Add unit tests**

Append to `crates/fork-instrument/tests/instrument.rs`:

```rust
#[test]
fn b1_scratch_plan_total_bytes_for_single_arm_i32_payload() {
    use fork_instrument::instrument::{plan_b1_scratch, /* exposed via lib if needed */};
    // (If symbols aren't exported yet, this test goes inside the
    // crate's `mod tests` block instead.)
    // Skip if plan_b1_scratch isn't pub — adapt to a structural
    // assertion via instrument() output instead.
}
```

(If `plan_b1_scratch` ends up internal-only, replace this with an integration test that drives a fixture through the full `instrument()` and checks structural invariants.)

**Step 4: Run cargo test**

```bash
cargo test -p fork-instrument --target aarch64-apple-darwin 2>&1 | tail -5
```
Expected: PASS.

**Step 5: Commit**

```bash
git add crates/fork-instrument/src/instrument.rs crates/fork-instrument/tests/instrument.rs
git commit -m "feat(fork-instrument): B1 stage 1 — assign per-arm scratch offsets

PlainCatchArmSlot + B1ScratchPlan track per-(function, region, arm)
scratch area for saved tag operand tuples. plan_b1_scratch sums the
total size and assigns 8-byte-aligned offsets. Scalar operand types
only; ref types panic with a clear diagnostic (Stage 2 will detect
and reject earlier)."
```

---

### Task 1.3: Reserve scratch space in the save buffer

**Files:**
- Modify: `crates/fork-instrument/src/runtime.rs` (around line 75-96 — Runtime struct)
- Modify: `crates/fork-instrument/src/instrument.rs` — caller of `inject_runtime`

**Step 1: Extend `Runtime` with scratch-base field**

In `runtime.rs`, modify the `Runtime` struct (line ~75):

```rust
pub struct Runtime {
    pub state_global: GlobalId,
    pub buf_global: GlobalId,
    pub buf_type: ValType,

    pub unwind_begin: FunctionId,
    pub unwind_end: FunctionId,
    pub rewind_begin: FunctionId,
    pub rewind_end: FunctionId,
    pub state: FunctionId,

    pub saved_globals: Vec<SavedGlobal>,

    /// Byte offset at which frame data begins. After Stage 1 this
    /// points past the (zero-sized at runtime alloc time) B1 scratch
    /// area; `set_b1_scratch_size` shifts it later when the scratch
    /// plan is known.
    pub frames_start_offset: u32,

    /// Stage 1 (B1): size in bytes of the plain-catch scratch area.
    /// `b1_scratch_base = 2P + N`. `frames_start_offset = b1_scratch_base
    /// + b1_scratch_size`. Initialized to 0 in `inject_runtime`; the
    /// caller computes the plan and calls `set_b1_scratch_size` before
    /// per-function instrumentation begins.
    pub b1_scratch_base: u32,
    pub b1_scratch_size: u32,
}
```

**Step 2: Initialize the new fields in `inject_runtime`**

In `inject_runtime` (around line 235), initialize:

```rust
Runtime {
    state_global,
    buf_global,
    buf_type: ptr_ty,
    unwind_begin,
    unwind_end,
    rewind_begin,
    rewind_end,
    state,
    saved_globals,
    frames_start_offset,
    b1_scratch_base: frames_start_offset,
    b1_scratch_size: 0,
}
```

**Step 3: Add `set_b1_scratch_size` method**

After the `Runtime` struct's `impl` (or add one if none exists):

```rust
impl Runtime {
    /// Stage 1 (B1): once the scratch plan is computed, shift
    /// `frames_start_offset` to make room. Must be called before any
    /// per-function instrumentation that reads `frames_start_offset`.
    pub fn set_b1_scratch_size(&mut self, size: u32) {
        // Align to 8 bytes so frame data starts on an aligned boundary.
        let aligned = (size + 7) & !7u32;
        self.b1_scratch_size = aligned;
        self.frames_start_offset = self.b1_scratch_base + aligned;
    }
}
```

**Step 4: Wire the call in instrument.rs**

Find the entry point that calls `inject_runtime` (it's likely `instrument_module` or similar — search for `inject_runtime(`):

```bash
grep -nE "inject_runtime\(" crates/fork-instrument/src/*.rs
```

After `inject_runtime(...)` returns and after `plan_and_inject_aux_tables(...)` is called, before per-function instrumentation begins, add:

```rust
let b1_plan = plan_b1_scratch(&module, &targets, &fork_path);
runtime.set_b1_scratch_size(b1_plan.total_bytes);
```

(Pass `b1_plan` along to per-function instrumentation as well — it's needed in Stage 2.)

**Step 5: Update `wpk_fork_unwind_begin` to seed `current_pos` with the new `frames_start_offset`**

The existing code in `runtime.rs:281` already writes `frames_start_offset` to `*(buf+0)`. Since we've shifted `frames_start_offset` to include the scratch area, that's the only place that needs updating, and it's already a field read — no code change.

**Step 6: Add structural test**

```rust
#[test]
fn b1_scratch_shifts_frames_start_offset() {
    // A module with one fork-path function that catches a tag with
    // an i32 payload. After Stage 1, frames_start_offset must be
    // larger than it would be without B1 by at least 8 bytes
    // (4 arm_id + 4 i32, 8-aligned).
    // Compare two instrumentations: one with the catch arm, one without.
    // (Implementation: build both fixtures, instrument both, compare
    // the value written into +0 of the buffer by wpk_fork_unwind_begin.)
}
```

**Step 7: Run cargo test, expect PASS**

```bash
cargo test -p fork-instrument --target aarch64-apple-darwin 2>&1 | tail -5
```

**Step 8: Commit**

```bash
git add crates/fork-instrument/src/runtime.rs crates/fork-instrument/src/instrument.rs crates/fork-instrument/tests/instrument.rs
git commit -m "feat(fork-instrument): B1 stage 1 — reserve scratch space in save buffer

Runtime gains b1_scratch_base + b1_scratch_size fields.
set_b1_scratch_size() shifts frames_start_offset to make room
for per-arm tag-operand scratch. wpk_fork_unwind_begin's
current_pos seed remains correct via the existing field read."
```

---

### Task 1.4: ABI snapshot — verify no inadvertent ABI drift

The buffer layout change is purely an internal-to-the-module geometry detail; `wpk_fork_unwind_begin` continues to self-init `*(buf + 0)` so the host doesn't see the shift. But the wasm exports are tracked.

**Step 1: Run ABI snapshot check**

```bash
bash scripts/check-abi-version.sh 2>&1 | tail -5
```
Expected: `abi: snapshot is in sync with sources.`

If anything drifts unexpectedly, investigate before proceeding.

---

### Task 1.5: Full Stage-1 verification

**Step 1: Run all fork-instrument tests**

```bash
cargo test -p fork-instrument --target aarch64-apple-darwin 2>&1 | tail -10
```
Expected: all tests pass, count >= 75 (the 75 baseline + new B1 tests).

**Step 2: Run kernel lib tests**

```bash
cargo test -p kandelo --target aarch64-apple-darwin --lib 2>&1 | tail -3
```
Expected: 757/757 pass, 0 failures.

**Step 3: Re-run libc-tests to confirm no regression**

```bash
scripts/run-libc-tests.sh 2>&1 | tail -10
```
Expected: 0 unexpected FAILs (XFAIL/TIME baseline acceptable). Same as Phase-7 baseline (302 PASS / 0 FAIL / 20 XFAIL / 2 TIME).

**Step 4: Run sortix basic suite (the load-induced flake-prone one)**

```bash
scripts/run-sortix-tests.sh basic 2>&1 | tail -10
```
Expected: 926 PASS / 0 FAIL / 4 XFAIL / 3 TIME (matches Phase-7 baseline).

If any gate regresses, **STOP** and diagnose before Stage 2.

**Step 5: Tag the Stage 1 commit**

```bash
git tag -a fork-instrument-b1-stage1 -m "B1 Stage 1: infrastructure (discovery + scratch plan + buffer reservation)"
```

---

## Stage 2 — Emission (target: 2-3 days, ~600 LoC)

**Goal:** Wire the scratch area into the unwind/rewind paths so plain-catch arms actually function — at unwind time, save the `(arm_id, operands...)` tuple to the scratch slot the planner allocated; at rewind time, load arm_id from scratch and re-throw the matching tag with restored operands.

### Stage-1 structures Stage 2 consumes

These were finalized during Stage 1 (commits `62ad0d506..761d6c87e`):

- **`PlainCatchArm`** (`crates/fork-instrument/src/instrument.rs:1972`): `arm_idx: u32` (index in tt.catches), `tag: TagId`, `label: InstrSeqId`, `operand_tys: Vec<ValType>`. Note: `arm_idx` is the **runtime arm_id Stage 2 writes into the scratch tuple** — combined with `catch_region_id` (per `CatchRegionPlan`), the pair is unique within a function.
- **`PlainCatchArmSlot`** (`instrument.rs:2050`): `arm: PlainCatchArm`, `scratch_offset: u32` (relative to scratch_base — Stage 2 must add `runtime.b1_scratch_base` for absolute address), `tuple_size: u32`.
- **`B1ScratchPlan`** (`instrument.rs:2065`): `total_bytes`, `per_function: HashMap<FunctionId, Vec<(InstrSeqId, Vec<PlainCatchArmSlot>)>>`. Outer Vec parallels `discover_try_table_bodies` order; inner Vec is per-arm.
- **`Runtime.b1_scratch_base: u32`** (`runtime.rs:75-92`): byte offset where scratch begins. `b1_scratch_size`: total reserved bytes (already `align_up_8`'d).
- **`pub fn plan_b1_scratch(module, targets) -> B1ScratchPlan`**: callable in tests directly.
- **Discovery is pre-ordered**: `lib.rs::instrument` filters `fork_path` to Local functions and sorts before passing to `plan_b1_scratch`. Stage 2 must use the **same filter+sort** when iterating to look up per-function plans, OR consume the plan via FunctionId-keyed hashmap (recommended — order-independent).

### Stage-1 gotchas Stage 2 must respect

- **Walrus tag operand types**: `module.types.get(module.tags.get(tag).ty()).params()` — `Tag::ty()` returns `TypeId`, not `Type`.
- **Walrus `throw $tag` semantics**: walrus IR has `Instr::Throw { tag: TagId }`. Operands are popped from the stack; the order matches `tag.params()`. Verify shape in walrus 0.26 source if unfamiliar.
- **Walrus `try_table` rewrite pattern**: see how `apply_catch_ref_handlers` (`instrument.rs:2138`) rewrites `CatchRef`/`CatchAllRef` → `$capture_K` blocks. The pattern: build new `Vec<TryTableCatch>` with replaced labels, replace the parent's `Instr::TryTable` with `Instr::Block(outer_seq)`, populate `outer_seq` with `Instr::Block(capture_seq)` + br_target. Stage 2's plain-catch capture follows the same shape.
- **Catch label block typing**: Wasm requires the catch's target block's signature to consume the tag's operand types. WAT shape that works for tests: `(block $h (result T) ...)` or `(block $h (param T) (result T'))` depending on what fall-through values the producer arranges. The previous Stage 1 attempt at `(block $h (param i32))` for a function-body-top fork-path target FAILED validation because the function entry stack is empty. Stage 2 fixtures should use the result-type-pattern that the existing `b1_scratch_plan_i32_payload_arm_is_8_bytes` test demonstrates.
- **Byte-identity goal NOT applicable to Stage 2.** Stage 1 was purely additive and preserved emit-byte-identity for shipping ports. Stage 2 changes emission for fork-path functions with plain-catch arms — by design. **However**, modules WITHOUT plain-catch arms must remain byte-identical (none of Stage 2's emission changes should fire when `B1ScratchPlan.per_function` is empty for that function). Test this explicitly.
- **The pre-existing alignment quirk** (synthetic test fixture with one i32 saved global → `frames_start_offset = 12`, not 8-aligned): Stage 2's i64 stores into the scratch area depend on `b1_scratch_base` being well-aligned, NOT `frames_start_offset`. Since `b1_scratch_base = 2P + N` (without alignment), it shares the same quirk. Verify Stage 2 uses unaligned stores OR aligns the b1_scratch_base. The `align_up_8` helper exists in both `instrument.rs` and `runtime.rs`.
- **Sortix basic / libc-test gate**: every Phase-7-shipping port instruments cleanly via the current pipeline and runs all sortix basic tests (929 PASS / 0 FAIL / 4 XFAIL). Stage 2 must preserve this — add a regression gate (`bash scripts/run-sortix-tests.sh basic`) after each emission task.

### Tasks

#### Task 2.0: Plumb `B1ScratchPlan` into `instrument_functions`

**Files:**
- `crates/fork-instrument/src/lib.rs`
- `crates/fork-instrument/src/instrument.rs::instrument_functions`

Pass the already-computed `b1_plan` from `lib.rs::instrument` down to `instrument_functions`, then thread it through to `instrument_one_function` (the per-function pipeline). Currently `lib.rs` discards `b1_plan` after consuming `total_bytes`.

Acceptance: `instrument_one_function` receives a `&[(InstrSeqId, Vec<PlainCatchArmSlot>)]` for the active function (lookup via `b1_plan.per_function.get(&fid).unwrap_or(&empty)`). No emission change yet — slots are just plumbed through.

Tests: existing 88 still pass; one new test asserts the plumbing reaches `instrument_one_function` (e.g., via a debug counter or via observing structural change in a fixture once the next task wires emission).

Commit: `feat(fork-instrument): B1 stage 2 — plumb plan through to per-function pipeline`.

#### Task 2.1: Operand-type carve-out (B2-style)

**Files:**
- `crates/fork-instrument/src/instrument.rs::plan_b1_scratch`

Before allocating scratch slots, walk each arm's `operand_tys` and check for unsupported types: `ValType::Ref(_)` (any ref class). For functions whose plain-catch arms include unsupported operand types, **drop those arms from the plan** AND record the function ID in a `b2_carveout: HashSet<FunctionId>` field on `B1ScratchPlan`. Emission tasks (2.2-2.4) will check this set and skip plain-catch instrumentation for those functions — falling back to today's "guard-dispatch + body replay diverges from NORMAL flow at the catch handler" behavior. That's not better than today, but it doesn't make things worse, and it surfaces the limitation cleanly.

Replace the existing `panic!` in `b1_scalar_size` (or its callers) with this carve-out logic.

Tests:
- A test fixture with `(tag $exn (param externref))` should produce a `B1ScratchPlan` with empty `per_function[that_fid]` and the function in `b2_carveout`.
- Existing tests must continue to pass (none use ref operands).
- Add `f32 + i32 + i64` mixed-payload coverage.

Commit: `feat(fork-instrument): B1 stage 2 — fall back to guard-dispatch for ref-typed catch operands`.

#### Task 2.2: Per-arm capture block emission

**Files:**
- `crates/fork-instrument/src/instrument.rs` — new function `apply_plain_catch_handlers` (sibling of `apply_catch_ref_handlers` at `:2138`).

For each fork-path function with plain-catch arms (and not in `b2_carveout`), for each `(try_table_body_seq, plain_catch_arms)` entry:
- Build a fresh `$capture_K_arm_J` block per arm, typed `[operand_tys] -> [operand_tys]` (consumes catch's branch args, re-pushes them after saving).
- Emit save sequence inside `$capture_K_arm_J`:
  - For each operand i: `local.set` to a fresh per-arm scratch local (or directly emit `store` to `b1_scratch_base + scratch_offset + 4 + per_operand_offset` using `runtime.buf_global` as base). Choose direct-store; simpler and matches Phase 6's approach.
  - Then `i32.store` at `[b1_scratch_base + scratch_offset]` for the `arm_id = arm_idx` value.
  - Then re-push operands by reading them back, OR (cleaner) pre-spill to locals before the save sequence and `local.get` back at the end.
- Set `in_catch_K = 1` (per existing Phase 6 catch_ref logic) and `catch_region_id_local = K`.
- `br` to the original `arm.label`.

The try_table rewrite: replace each plain `Catch { tag, label }` with `Catch { tag, label: capture_seq_id }`. Mixed plain+catch_ref try_tables: BOTH rewrites must apply. Verify by reading `apply_catch_ref_handlers`'s catches-list rebuild logic (lines 2175-2189) and extend.

Tests:
- Emission test: a fixture with a single plain-catch arm produces the expected capture-block shape. Assert via walrus IR walk that the `Instr::TryTable`'s catches list has the capture_seq_id substituted.
- Validation test: post-instrument module validates.
- Byte-identity guard: a module without plain-catch arms produces byte-identical output to pre-Task-2.2.

Commit: `feat(fork-instrument): B1 stage 2 — per-arm capture-block emission`.

#### Task 2.3: Per-arm rewind dispatch in `inject_rewind_throw_stubs`

**Files:**
- `crates/fork-instrument/src/instrument.rs::inject_rewind_throw_stubs` (currently at `:1974`).

Today's stub: `if state == REWINDING && catch_region_id == K { throw_ref (table.get exnref_stash slot) }`.

Extended stub for plain-catch arms in region K:
```
if state == REWINDING && catch_region_id == K {
    let arm_id = i32.load [b1_scratch_base + region_first_arm.scratch_offset]
    if arm_id == 0 { throw_ref (table.get exnref_stash slot) }   ;; existing catch_ref
    else if arm_id == J { throw $tag_J (load operand_0, ..., load operand_N-1) }
    else if arm_id == K' { ... }
    ...
}
```

`arm_id == 0` is reserved for the catch_ref path (which writes 0 because Phase 6 doesn't set arm_id). Plain-catch arms write `arm_idx + 1`? No — arm_idx 0 is a valid plain-catch arm index. Use a different sentinel. Two options:
- Use `arm_idx` directly as arm_id, and add a separate `is_ref: i32` flag at a different scratch offset to distinguish ref-path from plain-path.
- Reserve `arm_id = -1` (or `u32::MAX`) for catch_ref, use `arm_idx` for plain.

Option 2 is cleaner. Stage 1's `arm_id` field comment said "Stage 2 writes this value as the `arm_id` field of the saved scratch tuple at unwind time" — keep that contract. The catch_ref path just doesn't write to the scratch tuple at all; the rewind stub treats absence-of-write (initial value, set by parent process or zero-on-fresh-buffer) as "use the exnref path." Simplest: the rewind stub checks `is_in_catch_region == K` first, then if the `_wpk_fork_exnref_stash[slot]` is non-null, take the ref path; otherwise look up arm_id.

This needs a design pass during Task 2.3 implementation. Don't over-spec it now — the right answer will be obvious once Task 2.2's emission gives a concrete state to dispatch from.

Tests:
- Emission test: rewind stub for a region with both ref and plain arms has the expected if-chain shape.
- Stage 2 integration: parent forks from inside plain-catch handler, child resumes with operands restored. Requires Task 3's wasmtime harness — defer behavioral assertion to Stage 3.

Commit: `feat(fork-instrument): B1 stage 2 — multi-arm rewind dispatch (catch_ref + plain)`.

#### Task 2.4: Multi-target try_table support (decision point)

**Files:**
- `crates/fork-instrument/src/instrument.rs::plan_catch_ref_handlers` (the single-target restriction at `:2111`).

Phase 6 today rejects multi-target `*_ref` try_tables. B1's plain-catch capture inherently supports multiple targets (each gets its own `$capture_K_arm_J`). Decide whether to:
- (a) Lift the multi-target restriction in Phase 6 to match B1's capability.
- (b) Keep Phase 6's restriction and add a similar one for B1 plain-catch (single-target only).

Option (a) is more work (Phase 6 needs the same per-arm dispatch B1 just got) but unblocks programs with multi-target try_tables. Option (b) is faster.

**Recommendation: option (b) for Stage 2, file follow-up for option (a).** Synthetic fixtures don't force option (a), and shipping ports don't have multi-target try_tables.

Add a check in `discover_plain_catch_arms` (or in `plan_b1_scratch`'s carve-out): if a try_table has more than one plain-catch arm AND the labels differ, skip B1 instrumentation for that try_table and add the function to `b2_carveout`. Single-target multi-arm (all arms point to same label) is fine.

Commit: `feat(fork-instrument): B1 stage 2 — guard against multi-target plain-catch try_tables`.

### Stage 2 verification

After each task: `cargo test -p fork-instrument` + `bash scripts/run-sortix-tests.sh basic`. The sortix gate is the byte-identity check for shipping ports — if any of the 929 currently-passing tests regresses, Stage 2 has broken something. Stop and diagnose.

After Task 2.4: full gauntlet (cargo lib, vitest, libc-test, posix, sortix --all, ABI). vitest application failures (PHP/WP/Erlang) are environmental and not B1's concern.

Stage 2 ends with the emission code in place. Behavioral correctness is asserted in Stage 3 via a wasmtime-driven C++ fork-from-catch fixture.

---

## Stage 3 — Runtime harness — DEFERRED to SpiderMonkey port

**Decision (2026-04-28):** the natural real-world validation event for B1 is the in-progress SpiderMonkey-based Node.js runtime port (see `memory/spidermonkey-node-runtime-initiative.md`, design doc `docs/plans/2026-04-28-spidermonkey-node-runtime-design.md`). SpiderMonkey is a C++ codebase that uses C++ exception handling extensively; Node.js compatibility requires `child_process` / `popen` patterns that exercise fork-from-plain-catch in real production code paths.

The SpiderMonkey port's pre-Phase-1 gate 1.B was originally specified as "B1 follow-up shipped." With Stages 1+2 landed (this document), gate 1.B is met for the planning-and-emission portion. The runtime validation gap that Stage 3 was meant to close is **better filled by the port itself** — passing a SpiderMonkey-built C++ fork-from-catch test under both wasmtime AND the kernel's process-worker host is stronger evidence than a synthetic single-purpose fixture would be.

**Action item in the SpiderMonkey port plan:** Phase 1's test suite must include an explicit B1 fixture. Recommended shape:

- A small C++ fixture using `try { ... fork() ... } catch (T& e) { fork(); ... }` where the catch handler does real work (libc calls, allocations) before/after fork. Both parent and child paths exercised.
- Run via wasmtime AND via the kernel's process-worker host (different runtime environments may surface different bugs).
- The fixture lives in the SpiderMonkey port's test suite; its passing is the acceptance bar for B1 Stage 3.

**Until the SpiderMonkey port hits this case**, B1 Stages 1+2 remain unproven for real-world use:
- High confidence Stage 2 doesn't break existing programs (sortix `--all` byte-identical).
- Medium confidence Stage 2 emits valid wasm for plain-catch programs (validated, not run).
- Zero confidence Stage 2 produces *correct* runtime behavior for fork-from-plain-catch.

If a non-SpiderMonkey port forces fork-from-plain-catch first, that port becomes the validation event instead and the same fixture-shape requirement applies.

---

## Stage 4 — Fuzz oracle (target: 2-3 days, ~300 LoC)

**Goal:** Catch shape-sensitivity bugs that synthetic fixtures miss.

- **4a — Extend the existing fuzz generator** at `crates/fork-instrument/fuzz/` to emit programs with plain-catch handlers containing fork-path calls.
- **4b — Add a runtime oracle** that instruments the generated module, drives it under wasmtime through unwind/rewind, and compares observable state (memory + globals + exit code) against an unmodified baseline run.
- **4c — Run 10000 iterations clean** as the gate, matching the existing Phase 6 fuzz bar (`scripts/run-fork-instrument-fuzz.sh`).

---

## Stage 5 — Documentation

- **5a — Update `docs/fork-instrumentation.md`:**
  - New §"Plain-catch fork resume" describing the per-arm scratch layout (parallel to existing "Catch-handler resume" §).
  - Before/after WAT pairs for the plain-catch capture block + rewind-throw stub.
  - Move "Fork-from-catch through a plain `catch` clause" out of "Not guaranteed" and into "Guaranteed."
  - Add a remaining "Not guaranteed" entry for non-scalar-operand catches if Stage 2 keeps that as a carve-out.
- **5b — Update `docs/posix-status.md`:** Remove the "fork-from-catch unsupported" note.
- **5c — Update `docs/plans/2026-04-20-fork-instrumentation-design.md`:** Cross-link to this plan as the B1 follow-up implementation.

---

## Rollback strategy

If any stage destabilizes the existing pipeline, the staged commits make rollback easy: revert all commits since `fork-instrument-b1-stage1` (or further back to the merge base of `phase-7-pthread-fixes`). The B1 scratch fields default to zero; with `b1_scratch_size = 0`, `frames_start_offset` is unchanged and behavior is identical to pre-B1.

---

## Critical assumptions (validate as you go)

1. **walrus IR exposes tag operand types via `module.tags.get(tag).ty().params()`.** Verify in Task 1.1 step 4. If the API is named differently, adjust.
2. **`subtree_contains_fork_call` exists and works for label-target blocks.** It exists at `crates/fork-instrument/src/instrument.rs:3252`. Confirm.
3. **Wasm `throw $tag (operands...)` is emittable from walrus IR.** Verify by inspecting `walrus::ir::Throw` — Stage 2 task 1.
4. **8-byte alignment for the scratch area suffices for f64/i64 operand storage.** Standard wasm alignment rules say yes; double-check with v128 if any tag uses it (16-byte align needed; current plan uses 8 — Stage 1 review).
5. **No existing fork-path port has plain-catch fork.** Phase 7 ported 10 programs without hitting this pattern. Confirmed by spot-checking that all 10 wasms validate post-instrument. If a port quietly hit guard-dispatch fallback today and silently mis-instrumented, Stage 1 is purely additive so it won't expose new failures — but Stage 2 may make that program fail differently. Re-run libc-test + sortix gates after each stage.
