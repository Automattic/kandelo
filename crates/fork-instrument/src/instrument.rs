//! Per-function instrumentation.
//!
//! Scope through Phase 4d:
//!
//! - **4b** — structural wrap of every fork-path function body in a
//!   `$unwind_save` block.
//! - **4c** — at every call / `call_indirect` site inside a wrapped
//!   function that targets a fork-path callee, emit a state-machine
//!   if-gate that guards the call, tags the per-function `$call_idx`
//!   local, and propagates UNWINDING via `br_if $unwind_save`.
//! - **4d** — replace the placeholder `unreachable` postamble with a
//!   real unwind-save: write the frame header (func_index, call_index,
//!   catch_region_id, exnref_slot) and each scalar user local into
//!   `_wpk_fork_buf`, then advance `current_pos`. Inject a preamble
//!   that loads the frame header + locals when state == REWINDING.
//!   Extend the call-site condition to also take the then-branch when
//!   `state == REWINDING && $call_idx == N`, and populate the else
//!   branch with default values for the call's result types.
//!
//! Reference-typed locals and mutable globals are deferred to Phase
//! 4e / 4f; 4d handles only scalar locals (i32, i64, f32, f64, v128).
//!
//! ## Frame layout (4d)
//!
//! All offsets are relative to the frame's base address (pushed at
//! `current_pos` when saving, read from `current_pos - frame_size`
//! when loading). Frame grows upward.
//!
//! | Offset        | Size | Field             |
//! |---------------|------|-------------------|
//! | 0             | 4    | `func_index`      |
//! | 4             | 4    | `call_index`      |
//! | 8             | 4    | `catch_region_id` |
//! | 12            | 4    | `exnref_slot`     |
//! | 16..          | var  | scalar locals     |
//!
//! The frame size is fixed per function (16 + total scalar-local
//! byte-size) and is encoded as a constant at emit time.
//!
//! ## Buffer header (read/written by preamble/postamble)
//!
//! ```text
//! *(_wpk_fork_buf + 0) : current_pos (pointer, ptr-width)
//! ```
//!
//! Phase 4e will extend the buffer header with saved mutable globals.

use std::collections::{HashMap, HashSet};

use walrus::{
    AbstractHeapType, FunctionId, FunctionKind, GlobalId, HeapType, LocalFunction, LocalId,
    MemoryId, Module, RefType, TableId, TypeId, ValType,
    ir::{
        BinaryOp, Binop, Block, BrIf, Call, CallIndirect, Const, Drop, GlobalGet, IfElse,
        Instr, InstrLocId, InstrSeqId, InstrSeqType, LegacyCatch, LoadKind, LocalGet, LocalSet,
        Loop, MemArg, RefAsNonNull, RefNull, Return, StoreKind, TableGet, TableSet, ThrowRef,
        TryTable, Unreachable, Value, dfs_in_order,
    },
};

use crate::runtime::{self, Runtime};

/// Instrument every function in `fork_path` that we can instrument.
///
/// Returns the set of function IDs that were actually rewritten. Each
/// rewritten function is tagged with a unique `func_ordinal` (0..N)
/// that gets embedded into saved frames as `func_index`.
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

    // Collect targets before mutating. Sort by a stable key (we use
    // the function's walrus id, which has a total order) so that
    // `func_ordinal` assignments are deterministic across runs.
    let mut targets: Vec<FunctionId> = fork_path
        .iter()
        .copied()
        .filter(|id| !runtime_funcs.contains(id))
        .filter(|id| matches!(module.funcs.get(*id).kind, FunctionKind::Local(_)))
        .collect();
    targets.sort();

    // Phase 4f — plan aux-table slot assignments for every ref-typed
    // user local across the fork-path closure, then inject the tables
    // sized to exactly fit. Functions with no ref locals contribute
    // zero slots and receive an empty plan.
    //
    // Phase 6a — discover every `try_table` on the fork path and
    // assign it a per-function `catch_region_id` plus a slot in the
    // shared exnref stash (sized to `count(exnref locals) +
    // count(fork-path try_tables)`).
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

