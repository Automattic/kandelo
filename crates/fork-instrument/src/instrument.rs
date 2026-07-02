//! Per-function instrumentation — switch-dispatch transform.
//!
//! This module rewrites every fork-path function's body into an
//! switch-dispatch fork rewind: during REWIND, execution jumps
//! directly to the post-active-call-site label via a `br_table`
//! inside a REWINDING guard, skipping all body code between the
//! function entry and the resumed call site.
//!
//! Why this shape: re-executing a function's body top-to-bottom during
//! REWIND (the pre-redesign approach) re-fires every non-fork-path
//! direct call (`setpgid`, `dup3`, `open`, `kill`, …) and re-runs any
//! shadow-stack / SP arithmetic before the resumed call site.  Both
//! classes cause user-visible fork-semantic bugs.  Switch dispatch
//! sidesteps both problems: the only body code that runs during REWIND
//! is the chosen call site's post-call handling plus chunks that
//! follow it.
//!
//! ## Overall shape of an instrumented function body
//!
//! ```wat
//! (func $F (params...) (results...)
//!   ;; --- PREAMBLE (runs only when state == REWINDING) ---
//!   (if (i32.eq (global.get $_wpk_fork_state) (i32.const 2))
//!     (then
//!       ;; pop frame from save buffer, then restore catch_region_id,
//!       ;; exnref_slot, scalar locals, and arg-spill locals
//!     ))
//!
//!   ;; --- DISPATCH + WRAPPER + NESTED POST LABELS ---
//!   (block $unwind_save
//!     (block $POST_{N-1}
//!       ...
//!         (block $POST_0
//!           (block $dispatch_normal
//!             (if (i32.eq (global.get $_wpk_fork_state) (i32.const 2))
//!               (then
//!                 ;; load frame.call_index from *(buf + 0)
//!                 (br_table $POST_0 $POST_1 ... $POST_{N-1} $unwind_save)))
//!             ;; NORMAL: fall through out of $dispatch_normal
//!           )
//!           <chunk 0>                ;; pre-call-0 body, only NORMAL
//!           <spill args for call 0>  ;; into user-visible locals
//!         )  ;; end $POST_0 — also the br_table landing for call_idx==0
//!         <reload args for call 0>
//!         (call $callee_0)           ;; or call_indirect
//!         <Phase 6e: set catch_region_id_local / exnref_slot_local>
//!         (global.get $_wpk_fork_state) (i32.const 1) (i32.eq)
//!         (if (then
//!           ;; frame.call_index = 0
//!           (br $unwind_save)))       ;; propagate UNWINDING
//!         <chunk 1>
//!         <spill args for call 1>
//!       )  ;; end $POST_1
//!       ...
//!     )  ;; end $POST_{N-1}
//!     <reload args for call N-1>
//!     (call $callee_{N-1})
//!     <Phase 6e>
//!     (if state == UNWINDING:
//!       frame.call_index = N-1
//!       br $unwind_save)
//!     <chunk N: tail>
//!     (return)                       ;; normal-path exit
//!   )  ;; end $unwind_save — br target for UNWINDING propagation
//!
//!   ;; --- POSTAMBLE (runs only when branched-to via br $unwind_save) ---
//!   ;; push frame header fields except call_index, save scalar user locals,
//!   ;; save arg-spill locals, spill ref-typed user locals to aux tables,
//!   ;; advance current_pos, push defaults for the function's result types
//! )
//! ```
//!
//! ## MVP scope
//!
//! - **Top-level fork-path calls only.**  A fork-path call nested
//!   inside a `block`/`loop`/`if`/`try_table` causes `br_table` to be
//!   unable to land at its site (wasm semantics forbid branching into
//!   a block from outside).  The tool panics with a diagnostic in
//!   that case; the function must be restructured or the tool
//!   extended.
//! - **Fork-from-catch-handler remains unsupported** (B1 follow-up).
//!   Phase 6c/6d/6e plumbing is retained so ref-typed exnref locals
//!   still round-trip cleanly across fork; if a handler contains a
//!   fork-path call, the tool panics (same mechanism as nested).
//! - **Scalar args only for fork-path calls.**  If a fork-path call
//!   has a ref-typed argument, we'd need to spill it through an aux
//!   table (not currently wired up).  Panic in that case.
//!
//! ## Frame layout (unchanged from the previous transform)
//!
//! All offsets are relative to the frame's base address.
//!
//! | Offset        | Size | Field             |
//! |---------------|------|-------------------|
//! | 0             | 4    | `func_index`      |
//! | 4             | 4    | `call_index`      |
//! | 8             | 4    | `catch_region_id` |
//! | 12            | 4    | `exnref_slot`     |
//! | 16..          | var  | scalar locals (user + arg spills) |
//!
//! Ref-typed user locals are routed through module-level auxiliary
//! tables; their storage is outside the frame.
//!
//! ## What's preserved verbatim
//!
//! - `crates/fork-instrument/src/call_graph.rs` — fork-path closure
//!   discovery (direct + indirect).
//! - `crates/fork-instrument/src/runtime.rs` — state machine, five
//!   exported control functions, save-buffer layout, saved-globals
//!   handling.
//! - Phase 4f aux-table injection for ref-typed user locals.
//! - Phase 6a–6d plumbing for `try_table` / catch-handler resume.

use std::collections::{HashMap, HashSet};

use walrus::{
    ir::{
        AtomicWidth, BinaryOp, Binop, Block, Br, BrTable, Call, CallIndirect, Const, GlobalGet,
        IfElse, Instr, InstrLocId, InstrSeqId, InstrSeqType, LegacyCatch, LoadKind, LocalGet,
        LocalSet, LocalTee, Loop, MemArg, RefAsNonNull, RefIsNull, RefNull, Return, StoreKind,
        TableGet, TableSet, Throw, ThrowRef, TryTable, TryTableCatch, UnaryOp, Unreachable, Value,
    },
    AbstractHeapType, FunctionId, FunctionKind, HeapType, LocalFunction, LocalId, MemoryId, Module,
    RefType, TableId, TagId, TypeId, ValType,
};

use crate::runtime::{self, Runtime};

/// Instrument every function in `fork_path` that we can instrument.
///
/// Returns the set of function IDs that were actually rewritten.
pub fn instrument_functions(
    module: &mut Module,
    runtime: &Runtime,
    fork_path: &HashSet<FunctionId>,
    b1_plan: &B1ScratchPlan,
) -> HashSet<FunctionId> {
    let runtime_funcs: HashSet<FunctionId> = [
        runtime.unwind_begin,
        runtime.unwind_end,
        runtime.rewind_begin,
        runtime.rewind_end,
        runtime.state,
    ]
    .into_iter()
    .collect();

    let mut targets: Vec<FunctionId> = fork_path
        .iter()
        .copied()
        .filter(|id| !runtime_funcs.contains(id))
        .filter(|id| matches!(module.funcs.get(*id).kind, FunctionKind::Local(_)))
        .collect();
    targets.sort();

    let (aux_tables, ref_plan, catch_plans) = plan_and_inject_aux_tables(module, &targets);

    let empty_b1_slots: Vec<(InstrSeqId, Vec<PlainCatchArmSlot>)> = Vec::new();

    let mut instrumented = HashSet::new();
    for (ordinal, id) in targets.iter().enumerate() {
        let empty_plan: Vec<RefLocalSlot> = Vec::new();
        let this_plan = ref_plan.get(id).unwrap_or(&empty_plan);
        let empty_catch_plan: Vec<CatchRegionPlan> = Vec::new();
        let this_catch_plan = catch_plans.get(id).unwrap_or(&empty_catch_plan);
        let this_b1_slots = b1_plan.per_function.get(id).unwrap_or(&empty_b1_slots);
        instrument_one_function(
            module,
            *id,
            runtime,
            fork_path,
            ordinal as u32,
            &aux_tables,
            this_plan,
            this_catch_plan,
            this_b1_slots,
        );
        instrumented.insert(*id);
    }
    instrumented
}

// ----------------------------------------------------------------------
// Frame layout constants
// ----------------------------------------------------------------------

const HEADER_SIZE: u32 = 16;
const FUNC_INDEX_OFFSET: u64 = 0;
const CALL_INDEX_OFFSET: u64 = 4;
const CATCH_REGION_OFFSET: u64 = 8;
const EXNREF_SLOT_OFFSET: u64 = 12;
const LOCALS_START_OFFSET: u32 = HEADER_SIZE;

// ----------------------------------------------------------------------
// Per-function pipeline
// ----------------------------------------------------------------------

/// Classification of a top-level fork-path call site.
#[derive(Debug, Clone, Copy)]
enum CallTarget {
    Direct(FunctionId),
    Indirect { table: TableId },
}

/// A top-level call site awaiting dispatch-structure emission.
struct CallSiteInfo {
    target: CallTarget,
    sig_ty: TypeId,
    loc: InstrLocId,
}

#[derive(Debug, Clone, Copy)]
struct CatchStateLocals {
    catch_region_id: LocalId,
    exnref_slot: LocalId,
}

#[allow(clippy::too_many_arguments)]
fn instrument_one_function(
    module: &mut Module,
    func_id: FunctionId,
    runtime: &Runtime,
    fork_path: &HashSet<FunctionId>,
    func_ordinal: u32,
    aux_tables: &AuxTables,
    ref_plan: &[RefLocalSlot],
    catch_plan: &[CatchRegionPlan],
    b1_slots: &[(InstrSeqId, Vec<PlainCatchArmSlot>)],
) {
    // Choose scheme based on call-site topology. Post-commit-4
    // (2026-05-14) there are TWO live schemes (guard-dispatch was
    // deleted; legacy catch-handler forks still panic defensively):
    //
    //   instrument_one_function_switch — top-level fork-path calls
    //   only. Body is restructured so a top-level `br_table` jumps
    //   directly to the resumed call site, skipping all code in
    //   between. Per-call operand-stack carryovers (LLVM `*(sp+K) =
    //   call(...)` shapes) are absorbed via per-call spill locals
    //   (sub-commit 2.4c) — formerly forced guard-dispatch.
    //
    //   instrument_one_function_nested_switch — fork-path calls
    //   nested inside Block/IfElse/Loop/TryTable bodies. Cascading
    //   POST_K blocks plus per-region br_tables route REWIND through
    //   each enclosing instruction's own dispatch. Sub-commits 2.5/2.6
    //   added carryover spilling at nested direct-call landings,
    //   nested-Loop-with-carryover (side benefit), and multi-value-
    //   params SubRegion body-input-param prespill.
    //
    // Catch-handler bodies live inside a nested try_table; nested
    // switch-dispatch handles them via the rewind-throw stub +
    // capture block mechanism (see Phase 6 + B1 stages 1+2 docs).
    //
    // Both schemes:
    // - share the same fork-resume contract (state machine, frame
    //   layout, aux-table ref-typed spills, throw_ref catch resume).
    // - skip body chunks before the chosen POST_K on REWIND, so
    //   non-fork-path calls and side-effect ops in those chunks run
    //   exactly once on NORMAL — no per-op gating needed (the
    //   pre-2.5/2.6 Phase 4g machinery was deleted with guard-
    //   dispatch in commit 4).
    if has_nested_fork_calls(module, func_id, fork_path) {
        // Nested per-block switch-dispatch: if classify_nested_pattern
        // accepts the function's nesting shape, use the cascading
        // POST_K + per-region br_table transform. Sub-commits 2.5/2.6
        // expanded "supported" to cover Loops/TryTables/legacy Try
        // bodies/multi-value-params/carryovers; only fork-from-legacy-
        // catch remains a panic-defensive fallback.
        let nested_status = classify_nested_pattern(module, func_id, fork_path);
        if nested_status.is_supported() {
            instrument_one_function_nested_switch(
                module,
                func_id,
                runtime,
                fork_path,
                func_ordinal,
                aux_tables,
                ref_plan,
                catch_plan,
                b1_slots,
            );
            return;
        }
        // Commit 3 (2026-05-14): the only remaining
        // `NestedSupportStatus` rejection is fork-from-legacy-catch.
        // Sub-commits 2.5c/2.6c closed `UnsupportedCarryover` and
        // `UnsupportedMultiValueParams` respectively; legacy Try bodies
        // now use the same nested-switch route as TryTable bodies. If
        // we reach this branch on a shipping binary, the fork-path call
        // is in a legacy catch handler, which still needs exception
        // state reconstruction.
        let func = func_name(module, func_id);
        if has_fork_call_in_catch_handler(module, func_id, fork_path) {
            panic!(
                "fork-instrument: function `{func}` has a fork-path call inside a \
                 try_table catch-handler body. This pattern is currently \
                 unsupported end-to-end (B1 stages 1+2 shipped machinery but the \
                 C1 fixture still hangs). See \
                 memory/fork-instrument-b1-followup.md and the C1 fixture in \
                 programs/cpp_eh_fork_from_catch_test.cpp."
            );
        }
        match nested_status {
            NestedSupportStatus::UnsupportedLegacyTry => panic!(
                "fork-instrument: function `{func}` triggered `UnsupportedLegacyTry` \
                 — a fork-path call inside a legacy `catch` handler. Legacy `try` \
                 bodies are supported by nested switch-dispatch, but legacy catch \
                 handlers still need exception-state reconstruction before REWIND \
                 can re-enter the handler path."
            ),
            NestedSupportStatus::UnsupportedCarryover => panic!(
                "fork-instrument: function `{func}` has a nested fork-path call with \
                 an operand-stack carryover shape the nested-switch analyser cannot \
                 type. Extend `compute_nested_carryover_types` / \
                 `analyze_subregion_spill_types` for the specific producer."
            ),
            NestedSupportStatus::UnsupportedMultiValueParams => panic!(
                "fork-instrument: function `{func}` has unsupported multi-value \
                 params in nested fork-path control flow."
            ),
            NestedSupportStatus::Supported => unreachable!(),
        }
    }

    if has_top_level_stack_carryovers(module, func_id, fork_path) {
        // Sub-commit 2.4c (2026-05-14): switch-dispatch absorbs
        // top-level carryovers via in-place spill/reload at the call
        // site. The compute_carryover_types Option<ValType> refactor
        // (sub-commit 9-followup) made the analyser succeed for any
        // shape whose carryover values are statically typed — and
        // unknown-type values consumed before any fork-path call are
        // also tolerated. If the analyser still returns None here, a
        // shipping binary has an unknown-type value AS a carryover at
        // a fork-path call (genuinely rare LLVM output). Panic loudly
        // for the same reason as the LegacyTry case above.
        if compute_carryover_types(module, func_id, fork_path).is_some() {
            instrument_one_function_switch(
                module,
                func_id,
                runtime,
                fork_path,
                func_ordinal,
                aux_tables,
                ref_plan,
                catch_plan,
                b1_slots,
            );
            return;
        }
        let func = func_name(module, func_id);
        panic!(
            "fork-instrument: function `{func}` has a top-level fork-path call \
             whose operand-stack carryover contains a value of a type the \
             analyser can't statically determine or cannot scalar-spill \
             (ref-typed producer, non-fork-path CallIndirect or CallRef, \
             or ref-typed structured-control result). The 2.6c push-before \
             emission can spill this carryover only if its type is known. \
             Extend `compute_carryover_types` to handle the specific producer, \
             or change the source to avoid the pattern."
        );
    }

    instrument_one_function_switch(
        module,
        func_id,
        runtime,
        fork_path,
        func_ordinal,
        aux_tables,
        ref_plan,
        catch_plan,
        b1_slots,
    );
}

/// Switch-dispatch transform: fork-path calls are hoisted out of the
/// function body and reached during REWIND via a top-level `br_table`
/// that lands directly at the post-active-call-site label. Chunks
/// between calls run only on the NORMAL fall-through path.
#[allow(clippy::too_many_arguments)]
fn instrument_one_function_switch(
    module: &mut Module,
    func_id: FunctionId,
    runtime: &Runtime,
    fork_path: &HashSet<FunctionId>,
    func_ordinal: u32,
    aux_tables: &AuxTables,
    ref_plan: &[RefLocalSlot],
    catch_plan: &[CatchRegionPlan],
    b1_slots: &[(InstrSeqId, Vec<PlainCatchArmSlot>)],
) {
    // Pre-existing user locals (args + referenced in body). Scalars
    // live in the frame; ref-typed locals go through aux tables.
    let all_user_locals = collect_user_locals(module, func_id);
    let user_scalar_locals: Vec<(LocalId, ValType)> = all_user_locals
        .iter()
        .copied()
        .filter(|(_, ty)| is_scalar(*ty))
        .collect();

    // Sub-commit 2.4c: compute carryover types BEFORE taking the
    // original body, since `compute_carryover_types` reads the body
    // through `module.funcs.get(func_id)`. Computing it after `take`
    // would see an empty body and report no carryovers.
    let carryover_types_pre_take = compute_carryover_types(module, func_id, fork_path);

    // Take the original entry body; we rebuild it wholesale.
    let entry_id = local_mut(module, func_id).entry_block();
    let original_body: Vec<(Instr, InstrLocId)> =
        std::mem::take(&mut local_mut(module, func_id).block_mut(entry_id).instrs);

    // Partition the body at top-level fork-path call sites.
    let (mut chunks, call_sites) = partition_body(&original_body, fork_path, module);
    let n_calls = call_sites.len();

    // Allocate per-function synthetic locals.
    let catch_state_locals = if catch_plan.is_empty() && b1_slots.is_empty() {
        None
    } else {
        Some(CatchStateLocals {
            catch_region_id: module.locals.add(ValType::I32),
            exnref_slot: module.locals.add(ValType::I32),
        })
    };

    // Per-call argument materialization. The default is the existing
    // spill-local path; a conservative pure scalar suffix can instead
    // be replayed after POST_K and needs no frame-backed arg locals.
    let pending_arg_materializations: Vec<PendingCallArgMaterialization> = call_sites
        .iter()
        .enumerate()
        .map(|(site_idx, cs)| {
            let arg_types = call_arg_types(module, cs);
            for ty in &arg_types {
                if !is_scalar(*ty) {
                    let name = func_name(module, func_id);
                    panic!(
                        "fork-instrument: function `{name}` has a fork-path call with a ref-typed \
                     argument ({ty:?}). Ref-typed call arguments need aux-table spilling, \
                     which the MVP switch-dispatch transform does not yet support.",
                    );
                }
            }
            plan_call_arg_materialization(module, &chunks[site_idx], arg_types)
        })
        .collect();
    let arg_materializations: Vec<CallArgMaterialization> = pending_arg_materializations
        .into_iter()
        .map(|pending| allocate_call_arg_materialization(module, pending))
        .collect();
    for (site_idx, materialization) in arg_materializations.iter().enumerate() {
        truncate_materialized_tail(&mut chunks[site_idx], materialization.tail_len());
    }

    // Sub-commit 2.4c: per-call operand-stack carryovers (computed
    // pre-take, see above). Allocate spill locals for each.
    // Length mismatch or None falls back to per-call empty carryovers
    // — matches pre-2.4c switch-dispatch behavior for the no-carryover
    // case. The dispatch decision in `instrument_one_function` only
    // routes to switch-dispatch with carryovers when the analysis was
    // conclusive AND `has_top_level_stack_carryovers` was true.
    let carryover_types: Vec<Vec<ValType>> = match carryover_types_pre_take {
        Some(v) if v.len() == n_calls => v,
        _ => vec![Vec::new(); n_calls],
    };
    let mut carryover_spills: Vec<Vec<LocalId>> = Vec::with_capacity(n_calls);
    for site_carryovers in &carryover_types {
        let spills: Vec<LocalId> = site_carryovers
            .iter()
            .map(|&ty| module.locals.add(ty))
            .collect();
        carryover_spills.push(spills);
    }

    // Combined scalar locals for the frame (user locals first, then
    // frame-backed per-call arg spills in call order, then per-call
    // carryover spills in call order — added 2.4c).
    let mut frame_scalars: Vec<(LocalId, ValType)> = user_scalar_locals.clone();
    for (site_idx, cs) in call_sites.iter().enumerate() {
        let arg_types = call_arg_types(module, cs);
        for (&lid, &ty) in arg_materializations[site_idx]
            .spill_locals()
            .iter()
            .zip(arg_types.iter())
        {
            frame_scalars.push((lid, ty));
        }
    }
    for (site_idx, cr_types) in carryover_types.iter().enumerate() {
        for (&lid, &ty) in carryover_spills[site_idx].iter().zip(cr_types.iter()) {
            frame_scalars.push((lid, ty));
        }
    }

    let locals_with_offsets = assign_local_offsets(&frame_scalars, LOCALS_START_OFFSET);
    let frame_size = HEADER_SIZE + user_locals_size(&frame_scalars);

    let result_types: Vec<ValType> = {
        let ty_id = module.funcs.get(func_id).ty();
        module.types.get(ty_id).results().to_vec()
    };

    // Plan catch-handler entry-capture (Phase 6d). We allocate in_catch
    // and captured_exnref locals now; the IR rewrite is applied later,
    // after the body has been rebuilt.
    let catch_handlers = plan_catch_ref_handlers(module, func_id, catch_plan, aux_tables);

    // Build the new body: preamble-if + Block($unwind_save) + postamble.
    let memory = first_memory(module);
    let ptr_ty = runtime.buf_type;

    // Phase 6c rewind-throw stubs: prepended to each fork-path
    // try_table body. Phase 6 covers catch_ref / catch_all_ref.
    // B1 Stage 2 (Task 2.3) extends the same stub with a plain-catch
    // dispatch when `b1_slots` lists arms for the region.
    if !catch_plan.is_empty() && aux_tables.exnref.is_some() {
        let catch_state =
            catch_state_locals.expect("exnref catch plan requires catch-state locals");
        inject_rewind_throw_stubs(
            module,
            func_id,
            runtime,
            catch_state.catch_region_id,
            aux_tables,
            catch_plan,
            b1_slots,
        );
        // The stub injection appended to the try_tables' own body
        // seqs. Those seqs are reachable from instructions inside
        // `chunks` (we left them in place). The original body still
        // carries the TryTable instrs — no re-walk needed.
    }

    // Preamble: two dangling branches (then/empty-else). Then the
    // dispatch structure inside `$unwind_save`, then the postamble as
    // a flat list that follows the Block($unwind_save) in the entry
    // block.
    let local = local_mut(module, func_id);

    let preamble_then = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();
    let preamble_else = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();

    // POST_K + function-level `$unwind_save`. Dispatch-tree
    // `$dispatch_normal` / `$node_dispatch` are allocated by
    // `populate_dispatch_structure`.
    let unwind_save = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();
    let post_seqs: Vec<InstrSeqId> = (0..n_calls)
        .map(|_| {
            local
                .builder_mut()
                .dangling_instr_seq(InstrSeqType::Simple(None))
                .id()
        })
        .collect();

    // Populate preamble-then: pop frame, restore locals, etc.
    populate_preamble_then(
        local,
        preamble_then,
        runtime,
        memory,
        ptr_ty,
        catch_state_locals,
        &locals_with_offsets,
        ref_plan,
        aux_tables,
        frame_size,
    );

    populate_dispatch_structure(
        local,
        unwind_save,
        &post_seqs,
        &chunks,
        &call_sites,
        &arg_materializations,
        &carryover_spills,
        &catch_handlers,
        runtime,
        memory,
        ptr_ty,
        catch_state_locals,
    );

    // Postamble lives outside $unwind_save, in the entry block, right
    // after the Block($unwind_save) instruction. Built as a flat list
    // of instructions.
    let mut postamble: Vec<(Instr, InstrLocId)> = Vec::new();
    populate_postamble(
        &mut postamble,
        runtime,
        memory,
        ptr_ty,
        catch_state_locals,
        &locals_with_offsets,
        ref_plan,
        aux_tables,
        frame_size,
        func_ordinal,
        &result_types,
    );

    // Rebuild the entry block: [preamble if/else, Block($unwind_save),
    // postamble].
    let entry_seq = &mut local.block_mut(entry_id).instrs;
    entry_seq.clear();
    push_instr(
        entry_seq,
        Instr::GlobalGet(GlobalGet {
            global: runtime.state_global,
        }),
    );
    push_instr(
        entry_seq,
        Instr::Const(Const {
            value: Value::I32(runtime::STATE_REWINDING),
        }),
    );
    push_instr(
        entry_seq,
        Instr::Binop(Binop {
            op: BinaryOp::I32Eq,
        }),
    );
    push_instr(
        entry_seq,
        Instr::IfElse(IfElse {
            consequent: preamble_then,
            alternative: preamble_else,
        }),
    );
    push_instr(entry_seq, Instr::Block(Block { seq: unwind_save }));
    entry_seq.extend(postamble);

    // Phase 6d application: replaces each fork-path try_table with
    // an $outer/$capture wrap so caught exnrefs are stashed and the
    // original handler is re-entered via `br`. Runs after body rebuild
    // so it finds the try_tables at their new locations inside chunks.
    apply_catch_ref_handlers(module, func_id, &catch_handlers, aux_tables);

    // Stage 2 (B1) plain-catch capture-block emission: per-arm
    // captures intercept plain catch dispatch so the operand tuple
    // can be saved at unwind time. Runs AFTER Phase 6 so it finds
    // try_tables at their post-Phase-6 locations.
    if let Some(catch_state) = catch_state_locals {
        apply_plain_catch_handlers(
            module,
            func_id,
            runtime,
            catch_state.catch_region_id,
            b1_slots,
            catch_plan,
            &catch_handlers,
        );
    } else {
        debug_assert!(b1_slots.is_empty());
    }
}

// ----------------------------------------------------------------------
// Body analysis: nested-call validation + partitioning
// ----------------------------------------------------------------------

/// Returns true iff the function has at least one fork-path call
/// (direct or indirect) nested inside a `block`/`loop`/`if`/`try_table`.
/// Such a function cannot use the switch-dispatch top-level br_table
/// scheme; nested switch-dispatch (cascading POST_K + per-region
/// br_table) handles it instead.
fn has_nested_fork_calls(
    module: &Module,
    func_id: FunctionId,
    fork_path: &HashSet<FunctionId>,
) -> bool {
    let local = match &module.funcs.get(func_id).kind {
        FunctionKind::Local(l) => l,
        _ => return false,
    };

    fn walk(
        f: &LocalFunction,
        seq: InstrSeqId,
        fork_path: &HashSet<FunctionId>,
        depth: u32,
        found: &mut bool,
    ) {
        if *found {
            return;
        }
        for (instr, _) in &f.block(seq).instrs {
            match instr {
                Instr::Call(c) if fork_path.contains(&c.func) => {
                    if depth > 0 {
                        *found = true;
                        return;
                    }
                }
                Instr::CallIndirect(_) => {
                    if depth > 0 {
                        *found = true;
                        return;
                    }
                }
                _ => {}
            }
            for child in nested_seqs(instr) {
                walk(f, child, fork_path, depth + 1, found);
                if *found {
                    return;
                }
            }
        }
    }

    let mut found = false;
    walk(local, local.entry_block(), fork_path, 0, &mut found);
    found
}

/// Returns true iff any top-level fork-path call site in `func_id`
/// has operand-stack values "carried over" across the call — values
/// pushed before the call's args that remain on the stack at the call
/// point. LLVM emits this shape routinely for expressions like
/// `*(sp + K) = call(args...)`: `sp` is pushed first, then the call's
/// args, then the call runs, then i32.store consumes [sp, ret_val].
///
/// Pre-sub-commit-2.4c: switch-dispatch's `$POST_K` block was typed
/// Simple(None) (0 params, 0 results), so a non-empty stack at the
/// block's close would fail validation; functions with carryovers
/// fell through to guard-dispatch. Sub-commit 2.4c added per-call
/// carryover spilling so switch-dispatch absorbs these shapes
/// directly; this function still gates the routing decision (only
/// run `compute_carryover_types` when there IS a top-level carryover,
/// saving the per-instruction typed-stack walk on functions that
/// don't need it).
///
/// The walk is conservative: if we encounter an instruction whose
/// stack effect we can't statically determine (wasm-GC ops, legacy
/// exception `try`, …), we report `true` so the caller invokes
/// `compute_carryover_types`. That analyser may itself return `None`
/// (forcing the post-commit-3 panic) if an unknown-type slot reaches
/// a carryover; otherwise switch-dispatch handles it.
/// Likewise for stack underflows — which shouldn't happen in valid
/// wasm, but we defensively route to the post-commit-3 panic path if
/// the input is malformed in a way we can't analyze.
fn has_top_level_stack_carryovers(
    module: &Module,
    func_id: FunctionId,
    fork_path: &HashSet<FunctionId>,
) -> bool {
    let local = match &module.funcs.get(func_id).kind {
        FunctionKind::Local(l) => l,
        _ => return false,
    };
    let entry = local.entry_block();

    let mut depth: usize = 0;

    for (instr, _) in &local.block(entry).instrs {
        // Check for a fork-path call first — partitioning will split
        // here, so we need `depth` to equal the call's expected arity.
        let expected_args: Option<usize> = match instr {
            Instr::Call(c) if fork_path.contains(&c.func) => Some(
                module
                    .types
                    .get(module.funcs.get(c.func).ty())
                    .params()
                    .len(),
            ),
            Instr::CallIndirect(ci) => {
                // +1 for the table index on top of the signature's params.
                Some(module.types.get(ci.ty).params().len() + 1)
            }
            _ => None,
        };
        if let Some(expected) = expected_args {
            if depth > expected {
                return true;
            }
        }

        match top_level_stack_effect(module, local, instr) {
            StackEffect::Delta { pops, pushes } => {
                if depth < pops {
                    // Underflow — input wasm is ill-formed from our
                    // perspective, or we mis-analyzed an instruction.
                    // Conservatively report a carryover (forcing the
                    // caller to invoke compute_carryover_types, which
                    // will likely also return None and trigger the
                    // post-commit-3 panic).
                    return true;
                }
                depth = depth - pops + pushes;
            }
            StackEffect::Terminator => {
                // Remaining instructions in this seq are unreachable;
                // any fork-path call there is dead code.
                return false;
            }
            StackEffect::Unknown => {
                // Can't analyze — play safe.
                return true;
            }
        }
    }

    false
}

enum StackEffect {
    Delta { pops: usize, pushes: usize },
    Terminator,
    Unknown,
}

/// Compute the stack effect of a single instruction assuming it is
/// reachable (i.e., not sitting in a polymorphic post-terminator
/// region). Only used by `has_top_level_stack_carryovers`.
fn top_level_stack_effect(module: &Module, local: &LocalFunction, instr: &Instr) -> StackEffect {
    use StackEffect::{Delta, Terminator, Unknown};

    let block_params_results = |seq_id: InstrSeqId| -> (usize, usize) {
        let seq = local.block(seq_id);
        match seq.ty {
            InstrSeqType::Simple(None) => (0, 0),
            InstrSeqType::Simple(Some(_)) => (0, 1),
            InstrSeqType::MultiValue(ty_id) => {
                let t = module.types.get(ty_id);
                (t.params().len(), t.results().len())
            }
        }
    };

    match instr {
        // --- Pure producers (0 → 1) ---
        Instr::Const(_)
        | Instr::LocalGet(_)
        | Instr::GlobalGet(_)
        | Instr::MemorySize(_)
        | Instr::TableSize(_)
        | Instr::RefNull(_)
        | Instr::RefFunc(_) => Delta { pops: 0, pushes: 1 },

        // --- Pure consumers (1 → 0) ---
        Instr::LocalSet(_) | Instr::GlobalSet(_) | Instr::Drop(_) => Delta { pops: 1, pushes: 0 },

        // --- 1 → 1 ---
        Instr::LocalTee(_)
        | Instr::Unop(_)
        | Instr::Load(_)
        | Instr::LoadSimd(_)
        | Instr::MemoryGrow(_)
        | Instr::TableGet(_)
        | Instr::RefIsNull(_)
        | Instr::RefAsNonNull(_)
        | Instr::RefI31(_)
        | Instr::I31GetS(_)
        | Instr::I31GetU(_)
        | Instr::RefTest(_)
        | Instr::RefCast(_)
        | Instr::AnyConvertExtern(_)
        | Instr::ExternConvertAny(_) => Delta { pops: 1, pushes: 1 },

        // --- 2 → 0 ---
        Instr::Store(_) | Instr::TableSet(_) => Delta { pops: 2, pushes: 0 },

        // --- 2 → 1 ---
        Instr::Binop(_)
        | Instr::RefEq(_)
        | Instr::TableGrow(_)
        | Instr::AtomicRmw(_)
        | Instr::AtomicNotify(_)
        | Instr::I8x16Swizzle { .. }
        | Instr::I8x16Shuffle { .. } => Delta { pops: 2, pushes: 1 },

        // --- 3 → 0 ---
        Instr::MemoryFill(_)
        | Instr::MemoryCopy(_)
        | Instr::MemoryInit(_)
        | Instr::TableFill(_)
        | Instr::TableInit(_)
        | Instr::TableCopy(_) => Delta { pops: 3, pushes: 0 },

        // --- 3 → 1 ---
        Instr::TernOp(_)
        | Instr::Select(_)
        | Instr::Cmpxchg(_)
        | Instr::AtomicWait(_)
        | Instr::V128Bitselect { .. } => Delta { pops: 3, pushes: 1 },

        // --- 0 → 0 ---
        Instr::DataDrop(_) | Instr::ElemDrop(_) | Instr::AtomicFence(_) => {
            Delta { pops: 0, pushes: 0 }
        }

        // --- 4 → 2 ---
        Instr::I64Add128 { .. }
        | Instr::I64Sub128 { .. }
        | Instr::I64MulWideS { .. }
        | Instr::I64MulWideU { .. } => Delta { pops: 4, pushes: 2 },

        // --- Partial terminators / branch-with-value-passthrough ---
        // br_if pops its condition; the target's expected args remain
        // on the stack on fall-through, so static delta is just pop 1.
        Instr::BrIf(_) => Delta { pops: 1, pushes: 0 },
        // br_on_null / br_on_non_null / br_on_cast / br_on_cast_fail:
        // all pop 1 ref and push back on the non-branching path.
        Instr::BrOnNull(_)
        | Instr::BrOnNonNull(_)
        | Instr::BrOnCast(_)
        | Instr::BrOnCastFail(_) => Delta { pops: 1, pushes: 1 },

        // --- Nested blocks ---
        Instr::Block(b) => {
            let (p, r) = block_params_results(b.seq);
            Delta { pops: p, pushes: r }
        }
        Instr::Loop(l) => {
            let (p, r) = block_params_results(l.seq);
            Delta { pops: p, pushes: r }
        }
        Instr::IfElse(ie) => {
            let (p, r) = block_params_results(ie.consequent);
            // +1 for the branch condition consumed by `if`.
            Delta {
                pops: p + 1,
                pushes: r,
            }
        }
        Instr::TryTable(t) => {
            let (p, r) = block_params_results(t.seq);
            Delta { pops: p, pushes: r }
        }
        Instr::Try(t) => {
            let (p, r) = block_params_results(t.seq);
            Delta { pops: p, pushes: r }
        }

        // --- Function calls ---
        Instr::Call(c) => {
            let t = module.types.get(module.funcs.get(c.func).ty());
            Delta {
                pops: t.params().len(),
                pushes: t.results().len(),
            }
        }
        Instr::CallIndirect(ci) => {
            let t = module.types.get(ci.ty);
            Delta {
                pops: t.params().len() + 1,
                pushes: t.results().len(),
            }
        }
        Instr::CallRef(cr) => {
            let t = module.types.get(cr.ty);
            Delta {
                pops: t.params().len() + 1,
                pushes: t.results().len(),
            }
        }

        // --- Terminators: stack becomes polymorphic. Remaining instrs
        //     in the same seq are unreachable; stop walking. ---
        Instr::Return(_)
        | Instr::Unreachable(_)
        | Instr::Br(_)
        | Instr::BrTable(_)
        | Instr::ReturnCall(_)
        | Instr::ReturnCallIndirect(_)
        | Instr::ReturnCallRef(_)
        | Instr::Throw(_)
        | Instr::ThrowRef(_)
        | Instr::Rethrow(_) => Terminator,

        // --- Wasm-GC: not produced by our LLVM toolchain today. Report
        //     Unknown so we conservatively force the post-commit-3 panic
        //     path if any ever appears. ---
        Instr::StructNew(_)
        | Instr::StructNewDefault(_)
        | Instr::StructGet(_)
        | Instr::StructGetS(_)
        | Instr::StructGetU(_)
        | Instr::StructSet(_)
        | Instr::ArrayNew(_)
        | Instr::ArrayNewDefault(_)
        | Instr::ArrayNewFixed(_)
        | Instr::ArrayNewData(_)
        | Instr::ArrayNewElem(_)
        | Instr::ArrayGet(_)
        | Instr::ArrayGetS(_)
        | Instr::ArrayGetU(_)
        | Instr::ArraySet(_)
        | Instr::ArrayLen(_)
        | Instr::ArrayFill(_)
        | Instr::ArrayCopy(_)
        | Instr::ArrayInitData(_)
        | Instr::ArrayInitElem(_) => Unknown,
    }
}

