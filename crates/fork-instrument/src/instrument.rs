//! Per-function instrumentation — switch-dispatch transform.
//!
//! This module rewrites every fork-path function's body into an
//! asyncify-style switch dispatch: during REWIND, execution jumps
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
//!       ;; pop frame from save buffer, restore locals, call_idx,
//!       ;; catch_region_id, exnref_slot, arg-spill locals
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
//!                 (local.get $call_idx_local)
//!                 (br_table $POST_0 $POST_1 ... $POST_{N-1} $unwind_save)))
//!             ;; NORMAL: fall through out of $dispatch_normal
//!           )
//!           <chunk 0>                ;; pre-call-0 body, only NORMAL
//!           <spill args for call 0>  ;; into user-visible locals
//!         )  ;; end $POST_0 — also the br_table landing for call_idx==0
//!         <reload args for call 0>
//!         (call $callee_0)           ;; or call_indirect
//!         <Phase 6e: set catch_region_id_local / exnref_slot_local>
//!         (local.set $call_idx_local (i32.const 0))
//!         (global.get $_wpk_fork_state) (i32.const 1) (i32.eq)
//!         (br_if $unwind_save)        ;; propagate UNWINDING
//!         <chunk 1>
//!         <spill args for call 1>
//!       )  ;; end $POST_1
//!       ...
//!     )  ;; end $POST_{N-1}
//!     <reload args for call N-1>
//!     (call $callee_{N-1})
//!     <Phase 6e>
//!     (local.set $call_idx_local (i32.const N-1))
//!     (br_if $unwind_save if UNWINDING)
//!     <chunk N: tail>
//!     (return)                       ;; normal-path exit
//!   )  ;; end $unwind_save — br target for UNWINDING propagation
//!
//!   ;; --- POSTAMBLE (runs only when branched-to via br $unwind_save) ---
//!   ;; push frame header (func_index, call_index, catch_region_id,
//!   ;; exnref_slot), save scalar user locals, save arg-spill locals,
//!   ;; spill ref-typed user locals to aux tables, advance current_pos,
//!   ;; push defaults for the function's result types
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
    AbstractHeapType, FunctionId, FunctionKind, GlobalId, HeapType, LocalFunction, LocalId,
    MemoryId, Module, RefType, TableId, TypeId, ValType,
    ir::{
        BinaryOp, Binop, Block, Br, BrIf, BrTable, Call, CallIndirect, Const, Drop, GlobalGet,
        IfElse, Instr, InstrLocId, InstrSeqId, InstrSeqType, LegacyCatch, LoadKind, LocalGet,
        LocalSet, LocalTee, Loop, MemArg, RefAsNonNull, RefNull, Return, StoreKind, TableGet,
        TableSet, ThrowRef, TryTable, TryTableCatch, Unreachable, Value,
    },
};

use crate::runtime::{self, Runtime};