/// Full per-function instrumentation pipeline: structural wrap (4b),
/// then call-site state-machine gating (4c), then frame-I/O preamble
/// + postamble (4d), with ref-typed locals spilled through aux tables
/// (4f), and — Phase 6 — per-try_table rewind-throw stubs driven by
/// a frame-serialized `catch_region_id`.
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
    // Step 0: capture user locals (args + anything already referenced
    // in the body) *before* any mutation so we don't conflate them
    // with synthetic locals we add later. Partition into scalar (for
    // linear-memory frame) and ref-typed (for aux-table stash).
    let all_user_locals = collect_user_locals(module, func_id);
    let user_scalar_locals: Vec<(LocalId, ValType)> = all_user_locals
        .iter()
        .copied()
        .filter(|(_, ty)| is_scalar(*ty))
        .collect();

    // Step 4b — wrap the body.
    let wrapper_id = wrap_body(module, func_id);

    // Synthetic per-function locals. `call_idx_local` is read by the
    // if-gate condition, set by each wrapped call, serialized by the
    // postamble, and reloaded by the preamble. `frame_ptr_local`
    // holds the current frame's base address while preamble/postamble
    // run. The Phase 6 locals `catch_region_id_local` and
    // `exnref_slot_local` are always added (even if the function has
    // no try_tables) so the frame layout — and preamble/postamble
    // shape — stays uniform across instrumented functions.
    let call_idx_local = module.locals.add(ValType::I32);
    let frame_ptr_local = module.locals.add(runtime.buf_type);
    let catch_region_id_local = module.locals.add(ValType::I32);
    let exnref_slot_local = module.locals.add(ValType::I32);

    // Step 6c — inject the rewind-throw stub at the start of each
    // try_table body on the fork path, *before* call-site rewriting so
    // its ops (global.get / if-else) are seen by 4g's side-effect gater
    // only where appropriate. The stub itself performs side-effect-free
    // ops (the GlobalGet / LocalGet / Binop / If-guard); the IfElse
    // gates on state and, when matched, performs throw_ref.
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

    // Step 4c — rewrite calls with the full 4d-ready condition so
    // that REWINDING at the matching call_idx also enters the then-
    // branch and the else-branch supplies default result values.
    let mut call_ctx = CallWrapCtx {
        fork_path,
        state_global: runtime.state_global,
        unwind_save_id: wrapper_id,
        call_idx_local,
        next_call_idx: 0,
    };
    rewrite_calls_in_seq(module, func_id, wrapper_id, &mut call_ctx);

    // Step 4d+4f+6b — preamble (REWINDING frame-load + ref reloads +
    // catch_region_id / exnref_slot reloads) + postamble (frame-save
    // + ref spills + catch_region_id / exnref_slot writes + default
    // returns).
    let frame_size = HEADER_SIZE + user_locals_size(&user_scalar_locals);
    inject_frame_io(
        module,
        func_id,
        runtime,
        wrapper_id,
        call_idx_local,
        frame_ptr_local,
        catch_region_id_local,
        exnref_slot_local,
        &user_scalar_locals,
        ref_plan,
        aux_tables,
        frame_size,
        func_ordinal,
    );
}

// ----------------------------------------------------------------------
// Phase 4b — structural body wrap
// ----------------------------------------------------------------------

/// Move the entry block's original instructions into a fresh nested
/// block, append an in-block `return` so normal-path execution exits
/// the function cleanly, and install `unreachable` in the entry block
/// as a placeholder postamble. Phase 4d replaces the `unreachable`
/// with the real frame-save postamble. Returns the wrapper block id.
fn wrap_body(module: &mut Module, func_id: FunctionId) -> InstrSeqId {
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

// ----------------------------------------------------------------------
// Phase 4c — call-site state-machine wrap
// ----------------------------------------------------------------------

/// State threaded through the recursive call-wrap pass.
struct CallWrapCtx<'a> {
    fork_path: &'a HashSet<FunctionId>,
    state_global: GlobalId,
    unwind_save_id: InstrSeqId,
    call_idx_local: LocalId,
    next_call_idx: u32,
}