fn seq_scalar_result_types(
    module: &Module,
    local: &LocalFunction,
    seq_id: InstrSeqId,
) -> Option<Vec<ValType>> {
    match local.block(seq_id).ty {
        InstrSeqType::Simple(None) => Some(Vec::new()),
        InstrSeqType::Simple(Some(ty)) if is_scalar(ty) => Some(vec![ty]),
        InstrSeqType::Simple(Some(_)) => None,
        InstrSeqType::MultiValue(ty_id) => {
            let results = module.types.get(ty_id).results();
            if results.iter().all(|&ty| is_scalar(ty)) {
                Some(results.to_vec())
            } else {
                None
            }
        }
    }
}

fn push_structured_results(
    stack: &mut Vec<Option<ValType>>,
    module: &Module,
    local: &LocalFunction,
    seq_id: InstrSeqId,
    fallback_pushes: usize,
) {
    match seq_scalar_result_types(module, local, seq_id) {
        Some(types) => {
            for ty in types {
                stack.push(Some(ty));
            }
        }
        None => {
            for _ in 0..fallback_pushes {
                stack.push(None);
            }
        }
    }
}

/// Return the ValType of a `Load` based on its LoadKind. Used by
/// the carryover-type tracker (`compute_carryover_types`).
fn load_pushes(kind: &LoadKind) -> ValType {
    match kind {
        LoadKind::I32 { .. } | LoadKind::I32_8 { .. } | LoadKind::I32_16 { .. } => ValType::I32,
        LoadKind::I64 { .. }
        | LoadKind::I64_8 { .. }
        | LoadKind::I64_16 { .. }
        | LoadKind::I64_32 { .. } => ValType::I64,
        LoadKind::F32 => ValType::F32,
        LoadKind::F64 => ValType::F64,
        LoadKind::V128 => ValType::V128,
    }
}

/// Return the ValType of a Binop based on its BinaryOp.
fn binop_pushes(op: &BinaryOp) -> ValType {
    match op {
        BinaryOp::I32Eq
        | BinaryOp::I32Ne
        | BinaryOp::I32LtS
        | BinaryOp::I32LtU
        | BinaryOp::I32GtS
        | BinaryOp::I32GtU
        | BinaryOp::I32LeS
        | BinaryOp::I32LeU
        | BinaryOp::I32GeS
        | BinaryOp::I32GeU
        | BinaryOp::I64Eq
        | BinaryOp::I64Ne
        | BinaryOp::I64LtS
        | BinaryOp::I64LtU
        | BinaryOp::I64GtS
        | BinaryOp::I64GtU
        | BinaryOp::I64LeS
        | BinaryOp::I64LeU
        | BinaryOp::I64GeS
        | BinaryOp::I64GeU
        | BinaryOp::F32Eq
        | BinaryOp::F32Ne
        | BinaryOp::F32Lt
        | BinaryOp::F32Gt
        | BinaryOp::F32Le
        | BinaryOp::F32Ge
        | BinaryOp::F64Eq
        | BinaryOp::F64Ne
        | BinaryOp::F64Lt
        | BinaryOp::F64Gt
        | BinaryOp::F64Le
        | BinaryOp::F64Ge => ValType::I32,

        BinaryOp::I32Add
        | BinaryOp::I32Sub
        | BinaryOp::I32Mul
        | BinaryOp::I32DivS
        | BinaryOp::I32DivU
        | BinaryOp::I32RemS
        | BinaryOp::I32RemU
        | BinaryOp::I32And
        | BinaryOp::I32Or
        | BinaryOp::I32Xor
        | BinaryOp::I32Shl
        | BinaryOp::I32ShrS
        | BinaryOp::I32ShrU
        | BinaryOp::I32Rotl
        | BinaryOp::I32Rotr => ValType::I32,

        BinaryOp::I64Add
        | BinaryOp::I64Sub
        | BinaryOp::I64Mul
        | BinaryOp::I64DivS
        | BinaryOp::I64DivU
        | BinaryOp::I64RemS
        | BinaryOp::I64RemU
        | BinaryOp::I64And
        | BinaryOp::I64Or
        | BinaryOp::I64Xor
        | BinaryOp::I64Shl
        | BinaryOp::I64ShrS
        | BinaryOp::I64ShrU
        | BinaryOp::I64Rotl
        | BinaryOp::I64Rotr => ValType::I64,

        BinaryOp::F32Add
        | BinaryOp::F32Sub
        | BinaryOp::F32Mul
        | BinaryOp::F32Div
        | BinaryOp::F32Min
        | BinaryOp::F32Max
        | BinaryOp::F32Copysign => ValType::F32,

        BinaryOp::F64Add
        | BinaryOp::F64Sub
        | BinaryOp::F64Mul
        | BinaryOp::F64Div
        | BinaryOp::F64Min
        | BinaryOp::F64Max
        | BinaryOp::F64Copysign => ValType::F64,

        _ => ValType::V128,
    }
}

fn unop_pushes(op: &UnaryOp) -> ValType {
    let s = format!("{op:?}");
    if s.starts_with("I32") || s == "I64Eqz" {
        ValType::I32
    } else if s.starts_with("I64") {
        ValType::I64
    } else if s.starts_with("F32") {
        ValType::F32
    } else if s.starts_with("F64") {
        ValType::F64
    } else if s.starts_with("I8x16ExtractLane")
        || s.starts_with("I16x8ExtractLane")
        || s.starts_with("I32x4ExtractLane")
        || s.contains("AnyTrue")
        || s.contains("AllTrue")
        || s.contains("Bitmask")
    {
        ValType::I32
    } else if s.starts_with("I64x2ExtractLane") {
        ValType::I64
    } else if s.starts_with("F32x4ExtractLane") {
        ValType::F32
    } else if s.starts_with("F64x2ExtractLane") {
        ValType::F64
    } else {
        ValType::V128
    }
}

fn atomic_width_pushes(width: AtomicWidth) -> ValType {
    match width {
        AtomicWidth::I64 | AtomicWidth::I64_8 | AtomicWidth::I64_16 | AtomicWidth::I64_32 => {
            ValType::I64
        }
        AtomicWidth::I32 | AtomicWidth::I32_8 | AtomicWidth::I32_16 => ValType::I32,
    }
}

fn select_pushes(explicit: Option<ValType>, pre_stack: &[Option<ValType>]) -> Option<ValType> {
    if let Some(ty) = explicit {
        return is_scalar(ty).then_some(ty);
    }
    if pre_stack.len() < 3 {
        return None;
    }
    let lhs = pre_stack[pre_stack.len() - 3];
    let rhs = pre_stack[pre_stack.len() - 2];
    match (lhs, rhs) {
        (Some(a), Some(b)) if a == b && is_scalar(a) => Some(a),
        (Some(a), None) if is_scalar(a) => Some(a),
        (None, Some(b)) if is_scalar(b) => Some(b),
        _ => None,
    }
}

fn typed_single_push(
    module: &Module,
    instr: &Instr,
    pre_stack: &[Option<ValType>],
) -> Option<ValType> {
    match instr {
        Instr::Const(c) => match c.value {
            Value::I32(_) => Some(ValType::I32),
            Value::I64(_) => Some(ValType::I64),
            Value::F32(_) => Some(ValType::F32),
            Value::F64(_) => Some(ValType::F64),
            Value::V128(_) => Some(ValType::V128),
        },
        Instr::LocalGet(LocalGet { local: l }) | Instr::LocalTee(LocalTee { local: l }) => {
            Some(module.locals.get(*l).ty())
        }
        Instr::GlobalGet(GlobalGet { global: g }) => Some(module.globals.get(*g).ty),
        Instr::Load(load) => Some(load_pushes(&load.kind)),
        Instr::LoadSimd(_) => Some(ValType::V128),
        Instr::Binop(b) => Some(binop_pushes(&b.op)),
        Instr::Unop(u) => Some(unop_pushes(&u.op)),
        Instr::Select(s) => select_pushes(s.ty, pre_stack),
        Instr::TernOp(_) | Instr::V128Bitselect { .. } => Some(ValType::V128),
        Instr::AtomicRmw(rmw) => Some(atomic_width_pushes(rmw.width)),
        Instr::Cmpxchg(cmpxchg) => Some(atomic_width_pushes(cmpxchg.width)),
        Instr::AtomicNotify(_) | Instr::AtomicWait(_) => Some(ValType::I32),
        Instr::MemorySize(_)
        | Instr::MemoryGrow(_)
        | Instr::TableSize(_)
        | Instr::TableGrow(_)
        | Instr::RefIsNull(_)
        | Instr::RefEq(_)
        | Instr::I31GetS(_)
        | Instr::I31GetU(_) => Some(ValType::I32),
        Instr::I8x16Swizzle { .. } | Instr::I8x16Shuffle { .. } => Some(ValType::V128),
        _ => None,
    }
}

/// Compute the operand-stack carryover types for each top-level
/// fork-path call site in the function.
///
/// A "carryover" is a value pushed onto the operand stack BEFORE the
/// call's args, that remains on the stack across the call and is
/// consumed AFTER the call returns. For a call site whose signature
/// has `m` args, if the operand-stack depth at the call is `m + n`,
/// the bottom `n` slots are carryovers.
///
/// Returns:
/// - `Some(per_call_carryovers)` where `per_call_carryovers[K]` is the
///   list of carryover ValTypes (deepest stack slot first) at call K.
///   Empty vec if call K has no carryover.
/// - `None` if any producer instruction pushes a value of a type we
///   can't statically determine AND that value ends up in a carryover.
///   Post-commit-3, caller panics in this case — sub-commit 9-followup's
///   `Vec<Option<ValType>>` refinement made the analyser succeed for
///   any shape whose unknown slots are consumed before a fork-path
///   call's carryover, so `None` should be vanishingly rare in
///   shipping wasm. If it does fire, the panic message names the
///   function so the specific producer can be added to the typed-
///   producer list.
///
/// Statically-typed producers handled here:
///   `Const`, `LocalGet`, `LocalTee`, `GlobalGet`, `Load` (all kinds),
///   `Binop` (encoded by op-name prefix), direct `Call` (signature
///   results), `MemorySize`/`TableSize` (i32). Anything else triggers
///   `None`.
///
/// Used by `instrument_one_function`'s dispatch decision: if this
/// returns Some, switch-dispatch can absorb the carryover by spilling
/// to per-call carryover locals (Option B from the
/// 2026-05-13 plan, decided 2026-05-14).
fn compute_carryover_types(
    module: &Module,
    func_id: FunctionId,
    fork_path: &HashSet<FunctionId>,
) -> Option<Vec<Vec<ValType>>> {
    let local = match &module.funcs.get(func_id).kind {
        FunctionKind::Local(l) => l,
        _ => return Some(Vec::new()),
    };
    let entry = local.entry_block();

    // Typed operand stack — bottom-to-top. Sub-commit 9-followup
    // (2026-05-14): tracked as `Vec<Option<ValType>>` so unknown
    // producers (ref-typed producers, non-fork-path CallIndirect/
    // CallRef, ref-typed structured-control results) push `None`
    // without aborting. Failure is only triggered when a `None` slot
    // ends up in a fork-path call's carryover. This mirrors
    // `walk_seq_for_carryovers`'s 2.5c policy and closes the
    // second `instrument_one_function_guard_dispatch` caller in
    // `instrument_one_function` (since deleted by commit 4) for the
    // case where a top-level fork-path call HAS no carryover but
    // the function body still contains unknown-type producers
    // consumed before the call.
    let mut stack: Vec<Option<ValType>> = Vec::new();
    let mut carryovers: Vec<Vec<ValType>> = Vec::new();

    fn snapshot(slots: &[Option<ValType>]) -> Option<Vec<ValType>> {
        slots.iter().copied().collect::<Option<Vec<ValType>>>()
    }

    for (instr, _) in &local.block(entry).instrs {
        // Calls first — they're the partition points.
        match instr {
            Instr::Call(c) if fork_path.contains(&c.func) => {
                let sig = module.types.get(module.funcs.get(c.func).ty());
                let n_args = sig.params().len();
                if stack.len() < n_args {
                    return None; // ill-formed
                }
                let n_cr = stack.len() - n_args;
                carryovers.push(snapshot(&stack[..n_cr])?);
                stack.truncate(n_cr);
                for &ty in sig.results() {
                    stack.push(Some(ty));
                }
                continue;
            }
            Instr::CallIndirect(ci) => {
                let sig = module.types.get(ci.ty);
                let n_args = sig.params().len() + 1; // +1 for table index
                if stack.len() < n_args {
                    return None;
                }
                let n_cr = stack.len() - n_args;
                carryovers.push(snapshot(&stack[..n_cr])?);
                stack.truncate(n_cr);
                for &ty in sig.results() {
                    stack.push(Some(ty));
                }
                continue;
            }
            _ => {}
        }

        // Use existing stack-effect logic for pop count.
        match top_level_stack_effect(module, local, instr) {
            StackEffect::Delta { pops, pushes } => {
                if stack.len() < pops {
                    return None;
                }
                let pre_stack = stack.clone();
                stack.truncate(stack.len() - pops);
                if pushes == 0 {
                    continue;
                }
                // Determine pushed type(s). Multi-push instructions
                // are only Call / CallIndirect / CallRef; non-fork-
                // path indirect calls go through here as `None` slots
                // (the conservative `return None` from the legacy
                // code only fired AFTER pops had already happened, so
                // emitting None preserves stack-depth accounting).
                match instr {
                    Instr::Call(c) => {
                        let sig = module.types.get(module.funcs.get(c.func).ty());
                        for &ty in sig.results() {
                            stack.push(Some(ty));
                        }
                        continue;
                    }
                    Instr::CallIndirect(ci) => {
                        let sig = module.types.get(ci.ty);
                        for _ in sig.results() {
                            stack.push(None);
                        }
                        continue;
                    }
                    Instr::CallRef(cr) => {
                        let sig = module.types.get(cr.ty);
                        for _ in sig.results() {
                            stack.push(None);
                        }
                        continue;
                    }
                    Instr::Block(b) => {
                        push_structured_results(&mut stack, module, local, b.seq, pushes);
                        continue;
                    }
                    Instr::Loop(l) => {
                        push_structured_results(&mut stack, module, local, l.seq, pushes);
                        continue;
                    }
                    Instr::IfElse(ie) => {
                        push_structured_results(&mut stack, module, local, ie.consequent, pushes);
                        continue;
                    }
                    Instr::TryTable(t) => {
                        push_structured_results(&mut stack, module, local, t.seq, pushes);
                        continue;
                    }
                    Instr::Try(t) => {
                        push_structured_results(&mut stack, module, local, t.seq, pushes);
                        continue;
                    }
                    _ => {}
                }
                // Single-push, non-call, non-structured-control
                // producers.
                debug_assert_eq!(pushes, 1, "multi-push non-Call should not appear");
                stack.push(typed_single_push(module, instr, &pre_stack));
            }
            StackEffect::Terminator => {
                // Post-terminator code in the same seq is unreachable
                // but `partition_body` still walks it, so we need to
                // emit a carryover entry for any dead-code fork-path
                // Call / CallIndirect to keep our counts consistent.
                // Dead-code calls have no defined operand-stack state,
                // so report empty carryovers for each.
                let remaining = local
                    .block(entry)
                    .instrs
                    .iter()
                    .skip_while(|(i, _)| !std::ptr::eq(i, instr))
                    .skip(1); // skip the Terminator itself
                for (i, _) in remaining {
                    match i {
                        Instr::Call(c) if fork_path.contains(&c.func) => {
                            carryovers.push(Vec::new());
                        }
                        Instr::CallIndirect(_) => {
                            carryovers.push(Vec::new());
                        }
                        _ => {}
                    }
                }
                break;
            }
            StackEffect::Unknown => return None,
        }
    }

    Some(carryovers)
}

/// Like `compute_carryover_types` but for nested switch-dispatch:
/// covers fork-path call landings inside ANY fork-bearing seq in the
/// function, not just the top-level entry body.
///
/// Each seq is walked independently with a fresh, initially-empty
/// typed operand stack. Block/Loop/IfElse/TryTable instructions
/// encountered during a walk are treated as opaque at their parent
/// level: they contribute only their declared type-params/results to
/// the parent seq's stack depth. Their bodies are walked separately
/// when they appear as fork-bearing seqs of their own (i.e., when
/// they directly contain a fork-path Call/CallIndirect).
///
/// Returns a map keyed by `call_idx` — the call ordinal assigned by
/// `discover_calls_and_regions` in DFS order. Each value is the list
/// of carryover ValTypes (deepest stack slot first) for that call
/// site; an empty vec means the call has no carryover.
///
/// Returns `None` if any producer instruction in any walked seq
/// pushes a value whose type can't be determined statically (e.g. a
/// non-fork-path `CallIndirect` / `CallRef`, a wasm-GC ref, a
/// multi-value or ref-typed `Block`/`Loop`/`IfElse`/`TryTable`
/// result). The caller (sub-commit 2.5c) keeps the existing rejection
/// in `seq_has_unsupported_carryover` for the `None` case.
fn compute_nested_carryover_types(
    module: &Module,
    func_id: FunctionId,
    fork_path: &HashSet<FunctionId>,
) -> Option<HashMap<u32, Vec<ValType>>> {
    let local = match &module.funcs.get(func_id).kind {
        FunctionKind::Local(l) => l,
        _ => return Some(HashMap::new()),
    };

    let (sites, _regions) = discover_calls_and_regions(module, func_id, fork_path);
    if sites.is_empty() {
        return Some(HashMap::new());
    }

    // Group call_idxs by the seq that directly contains them. DFS-order
    // assignment in `discover_calls_and_regions` guarantees the per-seq
    // call_idxs are in source-order — matching the order
    // `walk_seq_for_carryovers` produces below.
    let mut direct_idxs_per_seq: HashMap<InstrSeqId, Vec<u32>> = HashMap::new();
    for site in &sites {
        direct_idxs_per_seq
            .entry(site.seq_id)
            .or_default()
            .push(site.call_idx);
    }

    let mut result: HashMap<u32, Vec<ValType>> = HashMap::new();
    for (&seq_id, direct_idxs) in &direct_idxs_per_seq {
        let per_seq = walk_seq_for_carryovers(module, local, seq_id, fork_path)?;
        if per_seq.len() != direct_idxs.len() {
            // Mismatch implies the walk terminated early (e.g., hit a
            // terminator before the last fork-path call). Conservative
            // fallback: report unanalyzable.
            return None;
        }
        for (cr, &idx) in per_seq.into_iter().zip(direct_idxs.iter()) {
            result.insert(idx, cr);
        }
    }

    Some(result)
}

/// Walk a single seq's top-level instructions and compute the
/// carryover types at each direct fork-path landing (`Call` to a
/// fork-path callee or `CallIndirect`). Block/Loop/IfElse/TryTable
/// instructions are treated as opaque — see
/// `compute_nested_carryover_types`.
///
/// Stack values are tracked as `Option<ValType>`: producers we can
/// type statically push `Some(ty)`; producers we can't scalar-spill
/// (e.g. ref-typed producers or non-fork-path CallRef results) push
/// `None`.
/// `None` slots are tolerated as long as they're consumed before
/// the next fork-path call; only `None` slots that end up IN A
/// carryover force `walk_seq_for_carryovers` to fail conservatively
/// (returning `None`). This makes the analyser succeed for any
/// fork-bearing seq with no carryover at all, regardless of the
/// producer instructions it contains.
fn walk_seq_for_carryovers(
    module: &Module,
    f: &LocalFunction,
    seq: InstrSeqId,
    fork_path: &HashSet<FunctionId>,
) -> Option<Vec<Vec<ValType>>> {
    // Sub-commit 2.6c: nested seqs with declared type-params enter
    // with those values already on the local stack (the body's inputs).
    // Initialise the typed stack accordingly so the walker doesn't
    // underflow on the first op that consumes them.
    let mut stack: Vec<Option<ValType>> = match f.block(seq).ty {
        InstrSeqType::MultiValue(ty_id) => module
            .types
            .get(ty_id)
            .params()
            .iter()
            .map(|&t| Some(t))
            .collect(),
        _ => Vec::new(),
    };
    let mut carryovers: Vec<Vec<ValType>> = Vec::new();

    // Helper: materialise the typed-carryover slice. Returns None if
    // any `None` slot would be captured.
    fn snapshot_carryover(slots: &[Option<ValType>]) -> Option<Vec<ValType>> {
        slots.iter().copied().collect::<Option<Vec<ValType>>>()
    }

    for (instr, _) in &f.block(seq).instrs {
        // Fork-path call landings — the partition points.
        match instr {
            Instr::Call(c) if fork_path.contains(&c.func) => {
                let sig = module.types.get(module.funcs.get(c.func).ty());
                let n_args = sig.params().len();
                if stack.len() < n_args {
                    return None;
                }
                let n_cr = stack.len() - n_args;
                carryovers.push(snapshot_carryover(&stack[..n_cr])?);
                stack.truncate(n_cr);
                for &ty in sig.results() {
                    stack.push(Some(ty));
                }
                continue;
            }
            Instr::CallIndirect(ci) => {
                let sig = module.types.get(ci.ty);
                let n_args = sig.params().len() + 1; // +1 table index
                if stack.len() < n_args {
                    return None;
                }
                let n_cr = stack.len() - n_args;
                carryovers.push(snapshot_carryover(&stack[..n_cr])?);
                stack.truncate(n_cr);
                for &ty in sig.results() {
                    stack.push(Some(ty));
                }
                continue;
            }
            _ => {}
        }

        match top_level_stack_effect(module, f, instr) {
            StackEffect::Delta { pops, pushes } => {
                if stack.len() < pops {
                    return None;
                }
                let pre_stack = stack.clone();
                stack.truncate(stack.len() - pops);
                if pushes == 0 {
                    continue;
                }
                // Determine pushed type(s). Multi-push instructions are
                // only Call / CallIndirect / CallRef and structured
                // control flow with a multi-value result. We type the
                // single-result cases precisely; everything else
                // contributes `None` slots so the seq can still proceed
                // as long as the unknown slot is consumed before any
                // carryover snapshot.
                match instr {
                    Instr::Call(c) => {
                        let sig = module.types.get(module.funcs.get(c.func).ty());
                        for &ty in sig.results() {
                            stack.push(Some(ty));
                        }
                        continue;
                    }
                    Instr::CallIndirect(ci) => {
                        // Non-fork-path CallIndirect (fork-path is
                        // handled above). Unknown ref-typed result?
                        // Push None slots — caller may or may not
                        // observe them as a carryover.
                        let sig = module.types.get(ci.ty);
                        for _ in sig.results() {
                            stack.push(None);
                        }
                        continue;
                    }
                    Instr::CallRef(cr) => {
                        let sig = module.types.get(cr.ty);
                        for _ in sig.results() {
                            stack.push(None);
                        }
                        continue;
                    }
                    Instr::Block(b) => {
                        push_structured_results(&mut stack, module, f, b.seq, pushes);
                        continue;
                    }
                    Instr::Loop(l) => {
                        push_structured_results(&mut stack, module, f, l.seq, pushes);
                        continue;
                    }
                    Instr::IfElse(ie) => {
                        push_structured_results(&mut stack, module, f, ie.consequent, pushes);
                        continue;
                    }
                    Instr::TryTable(t) => {
                        push_structured_results(&mut stack, module, f, t.seq, pushes);
                        continue;
                    }
                    Instr::Try(t) => {
                        push_structured_results(&mut stack, module, f, t.seq, pushes);
                        continue;
                    }
                    _ => {}
                }
                // Single-push, non-call, non-block-typed producers.
                debug_assert_eq!(
                    pushes, 1,
                    "multi-push non-call/non-structured-control should not reach here"
                );
                stack.push(typed_single_push(module, instr, &pre_stack));
            }
            StackEffect::Terminator => {
                // Post-terminator code in this seq is unreachable.
                // Don't push further carryover entries; the per-seq
                // call_idx list will mismatch in `compute_nested_*`
                // and force a conservative `None`. (Reachable fork-
                // path calls before the terminator are already in
                // `carryovers`.)
                return Some(carryovers);
            }
            StackEffect::Unknown => return None,
        }
    }

    Some(carryovers)
}

/// Split the original entry body at top-level fork-path calls.
///
/// Returns `(chunks, call_sites)`:
/// - `chunks[K]` is the run of instructions before call K (or, for
///   `K = n_calls`, the tail after the last call).
/// - `call_sites[K]` describes call K's dispatch target and signature.
///
/// Invariants:
/// - `chunks.len() == call_sites.len() + 1`.
/// - All instructions from the original body are either in a chunk or
///   consumed as a call-site head.
fn partition_body(
    original: &[(Instr, InstrLocId)],
    fork_path: &HashSet<FunctionId>,
    module: &Module,
) -> (Vec<Vec<(Instr, InstrLocId)>>, Vec<CallSiteInfo>) {
    let mut chunks: Vec<Vec<(Instr, InstrLocId)>> = vec![Vec::new()];
    let mut calls: Vec<CallSiteInfo> = Vec::new();

    for (instr, loc) in original.iter() {
        match instr {
            Instr::Call(c) if fork_path.contains(&c.func) => {
                let sig_ty = module.funcs.get(c.func).ty();
                calls.push(CallSiteInfo {
                    target: CallTarget::Direct(c.func),
                    sig_ty,
                    loc: *loc,
                });
                chunks.push(Vec::new());
            }
            Instr::CallIndirect(ci) => {
                calls.push(CallSiteInfo {
                    target: CallTarget::Indirect { table: ci.table },
                    sig_ty: ci.ty,
                    loc: *loc,
                });
                chunks.push(Vec::new());
            }
            _ => {
                chunks
                    .last_mut()
                    .expect("chunks always has at least one entry")
                    .push((instr.clone(), *loc));
            }
        }
    }
    (chunks, calls)
}

fn call_arg_types(module: &Module, cs: &CallSiteInfo) -> Vec<ValType> {
    let params = module.types.get(cs.sig_ty).params().to_vec();
    let mut arg_types = params;
    if matches!(cs.target, CallTarget::Indirect { .. }) {
        arg_types.push(ValType::I32);
    }
    arg_types
}

#[derive(Debug, Clone)]
enum PendingCallArgMaterialization {
    Spill {
        arg_types: Vec<ValType>,
    },
    PureTail {
        tail: Vec<(Instr, InstrLocId)>,
        tail_len: usize,
    },
}

#[derive(Debug, Clone)]
enum CallArgMaterialization {
    Spill {
        locals: Vec<LocalId>,
    },
    PureTail {
        tail: Vec<(Instr, InstrLocId)>,
        tail_len: usize,
    },
}

impl CallArgMaterialization {
    fn spill_locals(&self) -> &[LocalId] {
        match self {
            Self::Spill { locals } => locals,
            Self::PureTail { .. } => &[],
        }
    }

    fn tail_len(&self) -> usize {
        match self {
            Self::Spill { .. } => 0,
            Self::PureTail { tail_len, .. } => *tail_len,
        }
    }
}

fn plan_call_arg_materialization(
    module: &Module,
    chunk: &[(Instr, InstrLocId)],
    arg_types: Vec<ValType>,
) -> PendingCallArgMaterialization {
    if let Some((tail_len, tail)) = split_pure_scalar_tail(module, chunk, &arg_types) {
        PendingCallArgMaterialization::PureTail { tail, tail_len }
    } else {
        PendingCallArgMaterialization::Spill { arg_types }
    }
}

fn allocate_call_arg_materialization(
    module: &mut Module,
    pending: PendingCallArgMaterialization,
) -> CallArgMaterialization {
    match pending {
        PendingCallArgMaterialization::Spill { arg_types } => {
            let locals = arg_types.iter().map(|&ty| module.locals.add(ty)).collect();
            CallArgMaterialization::Spill { locals }
        }
        PendingCallArgMaterialization::PureTail { tail, tail_len } => {
            CallArgMaterialization::PureTail { tail, tail_len }
        }
    }
}

fn truncate_materialized_tail(chunk: &mut Vec<(Instr, InstrLocId)>, tail_len: usize) {
    if tail_len == 0 {
        return;
    }
    debug_assert!(chunk.len() >= tail_len);
    chunk.truncate(chunk.len() - tail_len);
}

fn split_pure_scalar_tail(
    module: &Module,
    chunk: &[(Instr, InstrLocId)],
    expected_outputs: &[ValType],
) -> Option<(usize, Vec<(Instr, InstrLocId)>)> {
    if expected_outputs.is_empty() {
        return None;
    }

    for start in 0..chunk.len() {
        let tail = &chunk[start..];
        if let Some(outputs) = pure_scalar_tail_outputs(module, tail) {
            if outputs == expected_outputs {
                return Some((tail.len(), tail.to_vec()));
            }
        }
    }

    None
}

fn pure_scalar_tail_outputs(module: &Module, tail: &[(Instr, InstrLocId)]) -> Option<Vec<ValType>> {
    let mut stack: Vec<ValType> = Vec::new();
    for (instr, _) in tail {
        match instr {
            Instr::Const(c) => stack.push(pure_const_type(c)?),
            Instr::LocalGet(LocalGet { local }) => {
                let ty = module.locals.get(*local).ty();
                if !is_scalar(ty) {
                    return None;
                }
                stack.push(ty);
            }
            Instr::Unop(u) => {
                let (input, output) = pure_unop_signature(u.op)?;
                pop_exact_types(&mut stack, &[input])?;
                stack.push(output);
            }
            Instr::Binop(b) => {
                let (lhs, rhs, output) = pure_binop_signature(b.op)?;
                pop_exact_types(&mut stack, &[lhs, rhs])?;
                stack.push(output);
            }
            _ => return None,
        }
    }
    Some(stack)
}

fn pure_const_type(c: &Const) -> Option<ValType> {
    match c.value {
        Value::I32(_) => Some(ValType::I32),
        Value::I64(_) => Some(ValType::I64),
        Value::F32(_) => Some(ValType::F32),
        Value::F64(_) => Some(ValType::F64),
        Value::V128(_) => None,
    }
}

fn pop_exact_types(stack: &mut Vec<ValType>, expected: &[ValType]) -> Option<()> {
    if stack.len() < expected.len() {
        return None;
    }
    let start = stack.len() - expected.len();
    if &stack[start..] != expected {
        return None;
    }
    stack.truncate(start);
    Some(())
}

fn pure_unop_signature(op: UnaryOp) -> Option<(ValType, ValType)> {
    match op {
        UnaryOp::I32Eqz | UnaryOp::I32Clz | UnaryOp::I32Ctz | UnaryOp::I32Popcnt => {
            Some((ValType::I32, ValType::I32))
        }
        UnaryOp::I64Eqz => Some((ValType::I64, ValType::I32)),
        UnaryOp::I64Clz | UnaryOp::I64Ctz | UnaryOp::I64Popcnt => {
            Some((ValType::I64, ValType::I64))
        }
        UnaryOp::I32WrapI64 => Some((ValType::I64, ValType::I32)),
        UnaryOp::I64ExtendSI32 | UnaryOp::I64ExtendUI32 => Some((ValType::I32, ValType::I64)),
        UnaryOp::I32Extend8S | UnaryOp::I32Extend16S => Some((ValType::I32, ValType::I32)),
        UnaryOp::I64Extend8S | UnaryOp::I64Extend16S | UnaryOp::I64Extend32S => {
            Some((ValType::I64, ValType::I64))
        }
        _ => None,
    }
}

fn pure_binop_signature(op: BinaryOp) -> Option<(ValType, ValType, ValType)> {
    match op {
        BinaryOp::I32Eq
        | BinaryOp::I32Ne
        | BinaryOp::I32LtS
        | BinaryOp::I32LtU
        | BinaryOp::I32GtS
        | BinaryOp::I32GtU
        | BinaryOp::I32LeS
        | BinaryOp::I32LeU
        | BinaryOp::I32GeS
        | BinaryOp::I32GeU => Some((ValType::I32, ValType::I32, ValType::I32)),
        BinaryOp::I64Eq
        | BinaryOp::I64Ne
        | BinaryOp::I64LtS
        | BinaryOp::I64LtU
        | BinaryOp::I64GtS
        | BinaryOp::I64GtU
        | BinaryOp::I64LeS
        | BinaryOp::I64LeU
        | BinaryOp::I64GeS
        | BinaryOp::I64GeU => Some((ValType::I64, ValType::I64, ValType::I32)),
        BinaryOp::I32Add
        | BinaryOp::I32Sub
        | BinaryOp::I32Mul
        | BinaryOp::I32And
        | BinaryOp::I32Or
        | BinaryOp::I32Xor
        | BinaryOp::I32Shl
        | BinaryOp::I32ShrS
        | BinaryOp::I32ShrU
        | BinaryOp::I32Rotl
        | BinaryOp::I32Rotr => Some((ValType::I32, ValType::I32, ValType::I32)),
        BinaryOp::I64Add
        | BinaryOp::I64Sub
        | BinaryOp::I64Mul
        | BinaryOp::I64And
        | BinaryOp::I64Or
        | BinaryOp::I64Xor
        | BinaryOp::I64Shl
        | BinaryOp::I64ShrS
        | BinaryOp::I64ShrU
        | BinaryOp::I64Rotl
        | BinaryOp::I64Rotr => Some((ValType::I64, ValType::I64, ValType::I64)),
        _ => None,
    }
}

// ----------------------------------------------------------------------
// Dispatch-structure emission
// ----------------------------------------------------------------------

/// Leaf size for the recursive bucketed dispatch. Each leaf handles at
/// most this many fork-path call sites; deeper levels recurse with the
/// same bucket size. With `BUCKET_SIZE = 32`, depth stays bounded for
/// production binaries with thousands of fork-path calls per dispatcher (see
/// `docs/plans/2026-06-05-fork-instrument-recursive-bucketing-plan.md`).
pub const BUCKET_SIZE: usize = 32;

/// Static partition of `[0, n_calls)` into buckets handled by the
/// recursive dispatch. Built before any IR emission so the topology
/// (depths, span constants, child counts) is known up front and the
/// emit step can recurse without surprises.
///
/// Invariants:
/// - `Leaf { start, end }` covers `end - start` consecutive call sites,
///   with `1 <= end - start <= BUCKET_SIZE`. The leaf inherits the
///   single-leaf emission shape from `emit_leaf_dispatch`.
/// - `Internal { children, span_per_child }` partitions a contiguous
///   call-site range into `children.len()` consecutive sub-ranges, each
///   of length `span_per_child` except possibly the last (which may be
///   smaller). `span_per_child` is a power of `BUCKET_SIZE` baked into
///   the dispatch wat as an i32 divisor at emit time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DispatchTree {
    Leaf {
        start: usize,
        end: usize,
    },
    Internal {
        children: Vec<DispatchTree>,
        span_per_child: usize,
    },
}