/// Instrument every function in `fork_path` that we can instrument.
///
/// Returns the set of function IDs that were actually rewritten.
pub fn instrument_functions(
    module: &mut Module,
    runtime: &Runtime,
    fork_path: &HashSet<FunctionId>,
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

    let mut instrumented = HashSet::new();
    for (ordinal, id) in targets.iter().enumerate() {
        let empty_plan: Vec<RefLocalSlot> = Vec::new();
        let this_plan = ref_plan.get(id).unwrap_or(&empty_plan);
        let empty_catch_plan: Vec<CatchRegionPlan> = Vec::new();
        let this_catch_plan = catch_plans.get(id).unwrap_or(&empty_catch_plan);
        instrument_one_function(
            module,
            *id,
            runtime,
            fork_path,
            ordinal as u32,
            &aux_tables,
            this_plan,
            this_catch_plan,
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
) {
    // Choose scheme based on call-site topology. Both schemes
    // implement the same fork-resume contract and share the frame
    // layout; they differ only in how REWIND reaches the resumed call:
    //
    //   switch-dispatch: body is restructured so a top-level `br_table`
    //   jumps directly to the resumed call site, skipping all code in
    //   between. Works only when every fork-path call lives at the
    //   function's top level -- wasm forbids `br_table` from branching
    //   into a nested block from outside.
    //
    //   guard-dispatch: each fork-path call site is gated in place by
    //   an if-else whose condition is `(NORMAL) || (REWIND && call_idx
    //   == N)`. The body re-executes linearly on REWIND; Phase 4g
    //   gates state-mutating ops so they don't re-fire. Handles
    //   arbitrary nesting.
    //
    // Catch-handler bodies live inside a nested try_table, so
    // fork-from-catch is routed to guard-dispatch by the nested-call
    // check. No separate detector needed.
    //
    // Switch-dispatch additionally requires that each top-level
    // fork-path call site leave the operand stack with *only* that
    // call's arguments — any value pushed before the args and consumed
    // after the call (a "carryover") cannot be expressed in switch-
    // dispatch's `$POST_K` block shape, which is 0 → 0. LLVM emits
    // carryovers routinely for expressions like `*(sp + K) = call(...)`
    // where `sp` is pushed, then the call's args, then i32.store. When
    // we detect a carryover, fall back to guard-dispatch, whose per-
    // call `if-else` shim preserves the enclosing stack.
    if has_nested_fork_calls(module, func_id, fork_path)
        || has_top_level_stack_carryovers(module, func_id, fork_path)
    {
        instrument_one_function_guard_dispatch(
            module,
            func_id,
            runtime,
            fork_path,
            func_ordinal,
            aux_tables,
            ref_plan,
            catch_plan,
        );
        return;
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
) {
    // Pre-existing user locals (args + referenced in body). Scalars
    // live in the frame; ref-typed locals go through aux tables.
    let all_user_locals = collect_user_locals(module, func_id);
    let user_scalar_locals: Vec<(LocalId, ValType)> = all_user_locals
        .iter()
        .copied()
        .filter(|(_, ty)| is_scalar(*ty))
        .collect();

    // Take the original entry body; we rebuild it wholesale.
    let entry_id = local_mut(module, func_id).entry_block();
    let original_body: Vec<(Instr, InstrLocId)> = std::mem::take(
        &mut local_mut(module, func_id).block_mut(entry_id).instrs,
    );

    // Partition the body at top-level fork-path call sites.
    let (chunks, call_sites) = partition_body(&original_body, fork_path, module);
    let n_calls = call_sites.len();

    // Allocate per-function synthetic locals.
    let call_idx_local = module.locals.add(ValType::I32);
    let frame_ptr_local = module.locals.add(runtime.buf_type);
    let catch_region_id_local = module.locals.add(ValType::I32);
    let exnref_slot_local = module.locals.add(ValType::I32);

    // Per-call arg-spill locals. Allocating them up front — before any
    // IR mutation — lets the frame layout see them as user-visible
    // scalar locals. Fork-path calls with ref-typed args are rejected
    // up front (MVP limitation).
    let mut arg_spills: Vec<Vec<LocalId>> = Vec::with_capacity(n_calls);
    for cs in &call_sites {
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
        let spills: Vec<LocalId> = arg_types.iter().map(|&ty| module.locals.add(ty)).collect();
        arg_spills.push(spills);
    }

    // Combined scalar locals for the frame (user locals first, then
    // per-call arg spills in call order).
    let mut frame_scalars: Vec<(LocalId, ValType)> = user_scalar_locals.clone();
    for (site_idx, cs) in call_sites.iter().enumerate() {
        let arg_types = call_arg_types(module, cs);
        for (&lid, &ty) in arg_spills[site_idx].iter().zip(arg_types.iter()) {
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
    // try_table body. Dead code in the MVP (fork-from-catch is
    // rejected), but kept to preserve the exnref serialization path
    // for future work.
    if aux_tables.exnref.is_some() {
        inject_rewind_throw_stubs(
            module,
            func_id,
            runtime,
            catch_region_id_local,
            aux_tables,
            catch_plan,
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

    // Build POST_K blocks (one per call) and the dispatch block.
    let unwind_save = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();
    let dispatch_normal = if n_calls > 0 {
        Some(
            local
                .builder_mut()
                .dangling_instr_seq(InstrSeqType::Simple(None))
                .id(),
        )
    } else {
        None
    };
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
        frame_ptr_local,
        call_idx_local,
        catch_region_id_local,
        exnref_slot_local,
        &locals_with_offsets,
        ref_plan,
        aux_tables,
        frame_size,
    );

    // Populate $dispatch_normal: state==REWIND → br_table to POST_K.
    if let Some(dn) = dispatch_normal {
        populate_dispatch_normal(
            local,
            dn,
            runtime,
            call_idx_local,
            &post_seqs,
            unwind_save,
        );
    }

    // Populate POST_K blocks and the chain of "post-call" sequences
    // that follow their closes.
    populate_dispatch_structure(
        local,
        unwind_save,
        dispatch_normal,
        &post_seqs,
        &chunks,
        &call_sites,
        &arg_spills,
        &catch_handlers,
        runtime.state_global,
        call_idx_local,
        catch_region_id_local,
        exnref_slot_local,
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
        frame_ptr_local,
        call_idx_local,
        catch_region_id_local,
        exnref_slot_local,
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
    push_instr(entry_seq, Instr::Binop(Binop { op: BinaryOp::I32Eq }));
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
}

// ----------------------------------------------------------------------
// Body analysis: nested-call validation + partitioning
// ----------------------------------------------------------------------

/// Returns true iff the function has at least one fork-path call
/// (direct or indirect) nested inside a `block`/`loop`/`if`/`try_table`.
/// Such a function cannot use the switch-dispatch top-level br_table
/// scheme; guard-dispatch handles it instead.
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
/// Switch-dispatch cannot express carryovers: its `$POST_K` block is
/// typed Simple(None) (0 params, 0 results), so a non-empty stack at
/// the block's close fails validation. Functions with carryovers are
/// routed to guard-dispatch, whose per-call if-else shim preserves the
/// enclosing operand stack intact.
///
/// The walk is conservative: if we encounter an instruction whose
/// stack effect we can't statically determine (wasm-GC ops, legacy
/// exception `try`, …), we report `true` to force guard-dispatch.
/// Likewise for stack underflows — which shouldn't happen in valid
/// wasm, but we defensively route to guard-dispatch if the input is
/// malformed in a way we can't analyze.
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
            Instr::Call(c) if fork_path.contains(&c.func) => {
                Some(module.types.get(module.funcs.get(c.func).ty()).params().len())
            }
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
                    // Either way, fall back to guard-dispatch.
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
fn top_level_stack_effect(
    module: &Module,
    local: &LocalFunction,
    instr: &Instr,
) -> StackEffect {
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
        Instr::LocalSet(_) | Instr::GlobalSet(_) | Instr::Drop(_) => {
            Delta { pops: 1, pushes: 0 }
        }

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
            Delta { pops: p + 1, pushes: r }
        }
        Instr::TryTable(t) => {
            let (p, r) = block_params_results(t.seq);
            Delta { pops: p, pushes: r }
        }

        // --- Function calls ---
        Instr::Call(c) => {
            let t = module.types.get(module.funcs.get(c.func).ty());
            Delta { pops: t.params().len(), pushes: t.results().len() }
        }
        Instr::CallIndirect(ci) => {
            let t = module.types.get(ci.ty);
            Delta { pops: t.params().len() + 1, pushes: t.results().len() }
        }
        Instr::CallRef(cr) => {
            let t = module.types.get(cr.ty);
            Delta { pops: t.params().len() + 1, pushes: t.results().len() }
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

        // --- Wasm-GC and legacy EH: not produced by our LLVM toolchain
        //     today. Report Unknown so we conservatively route to
        //     guard-dispatch if any ever appears. ---
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
        | Instr::ArrayInitElem(_)
        | Instr::Try { .. } => Unknown,
    }
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

// ----------------------------------------------------------------------
// Dispatch-structure emission
// ----------------------------------------------------------------------

fn populate_dispatch_normal(
    local: &mut LocalFunction,
    dispatch_normal: InstrSeqId,
    runtime: &Runtime,
    call_idx_local: LocalId,
    post_seqs: &[InstrSeqId],
    unwind_save: InstrSeqId,
) {
    // Inner "if REWINDING then br_table" block.
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
        push_instr(s, Instr::LocalGet(LocalGet { local: call_idx_local }));
        push_instr(
            s,
            Instr::BrTable(BrTable {
                blocks: post_seqs.to_vec().into_boxed_slice(),
                default: unwind_save,
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
    push_instr(s, Instr::Binop(Binop { op: BinaryOp::I32Eq }));
    push_instr(
        s,
        Instr::IfElse(IfElse {
            consequent: if_then,
            alternative: if_else,
        }),
    );
}

/// Populate the nested `$POST_K` blocks and the "post-call tail" that
/// follows each one. The structure is built innermost-outward so that
/// each outer block can reference its inner-block id via
/// `Instr::Block { seq: inner }`.
#[allow(clippy::too_many_arguments)]
fn populate_dispatch_structure(
    local: &mut LocalFunction,
    unwind_save: InstrSeqId,
    dispatch_normal: Option<InstrSeqId>,
    post_seqs: &[InstrSeqId],
    chunks: &[Vec<(Instr, InstrLocId)>],
    call_sites: &[CallSiteInfo],
    arg_spills: &[Vec<LocalId>],
    catch_handlers: &[CatchHandlerInfo],
    state_global: GlobalId,
    call_idx_local: LocalId,
    catch_region_id_local: LocalId,
    exnref_slot_local: LocalId,
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

    // $POST_0 body: [Block($dispatch_normal), chunk 0, spill 0].
    {
        let s = &mut local.block_mut(post_seqs[0]).instrs;
        if let Some(dn) = dispatch_normal {
            push_instr(s, Instr::Block(Block { seq: dn }));
        }
        for (instr, loc) in &chunks[0] {
            s.push((instr.clone(), *loc));
        }
        emit_spill_args(s, &arg_spills[0]);
    }

    // $POST_K body for K in 1..n_calls:
    //   [Block($POST_{K-1}), <post-call sequence for K-1>, chunk K, spill K]
    for k in 1..n_calls {
        // Open the nested POST block. Then emit the post-call
        // sequence for call K-1 via the LocalFunction builder (needed
        // for Phase 6e's IfElse/dangling seq allocation). Finally
        // append chunk K and spill K directly.
        {
            let s = &mut local.block_mut(post_seqs[k]).instrs;
            push_instr(s, Instr::Block(Block { seq: post_seqs[k - 1] }));
        }
        emit_post_call_via_local(
            local,
            post_seqs[k],
            &call_sites[k - 1],
            k - 1,
            &arg_spills[k - 1],
            catch_handlers,
            state_global,
            call_idx_local,
            catch_region_id_local,
            exnref_slot_local,
            unwind_save,
        );
        {
            let s = &mut local.block_mut(post_seqs[k]).instrs;
            for (instr, loc) in &chunks[k] {
                s.push((instr.clone(), *loc));
            }
            emit_spill_args(s, &arg_spills[k]);
        }
    }

    // $unwind_save body:
    //   [Block($POST_{n-1}), <post-call sequence for n-1>, chunk n, return]
    {
        let s = &mut local.block_mut(unwind_save).instrs;
        push_instr(s, Instr::Block(Block { seq: post_seqs[n_calls - 1] }));
    }
    emit_post_call_via_local(
        local,
        unwind_save,
        &call_sites[n_calls - 1],
        n_calls - 1,
        &arg_spills[n_calls - 1],
        catch_handlers,
        state_global,
        call_idx_local,
        catch_region_id_local,
        exnref_slot_local,
        unwind_save,
    );
    {
        let s = &mut local.block_mut(unwind_save).instrs;
        for (instr, loc) in &chunks[n_calls] {
            s.push((instr.clone(), *loc));
        }
        push_instr(s, Instr::Return(Return {}));
    }
}

/// Spill the arg values off the operand stack into the per-call
/// spill locals. Args are spilled in reverse (top-of-stack first),
/// so the deepest arg ends up in `spills[0]`.
fn emit_spill_args(out: &mut Vec<(Instr, InstrLocId)>, spills: &[LocalId]) {
    for &local in spills.iter().rev() {
        push_instr(out, Instr::LocalSet(LocalSet { local }));
    }
}

/// Emit Phase 6e writes inline. Must be called with mutable access to
/// the function (so dangling seqs can be allocated for each handler's
/// if-branch).
fn emit_phase_6e_writes(
    local: &mut LocalFunction,
    seq_id: InstrSeqId,
    catch_handlers: &[CatchHandlerInfo],
    catch_region_id_local: LocalId,
    exnref_slot_local: LocalId,
) {
    if catch_handlers.is_empty() {
        return;
    }
    {
        let s = &mut local.block_mut(seq_id).instrs;
        push_instr(s, Instr::Const(Const { value: Value::I32(0) }));
        push_instr(
            s,
            Instr::LocalSet(LocalSet {
                local: catch_region_id_local,
            }),
        );
        push_instr(s, Instr::Const(Const { value: Value::I32(0) }));
        push_instr(
            s,
            Instr::LocalSet(LocalSet {
                local: exnref_slot_local,
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
                    local: catch_region_id_local,
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
                    local: exnref_slot_local,
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
    frame_ptr_local: LocalId,
    call_idx_local: LocalId,
    catch_region_id_local: LocalId,
    exnref_slot_local: LocalId,
    locals_with_offsets: &[(LocalId, ValType, u32)],
    ref_plan: &[RefLocalSlot],
    aux_tables: &AuxTables,
    frame_size: u32,
) {
    let s = &mut local.block_mut(preamble_then).instrs;

    // frame_ptr = *(buf + 0) - frame_size
    push_instr(
        s,
        Instr::GlobalGet(GlobalGet {
            global: runtime.buf_global,
        }),
    );
    push_instr(s, load_ptr(memory, ptr_ty, 0));
    push_instr(s, ptr_const(ptr_ty, frame_size as i64));
    push_instr(s, Instr::Binop(Binop { op: ptr_sub(ptr_ty) }));
    push_instr(s, Instr::LocalSet(LocalSet { local: frame_ptr_local }));

    // *(buf + 0) = frame_ptr
    push_instr(
        s,
        Instr::GlobalGet(GlobalGet {
            global: runtime.buf_global,
        }),
    );
    push_instr(s, Instr::LocalGet(LocalGet { local: frame_ptr_local }));
    push_instr(s, store_ptr(memory, ptr_ty, 0));

    // call_idx_local = *(frame_ptr + CALL_INDEX_OFFSET)
    push_instr(s, Instr::LocalGet(LocalGet { local: frame_ptr_local }));
    push_instr(s, load_i32(memory, CALL_INDEX_OFFSET));
    push_instr(s, Instr::LocalSet(LocalSet { local: call_idx_local }));

    // catch_region_id_local / exnref_slot_local
    push_instr(s, Instr::LocalGet(LocalGet { local: frame_ptr_local }));
    push_instr(s, load_i32(memory, CATCH_REGION_OFFSET));
    push_instr(
        s,
        Instr::LocalSet(LocalSet {
            local: catch_region_id_local,
        }),
    );

    push_instr(s, Instr::LocalGet(LocalGet { local: frame_ptr_local }));
    push_instr(s, load_i32(memory, EXNREF_SLOT_OFFSET));
    push_instr(
        s,
        Instr::LocalSet(LocalSet {
            local: exnref_slot_local,
        }),
    );

    // Restore scalar user locals (includes arg-spill locals).
    for &(lid, ty, off) in locals_with_offsets {
        push_instr(s, Instr::LocalGet(LocalGet { local: frame_ptr_local }));
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
    frame_ptr_local: LocalId,
    call_idx_local: LocalId,
    catch_region_id_local: LocalId,
    exnref_slot_local: LocalId,
    locals_with_offsets: &[(LocalId, ValType, u32)],
    ref_plan: &[RefLocalSlot],
    aux_tables: &AuxTables,
    frame_size: u32,
    func_ordinal: u32,
    result_types: &[ValType],
) {
    // frame_ptr = *(buf + 0)
    push_instr(
        out,
        Instr::GlobalGet(GlobalGet {
            global: runtime.buf_global,
        }),
    );
    push_instr(out, load_ptr(memory, ptr_ty, 0));
    push_instr(
        out,
        Instr::LocalSet(LocalSet {
            local: frame_ptr_local,
        }),
    );

    // frame[0] = func_ordinal
    push_instr(
        out,
        Instr::LocalGet(LocalGet {
            local: frame_ptr_local,
        }),
    );
    push_instr(
        out,
        Instr::Const(Const {
            value: Value::I32(func_ordinal as i32),
        }),
    );
    push_instr(out, store_i32(memory, FUNC_INDEX_OFFSET));

    // frame[4] = call_idx_local
    push_instr(
        out,
        Instr::LocalGet(LocalGet {
            local: frame_ptr_local,
        }),
    );
    push_instr(
        out,
        Instr::LocalGet(LocalGet {
            local: call_idx_local,
        }),
    );
    push_instr(out, store_i32(memory, CALL_INDEX_OFFSET));

    // frame[8] = catch_region_id_local
    push_instr(
        out,
        Instr::LocalGet(LocalGet {
            local: frame_ptr_local,
        }),
    );
    push_instr(
        out,
        Instr::LocalGet(LocalGet {
            local: catch_region_id_local,
        }),
    );
    push_instr(out, store_i32(memory, CATCH_REGION_OFFSET));

    // frame[12] = exnref_slot_local
    push_instr(
        out,
        Instr::LocalGet(LocalGet {
            local: frame_ptr_local,
        }),
    );
    push_instr(
        out,
        Instr::LocalGet(LocalGet {
            local: exnref_slot_local,
        }),
    );
    push_instr(out, store_i32(memory, EXNREF_SLOT_OFFSET));

    // Save scalar user + arg-spill locals
    for &(lid, ty, off) in locals_with_offsets {
        push_instr(
            out,
            Instr::LocalGet(LocalGet {
                local: frame_ptr_local,
            }),
        );
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
    push_instr(
        out,
        Instr::LocalGet(LocalGet {
            local: frame_ptr_local,
        }),
    );
    push_instr(out, ptr_const(ptr_ty, frame_size as i64));
    push_instr(out, Instr::Binop(Binop { op: ptr_add(ptr_ty) }));
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
/// - tag `call_idx_local` with K
/// - UNWINDING propagation: `br_if $unwind_save` if state == UNWINDING
///
/// Takes `&mut LocalFunction` so Phase 6e can allocate dangling
/// IfElse branches for each handler check.
#[allow(clippy::too_many_arguments)]
fn emit_post_call_via_local(
    local: &mut LocalFunction,
    seq_id: InstrSeqId,
    call: &CallSiteInfo,
    call_idx: usize,
    spills: &[LocalId],
    catch_handlers: &[CatchHandlerInfo],
    state_global: GlobalId,
    call_idx_local: LocalId,
    catch_region_id_local: LocalId,
    exnref_slot_local: LocalId,
    unwind_save: InstrSeqId,
) {
    // Reload args.
    {
        let s = &mut local.block_mut(seq_id).instrs;
        for &l in spills.iter() {
            push_instr(s, Instr::LocalGet(LocalGet { local: l }));
        }
        let call_instr = match call.target {
            CallTarget::Direct(func) => Instr::Call(Call { func }),
            CallTarget::Indirect { table } => Instr::CallIndirect(CallIndirect {
                ty: call.sig_ty,
                table,
            }),
        };
        s.push((call_instr, call.loc));
    }

    emit_phase_6e_writes(
        local,
        seq_id,
        catch_handlers,
        catch_region_id_local,
        exnref_slot_local,
    );

    let s = &mut local.block_mut(seq_id).instrs;
    push_instr(
        s,
        Instr::Const(Const {
            value: Value::I32(call_idx as i32),
        }),
    );
    push_instr(
        s,
        Instr::LocalSet(LocalSet {
            local: call_idx_local,
        }),
    );
    push_instr(s, Instr::GlobalGet(GlobalGet { global: state_global }));
    push_instr(
        s,
        Instr::Const(Const {
            value: Value::I32(runtime::STATE_UNWINDING),
        }),
    );
    push_instr(s, Instr::Binop(Binop { op: BinaryOp::I32Eq }));
    push_instr(
        s,
        Instr::BrIf(BrIf {
            block: unwind_save,
        }),
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
    user_scalar_locals.iter().map(|(_, ty)| scalar_size(*ty)).sum()
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
                    LegacyCatch::Catch { handler, .. }
                    | LegacyCatch::CatchAll { handler } => ids.push(*handler),
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

fn default_for_type(ty: ValType) -> Option<Instr> {
    Some(match ty {
        ValType::I32 => Instr::Const(Const { value: Value::I32(0) }),
        ValType::I64 => Instr::Const(Const { value: Value::I64(0) }),
        ValType::F32 => Instr::Const(Const { value: Value::F32(0.0) }),
        ValType::F64 => Instr::Const(Const { value: Value::F64(0.0) }),
        ValType::V128 => Instr::Const(Const { value: Value::V128(0) }),
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
        ValType::I32 => Instr::Const(Const { value: Value::I32(v as i32) }),
        ValType::I64 => Instr::Const(Const { value: Value::I64(v) }),
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

// ----------------------------------------------------------------------
// Phase 6c — rewind-throw stub injection
// ----------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn inject_rewind_throw_stubs(
    module: &mut Module,
    func_id: FunctionId,
    runtime: &Runtime,
    catch_region_id_local: LocalId,
    aux_tables: &AuxTables,
    catch_plan: &[CatchRegionPlan],
) {
    let exnref_table = match aux_tables.exnref {
        Some(t) => t,
        None => {
            debug_assert!(catch_plan.is_empty());
            return;
        }
    };

    for plan in catch_plan {
        let body_seq_id = plan.body_seq;
        let region_id = plan.catch_region_id;
        let slot = plan.exnref_slot;

        let local = local_mut(module, func_id);
        let then_id = local
            .builder_mut()
            .dangling_instr_seq(InstrSeqType::Simple(None))
            .id();
        let else_id = local
            .builder_mut()
            .dangling_instr_seq(InstrSeqType::Simple(None))
            .id();
        {
            let s = &mut local.block_mut(then_id).instrs;
            push_instr(
                s,
                Instr::Const(Const {
                    value: Value::I32(slot as i32),
                }),
            );
            push_instr(s, Instr::TableGet(TableGet { table: exnref_table }));
            push_instr(s, Instr::RefAsNonNull(RefAsNonNull {}));
            push_instr(s, Instr::ThrowRef(ThrowRef {}));
        }

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
        push_instr(body, Instr::Binop(Binop { op: BinaryOp::I32Eq }));
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
        push_instr(body, Instr::Binop(Binop { op: BinaryOp::I32Eq }));
        push_instr(body, Instr::Binop(Binop { op: BinaryOp::I32And }));
        push_instr(
            body,
            Instr::IfElse(IfElse {
                consequent: then_id,
                alternative: else_id,
            }),
        );

        body.extend(original);
    }
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
            push_instr(s, Instr::Br(Br { block: outer_seq_id }));
        }

        {
            let local = local_mut(module, func_id);
            let s = &mut local.block_mut(outer_seq_id).instrs;
            push_instr(s, Instr::Block(Block { seq: capture_seq_id }));
            push_instr(
                s,
                Instr::LocalTee(LocalTee {
                    local: info.captured_exnref_local,
                }),
            );
            push_instr(s, Instr::Const(Const { value: Value::I32(1) }));
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
            push_instr(s, Instr::TableSet(TableSet { table: exnref_table }));
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

// ======================================================================
// Guard-dispatch scheme (Phase 4b/4c/4d/4g + Phase 6)
// ======================================================================
//
// Counterpart to switch-dispatch. Used for fork-path functions that
// have one or more fork-path calls nested inside a block/loop/if/
// try_table -- these cannot use the top-level `br_table` dispatch
// because wasm forbids branching into a nested block from outside.
//
// Each fork-path call site is wrapped in an in-place guard: an
// if-else whose condition is `(state == NORMAL) || (state == REWINDING
// && call_idx == N)`. On NORMAL, the call fires. On REWIND at a
// matching idx, the call also fires (so the child re-enters the
// kernel for the fork). On REWIND at a non-matching idx, defaults are
// pushed and the body continues past the call. Every observable
// side-effect op (local.set / store / memory.grow / ...) is wrapped
// in `if state == NORMAL` (Phase 4g) so it doesn't re-fire during
// REWIND's linear replay of the body.
//
// The entry block still ends up as [preamble-ifelse, Block($unwind_save),
// postamble] so the frame layout is stable across schemes.

#[allow(clippy::too_many_arguments)]
fn instrument_one_function_guard_dispatch(
    module: &mut Module,
    func_id: FunctionId,
    runtime: &Runtime,
    fork_path: &HashSet<FunctionId>,
    func_ordinal: u32,
    aux_tables: &AuxTables,
    ref_plan: &[RefLocalSlot],
    catch_plan: &[CatchRegionPlan],
) {
    let all_user_locals = collect_user_locals(module, func_id);
    let user_scalar_locals: Vec<(LocalId, ValType)> = all_user_locals
        .iter()
        .copied()
        .filter(|(_, ty)| is_scalar(*ty))
        .collect();

    let wrapper_id = wrap_body_guard_dispatch(module, func_id);

    let call_idx_local = module.locals.add(ValType::I32);
    let frame_ptr_local = module.locals.add(runtime.buf_type);
    let catch_region_id_local = module.locals.add(ValType::I32);
    let exnref_slot_local = module.locals.add(ValType::I32);

    if aux_tables.exnref.is_some() {
        inject_rewind_throw_stubs(
            module,
            func_id,
            runtime,
            catch_region_id_local,
            aux_tables,
            catch_plan,
        );
    }

    let catch_handlers = plan_catch_ref_handlers(module, func_id, catch_plan, aux_tables);

    let mut call_ctx = CallWrapCtxGuardDispatch {
        fork_path,
        state_global: runtime.state_global,
        unwind_save_id: wrapper_id,
        call_idx_local,
        catch_region_id_local,
        exnref_slot_local,
        catch_handlers: &catch_handlers,
        next_call_idx: 0,
        result_save_locals: Vec::new(),
    };
    rewrite_calls_in_seq_guard_dispatch(module, func_id, wrapper_id, &mut call_ctx);

    apply_catch_ref_handlers(module, func_id, &catch_handlers, aux_tables);

    // Result-save locals from gated non-fork-path direct calls must
    // participate in the frame so REWIND restores the parent's return
    // value into them. Append after the rewrite has finished allocating
    // them; assign_local_offsets / inject_frame_io_guard_dispatch see
    // them via the extended list.
    let mut framed_scalar_locals = user_scalar_locals;
    framed_scalar_locals.extend(call_ctx.result_save_locals.drain(..));

    let frame_size = HEADER_SIZE + user_locals_size(&framed_scalar_locals);
    inject_frame_io_guard_dispatch(
        module,
        func_id,
        runtime,
        wrapper_id,
        call_idx_local,
        frame_ptr_local,
        catch_region_id_local,
        exnref_slot_local,
        &framed_scalar_locals,
        ref_plan,
        aux_tables,
        frame_size,
        func_ordinal,
    );
}

/// Move the entry block's original instructions into a fresh nested
/// block, append an in-block `return` so normal-path execution exits
/// the function cleanly, and install an `unreachable` in the entry
/// block as a placeholder postamble. `inject_frame_io_guard_dispatch` replaces
/// the `unreachable` with the real frame-save postamble.
fn wrap_body_guard_dispatch(module: &mut Module, func_id: FunctionId) -> InstrSeqId {
    let local = local_mut(module, func_id);
    let entry_id = local.entry_block();

    let original_instrs: Vec<(Instr, InstrLocId)> =
        std::mem::take(&mut local.block_mut(entry_id).instrs);

    let wrapper_id = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();

    {
        let wrapper_seq = local.block_mut(wrapper_id);
        wrapper_seq.instrs = original_instrs;
        wrapper_seq
            .instrs
            .push((Instr::Return(Return {}), InstrLocId::default()));
    }
    {
        let entry_seq = local.block_mut(entry_id);
        entry_seq.instrs.push((
            Instr::Block(Block { seq: wrapper_id }),
            InstrLocId::default(),
        ));
        entry_seq.instrs.push((
            Instr::Unreachable(Unreachable {}),
            InstrLocId::default(),
        ));
    }

    wrapper_id
}

struct CallWrapCtxGuardDispatch<'a> {
    fork_path: &'a HashSet<FunctionId>,
    state_global: GlobalId,
    unwind_save_id: InstrSeqId,
    call_idx_local: LocalId,
    catch_region_id_local: LocalId,
    exnref_slot_local: LocalId,
    catch_handlers: &'a [CatchHandlerInfo],
    next_call_idx: u32,
    /// Result-save locals allocated for non-fork-path direct calls.
    /// These participate in the function's frame so that on REWIND the
    /// parent's actual return value is restored (rather than re-firing
    /// the call's kernel side effects). Appended to user_scalar_locals
    /// after rewrite, before frame I/O is emitted.
    result_save_locals: Vec<(LocalId, ValType)>,
}

fn rewrite_calls_in_seq_guard_dispatch(
    module: &mut Module,
    func_id: FunctionId,
    seq_id: InstrSeqId,
    ctx: &mut CallWrapCtxGuardDispatch,
) {
    let original: Vec<(Instr, InstrLocId)> =
        std::mem::take(&mut local_mut(module, func_id).block_mut(seq_id).instrs);

    let mut new_instrs: Vec<(Instr, InstrLocId)> = Vec::with_capacity(original.len());

    for (instr, loc) in original {
        for nested_id in nested_seqs(&instr) {
            rewrite_calls_in_seq_guard_dispatch(module, func_id, nested_id, ctx);
        }

        match &instr {
            Instr::Call(c) if ctx.fork_path.contains(&c.func) => {
                let callee_ty = module.funcs.get(c.func).ty();
                let callee_func = c.func;
                emit_wrapped_call_guard_dispatch(
                    module,
                    func_id,
                    &mut new_instrs,
                    ctx,
                    callee_ty,
                    CallTarget::Direct(callee_func),
                    loc,
                );
            }
            Instr::CallIndirect(ci) => {
                let ty = ci.ty;
                let table = ci.table;
                emit_wrapped_call_guard_dispatch(
                    module,
                    func_id,
                    &mut new_instrs,
                    ctx,
                    ty,
                    CallTarget::Indirect { table },
                    loc,
                );
            }
            Instr::Call(c) => {
                // Non-fork-path direct call. Gate it so kernel side
                // effects (setpgid, dup3, open, kill, ...) inside the
                // callee don't re-fire when the body re-executes during
                // REWIND. Result is saved in a frame-resident user
                // scalar local so consumers see the parent's actual
                // return value (rather than 0, which would diverge
                // control flow when the result is consumed inline).
                let callee_ty = module.funcs.get(c.func).ty();
                let callee_func = c.func;
                emit_gated_non_fork_call(
                    module,
                    func_id,
                    &mut new_instrs,
                    ctx,
                    callee_ty,
                    callee_func,
                    loc,
                );
            }
            _ => match side_effect_shape(&instr, module) {
                Some(shape) => emit_gated_side_effect(
                    module,
                    func_id,
                    &mut new_instrs,
                    ctx.state_global,
                    instr,
                    loc,
                    shape,
                ),
                None => new_instrs.push((instr, loc)),
            },
        }
    }

    local_mut(module, func_id).block_mut(seq_id).instrs = new_instrs;
}

fn emit_wrapped_call_guard_dispatch(
    module: &mut Module,
    func_id: FunctionId,
    out: &mut Vec<(Instr, InstrLocId)>,
    ctx: &mut CallWrapCtxGuardDispatch,
    sig_ty: TypeId,
    target: CallTarget,
    loc: InstrLocId,
) {
    let (params, results): (Vec<ValType>, Vec<ValType>) = {
        let ty = module.types.get(sig_ty);
        (ty.params().to_vec(), ty.results().to_vec())
    };

    let mut arg_types: Vec<ValType> = params.clone();
    if matches!(target, CallTarget::Indirect { .. }) {
        arg_types.push(ValType::I32);
    }

    let arg_locals: Vec<LocalId> = arg_types.iter().map(|&ty| module.locals.add(ty)).collect();

    let branch_ty = InstrSeqType::new(&mut module.types, &[], &results);

    let call_idx = ctx.next_call_idx;
    ctx.next_call_idx += 1;

    let state_global = ctx.state_global;
    let unwind_save_id = ctx.unwind_save_id;
    let call_idx_local = ctx.call_idx_local;

    let call_instr = match target {
        CallTarget::Direct(func) => Instr::Call(Call { func }),
        CallTarget::Indirect { table } => Instr::CallIndirect(CallIndirect {
            ty: sig_ty,
            table,
        }),
    };

    let local = local_mut(module, func_id);
    let then_id = local.builder_mut().dangling_instr_seq(branch_ty).id();
    let else_id = local.builder_mut().dangling_instr_seq(branch_ty).id();

    {
        let then_seq = local.block_mut(then_id);
        for &arg in &arg_locals {
            push_instr(&mut then_seq.instrs, Instr::LocalGet(LocalGet { local: arg }));
        }
        then_seq.instrs.push((call_instr, loc));

        push_instr(
            &mut then_seq.instrs,
            Instr::Const(Const {
                value: Value::I32(call_idx as i32),
            }),
        );
        push_instr(
            &mut then_seq.instrs,
            Instr::LocalSet(LocalSet {
                local: call_idx_local,
            }),
        );

        if !ctx.catch_handlers.is_empty() {
            push_instr(
                &mut then_seq.instrs,
                Instr::Const(Const { value: Value::I32(0) }),
            );
            push_instr(
                &mut then_seq.instrs,
                Instr::LocalSet(LocalSet {
                    local: ctx.catch_region_id_local,
                }),
            );
            push_instr(
                &mut then_seq.instrs,
                Instr::Const(Const { value: Value::I32(0) }),
            );
            push_instr(
                &mut then_seq.instrs,
                Instr::LocalSet(LocalSet {
                    local: ctx.exnref_slot_local,
                }),
            );
        }
        for info in ctx.catch_handlers {
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
                        local: ctx.catch_region_id_local,
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
                        local: ctx.exnref_slot_local,
                    }),
                );
            }
            push_instr(
                &mut local.block_mut(then_id).instrs,
                Instr::LocalGet(LocalGet {
                    local: info.in_catch_local,
                }),
            );
            push_instr(
                &mut local.block_mut(then_id).instrs,
                Instr::IfElse(IfElse {
                    consequent: ih_then,
                    alternative: ih_else,
                }),
            );
        }

        let then_seq = local.block_mut(then_id);
        push_instr(
            &mut then_seq.instrs,
            Instr::GlobalGet(GlobalGet { global: state_global }),
        );
        push_instr(
            &mut then_seq.instrs,
            Instr::Const(Const {
                value: Value::I32(runtime::STATE_UNWINDING),
            }),
        );
        push_instr(
            &mut then_seq.instrs,
            Instr::Binop(Binop { op: BinaryOp::I32Eq }),
        );
        push_instr(
            &mut then_seq.instrs,
            Instr::BrIf(BrIf {
                block: unwind_save_id,
            }),
        );
    }

    {
        let else_seq = local.block_mut(else_id);
        let mut needs_unreachable = false;
        for &ty in &results {
            match default_for_type(ty) {
                Some(instr) => push_instr(&mut else_seq.instrs, instr),
                None => {
                    needs_unreachable = true;
                    break;
                }
            }
        }
        if needs_unreachable {
            else_seq.instrs.clear();
            push_instr(&mut else_seq.instrs, Instr::Unreachable(Unreachable {}));
        }
    }

    for &arg in arg_locals.iter().rev() {
        push_instr(out, Instr::LocalSet(LocalSet { local: arg }));
    }

    // (state == NORMAL) || ((state == REWINDING) && (call_idx == N))
    push_instr(out, Instr::GlobalGet(GlobalGet { global: state_global }));
    push_instr(
        out,
        Instr::Const(Const {
            value: Value::I32(runtime::STATE_NORMAL),
        }),
    );
    push_instr(out, Instr::Binop(Binop { op: BinaryOp::I32Eq }));

    push_instr(out, Instr::GlobalGet(GlobalGet { global: state_global }));
    push_instr(
        out,
        Instr::Const(Const {
            value: Value::I32(runtime::STATE_REWINDING),
        }),
    );
    push_instr(out, Instr::Binop(Binop { op: BinaryOp::I32Eq }));

    push_instr(
        out,
        Instr::LocalGet(LocalGet {
            local: call_idx_local,
        }),
    );
    push_instr(
        out,
        Instr::Const(Const {
            value: Value::I32(call_idx as i32),
        }),
    );
    push_instr(out, Instr::Binop(Binop { op: BinaryOp::I32Eq }));

    push_instr(out, Instr::Binop(Binop { op: BinaryOp::I32And }));
    push_instr(out, Instr::Binop(Binop { op: BinaryOp::I32Or }));

    push_instr(
        out,
        Instr::IfElse(IfElse {
            consequent: then_id,
            alternative: else_id,
        }),
    );
}

/// Gate a non-fork-path direct call so its kernel side effects don't
/// re-fire during REWIND replay of a guard-dispatch fork-path body.
///
/// Shape (`call $foo` with two i32 args returning i32):
///
/// ```wat
/// ;; [arg0 arg1] on stack
/// global.get $_wpk_fork_state
/// i32.const 0       ;; STATE_NORMAL
/// i32.eq            ;; [arg0 arg1 cond]
/// if (param i32 i32) (result)
///   then
///     call $foo                 ;; consumes [arg0 arg1], pushes [r]
///     local.set $result_save_0  ;; consumes [r]
///   else
///     drop                       ;; consumes arg1
///     drop                       ;; consumes arg0
/// end
/// local.get $result_save_0       ;; [r] back on outer stack
/// ```
///
/// `$result_save_0` is a fresh user-scalar local (one per scalar
/// result type) that participates in the function's frame. On
/// UNWIND its parent value is serialized; on REWIND it is restored.
/// Consumers of the original call's result therefore see the
/// parent's actual return value during REWIND, not a default 0
/// (which would diverge control flow when the result is consumed
/// inline without `local.set`).
///
/// Calls with non-scalar results (a non-nullable `Ref`) are left
/// unwrapped: there is no scalar-frame slot we can store them in.
/// In practice, LLVM-emitted C does not produce such call sites
/// inside fork-path bodies (no Wasm-GC), so this is a deliberate
/// MVP gap rather than a known regression.
fn emit_gated_non_fork_call(
    module: &mut Module,
    func_id: FunctionId,
    out: &mut Vec<(Instr, InstrLocId)>,
    ctx: &mut CallWrapCtxGuardDispatch,
    sig_ty: TypeId,
    callee: FunctionId,
    loc: InstrLocId,
) {
    let (params, results): (Vec<ValType>, Vec<ValType>) = {
        let ty = module.types.get(sig_ty);
        (ty.params().to_vec(), ty.results().to_vec())
    };

    // If any result is a non-scalar (non-nullable ref), we can't
    // round-trip through the scalar frame. Leave the call unwrapped;
    // its side effects will still re-fire on REWIND, but this case
    // doesn't arise in practice for our toolchain.
    let all_results_framable = results.iter().all(|&ty| match ty {
        ValType::I32 | ValType::I64 | ValType::F32 | ValType::F64 | ValType::V128 => true,
        ValType::Ref(_) => false,
    });
    if !all_results_framable {
        push_instr(out, Instr::Call(Call { func: callee }));
        let _ = loc;
        return;
    }

    // Allocate one result-save local per result type. Track in ctx so
    // they get appended to user_scalar_locals after the rewrite (which
    // is what gives them frame slots).
    let save_locals: Vec<LocalId> = results
        .iter()
        .map(|&ty| {
            let l = module.locals.add(ty);
            ctx.result_save_locals.push((l, ty));
            l
        })
        .collect();

    let branch_ty = InstrSeqType::new(&mut module.types, &params, &[]);
    let local = local_mut(module, func_id);
    let then_id = local.builder_mut().dangling_instr_seq(branch_ty).id();
    let else_id = local.builder_mut().dangling_instr_seq(branch_ty).id();

    // then: call $callee, then local.set in reverse so the topmost
    //   result is captured into the last save_local.
    {
        let then_seq = local.block_mut(then_id);
        then_seq.instrs.push((Instr::Call(Call { func: callee }), loc));
        for &l in save_locals.iter().rev() {
            push_instr(&mut then_seq.instrs, Instr::LocalSet(LocalSet { local: l }));
        }
    }

    // else: drop one item per arg.
    {
        let else_seq = local.block_mut(else_id);
        for _ in 0..params.len() {
            push_instr(&mut else_seq.instrs, Instr::Drop(Drop {}));
        }
    }

    // Outer: state == NORMAL guard, then if-else, then load saved
    // results back onto the operand stack in forward order so
    // consumers see the same shape they would for an unwrapped call.
    push_instr(
        out,
        Instr::GlobalGet(GlobalGet {
            global: ctx.state_global,
        }),
    );
    push_instr(
        out,
        Instr::Const(Const {
            value: Value::I32(runtime::STATE_NORMAL),
        }),
    );
    push_instr(out, Instr::Binop(Binop { op: BinaryOp::I32Eq }));
    push_instr(
        out,
        Instr::IfElse(IfElse {
            consequent: then_id,
            alternative: else_id,
        }),
    );
    for &l in &save_locals {
        push_instr(out, Instr::LocalGet(LocalGet { local: l }));
    }
}

// ---- Phase 4g: non-call side-effect gating --------------------------

struct SideEffectShape {
    params: Vec<ValType>,
    results: Vec<ValType>,
}

fn side_effect_shape(instr: &Instr, module: &Module) -> Option<SideEffectShape> {
    let ptr_ty = |mem: MemoryId| -> ValType {
        if module.memories.get(mem).memory64 {
            ValType::I64
        } else {
            ValType::I32
        }
    };

    match instr {
        Instr::LocalSet(ls) => Some(SideEffectShape {
            params: vec![module.locals.get(ls.local).ty()],
            results: vec![],
        }),
        Instr::LocalTee(lt) => {
            let ty = module.locals.get(lt.local).ty();
            Some(SideEffectShape {
                params: vec![ty],
                results: vec![ty],
            })
        }
        Instr::GlobalSet(gs) => Some(SideEffectShape {
            params: vec![module.globals.get(gs.global).ty],
            results: vec![],
        }),
        Instr::Store(s) => {
            let val_ty = match s.kind {
                StoreKind::I32 { .. } | StoreKind::I32_8 { .. } | StoreKind::I32_16 { .. } => {
                    ValType::I32
                }
                StoreKind::I64 { .. }
                | StoreKind::I64_8 { .. }
                | StoreKind::I64_16 { .. }
                | StoreKind::I64_32 { .. } => ValType::I64,
                StoreKind::F32 => ValType::F32,
                StoreKind::F64 => ValType::F64,
                StoreKind::V128 => ValType::V128,
            };
            Some(SideEffectShape {
                params: vec![ptr_ty(s.memory), val_ty],
                results: vec![],
            })
        }
        Instr::MemoryGrow(mg) => {
            let pt = ptr_ty(mg.memory);
            Some(SideEffectShape {
                params: vec![pt],
                results: vec![pt],
            })
        }
        Instr::MemoryFill(mf) => Some(SideEffectShape {
            params: vec![ptr_ty(mf.memory), ValType::I32, ptr_ty(mf.memory)],
            results: vec![],
        }),
        Instr::MemoryCopy(mc) => Some(SideEffectShape {
            params: vec![ptr_ty(mc.dst), ptr_ty(mc.src), ptr_ty(mc.dst)],
            results: vec![],
        }),
        Instr::MemoryInit(mi) => Some(SideEffectShape {
            params: vec![ptr_ty(mi.memory), ValType::I32, ValType::I32],
            results: vec![],
        }),
        Instr::DataDrop(_) | Instr::ElemDrop(_) => Some(SideEffectShape {
            params: vec![],
            results: vec![],
        }),
        Instr::TableSet(ts) => {
            let table = module.tables.get(ts.table);
            let idx_ty = if table.table64 {
                ValType::I64
            } else {
                ValType::I32
            };
            Some(SideEffectShape {
                params: vec![idx_ty, ValType::Ref(table.element_ty)],
                results: vec![],
            })
        }
        _ => None,
    }
}

fn emit_gated_side_effect(
    module: &mut Module,
    func_id: FunctionId,
    out: &mut Vec<(Instr, InstrLocId)>,
    state_global: GlobalId,
    instr: Instr,
    loc: InstrLocId,
    shape: SideEffectShape,
) {
    let branch_ty = InstrSeqType::new(&mut module.types, &shape.params, &shape.results);

    let local = local_mut(module, func_id);
    let then_id = local.builder_mut().dangling_instr_seq(branch_ty).id();
    let else_id = local.builder_mut().dangling_instr_seq(branch_ty).id();

    local.block_mut(then_id).instrs.push((instr, loc));

    {
        let else_seq = &mut local.block_mut(else_id).instrs;
        for _ in 0..shape.params.len() {
            push_instr(else_seq, Instr::Drop(Drop {}));
        }
        let mut fallback = false;
        for &ty in &shape.results {
            match default_for_type(ty) {
                Some(d) => push_instr(else_seq, d),
                None => {
                    fallback = true;
                    break;
                }
            }
        }
        if fallback {
            else_seq.clear();
            push_instr(else_seq, Instr::Unreachable(Unreachable {}));
        }
    }

    push_instr(out, Instr::GlobalGet(GlobalGet { global: state_global }));
    push_instr(
        out,
        Instr::Const(Const {
            value: Value::I32(runtime::STATE_NORMAL),
        }),
    );
    push_instr(out, Instr::Binop(Binop { op: BinaryOp::I32Eq }));
    push_instr(
        out,
        Instr::IfElse(IfElse {
            consequent: then_id,
            alternative: else_id,
        }),
    );
}

// ---- Guard-dispatch preamble + postamble (shares frame layout) -----

#[allow(clippy::too_many_arguments)]
fn inject_frame_io_guard_dispatch(
    module: &mut Module,
    func_id: FunctionId,
    runtime: &Runtime,
    wrapper_id: InstrSeqId,
    call_idx_local: LocalId,
    frame_ptr_local: LocalId,
    catch_region_id_local: LocalId,
    exnref_slot_local: LocalId,
    user_scalar_locals: &[(LocalId, ValType)],
    ref_plan: &[RefLocalSlot],
    aux_tables: &AuxTables,
    frame_size: u32,
    func_ordinal: u32,
) {
    let memory = first_memory(module);
    let ptr_ty = runtime.buf_type;
    let locals_with_offsets = assign_local_offsets(user_scalar_locals, LOCALS_START_OFFSET);

    let result_types: Vec<ValType> = {
        let ty_id = module.funcs.get(func_id).ty();
        module.types.get(ty_id).results().to_vec()
    };

    let local = local_mut(module, func_id);

    let preamble_then = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();
    let preamble_else = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();

    populate_preamble_then(
        local,
        preamble_then,
        runtime,
        memory,
        ptr_ty,
        frame_ptr_local,
        call_idx_local,
        catch_region_id_local,
        exnref_slot_local,
        &locals_with_offsets,
        ref_plan,
        aux_tables,
        frame_size,
    );

    let mut postamble: Vec<(Instr, InstrLocId)> = Vec::new();
    populate_postamble(
        &mut postamble,
        runtime,
        memory,
        ptr_ty,
        frame_ptr_local,
        call_idx_local,
        catch_region_id_local,
        exnref_slot_local,
        &locals_with_offsets,
        ref_plan,
        aux_tables,
        frame_size,
        func_ordinal,
        &result_types,
    );

    let entry_id = local.entry_block();
    local.block_mut(entry_id).instrs.clear();

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
    push_instr(entry_seq, Instr::Binop(Binop { op: BinaryOp::I32Eq }));
    push_instr(
        entry_seq,
        Instr::IfElse(IfElse {
            consequent: preamble_then,
            alternative: preamble_else,
        }),
    );
    push_instr(entry_seq, Instr::Block(Block { seq: wrapper_id }));
    entry_seq.extend(postamble);
}