/// Recursively walk every instruction sequence reachable from
/// `seq_id`, rewriting `Call` / `CallIndirect` instructions that
/// target fork-path callees.
///
/// Order: we recurse into nested sequences *before* processing the
/// owning instruction so that `call_idx` is assigned in source-order
/// (DFS). This matches the contract the 4d postamble/preamble rely
/// on: reading `call_idx` tells you which call site triggered the
/// unwind deterministically.
fn rewrite_calls_in_seq(
    module: &mut Module,
    func_id: FunctionId,
    seq_id: InstrSeqId,
    ctx: &mut CallWrapCtx,
) {
    let original: Vec<(Instr, InstrLocId)> =
        std::mem::take(&mut local_mut(module, func_id).block_mut(seq_id).instrs);

    let mut new_instrs: Vec<(Instr, InstrLocId)> = Vec::with_capacity(original.len());

    for (instr, loc) in original {
        for nested_id in nested_seqs(&instr) {
            rewrite_calls_in_seq(module, func_id, nested_id, ctx);
        }

        match &instr {
            Instr::Call(c) if ctx.fork_path.contains(&c.func) => {
                let callee_ty = module.funcs.get(c.func).ty();
                let callee_func = c.func;
                emit_wrapped_call(
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
                // Every indirect call in a wrapped function might
                // dispatch to a fork-path target (Phase 3's closure
                // already required this), so all must be wrapped.
                let ty = ci.ty;
                let table = ci.table;
                emit_wrapped_call(
                    module,
                    func_id,
                    &mut new_instrs,
                    ctx,
                    ty,
                    CallTarget::Indirect { table },
                    loc,
                );
            }
            _ => {
                // Phase 4g — if the instruction has observable side
                // effects on state that survives across the fork
                // checkpoint (memory, globals, locals, tables), wrap
                // it in a `state == NORMAL` guard. Control-flow and
                // value-producing-only ops fall through to an
                // un-gated push.
                match side_effect_shape(&instr, module) {
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
                }
            }
        }
    }

    local_mut(module, func_id).block_mut(seq_id).instrs = new_instrs;
}

/// Inner `InstrSeqId`s nested inside `instr`, if any. Control-flow
/// constructs (block/loop/if/try/try_table/legacy-catch-handlers)
/// embed nested sequences we need to traverse. Instructions that
/// *target* other blocks (br, br_if, br_table) do not nest — they
/// merely reference labels.
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

#[derive(Debug, Clone, Copy)]
enum CallTarget {
    Direct(FunctionId),
    Indirect { table: TableId },
}

/// Emit the 4c/4d state-machine wrap around a single call site into
/// `out`. `sig_ty` is the callee's function-type id. For indirect
/// calls the i32 table-index is an additional top-of-stack argument
/// not described by `sig_ty`.
fn emit_wrapped_call(
    module: &mut Module,
    func_id: FunctionId,
    out: &mut Vec<(Instr, InstrLocId)>,
    ctx: &mut CallWrapCtx,
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

    // Allocate a fresh spill local per arg. Reuse across sites is a
    // future optimization — per-site allocation is always correct.
    let arg_locals: Vec<LocalId> = arg_types
        .iter()
        .map(|&ty| module.locals.add(ty))
        .collect();

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

    // --- Populate the then-branch ---
    {
        let then_seq = local.block_mut(then_id);

        for &arg in &arg_locals {
            push_instr(&mut then_seq.instrs, Instr::LocalGet(LocalGet { local: arg }));
        }
        then_seq.instrs.push((call_instr, loc));

        // Tag `call_idx_local` with this site's index. This is done
        // after the call so that during UNWINDING propagation from a
        // deeper frame, our postamble sees the correct index.
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

        // state == UNWINDING ? → br $unwind_save. The results on the
        // stack are discarded because $unwind_save is () -> ().
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
            Instr::Binop(Binop {
                op: BinaryOp::I32Eq,
            }),
        );
        push_instr(
            &mut then_seq.instrs,
            Instr::BrIf(BrIf {
                block: unwind_save_id,
            }),
        );
    }

    // --- Populate the else-branch ---
    //
    // Reached during REWINDING when `$call_idx != call_idx` (this
    // isn't the call site the unwind came from) or during any
    // otherwise-not-NORMAL state. The results must match the call's
    // result type, so we push defaults. Non-nullable ref results
    // fall back to `unreachable`: we can't synthesize a valid
    // reference, and during a correct rewind we never take this
    // branch for the target call site anyway.
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
            // Clear any partially-emitted defaults before unreachable.
            else_seq.instrs.clear();
            push_instr(&mut else_seq.instrs, Instr::Unreachable(Unreachable {}));
        }
    }

    // --- Emit the wrap into the parent sequence ---
    //
    // Order: spill args (top-of-stack first), compute the combined
    // NORMAL-or-REWINDING-at-this-idx condition, emit the if.

    // Spill args: reverse order so deepest arg ends up in local[0].
    for &arg in arg_locals.iter().rev() {
        push_instr(out, Instr::LocalSet(LocalSet { local: arg }));
    }

    // Condition: (state == NORMAL) || ((state == REWINDING) && (call_idx == N))
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