impl DispatchTree {
    /// Maximum walker depth this subtree contributes, measured the same
    /// way as `tests/large_dispatcher.rs::max_nesting_depth`: every
    /// `Block`/`Loop`/`IfElse`/`TryTable` walked into adds one level.
    ///
    /// For a leaf placed at the function root (its outermost block is
    /// the function-level `$unwind_save`), this yields the absolute
    /// walker depth at the deepest IfElse consequent inside the
    /// dispatch. For a subtree nested inside an internal node's
    /// `$child_K` slot, the same value still bounds the subtree's
    /// internal depth — the surrounding `$child_K` blocks of the
    /// parent are accounted for in the parent's own `max_depth`.
    ///
    /// Recurrence:
    /// - Leaf with `n` calls: `n + 3` (one block per `$POST_K`, plus
    ///   `$unwind_save`, `$dispatch_normal`, and the REWIND IfElse
    ///   consequent).
    /// - Internal with `B` children: the deepest path runs either
    ///   through the dispatch IfElse (`$node_exit` → `$child_*` chain
    ///   → `$node_dispatch` → IfElse, depth `B + 3`) or through a
    ///   child. Child K sits at `$child_K` which is opened at walker
    ///   depth `B - K + 1` from `$node_exit`; the child's own
    ///   emission shares that block as its outermost, contributing
    ///   `max_depth(C_K) - 1` further levels on top. So child K's
    ///   contribution is `B - K + max_depth(C_K)`. Because
    ///   `$child_0` sits at the deepest slot (depth `B + 1`), child 0
    ///   typically dominates for balanced subtrees; the max formula
    ///   stays safe for any partition.
    ///
    /// Used by `tests/dispatch_tree.rs` to verify the
    /// `O(M · log_M(N))` depth invariant.
    pub fn max_depth(&self) -> usize {
        match self {
            DispatchTree::Leaf { start, end } => (end - start) + 3,
            DispatchTree::Internal { children, .. } => {
                let b = children.len();
                let deepest_child_path = children
                    .iter()
                    .enumerate()
                    .map(|(k, c)| (b - k) + c.max_depth())
                    .max()
                    .expect("Internal node must have at least one child");
                deepest_child_path.max(b + 3)
            }
        }
    }

    /// First call-site index covered by this subtree.
    pub fn start(&self) -> usize {
        match self {
            DispatchTree::Leaf { start, .. } => *start,
            DispatchTree::Internal { children, .. } => {
                children.first().expect("non-empty Internal").start()
            }
        }
    }

    /// One past the last call-site index covered by this subtree.
    pub fn end(&self) -> usize {
        match self {
            DispatchTree::Leaf { end, .. } => *end,
            DispatchTree::Internal { children, .. } => {
                children.last().expect("non-empty Internal").end()
            }
        }
    }
}

/// Partition `[0, n_calls)` into a balanced dispatch tree with leaf
/// bucket size `bucket_size`.
///
/// - `n_calls == 0` → returns the degenerate empty leaf `Leaf { 0, 0 }`.
///   The caller (`populate_dispatch_structure`) handles the zero-call
///   case directly and never asks for the tree, but the constructor
///   stays total to keep property tests simple.
/// - `n_calls <= bucket_size` → a single `Leaf { 0, n_calls }`. **No
///   diff from the pre-bucketing single-leaf code path**: existing
///   binaries (almost all real cases) emit the exact same IR.
/// - Otherwise → an `Internal` whose `span_per_child` is the largest
///   power of `bucket_size` that is strictly less than `n_calls`, with
///   children built recursively over each sub-range.
pub fn build_dispatch_tree(n_calls: usize, bucket_size: usize) -> DispatchTree {
    assert!(bucket_size >= 2, "bucket_size must be >= 2");

    if n_calls <= bucket_size {
        return DispatchTree::Leaf {
            start: 0,
            end: n_calls,
        };
    }
    build_dispatch_tree_range(0, n_calls, bucket_size)
}

/// Recursive workhorse for `build_dispatch_tree`. Partitions
/// `[start, end)` with `start < end` into a tree node, choosing the
/// largest power-of-`bucket_size` span that still yields at least two
/// children.
fn build_dispatch_tree_range(start: usize, end: usize, bucket_size: usize) -> DispatchTree {
    debug_assert!(start < end);
    let n = end - start;
    if n <= bucket_size {
        return DispatchTree::Leaf { start, end };
    }

    // Find the largest power of `bucket_size` that is < n. This is the
    // span of each child except possibly the last. For n in (M, M^2],
    // span = M; for n in (M^2, M^3], span = M^2; etc.
    let mut span: usize = bucket_size;
    while span
        .checked_mul(bucket_size)
        .map(|next| next < n)
        .unwrap_or(false)
    {
        span *= bucket_size;
    }

    let mut children = Vec::new();
    let mut cursor = start;
    while cursor < end {
        let child_end = (cursor + span).min(end);
        children.push(build_dispatch_tree_range(cursor, child_end, bucket_size));
        cursor = child_end;
    }

    DispatchTree::Internal {
        children,
        span_per_child: span,
    }
}

/// On REWIND, br_table to `post_seqs_slice[call_idx - range_start]`.
/// `range_start == 0` elides the subtraction so a single-leaf
/// tree emits byte-identical IR to the pre-bucketing code.
fn populate_dispatch_normal(
    local: &mut LocalFunction,
    dispatch_normal: InstrSeqId,
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    post_seqs_slice: &[InstrSeqId],
    range_start: usize,
    default_target: InstrSeqId,
) {
    let if_then = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();
    let if_else = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();

    {
        let s = &mut local.block_mut(if_then).instrs;
        push_current_call_index(s, runtime, memory, ptr_ty);
        if range_start != 0 {
            push_instr(
                s,
                Instr::Const(Const {
                    value: Value::I32(range_start as i32),
                }),
            );
            push_instr(
                s,
                Instr::Binop(Binop {
                    op: BinaryOp::I32Sub,
                }),
            );
        }
        push_instr(
            s,
            Instr::BrTable(BrTable {
                blocks: post_seqs_slice.to_vec().into_boxed_slice(),
                default: default_target,
            }),
        );
    }

    let s = &mut local.block_mut(dispatch_normal).instrs;
    push_instr(
        s,
        Instr::GlobalGet(GlobalGet {
            global: runtime.state_global,
        }),
    );
    push_instr(
        s,
        Instr::Const(Const {
            value: Value::I32(runtime::STATE_REWINDING),
        }),
    );
    push_instr(
        s,
        Instr::Binop(Binop {
            op: BinaryOp::I32Eq,
        }),
    );
    push_instr(
        s,
        Instr::IfElse(IfElse {
            consequent: if_then,
            alternative: if_else,
        }),
    );
}

/// On REWIND, br_table to `child_seqs[(call_idx - range_start) /
/// span_per_child]`. `span_per_child` is always a power of
/// `BUCKET_SIZE` by construction, so the division is exact at every
/// bucket boundary.
fn populate_internal_dispatch(
    local: &mut LocalFunction,
    node_dispatch: InstrSeqId,
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    child_seqs: &[InstrSeqId],
    range_start: usize,
    span_per_child: usize,
    default_target: InstrSeqId,
) {
    let if_then = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();
    let if_else = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();

    {
        let s = &mut local.block_mut(if_then).instrs;
        push_current_call_index(s, runtime, memory, ptr_ty);
        if range_start != 0 {
            push_instr(
                s,
                Instr::Const(Const {
                    value: Value::I32(range_start as i32),
                }),
            );
            push_instr(
                s,
                Instr::Binop(Binop {
                    op: BinaryOp::I32Sub,
                }),
            );
        }
        push_instr(
            s,
            Instr::Const(Const {
                value: Value::I32(span_per_child as i32),
            }),
        );
        push_instr(
            s,
            Instr::Binop(Binop {
                op: BinaryOp::I32DivU,
            }),
        );
        push_instr(
            s,
            Instr::BrTable(BrTable {
                blocks: child_seqs.to_vec().into_boxed_slice(),
                default: default_target,
            }),
        );
    }

    let s = &mut local.block_mut(node_dispatch).instrs;
    push_instr(
        s,
        Instr::GlobalGet(GlobalGet {
            global: runtime.state_global,
        }),
    );
    push_instr(
        s,
        Instr::Const(Const {
            value: Value::I32(runtime::STATE_REWINDING),
        }),
    );
    push_instr(
        s,
        Instr::Binop(Binop {
            op: BinaryOp::I32Eq,
        }),
    );
    push_instr(
        s,
        Instr::IfElse(IfElse {
            consequent: if_then,
            alternative: if_else,
        }),
    );
}

/// Walks a `DispatchTree` built over `n_calls` and emits the bucketed
/// dispatch IR into `unwind_save`. For `n_calls <= BUCKET_SIZE` this
/// degenerates to a single leaf matching the pre-bucketing shape.
#[allow(clippy::too_many_arguments)]
fn populate_dispatch_structure(
    local: &mut LocalFunction,
    unwind_save: InstrSeqId,
    post_seqs: &[InstrSeqId],
    chunks: &[Vec<(Instr, InstrLocId)>],
    call_sites: &[CallSiteInfo],
    arg_materializations: &[CallArgMaterialization],
    carryover_spills: &[Vec<LocalId>],
    catch_handlers: &[CatchHandlerInfo],
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    catch_state_locals: Option<CatchStateLocals>,
) {
    let n_calls = call_sites.len();

    // Zero calls: the dispatch degenerates to the original body
    // followed by `return`. Should not normally happen for a
    // fork-path function, but keep it validator-clean.
    if n_calls == 0 {
        let s = &mut local.block_mut(unwind_save).instrs;
        for (instr, loc) in &chunks[0] {
            s.push((instr.clone(), *loc));
        }
        push_instr(s, Instr::Return(Return {}));
        return;
    }

    let tree = build_dispatch_tree(n_calls, BUCKET_SIZE);
    emit_dispatch_node(
        local,
        &tree,
        unwind_save,
        unwind_save,
        true,
        post_seqs,
        chunks,
        call_sites,
        arg_materializations,
        carryover_spills,
        catch_handlers,
        runtime,
        memory,
        ptr_ty,
        catch_state_locals,
    );
}

/// Recursive dispatcher over a `DispatchTree` node. Routes leaves to
/// `emit_leaf_dispatch` and internal nodes to `emit_internal_dispatch`,
/// threading the function-level `$unwind_save` through every level so
/// UNWIND propagations always escape the entire tree in a single `br`.
#[allow(clippy::too_many_arguments)]
fn emit_dispatch_node(
    local: &mut LocalFunction,
    node: &DispatchTree,
    exit_seq: InstrSeqId,
    function_unwind_save: InstrSeqId,
    is_last_overall: bool,
    post_seqs: &[InstrSeqId],
    chunks: &[Vec<(Instr, InstrLocId)>],
    call_sites: &[CallSiteInfo],
    arg_materializations: &[CallArgMaterialization],
    carryover_spills: &[Vec<LocalId>],
    catch_handlers: &[CatchHandlerInfo],
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    catch_state_locals: Option<CatchStateLocals>,
) {
    match node {
        DispatchTree::Leaf { start, end } => emit_leaf_dispatch(
            local,
            exit_seq,
            function_unwind_save,
            *start,
            *end,
            is_last_overall,
            post_seqs,
            chunks,
            call_sites,
            arg_materializations,
            carryover_spills,
            catch_handlers,
            runtime,
            memory,
            ptr_ty,
            catch_state_locals,
        ),
        DispatchTree::Internal {
            children,
            span_per_child,
        } => emit_internal_dispatch(
            local,
            exit_seq,
            function_unwind_save,
            is_last_overall,
            children,
            *span_per_child,
            post_seqs,
            chunks,
            call_sites,
            arg_materializations,
            carryover_spills,
            catch_handlers,
            runtime,
            memory,
            ptr_ty,
            catch_state_locals,
        ),
    }
}

/// Emit one internal node, `B = children.len()`:
///
/// ```text
/// (block $exit_seq
///   (block $child_{B-1} ... (block $child_0
///     (block $node_dispatch ;; REWIND: br_table $child_0..$child_{B-1}
///     ))
///     <child 0's emission>     ;; appended into $child_1
///   ) <child 1's emission> ...
///   <child B-1's emission>     ;; appended into $exit_seq
/// )
/// ```
///
/// Each child K's emission is appended into its immediate enclosing
/// block (`$child_{K+1}`, or `$exit_seq` for K = B-1) after the
/// `Block($child_K)` opening, so REWIND `br $child_K` lands exactly
/// where child K's recursive emission begins. `is_last_overall`
/// flows only to the rightmost child.
#[allow(clippy::too_many_arguments)]
fn emit_internal_dispatch(
    local: &mut LocalFunction,
    exit_seq: InstrSeqId,
    function_unwind_save: InstrSeqId,
    is_last_overall: bool,
    children: &[DispatchTree],
    span_per_child: usize,
    post_seqs: &[InstrSeqId],
    chunks: &[Vec<(Instr, InstrLocId)>],
    call_sites: &[CallSiteInfo],
    arg_materializations: &[CallArgMaterialization],
    carryover_spills: &[Vec<LocalId>],
    catch_handlers: &[CatchHandlerInfo],
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    catch_state_locals: Option<CatchStateLocals>,
) {
    let b = children.len();
    debug_assert!(b >= 2, "internal dispatch node must have >= 2 children");

    let range_start = children[0].start();

    let node_dispatch = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();
    let child_seqs: Vec<InstrSeqId> = (0..b)
        .map(|_| {
            local
                .builder_mut()
                .dangling_instr_seq(InstrSeqType::Simple(None))
                .id()
        })
        .collect();

    populate_internal_dispatch(
        local,
        node_dispatch,
        runtime,
        memory,
        ptr_ty,
        &child_seqs,
        range_start,
        span_per_child,
        exit_seq,
    );

    {
        let s = &mut local.block_mut(child_seqs[0]).instrs;
        push_instr(s, Instr::Block(Block { seq: node_dispatch }));
    }

    for k in 1..b {
        {
            let s = &mut local.block_mut(child_seqs[k]).instrs;
            push_instr(
                s,
                Instr::Block(Block {
                    seq: child_seqs[k - 1],
                }),
            );
        }
        emit_dispatch_node(
            local,
            &children[k - 1],
            child_seqs[k],
            function_unwind_save,
            false,
            post_seqs,
            chunks,
            call_sites,
            arg_materializations,
            carryover_spills,
            catch_handlers,
            runtime,
            memory,
            ptr_ty,
            catch_state_locals,
        );
    }

    {
        let s = &mut local.block_mut(exit_seq).instrs;
        push_instr(
            s,
            Instr::Block(Block {
                seq: child_seqs[b - 1],
            }),
        );
    }
    emit_dispatch_node(
        local,
        &children[b - 1],
        exit_seq,
        function_unwind_save,
        is_last_overall,
        post_seqs,
        chunks,
        call_sites,
        arg_materializations,
        carryover_spills,
        catch_handlers,
        runtime,
        memory,
        ptr_ty,
        catch_state_locals,
    );
}

/// Emit the `$POST_K` chain for one leaf covering
/// `call_sites[leaf_start..leaf_end]`. Per-call UNWIND `br_if`s target
/// `function_unwind_save` so an unwind escapes the whole tree in one
/// `br`. `is_last_leaf` appends `chunks[n_calls] + Return` to
/// `exit_seq`; otherwise the leaf hands off the boundary chunk to the
/// next sibling (see body).
#[allow(clippy::too_many_arguments)]
fn emit_leaf_dispatch(
    local: &mut LocalFunction,
    exit_seq: InstrSeqId,
    function_unwind_save: InstrSeqId,
    leaf_start: usize,
    leaf_end: usize,
    is_last_leaf: bool,
    post_seqs: &[InstrSeqId],
    chunks: &[Vec<(Instr, InstrLocId)>],
    call_sites: &[CallSiteInfo],
    arg_materializations: &[CallArgMaterialization],
    carryover_spills: &[Vec<LocalId>],
    catch_handlers: &[CatchHandlerInfo],
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    catch_state_locals: Option<CatchStateLocals>,
) {
    debug_assert!(
        leaf_end > leaf_start,
        "emit_leaf_dispatch must not be called with an empty leaf",
    );
    let n_calls_total = call_sites.len();

    let dispatch_normal = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();
    populate_dispatch_normal(
        local,
        dispatch_normal,
        runtime,
        memory,
        ptr_ty,
        &post_seqs[leaf_start..leaf_end],
        leaf_start,
        function_unwind_save,
    );

    // Non-first leaves skip chunks[leaf_start] + spills[leaf_start]:
    // the previous leaf's exit_seq already emitted them as boundary
    // tail (see end of this function), so re-emitting here would run
    // the chunk's side effects twice on NORMAL fall-through.
    {
        let s = &mut local.block_mut(post_seqs[leaf_start]).instrs;
        push_instr(
            s,
            Instr::Block(Block {
                seq: dispatch_normal,
            }),
        );
        if leaf_start == 0 {
            for (instr, loc) in &chunks[leaf_start] {
                s.push((instr.clone(), *loc));
            }
            emit_spill_call_tail(
                s,
                &arg_materializations[leaf_start],
                &carryover_spills[leaf_start],
            );
        }
    }

    for k in (leaf_start + 1)..leaf_end {
        {
            let s = &mut local.block_mut(post_seqs[k]).instrs;
            push_instr(
                s,
                Instr::Block(Block {
                    seq: post_seqs[k - 1],
                }),
            );
        }
        emit_post_call_via_local(
            local,
            post_seqs[k],
            &call_sites[k - 1],
            k - 1,
            &arg_materializations[k - 1],
            &carryover_spills[k - 1],
            catch_handlers,
            runtime,
            memory,
            ptr_ty,
            catch_state_locals,
            function_unwind_save,
        );
        {
            let s = &mut local.block_mut(post_seqs[k]).instrs;
            for (instr, loc) in &chunks[k] {
                s.push((instr.clone(), *loc));
            }
            emit_spill_call_tail(s, &arg_materializations[k], &carryover_spills[k]);
        }
    }

    // Non-last leaves emit chunks[leaf_end] + spills[leaf_end] here so
    // the boundary chunk drains the previous call's return off the
    // operand stack before exit_seq closes — `$child_K` blocks have
    // sig `()->()` and would otherwise fail wasm validation.
    {
        let s = &mut local.block_mut(exit_seq).instrs;
        push_instr(
            s,
            Instr::Block(Block {
                seq: post_seqs[leaf_end - 1],
            }),
        );
    }
    emit_post_call_via_local(
        local,
        exit_seq,
        &call_sites[leaf_end - 1],
        leaf_end - 1,
        &arg_materializations[leaf_end - 1],
        &carryover_spills[leaf_end - 1],
        catch_handlers,
        runtime,
        memory,
        ptr_ty,
        catch_state_locals,
        function_unwind_save,
    );
    if is_last_leaf {
        let s = &mut local.block_mut(exit_seq).instrs;
        for (instr, loc) in &chunks[n_calls_total] {
            s.push((instr.clone(), *loc));
        }
        push_instr(s, Instr::Return(Return {}));
    } else {
        let s = &mut local.block_mut(exit_seq).instrs;
        for (instr, loc) in &chunks[leaf_end] {
            s.push((instr.clone(), *loc));
        }
        emit_spill_call_tail(
            s,
            &arg_materializations[leaf_end],
            &carryover_spills[leaf_end],
        );
    }
}

/// Spill the arg values off the operand stack into the per-call
/// spill locals. Args are spilled in reverse (top-of-stack first),
/// so the deepest arg ends up in `spills[0]`.
///
/// When `carryovers` is non-empty (sub-commit 2.4c), the operand
/// stack at the call site is `[..., carryover_0, ..., carryover_{n-1},
/// arg_0, ..., arg_{m-1}]` (bottom-to-top). After popping all args,
/// we keep popping into `carryovers` (also reverse-order), so
/// `carryovers[0]` ends up holding the deepest carryover slot.
fn emit_spill_args(out: &mut Vec<(Instr, InstrLocId)>, spills: &[LocalId], carryovers: &[LocalId]) {
    for &local in spills.iter().rev() {
        push_instr(out, Instr::LocalSet(LocalSet { local }));
    }
    for &local in carryovers.iter().rev() {
        push_instr(out, Instr::LocalSet(LocalSet { local }));
    }
}

fn emit_spill_call_tail(
    out: &mut Vec<(Instr, InstrLocId)>,
    arg_materialization: &CallArgMaterialization,
    carryovers: &[LocalId],
) {
    emit_spill_args(out, arg_materialization.spill_locals(), carryovers);
}

fn emit_materialized_call_args(
    out: &mut Vec<(Instr, InstrLocId)>,
    arg_materialization: &CallArgMaterialization,
) {
    match arg_materialization {
        CallArgMaterialization::Spill { locals } => {
            for &l in locals.iter() {
                push_instr(out, Instr::LocalGet(LocalGet { local: l }));
            }
        }
        CallArgMaterialization::PureTail { tail, .. } => {
            out.extend(tail.iter().cloned());
        }
    }
}

/// Emit Phase 6e writes inline. Must be called with mutable access to
/// the function (so dangling seqs can be allocated for each handler's
/// if-branch).
fn emit_phase_6e_writes(
    local: &mut LocalFunction,
    seq_id: InstrSeqId,
    catch_handlers: &[CatchHandlerInfo],
    catch_state_locals: Option<CatchStateLocals>,
) {
    if catch_handlers.is_empty() {
        return;
    }
    let catch_state = catch_state_locals.expect("catch handlers require catch-state locals");
    {
        let s = &mut local.block_mut(seq_id).instrs;
        push_instr(
            s,
            Instr::Const(Const {
                value: Value::I32(0),
            }),
        );
        push_instr(
            s,
            Instr::LocalSet(LocalSet {
                local: catch_state.catch_region_id,
            }),
        );
        push_instr(
            s,
            Instr::Const(Const {
                value: Value::I32(0),
            }),
        );
        push_instr(
            s,
            Instr::LocalSet(LocalSet {
                local: catch_state.exnref_slot,
            }),
        );
    }
    for info in catch_handlers {
        let if_ty = InstrSeqType::Simple(None);
        let ih_then = local.builder_mut().dangling_instr_seq(if_ty).id();
        let ih_else = local.builder_mut().dangling_instr_seq(if_ty).id();
        {
            let s = &mut local.block_mut(ih_then).instrs;
            push_instr(
                s,
                Instr::Const(Const {
                    value: Value::I32(info.catch_region_id as i32),
                }),
            );
            push_instr(
                s,
                Instr::LocalSet(LocalSet {
                    local: catch_state.catch_region_id,
                }),
            );
            push_instr(
                s,
                Instr::Const(Const {
                    value: Value::I32(info.exnref_slot as i32),
                }),
            );
            push_instr(
                s,
                Instr::LocalSet(LocalSet {
                    local: catch_state.exnref_slot,
                }),
            );
        }
        let s = &mut local.block_mut(seq_id).instrs;
        push_instr(
            s,
            Instr::LocalGet(LocalGet {
                local: info.in_catch_local,
            }),
        );
        push_instr(
            s,
            Instr::IfElse(IfElse {
                consequent: ih_then,
                alternative: ih_else,
            }),
        );
    }
}

fn emit_call_index_store_and_unwind_branch(
    local: &mut LocalFunction,
    seq_id: InstrSeqId,
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    call_idx: u32,
    unwind_save: InstrSeqId,
) {
    let if_then = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();
    let if_else = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();

    {
        let s = &mut local.block_mut(if_then).instrs;
        push_current_frame_ptr(s, runtime, memory, ptr_ty);
        push_instr(
            s,
            Instr::Const(Const {
                value: Value::I32(call_idx as i32),
            }),
        );
        push_instr(s, store_i32(memory, CALL_INDEX_OFFSET));
        push_instr(s, Instr::Br(Br { block: unwind_save }));
    }

    let s = &mut local.block_mut(seq_id).instrs;
    push_instr(
        s,
        Instr::GlobalGet(GlobalGet {
            global: runtime.state_global,
        }),
    );
    push_instr(
        s,
        Instr::Const(Const {
            value: Value::I32(runtime::STATE_UNWINDING),
        }),
    );
    push_instr(
        s,
        Instr::Binop(Binop {
            op: BinaryOp::I32Eq,
        }),
    );
    push_instr(
        s,
        Instr::IfElse(IfElse {
            consequent: if_then,
            alternative: if_else,
        }),
    );
}

// ----------------------------------------------------------------------
// Preamble / postamble
// ----------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn populate_preamble_then(
    local: &mut LocalFunction,
    preamble_then: InstrSeqId,
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    catch_state_locals: Option<CatchStateLocals>,
    locals_with_offsets: &[(LocalId, ValType, u32)],
    ref_plan: &[RefLocalSlot],
    aux_tables: &AuxTables,
    frame_size: u32,
) {
    let s = &mut local.block_mut(preamble_then).instrs;

    // *(buf + 0) = *(buf + 0) - frame_size. After this, the buffer
    // cursor itself is the current frame pointer for all frame reads.
    push_instr(
        s,
        Instr::GlobalGet(GlobalGet {
            global: runtime.buf_global,
        }),
    );
    push_instr(
        s,
        Instr::GlobalGet(GlobalGet {
            global: runtime.buf_global,
        }),
    );
    push_instr(s, load_ptr(memory, ptr_ty, 0));
    push_instr(s, ptr_const(ptr_ty, frame_size as i64));
    push_instr(
        s,
        Instr::Binop(Binop {
            op: ptr_sub(ptr_ty),
        }),
    );
    push_instr(s, store_ptr(memory, ptr_ty, 0));

    if let Some(catch_state) = catch_state_locals {
        // catch_region_id_local / exnref_slot_local
        push_current_frame_ptr(s, runtime, memory, ptr_ty);
        push_instr(s, load_i32(memory, CATCH_REGION_OFFSET));
        push_instr(
            s,
            Instr::LocalSet(LocalSet {
                local: catch_state.catch_region_id,
            }),
        );

        push_current_frame_ptr(s, runtime, memory, ptr_ty);
        push_instr(s, load_i32(memory, EXNREF_SLOT_OFFSET));
        push_instr(
            s,
            Instr::LocalSet(LocalSet {
                local: catch_state.exnref_slot,
            }),
        );
    }

    // Restore scalar user locals (includes arg-spill locals).
    for &(lid, ty, off) in locals_with_offsets {
        push_current_frame_ptr(s, runtime, memory, ptr_ty);
        push_instr(s, load_scalar(memory, ty, off as u64));
        push_instr(s, Instr::LocalSet(LocalSet { local: lid }));
    }

    // Restore ref-typed user locals from aux tables.
    for slot in ref_plan {
        let table = aux_tables
            .table_for(slot.class)
            .expect("aux table for this ref class must be injected");
        push_instr(
            s,
            Instr::Const(Const {
                value: Value::I32(slot.slot as i32),
            }),
        );
        push_instr(s, Instr::TableGet(TableGet { table }));
        push_instr(s, Instr::LocalSet(LocalSet { local: slot.local }));
    }
}

#[allow(clippy::too_many_arguments)]
fn populate_postamble(
    out: &mut Vec<(Instr, InstrLocId)>,
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    catch_state_locals: Option<CatchStateLocals>,
    locals_with_offsets: &[(LocalId, ValType, u32)],
    ref_plan: &[RefLocalSlot],
    aux_tables: &AuxTables,
    frame_size: u32,
    func_ordinal: u32,
    result_types: &[ValType],
) {
    // frame[0] = func_ordinal
    push_current_frame_ptr(out, runtime, memory, ptr_ty);
    push_instr(
        out,
        Instr::Const(Const {
            value: Value::I32(func_ordinal as i32),
        }),
    );
    push_instr(out, store_i32(memory, FUNC_INDEX_OFFSET));

    if let Some(catch_state) = catch_state_locals {
        // frame[8] = dynamic catch_region_id for catch-capable functions.
        push_current_frame_ptr(out, runtime, memory, ptr_ty);
        push_instr(
            out,
            Instr::LocalGet(LocalGet {
                local: catch_state.catch_region_id,
            }),
        );
        push_instr(out, store_i32(memory, CATCH_REGION_OFFSET));

        // frame[12] = dynamic exnref_slot for catch-capable functions.
        push_current_frame_ptr(out, runtime, memory, ptr_ty);
        push_instr(
            out,
            Instr::LocalGet(LocalGet {
                local: catch_state.exnref_slot,
            }),
        );
        push_instr(out, store_i32(memory, EXNREF_SLOT_OFFSET));
    } else {
        // frame[8..16] = zero catch_region_id + exnref_slot.
        push_current_frame_ptr(out, runtime, memory, ptr_ty);
        push_instr(
            out,
            Instr::Const(Const {
                value: Value::I64(0),
            }),
        );
        push_instr(out, store_scalar(memory, ValType::I64, CATCH_REGION_OFFSET));
    }

    // Save scalar user + arg-spill locals
    for &(lid, ty, off) in locals_with_offsets {
        push_current_frame_ptr(out, runtime, memory, ptr_ty);
        push_instr(out, Instr::LocalGet(LocalGet { local: lid }));
        push_instr(out, store_scalar(memory, ty, off as u64));
    }

    // Spill ref-typed user locals to aux tables.
    for slot in ref_plan {
        let table = aux_tables
            .table_for(slot.class)
            .expect("aux table for this ref class must be injected");
        push_instr(
            out,
            Instr::Const(Const {
                value: Value::I32(slot.slot as i32),
            }),
        );
        push_instr(out, Instr::LocalGet(LocalGet { local: slot.local }));
        push_instr(out, Instr::TableSet(TableSet { table }));
    }

    // Advance current_pos: *(buf + 0) = frame_ptr + frame_size
    push_instr(
        out,
        Instr::GlobalGet(GlobalGet {
            global: runtime.buf_global,
        }),
    );
    push_current_frame_ptr(out, runtime, memory, ptr_ty);
    push_instr(out, ptr_const(ptr_ty, frame_size as i64));
    push_instr(
        out,
        Instr::Binop(Binop {
            op: ptr_add(ptr_ty),
        }),
    );
    push_instr(out, store_ptr(memory, ptr_ty, 0));

    // Push defaults for the function's result types, or `unreachable`
    // if any result is a non-nullable ref.
    let mut fallback_unreachable = false;
    for &ty in result_types {
        match default_for_type(ty) {
            Some(instr) => push_instr(out, instr),
            None => {
                fallback_unreachable = true;
                break;
            }
        }
    }
    if fallback_unreachable {
        push_instr(out, Instr::Unreachable(walrus::ir::Unreachable {}));
    }
}

/// Post-call sequence for call site K, appended to sequence `seq_id`:
/// - reload spilled args
/// - emit the call instruction
/// - Phase 6e writes (compute catch_region_id / exnref_slot from active
///   in_catch flags)
/// - if state == UNWINDING, write K to frame.call_index and branch to
///   `$unwind_save`
///
/// Takes `&mut LocalFunction` so Phase 6e can allocate dangling
/// IfElse branches for each handler check.
#[allow(clippy::too_many_arguments)]
fn emit_post_call_via_local(
    local: &mut LocalFunction,
    seq_id: InstrSeqId,
    call: &CallSiteInfo,
    call_idx: usize,
    arg_materialization: &CallArgMaterialization,
    carryovers: &[LocalId],
    catch_handlers: &[CatchHandlerInfo],
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    catch_state_locals: Option<CatchStateLocals>,
    unwind_save: InstrSeqId,
) {
    // Reload carryovers (deepest first), then args (deepest first).
    // The call pops only its args, leaving the carryovers + result on
    // the stack — matching the original code's expected shape.
    {
        let s = &mut local.block_mut(seq_id).instrs;
        for &l in carryovers.iter() {
            push_instr(s, Instr::LocalGet(LocalGet { local: l }));
        }
        emit_materialized_call_args(s, arg_materialization);
        let call_instr = match call.target {
            CallTarget::Direct(func) => Instr::Call(Call { func }),
            CallTarget::Indirect { table } => Instr::CallIndirect(CallIndirect {
                ty: call.sig_ty,
                table,
            }),
        };
        s.push((call_instr, call.loc));
    }

    emit_phase_6e_writes(local, seq_id, catch_handlers, catch_state_locals);

    emit_call_index_store_and_unwind_branch(
        local,
        seq_id,
        runtime,
        memory,
        ptr_ty,
        call_idx as u32,
        unwind_save,
    );
}

// ----------------------------------------------------------------------
// Misc helpers
// ----------------------------------------------------------------------

fn assign_local_offsets(
    user_scalar_locals: &[(LocalId, ValType)],
    start: u32,
) -> Vec<(LocalId, ValType, u32)> {
    let mut result = Vec::with_capacity(user_scalar_locals.len());
    let mut off = start;
    for &(lid, ty) in user_scalar_locals {
        result.push((lid, ty, off));
        off += scalar_size(ty);
    }
    result
}

fn user_locals_size(user_scalar_locals: &[(LocalId, ValType)]) -> u32 {
    user_scalar_locals
        .iter()
        .map(|(_, ty)| scalar_size(*ty))
        .sum()
}

fn func_name(module: &Module, id: FunctionId) -> String {
    module
        .funcs
        .get(id)
        .name
        .clone()
        .unwrap_or_else(|| format!("{:?}", id))
}

// ----------------------------------------------------------------------
// User-local discovery
// ----------------------------------------------------------------------

fn collect_user_locals(module: &Module, func_id: FunctionId) -> Vec<(LocalId, ValType)> {
    let local = match &module.funcs.get(func_id).kind {
        FunctionKind::Local(l) => l,
        _ => return Vec::new(),
    };

    struct Collector {
        ordered: Vec<LocalId>,
        seen: HashSet<LocalId>,
    }

    impl<'a> walrus::ir::Visitor<'a> for Collector {
        fn visit_local_id(&mut self, id: &LocalId) {
            if self.seen.insert(*id) {
                self.ordered.push(*id);
            }
        }
    }

    let mut c = Collector {
        ordered: Vec::new(),
        seen: HashSet::new(),
    };
    for arg in &local.args {
        if c.seen.insert(*arg) {
            c.ordered.push(*arg);
        }
    }
    walrus::ir::dfs_in_order(&mut c, local, local.entry_block());

    c.ordered
        .into_iter()
        .map(|id| (id, module.locals.get(id).ty()))
        .collect()
}

// ----------------------------------------------------------------------
// Nested-seq traversal
// ----------------------------------------------------------------------

fn nested_seqs(instr: &Instr) -> Vec<InstrSeqId> {
    match instr {
        Instr::Block(Block { seq }) => vec![*seq],
        Instr::Loop(Loop { seq }) => vec![*seq],
        Instr::IfElse(IfElse {
            consequent,
            alternative,
        }) => vec![*consequent, *alternative],
        Instr::TryTable(TryTable { seq, .. }) => vec![*seq],
        Instr::Try(t) => {
            let mut ids = vec![t.seq];
            for c in &t.catches {
                match c {
                    LegacyCatch::Catch { handler, .. } | LegacyCatch::CatchAll { handler } => {
                        ids.push(*handler)
                    }
                    LegacyCatch::Delegate { .. } => {}
                }
            }
            ids
        }
        _ => Vec::new(),
    }
}

// ----------------------------------------------------------------------
// Value-typed helpers
// ----------------------------------------------------------------------

fn is_scalar(ty: ValType) -> bool {
    !matches!(ty, ValType::Ref(_))
}

