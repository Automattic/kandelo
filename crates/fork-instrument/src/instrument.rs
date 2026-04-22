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
        BinaryOp, Binop, Block, Br, BrIf, BrTable, Call, CallIndirect, Const, GlobalGet, IfElse,
        Instr, InstrLocId, InstrSeqId, InstrSeqType, LegacyCatch, LoadKind, LocalGet, LocalSet,
        LocalTee, Loop, MemArg, RefAsNonNull, RefNull, Return, StoreKind, TableGet, TableSet,
        ThrowRef, TryTable, TryTableCatch, Value,
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
    // Pre-existing user locals (args + referenced in body). Scalars
    // live in the frame; ref-typed locals go through aux tables.
    let all_user_locals = collect_user_locals(module, func_id);
    let user_scalar_locals: Vec<(LocalId, ValType)> = all_user_locals
        .iter()
        .copied()
        .filter(|(_, ty)| is_scalar(*ty))
        .collect();

    // MVP constraint: any fork-path call nested inside a
    // block/loop/if/try_table causes `br_table` dispatch to be unable
    // to land at that call site. Detect and panic with a clear
    // diagnostic pointing at the offending function.
    validate_no_nested_fork_calls(module, func_id, fork_path);

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

    // Reject fork-path calls inside catch-handler bodies. Phase 6d
    // plumbing captures the caught exnref; a fork-path call inside a
    // handler would need the new dispatch to land there during REWIND,
    // which is the B1 follow-up. See `memory/fork-instrument-b1-followup.md`.
    validate_no_fork_call_in_catch_handler(module, func_id, fork_path, &catch_handlers);

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

fn validate_no_nested_fork_calls(
    module: &Module,
    func_id: FunctionId,
    fork_path: &HashSet<FunctionId>,
) {
    let local = match &module.funcs.get(func_id).kind {
        FunctionKind::Local(l) => l,
        _ => return,
    };

    fn walk(
        f: &LocalFunction,
        seq: InstrSeqId,
        fork_path: &HashSet<FunctionId>,
        depth: u32,
        func_name_str: &str,
    ) {
        for (instr, _) in &f.block(seq).instrs {
            match instr {
                Instr::Call(c) if fork_path.contains(&c.func) => {
                    if depth > 0 {
                        panic!(
                            "fork-instrument: function `{func_name_str}` has a fork-path direct \
                             call nested at depth {depth}. The switch-dispatch transform \
                             supports only top-level fork-path calls; restructure the source \
                             or extend the tool.",
                        );
                    }
                }
                Instr::CallIndirect(_) => {
                    if depth > 0 {
                        panic!(
                            "fork-instrument: function `{func_name_str}` has a `call_indirect` \
                             nested at depth {depth}. Every `call_indirect` in a fork-path \
                             function is treated as potentially fork-path and must live at the \
                             top level under the MVP switch-dispatch transform.",
                        );
                    }
                }
                _ => {}
            }
            for child in nested_seqs(instr) {
                walk(f, child, fork_path, depth + 1, func_name_str);
            }
        }
    }

    let name = func_name(module, func_id);
    walk(local, local.entry_block(), fork_path, 0, &name);
}

fn validate_no_fork_call_in_catch_handler(
    module: &Module,
    func_id: FunctionId,
    fork_path: &HashSet<FunctionId>,
    catch_handlers: &[CatchHandlerInfo],
) {
    // Any fork-path call reachable from a catch-handler target label
    // is a fork-from-catch pattern (B1 follow-up). The pre-transform
    // walk already rejected calls inside nested sequences (including
    // catch-handler blocks), so this is belt-and-braces — but surface
    // it explicitly to make the failure mode clear.
    if catch_handlers.is_empty() {
        return;
    }
    let local = match &module.funcs.get(func_id).kind {
        FunctionKind::Local(l) => l,
        _ => return,
    };
    for info in catch_handlers {
        let mut found = false;
        check_seq_for_fork_call(local, info.target_label, fork_path, &mut found);
        if found {
            let name = func_name(module, func_id);
            panic!(
                "fork-instrument: function `{name}` reaches a fork-path call from inside a \
                 `catch_ref` handler (region {}). Fork-from-catch is the B1 follow-up and \
                 unsupported in the MVP switch-dispatch transform. See \
                 `memory/fork-instrument-b1-followup.md`.",
                info.catch_region_id,
            );
        }
    }
}

fn check_seq_for_fork_call(
    f: &LocalFunction,
    seq: InstrSeqId,
    fork_path: &HashSet<FunctionId>,
    found: &mut bool,
) {
    if *found {
        return;
    }
    for (instr, _) in &f.block(seq).instrs {
        match instr {
            Instr::Call(c) if fork_path.contains(&c.func) => {
                *found = true;
                return;
            }
            Instr::CallIndirect(_) => {
                *found = true;
                return;
            }
            _ => {}
        }
        for child in nested_seqs(instr) {
            check_seq_for_fork_call(f, child, fork_path, found);
            if *found {
                return;
            }
        }
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