// ----------------------------------------------------------------------
// Phase 4d — frame I/O: preamble + postamble
// ----------------------------------------------------------------------

/// Size of the fixed frame header in bytes.
const HEADER_SIZE: u32 = 16;
const FUNC_INDEX_OFFSET: u64 = 0;
const CALL_INDEX_OFFSET: u64 = 4;
const CATCH_REGION_OFFSET: u64 = 8;
const EXNREF_SLOT_OFFSET: u64 = 12;
/// Byte offset at which saved scalar locals start within the frame.
const LOCALS_START_OFFSET: u32 = HEADER_SIZE;

/// Rewrite the entry block to include a REWINDING preamble (before
/// the wrapper block) and replace the Phase-4b `unreachable`
/// placeholder with a real unwind-save postamble. Scalar user locals
/// are saved to / loaded from `_wpk_fork_buf`; ref-typed user locals
/// are spilled through `aux_tables` to their pre-assigned slots. The
/// frame's `catch_region_id` and `exnref_slot` fields round-trip
/// through `catch_region_id_local` / `exnref_slot_local` (Phase 6b).
/// They are written by the call-site wrapping (Phase 6e) at fork-time
/// and read by the rewind-throw stubs (Phase 6c) during replay.
#[allow(clippy::too_many_arguments)]
fn inject_frame_io(
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
    let ptr_ty = runtime.buf_type;
    let memory = first_memory(module);

    // Compute per-local in-frame offsets once; reused by preamble and
    // postamble so the two stay consistent.
    let locals_with_offsets = assign_local_offsets(user_scalar_locals, LOCALS_START_OFFSET);

    // Capture the function's result types now, before taking the
    // long-lived mutable borrow on its LocalFunction.
    let result_types: Vec<ValType> = {
        let ty_id = module.funcs.get(func_id).ty();
        module.types.get(ty_id).results().to_vec()
    };

    // Build the preamble's then-branch (what runs when REWINDING is
    // detected) and an empty else, both in dangling InstrSeqs.
    let local = local_mut(module, func_id);
    let preamble_then = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();
    let preamble_else = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();

    {
        let seq = &mut local.block_mut(preamble_then).instrs;

        // frame_ptr = *(buf + 0) - frame_size
        push_instr(
            seq,
            Instr::GlobalGet(GlobalGet {
                global: runtime.buf_global,
            }),
        );
        push_instr(seq, load_ptr(memory, ptr_ty, 0));
        push_instr(seq, ptr_const(ptr_ty, frame_size as i64));
        push_instr(seq, Instr::Binop(Binop { op: ptr_sub(ptr_ty) }));
        push_instr(seq, Instr::LocalSet(LocalSet { local: frame_ptr_local }));

        // Write back: *(buf + 0) = frame_ptr
        push_instr(
            seq,
            Instr::GlobalGet(GlobalGet {
                global: runtime.buf_global,
            }),
        );
        push_instr(seq, Instr::LocalGet(LocalGet { local: frame_ptr_local }));
        push_instr(seq, store_ptr(memory, ptr_ty, 0));

        // call_idx_local = *(frame_ptr + CALL_INDEX_OFFSET)
        push_instr(seq, Instr::LocalGet(LocalGet { local: frame_ptr_local }));
        push_instr(seq, load_i32(memory, CALL_INDEX_OFFSET));
        push_instr(seq, Instr::LocalSet(LocalSet { local: call_idx_local }));

        // Phase 6b — catch_region_id = *(frame_ptr + CATCH_REGION_OFFSET)
        push_instr(seq, Instr::LocalGet(LocalGet { local: frame_ptr_local }));
        push_instr(seq, load_i32(memory, CATCH_REGION_OFFSET));
        push_instr(seq, Instr::LocalSet(LocalSet { local: catch_region_id_local }));

        // Phase 6b — exnref_slot = *(frame_ptr + EXNREF_SLOT_OFFSET)
        push_instr(seq, Instr::LocalGet(LocalGet { local: frame_ptr_local }));
        push_instr(seq, load_i32(memory, EXNREF_SLOT_OFFSET));
        push_instr(seq, Instr::LocalSet(LocalSet { local: exnref_slot_local }));

        // Restore scalar user locals
        for &(lid, ty, off) in &locals_with_offsets {
            push_instr(seq, Instr::LocalGet(LocalGet { local: frame_ptr_local }));
            push_instr(seq, load_scalar(memory, ty, off as u64));
            push_instr(seq, Instr::LocalSet(LocalSet { local: lid }));
        }

        // Phase 4f — restore ref-typed user locals from aux tables.
        // Sequence per local: i32.const <slot>, table.get <table>, local.set.
        for slot in ref_plan {
            let table = aux_tables
                .table_for(slot.class)
                .expect("aux table for this ref class must be injected");
            push_instr(
                seq,
                Instr::Const(Const {
                    value: Value::I32(slot.slot as i32),
                }),
            );
            push_instr(seq, Instr::TableGet(TableGet { table }));
            push_instr(seq, Instr::LocalSet(LocalSet { local: slot.local }));
        }
    }

    // Build the postamble body. We keep it as a plain Vec and append
    // to the entry block so it's reachable via `br $unwind_save` (a
    // br that targets the wrapper block, exiting into the entry).
    let mut postamble: Vec<(Instr, InstrLocId)> = Vec::new();
    {
        // frame_ptr = *(buf + 0)
        push_instr(
            &mut postamble,
            Instr::GlobalGet(GlobalGet {
                global: runtime.buf_global,
            }),
        );
        push_instr(&mut postamble, load_ptr(memory, ptr_ty, 0));
        push_instr(
            &mut postamble,
            Instr::LocalSet(LocalSet { local: frame_ptr_local }),
        );

        // Write header: func_index, call_index, 0, 0.
        push_instr(
            &mut postamble,
            Instr::LocalGet(LocalGet { local: frame_ptr_local }),
        );
        push_instr(
            &mut postamble,
            Instr::Const(Const {
                value: Value::I32(func_ordinal as i32),
            }),
        );
        push_instr(&mut postamble, store_i32(memory, FUNC_INDEX_OFFSET));

        push_instr(
            &mut postamble,
            Instr::LocalGet(LocalGet { local: frame_ptr_local }),
        );
        push_instr(
            &mut postamble,
            Instr::LocalGet(LocalGet { local: call_idx_local }),
        );
        push_instr(&mut postamble, store_i32(memory, CALL_INDEX_OFFSET));

        // Phase 6b — serialize catch_region_id_local + exnref_slot_local
        // instead of writing hardcoded zeros. Both locals default to 0
        // and are only set by Phase 6e call-site wrapping when a
        // handler is currently active, so the "not-in-handler" case
        // still stores 0 (equivalent to the prior behavior).
        push_instr(
            &mut postamble,
            Instr::LocalGet(LocalGet { local: frame_ptr_local }),
        );
        push_instr(
            &mut postamble,
            Instr::LocalGet(LocalGet { local: catch_region_id_local }),
        );
        push_instr(&mut postamble, store_i32(memory, CATCH_REGION_OFFSET));

        push_instr(
            &mut postamble,
            Instr::LocalGet(LocalGet { local: frame_ptr_local }),
        );
        push_instr(
            &mut postamble,
            Instr::LocalGet(LocalGet { local: exnref_slot_local }),
        );
        push_instr(&mut postamble, store_i32(memory, EXNREF_SLOT_OFFSET));

        // Save scalar user locals
        for &(lid, ty, off) in &locals_with_offsets {
            push_instr(
                &mut postamble,
                Instr::LocalGet(LocalGet { local: frame_ptr_local }),
            );
            push_instr(&mut postamble, Instr::LocalGet(LocalGet { local: lid }));
            push_instr(&mut postamble, store_scalar(memory, ty, off as u64));
        }

        // Phase 4f — spill ref-typed user locals to aux tables.
        // Sequence per local: i32.const <slot>, local.get, table.set.
        for slot in ref_plan {
            let table = aux_tables
                .table_for(slot.class)
                .expect("aux table for this ref class must be injected");
            push_instr(
                &mut postamble,
                Instr::Const(Const {
                    value: Value::I32(slot.slot as i32),
                }),
            );
            push_instr(
                &mut postamble,
                Instr::LocalGet(LocalGet { local: slot.local }),
            );
            push_instr(&mut postamble, Instr::TableSet(TableSet { table }));
        }

        // Advance current_pos: *(buf + 0) = frame_ptr + frame_size
        push_instr(
            &mut postamble,
            Instr::GlobalGet(GlobalGet {
                global: runtime.buf_global,
            }),
        );
        push_instr(
            &mut postamble,
            Instr::LocalGet(LocalGet { local: frame_ptr_local }),
        );
        push_instr(&mut postamble, ptr_const(ptr_ty, frame_size as i64));
        push_instr(&mut postamble, Instr::Binop(Binop { op: ptr_add(ptr_ty) }));
        push_instr(&mut postamble, store_ptr(memory, ptr_ty, 0));

        // Push defaults for the function's result types. If any
        // result is a non-nullable ref type we fall back to
        // `unreachable` (a function that fork-unwinds-to-default
        // with a non-nullable-ref return is semantically undefined).
        let mut fallback_unreachable = false;
        for &ty in &result_types {
            match default_for_type(ty) {
                Some(instr) => push_instr(&mut postamble, instr),
                None => {
                    fallback_unreachable = true;
                    break;
                }
            }
        }
        if fallback_unreachable {
            push_instr(&mut postamble, Instr::Unreachable(Unreachable {}));
        }
    }

    // Rebuild the entry block:
    //   [<preamble IfElse>, Block(wrapper), <postamble>]
    let entry_id = local.entry_block();
    local.block_mut(entry_id).instrs.clear();

    let entry_seq = &mut local.block_mut(entry_id).instrs;
    // Preamble condition: state == REWINDING
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

    // The wrapper block (target of br_if in wrapped calls).
    push_instr(entry_seq, Instr::Block(Block { seq: wrapper_id }));

    // Postamble — reached only via br $unwind_save.
    entry_seq.extend(postamble);
}

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