fn scalar_size(ty: ValType) -> u32 {
    match ty {
        ValType::I32 | ValType::F32 => 4,
        ValType::I64 | ValType::F64 => 8,
        ValType::V128 => 16,
        ValType::Ref(_) => panic!("scalar_size called on ref type"),
    }
}

fn natural_align(ty: ValType) -> u32 {
    scalar_size(ty)
}

/// Round `x` up to the nearest 8-byte boundary. Used by B1 scratch
/// planning and (Task 1.3) save-buffer reservation. A near-duplicate
/// lives in `runtime.rs`; consolidate when extracting `crate::layout`.
fn align_up_8(x: u32) -> u32 {
    (x + 7) & !7u32
}

fn default_for_type(ty: ValType) -> Option<Instr> {
    Some(match ty {
        ValType::I32 => Instr::Const(Const {
            value: Value::I32(0),
        }),
        ValType::I64 => Instr::Const(Const {
            value: Value::I64(0),
        }),
        ValType::F32 => Instr::Const(Const {
            value: Value::F32(0.0),
        }),
        ValType::F64 => Instr::Const(Const {
            value: Value::F64(0.0),
        }),
        ValType::V128 => Instr::Const(Const {
            value: Value::V128(0),
        }),
        ValType::Ref(rt) if rt.nullable => Instr::RefNull(RefNull { ty: rt }),
        ValType::Ref(_) => return None,
    })
}

fn load_i32(memory: MemoryId, offset: u64) -> Instr {
    Instr::Load(walrus::ir::Load {
        memory,
        kind: LoadKind::I32 { atomic: false },
        arg: MemArg { align: 4, offset },
    })
}

fn store_i32(memory: MemoryId, offset: u64) -> Instr {
    Instr::Store(walrus::ir::Store {
        memory,
        kind: StoreKind::I32 { atomic: false },
        arg: MemArg { align: 4, offset },
    })
}

fn load_scalar(memory: MemoryId, ty: ValType, offset: u64) -> Instr {
    let kind = match ty {
        ValType::I32 => LoadKind::I32 { atomic: false },
        ValType::I64 => LoadKind::I64 { atomic: false },
        ValType::F32 => LoadKind::F32,
        ValType::F64 => LoadKind::F64,
        ValType::V128 => LoadKind::V128,
        ValType::Ref(_) => panic!("load_scalar on ref type"),
    };
    Instr::Load(walrus::ir::Load {
        memory,
        kind,
        arg: MemArg {
            align: natural_align(ty),
            offset,
        },
    })
}

fn store_scalar(memory: MemoryId, ty: ValType, offset: u64) -> Instr {
    let kind = match ty {
        ValType::I32 => StoreKind::I32 { atomic: false },
        ValType::I64 => StoreKind::I64 { atomic: false },
        ValType::F32 => StoreKind::F32,
        ValType::F64 => StoreKind::F64,
        ValType::V128 => StoreKind::V128,
        ValType::Ref(_) => panic!("store_scalar on ref type"),
    };
    Instr::Store(walrus::ir::Store {
        memory,
        kind,
        arg: MemArg {
            align: natural_align(ty),
            offset,
        },
    })
}

fn load_ptr(memory: MemoryId, ptr_ty: ValType, offset: u64) -> Instr {
    let (kind, align) = match ptr_ty {
        ValType::I32 => (LoadKind::I32 { atomic: false }, 4),
        ValType::I64 => (LoadKind::I64 { atomic: false }, 8),
        _ => panic!("unsupported ptr type"),
    };
    Instr::Load(walrus::ir::Load {
        memory,
        kind,
        arg: MemArg { align, offset },
    })
}

fn store_ptr(memory: MemoryId, ptr_ty: ValType, offset: u64) -> Instr {
    let (kind, align) = match ptr_ty {
        ValType::I32 => (StoreKind::I32 { atomic: false }, 4),
        ValType::I64 => (StoreKind::I64 { atomic: false }, 8),
        _ => panic!("unsupported ptr type"),
    };
    Instr::Store(walrus::ir::Store {
        memory,
        kind,
        arg: MemArg { align, offset },
    })
}

fn ptr_const(ptr_ty: ValType, v: i64) -> Instr {
    match ptr_ty {
        ValType::I32 => Instr::Const(Const {
            value: Value::I32(v as i32),
        }),
        ValType::I64 => Instr::Const(Const {
            value: Value::I64(v),
        }),
        _ => panic!("unsupported ptr type"),
    }
}

fn ptr_add(ptr_ty: ValType) -> BinaryOp {
    match ptr_ty {
        ValType::I32 => BinaryOp::I32Add,
        ValType::I64 => BinaryOp::I64Add,
        _ => panic!("unsupported ptr type"),
    }
}

fn ptr_sub(ptr_ty: ValType) -> BinaryOp {
    match ptr_ty {
        ValType::I32 => BinaryOp::I32Sub,
        ValType::I64 => BinaryOp::I64Sub,
        _ => panic!("unsupported ptr type"),
    }
}

fn first_memory(module: &Module) -> MemoryId {
    module
        .memories
        .iter()
        .next()
        .map(|m| m.id())
        .expect("instrumented module must have at least one memory")
}

fn local_mut(module: &mut Module, func_id: FunctionId) -> &mut LocalFunction {
    match &mut module.funcs.get_mut(func_id).kind {
        FunctionKind::Local(l) => l,
        _ => panic!("expected a local (non-import) function"),
    }
}

fn push_instr(out: &mut Vec<(Instr, InstrLocId)>, instr: Instr) {
    out.push((instr, InstrLocId::default()));
}

fn push_current_frame_ptr(
    out: &mut Vec<(Instr, InstrLocId)>,
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
) {
    push_instr(
        out,
        Instr::GlobalGet(GlobalGet {
            global: runtime.buf_global,
        }),
    );
    push_instr(out, load_ptr(memory, ptr_ty, 0));
}

fn push_current_call_index(
    out: &mut Vec<(Instr, InstrLocId)>,
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
) {
    push_current_frame_ptr(out, runtime, memory, ptr_ty);
    push_instr(out, load_i32(memory, CALL_INDEX_OFFSET));
}

// ----------------------------------------------------------------------
// Phase 4f — ref-typed local spilling via aux tables
// ----------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RefClass {
    Funcref,
    Externref,
    Exnref,
}

#[derive(Debug, Clone, Copy)]
pub struct RefLocalSlot {
    pub local: LocalId,
    pub class: RefClass,
    pub slot: u32,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct AuxTables {
    pub funcref: Option<TableId>,
    pub externref: Option<TableId>,
    pub exnref: Option<TableId>,
}

impl AuxTables {
    pub fn table_for(&self, class: RefClass) -> Option<TableId> {
        match class {
            RefClass::Funcref => self.funcref,
            RefClass::Externref => self.externref,
            RefClass::Exnref => self.exnref,
        }
    }
}

fn classify_ref(rt: RefType) -> Option<RefClass> {
    if !rt.nullable {
        return None;
    }
    match rt.heap_type {
        HeapType::Abstract(AbstractHeapType::Func) => Some(RefClass::Funcref),
        HeapType::Abstract(AbstractHeapType::NoFunc) => Some(RefClass::Funcref),
        HeapType::Abstract(AbstractHeapType::Extern) => Some(RefClass::Externref),
        HeapType::Abstract(AbstractHeapType::NoExtern) => Some(RefClass::Externref),
        HeapType::Abstract(AbstractHeapType::Exn) => Some(RefClass::Exnref),
        HeapType::Abstract(AbstractHeapType::NoExn) => Some(RefClass::Exnref),
        _ => None,
    }
}

fn plan_and_inject_aux_tables(
    module: &mut Module,
    targets: &[FunctionId],
) -> (
    AuxTables,
    HashMap<FunctionId, Vec<RefLocalSlot>>,
    HashMap<FunctionId, Vec<CatchRegionPlan>>,
) {
    let mut funcref_cursor: u32 = 0;
    let mut externref_cursor: u32 = 0;
    let mut exnref_cursor: u32 = 0;

    let mut plan: HashMap<FunctionId, Vec<RefLocalSlot>> = HashMap::new();

    for &id in targets {
        let mut per_func: Vec<RefLocalSlot> = Vec::new();
        for (local, ty) in collect_user_locals(module, id) {
            let rt = match ty {
                ValType::Ref(rt) => rt,
                _ => continue,
            };
            let class = classify_ref(rt).unwrap_or_else(|| {
                let name = module.funcs.get(id).name.as_deref().unwrap_or("<anon>");
                panic!(
                    "fork-instrument 4f: function `{name}` has a ref-typed local of \
                     type {rt:?} which is not yet supported (non-nullable or non-abstract \
                     ref).",
                )
            });
            let slot = match class {
                RefClass::Funcref => {
                    let s = funcref_cursor;
                    funcref_cursor += 1;
                    s
                }
                RefClass::Externref => {
                    let s = externref_cursor;
                    externref_cursor += 1;
                    s
                }
                RefClass::Exnref => {
                    let s = exnref_cursor;
                    exnref_cursor += 1;
                    s
                }
            };
            per_func.push(RefLocalSlot { local, class, slot });
        }
        if !per_func.is_empty() {
            plan.insert(id, per_func);
        }
    }

    let mut catch_plans: HashMap<FunctionId, Vec<CatchRegionPlan>> = HashMap::new();
    for &id in targets {
        let bodies = discover_try_table_bodies(module, id);
        let mut per_func: Vec<CatchRegionPlan> = Vec::with_capacity(bodies.len());
        for (lex_idx, body_seq) in bodies.into_iter().enumerate() {
            let slot = exnref_cursor;
            exnref_cursor += 1;
            per_func.push(CatchRegionPlan {
                body_seq,
                catch_region_id: (lex_idx as u32) + 1,
                exnref_slot: slot,
            });
        }
        if !per_func.is_empty() {
            catch_plans.insert(id, per_func);
        }
    }

    let funcref = if funcref_cursor > 0 {
        let id = module.tables.add_local(
            false,
            funcref_cursor as u64,
            Some(funcref_cursor as u64),
            RefType::FUNCREF,
        );
        module.tables.get_mut(id).name = Some("_wpk_fork_funcref_stash".into());
        Some(id)
    } else {
        None
    };
    let externref = if externref_cursor > 0 {
        let id = module.tables.add_local(
            false,
            externref_cursor as u64,
            Some(externref_cursor as u64),
            RefType::EXTERNREF,
        );
        module.tables.get_mut(id).name = Some("_wpk_fork_externref_stash".into());
        Some(id)
    } else {
        None
    };
    let exnref = if exnref_cursor > 0 {
        let exn_rt = RefType {
            nullable: true,
            heap_type: HeapType::Abstract(AbstractHeapType::Exn),
        };
        let id = module.tables.add_local(
            false,
            exnref_cursor as u64,
            Some(exnref_cursor as u64),
            exn_rt,
        );
        module.tables.get_mut(id).name = Some("_wpk_fork_exnref_stash".into());
        Some(id)
    } else {
        None
    };

    (
        AuxTables {
            funcref,
            externref,
            exnref,
        },
        plan,
        catch_plans,
    )
}

#[derive(Debug, Clone, Copy)]
pub struct CatchRegionPlan {
    pub body_seq: InstrSeqId,
    pub catch_region_id: u32,
    pub exnref_slot: u32,
}

fn discover_try_table_bodies(module: &Module, func_id: FunctionId) -> Vec<InstrSeqId> {
    let local = match &module.funcs.get(func_id).kind {
        FunctionKind::Local(l) => l,
        _ => return Vec::new(),
    };
    let mut bodies = Vec::new();
    visit_try_tables(local, local.entry_block(), &mut bodies);
    bodies
}

fn visit_try_tables(f: &LocalFunction, seq: InstrSeqId, out: &mut Vec<InstrSeqId>) {
    for (instr, _) in &f.block(seq).instrs {
        if let Instr::TryTable(tt) = instr {
            out.push(tt.seq);
        }
        for child in nested_seqs(instr) {
            visit_try_tables(f, child, out);
        }
    }
}

/// Stage 1 (B1) — describes a single `catch $tag $label` clause in a
/// fork-path try_table. Discovered alongside `CatchRegionPlan` and
/// recorded per-region for later Stage 2 wiring.
#[derive(Debug, Clone)]
pub struct PlainCatchArm {
    /// Index of this arm within its try_table's `catches` list. Stage 2
    /// writes this value as the `arm_id` field of the saved scratch tuple
    /// at unwind time; the rewind path reads it to select which
    /// `throw $tag (operands)` to emit. Combined with the function's
    /// `catch_region_id` (tracked by `CatchRegionPlan`), the pair is
    /// unique within the function — no module-wide arm_id is needed.
    pub arm_idx: u32,
    /// Tag this arm catches.
    pub tag: TagId,
    /// Label the arm branches to on catch (target block id).
    pub label: InstrSeqId,
    /// Tag's operand types (matches the params of the type that
    /// `module.tags.get(tag).ty()` references). Cached at discovery
    /// time so we don't re-look-up on emission.
    pub operand_tys: Vec<ValType>,
}

/// Stage 1 (B1) — for each try_table in `func_id`, returns
/// `(body_seq, plain_catch_arms)` where `plain_catch_arms` lists
/// every plain `Catch { tag, label }` clause. Following Phase 6's
/// pattern: catch_ref / catch_all_ref clauses are skipped (Phase 6
/// territory); plain catch is enumerated unfiltered.
///
/// Function-level filtering happens at the call site (caller passes
/// only fork-path `FunctionId`s, mirroring `discover_try_table_bodies`).
/// Sub-function arm-by-arm reachability filtering is intentionally
/// not done — Phase 6 doesn't filter either, and the cost of
/// recording an unused `PlainCatchArm` is one struct per arm.
pub fn discover_plain_catch_arms(
    module: &Module,
    func_id: FunctionId,
) -> Vec<(InstrSeqId, Vec<PlainCatchArm>)> {
    let local = match &module.funcs.get(func_id).kind {
        FunctionKind::Local(l) => l,
        _ => return Vec::new(),
    };
    let mut out = Vec::new();
    visit_for_plain_catch(module, local, local.entry_block(), &mut out);
    out
}

fn visit_for_plain_catch(
    module: &Module,
    f: &LocalFunction,
    seq: InstrSeqId,
    out: &mut Vec<(InstrSeqId, Vec<PlainCatchArm>)>,
) {
    for (instr, _) in &f.block(seq).instrs {
        if let Instr::TryTable(tt) = instr {
            let mut arms: Vec<PlainCatchArm> = Vec::new();
            for (i, c) in tt.catches.iter().enumerate() {
                let (tag, label) = match c {
                    TryTableCatch::Catch { tag, label } => (*tag, *label),
                    _ => continue, // CatchRef / CatchAllRef: handled by Phase 6.
                                   // CatchAll: unsupported today; not in B1 scope
                                   // (no tag → no operand_tys to save).
                };
                let operand_tys: Vec<ValType> = module
                    .types
                    .get(module.tags.get(tag).ty())
                    .params()
                    .to_vec();
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
            visit_for_plain_catch(module, f, child, out);
        }
    }
}

/// Stage 1 (B1) — per-arm slot in the scratch area.
#[derive(Debug, Clone)]
pub struct PlainCatchArmSlot {
    pub arm: PlainCatchArm,
    /// Byte offset within the B1 scratch area at which this arm's
    /// (arm_id, operand_0..N-1) tuple is stored. Relative to the
    /// scratch base (which `Runtime.b1_scratch_base` will track in
    /// Task 1.3); not yet relative to absolute buffer base.
    pub scratch_offset: u32,
    /// Total size in bytes of this arm's saved tuple: 4 (arm_id) +
    /// concatenated scalar operand sizes. Per-operand alignment is
    /// preserved without padding because (a) operand sizes are
    /// powers-of-2 (4, 8, or 16 bytes), (b) the tuple itself starts
    /// 8-aligned within the scratch area, and (c) operands appear in
    /// declaration order — the first operand at +4 lands 4-aligned,
    /// and any 8-aligned operand falls on a tuple offset that's
    /// already 8-aligned because preceding operands are also
    /// powers-of-2.
    pub tuple_size: u32,
}

/// Stage 1 (B1) — module-wide plain-catch scratch plan.
///
/// Stage 2 (Task 2.1) adds `b2_carveout`: functions whose plain-catch
/// arms include unsupported operand types (e.g., ref-typed) land here
/// instead of `per_function`. Stage 2 emission tasks check this set
/// and skip plain-catch instrumentation for carved-out functions —
/// falling back to today's behavior (Phase 6 catch_ref still works,
/// plain-catch fork remains unsupported for those specific shapes).
#[derive(Debug, Clone, Default)]
pub struct B1ScratchPlan {
    /// Total bytes the B1 scratch area occupies. Stage 1 Task 1.3
    /// will reserve this many bytes between `saved_globals` and
    /// `frame data` in the save buffer.
    pub total_bytes: u32,
    /// Per-function per-region per-arm slot assignments. Outer Vec
    /// parallels `discover_plain_catch_arms`'s return shape (one
    /// entry per try_table that has at least one plain-catch arm).
    pub per_function:
        std::collections::HashMap<FunctionId, Vec<(InstrSeqId, Vec<PlainCatchArmSlot>)>>,
    /// Stage 2 (B1): functions whose plain-catch arms include
    /// unsupported operand types (e.g., ref-typed). For these
    /// functions, B1 emission tasks fall back to today's behavior
    /// (Phase 6 doesn't intercept plain-catch arms — the function
    /// works for catch_ref but is unsupported for plain-catch fork).
    pub b2_carveout: std::collections::HashSet<FunctionId>,
}

/// Stage 1 (B1) — assigns scratch offsets for every plain-catch arm
/// across all fork-path functions. The scratch area lives between
/// `saved_globals` and `frame data` in the save buffer; its base is
/// `Runtime.b1_scratch_base` (set in Task 1.3) and its total size
/// is `B1ScratchPlan.total_bytes`.
///
/// Tuple layout per arm (Stage 2 will read/write this):
/// ```text
/// +0    4    arm_id (i32)
/// +4    var  operand_0 ... operand_N-1, naturally aligned
/// ```
/// Tuples are 8-byte-aligned within the scratch area so that
/// i64/f64 operands at offset +4 (the first operand position)
/// land on a properly aligned address relative to the scratch base.
///
/// Operand types are restricted to scalars (i32/i64/f32/f64/v128)
/// at this stage. Ref-typed operands (externref/funcref/exnref/GC
/// refs) will require aux-table spilling — a future B2 carve-out.
///
/// Stage 2 (Task 2.1) detects ref-typed payloads here and routes the
/// affected function to `B1ScratchPlan.b2_carveout` instead of
/// `per_function`. Stage 2 emission tasks check the carve-out set
/// and skip plain-catch instrumentation for those functions, so
/// `scalar_size`'s ref-type panic is now unreachable from the
/// planner — it survives only as a defense-in-depth assertion for
/// future callers that bypass the carve-out filter.
///
/// The carve-out is whole-function: if any arm in any region of a
/// function has a ref-typed operand, the entire function's
/// plain-catch instrumentation is skipped. We don't selectively drop
/// arms because Task 2.3's rewind dispatcher needs the whole
/// region's arm set or none.
///
/// The cursor walks `targets` in iteration order, so per-function
/// offsets depend on the caller's ordering of `targets`. Stage 2's
/// emission code reads `B1ScratchPlan.per_function[fid]` keyed by
/// `FunctionId`, so this ordering is internal to the plan and
/// irrelevant to correctness — but tests that pin specific offset
/// values must use stable target ordering.
pub fn plan_b1_scratch(module: &Module, targets: &[FunctionId]) -> B1ScratchPlan {
    let mut plan = B1ScratchPlan::default();
    let mut cursor: u32 = 0;
    for &fid in targets {
        let arms_per_region = discover_plain_catch_arms(module, fid);
        if arms_per_region.is_empty() {
            continue;
        }
        // Stage 2 (B1): detect unsupported operand types and carve out
        // the entire function. We can't selectively drop just the bad
        // arms because the rewind-throw stub dispatches by arm_id and
        // expects every arm in a region to have a scratch slot — Stage
        // 2 keeps things simple by treating the whole function's
        // plain-catch as off-limits if any arm has a ref operand.
        let has_unsupported = arms_per_region.iter().any(|(_, arms)| {
            arms.iter()
                .any(|arm| arm.operand_tys.iter().any(|t| matches!(t, ValType::Ref(_))))
        });
        // Stage 2 (B1) Task 2.4: multi-target plain-catch guard.
        // A try_table whose plain-catch arms branch to *different*
        // labels has not been verified end-to-end. Per-arm capture
        // blocks each branch to their own original target label, and
        // the rewind dispatcher's re-throw routes through the
        // try_table's catch clauses to reach those captures, so in
        // principle multi-target should work — but until a real port
        // exercises it, conservatively treat such functions as
        // b2_carveout. Single-target multi-arm (multiple catches all
        // pointing at the same label) remains supported.
        let has_multi_target = arms_per_region.iter().any(|(_, arms)| {
            if arms.len() <= 1 {
                return false;
            }
            let first = arms[0].label;
            arms.iter().any(|arm| arm.label != first)
        });
        if has_unsupported || has_multi_target {
            plan.b2_carveout.insert(fid);
            continue;
        }
        let mut per_func: Vec<(InstrSeqId, Vec<PlainCatchArmSlot>)> =
            Vec::with_capacity(arms_per_region.len());
        for (body_seq, arm_list) in arms_per_region {
            let mut slots: Vec<PlainCatchArmSlot> = Vec::with_capacity(arm_list.len());
            for arm in arm_list {
                debug_assert!(
                    arm.operand_tys.iter().all(|t| !matches!(t, ValType::Ref(_))),
                    "B1 plan_b1_scratch invariant: caller must filter ref-payload arms via Stage 2 \
                     b2_carveout (excluded from fork-path) before reaching the planner. Affected \
                     function has a tag with a ref-typed operand."
                );
                let payload_size: u32 = arm.operand_tys.iter().map(|t| scalar_size(*t)).sum();
                let tuple_size = 4 + payload_size;
                // Outer 8-byte alignment for the tuple start.
                let aligned = align_up_8(cursor);
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
    // Final scratch area aligned up to 8 bytes so `frames_start_offset`
    // (which sits after the scratch area) lands aligned for the frame
    // header writes that follow.
    plan.total_bytes = align_up_8(cursor);
    plan
}

// ----------------------------------------------------------------------
// Phase 6c — rewind-throw stub injection
// ----------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
/// Phase 6c (extended by B1 Stage 2 Task 2.3) — prepend a rewind-throw
/// stub at the top of each fork-path try_table body.
///
/// On REWIND, when `catch_region_id_local == K`, the stub re-enters the
/// try_table's catch dispatch so the original handler observes the same
/// exception that was caught pre-fork. The shape depends on what kind
/// of catch was originally taken:
///
/// - **catch_ref / catch_all_ref**: Phase 6's `apply_catch_ref_handlers`
///   stashed the exnref in `_wpk_fork_exnref_stash[slot]`. We re-throw
///   it via `throw_ref`. Selected when the stash slot is non-null.
///
/// - **plain catch (B1 Stage 2)**: the per-arm capture block stored
///   `(arm_id, op_0, ..., op_M-1)` in the B1 scratch tuple at
///   `runtime.b1_scratch_base + slot.scratch_offset`. We load the
///   arm_id, dispatch by value to the matching arm, push the saved
///   operands, and `throw $tag`. Selected when the stash slot is null.
///
/// The exnref-stash null-check is the sentinel: Phase 6's capture
/// always writes a non-null exnref; B1's plain-catch capture never
/// touches the stash. This naturally disambiguates regions with mixed
/// `catch_ref` and `catch` clauses without Phase 6 needing to know
/// about B1.
///
/// `b1_slots_lookup` maps `body_seq -> arm slots` for regions that have
/// at least one plain-catch arm in scope (i.e. function not in
/// `b2_carveout`). Regions with no plain arms fall back to today's
/// catch_ref-only stub shape.
fn inject_rewind_throw_stubs(
    module: &mut Module,
    func_id: FunctionId,
    runtime: &Runtime,
    catch_region_id_local: LocalId,
    aux_tables: &AuxTables,
    catch_plan: &[CatchRegionPlan],
    b1_slots: &[(InstrSeqId, Vec<PlainCatchArmSlot>)],
) {
    let exnref_table = match aux_tables.exnref {
        Some(t) => t,
        None => {
            debug_assert!(catch_plan.is_empty());
            return;
        }
    };

    let b1_lookup: HashMap<InstrSeqId, &[PlainCatchArmSlot]> = b1_slots
        .iter()
        .map(|(seq, slots)| (*seq, slots.as_slice()))
        .collect();

    let memory = first_memory(module);

    for plan in catch_plan {
        let body_seq_id = plan.body_seq;
        let region_id = plan.catch_region_id;
        let slot = plan.exnref_slot;
        let plain_arms: &[PlainCatchArmSlot] = b1_lookup.get(&body_seq_id).copied().unwrap_or(&[]);

        // Build the inner "catch_ref path" sequence (Phase 6's existing
        // logic). Always emitted — used either as the only path
        // (region has no plain arms) or as the false-branch of the
        // B1 sentinel check (region has plain arms).
        let throw_ref_seq_id = {
            let local = local_mut(module, func_id);
            let s = local
                .builder_mut()
                .dangling_instr_seq(InstrSeqType::Simple(None))
                .id();
            let block = &mut local.block_mut(s).instrs;
            push_instr(
                block,
                Instr::Const(Const {
                    value: Value::I32(slot as i32),
                }),
            );
            push_instr(
                block,
                Instr::TableGet(TableGet {
                    table: exnref_table,
                }),
            );
            push_instr(block, Instr::RefAsNonNull(RefAsNonNull {}));
            push_instr(block, Instr::ThrowRef(ThrowRef {}));
            s
        };

        // Build the "rewind dispatch" sequence: either a single
        // throw_ref (no plain arms) or a sentinel-gated split between
        // plain-catch dispatch and throw_ref.
        let dispatch_seq_id = if plain_arms.is_empty() {
            throw_ref_seq_id
        } else {
            // B1 plain-catch dispatch: build first, then wrap in
            // an IfElse that selects on `exnref_stash[slot] is null`.
            let plain_dispatch_id =
                build_plain_catch_dispatch(module, func_id, runtime, memory, plain_arms);

            let local = local_mut(module, func_id);
            let outer = local
                .builder_mut()
                .dangling_instr_seq(InstrSeqType::Simple(None))
                .id();
            let block = &mut local.block_mut(outer).instrs;
            // Sentinel: load `_wpk_fork_exnref_stash[slot]` and check if
            // it's null. If null → plain-catch dispatch; if non-null →
            // catch_ref throw_ref.
            push_instr(
                block,
                Instr::Const(Const {
                    value: Value::I32(slot as i32),
                }),
            );
            push_instr(
                block,
                Instr::TableGet(TableGet {
                    table: exnref_table,
                }),
            );
            push_instr(block, Instr::RefIsNull(RefIsNull {}));
            push_instr(
                block,
                Instr::IfElse(IfElse {
                    consequent: plain_dispatch_id,
                    alternative: throw_ref_seq_id,
                }),
            );
            outer
        };

        // Build the empty else for the outer REWIND-match guard.
        let else_id = {
            let local = local_mut(module, func_id);
            local
                .builder_mut()
                .dangling_instr_seq(InstrSeqType::Simple(None))
                .id()
        };

        // Prepend the outer guard `if state==REWINDING && cri == K`
        // to the try_table body.
        let local = local_mut(module, func_id);
        let original: Vec<(Instr, InstrLocId)> =
            std::mem::take(&mut local.block_mut(body_seq_id).instrs);
        let body = &mut local.block_mut(body_seq_id).instrs;

        push_instr(
            body,
            Instr::GlobalGet(GlobalGet {
                global: runtime.state_global,
            }),
        );
        push_instr(
            body,
            Instr::Const(Const {
                value: Value::I32(runtime::STATE_REWINDING),
            }),
        );
        push_instr(
            body,
            Instr::Binop(Binop {
                op: BinaryOp::I32Eq,
            }),
        );
        push_instr(
            body,
            Instr::LocalGet(LocalGet {
                local: catch_region_id_local,
            }),
        );
        push_instr(
            body,
            Instr::Const(Const {
                value: Value::I32(region_id as i32),
            }),
        );
        push_instr(
            body,
            Instr::Binop(Binop {
                op: BinaryOp::I32Eq,
            }),
        );
        push_instr(
            body,
            Instr::Binop(Binop {
                op: BinaryOp::I32And,
            }),
        );
        push_instr(
            body,
            Instr::IfElse(IfElse {
                consequent: dispatch_seq_id,
                alternative: else_id,
            }),
        );

        body.extend(original);
    }
}

/// Build a dangling instr_seq that performs B1 plain-catch rewind
/// dispatch. The sequence reads the saved `arm_id` from the B1 scratch
/// tuple and walks an if-chain over `arm_idx` values, throwing the
/// matching tag with operands loaded from the same tuple.
///
/// Layout of the scratch tuple (per `emit_capture_save_and_branch`):
///   +0       i32  arm_id
///   +4..     scalar operand_0, operand_1, ...
///
/// The base address is `*runtime.buf_global + runtime.b1_scratch_base
/// + slot.scratch_offset`.
fn build_plain_catch_dispatch(
    module: &mut Module,
    func_id: FunctionId,
    runtime: &Runtime,
    memory: MemoryId,
    arms: &[PlainCatchArmSlot],
) -> InstrSeqId {
    debug_assert!(!arms.is_empty());

    // We build the if-chain bottom-up: the "else" of arm[N-1] is a
    // single `unreachable` (all arm_ids exhausted); each preceding
    // arm wraps the previous chain in `if arm_id == K { throw J } else {
    // ...prev... }`.
    //
    // arm_id is stable across capture+rewind: capture writes
    // `slot.arm.arm_idx` at offset +0; we compare against the same
    // value here.

    // Innermost else: unreachable (defense; arm_id always matches one
    // of the saved arms).
    let unreachable_id = {
        let local = local_mut(module, func_id);
        let s = local
            .builder_mut()
            .dangling_instr_seq(InstrSeqType::Simple(None))
            .id();
        push_instr(
            &mut local.block_mut(s).instrs,
            Instr::Unreachable(Unreachable {}),
        );
        s
    };

    let mut chain = unreachable_id;
    for slot in arms.iter().rev() {
        // Build the "throw arm[J]" body: load operands from scratch,
        // then throw the tag.
        let throw_id = {
            let local = local_mut(module, func_id);
            local
                .builder_mut()
                .dangling_instr_seq(InstrSeqType::Simple(None))
                .id()
        };
        let scratch_off = (runtime.b1_scratch_base + slot.scratch_offset) as u64;
        // Operands start at +4 (after arm_id i32). Walk in declaration
        // order so they land on the operand stack in the order the
        // tag's params expect.
        let mut cur_off: u32 = 4;
        let operand_loads: Vec<(Instr, Instr)> = slot
            .arm
            .operand_tys
            .iter()
            .map(|&ty| {
                let abs_off = scratch_off + cur_off as u64;
                cur_off += scalar_size(ty);
                (
                    Instr::GlobalGet(GlobalGet {
                        global: runtime.buf_global,
                    }),
                    load_scalar(memory, ty, abs_off),
                )
            })
            .collect();

        let local = local_mut(module, func_id);
        let s = &mut local.block_mut(throw_id).instrs;
        for (gget, load) in operand_loads {
            push_instr(s, gget);
            push_instr(s, load);
        }
        push_instr(s, Instr::Throw(Throw { tag: slot.arm.tag }));

        // Wrap: if (load arm_id) == arm_idx { throw_id } else { chain }
        let outer_id = {
            let local = local_mut(module, func_id);
            local
                .builder_mut()
                .dangling_instr_seq(InstrSeqType::Simple(None))
                .id()
        };
        {
            let local = local_mut(module, func_id);
            let s = &mut local.block_mut(outer_id).instrs;
            // Load arm_id from scratch (offset +0 of tuple).
            push_instr(
                s,
                Instr::GlobalGet(GlobalGet {
                    global: runtime.buf_global,
                }),
            );
            push_instr(s, load_i32(memory, scratch_off));
            push_instr(
                s,
                Instr::Const(Const {
                    value: Value::I32(slot.arm.arm_idx as i32),
                }),
            );
            push_instr(
                s,
                Instr::Binop(Binop {
                    op: BinaryOp::I32Eq,
                }),
            );
            push_instr(
                s,
                Instr::IfElse(IfElse {
                    consequent: throw_id,
                    alternative: chain,
                }),
            );
        }
        chain = outer_id;
    }

    chain
}

// ----------------------------------------------------------------------
// Phase 6d — catch-handler entry capture
// ----------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
struct CatchHandlerInfo {
    catch_region_id: u32,
    exnref_slot: u32,
    body_seq: InstrSeqId,
    target_label: InstrSeqId,
    in_catch_local: LocalId,
    captured_exnref_local: LocalId,
}

fn plan_catch_ref_handlers(
    module: &mut Module,
    func_id: FunctionId,
    catch_plan: &[CatchRegionPlan],
    aux_tables: &AuxTables,
) -> Vec<CatchHandlerInfo> {
    let mut infos = Vec::new();
    if aux_tables.exnref.is_none() {
        return infos;
    }
    let exnref_ty = RefType {
        nullable: true,
        heap_type: HeapType::Abstract(AbstractHeapType::Exn),
    };

    for plan in catch_plan {
        let target_label_opt = {
            let local = match &module.funcs.get(func_id).kind {
                FunctionKind::Local(l) => l,
                _ => continue,
            };
            let (_, tt) = match find_try_table_parent_seq(local, local.entry_block(), plan.body_seq)
            {
                Some(v) => v,
                None => continue,
            };

            let mut ref_targets: HashSet<InstrSeqId> = HashSet::new();
            for c in &tt.catches {
                match c {
                    TryTableCatch::CatchRef { label, .. }
                    | TryTableCatch::CatchAllRef { label } => {
                        ref_targets.insert(*label);
                    }
                    _ => {}
                }
            }
            if ref_targets.len() != 1 {
                None
            } else {
                Some(*ref_targets.iter().next().unwrap())
            }
        };
        let target_label = match target_label_opt {
            Some(t) => t,
            None => continue,
        };

        let in_catch_local = module.locals.add(ValType::I32);
        let captured_exnref_local = module.locals.add(ValType::Ref(exnref_ty));

        infos.push(CatchHandlerInfo {
            catch_region_id: plan.catch_region_id,
            exnref_slot: plan.exnref_slot,
            body_seq: plan.body_seq,
            target_label,
            in_catch_local,
            captured_exnref_local,
        });
    }

    infos
}

fn apply_catch_ref_handlers(
    module: &mut Module,
    func_id: FunctionId,
    handlers: &[CatchHandlerInfo],
    aux_tables: &AuxTables,
) {
    let exnref_table = match aux_tables.exnref {
        Some(t) => t,
        None => return,
    };

    for info in handlers {
        let (parent_seq, original_catches, try_table_type, catch_sig_type) = {
            let local = match &module.funcs.get(func_id).kind {
                FunctionKind::Local(l) => l,
                _ => continue,
            };
            let (parent, tt) =
                match find_try_table_parent_seq(local, local.entry_block(), info.body_seq) {
                    Some(v) => v,
                    None => continue,
                };
            let catches = tt.catches.clone();
            let try_sig = local.block(info.body_seq).ty;
            let catch_sig = local.block(info.target_label).ty;
            (parent, catches, try_sig, catch_sig)
        };

        let (outer_seq_id, capture_seq_id) = {
            let local = local_mut(module, func_id);
            let cap = local.builder_mut().dangling_instr_seq(catch_sig_type).id();
            let out = local.builder_mut().dangling_instr_seq(try_table_type).id();
            (out, cap)
        };

        let new_catches: Vec<TryTableCatch> = original_catches
            .iter()
            .map(|c| match c {
                TryTableCatch::CatchRef { tag, .. } => TryTableCatch::CatchRef {
                    tag: *tag,
                    label: capture_seq_id,
                },
                TryTableCatch::CatchAllRef { .. } => TryTableCatch::CatchAllRef {
                    label: capture_seq_id,
                },
                TryTableCatch::Catch { tag, label } => TryTableCatch::Catch {
                    tag: *tag,
                    label: *label,
                },
                TryTableCatch::CatchAll { label } => TryTableCatch::CatchAll { label: *label },
            })
            .collect();

        {
            let local = local_mut(module, func_id);
            let s = &mut local.block_mut(capture_seq_id).instrs;
            push_instr(
                s,
                Instr::TryTable(TryTable {
                    seq: info.body_seq,
                    catches: new_catches,
                }),
            );
            push_instr(
                s,
                Instr::Br(Br {
                    block: outer_seq_id,
                }),
            );
        }

        {
            let local = local_mut(module, func_id);
            let s = &mut local.block_mut(outer_seq_id).instrs;
            push_instr(
                s,
                Instr::Block(Block {
                    seq: capture_seq_id,
                }),
            );
            push_instr(
                s,
                Instr::LocalTee(LocalTee {
                    local: info.captured_exnref_local,
                }),
            );
            push_instr(
                s,
                Instr::Const(Const {
                    value: Value::I32(1),
                }),
            );
            push_instr(
                s,
                Instr::LocalSet(LocalSet {
                    local: info.in_catch_local,
                }),
            );
            push_instr(
                s,
                Instr::Const(Const {
                    value: Value::I32(info.exnref_slot as i32),
                }),
            );
            push_instr(
                s,
                Instr::LocalGet(LocalGet {
                    local: info.captured_exnref_local,
                }),
            );
            push_instr(
                s,
                Instr::TableSet(TableSet {
                    table: exnref_table,
                }),
            );
            push_instr(
                s,
                Instr::Br(Br {
                    block: info.target_label,
                }),
            );
        }

        {
            let local = local_mut(module, func_id);
            let parent_instrs = &mut local.block_mut(parent_seq).instrs;
            let tt_idx = parent_instrs
                .iter()
                .position(|(i, _)| matches!(i, Instr::TryTable(tt) if tt.seq == info.body_seq))
                .expect("try_table not found in its parent");
            parent_instrs[tt_idx].0 = Instr::Block(Block { seq: outer_seq_id });
        }
    }
}

// ----------------------------------------------------------------------
// Stage 2 (B1) — per-arm capture-block emission for plain catch
// ----------------------------------------------------------------------

/// Per-region emission state for a B1 plain-catch transform: links the
/// region's try_table body to the function-local "in_catch" flag and
/// the region's id (used for setting `catch_region_id_local` at unwind
/// time).
///
/// Phase 6's `CatchHandlerInfo::in_catch_local` is allocated only for
/// regions with a catch_ref/catch_all_ref clause. For plain-catch-only
/// regions we allocate a fresh local; for mixed regions we reuse Phase
/// 6's local so `maybe_record_catch_state` continues to see a single
/// flag per region.
#[derive(Debug, Clone, Copy)]
#[allow(dead_code)] // Task 2.3 will consume these fields.
struct PlainCatchRegionInfo {
    body_seq: InstrSeqId,
    catch_region_id: u32,
    in_catch_local: LocalId,
}

/// Stage 2 (B1) — emit per-arm capture blocks that intercept plain
/// catch dispatch.
///
/// For each fork-path try_table that has at least one plain-catch arm
/// (and whose function is NOT in `b2_carveout`), this rewrites:
///
/// ```wat
/// (try_table (catch $tag $h) ... body ...)   ;; original
/// ```
/// into:
/// ```wat
/// (block $b1_outer <try_table_type>
///   (block $cap_arm_0 <tag0.params()>
///     ...
///     (block $cap_arm_N-1 <tagN-1.params()>
///       (try_table (catch $tag0 $cap_arm_0) ... (catch $tagN-1 $cap_arm_N-1) body)
///       br $b1_outer)
///     ;; cap_arm_N-1 body: tagN-1.params on stack — save, set flags, br $hN-1
///   ...
///   ;; cap_arm_0 body: tag0.params on stack — save, set flags, br $h0
/// ```
///
/// Inside each cap_arm_J body the operands are:
///   1. spilled to fresh locals (top-of-stack first).
///   2. saved as a tuple (arm_id, op_0, ..., op_M-1) at scratch slot
///      `runtime.b1_scratch_base + slot.scratch_offset`.
///   3. used to set `in_catch_local = 1` and `catch_region_id_local =
///      region_id`.
///   4. re-pushed (in declaration order) and `br $hJ` executes.
///
/// CatchAll/CatchRef/CatchAllRef clauses are preserved verbatim. If
/// Phase 6 already retargeted CatchRef/CatchAllRef clauses, those
/// retargets are passed through unchanged.
///
/// `catch_handlers` is Phase 6's per-region info; the `in_catch_local`
/// is reused for any region that overlaps with B1's emission. For
/// plain-catch-only regions, a fresh `in_catch_local` is allocated.
///
/// Returns the per-region info Task 2.3 will consume: the region_id
/// + in_catch_local pair lets `inject_rewind_throw_stubs` and
/// `maybe_record_catch_state` extend their dispatch to plain-catch-
/// only regions. Currently the caller discards the return; Task 2.3
/// will plumb it through.
#[allow(dead_code)]
fn apply_plain_catch_handlers(
    module: &mut Module,
    func_id: FunctionId,
    runtime: &Runtime,
    catch_region_id_local: LocalId,
    b1_slots: &[(InstrSeqId, Vec<PlainCatchArmSlot>)],
    catch_plan: &[CatchRegionPlan],
    catch_handlers: &[CatchHandlerInfo],
) -> Vec<PlainCatchRegionInfo> {
    let mut regions = Vec::new();
    if b1_slots.is_empty() {
        return regions;
    }
    let memory = first_memory(module);

    for (body_seq, arm_slots) in b1_slots {
        if arm_slots.is_empty() {
            continue;
        }

        // Phase 6's `apply_catch_ref_handlers` may have moved this
        // try_table inside its own capture block. `find_try_table_parent_seq`
        // walks recursively from the entry block, so the new parent
        // is discovered automatically.
        let (parent_seq, original_catches, try_table_type) = {
            let local = match &module.funcs.get(func_id).kind {
                FunctionKind::Local(l) => l,
                _ => continue,
            };
            let (parent, tt) =
                match find_try_table_parent_seq(local, local.entry_block(), *body_seq) {
                    Some(v) => v,
                    None => continue,
                };
            (parent, tt.catches.clone(), local.block(*body_seq).ty)
        };

        // Look up region_id from catch_plan (every fork-path try_table
        // gets a catch_region_id assigned in plan_and_inject_aux_tables).
        let catch_region_id = catch_plan
            .iter()
            .find(|p| p.body_seq == *body_seq)
            .map(|p| p.catch_region_id)
            .unwrap_or(0);

        // Reuse Phase 6's in_catch_local if the region overlaps; else
        // allocate a fresh one. (Mixed catch_ref+plain regions share
        // the same flag so post-call dispatch sees a single signal per
        // region.)
        let in_catch_local = catch_handlers
            .iter()
            .find(|h| h.body_seq == *body_seq)
            .map(|h| h.in_catch_local)
            .unwrap_or_else(|| module.locals.add(ValType::I32));

        regions.push(PlainCatchRegionInfo {
            body_seq: *body_seq,
            catch_region_id,
            in_catch_local,
        });

        // ----------------------------------------------------------
        // Build dangling sequences: outer + N caps.
        // Caps are ordered outer-to-inner so `cap_seq_ids[J]` is the
        // J-th outermost (and corresponds to `arm_slots[J]`). The
        // innermost cap (`cap_seq_ids[N-1]`) holds the inner try_table
        // and the `br $b1_outer` that handles normal exit.
        // ----------------------------------------------------------
        let outer_seq_id = {
            let local = local_mut(module, func_id);
            local.builder_mut().dangling_instr_seq(try_table_type).id()
        };

        // Build per-arm InstrSeqType up-front (mutates module.types)
        // before any &mut LocalFunction borrow is needed.
        let cap_types: Vec<InstrSeqType> = arm_slots
            .iter()
            .map(|slot| InstrSeqType::new(&mut module.types, &[], &slot.arm.operand_tys))
            .collect();

        let mut cap_seq_ids: Vec<InstrSeqId> = Vec::with_capacity(arm_slots.len());
        for cap_ty in &cap_types {
            let local = local_mut(module, func_id);
            cap_seq_ids.push(local.builder_mut().dangling_instr_seq(*cap_ty).id());
        }

        // Per-arm operand spill locals.
        let mut arm_spill_locals: Vec<Vec<LocalId>> = Vec::with_capacity(arm_slots.len());
        for slot in arm_slots {
            let spills: Vec<LocalId> = slot
                .arm
                .operand_tys
                .iter()
                .map(|&ty| module.locals.add(ty))
                .collect();
            arm_spill_locals.push(spills);
        }

        // ----------------------------------------------------------
        // Rewrite the inner try_table's catches: each plain Catch
        // arm now points at its capture block; everything else (incl.
        // catch_ref/catch_all_ref already retargeted by Phase 6) is
        // preserved verbatim.
        //
        // We map by arm position within `arm_slots` -- each entry's
        // `arm.arm_idx` is the arm's index in the original try_table's
        // catches list. We walk `original_catches` and substitute each
        // matching plain Catch with its capture target.
        // ----------------------------------------------------------
        let mut new_catches: Vec<TryTableCatch> = original_catches.clone();
        for (j, slot) in arm_slots.iter().enumerate() {
            let arm_idx = slot.arm.arm_idx as usize;
            if let Some(c) = new_catches.get_mut(arm_idx) {
                if let TryTableCatch::Catch { tag, .. } = c {
                    *c = TryTableCatch::Catch {
                        tag: *tag,
                        label: cap_seq_ids[j],
                    };
                }
            }
        }

        // ----------------------------------------------------------
        // Populate innermost cap (cap_seq_ids[N-1]):
        //   try_table(...)
        //   br $b1_outer
        // ----------------------------------------------------------
        //
        // D-06 fix (2026-05-14): emit_capture_save_and_branch's
        // "capture tail" (spill payload, save to scratch, set flags,
        // re-push payload, br $hJ) must run AT THE POINT WHERE
        // CONTROL ARRIVES AFTER THE CATCH — which, per wasm-EH's
        // br-to-label semantics, is OUTSIDE the cap_seq the catch
        // targeted. So arm J's capture tail belongs in
        // `cap_seq_ids[J-1]` (or `outer_seq_id` for J=0), right
        // after the `Block(cap_seq_ids[J])` that contains the catch
        // target. The pre-fix code emitted the capture tail INSIDE
        // `cap_seq_ids[J]` AFTER the `br $outer` terminator —
        // making it dead code on both paths (fall-through: br
        // terminated; catch: jumped to cap_seq[J] END, past where
        // the tail was placed). On modern wasm-EH lowering this
        // surfaced as a stack-imbalance validation error because
        // the catch payload propagated out of cap_seq[J] with no
        // capture-tail to consume it.
        //
        // Under legacy `try`/`catch`, the dispatch mechanism was
        // different (engine handled tag matching inline at the
        // catch opcode), so the bug was latent — the capture-tail
        // never ran in either case, but legacy `try`/`catch` was
        // forced to guard-dispatch which used a completely
        // different mechanism.
        let n = arm_slots.len();
        {
            let local = local_mut(module, func_id);
            let s = &mut local.block_mut(cap_seq_ids[n - 1]).instrs;
            push_instr(
                s,
                Instr::TryTable(TryTable {
                    seq: *body_seq,
                    catches: new_catches,
                }),
            );
            push_instr(
                s,
                Instr::Br(Br {
                    block: outer_seq_id,
                }),
            );
        }

        // ----------------------------------------------------------
        // Populate non-innermost caps (cap_seq_ids[J] for J < N-1):
        //   Block(cap_seq_ids[J+1])
        //   ;; cap-end body for arm J+1 — runs when arm J+1's catch
        //   ;;  fired, propagated its payload out of cap_seq[J+1],
        //   ;;  and landed here in cap_seq[J].
        // ----------------------------------------------------------
        for j in (0..n - 1).rev() {
            {
                let local = local_mut(module, func_id);
                let s = &mut local.block_mut(cap_seq_ids[j]).instrs;
                push_instr(
                    s,
                    Instr::Block(Block {
                        seq: cap_seq_ids[j + 1],
                    }),
                );
            }
            // Capture tail for arm J+1 (the arm whose catch
            // targets cap_seq[J+1]). Lives in cap_seq[J] AFTER the
            // Block(cap_seq[J+1]).
            emit_capture_save_and_branch(
                module,
                func_id,
                runtime,
                memory,
                cap_seq_ids[j],
                &arm_slots[j + 1],
                &arm_spill_locals[j + 1],
                in_catch_local,
                catch_region_id_local,
                catch_region_id,
            );
        }

        // ----------------------------------------------------------
        // Populate $b1_outer: contains the outermost cap block
        // followed by the capture tail for arm 0 (the arm whose
        // catch targets cap_seq[0]).
        //
        // On normal exit (try_table fell through → br $outer →
        // outer terminated), outer's end is never reached; the
        // capture tail is dead. On catch path for arm 0: payload
        // → cap_seq[0] end → control back in outer at position
        // after Block(cap_seq[0]) → capture tail runs → br to
        // arm 0's original handler label. On catch path for inner
        // arms (J > 0): payload → cap_seq[J] end → cap_seq[J-1]
        // post-Block(cap_seq[J]) → capture tail for arm J runs in
        // cap_seq[J-1] → br to arm J's handler label.
        // ----------------------------------------------------------
        {
            let local = local_mut(module, func_id);
            let s = &mut local.block_mut(outer_seq_id).instrs;
            push_instr(
                s,
                Instr::Block(Block {
                    seq: cap_seq_ids[0],
                }),
            );
        }
        // Capture tail for arm 0 (whose catch targets cap_seq[0]).
        // Emitted in outer_seq AFTER Block(cap_seq[0]).
        emit_capture_save_and_branch(
            module,
            func_id,
            runtime,
            memory,
            outer_seq_id,
            &arm_slots[0],
            &arm_spill_locals[0],
            in_catch_local,
            catch_region_id_local,
            catch_region_id,
        );

        // ----------------------------------------------------------
        // Replace the original TryTable in the parent seq with
        // Block($b1_outer). The TryTable now lives inside the
        // innermost cap, retargeted to the per-arm captures.
        // ----------------------------------------------------------
        {
            let local = local_mut(module, func_id);
            let parent_instrs = &mut local.block_mut(parent_seq).instrs;
            let tt_idx = parent_instrs
                .iter()
                .position(|(i, _)| matches!(i, Instr::TryTable(tt) if tt.seq == *body_seq))
                .expect("try_table not found in its parent (B1 stage 2 emission)");
            parent_instrs[tt_idx].0 = Instr::Block(Block { seq: outer_seq_id });
        }
    }

    regions
}

/// Emit the capture-block "tail" for a single plain-catch arm: at the
/// point where this is invoked, `tag.params()` are on the operand
/// stack. The emitted sequence:
///
///   1. Spill operands to per-arm locals (top-of-stack first).
///   2. Save tuple (arm_id, op_0, ..., op_M-1) to memory at
///      `b1_scratch_base + slot.scratch_offset`.
///   3. Set `in_catch_local = 1`, `catch_region_id_local = region_id`.
///   4. Re-push operands (declaration order).
///   5. `br slot.arm.label` (original handler).
fn emit_capture_save_and_branch(
    module: &mut Module,
    func_id: FunctionId,
    runtime: &Runtime,
    memory: MemoryId,
    cap_seq_id: InstrSeqId,
    slot: &PlainCatchArmSlot,
    spills: &[LocalId],
    in_catch_local: LocalId,
    catch_region_id_local: LocalId,
    catch_region_id: u32,
) {
    let local = local_mut(module, func_id);
    let s = &mut local.block_mut(cap_seq_id).instrs;

    // 1. Spill operands. Operands were declared L-to-R but appear on
    //    the stack with the LAST one on top — so we spill in reverse
    //    declaration order: spills[M-1] first, then [M-2], ..., [0].
    for i in (0..spills.len()).rev() {
        push_instr(s, Instr::LocalSet(LocalSet { local: spills[i] }));
    }

    // 2. Save arm_id at offset +0 of this arm's scratch tuple. The
    //    absolute address is `*(buf_global) + b1_scratch_base +
    //    scratch_offset`. We fold the constant offset into the
    //    MemArg.offset and push `global.get $buf_global` as the
    //    address.
    let scratch_off = (runtime.b1_scratch_base + slot.scratch_offset) as u64;
    push_instr(
        s,
        Instr::GlobalGet(GlobalGet {
            global: runtime.buf_global,
        }),
    );
    push_instr(
        s,
        Instr::Const(Const {
            value: Value::I32(slot.arm.arm_idx as i32),
        }),
    );
    push_instr(s, store_i32(memory, scratch_off));

    // 2b. Save operands at offset +4 + cumulative.
    let mut cur_off: u32 = 4;
    for (i, &ty) in slot.arm.operand_tys.iter().enumerate() {
        let abs_off = scratch_off + cur_off as u64;
        push_instr(
            s,
            Instr::GlobalGet(GlobalGet {
                global: runtime.buf_global,
            }),
        );
        push_instr(s, Instr::LocalGet(LocalGet { local: spills[i] }));
        push_instr(s, store_scalar(memory, ty, abs_off));
        cur_off += scalar_size(ty);
    }

    // 3. Set flags.
    push_instr(
        s,
        Instr::Const(Const {
            value: Value::I32(1),
        }),
    );
    push_instr(
        s,
        Instr::LocalSet(LocalSet {
            local: in_catch_local,
        }),
    );
    push_instr(
        s,
        Instr::Const(Const {
            value: Value::I32(catch_region_id as i32),
        }),
    );
    push_instr(
        s,
        Instr::LocalSet(LocalSet {
            local: catch_region_id_local,
        }),
    );

    // 4. Re-push operands in declaration order.
    for &spill in spills {
        push_instr(s, Instr::LocalGet(LocalGet { local: spill }));
    }

    // 5. Branch to original handler.
    push_instr(
        s,
        Instr::Br(Br {
            block: slot.arm.label,
        }),
    );
}

fn find_try_table_parent_seq<'a>(
    f: &'a LocalFunction,
    seq: InstrSeqId,
    body_seq: InstrSeqId,
) -> Option<(InstrSeqId, &'a TryTable)> {
    for (instr, _) in &f.block(seq).instrs {
        if let Instr::TryTable(tt) = instr {
            if tt.seq == body_seq {
                return Some((seq, tt));
            }
        }
        for child in nested_seqs(instr) {
            if let Some(v) = find_try_table_parent_seq(f, child, body_seq) {
                return Some(v);
            }
        }
    }
    None
}

// =====================================================================
// Trampoline dispatch — sub-commit 2.2 of the mega-PR
// (docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md)
// =====================================================================
//
// Note: guard-dispatch was deleted in commit 4 (2026-05-14) after the
// 2.5/2.6 sub-commits absorbed UnsupportedCarryover/MultiValueParams
// into nested switch-dispatch, commit 9's modern-EH SDK flip
// eliminated UnsupportedLegacyTry from shipping wasm, and commit 3
// replaced the two `instrument_one_function_guard_dispatch` callers
// with panics. The trampoline scaffolding below remains UNWIRED in
// shipping fork-instrument runs; it's preserved for future use if a
// new "genuinely impossible for switch-dispatch" case ever emerges.
//
// Replaces guard-dispatch as the fallback for the three classes
// switch-dispatch can't handle today:
//   (a) Nested fork-path call inside a Loop/IfElse/TryTable body that
//       `classify_nested_pattern` rejects (UnsupportedLegacyTry,
//       UnsupportedMultiValueParams, UnsupportedCarryover).
//   (b) Top-level fork-path call with operand-stack carryover.
//   (c) Nested call_indirect to a fork-path callee, in combination
//       with another unsupported pattern. (Simple nested call_indirect
//       in a loop is empirically already handled by nested switch-
//       dispatch — see crates/fork-instrument/tests/trampoline.rs's
//       `today_nested_call_indirect_uses_nested_switch_dispatch`.)
//
// Per-function dispatch table (open Q #3, resolved 2026-05-13):
// each instrumented fork-path function emits its own
// `(table $<fn>_post_table funcref)` populated with the extracted
// post-call functions for that function. Entry-point REWIND check
// does `call_indirect $<fn>_post_table (local.get $call_idx)`.
//
// State after sub-commit 2.2 (this commit): the function below is
// defined but UNREACHABLE — no caller exists. The body emission
// lands in 2.3; sub-commits 2.4 (carryover), 2.5 (call_indirect +
// pattern), 2.6 (nested unsupported) wire callers one class at a
// time. Once 2.6 ships, guard-dispatch is unreachable; commits 3-4
// verify and delete it.

/// Emit a per-function funcref dispatch table populated with the
/// extracted post-call functions for one fork-path function.
///
/// The table is sized exactly to fit `post_funcs.len()` entries,
/// named `<owner_name>_post_table`, and immediately populated via an
/// active `(elem)` segment at offset 0.
///
/// Returns the new `TableId`. Empty `post_funcs` is allowed (the
/// table is still created, with size 0 and no elem segment) — that
/// case shouldn't occur in practice (a fork-path function with zero
/// fork-path call sites wouldn't be on the trampoline path) but
/// keeping the helper total simplifies the call-site contract.
///
/// Used by `instrument_one_function_trampoline_dispatch` (sub-commits
/// 2.4-2.6) to set up the dispatch table that the entry-point REWIND
/// check `call_indirect`s into.
#[allow(dead_code)] // wired up in sub-commits 2.4-2.6
fn emit_per_function_post_table(
    module: &mut Module,
    owner_name: &str,
    post_funcs: &[FunctionId],
) -> TableId {
    let n = post_funcs.len() as u64;
    let table_id = module.tables.add_local(false, n, Some(n), RefType::FUNCREF);
    module.tables.get_mut(table_id).name = Some(format!("{owner_name}_post_table"));

    if !post_funcs.is_empty() {
        module.elements.add(
            walrus::ElementKind::Active {
                table: table_id,
                offset: walrus::ConstExpr::Value(Value::I32(0)),
            },
            walrus::ElementItems::Functions(post_funcs.to_vec()),
        );
    }

    table_id
}

/// Rewrite original-function `Local{Get,Set,Tee}` instructions in a
/// chunk to read/write a frame-resident scratch slot via the new
/// function's `frame_ptr` parameter and a per-local temp.
///
/// Given a `reify` map `[(orig_local, val_type, frame_offset)]`, the
/// function returns:
///   - the rewritten instruction sequence
///   - a `Vec<LocalId>` of the temp locals it allocated (one per
///     entry in `reify`) — to be added to the new function's
///     local list by the caller (FunctionBuilder doesn't auto-add
///     locals referenced by instructions, only ones in `args`).
///
/// Rewrites:
///   - `LocalGet $L`  → `LocalGet $frame_ptr; load_scalar T offset=K`
///   - `LocalSet $L`  → `LocalSet $tmp; LocalGet $frame_ptr;
///                       LocalGet $tmp; store_scalar T offset=K`
///   - `LocalTee $L`  → same as `LocalSet` then `LocalGet $tmp`
///
/// Locals NOT in `reify` are left unchanged (the caller is
/// responsible for either declaring them in the new function or
/// guaranteeing they don't appear).
///
/// Used by sub-commit 2.4c when wiring the trampoline for the
/// top-level carryover case: the original function's locals that
/// must survive the fork boundary get reified as frame slots; the
/// post-call function loads them from the frame on REWIND entry.
#[allow(dead_code)] // wired up in sub-commit 2.4c
fn rewrite_chunk_locals_to_frame(
    module: &mut Module,
    chunk: Vec<(Instr, InstrLocId)>,
    frame_ptr: LocalId,
    memory: MemoryId,
    reify: &[(LocalId, ValType, u32)],
) -> (Vec<(Instr, InstrLocId)>, Vec<LocalId>) {
    use std::collections::HashMap;

    // Allocate one temp local per entry in `reify`. The temp lives
    // in the new function and holds the value transiently between
    // pop-from-stack and store-to-frame (or load-from-frame and
    // re-push, for Tee).
    let mut temps: HashMap<LocalId, (LocalId, ValType, u32)> = HashMap::new();
    let mut new_locals: Vec<LocalId> = Vec::with_capacity(reify.len());
    for &(orig, ty, off) in reify {
        let tmp = module.locals.add(ty);
        temps.insert(orig, (tmp, ty, off));
        new_locals.push(tmp);
    }

    let mut out = Vec::with_capacity(chunk.len());
    for (instr, loc) in chunk {
        match instr {
            Instr::LocalGet(LocalGet { local }) if temps.contains_key(&local) => {
                let &(_tmp, ty, off) = temps.get(&local).unwrap();
                out.push((Instr::LocalGet(LocalGet { local: frame_ptr }), loc));
                out.push((load_scalar(memory, ty, off as u64), loc));
            }
            Instr::LocalSet(LocalSet { local }) if temps.contains_key(&local) => {
                let &(tmp, ty, off) = temps.get(&local).unwrap();
                out.push((Instr::LocalSet(LocalSet { local: tmp }), loc));
                out.push((Instr::LocalGet(LocalGet { local: frame_ptr }), loc));
                out.push((Instr::LocalGet(LocalGet { local: tmp }), loc));
                out.push((store_scalar(memory, ty, off as u64), loc));
            }
            Instr::LocalTee(LocalTee { local }) if temps.contains_key(&local) => {
                let &(tmp, ty, off) = temps.get(&local).unwrap();
                out.push((Instr::LocalSet(LocalSet { local: tmp }), loc));
                out.push((Instr::LocalGet(LocalGet { local: frame_ptr }), loc));
                out.push((Instr::LocalGet(LocalGet { local: tmp }), loc));
                out.push((store_scalar(memory, ty, off as u64), loc));
                out.push((Instr::LocalGet(LocalGet { local: tmp }), loc));
            }
            other => out.push((other, loc)),
        }
    }

    (out, new_locals)
}

/// Extract a sequence of instructions into a new wasm function with
/// signature `() -> ()`.
///
/// This is the minimal post-call extraction primitive. Given a chunk
/// of instructions that were originally part of some host function's
/// body, synthesise a new module-level function whose body is exactly
/// those instructions (preserving `InstrLocId` for source mapping).
///
/// **Limitation in 2.4a (this commit):** the input instructions MUST
/// be self-contained — they may NOT reference `LocalId`s from the
/// original function. Sub-commit 2.4b adds the local-rewriting pass
/// (rewrites `LocalGet/Set/Tee` to read/write a frame-resident
/// scratch slot via the function's frame_ptr param), which is the
/// piece that lets real chunks be extracted. Until then the caller
/// is responsible for guaranteeing the input is local-free.
///
/// Also: the new function's signature is hardcoded to `() -> ()`
/// here. Real post-call extraction needs a `(frame_ptr) -> ()`
/// signature so the trampoline can pass the frame pointer in.
/// 2.4b/c will adjust this.
///
/// Used by `instrument_one_function_trampoline_dispatch` (sub-commits
/// 2.4-2.6) to materialize each post-call chunk as an entry in the
/// per-function dispatch table built by `emit_per_function_post_table`.
#[allow(dead_code)] // wired up in sub-commit 2.4c
fn extract_chunk_to_function(
    module: &mut Module,
    name: &str,
    instrs: Vec<(Instr, InstrLocId)>,
) -> FunctionId {
    let mut builder = walrus::FunctionBuilder::new(&mut module.types, &[], &[]);
    builder.name(name.to_string());
    let body_id = builder.func_body_id();
    {
        let mut body = builder.instr_seq(body_id);
        body.instrs_mut().extend(instrs);
    }
    builder.finish(vec![], &mut module.funcs)
}

/// Trampoline dispatch — placeholder. Body lands in sub-commits
/// 2.4-2.6 (one class wired per sub-commit).
///
/// Same signature as `instrument_one_function_guard_dispatch` so it
/// becomes a drop-in replacement at the call sites in
/// `instrument_one_function` once each class is wired.
#[allow(clippy::too_many_arguments)]
#[allow(dead_code)] // wired up class-by-class in sub-commits 2.4-2.6
fn instrument_one_function_trampoline_dispatch(
    _module: &mut Module,
    _func_id: FunctionId,
    _runtime: &Runtime,
    _fork_path: &HashSet<FunctionId>,
    _func_ordinal: u32,
    _aux_tables: &AuxTables,
    _ref_plan: &[RefLocalSlot],
    _catch_plan: &[CatchRegionPlan],
    _b1_slots: &[(InstrSeqId, Vec<PlainCatchArmSlot>)],
) {
    unimplemented!(
        "trampoline emission lands in sub-commits 2.4-2.6 of the mega-PR; \
         this function is currently unreachable — see the section \
         comment above for the rollout plan"
    );
}

#[allow(clippy::too_many_arguments)]
// ======================================================================
// Nested per-block switch-dispatch (Path A from
// memory/fork-instrument-O2-bug-investigation.md)
// ======================================================================
//
// When a function has fork-path calls nested inside a
// `Block`/`IfElse`/`Loop`/`TryTable` body, today's
// `instrument_one_function_guard_dispatch` replays the function body
// top-to-bottom on REWIND with side-effect ops gated. That replay can
// diverge from NORMAL flow when a gated `LocalTee` pushes the default
// value (0) instead of the value being teed, or similar. The
// divergence makes downstream control flow take a different path on
// REWIND, silently skipping the kernel_fork wrap (popen hangs).
//
// This transform restructures the body so REWIND never re-executes
// pre-call code: each sequence containing fork-path calls (transitively)
// gets its own per-block dispatch. The function-level dispatch maps
// each `call_idx` to either a direct `POST_K` (for top-level calls) or
// a `POST_J_ENTER` label positioned right before a sub-region's
// enclosing instruction. Sub-regions then dispatch internally.
//
// For IfElse, the `cond` is rewritten via wasm `select` so that on
// REWIND with a `call_idx` in this if's range, the branch containing
// the active call is force-entered WITHOUT re-evaluating the original
// `cond` expression. The original cond is spilled into
// `cond_swap_local` at the end of the chunk inside POST_K, then read
// back via `local.get` in the post-call sequence.
//
// MVP supported nesting: `Block` (any result type), `IfElse`,
// `Loop`, `TryTable` body. Unsupported (routes to guard-dispatch):
// legacy `Try`, multi-value-params blocks, sub-region landings whose
// preceding chunk has a stack carryover.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NestedSupportStatus {
    Supported,
    UnsupportedLegacyTry,
    /// Sub-commit 2.6c: no longer produced — multi-value-params
    /// SubRegions now route to nested switch-dispatch via the body-
    /// param prespill + reload mechanism in `transform_region_seq`.
    /// Kept as a documented enum variant for future defensive use
    /// (e.g., if a shape regression appears).
    #[allow(dead_code)]
    UnsupportedMultiValueParams,
    UnsupportedCarryover,
}

impl NestedSupportStatus {
    fn is_supported(self) -> bool {
        matches!(self, NestedSupportStatus::Supported)
    }
}

/// Classify a function's nesting pattern. MVP scope: returns
/// `Supported` iff every fork-path call in the function lives inside a
/// chain of `Block` bodies only (any depth), no enclosing `IfElse` /
/// `Loop` / `TryTable` / legacy `Try`, no multi-value-params blocks,
/// no nested-seq stack carryovers.
///
/// This narrow scope handles the popen-class regression — popen's
/// `__fork` and `posix_spawn` reach `kernel_fork` through `block`
/// nesting (no IfElse around the fork-path call). Functions with
/// IfElse-around-fork-call still fall back to guard-dispatch (today's
/// behavior); that's a known divergence-bug exposure but is not the
/// pattern that hangs popen on this branch.
fn classify_nested_pattern(
    module: &Module,
    func_id: FunctionId,
    fork_path: &HashSet<FunctionId>,
) -> NestedSupportStatus {
    let local = match &module.funcs.get(func_id).kind {
        FunctionKind::Local(l) => l,
        _ => return NestedSupportStatus::Supported,
    };
    let status = classify_seq(module, local, local.entry_block(), fork_path);
    if !status.is_supported() {
        return status;
    }

    // Sub-commit 2.5c (2026-05-14): direct fork-path call landings
    // with operand-stack carryovers are absorbed by nested switch-
    // dispatch via the per-call carryover-spilling extension wired in
    // 2.5b. The carryover types must be statically determinable —
    // fall back to guard-dispatch when the analyser can't type them,
    // mirroring the policy used by top-level switch-dispatch's 2.4c
    // gate in `instrument_one_function`. The seq-level check in
    // `seq_has_unsupported_carryover` no longer rejects these;
    // function-level here is the appropriate granularity (the
    // analyser needs the whole function's call_idx assignment to
    // produce its result).
    if compute_nested_carryover_types(module, func_id, fork_path).is_none() {
        return NestedSupportStatus::UnsupportedCarryover;
    }

    NestedSupportStatus::Supported
}

fn classify_seq(
    module: &Module,
    f: &LocalFunction,
    seq: InstrSeqId,
    fork_path: &HashSet<FunctionId>,
) -> NestedSupportStatus {
    let carryover = seq_has_unsupported_carryover(module, f, seq, fork_path);
    if carryover {
        return NestedSupportStatus::UnsupportedCarryover;
    }

    for (instr, _) in &f.block(seq).instrs {
        match instr {
            Instr::Loop(_) | Instr::Block(_) | Instr::IfElse(_) | Instr::TryTable(_) => {
                // Allowed. Loops, blocks, ifs, and try_tables are
                // handled by per-block dispatch inside their body.
                // For IfElse, the cond rewrite via `select` selects
                // between original cond (NORMAL) and force-flag
                // (REWIND).  Try_table catches branch to outer
                // labels — fork-path calls reachable only via a
                // catch (fork-from-catch) are still unsupported, but
                // are detected separately as "carryover" / "unknown
                // stack-effect" patterns and routed to guard-dispatch.
            }
            Instr::Try(t) => {
                // Legacy try bodies follow the same nested-switch route
                // as block/loop/try_table bodies. Legacy catch handlers
                // remain unsupported because REWIND cannot re-enter a
                // handler without reconstructing the exception path.
                for c in &t.catches {
                    let handler = match c {
                        LegacyCatch::Catch { handler, .. } => Some(*handler),
                        LegacyCatch::CatchAll { handler } => Some(*handler),
                        LegacyCatch::Delegate { .. } => None,
                    };
                    if let Some(h) = handler {
                        if subtree_contains_fork_call(f, h, fork_path) {
                            return NestedSupportStatus::UnsupportedLegacyTry;
                        }
                    }
                }
            }
            _ => {}
        }
        for child in nested_seqs(instr) {
            // Sub-commit 2.6c (2026-05-14): multi-value-params
            // SubRegions are now absorbed by nested switch-dispatch
            // via the typed `CarryoverPlan::spill_locals` machinery
            // (2.6a/2.6b). The Block's declared type-params are
            // spilled at the chunk tail (like any other carryover)
            // and pushed back BEFORE the SubRegion runs at
            // emit_post_landing. The function-level
            // `UnsupportedMultiValueParams` rejection here is gone.
            let status = classify_seq(module, f, child, fork_path);
            if !status.is_supported() {
                return status;
            }
        }
    }
    NestedSupportStatus::Supported
}

fn subtree_contains_fork_call(
    f: &LocalFunction,
    seq: InstrSeqId,
    fork_path: &HashSet<FunctionId>,
) -> bool {
    for (instr, _) in &f.block(seq).instrs {
        match instr {
            Instr::Call(c) if fork_path.contains(&c.func) => return true,
            Instr::CallIndirect(_) => return true,
            _ => {}
        }
        for child in nested_seqs(instr) {
            if subtree_contains_fork_call(f, child, fork_path) {
                return true;
            }
        }
    }
    false
}

/// Returns true iff `seq` contains a fork-path landing (direct call
/// or sub-region whose nested seq is fork-bearing) whose pre-landing
/// stack has a carryover — extra values left on the stack from before
/// the chunk's start that aren't part of the landing's required
/// inputs. Per-block dispatch's `POST_K` blocks are typed `Simple(None)`
/// (0 → 0), so carryovers can't be expressed.
///
/// "Required inputs" per landing:
///   - Direct fork-path Call: the call's params count.
///   - CallIndirect: params + 1 (the table index).
///   - Block / Loop / TryTable: 0 (we already reject multi-value
///     params blocks elsewhere in classify_nested_pattern).
///   - IfElse: 1 (the cond).
///
/// ## Known unfixed case: `tests/sortix/os-test/basic/spawn/posix_spawnattr_setpgroup` -O2
///
/// LLVM-O2 inlines `posix_spawn` into `main` and emits a sub-region
/// carryover at the `kernel_fork`-bearing block:
///
/// ```text
/// local.get 0           ;; push __errno_location() — carryover
/// block (result i32)    ;; the block contains kernel_fork
///   ... kernel_fork wrap ...
/// end
/// local.tee 1           ;; save posix_spawn return value
/// i32.store             ;; *errno_location = posix_spawn_rc — consumes both
/// ```
///
/// We currently route this to **guard-dispatch** (because
/// switch-dispatch's `POST_K` blocks are 0 → 0 and can't express the
/// carryover). On `-O0`/`-O1` the function passes; on `-O2` it fails
/// with `waitpid: ECHILD` because the parent's local `pid` ends up at
/// 0 instead of the child's pid. The `pid` write happens through the
/// `&pid` pointer inside the inlined `posix_spawn` body, after the
/// kernel_fork rewind handshake — but some divergence specific to the
/// `-O2` shape causes that write not to take effect on the parent's
/// REWIND path.
///
/// We **expected guard-dispatch + the c01554940 non-fork-path-call
/// gate + the LocalTee identity-passthrough fix to handle this case**,
/// but multiple sessions of debugging haven't pinned down the exact
/// divergence; the bug is highly LLVM-codegen-sensitive (adding a
/// single `fprintf`/`fflush` at the right spot makes it pass). The
/// current best understanding is that some pre-call op leaves the
/// stack or shadow-stack in a state that REWIND replay diverges from
/// NORMAL, despite all the targeted fixes.
///
/// **Next step:** the proper fix is to extend per-block switch-dispatch
/// to handle carryovers at sub-region landings via local-spilling
/// (allocate spill locals, push values from carryover into them
/// before the enclosing instruction, reload after) — that takes the
/// function off the guard-dispatch path entirely and avoids the
/// divergence. Implementation begins immediately below; see
/// `partition_region_instrs` and `emit_chunk_tail_for_landing`.
///
/// **It remains worth revisiting whether guard-dispatch could be
/// fixed for this case in the future** — a successful guard-dispatch
/// solution would cover any other LLVM-codegen-sensitive carryover
/// shape we discover later, not just the ones that fit the
/// switch-dispatch carryover-spilling extension.
#[allow(dead_code)]
fn seq_has_direct_fork_carryover(
    module: &Module,
    f: &LocalFunction,
    seq: InstrSeqId,
    fork_path: &HashSet<FunctionId>,
) -> bool {
    let mut depth: usize = 0;
    for (instr, _) in &f.block(seq).instrs {
        // Check direct fork-path call landings.
        let direct_expected: Option<usize> = match instr {
            Instr::Call(c) if fork_path.contains(&c.func) => Some(
                module
                    .types
                    .get(module.funcs.get(c.func).ty())
                    .params()
                    .len(),
            ),
            Instr::CallIndirect(ci) => Some(module.types.get(ci.ty).params().len() + 1),
            _ => None,
        };
        if let Some(expected) = direct_expected {
            if depth > expected {
                return true;
            }
        }

        // Check sub-region landings: any enclosing instruction whose
        // nested seq's subtree contains a fork-path call (so the
        // partition would emit a SubRegion landing for it).
        let is_subregion_landing = match instr {
            Instr::Block(_)
            | Instr::Loop(_)
            | Instr::TryTable(_)
            | Instr::Try(_)
            | Instr::IfElse(_) => nested_seqs(instr)
                .iter()
                .any(|s| subtree_contains_fork_call(f, *s, fork_path)),
            _ => false,
        };
        if is_subregion_landing {
            let subregion_expected = match instr {
                Instr::IfElse(_) => 1,
                _ => 0,
            };
            if depth > subregion_expected {
                return true;
            }
        }

        match top_level_stack_effect(module, f, instr) {
            StackEffect::Delta { pops, pushes } => {
                if depth < pops {
                    return true;
                }
                depth = depth - pops + pushes;
            }
            StackEffect::Terminator => return false,
            StackEffect::Unknown => return true,
        }
    }
    false
}

/// Like `seq_has_direct_fork_carryover` but only flags carryovers
/// that the per-block switch-dispatch transform can NOT handle via
/// local-spilling. Currently: every carryover except a 1-i32 stack
/// item at a SubRegion (non-IfElse) landing whose enclosing
/// instruction produces 0 or 1 i32 result.
///
/// MVP rationale: in C-emitted wasm at -O2, the most common carryover
/// pattern is `local.get $ptr; block (result i32) { ... fork ... };
/// local.tee; i32.store` — a single i32 (typically a pointer) pushed
/// before a fork-bearing block and consumed after. We spill the i32
/// via `local.set $carryover_local` at the chunk tail, then reload it
/// after the block runs (juggling with a `tmp_result_local` if the
/// block produces an i32 result).
///
/// Wider carryover patterns (multi-value, non-i32 types, carryovers at
/// DirectCall landings) still reject; extending support is
/// straightforward but not needed for the cases we've seen so far.
fn seq_has_unsupported_carryover(
    module: &Module,
    f: &LocalFunction,
    seq: InstrSeqId,
    fork_path: &HashSet<FunctionId>,
) -> bool {
    // Sub-commit 2.6c: a Block/Loop/TryTable body with declared
    // type-params enters with those values already on the seq's
    // local operand stack. Initialise `depth` accordingly so the
    // walker doesn't underflow on the very first arithmetic op that
    // consumes them.
    let mut depth: usize = match f.block(seq).ty {
        InstrSeqType::MultiValue(ty_id) => module.types.get(ty_id).params().len(),
        _ => 0,
    };
    for (instr, _) in &f.block(seq).instrs {
        // Sub-commit 2.5c (2026-05-14): direct fork-path call landings
        // with operand-stack carryovers are now absorbed by nested
        // switch-dispatch via the carryover-spilling extension (see
        // `compute_nested_carryover_types` + the per-call
        // `carryover_spills` wiring in `instrument_one_function_nested_switch`).
        // The function-level fallback for shapes the analyser can't
        // statically type lives at `classify_nested_pattern`. No
        // per-seq direct-call rejection here.

        // Sub-region landings.
        let is_subregion = match instr {
            Instr::Block(_)
            | Instr::Loop(_)
            | Instr::TryTable(_)
            | Instr::Try(_)
            | Instr::IfElse(_) => nested_seqs(instr)
                .iter()
                .any(|s| subtree_contains_fork_call(f, *s, fork_path)),
            _ => false,
        };
        if is_subregion {
            let is_ifelse = matches!(instr, Instr::IfElse(_));
            // Sub-commit 2.6b: a SubRegion's `expected_input` includes
            // both the cond (for IfElse) AND any declared type-params
            // (for multi-value-params Block/Loop/TryTable). Values
            // beyond that are real "extra carryover" above the params.
            // The 2.6a analyser spills both bands uniformly into
            // `CarryoverPlan::spill_locals`, so multi-value-params
            // SubRegions are no longer rejected — their params are
            // just one source of spill values.
            let subregion_params = subregion_input_param_count(module, f, instr);
            let expected_input: usize = if is_ifelse { 1 } else { subregion_params };
            let carryover_depth = depth.saturating_sub(expected_input);
            if carryover_depth > 0 {
                // Otherwise: this is a supported extra-carryover
                // (possibly combined with multi-value params, both
                // spilled together by 2.6a's analyser).
            }
        }

        match top_level_stack_effect(module, f, instr) {
            StackEffect::Delta { pops, pushes } => {
                if depth < pops {
                    return true;
                }
                depth = depth - pops + pushes;
            }
            StackEffect::Terminator => return false,
            StackEffect::Unknown => return true,
        }
    }
    false
}

/// Sub-commit 2.6b: count the declared type-params of a SubRegion
/// (Block/Loop/TryTable). Returns 0 for simple (non-multi-value)
/// signatures, and 0 for non-SubRegion instructions.
fn subregion_input_param_count(module: &Module, f: &LocalFunction, instr: &Instr) -> usize {
    let body_seq = match instr {
        Instr::Block(b) => Some(b.seq),
        Instr::Loop(l) => Some(l.seq),
        Instr::TryTable(t) => Some(t.seq),
        Instr::Try(t) => Some(t.seq),
        _ => None,
    };
    let Some(seq) = body_seq else {
        return 0;
    };
    match f.block(seq).ty {
        InstrSeqType::MultiValue(ty_id) => module.types.get(ty_id).params().len(),
        _ => 0,
    }
}

/// For each non-IfElse SubRegion landing in a fork-bearing seq,
/// returns the full Vec<ValType> of values to spill at that landing —
/// covering BOTH the SubRegion's type-params (consumed on entry) AND
/// any extra carryover values above the params on the parent stack.
///
/// Sub-commit 2.6a: replaces the depth-only analyser for SubRegion
/// landings. Allows multi-value-params SubRegions (Block/Loop/TryTable
/// with `(func (param ...) (result ...))` type signature) to route
/// through nested switch-dispatch — their params are spilled at the
/// chunk tail like any other carryover and pushed back before the
/// SubRegion runs at emit_post_landing.
///
/// Returned shape: one entry per landing in the same order as
/// `partition_region_instrs`. Entries are:
/// - DirectCall: empty Vec (DirectCall carryovers go through the
///   call_idx-keyed `compute_nested_carryover_types` analyser from
///   sub-commit 2.5a).
/// - SubRegion (non-IfElse): the full spill ValType list (params first
///   for the SubRegion's own input requirements, then extra carryover
///   above; both ordered deepest-stack-first as they would appear on
///   the parent stack just before the SubRegion instr).
/// - SubRegionIfElse: the full spill ValType list, where the last
///   value is the original condition and preceding values are restored
///   as carryovers below the condition.
///
/// Returns `None` if any producer in this seq pushes a value whose
/// type can't be statically determined AND that value ends up in a
/// SubRegion's spill list. Producers that push unknown-type values
/// consumed before any SubRegion landing are harmless.
fn analyze_subregion_spill_types(
    module: &Module,
    f: &LocalFunction,
    seq: InstrSeqId,
    fork_path: &HashSet<FunctionId>,
    direct_idxs_at_this_seq: &[u32],
    regions: &HashMap<InstrSeqId, RegionInfo>,
) -> Option<Vec<Vec<ValType>>> {
    let mut out: Vec<Vec<ValType>> = Vec::new();
    // Sub-commit 2.6c: nested seqs with type-params enter with those
    // values on the body's local stack — initialise the typed stack
    // accordingly. Without this, multi-value-params Block/Loop/
    // TryTable bodies would have the walker underflow at their first
    // body-instr that consumes a param.
    let mut stack: Vec<Option<ValType>> = match f.block(seq).ty {
        InstrSeqType::MultiValue(ty_id) => module
            .types
            .get(ty_id)
            .params()
            .iter()
            .map(|&t| Some(t))
            .collect(),
        _ => Vec::new(),
    };
    let mut direct_cursor = 0usize;

    fn snapshot(slots: &[Option<ValType>]) -> Option<Vec<ValType>> {
        slots.iter().copied().collect::<Option<Vec<ValType>>>()
    }

    for (instr, _) in &f.block(seq).instrs {
        // Is this a fork-path direct landing?
        let is_fork_landing = match instr {
            Instr::Call(c) => fork_path.contains(&c.func),
            Instr::CallIndirect(_) => true,
            _ => false,
        };
        if is_fork_landing && direct_cursor < direct_idxs_at_this_seq.len() {
            // DirectCall — empty spill list at this landing.
            out.push(Vec::new());
            direct_cursor += 1;
        } else {
            // Detect a SubRegion landing (any enclosing instr whose
            // nested seq is a fork-bearing region).
            let mut is_subregion_landing = false;
            let is_ifelse = matches!(instr, Instr::IfElse(_));
            if is_ifelse {
                if let Instr::IfElse(ie) = instr {
                    if regions.contains_key(&ie.consequent) || regions.contains_key(&ie.alternative)
                    {
                        is_subregion_landing = true;
                    }
                }
            } else {
                for child in nested_seqs(instr) {
                    if regions.contains_key(&child) {
                        is_subregion_landing = true;
                        break;
                    }
                }
            }
            if is_subregion_landing {
                // Spill list = the full current parent stack
                // (deepest-first). For Block/Loop/TryTable/Try, the
                // SubRegion consumes its declared type-params from the
                // top and any extra values beneath stay carryover. For
                // IfElse, the top slot is the original condition; values
                // beneath it are restored before the selected condition
                // is pushed back.
                let snap = snapshot(&stack)?;
                out.push(snap);
            }
        }

        // Advance the typed stack. Same logic as
        // `walk_seq_for_carryovers` — known producers push `Some(ty)`,
        // unknown producers push `None`. Fork-path Call/CallIndirect
        // pops args and pushes typed results.
        match instr {
            Instr::Call(c) if fork_path.contains(&c.func) => {
                let sig = module.types.get(module.funcs.get(c.func).ty());
                let n_args = sig.params().len();
                if stack.len() < n_args {
                    return None;
                }
                stack.truncate(stack.len() - n_args);
                for &ty in sig.results() {
                    stack.push(Some(ty));
                }
                continue;
            }
            Instr::CallIndirect(ci) => {
                let sig = module.types.get(ci.ty);
                let n_args = sig.params().len() + 1;
                if stack.len() < n_args {
                    return None;
                }
                stack.truncate(stack.len() - n_args);
                for &ty in sig.results() {
                    stack.push(Some(ty));
                }
                continue;
            }
            _ => {}
        }

        match top_level_stack_effect(module, f, instr) {
            StackEffect::Delta { pops, pushes } => {
                if stack.len() < pops {
                    return None;
                }
                let pre_stack = stack.clone();
                stack.truncate(stack.len() - pops);
                if pushes == 0 {
                    continue;
                }
                match instr {
                    Instr::Call(c) => {
                        let sig = module.types.get(module.funcs.get(c.func).ty());
                        for &ty in sig.results() {
                            stack.push(Some(ty));
                        }
                        continue;
                    }
                    Instr::CallRef(cr) => {
                        let sig = module.types.get(cr.ty);
                        for _ in sig.results() {
                            stack.push(None);
                        }
                        continue;
                    }
                    Instr::Block(b) => {
                        push_structured_results(&mut stack, module, f, b.seq, pushes);
                        continue;
                    }
                    Instr::Loop(l) => {
                        push_structured_results(&mut stack, module, f, l.seq, pushes);
                        continue;
                    }
                    Instr::IfElse(ie) => {
                        push_structured_results(&mut stack, module, f, ie.consequent, pushes);
                        continue;
                    }
                    Instr::TryTable(t) => {
                        push_structured_results(&mut stack, module, f, t.seq, pushes);
                        continue;
                    }
                    Instr::Try(t) => {
                        push_structured_results(&mut stack, module, f, t.seq, pushes);
                        continue;
                    }
                    _ => {}
                }
                debug_assert_eq!(pushes, 1);
                stack.push(typed_single_push(module, instr, &pre_stack));
            }
            StackEffect::Terminator => return Some(out),
            StackEffect::Unknown => return None,
        }
    }

    Some(out)
}

fn has_fork_call_in_catch_handler(
    module: &Module,
    func_id: FunctionId,
    fork_path: &HashSet<FunctionId>,
) -> bool {
    let local = match &module.funcs.get(func_id).kind {
        FunctionKind::Local(l) => l,
        _ => return false,
    };
    fn walk(f: &LocalFunction, seq: InstrSeqId, fork_path: &HashSet<FunctionId>) -> bool {
        for (instr, _) in &f.block(seq).instrs {
            if let Instr::TryTable(tt) = instr {
                for c in &tt.catches {
                    let handler = match c {
                        TryTableCatch::Catch { label, .. }
                        | TryTableCatch::CatchAll { label }
                        | TryTableCatch::CatchRef { label, .. }
                        | TryTableCatch::CatchAllRef { label } => *label,
                    };
                    // try_table catch labels target an enclosing block,
                    // so a fork call in the body of THAT block is a
                    // fork-from-catch candidate. We approximate: if the
                    // handler label is reachable from a fork-path call
                    // in the function. Since walrus IR doesn't easily
                    // give us "code AT label X", we rely on the simpler
                    // existing detection in classify_nested_pattern
                    // which flags TryTable bodies; if you got here via
                    // the fall-through guard-dispatch path, B1 status
                    // is already known. Here we conservatively return
                    // false — let guard-dispatch handle (today's
                    // behavior).
                    let _ = handler;
                }
            }
            for child in nested_seqs(instr) {
                if walk(f, child, fork_path) {
                    return true;
                }
            }
        }
        false
    }
    walk(local, local.entry_block(), fork_path)
}

// --- Discovery: walk the function in DFS order, assigning call_idx --

#[derive(Debug, Clone, Copy)]
enum NestedTarget {
    Direct(FunctionId),
    Indirect { table: TableId },
}

#[derive(Debug, Clone)]
struct NestedCallSite {
    call_idx: u32,
    seq_id: InstrSeqId,
    target: NestedTarget,
    sig_ty: TypeId,
    loc: InstrLocId,
}

#[derive(Debug, Clone)]
struct RegionInfo {
    /// `call_idx_lo..=call_idx_hi`: contiguous since DFS-ordered.
    range_lo: u32,
    range_hi: u32,
}

/// Walk the function in DFS order and:
///   - assign a `call_idx` to every fork-path Call/CallIndirect site,
///   - record which seq directly contains each call,
///   - compute, for every seq, the set of call_idxs in its subtree.
fn discover_calls_and_regions(
    module: &Module,
    func_id: FunctionId,
    fork_path: &HashSet<FunctionId>,
) -> (Vec<NestedCallSite>, HashMap<InstrSeqId, RegionInfo>) {
    let local = match &module.funcs.get(func_id).kind {
        FunctionKind::Local(l) => l,
        _ => return (Vec::new(), HashMap::new()),
    };
    let mut sites = Vec::new();
    let mut by_seq: HashMap<InstrSeqId, Vec<u32>> = HashMap::new();
    let mut next_idx: u32 = 0;
    walk_discover(
        module,
        local,
        local.entry_block(),
        fork_path,
        &mut sites,
        &mut by_seq,
        &mut next_idx,
    );
    let mut regions: HashMap<InstrSeqId, RegionInfo> = HashMap::new();
    for (seq_id, call_idxs) in by_seq {
        if call_idxs.is_empty() {
            continue;
        }
        let lo = *call_idxs.first().unwrap();
        let hi = *call_idxs.last().unwrap();
        regions.insert(
            seq_id,
            RegionInfo {
                range_lo: lo,
                range_hi: hi,
            },
        );
    }
    (sites, regions)
}

fn walk_discover(
    module: &Module,
    f: &LocalFunction,
    seq: InstrSeqId,
    fork_path: &HashSet<FunctionId>,
    sites: &mut Vec<NestedCallSite>,
    by_seq: &mut HashMap<InstrSeqId, Vec<u32>>,
    next_idx: &mut u32,
) {
    let mut my_idxs: Vec<u32> = Vec::new();
    for (instr, loc) in &f.block(seq).instrs {
        match instr {
            Instr::Call(c) if fork_path.contains(&c.func) => {
                let idx = *next_idx;
                *next_idx += 1;
                sites.push(NestedCallSite {
                    call_idx: idx,
                    seq_id: seq,
                    target: NestedTarget::Direct(c.func),
                    sig_ty: module.funcs.get(c.func).ty(),
                    loc: *loc,
                });
                my_idxs.push(idx);
            }
            Instr::CallIndirect(ci) => {
                let idx = *next_idx;
                *next_idx += 1;
                sites.push(NestedCallSite {
                    call_idx: idx,
                    seq_id: seq,
                    target: NestedTarget::Indirect { table: ci.table },
                    sig_ty: ci.ty,
                    loc: *loc,
                });
                my_idxs.push(idx);
            }
            _ => {}
        }
        for child in nested_seqs(instr) {
            walk_discover(module, f, child, fork_path, sites, by_seq, next_idx);
        }
    }
    // After visiting children, gather subtree call_idxs into this seq's
    // entry. The DFS order guarantees they're contiguous.
    let lo = my_idxs.first().copied();
    let hi_self = my_idxs.last().copied();
    let mut subtree: Vec<u32> = my_idxs;
    // Re-walk to add child sub-tree call_idxs that were registered in
    // by_seq during the child recursion. We sort+dedup at the end.
    for (instr, _) in &f.block(seq).instrs {
        for child in nested_seqs(instr) {
            if let Some(child_calls) = by_seq.get(&child) {
                subtree.extend_from_slice(child_calls);
            }
        }
    }
    subtree.sort();
    subtree.dedup();
    let _ = (lo, hi_self);
    if !subtree.is_empty() {
        by_seq.insert(seq, subtree);
    }
}

// --- The main transform ----------------------------------------------

#[allow(clippy::too_many_arguments)]
fn instrument_one_function_nested_switch(
    module: &mut Module,
    func_id: FunctionId,
    runtime: &Runtime,
    fork_path: &HashSet<FunctionId>,
    func_ordinal: u32,
    aux_tables: &AuxTables,
    ref_plan: &[RefLocalSlot],
    catch_plan: &[CatchRegionPlan],
    b1_slots: &[(InstrSeqId, Vec<PlainCatchArmSlot>)],
) {
    // Pre-existing user locals.
    let all_user_locals = collect_user_locals(module, func_id);
    let user_scalar_locals: Vec<(LocalId, ValType)> = all_user_locals
        .iter()
        .copied()
        .filter(|(_, ty)| is_scalar(*ty))
        .collect();

    // Discover all fork-path call sites (with assigned call_idxs in
    // DFS order) and the per-seq region info.
    let (sites, regions) = discover_calls_and_regions(module, func_id, fork_path);
    let n_calls = sites.len();
    if n_calls == 0 {
        // Defensive: function should have at least one fork-path call
        // by virtue of being in fork_path. Bail out to existing
        // top-level switch-dispatch (which handles n_calls==0 cleanly).
        instrument_one_function_switch(
            module,
            func_id,
            runtime,
            fork_path,
            func_ordinal,
            aux_tables,
            ref_plan,
            catch_plan,
            b1_slots,
        );
        return;
    }

    // Compute, for each fork-bearing seq, the call_idxs of its DIRECT
    // fork-path calls (ordered by DFS, == order in `sites`). Used by
    // argument materialization, the carryover pre-pass, and the
    // transform loops below.
    let direct_idxs_per_seq: HashMap<InstrSeqId, Vec<u32>> = {
        let mut m: HashMap<InstrSeqId, Vec<u32>> = HashMap::new();
        for site in &sites {
            m.entry(site.seq_id).or_default().push(site.call_idx);
        }
        m
    };

    // Plan per-call argument materialization before allocating the
    // frame. Pure scalar argument tails are replayed after POST_K;
    // all other shapes keep the existing frame-backed spill locals.
    let mut pending_arg_materializations: HashMap<u32, PendingCallArgMaterialization> =
        HashMap::new();
    {
        let local_ro = match &module.funcs.get(func_id).kind {
            FunctionKind::Local(l) => l,
            _ => panic!("expected local function"),
        };
        let empty_idxs: Vec<u32> = Vec::new();
        for &seq_id in direct_idxs_per_seq.keys() {
            let direct = direct_idxs_per_seq.get(&seq_id).unwrap_or(&empty_idxs);
            let original = &local_ro.block(seq_id).instrs;
            let (chunks, landings) =
                partition_region_instrs(local_ro, original, direct, &regions, fork_path);
            for (landing_idx, landing) in landings.iter().enumerate() {
                let LandingKind::DirectCall { call_idx } = &landing.kind else {
                    continue;
                };
                let call_idx = *call_idx;
                let site = sites
                    .iter()
                    .find(|site| site.call_idx == call_idx)
                    .expect("call_idx must have a discovered site");
                let arg_types = nested_call_arg_types(module, site);
                for &ty in &arg_types {
                    if !is_scalar(ty) {
                        let name = func_name(module, func_id);
                        panic!(
                            "fork-instrument: function `{name}` has a nested fork-path call \
                     with a ref-typed argument ({ty:?}). Aux-table arg spilling \
                     is not yet supported in the nested per-block transform."
                        );
                    }
                }
                pending_arg_materializations.insert(
                    call_idx,
                    plan_call_arg_materialization(module, &chunks[landing_idx], arg_types),
                );
            }
        }
    }
    let mut arg_materializations: HashMap<u32, CallArgMaterialization> = HashMap::new();
    for site in &sites {
        let pending = pending_arg_materializations
            .remove(&site.call_idx)
            .unwrap_or_else(|| PendingCallArgMaterialization::Spill {
                arg_types: nested_call_arg_types(module, site),
            });
        arg_materializations.insert(
            site.call_idx,
            allocate_call_arg_materialization(module, pending),
        );
    }

    // Sub-commit 2.5b: per-call operand-stack carryovers at direct
    // fork-path call landings inside any fork-bearing seq. Mirrors
    // 2.4c's carryover_spills wiring at top-level switch-dispatch:
    // at each call site, after popping the args, also pop the
    // carryover values into per-call carryover spill locals. They
    // round-trip through the fork frame so REWIND can reload them
    // beneath the call's result.
    //
    // `compute_nested_carryover_types` may return `None` for shapes
    // it can't statically type. Until sub-commit 2.5c flips the
    // rejection in `seq_has_unsupported_carryover`, the only seqs
    // that actually reach this point have already passed that check,
    // so `None` here is unexpected — but we treat it identically to
    // "no carryovers at any call" for safety (matches 2.4c behavior).
    let nested_carryover_types: HashMap<u32, Vec<ValType>> =
        compute_nested_carryover_types(module, func_id, fork_path).unwrap_or_default();
    let mut carryover_spills: HashMap<u32, Vec<LocalId>> = HashMap::new();
    for site in &sites {
        let cr_types: &[ValType] = nested_carryover_types
            .get(&site.call_idx)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let spills: Vec<LocalId> = cr_types.iter().map(|&ty| module.locals.add(ty)).collect();
        carryover_spills.insert(site.call_idx, spills);
    }

    // Combined scalar locals for the function frame: existing user
    // scalars + frame-backed per-call arg-spill locals (in call_idx
    // order) + per-call carryover-spill locals (in call_idx order;
    // sub-commit 2.5b).
    let mut frame_scalars: Vec<(LocalId, ValType)> = user_scalar_locals.clone();
    for site in &sites {
        let arg_types = nested_call_arg_types(module, site);
        for (&lid, &ty) in arg_materializations[&site.call_idx]
            .spill_locals()
            .iter()
            .zip(arg_types.iter())
        {
            frame_scalars.push((lid, ty));
        }
    }
    for site in &sites {
        let cr_types: &[ValType] = nested_carryover_types
            .get(&site.call_idx)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        for (&lid, &ty) in carryover_spills[&site.call_idx].iter().zip(cr_types.iter()) {
            frame_scalars.push((lid, ty));
        }
    }

    // Synthetic locals.
    let catch_state_locals = if catch_plan.is_empty() && b1_slots.is_empty() {
        None
    } else {
        Some(CatchStateLocals {
            catch_region_id: module.locals.add(ValType::I32),
            exnref_slot: module.locals.add(ValType::I32),
        })
    };
    // Tmp i32 used by the IfElse cond rewrite to swap stack order
    // (preserve original cond while computing force_flag and
    // is_rewind without touching the operand stack).
    let cond_swap_local = module.locals.add(ValType::I32);

    // Pre-pass: walk each fork-bearing seq, identify its
    // SubRegion-with-1-i32-carryover landings, and pre-allocate spill
    // locals (+ tmp_result_local for blocks producing 1 i32). The
    // locals are added to `frame_scalars` so they round-trip through
    // the fork frame. They are stored by (seq_id, landing_index) and
    // attached to landings during partition.
    //
    // Rationale: we have to allocate locals *before* computing
    // `frame_size` and `locals_with_offsets` (the postamble's frame
    // I/O depends on those). Doing the carryover analysis here keeps
    // the per-region transform loop straightforward.
    let mut carryover_plans: HashMap<(InstrSeqId, usize), CarryoverPlan> = HashMap::new();
    {
        let local_ro = match &module.funcs.get(func_id).kind {
            FunctionKind::Local(l) => l,
            _ => panic!("expected local function"),
        };
        let empty_idxs: Vec<u32> = Vec::new();
        // Snapshot needed seq+landing data first (immutable borrow),
        // then allocate locals (mutable borrow).
        let mut pending_plans: Vec<(InstrSeqId, usize, PendingCarryoverPlan)> = Vec::new();
        for &seq_id in regions.keys() {
            let direct = direct_idxs_per_seq.get(&seq_id).unwrap_or(&empty_idxs);
            // Sub-commit 2.6a: typed analyser captures per-landing
            // spill ValTypes (covering both SubRegion type-params and
            // any extra carryover above them). None on unanalyzable
            // shapes — `classify_nested_pattern` already gated on a
            // best-effort version of this, so None here is the same
            // conservative fallback (function routes to guard-dispatch
            // unless 2.5c/2.6a's combined gates accepted it).
            let spill_types = analyze_subregion_spill_types(
                module, local_ro, seq_id, fork_path, direct, &regions,
            )
            .unwrap_or_default();
            let original = &local_ro.block(seq_id).instrs;
            let (chunks, landings) =
                partition_region_instrs(local_ro, original, direct, &regions, fork_path);
            for (landing_idx, landing) in landings.iter().enumerate() {
                let Some(types) = spill_types.get(landing_idx) else {
                    continue;
                };
                if types.is_empty() {
                    continue;
                }
                let pure_allowed = match &landing.kind {
                    LandingKind::SubRegionIfElse { .. } => types.len() == 1,
                    LandingKind::SubRegion { .. } => true,
                    LandingKind::DirectCall { .. } => false,
                };
                if pure_allowed {
                    if let Some((tail_len, tail)) =
                        split_pure_scalar_tail(module, &chunks[landing_idx], types)
                    {
                        pending_plans.push((
                            seq_id,
                            landing_idx,
                            PendingCarryoverPlan::PureTail {
                                tail,
                                tail_len,
                                types: types.clone(),
                            },
                        ));
                        continue;
                    }
                }
                pending_plans.push((
                    seq_id,
                    landing_idx,
                    PendingCarryoverPlan::Spill {
                        types: types.clone(),
                    },
                ));
            }
        }
        // Now allocate. Sub-commit 2.6a: per-landing Vec of typed
        // spill locals (ordered deepest-stack-first). Multi-value-
        // params SubRegions land here with len() == n_params + extra.
        // tmp_result_local is no longer needed — the push-before
        // emission order leaves any extra carryover beneath the
        // SubRegion's result automatically.
        for (seq_id, landing_idx, pending) in pending_plans {
            let plan = match pending {
                PendingCarryoverPlan::Spill { types } => {
                    let mut spill_locals: Vec<(LocalId, ValType)> = Vec::with_capacity(types.len());
                    for &ty in &types {
                        let lid = module.locals.add(ty);
                        frame_scalars.push((lid, ty));
                        spill_locals.push((lid, ty));
                    }
                    CarryoverPlan::Spill { spill_locals }
                }
                PendingCarryoverPlan::PureTail {
                    tail,
                    tail_len,
                    types,
                } => CarryoverPlan::PureTail {
                    tail,
                    tail_len,
                    types,
                },
            };
            carryover_plans.insert((seq_id, landing_idx), plan);
        }
    }

    // Sub-commit 2.6c: per-seq body-input-params. A fork-bearing
    // seq that itself has declared type-params (i.e., it's the body
    // of a multi-value-params Block/Loop/TryTable) enters with those
    // params on its local stack. The cascading POST_K blocks emitted
    // by `populate_region_dispatch_structure` are typed Simple(None)
    // — they don't expose the body's input stack to inner chunks. To
    // bridge: at body entry, pre-spill the params to fresh locals;
    // at the start of POST_0 body (just before chunks[0] runs),
    // reload them onto the local stack. On REWIND the dispatch
    // br_tables past chunks[0..K], so the LocalGets only execute on
    // NORMAL flow when chunks[0] needs the params anyway.
    //
    // Locals don't need to be in frame_scalars: their values are
    // re-set on every seq entry (NORMAL or REWIND, since the params
    // are always on the body stack via either the original push or
    // the SubRegion-landing reload).
    let mut body_param_locals: HashMap<InstrSeqId, Vec<(LocalId, ValType)>> = HashMap::new();
    {
        let local_ro = match &module.funcs.get(func_id).kind {
            FunctionKind::Local(l) => l,
            _ => unreachable!(),
        };
        let mut to_allocate: Vec<(InstrSeqId, Vec<ValType>)> = Vec::new();
        for &seq_id in regions.keys() {
            if let InstrSeqType::MultiValue(ty_id) = local_ro.block(seq_id).ty {
                let params = module.types.get(ty_id).params();
                if !params.is_empty() {
                    to_allocate.push((seq_id, params.to_vec()));
                }
            }
        }
        for (seq_id, types) in to_allocate {
            let mut locals: Vec<(LocalId, ValType)> = Vec::with_capacity(types.len());
            for &ty in &types {
                let lid = module.locals.add(ty);
                locals.push((lid, ty));
            }
            body_param_locals.insert(seq_id, locals);
        }
    }

    let locals_with_offsets = assign_local_offsets(&frame_scalars, LOCALS_START_OFFSET);
    let frame_size = HEADER_SIZE + user_locals_size(&frame_scalars);

    let result_types: Vec<ValType> = {
        let ty_id = module.funcs.get(func_id).ty();
        module.types.get(ty_id).results().to_vec()
    };

    // Plan catch handlers (Phase 6d). These remain dead code for the
    // nested transform's MVP (no fork-from-catch), but the plumbing is
    // preserved for ref-typed exnref locals that still round-trip.
    let catch_handlers = plan_catch_ref_handlers(module, func_id, catch_plan, aux_tables);

    let memory = first_memory(module);
    let ptr_ty = runtime.buf_type;

    // Phase 6c rewind-throw stubs (still emitted for try_table bodies
    // without fork-path calls — preserves the exnref serialization
    // path). Extended by B1 Stage 2 Task 2.3 with plain-catch arm
    // dispatch when `b1_slots` lists arms for the region.
    if !catch_plan.is_empty() && aux_tables.exnref.is_some() {
        let catch_state =
            catch_state_locals.expect("exnref catch plan requires catch-state locals");
        inject_rewind_throw_stubs(
            module,
            func_id,
            runtime,
            catch_state.catch_region_id,
            aux_tables,
            catch_plan,
            b1_slots,
        );
    }

    // Build preamble + unwind_save wrapper + postamble seqs.
    let local = local_mut(module, func_id);
    let preamble_then = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();
    let preamble_else = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();
    let unwind_save = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();

    populate_preamble_then(
        local,
        preamble_then,
        runtime,
        memory,
        ptr_ty,
        catch_state_locals,
        &locals_with_offsets,
        ref_plan,
        aux_tables,
        frame_size,
    );

    // Recursively transform each fork-bearing seq, bottom-up. A seq is
    // fork-bearing iff it appears in `regions`. The function's entry
    // block is the root region; its transformation produces the
    // function-level dispatch + cascading POST blocks.
    //
    // For NON-entry fork-bearing seqs, the transformation rebuilds the
    // seq's instrs in-place (replacing them with the dispatch + POST
    // cascade). The seq's enclosing instruction (in the parent seq) is
    // unchanged structurally — but for IfElse, the parent seq is
    // responsible for rewriting the cond.
    //
    // The function-level $unwind_save lives at the entry block's level
    // and is the long-branch target for UNWINDING propagation from any
    // depth.
    let entry_id = local.entry_block();

    // Process all fork-bearing seqs except the entry (entry handled
    // specially with preamble/postamble + unwind_save). Order:
    // bottom-up (deepest first).
    let mut non_entry_regions: Vec<InstrSeqId> =
        regions.keys().copied().filter(|&s| s != entry_id).collect();
    // Sort by depth (deepest first). Walrus doesn't expose depth
    // directly, so compute via parent-seq walk.
    let depth_map = compute_seq_depths(local, entry_id);
    non_entry_regions.sort_by_key(|s| std::cmp::Reverse(depth_map.get(s).copied().unwrap_or(0)));

    // Transform non-entry regions bottom-up.
    for seq_id in non_entry_regions {
        let region_info = regions.get(&seq_id).unwrap().clone();
        let empty_idxs: Vec<u32> = Vec::new();
        let direct = direct_idxs_per_seq.get(&seq_id).unwrap_or(&empty_idxs);
        let empty_params: Vec<(LocalId, ValType)> = Vec::new();
        let body_params = body_param_locals.get(&seq_id).unwrap_or(&empty_params);
        transform_region_seq(
            local,
            seq_id,
            &region_info,
            direct,
            &regions,
            &sites,
            fork_path,
            &arg_materializations,
            &carryover_spills,
            &carryover_plans,
            &catch_handlers,
            runtime,
            memory,
            ptr_ty,
            cond_swap_local,
            catch_state_locals,
            unwind_save,
            body_params,
        );
    }

    // Transform entry region: dispatch + cascading POST inside
    // $unwind_save. Same pattern as the existing top-level
    // switch-dispatch but with mixed DirectCall/SubRegion landings.
    let entry_region_info = regions.get(&entry_id).unwrap().clone();
    let empty_idxs: Vec<u32> = Vec::new();
    let entry_direct = direct_idxs_per_seq.get(&entry_id).unwrap_or(&empty_idxs);
    transform_entry_region(
        local,
        entry_id,
        &entry_region_info,
        entry_direct,
        &regions,
        &sites,
        fork_path,
        &arg_materializations,
        &carryover_spills,
        &carryover_plans,
        &catch_handlers,
        runtime,
        memory,
        ptr_ty,
        cond_swap_local,
        catch_state_locals,
        unwind_save,
        &result_types,
    );

    // Build postamble — same as switch-dispatch.
    let mut postamble: Vec<(Instr, InstrLocId)> = Vec::new();
    populate_postamble(
        &mut postamble,
        runtime,
        memory,
        ptr_ty,
        catch_state_locals,
        &locals_with_offsets,
        ref_plan,
        aux_tables,
        frame_size,
        func_ordinal,
        &result_types,
    );

    // Wrap entry block with [preamble-if-else, Block(unwind_save), postamble].
    // The entry block's instrs (set by transform_entry_region) become
    // the body of `unwind_save`. We pull them out and place them inside
    // unwind_save here, then install the wrapper structure in entry.
    let entry_body: Vec<(Instr, InstrLocId)> =
        std::mem::take(&mut local.block_mut(entry_id).instrs);
    {
        let s = &mut local.block_mut(unwind_save).instrs;
        s.extend(entry_body);
    }

    let entry_seq = &mut local.block_mut(entry_id).instrs;
    push_instr(
        entry_seq,
        Instr::GlobalGet(GlobalGet {
            global: runtime.state_global,
        }),
    );
    push_instr(
        entry_seq,
        Instr::Const(Const {
            value: Value::I32(runtime::STATE_REWINDING),
        }),
    );
    push_instr(
        entry_seq,
        Instr::Binop(Binop {
            op: BinaryOp::I32Eq,
        }),
    );
    push_instr(
        entry_seq,
        Instr::IfElse(IfElse {
            consequent: preamble_then,
            alternative: preamble_else,
        }),
    );
    push_instr(entry_seq, Instr::Block(Block { seq: unwind_save }));
    entry_seq.extend(postamble);

    apply_catch_ref_handlers(module, func_id, &catch_handlers, aux_tables);

    // Stage 2 (B1) plain-catch capture-block emission. Runs AFTER
    // Phase 6 so it sees post-Phase-6 try_table locations.
    if let Some(catch_state) = catch_state_locals {
        apply_plain_catch_handlers(
            module,
            func_id,
            runtime,
            catch_state.catch_region_id,
            b1_slots,
            catch_plan,
            &catch_handlers,
        );
    } else {
        debug_assert!(b1_slots.is_empty());
    }
}

/// At the end of a chunk that precedes a landing (inside the POST_K
/// block body), spill the trailing operand-stack values into locals
/// so the POST_K body's net stack effect stays 0 → 0.
///
/// - DirectCall landing: the chunk's tail is the call's arg values.
///   Spill them into per-call arg locals (existing behavior).
/// - SubRegionIfElse landing: the chunk's tail is the IfElse's
///   `cond` (1 i32). Spill it into `cond_swap_local`; the cond
///   rewrite reads it back later via `local.get`.
/// - SubRegion landing (Block/Loop/TryTable): the chunk has 0 → 0
///   stack effect already. Nothing to spill.
fn emit_chunk_tail_for_landing(
    out: &mut Vec<(Instr, InstrLocId)>,
    landing: &LandingInfo,
    arg_materializations: &HashMap<u32, CallArgMaterialization>,
    carryover_spills: &HashMap<u32, Vec<LocalId>>,
    cond_swap_local: LocalId,
) {
    match &landing.kind {
        LandingKind::DirectCall { call_idx } => {
            // Sub-commit 2.5b: nested switch-dispatch absorbs
            // direct-call carryovers via in-place spill at the call
            // site. After popping the call's args, also pop the
            // carryover values (Option B from the 2026-05-13 plan,
            // matching top-level switch-dispatch's 2.4c behavior).
            // `carryover_spills` is keyed by call_idx; an absent entry
            // is treated as no-carryover.
            let empty: Vec<LocalId> = Vec::new();
            let cr = carryover_spills.get(call_idx).unwrap_or(&empty);
            emit_spill_call_tail(out, &arg_materializations[call_idx], cr);
        }
        LandingKind::SubRegionIfElse { .. } => {
            if let Some(plan) = &landing.carryover {
                if let CarryoverPlan::Spill { spill_locals } = plan {
                    for (l, _ty) in spill_locals.iter().rev() {
                        push_instr(out, Instr::LocalSet(LocalSet { local: *l }));
                    }
                }
            } else {
                push_instr(
                    out,
                    Instr::LocalSet(LocalSet {
                        local: cond_swap_local,
                    }),
                );
            }
        }
        LandingKind::SubRegion { .. } => {
            // Sub-commit 2.6a: spill ALL parent-stack values at this
            // SubRegion landing — both the SubRegion's type-params
            // (consumed on entry) AND any extra carryover above. The
            // operand stack at the chunk tail has the spill values on
            // top (deepest-first in spill_locals); pop top-of-stack
            // first so spill_locals[0] receives the deepest slot.
            // After this, POST_K body's net stack effect is 0 → 0.
            if let Some(plan) = &landing.carryover {
                if let CarryoverPlan::Spill { spill_locals } = plan {
                    for (l, _ty) in spill_locals.iter().rev() {
                        push_instr(out, Instr::LocalSet(LocalSet { local: *l }));
                    }
                }
            }
        }
    }
}

fn nested_call_arg_types(module: &Module, site: &NestedCallSite) -> Vec<ValType> {
    let mut arg_types: Vec<ValType> = module.types.get(site.sig_ty).params().to_vec();
    if matches!(site.target, NestedTarget::Indirect { .. }) {
        arg_types.push(ValType::I32);
    }
    arg_types
}

// --- Region landings -------------------------------------------------

fn compute_seq_depths(f: &LocalFunction, entry: InstrSeqId) -> HashMap<InstrSeqId, u32> {
    let mut out = HashMap::new();
    fn walk(f: &LocalFunction, seq: InstrSeqId, depth: u32, out: &mut HashMap<InstrSeqId, u32>) {
        out.insert(seq, depth);
        for (instr, _) in &f.block(seq).instrs {
            for child in nested_seqs(instr) {
                walk(f, child, depth + 1, out);
            }
        }
    }
    walk(f, entry, 0, &mut out);
    out
}

// --- Per-region transform (non-entry) --------------------------------

#[allow(clippy::too_many_arguments)]
fn transform_region_seq(
    local: &mut LocalFunction,
    seq_id: InstrSeqId,
    region_info: &RegionInfo,
    direct_idxs_at_this_seq: &[u32],
    regions: &HashMap<InstrSeqId, RegionInfo>,
    sites: &[NestedCallSite],
    fork_path: &HashSet<FunctionId>,
    arg_materializations: &HashMap<u32, CallArgMaterialization>,
    carryover_spills: &HashMap<u32, Vec<LocalId>>,
    carryover_plans: &HashMap<(InstrSeqId, usize), CarryoverPlan>,
    catch_handlers: &[CatchHandlerInfo],
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    cond_swap_local: LocalId,
    catch_state_locals: Option<CatchStateLocals>,
    unwind_save: InstrSeqId,
    // Sub-commit 2.6c: this seq's declared type-params (only set for
    // multi-value Block/Loop/TryTable bodies). Pre-spilled at body
    // entry so the cascading POST_K Simple(None) blocks can re-expose
    // them to chunks[0] via LocalGet prepend.
    body_param_locals: &[(LocalId, ValType)],
) {
    // Take the original instrs of this region.
    let original: Vec<(Instr, InstrLocId)> = std::mem::take(&mut local.block_mut(seq_id).instrs);

    let (mut chunks, mut landings) = partition_region_instrs(
        local,
        &original,
        direct_idxs_at_this_seq,
        regions,
        fork_path,
    );

    // Sub-commit 2.6c: if this seq has body params, prepend LocalGets
    // to chunks[0] so the params are restored onto POST_0's local
    // stack before any consuming instruction (e.g., i32.add) runs.
    // Ordered deepest-first to match the original parent-stack layout.
    if !body_param_locals.is_empty() && !chunks.is_empty() {
        let mut prefix: Vec<(Instr, InstrLocId)> = Vec::with_capacity(body_param_locals.len());
        for (lid, _ty) in body_param_locals.iter() {
            prefix.push((
                Instr::LocalGet(LocalGet { local: *lid }),
                InstrLocId::default(),
            ));
        }
        prefix.extend(std::mem::take(&mut chunks[0]));
        chunks[0] = prefix;
    }
    // Attach carryover plans (if any) to landings.
    for (li, landing) in landings.iter_mut().enumerate() {
        if let Some(plan) = carryover_plans.get(&(seq_id, li)) {
            landing.carryover = Some(plan.clone());
        }
    }
    apply_landing_materializations_to_chunks(&mut chunks, &landings, arg_materializations);

    let n_landings = landings.len();
    if n_landings == 0 {
        let mut all = Vec::new();
        for chunk in chunks {
            all.extend(chunk);
        }
        local.block_mut(seq_id).instrs = all;
        return;
    }

    // Allocate POST seqs for each landing + dispatch seq.
    let post_seqs: Vec<InstrSeqId> = (0..n_landings)
        .map(|_| {
            local
                .builder_mut()
                .dangling_instr_seq(InstrSeqType::Simple(None))
                .id()
        })
        .collect();
    let dispatch_seq = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();

    // Emit the dispatch's br_table.
    populate_region_dispatch(
        local,
        dispatch_seq,
        runtime,
        memory,
        ptr_ty,
        region_info,
        &landings,
        &post_seqs,
        unwind_save,
    );

    // Build the cascading POST blocks.
    populate_region_dispatch_structure(
        local,
        seq_id,
        Some(dispatch_seq),
        &post_seqs,
        &chunks,
        &landings,
        sites,
        arg_materializations,
        carryover_spills,
        catch_handlers,
        runtime,
        memory,
        ptr_ty,
        cond_swap_local,
        catch_state_locals,
        unwind_save,
        false, // don't append `return` at end
    );

    // Sub-commit 2.6c: prepend LocalSets for the body's declared
    // type-params, in reverse order (top-of-stack first). Runs on
    // every body entry — NORMAL and REWIND — saving the params to
    // local slots that POST_0's prepended LocalGets reload from.
    if !body_param_locals.is_empty() {
        let mut preamble: Vec<(Instr, InstrLocId)> = Vec::with_capacity(body_param_locals.len());
        for (lid, _ty) in body_param_locals.iter().rev() {
            preamble.push((
                Instr::LocalSet(LocalSet { local: *lid }),
                InstrLocId::default(),
            ));
        }
        let s = &mut local.block_mut(seq_id).instrs;
        preamble.extend(std::mem::take(s));
        *s = preamble;
    }
}

#[allow(clippy::too_many_arguments)]
fn transform_entry_region(
    local: &mut LocalFunction,
    seq_id: InstrSeqId,
    region_info: &RegionInfo,
    direct_idxs_at_this_seq: &[u32],
    regions: &HashMap<InstrSeqId, RegionInfo>,
    sites: &[NestedCallSite],
    fork_path: &HashSet<FunctionId>,
    arg_materializations: &HashMap<u32, CallArgMaterialization>,
    carryover_spills: &HashMap<u32, Vec<LocalId>>,
    carryover_plans: &HashMap<(InstrSeqId, usize), CarryoverPlan>,
    catch_handlers: &[CatchHandlerInfo],
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    cond_swap_local: LocalId,
    catch_state_locals: Option<CatchStateLocals>,
    unwind_save: InstrSeqId,
    _result_types: &[ValType],
) {
    let original: Vec<(Instr, InstrLocId)> = std::mem::take(&mut local.block_mut(seq_id).instrs);

    let (mut chunks, mut landings) = partition_region_instrs(
        local,
        &original,
        direct_idxs_at_this_seq,
        regions,
        fork_path,
    );
    for (li, landing) in landings.iter_mut().enumerate() {
        if let Some(plan) = carryover_plans.get(&(seq_id, li)) {
            landing.carryover = Some(plan.clone());
        }
    }
    apply_landing_materializations_to_chunks(&mut chunks, &landings, arg_materializations);

    let n_landings = landings.len();

    let post_seqs: Vec<InstrSeqId> = (0..n_landings)
        .map(|_| {
            local
                .builder_mut()
                .dangling_instr_seq(InstrSeqType::Simple(None))
                .id()
        })
        .collect();
    let dispatch_seq = if n_landings > 0 {
        Some(
            local
                .builder_mut()
                .dangling_instr_seq(InstrSeqType::Simple(None))
                .id(),
        )
    } else {
        None
    };

    if let Some(d) = dispatch_seq {
        populate_region_dispatch(
            local,
            d,
            runtime,
            memory,
            ptr_ty,
            region_info,
            &landings,
            &post_seqs,
            unwind_save,
        );
    }

    // Entry-region's structure ends with the function's normal-path
    // return; populate_region_dispatch_structure(..., true) appends it.
    populate_region_dispatch_structure(
        local,
        seq_id,
        dispatch_seq,
        &post_seqs,
        &chunks,
        &landings,
        sites,
        arg_materializations,
        carryover_spills,
        catch_handlers,
        runtime,
        memory,
        ptr_ty,
        cond_swap_local,
        catch_state_locals,
        unwind_save,
        true, // append `return` for normal-path exit
    );
}

#[derive(Debug, Clone)]
enum LandingKind {
    DirectCall {
        call_idx: u32,
    },
    /// Block/Loop/TryTable: just preserved verbatim.
    SubRegion {
        range_lo: u32,
        range_hi: u32,
    },
    /// IfElse landing: needs a cond rewrite so REWIND lands in the
    /// branch that contains the active call_idx. We require the
    /// caller to supply both branch ranges; either may be empty
    /// (None) if that branch has no fork-path calls.
    SubRegionIfElse {
        range_lo: u32,
        range_hi: u32,
        then_range: Option<(u32, u32)>,
        else_range: Option<(u32, u32)>,
    },
}

/// Stack-carryover spill plan for a sub-region landing whose
/// preceding chunk leaves one or more values on the operand stack.
/// POST_K bodies are typed `Simple(None)` (0 → 0), so the values must
/// be spilled before the enclosing instr runs and reloaded after.
///
/// The values fall into two semantic categories that nonetheless
/// share the same spill-and-reload mechanism (sub-commit 2.6a):
///
/// - **Type-params** of the SubRegion (Block/Loop/TryTable with a
///   multi-value `(func (param ...) (result ...))` signature). These
///   are consumed by the SubRegion on entry and pushed back BEFORE
///   the SubRegion runs.
/// - **Extra carryover** above the type-params on the parent stack
///   (values not consumed by the SubRegion). Pre-2.6a this was the
///   only case — a 1-i32 carryover at a no-params SubRegion.
///
/// Both cases use the same emission shape: at the chunk tail, pop all
/// values into spill locals (top-of-stack first, so `spill_locals[0]`
/// holds the deepest stack slot). At emit_post_landing, push them
/// back in `spill_locals[0..]` order BEFORE the SubRegion instr. The
/// SubRegion consumes the top params, leaving any extra carryover
/// beneath whatever result it pushes — no juggling tmp local needed.
#[derive(Debug, Clone)]
enum CarryoverPlan {
    Spill {
        /// Spill locals, one per spilled value. Ordered deepest-first
        /// (i.e., `spill_locals[0]` is the value that was at the bottom
        /// of the spilled stack region; `spill_locals.last()` was on top).
        spill_locals: Vec<(LocalId, ValType)>,
    },
    PureTail {
        /// Pure scalar suffix removed from the NORMAL chunk and replayed
        /// at the landing. The suffix must produce `types` from an empty
        /// stack and may contain only constants, local.get, and whitelisted
        /// non-trapping scalar numeric ops.
        tail: Vec<(Instr, InstrLocId)>,
        tail_len: usize,
        types: Vec<ValType>,
    },
}

#[derive(Debug, Clone)]
enum PendingCarryoverPlan {
    Spill {
        types: Vec<ValType>,
    },
    PureTail {
        tail: Vec<(Instr, InstrLocId)>,
        tail_len: usize,
        types: Vec<ValType>,
    },
}

enum IfElseCondSource<'a> {
    Local(LocalId),
    PureTail(&'a [(Instr, InstrLocId)]),
}

#[derive(Debug, Clone)]
struct LandingInfo {
    kind: LandingKind,
    /// For SubRegion/SubRegionIfElse: the enclosing instruction
    /// preserved verbatim. Its nested seqs have been transformed
    /// independently (bottom-up).
    sub_region_instr: Option<(Instr, InstrLocId)>,
    /// Set on a SubRegion landing whose preceding chunk has a 1-i32
    /// stack carryover. None for landings without carryover.
    carryover: Option<CarryoverPlan>,
}

fn apply_landing_materializations_to_chunks(
    chunks: &mut [Vec<(Instr, InstrLocId)>],
    landings: &[LandingInfo],
    arg_materializations: &HashMap<u32, CallArgMaterialization>,
) {
    for (landing_idx, landing) in landings.iter().enumerate() {
        let tail_len = match &landing.kind {
            LandingKind::DirectCall { call_idx } => arg_materializations[call_idx].tail_len(),
            LandingKind::SubRegion { .. } | LandingKind::SubRegionIfElse { .. } => {
                match &landing.carryover {
                    Some(CarryoverPlan::PureTail { tail_len, .. }) => *tail_len,
                    _ => 0,
                }
            }
        };
        truncate_materialized_tail(&mut chunks[landing_idx], tail_len);
    }
}

/// Partition `original` instrs at landings:
///   - direct fork-path Call/CallIndirect at this seq's level → DirectCall.
///   - any enclosing instr (Block/IfElse/Loop/TryTable/Try) whose
///     nested seq is a fork-bearing region → SubRegion. We use the
///     `regions` map to look up the child's call_idx range.
/// Returns (chunks, landings) where `chunks.len() == landings.len() + 1`.
///
/// The DirectCall's `call_idx` is taken from `direct_idxs` in order —
/// `discover_calls_and_regions` assigned call_idxs in DFS order,
/// matching the order fork-path-relevant calls (direct fork-path Call,
/// any CallIndirect) appear in this seq's instrs. Non-fork-path
/// direct calls fall through to the chunk verbatim.
fn partition_region_instrs(
    _f: &LocalFunction,
    original: &[(Instr, InstrLocId)],
    direct_idxs_at_this_seq: &[u32],
    regions: &HashMap<InstrSeqId, RegionInfo>,
    fork_path: &HashSet<FunctionId>,
) -> (Vec<Vec<(Instr, InstrLocId)>>, Vec<LandingInfo>) {
    let mut chunks: Vec<Vec<(Instr, InstrLocId)>> = vec![Vec::new()];
    let mut landings: Vec<LandingInfo> = Vec::new();

    let mut direct_cursor = 0usize;

    for (instr, loc) in original.iter() {
        // A fork-path-relevant call at this seq's level: direct Call
        // to a fork-path callee, OR any CallIndirect (conservatively
        // assumed to potentially reach a fork-path callee — same
        // policy as discover_calls_and_regions).
        let is_fork_landing = match instr {
            Instr::Call(c) => fork_path.contains(&c.func),
            Instr::CallIndirect(_) => true,
            _ => false,
        };
        if is_fork_landing && direct_cursor < direct_idxs_at_this_seq.len() {
            let idx = direct_idxs_at_this_seq[direct_cursor];
            direct_cursor += 1;
            landings.push(LandingInfo {
                kind: LandingKind::DirectCall { call_idx: idx },
                sub_region_instr: None,
                carryover: None,
            });
            chunks.push(Vec::new());
            continue;
        }

        // Sub-region landing: any enclosing instr whose nested seq(s)
        // are fork-bearing regions. For IfElse, both branches may be
        // regions; collect both ranges so the cond rewrite can pick
        // the right branch on REWIND.
        let mut sub_lo_hi: Option<(u32, u32)> = None;
        let mut ifelse_then_range: Option<(u32, u32)> = None;
        let mut ifelse_else_range: Option<(u32, u32)> = None;
        let is_ifelse = matches!(instr, Instr::IfElse(_));

        if is_ifelse {
            if let Instr::IfElse(ie) = instr {
                if let Some(info) = regions.get(&ie.consequent) {
                    ifelse_then_range = Some((info.range_lo, info.range_hi));
                }
                if let Some(info) = regions.get(&ie.alternative) {
                    ifelse_else_range = Some((info.range_lo, info.range_hi));
                }
                if ifelse_then_range.is_some() || ifelse_else_range.is_some() {
                    let lo = ifelse_then_range
                        .map(|(l, _)| l)
                        .into_iter()
                        .chain(ifelse_else_range.map(|(l, _)| l))
                        .min()
                        .unwrap();
                    let hi = ifelse_then_range
                        .map(|(_, h)| h)
                        .into_iter()
                        .chain(ifelse_else_range.map(|(_, h)| h))
                        .max()
                        .unwrap();
                    sub_lo_hi = Some((lo, hi));
                }
            }
        } else {
            for child in nested_seqs(instr) {
                if let Some(child_info) = regions.get(&child) {
                    sub_lo_hi = match sub_lo_hi {
                        None => Some((child_info.range_lo, child_info.range_hi)),
                        Some((lo, hi)) => {
                            Some((lo.min(child_info.range_lo), hi.max(child_info.range_hi)))
                        }
                    };
                }
            }
        }

        if let Some((lo, hi)) = sub_lo_hi {
            let kind = if is_ifelse {
                LandingKind::SubRegionIfElse {
                    range_lo: lo,
                    range_hi: hi,
                    then_range: ifelse_then_range,
                    else_range: ifelse_else_range,
                }
            } else {
                LandingKind::SubRegion {
                    range_lo: lo,
                    range_hi: hi,
                }
            };
            landings.push(LandingInfo {
                kind,
                sub_region_instr: Some((instr.clone(), *loc)),
                carryover: None, // populated later if classify allows
            });
            chunks.push(Vec::new());
            continue;
        }

        chunks.last_mut().unwrap().push((instr.clone(), *loc));
    }

    (chunks, landings)
}

// --- Per-region dispatch + cascading POST blocks ---------------------

#[allow(clippy::too_many_arguments)]
fn populate_region_dispatch(
    local: &mut LocalFunction,
    dispatch_seq: InstrSeqId,
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    region_info: &RegionInfo,
    landings: &[LandingInfo],
    post_seqs: &[InstrSeqId],
    unwind_save: InstrSeqId,
) {
    // Build br_table: for each call_idx K in region_info.range, target
    // the POST seq corresponding to the landing that covers K.
    let lo = region_info.range_lo;
    let hi = region_info.range_hi;
    let count = (hi - lo + 1) as usize;
    let mut blocks_vec: Vec<InstrSeqId> = vec![unwind_save; count];
    for (li, landing) in landings.iter().enumerate() {
        match &landing.kind {
            LandingKind::DirectCall { call_idx } => {
                let i = (*call_idx - lo) as usize;
                if i < count {
                    blocks_vec[i] = post_seqs[li];
                }
            }
            LandingKind::SubRegion { range_lo, range_hi }
            | LandingKind::SubRegionIfElse {
                range_lo, range_hi, ..
            } => {
                for k in *range_lo..=*range_hi {
                    let i = (k - lo) as usize;
                    if i < count {
                        blocks_vec[i] = post_seqs[li];
                    }
                }
            }
        }
    }

    let if_then = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();
    let if_else = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();

    {
        let s = &mut local.block_mut(if_then).instrs;
        push_current_call_index(s, runtime, memory, ptr_ty);
        if lo != 0 {
            push_instr(
                s,
                Instr::Const(Const {
                    value: Value::I32(lo as i32),
                }),
            );
            push_instr(
                s,
                Instr::Binop(Binop {
                    op: BinaryOp::I32Sub,
                }),
            );
        }
        push_instr(
            s,
            Instr::BrTable(BrTable {
                blocks: blocks_vec.into_boxed_slice(),
                default: unwind_save,
            }),
        );
    }

    let s = &mut local.block_mut(dispatch_seq).instrs;
    push_instr(
        s,
        Instr::GlobalGet(GlobalGet {
            global: runtime.state_global,
        }),
    );
    push_instr(
        s,
        Instr::Const(Const {
            value: Value::I32(runtime::STATE_REWINDING),
        }),
    );
    push_instr(
        s,
        Instr::Binop(Binop {
            op: BinaryOp::I32Eq,
        }),
    );
    push_instr(
        s,
        Instr::IfElse(IfElse {
            consequent: if_then,
            alternative: if_else,
        }),
    );
}

#[allow(clippy::too_many_arguments)]
fn populate_region_dispatch_structure(
    local: &mut LocalFunction,
    outer_seq: InstrSeqId,
    dispatch_seq: Option<InstrSeqId>,
    post_seqs: &[InstrSeqId],
    chunks: &[Vec<(Instr, InstrLocId)>],
    landings: &[LandingInfo],
    sites: &[NestedCallSite],
    arg_materializations: &HashMap<u32, CallArgMaterialization>,
    carryover_spills: &HashMap<u32, Vec<LocalId>>,
    catch_handlers: &[CatchHandlerInfo],
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    cond_swap_local: LocalId,
    catch_state_locals: Option<CatchStateLocals>,
    unwind_save: InstrSeqId,
    append_return: bool,
) {
    let n_landings = landings.len();
    if n_landings == 0 {
        // Empty region: just put chunks back, append return if entry.
        let s = &mut local.block_mut(outer_seq).instrs;
        for chunk in chunks {
            for it in chunk {
                s.push(it.clone());
            }
        }
        if append_return {
            push_instr(s, Instr::Return(Return {}));
        }
        return;
    }

    // POST_0 body: [Block($dispatch_seq), chunk 0, spill 0 / cond_swap].
    {
        let s = &mut local.block_mut(post_seqs[0]).instrs;
        if let Some(d) = dispatch_seq {
            push_instr(s, Instr::Block(Block { seq: d }));
        }
        for (instr, loc) in &chunks[0] {
            s.push((instr.clone(), *loc));
        }
        emit_chunk_tail_for_landing(
            s,
            &landings[0],
            arg_materializations,
            carryover_spills,
            cond_swap_local,
        );
    }

    // POST_K (K in 1..n_landings):
    //   [Block($POST_{K-1}), <post-K-1 sequence>, chunk K, spill K?]
    for k in 1..n_landings {
        {
            let s = &mut local.block_mut(post_seqs[k]).instrs;
            push_instr(
                s,
                Instr::Block(Block {
                    seq: post_seqs[k - 1],
                }),
            );
        }
        emit_post_landing(
            local,
            post_seqs[k],
            &landings[k - 1],
            sites,
            arg_materializations,
            carryover_spills,
            catch_handlers,
            runtime,
            memory,
            ptr_ty,
            cond_swap_local,
            catch_state_locals,
            unwind_save,
        );
        {
            let s = &mut local.block_mut(post_seqs[k]).instrs;
            for (instr, loc) in &chunks[k] {
                s.push((instr.clone(), *loc));
            }
            emit_chunk_tail_for_landing(
                s,
                &landings[k],
                arg_materializations,
                carryover_spills,
                cond_swap_local,
            );
        }
    }

    // outer_seq body:
    //   [Block($POST_{n-1}), <post-(n-1) sequence>, chunk n, return?]
    {
        let s = &mut local.block_mut(outer_seq).instrs;
        push_instr(
            s,
            Instr::Block(Block {
                seq: post_seqs[n_landings - 1],
            }),
        );
    }
    emit_post_landing(
        local,
        outer_seq,
        &landings[n_landings - 1],
        sites,
        arg_materializations,
        carryover_spills,
        catch_handlers,
        runtime,
        memory,
        ptr_ty,
        cond_swap_local,
        catch_state_locals,
        unwind_save,
    );
    {
        let s = &mut local.block_mut(outer_seq).instrs;
        for (instr, loc) in &chunks[n_landings] {
            s.push((instr.clone(), *loc));
        }
        if append_return {
            push_instr(s, Instr::Return(Return {}));
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn emit_post_landing(
    local: &mut LocalFunction,
    seq_id: InstrSeqId,
    landing: &LandingInfo,
    sites: &[NestedCallSite],
    arg_materializations: &HashMap<u32, CallArgMaterialization>,
    carryover_spills: &HashMap<u32, Vec<LocalId>>,
    catch_handlers: &[CatchHandlerInfo],
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    cond_swap_local: LocalId,
    catch_state_locals: Option<CatchStateLocals>,
    unwind_save: InstrSeqId,
) {
    match &landing.kind {
        LandingKind::DirectCall { call_idx } => {
            let site = sites
                .iter()
                .find(|s| s.call_idx == *call_idx)
                .expect("site");
            // Sub-commit 2.5b: reload carryovers FIRST (deepest →
            // top), then args. The call pops only its args, leaving
            // the carryovers + result on the stack — matching the
            // original code's expected shape, same as top-level
            // switch-dispatch's `emit_post_call_via_local`.
            let empty: Vec<LocalId> = Vec::new();
            let carryovers = carryover_spills.get(call_idx).unwrap_or(&empty);
            {
                let s = &mut local.block_mut(seq_id).instrs;
                for &l in carryovers.iter() {
                    push_instr(s, Instr::LocalGet(LocalGet { local: l }));
                }
                emit_materialized_call_args(s, &arg_materializations[call_idx]);
                let call_instr = match site.target {
                    NestedTarget::Direct(func) => Instr::Call(Call { func }),
                    NestedTarget::Indirect { table } => Instr::CallIndirect(CallIndirect {
                        ty: site.sig_ty,
                        table,
                    }),
                };
                s.push((call_instr, site.loc));
            }
            // Phase 6e + call_idx frame write + UNWIND branch.
            emit_phase_6e_writes(local, seq_id, catch_handlers, catch_state_locals);
            emit_call_index_store_and_unwind_branch(
                local,
                seq_id,
                runtime,
                memory,
                ptr_ty,
                *call_idx,
                unwind_save,
            );
        }
        LandingKind::SubRegion { .. } => {
            // Block/Loop/TryTable: preserve the enclosing instr
            // verbatim. Its body has been recursively transformed
            // already (bottom-up). On REWIND we land at this
            // POST_J_ENTER's close, then fall through into the
            // enclosing instr unconditionally — since the body always
            // enters via fall-through, no cond rewrite is needed.
            let (instr, loc) = landing
                .sub_region_instr
                .clone()
                .expect("SubRegion landing must have its enclosing instr stashed");

            // Sub-commit 2.6a: push spill_locals BEFORE the SubRegion
            // instr. Ordered deepest-first in `spill_locals`, so
            // pushing in `spill_locals[0..]` order restores the
            // original parent-stack layout. The SubRegion's type-
            // params (at the top of the stack post-push) are
            // consumed on entry; any extra carryover beneath stays
            // intact and ends up below the SubRegion's result on
            // exit — matching the original semantics without the
            // previous tmp_result juggle.
            //
            // For the existing 1-i32-no-params case: spill_locals
            // has 1 entry; pushed before the SubRegion; the
            // SubRegion produces its single i32 result; final stack
            // = [..., carryover, result]. Same end state as the
            // pre-2.6a post-emission with tmp_result juggle.
            let s = &mut local.block_mut(seq_id).instrs;
            if let Some(plan) = &landing.carryover {
                match plan {
                    CarryoverPlan::Spill { spill_locals } => {
                        for (l, _ty) in spill_locals.iter() {
                            push_instr(s, Instr::LocalGet(LocalGet { local: *l }));
                        }
                    }
                    CarryoverPlan::PureTail { tail, .. } => {
                        s.extend(tail.iter().cloned());
                    }
                }
            }
            s.push((instr, loc));
        }
        LandingKind::SubRegionIfElse {
            range_lo: _,
            range_hi: _,
            then_range,
            else_range,
        } => {
            // IfElse landing: orig_cond was already spilled into
            // `cond_swap_local` at the end of the preceding chunk
            // (see `emit_chunk_tail_for_landing`). Stack at entry to
            // this post-landing is empty.
            //
            // We push a synthesized cond that selects via `select`:
            //   - on NORMAL (is_rewind=0): orig_cond from cond_swap_local.
            //   - on REWIND (is_rewind=1): force_flag (1 to enter THEN,
            //     0 to enter ELSE) based on which branch holds the
            //     active call_idx.
            //
            // The wasm `select` instruction pops 3 values [val1, val2,
            // cond] and pushes (cond ? val1 : val2). We arrange:
            //   val1 = force_flag, val2 = orig_cond, cond = is_rewind.
            let (instr, loc) = landing
                .sub_region_instr
                .clone()
                .expect("SubRegionIfElse landing must have its enclosing instr stashed");

            let s = &mut local.block_mut(seq_id).instrs;
            let cond_source = match &landing.carryover {
                Some(CarryoverPlan::Spill { spill_locals }) => {
                    let (cond_local, _ty) = spill_locals
                        .last()
                        .copied()
                        .expect("IfElse spill plan must include the condition");
                    for (l, _ty) in spill_locals.iter().take(spill_locals.len() - 1) {
                        push_instr(s, Instr::LocalGet(LocalGet { local: *l }));
                    }
                    IfElseCondSource::Local(cond_local)
                }
                Some(CarryoverPlan::PureTail { tail, types, .. }) => {
                    debug_assert_eq!(
                        types.as_slice(),
                        &[ValType::I32],
                        "pure IfElse cond materialization only supports condition-only i32 tails"
                    );
                    IfElseCondSource::PureTail(tail)
                }
                None => IfElseCondSource::Local(cond_swap_local),
            };
            // Push force_flag.
            match (then_range, else_range) {
                (Some(_), None) => {
                    push_instr(
                        s,
                        Instr::Const(Const {
                            value: Value::I32(1),
                        }),
                    );
                }
                (None, Some(_)) => {
                    push_instr(
                        s,
                        Instr::Const(Const {
                            value: Value::I32(0),
                        }),
                    );
                }
                (Some((tlo, thi)), Some(_)) => {
                    // Both branches have fork calls. Use range
                    // membership on THEN's range.
                    push_current_call_index(s, runtime, memory, ptr_ty);
                    push_instr(
                        s,
                        Instr::Const(Const {
                            value: Value::I32(*tlo as i32),
                        }),
                    );
                    push_instr(
                        s,
                        Instr::Binop(Binop {
                            op: BinaryOp::I32GeS,
                        }),
                    );
                    push_current_call_index(s, runtime, memory, ptr_ty);
                    push_instr(
                        s,
                        Instr::Const(Const {
                            value: Value::I32(*thi as i32),
                        }),
                    );
                    push_instr(
                        s,
                        Instr::Binop(Binop {
                            op: BinaryOp::I32LeS,
                        }),
                    );
                    push_instr(
                        s,
                        Instr::Binop(Binop {
                            op: BinaryOp::I32And,
                        }),
                    );
                }
                (None, None) => {
                    push_instr(
                        s,
                        Instr::Const(Const {
                            value: Value::I32(0),
                        }),
                    );
                }
            }
            // Push orig_cond from either the spill local or the pure
            // scalar tail removed from the NORMAL chunk.
            match cond_source {
                IfElseCondSource::Local(cond_local) => {
                    push_instr(s, Instr::LocalGet(LocalGet { local: cond_local }));
                }
                IfElseCondSource::PureTail(tail) => {
                    s.extend(tail.iter().cloned());
                }
            }
            // Push is_rewind.
            push_instr(
                s,
                Instr::GlobalGet(GlobalGet {
                    global: runtime.state_global,
                }),
            );
            push_instr(
                s,
                Instr::Const(Const {
                    value: Value::I32(runtime::STATE_REWINDING),
                }),
            );
            push_instr(
                s,
                Instr::Binop(Binop {
                    op: BinaryOp::I32Eq,
                }),
            );
            push_instr(s, Instr::Select(walrus::ir::Select { ty: None }));
            // Original IfElse with rewritten cond on the stack.
            s.push((instr, loc));
        }
    }
}

// =====================================================================
// Unit tests — first in this file. Lives here (rather than in tests/)
// because the trampoline helpers are intentionally private; private
// items are unreachable from integration tests.
// =====================================================================

#[cfg(test)]
mod trampoline_tests {
    use super::*;
    use walrus::ir::Drop;

    /// Build a tiny module with N stub functions returning unit, and
    /// return their FunctionIds in order. Used to populate per-function
    /// post-table fixtures without needing to construct realistic
    /// post-call extraction bodies (those land in 2.4-2.6).
    fn build_module_with_stubs(n: usize) -> (Module, Vec<FunctionId>) {
        let mut module = Module::default();
        let stub_ty = module.types.add(&[], &[]);
        let mut ids = Vec::with_capacity(n);
        for i in 0..n {
            let mut builder = walrus::FunctionBuilder::new(&mut module.types, &[], &[]);
            builder.name(format!("post_{i}"));
            let func = builder.finish(vec![], &mut module.funcs);
            // Confirm signature didn't drift (we built [] -> [] above).
            let _ = stub_ty;
            ids.push(func);
        }
        (module, ids)
    }

    fn find_table_by_name<'a>(module: &'a Module, name: &str) -> Option<&'a walrus::Table> {
        module
            .tables
            .iter()
            .find(|t| t.name.as_deref() == Some(name))
    }

    /// Returns the first active elem segment populating `table_id`,
    /// or None.
    fn find_active_elem_for(module: &Module, table_id: TableId) -> Option<&walrus::Element> {
        module.elements.iter().find(|el| {
            matches!(
                &el.kind,
                walrus::ElementKind::Active { table, .. } if *table == table_id
            )
        })
    }

    #[test]
    fn emit_per_function_post_table_creates_named_table_sized_to_fit() {
        let (mut module, post_funcs) = build_module_with_stubs(3);
        let table_id = emit_per_function_post_table(&mut module, "caller", &post_funcs);

        let table = find_table_by_name(&module, "caller_post_table")
            .expect("table named caller_post_table must exist");
        assert_eq!(table.id(), table_id);
        assert_eq!(table.initial, 3);
        assert_eq!(table.maximum, Some(3));
        assert_eq!(table.element_ty, RefType::FUNCREF);
    }

    #[test]
    fn emit_per_function_post_table_emits_active_elem_with_funcrefs_in_order() {
        let (mut module, post_funcs) = build_module_with_stubs(3);
        let table_id = emit_per_function_post_table(&mut module, "caller", &post_funcs);

        let elem = find_active_elem_for(&module, table_id)
            .expect("active elem segment must populate caller_post_table");

        // Active elem at offset 0.
        match &elem.kind {
            walrus::ElementKind::Active { table, offset } => {
                assert_eq!(*table, table_id);
                match offset {
                    walrus::ConstExpr::Value(Value::I32(0)) => {}
                    other => panic!("expected i32.const 0 offset, got {other:?}"),
                }
            }
            other => panic!("expected Active elem kind, got {other:?}"),
        }

        // Funcrefs are populated in input order.
        match &elem.items {
            walrus::ElementItems::Functions(ids) => {
                assert_eq!(ids, &post_funcs);
            }
            other => panic!("expected Functions items, got {other:?}"),
        }
    }

    #[test]
    fn emit_per_function_post_table_empty_skips_elem_segment() {
        let (mut module, _) = build_module_with_stubs(0);
        let table_id = emit_per_function_post_table(&mut module, "caller", &[]);

        let table = find_table_by_name(&module, "caller_post_table")
            .expect("table is created even for empty post_funcs");
        assert_eq!(table.initial, 0);
        assert_eq!(table.maximum, Some(0));

        // No elem segment for this table.
        assert!(
            find_active_elem_for(&module, table_id).is_none(),
            "no elem segment expected when post_funcs is empty"
        );
    }

    #[test]
    fn extract_chunk_to_function_creates_named_function_with_input_instrs() {
        let mut module = Module::default();
        let body = vec![
            (
                Instr::Const(Const {
                    value: Value::I32(7),
                }),
                InstrLocId::default(),
            ),
            (Instr::Drop(Drop {}), InstrLocId::default()),
        ];
        let func_id = extract_chunk_to_function(&mut module, "post_chunk_0", body);

        let func = module.funcs.get(func_id);
        assert_eq!(func.name.as_deref(), Some("post_chunk_0"));

        let local = match &func.kind {
            FunctionKind::Local(l) => l,
            _ => panic!("expected local function"),
        };
        let entry = local.entry_block();
        let block = local.block(entry);
        assert_eq!(
            block.instrs.len(),
            2,
            "body must contain the 2 input instrs"
        );
        assert!(matches!(block.instrs[0].0, Instr::Const(_)));
        assert!(matches!(block.instrs[1].0, Instr::Drop(_)));
    }

    #[test]
    fn extract_chunk_to_function_signature_is_unit_to_unit() {
        let mut module = Module::default();
        let func_id = extract_chunk_to_function(&mut module, "empty_chunk", vec![]);

        let func = module.funcs.get(func_id);
        let ty = module.types.get(func.ty());
        assert_eq!(ty.params(), &[], "no params expected in 2.4a");
        assert_eq!(ty.results(), &[], "no results expected in 2.4a");
    }

    #[test]
    fn extract_chunk_to_function_preserves_instr_loc_ids() {
        // Deliberately use a non-default InstrLocId so we can detect
        // it round-trips through extraction.
        let mut module = Module::default();
        let loc = InstrLocId::new(0xCAFEBABE);
        let body = vec![(
            Instr::Const(Const {
                value: Value::I32(0),
            }),
            loc,
        )];
        let func_id = extract_chunk_to_function(&mut module, "loc_test", body);

        let local = match &module.funcs.get(func_id).kind {
            FunctionKind::Local(l) => l,
            _ => panic!(),
        };
        let entry = local.entry_block();
        assert_eq!(
            local.block(entry).instrs[0].1,
            loc,
            "InstrLocId must round-trip"
        );
    }

    /// Module setup with a single 1-page memory and a known frame_ptr
    /// local to feed the rewriter.
    fn build_module_with_memory_and_frame_ptr() -> (Module, MemoryId, LocalId) {
        let mut module = Module::default();
        let memory = module.memories.add_local(false, false, 1, Some(1), None);
        let frame_ptr = module.locals.add(ValType::I32);
        (module, memory, frame_ptr)
    }

    #[test]
    fn rewrite_chunk_locals_to_frame_localget_becomes_load() {
        let (mut module, memory, frame_ptr) = build_module_with_memory_and_frame_ptr();
        let orig_local = module.locals.add(ValType::I32);
        let chunk = vec![(
            Instr::LocalGet(LocalGet { local: orig_local }),
            InstrLocId::default(),
        )];
        let (rewritten, new_locals) = rewrite_chunk_locals_to_frame(
            &mut module,
            chunk,
            frame_ptr,
            memory,
            &[(orig_local, ValType::I32, 12)],
        );

        assert_eq!(new_locals.len(), 1, "one temp allocated");
        assert_eq!(rewritten.len(), 2);
        match &rewritten[0].0 {
            Instr::LocalGet(LocalGet { local }) => assert_eq!(*local, frame_ptr),
            other => panic!("expected LocalGet $frame_ptr, got {other:?}"),
        }
        match &rewritten[1].0 {
            Instr::Load(load) => {
                assert!(matches!(load.kind, LoadKind::I32 { atomic: false }));
                assert_eq!(load.arg.offset, 12);
            }
            other => panic!("expected i32.load offset=12, got {other:?}"),
        }
    }

    #[test]
    fn rewrite_chunk_locals_to_frame_localset_becomes_tmp_then_store() {
        let (mut module, memory, frame_ptr) = build_module_with_memory_and_frame_ptr();
        let orig_local = module.locals.add(ValType::I32);
        let chunk = vec![(
            Instr::LocalSet(LocalSet { local: orig_local }),
            InstrLocId::default(),
        )];
        let (rewritten, new_locals) = rewrite_chunk_locals_to_frame(
            &mut module,
            chunk,
            frame_ptr,
            memory,
            &[(orig_local, ValType::I32, 4)],
        );

        let tmp = new_locals[0];
        assert_eq!(rewritten.len(), 4);
        match &rewritten[0].0 {
            Instr::LocalSet(LocalSet { local }) => assert_eq!(*local, tmp),
            other => panic!("expected LocalSet $tmp, got {other:?}"),
        }
        match &rewritten[1].0 {
            Instr::LocalGet(LocalGet { local }) => assert_eq!(*local, frame_ptr),
            other => panic!("expected LocalGet $frame_ptr, got {other:?}"),
        }
        match &rewritten[2].0 {
            Instr::LocalGet(LocalGet { local }) => assert_eq!(*local, tmp),
            other => panic!("expected LocalGet $tmp, got {other:?}"),
        }
        match &rewritten[3].0 {
            Instr::Store(store) => {
                assert!(matches!(store.kind, StoreKind::I32 { atomic: false }));
                assert_eq!(store.arg.offset, 4);
            }
            other => panic!("expected i32.store offset=4, got {other:?}"),
        }
    }

    #[test]
    fn rewrite_chunk_locals_to_frame_localtee_stores_then_reloads_tmp() {
        let (mut module, memory, frame_ptr) = build_module_with_memory_and_frame_ptr();
        let orig_local = module.locals.add(ValType::I64);
        let chunk = vec![(
            Instr::LocalTee(LocalTee { local: orig_local }),
            InstrLocId::default(),
        )];
        let (rewritten, new_locals) = rewrite_chunk_locals_to_frame(
            &mut module,
            chunk,
            frame_ptr,
            memory,
            &[(orig_local, ValType::I64, 8)],
        );

        let tmp = new_locals[0];
        // LocalSet $tmp, LocalGet $frame_ptr, LocalGet $tmp,
        // i64.store offset=8, LocalGet $tmp
        assert_eq!(rewritten.len(), 5);
        match &rewritten[3].0 {
            Instr::Store(store) => {
                assert!(matches!(store.kind, StoreKind::I64 { atomic: false }));
                assert_eq!(store.arg.offset, 8);
            }
            other => panic!("expected i64.store offset=8 at index 3, got {other:?}"),
        }
        match &rewritten[4].0 {
            Instr::LocalGet(LocalGet { local }) => assert_eq!(*local, tmp),
            other => panic!("expected LocalGet $tmp at index 4, got {other:?}"),
        }
    }

    #[test]
    fn compute_carryover_types_no_calls_returns_empty() {
        // No fork-path calls in the body → empty result.
        let wat = r#"
            (module
              (import "kernel" "kernel_fork" (func $fork (result i32)))
              (func $main (export "_start") (result i32)
                (i32.const 0)))
        "#;
        let bytes = wat::parse_str(wat).unwrap();
        let module = Module::from_buffer(&bytes).unwrap();
        let main = module
            .funcs
            .iter()
            .find(|f| f.name.as_deref() == Some("main"))
            .unwrap()
            .id();
        let mut fork_path = HashSet::new();
        let fork_id = module
            .funcs
            .iter()
            .find(|f| f.name.as_deref() == Some("fork"))
            .unwrap()
            .id();
        fork_path.insert(fork_id);
        fork_path.insert(main);
        let result = compute_carryover_types(&module, main, &fork_path);
        assert_eq!(result, Some(vec![]));
    }

    #[test]
    fn compute_carryover_types_simple_no_carryover_returns_empty_per_call() {
        // One fork-path call, no carryover (no values on stack
        // before the call's args). Should return Some(vec![vec![]]).
        let wat = r#"
            (module
              (import "kernel" "kernel_fork" (func $fork (result i32)))
              (func $main (export "_start") (result i32)
                (call $fork)))
        "#;
        let bytes = wat::parse_str(wat).unwrap();
        let module = Module::from_buffer(&bytes).unwrap();
        let main = module
            .funcs
            .iter()
            .find(|f| f.name.as_deref() == Some("main"))
            .unwrap()
            .id();
        let fork_id = module
            .funcs
            .iter()
            .find(|f| f.name.as_deref() == Some("fork"))
            .unwrap()
            .id();
        let mut fork_path = HashSet::new();
        fork_path.insert(fork_id);
        fork_path.insert(main);
        let result = compute_carryover_types(&module, main, &fork_path);
        assert_eq!(result, Some(vec![vec![]]));
    }

    #[test]
    fn compute_carryover_types_localget_carryover_at_call_returns_i32() {
        // Carryover pattern: local.get $sp pushed before the call's
        // args. Equivalent to top_level_carryover.wat's shape.
        let wat = r#"
            (module
              (import "kernel" "kernel_fork" (func $fork (result i32)))
              (memory (export "memory") 1)
              (func $helper (param i32 i32) (result i32)
                (drop (call $fork))
                (local.get 0))
              (func $main (export "_start") (result i32)
                (local $sp i32)
                (local.set $sp (i32.const 100))
                ;; Carryover: push $sp, then call args, then call helper.
                local.get $sp
                i32.const 16
                i32.const 8
                call $helper
                i32.store offset=12
                (i32.const 0)))
        "#;
        let bytes = wat::parse_str(wat).unwrap();
        let module = Module::from_buffer(&bytes).unwrap();
        let main = module
            .funcs
            .iter()
            .find(|f| f.name.as_deref() == Some("main"))
            .unwrap()
            .id();
        let helper = module
            .funcs
            .iter()
            .find(|f| f.name.as_deref() == Some("helper"))
            .unwrap()
            .id();
        let fork_id = module
            .funcs
            .iter()
            .find(|f| f.name.as_deref() == Some("fork"))
            .unwrap()
            .id();
        let mut fork_path = HashSet::new();
        fork_path.insert(fork_id);
        fork_path.insert(helper);
        fork_path.insert(main);
        let result = compute_carryover_types(&module, main, &fork_path);
        // helper has 2 i32 args; $sp on the stack below them is the
        // carryover. Expected: one call site with carryover [i32].
        assert_eq!(result, Some(vec![vec![ValType::I32]]));
    }

    #[test]
    fn compute_carryover_types_unknown_producer_consumed_before_call_returns_some() {
        // Post-2.6c-followup: non-carryover stack values do not force
        // the old guard-dispatch path. The call has no carryover here,
        // so the analyser succeeds with an empty Vec.
        let wat = r#"
            (module
              (import "kernel" "kernel_fork" (func $fork (result i32)))
              (func $main (export "_start") (result i32)
                (local $i i32)
                (local.set $i (i32.add (local.get $i) (i32.const 1)))
                (drop (call $fork))
                (local.get $i)))
        "#;
        let bytes = wat::parse_str(wat).unwrap();
        let module = Module::from_buffer(&bytes).unwrap();
        let main = find_func_id(&module, "main");
        let fork_path = build_fork_path(&module, &["fork", "main"]);
        let result = compute_carryover_types(&module, main, &fork_path);
        // One fork-path call ($fork), no carryover, no `None` slot in
        // the carryover → Some(vec![vec![]]).
        assert_eq!(result, Some(vec![vec![]]));
    }

    #[test]
    fn compute_carryover_types_unknown_producer_in_carryover_returns_none() {
        // Contrast case: a ref-typed producer's value IS the carryover
        // at a fork-path call. The switch-dispatch spill path only
        // supports scalar ValTypes, so the analyser correctly fails.
        let wat = r#"
            (module
              (import "kernel" "kernel_fork" (func $fork (result i32)))
              (func $main (export "_start") (result i32)
                ;; Push a ref-typed slot BEFORE the fork call — it
                ;; becomes the carryover.
                ref.null extern
                call $fork
                ;; Consume both: fork_pid + ref.null.
                drop
                drop
                (i32.const 0)))
        "#;
        let bytes = wat::parse_str(wat).unwrap();
        let module = Module::from_buffer(&bytes).unwrap();
        let main = find_func_id(&module, "main");
        let fork_path = build_fork_path(&module, &["fork", "main"]);
        let result = compute_carryover_types(&module, main, &fork_path);
        // Carryover would be [None] (the ref-typed result). Analyser
        // refuses -> None.
        assert_eq!(result, None);
    }

    // Sub-commit 2.5a: nested-aware carryover analyser. The analyser
    // walks each fork-bearing seq independently and reports per-call_idx
    // carryover types. Block/Loop/IfElse/TryTable instructions are
    // opaque at their parent level — their bodies are walked separately
    // when they appear as fork-bearing seqs of their own.

    fn build_fork_path(module: &Module, names: &[&str]) -> HashSet<FunctionId> {
        let mut fp = HashSet::new();
        for n in names {
            let id = module
                .funcs
                .iter()
                .find(|f| f.name.as_deref() == Some(*n))
                .unwrap_or_else(|| panic!("function `{n}` not found"))
                .id();
            fp.insert(id);
        }
        fp
    }

    fn find_func_id(module: &Module, name: &str) -> FunctionId {
        module
            .funcs
            .iter()
            .find(|f| f.name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("function `{name}` not found"))
            .id()
    }

    #[test]
    fn compute_nested_carryover_types_no_calls_returns_empty_map() {
        // No fork-path calls anywhere → empty map.
        let wat = r#"
            (module
              (import "kernel" "kernel_fork" (func $fork (result i32)))
              (func $main (export "_start") (result i32)
                (i32.const 0)))
        "#;
        let bytes = wat::parse_str(wat).unwrap();
        let module = Module::from_buffer(&bytes).unwrap();
        let main = find_func_id(&module, "main");
        let fork_path = build_fork_path(&module, &["fork", "main"]);
        let result = compute_nested_carryover_types(&module, main, &fork_path);
        assert_eq!(result, Some(HashMap::new()));
    }

    #[test]
    fn compute_nested_carryover_types_top_level_no_carryover_reports_empty_vec() {
        // One top-level fork-path call, no carryover. The analyser
        // walks the entry block (which IS a fork-bearing seq) and
        // returns `{call_idx: vec![]}`.
        let wat = r#"
            (module
              (import "kernel" "kernel_fork" (func $fork (result i32)))
              (func $main (export "_start") (result i32)
                (call $fork)))
        "#;
        let bytes = wat::parse_str(wat).unwrap();
        let module = Module::from_buffer(&bytes).unwrap();
        let main = find_func_id(&module, "main");
        let fork_path = build_fork_path(&module, &["fork", "main"]);
        let result = compute_nested_carryover_types(&module, main, &fork_path).unwrap();
        assert_eq!(result.len(), 1);
        // The single call gets call_idx=0; carryover must be empty.
        assert_eq!(result.get(&0), Some(&Vec::<ValType>::new()));
    }

    #[test]
    fn compute_nested_carryover_types_direct_call_in_block_with_i32_carryover() {
        // The case 2.5 is built for: a direct fork-path Call inside a
        // nested Block, with an i32 pushed BEFORE the call's args and
        // consumed AFTER. The outer Block returns 0 results (so the
        // carryover sits on the parent's stack across the inner Block).
        //
        // Pre-2.5: nested switch-dispatch's analyser pushed 0 for any
        // direct-call landing. After 2.5a, this returns `[i32]`.
        let wat = r#"
            (module
              (import "kernel" "kernel_fork" (func $fork (result i32)))
              (memory (export "memory") 1)
              (func $helper (param i32 i32) (result i32)
                (drop (call $fork))
                (local.get 0))
              (func $main (export "_start") (result i32)
                (local $sp i32)
                (local.set $sp (i32.const 100))
                ;; Outer Block forces nested-switch routing (creates a
                ;; nested fork-bearing seq).
                (block
                  ;; Carryover: push $sp BEFORE the helper's args; the
                  ;; helper is the fork-path direct call.
                  local.get $sp
                  i32.const 16
                  i32.const 8
                  call $helper
                  i32.store offset=12)
                (i32.const 0)))
        "#;
        let bytes = wat::parse_str(wat).unwrap();
        let module = Module::from_buffer(&bytes).unwrap();
        let main = find_func_id(&module, "main");
        let fork_path = build_fork_path(&module, &["fork", "helper", "main"]);
        let result = compute_nested_carryover_types(&module, main, &fork_path).unwrap();
        // Two fork-path calls: $fork inside $helper (top-level there),
        // and $helper inside the Block in $main. We only care about
        // $main's seq results here.
        // discover_calls_and_regions assigns call_idx in DFS order
        // across the function; in $main the only fork-path direct call
        // is to $helper, inside the Block. Find that call_idx by
        // discovering and matching seq_id == the inner Block.
        let (sites, _) = discover_calls_and_regions(&module, main, &fork_path);
        let entry_seq = match &module.funcs.get(main).kind {
            FunctionKind::Local(l) => l.entry_block(),
            _ => unreachable!(),
        };
        // The helper call lives inside a nested Block, NOT at the entry
        // seq. There must be at least one site whose seq_id != entry.
        let helper_site = sites
            .iter()
            .find(|s| s.seq_id != entry_seq)
            .expect("expected a fork-path call inside the nested Block");
        assert_eq!(
            result.get(&helper_site.call_idx),
            Some(&vec![ValType::I32]),
            "direct fork-path call inside Block must report [i32] carryover"
        );
    }

    #[test]
    fn compute_nested_carryover_types_direct_call_in_block_no_carryover() {
        // Same nesting shape but no carryover: just the call's args on
        // the stack. Must report empty vec for the call.
        let wat = r#"
            (module
              (import "kernel" "kernel_fork" (func $fork (result i32)))
              (func $helper (param i32) (result i32)
                (drop (call $fork))
                (local.get 0))
              (func $main (export "_start") (result i32)
                (block
                  (drop (call $helper (i32.const 42))))
                (i32.const 0)))
        "#;
        let bytes = wat::parse_str(wat).unwrap();
        let module = Module::from_buffer(&bytes).unwrap();
        let main = find_func_id(&module, "main");
        let fork_path = build_fork_path(&module, &["fork", "helper", "main"]);
        let result = compute_nested_carryover_types(&module, main, &fork_path).unwrap();
        let (sites, _) = discover_calls_and_regions(&module, main, &fork_path);
        let entry_seq = match &module.funcs.get(main).kind {
            FunctionKind::Local(l) => l.entry_block(),
            _ => unreachable!(),
        };
        let nested_site = sites
            .iter()
            .find(|s| s.seq_id != entry_seq)
            .expect("expected helper call inside the Block");
        assert_eq!(
            result.get(&nested_site.call_idx),
            Some(&Vec::<ValType>::new()),
            "no carryover → empty vec at the nested call"
        );
    }

    #[test]
    fn compute_nested_carryover_types_two_seqs_independent_carryovers() {
        // Function has two fork-bearing seqs (the entry block AND a
        // nested Block), each with its own carryover. Verifies the
        // analyser reports BOTH correctly, keyed by their respective
        // call_idxs.
        let wat = r#"
            (module
              (import "kernel" "kernel_fork" (func $fork (result i32)))
              (memory (export "memory") 1)
              (func $helper (param i32 i32) (result i32)
                (drop (call $fork))
                (local.get 0))
              (func $main (export "_start") (result i32)
                (local $sp i32)
                (local.set $sp (i32.const 100))
                ;; Top-level fork-path call with i32 carryover.
                local.get $sp
                i32.const 16
                i32.const 8
                call $helper
                i32.store offset=4
                ;; Nested fork-path call (in a Block) with i32 carryover.
                (block
                  local.get $sp
                  i32.const 24
                  i32.const 9
                  call $helper
                  i32.store offset=8)
                (i32.const 0)))
        "#;
        let bytes = wat::parse_str(wat).unwrap();
        let module = Module::from_buffer(&bytes).unwrap();
        let main = find_func_id(&module, "main");
        let fork_path = build_fork_path(&module, &["fork", "helper", "main"]);
        let result = compute_nested_carryover_types(&module, main, &fork_path).unwrap();

        let (sites, _) = discover_calls_and_regions(&module, main, &fork_path);
        let entry_seq = match &module.funcs.get(main).kind {
            FunctionKind::Local(l) => l.entry_block(),
            _ => unreachable!(),
        };
        // One site lives in the entry seq, one in the nested Block.
        let entry_site = sites
            .iter()
            .find(|s| s.seq_id == entry_seq)
            .expect("expected a top-level helper call");
        let nested_site = sites
            .iter()
            .find(|s| s.seq_id != entry_seq)
            .expect("expected a nested helper call");
        assert_eq!(result.get(&entry_site.call_idx), Some(&vec![ValType::I32]));
        assert_eq!(result.get(&nested_site.call_idx), Some(&vec![ValType::I32]));
    }

    // Sub-commit 2.6a: typed SubRegion spill analyser.

    #[test]
    fn analyze_subregion_spill_types_multivalue_block_with_fork_inside() {
        // Replica of `nested_multivalue_params.wat` — Block with type
        // (param i32 i32) (result i32) containing a fork-path call.
        // Expected: SubRegion landing in the entry seq reports spill
        // types [i32, i32] (the Block's two params, no extra carryover).
        let wat = r#"
            (module
              (import "kernel" "kernel_fork" (func $fork (result i32)))
              (type $two_to_one (func (param i32 i32) (result i32)))
              (memory (export "memory") 1)
              (func $main (export "_start") (result i32)
                i32.const 7
                i32.const 11
                (block $B (type $two_to_one)
                  i32.add
                  call $fork
                  drop)
                drop
                (i32.const 0)))
        "#;
        let bytes = wat::parse_str(wat).unwrap();
        let module = Module::from_buffer(&bytes).unwrap();
        let main = find_func_id(&module, "main");
        let fork_path = build_fork_path(&module, &["fork", "main"]);
        let (sites, regions) = discover_calls_and_regions(&module, main, &fork_path);
        let local_ro = match &module.funcs.get(main).kind {
            FunctionKind::Local(l) => l,
            _ => unreachable!(),
        };
        let entry = local_ro.entry_block();
        // The entry seq has the multi-value-params Block as a
        // SubRegion landing. No DirectCall landings here (the fork
        // call is INSIDE the Block).
        let direct_at_entry: Vec<u32> = sites
            .iter()
            .filter(|s| s.seq_id == entry)
            .map(|s| s.call_idx)
            .collect();
        let result = analyze_subregion_spill_types(
            &module,
            local_ro,
            entry,
            &fork_path,
            &direct_at_entry,
            &regions,
        )
        .expect("analyser should succeed for fully-typed shape");
        // One landing at the entry seq (the Block).
        assert_eq!(result.len(), 1, "expected one landing entry");
        assert_eq!(
            result[0],
            vec![ValType::I32, ValType::I32],
            "Block's 2 i32 type-params must be the spill types"
        );
    }

    #[test]
    fn analyze_subregion_spill_types_block_with_extra_carryover_above_params() {
        // Block with type (param i32) (result i32) AND an extra i32
        // pushed on the parent stack above the param. Expected spill
        // types at the SubRegion landing: [extra, param] (deepest
        // first; both i32 in this case).
        let wat = r#"
            (module
              (import "kernel" "kernel_fork" (func $fork (result i32)))
              (type $one_to_one (func (param i32) (result i32)))
              (memory (export "memory") 1)
              (func $main (export "_start") (result i32)
                (local $tmp i32)
                ;; Push extra carryover first.
                i32.const 99
                ;; Push the Block's param next.
                i32.const 7
                (block $B (type $one_to_one)
                  ;; Block's param is on the stack (one i32). Save it,
                  ;; do the fork, then push it back as the block's result.
                  local.set $tmp
                  call $fork
                  drop
                  local.get $tmp)
                ;; Stack now: [extra=99, block_result]
                i32.add
                drop
                (i32.const 0)))
        "#;
        let bytes = wat::parse_str(wat).unwrap();
        let module = Module::from_buffer(&bytes).unwrap();
        let main = find_func_id(&module, "main");
        let fork_path = build_fork_path(&module, &["fork", "main"]);
        let (sites, regions) = discover_calls_and_regions(&module, main, &fork_path);
        let local_ro = match &module.funcs.get(main).kind {
            FunctionKind::Local(l) => l,
            _ => unreachable!(),
        };
        let entry = local_ro.entry_block();
        let direct_at_entry: Vec<u32> = sites
            .iter()
            .filter(|s| s.seq_id == entry)
            .map(|s| s.call_idx)
            .collect();
        let result = analyze_subregion_spill_types(
            &module,
            local_ro,
            entry,
            &fork_path,
            &direct_at_entry,
            &regions,
        )
        .expect("analyser should succeed");
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0],
            vec![ValType::I32, ValType::I32],
            "deepest-first: [extra=i32, param=i32]"
        );
    }

    #[test]
    fn analyze_subregion_spill_types_simple_block_no_carryover_returns_empty() {
        // Simple `(block (result i32) ... fork ...)` with NO carryover
        // and NO type-params — analyser reports empty spill list.
        let wat = r#"
            (module
              (import "kernel" "kernel_fork" (func $fork (result i32)))
              (memory (export "memory") 1)
              (func $main (export "_start") (result i32)
                (block $B (result i32)
                  call $fork)
                drop
                (i32.const 0)))
        "#;
        let bytes = wat::parse_str(wat).unwrap();
        let module = Module::from_buffer(&bytes).unwrap();
        let main = find_func_id(&module, "main");
        let fork_path = build_fork_path(&module, &["fork", "main"]);
        let (sites, regions) = discover_calls_and_regions(&module, main, &fork_path);
        let local_ro = match &module.funcs.get(main).kind {
            FunctionKind::Local(l) => l,
            _ => unreachable!(),
        };
        let entry = local_ro.entry_block();
        let direct_at_entry: Vec<u32> = sites
            .iter()
            .filter(|s| s.seq_id == entry)
            .map(|s| s.call_idx)
            .collect();
        let result = analyze_subregion_spill_types(
            &module,
            local_ro,
            entry,
            &fork_path,
            &direct_at_entry,
            &regions,
        )
        .expect("analyser should succeed");
        assert_eq!(result.len(), 1);
        assert!(
            result[0].is_empty(),
            "no params, no carryover → empty spill list"
        );
    }

    #[test]
    fn rewrite_chunk_locals_to_frame_unreified_locals_pass_through() {
        let (mut module, memory, frame_ptr) = build_module_with_memory_and_frame_ptr();
        let unreified = module.locals.add(ValType::I32);
        let chunk = vec![(
            Instr::LocalGet(LocalGet { local: unreified }),
            InstrLocId::default(),
        )];
        let (rewritten, new_locals) = rewrite_chunk_locals_to_frame(
            &mut module,
            chunk,
            frame_ptr,
            memory,
            &[], // empty reify list — nothing to rewrite
        );

        assert!(new_locals.is_empty(), "no temps allocated");
        assert_eq!(rewritten.len(), 1);
        match &rewritten[0].0 {
            Instr::LocalGet(LocalGet { local }) => assert_eq!(*local, unreified),
            other => panic!("expected unchanged LocalGet, got {other:?}"),
        }
    }

    #[test]
    fn extract_chunk_to_function_validates_when_chunk_is_self_contained() {
        // A self-contained chunk (no local refs, balanced operand stack)
        // should produce wasm that round-trips through wasmparser.
        let mut module = Module::default();
        let body = vec![
            (
                Instr::Const(Const {
                    value: Value::I32(42),
                }),
                InstrLocId::default(),
            ),
            (Instr::Drop(Drop {}), InstrLocId::default()),
        ];
        let _ = extract_chunk_to_function(&mut module, "validates", body);

        let bytes = module.emit_wasm();
        let mut validator =
            wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::default());
        validator
            .validate_all(&bytes)
            .expect("extracted-only module must validate");
    }

    #[test]
    fn emit_per_function_post_table_independent_owners_get_independent_tables() {
        let (mut module, post_funcs) = build_module_with_stubs(2);
        let post_a = vec![post_funcs[0]];
        let post_b = vec![post_funcs[1]];

        let table_a = emit_per_function_post_table(&mut module, "fn_a", &post_a);
        let table_b = emit_per_function_post_table(&mut module, "fn_b", &post_b);

        assert_ne!(table_a, table_b);
        let ta = find_table_by_name(&module, "fn_a_post_table").unwrap();
        let tb = find_table_by_name(&module, "fn_b_post_table").unwrap();
        assert_eq!(ta.id(), table_a);
        assert_eq!(tb.id(), table_b);

        // Each table has its own elem populating it with its own
        // funcs — no cross-contamination.
        let elem_a = find_active_elem_for(&module, table_a).unwrap();
        let elem_b = find_active_elem_for(&module, table_b).unwrap();
        match (&elem_a.items, &elem_b.items) {
            (walrus::ElementItems::Functions(ids_a), walrus::ElementItems::Functions(ids_b)) => {
                assert_eq!(ids_a, &post_a);
                assert_eq!(ids_b, &post_b);
            }
            _ => panic!("expected Functions items in both elems"),
        }
    }
}