// ----------------------------------------------------------------------
// User-local discovery
// ----------------------------------------------------------------------

/// All locals referenced in the function's body (including args,
/// even if an arg is never read). DFS order, deduplicated.
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
    // Include args first in declaration order; most LLVM-generated
    // wasm references them in order anyway, but this guarantees a
    // stable ordering independent of body shape.
    for arg in &local.args {
        if c.seen.insert(*arg) {
            c.ordered.push(*arg);
        }
    }
    dfs_in_order(&mut c, local, local.entry_block());

    c.ordered
        .into_iter()
        .map(|id| (id, module.locals.get(id).ty()))
        .collect()
}

// ----------------------------------------------------------------------
// Small helpers — types, loads/stores, constants
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
        // Non-nullable ref: caller must fall back to `unreachable`.
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

/// Classification of a reference type for aux-table routing. Phase
/// 4f supports the three abstract nullable ref kinds LLVM-generated
/// wasm is likely to produce; richer wasm-GC types (anyref / eqref /
/// struct / array / concrete typed refs) are currently unsupported
/// and will cause instrumentation to panic with a diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RefClass {
    Funcref,
    Externref,
    Exnref,
}

/// A single ref-typed user local's slot assignment in the aux tables.
#[derive(Debug, Clone, Copy)]
pub struct RefLocalSlot {
    pub local: LocalId,
    pub class: RefClass,
    /// Zero-based index within the `class`-specific table.
    pub slot: u32,
}

/// The three auxiliary tables used by Phase 4f. Each is `Some` only
/// if at least one ref-typed local of the matching class exists on
/// the fork-path. Absent tables indicate "not needed" for this module.
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

/// Classify a ref type into a [`RefClass`], or return `None` for
/// types outside 4f's support matrix. Only nullable abstract
/// funcref / externref / exnref are currently accepted.
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
        // Concrete types and wasm-GC abstract types (any/eq/struct/
        // array/i31) require more machinery (separate tables per
        // concrete type, or ref.cast on reload). Fail loudly so
        // users don't get silent rewind corruption.
        _ => None,
    }
}

/// Count ref-typed user locals per function and assign stable slot
/// indices within per-class aux tables. Then inject the tables with
/// the exact required initial size. Panics if any function on the
/// fork-path contains a ref-typed local we cannot currently handle.
///
/// Phase 6a extension: also discover every `try_table` on the fork
/// path, assign each a per-function `catch_region_id` (1-based), and
/// reserve a slot in `_wpk_fork_exnref_stash` for its runtime-caught
/// exnref. The exnref table is then sized to fit both exnref user
/// locals (4f) and try_table slots (6a).
fn plan_and_inject_aux_tables(
    module: &mut Module,
    targets: &[FunctionId],
) -> (
    AuxTables,
    HashMap<FunctionId, Vec<RefLocalSlot>>,
    HashMap<FunctionId, Vec<CatchRegionPlan>>,
) {
    // Running slot counters per class; become the tables' initial sizes.
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
                let name = module
                    .funcs
                    .get(id)
                    .name
                    .as_deref()
                    .unwrap_or("<anon>");
                panic!(
                    "fork-instrument 4f: function `{name}` has a ref-typed local of \
                     type {rt:?} which is not yet supported (non-nullable or non-abstract \
                     ref). Add support in classify_ref() or avoid reaching fork from here.",
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

    // Phase 6a — enumerate fork-path try_tables and allocate one
    // exnref-stash slot per try_table. Ids are per-function, 1-based;
    // 0 is reserved in the frame's `catch_region_id` field to mean
    // "not inside any catch handler".
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

    // Inject only the tables that will actually be used.
    let funcref = if funcref_cursor > 0 {
        let id = module.tables.add_local(
            /* table64 */ false,
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

/// Per-try_table metadata used by Phase 6c/6d/6e.
#[derive(Debug, Clone, Copy)]
pub struct CatchRegionPlan {
    /// `InstrSeqId` of the try_table's body (not the enclosing try_table
    /// instruction itself). The rewind-throw stub is prepended here.
    pub body_seq: InstrSeqId,
    /// 1-based id unique within the owning function. 0 is reserved
    /// for "not inside any catch handler".
    pub catch_region_id: u32,
    /// Slot in the module-wide `_wpk_fork_exnref_stash` table used to
    /// hold the runtime-caught exnref across fork (stashed by the call
    /// site inside the handler, reloaded by the preamble's `throw_ref`).
    pub exnref_slot: u32,
}

/// Discover the `InstrSeqId` of every `try_table` body within a
/// function, in lexical DFS order (outer-first). Non-local functions
/// return an empty vector.
fn discover_try_table_bodies(module: &Module, func_id: FunctionId) -> Vec<InstrSeqId> {
    let local = match &module.funcs.get(func_id).kind {
        FunctionKind::Local(l) => l,
        _ => return Vec::new(),
    };
    let mut bodies = Vec::new();
    visit_try_tables(local, local.entry_block(), &mut bodies);
    bodies
}

fn visit_try_tables(
    f: &LocalFunction,
    seq: InstrSeqId,
    out: &mut Vec<InstrSeqId>,
) {
    for (instr, _) in &f.block(seq).instrs {
        // Record a try_table body before recursing, so ordering is
        // pre-order DFS (outer try_tables come before nested ones).
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
//
// When a fork was triggered from inside a catch handler, the child
// must re-enter the handler to resume at the original fork call site.
// Normal rewind (call-idx matching) can't reach handler code because
// handlers are only entered via thrown-exception control flow, not
// normal fall-through.
//
// Phase 6's answer: prepend each fork-path try_table's body with a
// guard that, when the frame carries this try_table's
// `catch_region_id`, loads the stashed exnref and `throw_ref`s it.
// The enclosing try_table catches the thrown reference (matching the
// original tag, since we kept the original exnref) and dispatches to
// its own catch clause — landing us inside the handler again, now in
// REWINDING state, where the existing 4c/4d machinery picks up.
//
// If catch_region_id doesn't match this try_table (or state isn't
// REWINDING at all), the stub is a no-op and control flows into the
// original body.

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
            // If no exnref table exists, there can be no stash to
            // reload from, so the stub would never meaningfully fire.
            // This case should also mean `catch_plan` is empty (we
            // would have allocated slots for it otherwise).
            debug_assert!(catch_plan.is_empty());
            return;
        }
    };

    for plan in catch_plan {
        let body_seq_id = plan.body_seq;
        let region_id = plan.catch_region_id;
        let slot = plan.exnref_slot;

        // Build the stub's two dangling branches:
        //   then: load exnref from slot, ref.as_non_null, throw_ref.
        //   else: empty (fall through to original body).
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

        // Move the original body aside, then build the stub followed
        // by the original body in the same sequence.
        let original: Vec<(Instr, InstrLocId)> =
            std::mem::take(&mut local.block_mut(body_seq_id).instrs);
        let body = &mut local.block_mut(body_seq_id).instrs;

        // Guard: (state == REWINDING) && (catch_region_id == region_id)
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

        // Restore the original body after the stub.
        body.extend(original);
    }
}

// ----------------------------------------------------------------------
// Phase 4g — non-call side-effect gating
// ----------------------------------------------------------------------
//
// Re-executing side effects during the REWIND replay corrupts the
// child's state: globals would be double-updated, stores would write
// into already-post-fork memory, locals would clobber the values the
// preamble just restored. Each side-effect instruction is therefore
// wrapped in an `if state == NORMAL` so it runs only in the
// normal-execution path, not during replay.
//
// The wrap must preserve stack typing: the `if` block has the
// instruction's own input/output type. Pass-through in the else
// branch drops stack inputs and, for the few ops that produce
// results, supplies default-valued replacements (e.g. `memory.grow
// → i32.const 0`). The downstream effect is rarely visible: the
// consumer of the result (a LocalSet, another Store, etc.) is itself
// gated and discards the value via its else-drop.

/// Stack-effect shape of a gated side-effect instruction.
struct SideEffectShape {
    params: Vec<ValType>,
    results: Vec<ValType>,
}

/// If `instr` has a side effect on state visible across fork, return
/// its (params, results) stack-effect shape. Pure instructions and
/// instructions we leave ungated (control flow, loads, arithmetic)
/// return `None`.
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
            params: vec![
                ptr_ty(mc.dst),
                ptr_ty(mc.src),
                ptr_ty(mc.dst), // copy size uses dest's addressing width
            ],
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
        // Ungated — safe to re-execute (pure) or deferred to a later
        // phase (atomics, GC, exception throws).
        _ => None,
    }
}

/// Emit a gated side-effect op: push the original instruction into a
/// dangling `then` block, and in the `else` block drop any params
/// and push defaults for any results. The outer sequence gets:
///     global.get state, i32.const NORMAL, i32.eq, if-else.
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

    // then: run the original op.
    local.block_mut(then_id).instrs.push((instr, loc));

    // else: consume the inputs, emit default outputs.
    {
        let else_seq = &mut local.block_mut(else_id).instrs;
        // Drop params (top of stack is last param in declaration order).
        for _ in 0..shape.params.len() {
            push_instr(else_seq, Instr::Drop(Drop {}));
        }
        // Produce defaults for results. If any result is a
        // non-nullable ref we fall back to unreachable — this is
        // unreachable during runtime anyway because the downstream
        // consumer is itself gated.
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

    // Parent sequence: state check, then if-else.
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

