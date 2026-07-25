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
//!       ;; pop frame from save buffer, then restore catch_selector,
//!       ;; reserved catch metadata, scalar locals, and arg-spill locals
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
//!         ;; catch capture already selected the exact dynamic arm
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
//!     ;; catch capture already selected the exact dynamic arm
//!     (if state == UNWINDING:
//!       frame.call_index = N-1
//!       br $unwind_save)
//!     <chunk N: tail>
//!     (return)                       ;; normal-path exit
//!   )  ;; end $unwind_save — br target for UNWINDING propagation
//!
//!   ;; --- POSTAMBLE (runs only when branched-to via br $unwind_save) ---
//!   ;; push frame header fields except call_index, save scalar user locals,
//!   ;; save arg-spill locals, advance current_pos, push defaults for the
//!   ;; function's result types
//! )
//! ```
//!
//! ## Supported replay surface
//!
//! - **Top-level and nested fork-path calls.** Top-level calls use the
//!   function switch-dispatch. Calls nested in structured control flow use a
//!   per-block switch-dispatch so rewind never branches into a block from
//!   outside it.
//! - **Fork from statically tagged modern `try_table` catches is
//!   supported.** Catch and CatchRef arm identity and scalar tag
//!   payloads are frame-backed per activation. Rewind throws the tag
//!   again so the fresh module instance creates a fresh exnref.
//!   Fork-reachable legacy `try` handlers are normalized to this same modern
//!   activation-owned representation before instrumentation.
//! - **Abstract function and external references use activation-owned
//!   recipes.** Live locals, parameters, call operands, and operand-stack
//!   carryovers are encoded to deterministic recipe IDs in a call-specific
//!   process vector and decoded against the fresh child instance.
//!   Definitely-null references need no recipe. Statically tagged CatchRef
//!   state is reconstructed by rethrowing its saved payload inside Wasm.
//!
//! ## Frame layout
//!
//! All offsets are relative to the frame's base address.
//!
//! | Offset        | Size | Field             |
//! |---------------|------|-------------------|
//! | 0             | 4    | `func_index`      |
//! | 4             | 4    | `call_index`      |
//! | 8             | 4    | `catch_selector`  |
//! | 12            | 4    | process reference-vector ordinal |
//! | 16..          | var  | scalar locals (user, arg spills, tagged-catch state) |
//!
//! There is deliberately no module-instance auxiliary reference storage:
//! workers reconstruct a child from linear memory in a fresh Wasm instance.
//!
//! ## What's preserved verbatim
//!
//! - `crates/fork-instrument/src/call_graph.rs` — fork-path closure
//!   discovery (direct + indirect).
//! - `crates/fork-instrument/src/runtime.rs` — state machine, seven
//!   exported control functions, save-buffer layout, saved-globals
//!   handling.
//! - Phase 6a–6d plumbing for `try_table` / tagged-catch resume.

use anyhow::Result;
use std::collections::{BTreeMap, HashMap, HashSet};

use walrus::{
    AbstractHeapType, ElementItems, ElementKind, ExportItem, FunctionBuilder, FunctionId,
    FunctionKind, HeapType, LocalFunction, LocalId, MemoryId, Module, RawCustomSection, RefType,
    TableId, TagId, TypeId, ValType,
    ir::{
        AtomicWidth, BinaryOp, Binop, Block, Br, BrTable, Call, CallIndirect, Const, GlobalGet,
        IfElse, Instr, InstrLocId, InstrSeqId, InstrSeqType, LegacyCatch, LoadKind, LocalGet,
        LocalSet, LocalTee, Loop, MemArg, RefAsNonNull, RefNull, Return, StoreKind, Throw,
        TryTable, TryTableCatch, UnaryOp, Unreachable, Value,
    },
};

use crate::{
    call_graph::{TailCallKind, TailCallSite},
    reference_analysis::{
        FunctionReferenceAnalysis, OriginalCallKind, ReferenceNullability,
        analyze_function_references,
    },
    runtime::{self, ReferenceCodecClass as RefClass, Runtime},
};

const HOST_PARSED_MARKER_EXPORTS: &[&str] = &[
    "__abi_version",
    "__wasm_posix_thread_slots",
    "__get_channel_base_addr",
];

pub const RESUME_CATALOG_EXPORT: &str = "__wpk_fork_resume_catalog";
pub const RESUME_CATALOG_SECTION: &str = "kandelo.wpk_fork.resume_catalog";
pub const RESUME_START_EXPORT: &str = "wpk_fork_resume_start";
pub const RESUME_THREAD_EXPORT: &str = "wpk_fork_resume_thread";
const RESUME_CATALOG_MAGIC: [u8; 4] = *b"KFRC";
const RESUME_CATALOG_VERSION: u16 = 1;
const RESUME_CATALOG_HEADER_SIZE: u16 = 12;

fn is_host_parsed_marker_function(module: &Module, id: FunctionId) -> bool {
    module.exports.iter().any(|export| {
        HOST_PARSED_MARKER_EXPORTS.contains(&export.name.as_str())
            && matches!(export.item, ExportItem::Function(func) if func == id)
    })
}

/// Verify that every fork-reachable reference shape has a typed owner.
///
/// WHY this runs before any rewriting: the host creates fork children by
/// copying linear memory into a newly instantiated module. The complete Wasm
/// reference hierarchy is routed to a generated codec class here; mutable
/// globals, tables, and segment lifetime are owned by the KFMS guest helpers,
/// while activation references are owned by frame recipe IDs. Errors from
/// this pass indicate malformed/stale transformation metadata, not a policy
/// that excludes otherwise-valid reference-bearing programs.
pub fn validate_activation_state(module: &Module, fork_path: &HashSet<FunctionId>) -> Result<()> {
    validate_activation_state_with_targets(module, fork_path, fork_path)
}

/// Validate surviving activations while selecting suspension-capable call
/// sites from the larger semantic control-reachability closure.
///
/// A function traversed only by `return_call*` is intentionally absent from
/// `activations`: its frame no longer exists at the fork point. It remains in
/// `fork_path_targets` so an older live caller recognizes that an ordinary
/// call into the transparent tail chain is a replay landing.
pub fn validate_activation_state_with_targets(
    module: &Module,
    activations: &HashSet<FunctionId>,
    fork_path_targets: &HashSet<FunctionId>,
) -> Result<()> {
    if activations.is_empty() {
        return Ok(());
    }

    let mut targets: Vec<FunctionId> = activations.iter().copied().collect();
    targets.sort();
    for func_id in targets {
        let function = module.funcs.get(func_id);
        let FunctionKind::Local(_) = &function.kind else {
            continue;
        };
        if is_host_parsed_marker_function(module, func_id) {
            continue;
        }
        let name = function.name.as_deref().unwrap_or("<unnamed>");

        for (local_id, ty) in collect_user_locals(module, func_id) {
            let ValType::Ref(reference) = ty else {
                continue;
            };
            validate_reference_shape(
                module,
                reference,
                &format!("fork-reachable function `{name}` local/parameter {local_id:?}"),
            )?;
        }

        let signature = module.types.get(function.ty());
        for reference in signature
            .params()
            .iter()
            .chain(signature.results())
            .filter_map(|ty| match ty {
                ValType::Ref(reference) => Some(*reference),
                _ => None,
            })
        {
            validate_reference_shape(
                module,
                reference,
                &format!("fork-reachable function `{name}` signature"),
            )?;
        }

        let reference_analysis = analyze_function_references(module, func_id, fork_path_targets)?;
        validate_reference_call_state(module, name, &reference_analysis)?;
    }

    Ok(())
}

fn validate_reference_shape(module: &Module, reference: RefType, _owner: &str) -> Result<()> {
    // Every WebAssembly reference hierarchy has a typed recipe provider.
    // Concrete function/GC types are upcast for encoding and cast back after
    // decoding in the fresh instance.
    let _ = RefClass::of(module, reference);
    Ok(())
}

fn validate_reference_call_state(
    module: &Module,
    function_name: &str,
    analysis: &FunctionReferenceAnalysis,
) -> Result<()> {
    for site in &analysis.call_sites {
        for operand in site
            .reference_arguments
            .iter()
            .chain(site.reference_carryovers.iter())
        {
            validate_reference_shape(
                module,
                operand.ty,
                &format!(
                    "fork-reachable function `{function_name}` call {:?} operand {}",
                    site.id, operand.index
                ),
            )?;
        }

        if site.has_reference_callee {
            // call_ref's concrete callee type is statically recovered with a
            // Wasm ref.cast after decoding the abstract funcref recipe.
        }
    }
    Ok(())
}

/// Instrument every function in `fork_path` that we can instrument.
///
/// Returns the set of function IDs that were actually rewritten.
pub fn instrument_functions(
    module: &mut Module,
    runtime: &Runtime,
    fork_path: &HashSet<FunctionId>,
    plain_catch_plan: &PlainCatchPlan,
) -> HashSet<FunctionId> {
    instrument_functions_with_targets_and_tail_sites(
        module,
        runtime,
        fork_path,
        fork_path,
        &[],
        plain_catch_plan,
    )
}

/// Instrument only activation-live functions, selecting their replay
/// landings from the full semantic fork-reachability closure.
pub fn instrument_functions_with_targets(
    module: &mut Module,
    runtime: &Runtime,
    activations: &HashSet<FunctionId>,
    fork_path_targets: &HashSet<FunctionId>,
    plain_catch_plan: &PlainCatchPlan,
) -> HashSet<FunctionId> {
    instrument_functions_with_targets_and_tail_sites(
        module,
        runtime,
        activations,
        fork_path_targets,
        &[],
        plain_catch_plan,
    )
}

/// Instrument activation-live functions after making every fork boundary use
/// the private exception transport.
///
/// Ordinary direct calls to rewritten local functions need no shim: their
/// generated postamble throws `__wpk_fork_unwind`. Imported fork entries and
/// dynamic dispatch can instead return normally after setting
/// `STATE_UNWINDING`, so those operations are moved into short generated
/// helpers which check the state before exposing any result to the source
/// activation. Fork-reaching tail sites tail-call the same helpers, retaining
/// bounded-stack semantics for transparent tail chains.
pub fn instrument_functions_with_targets_and_tail_sites(
    module: &mut Module,
    runtime: &Runtime,
    activations: &HashSet<FunctionId>,
    fork_path_targets: &HashSet<FunctionId>,
    tail_call_sites: &[TailCallSite],
    plain_catch_plan: &PlainCatchPlan,
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

    let mut targets: Vec<FunctionId> = activations
        .iter()
        .copied()
        .filter(|id| !runtime_funcs.contains(id))
        .filter(|id| !is_host_parsed_marker_function(module, *id))
        .filter(|id| matches!(module.funcs.get(*id).kind, FunctionKind::Local(_)))
        .collect();
    targets.sort();
    let materialized_activations: HashSet<FunctionId> =
        targets.iter().copied().collect();

    let catch_plans = plan_catch_regions(module, &targets);
    let transport_helpers = inject_unwind_transport_helpers(
        module,
        runtime,
        &targets,
        fork_path_targets,
        tail_call_sites,
    );
    rewrite_activation_unwind_boundaries(module, &targets, tail_call_sites, &transport_helpers);
    let unwind_frame_select = emit_unwind_frame_select_helper(module, runtime);
    let mut transformed_call_targets = fork_path_targets.clone();
    transformed_call_targets.extend(transport_helpers.values().copied());

    // Analyze every target before rewriting the first body. Stable original
    // program points are the ownership boundary: synthetic dispatch locals
    // must never make an otherwise-dead guest reference look live.
    let reference_analyses: HashMap<FunctionId, FunctionReferenceAnalysis> = targets
        .iter()
        .copied()
        .map(|id| {
            let analysis = analyze_function_references(module, id, &transformed_call_targets)
                .unwrap_or_else(|error| panic!("fork reference analysis failed: {error:#}"));
            (id, analysis)
        })
        .collect();

    let empty_plain_catches: Vec<(InstrSeqId, Vec<PlainCatchArm>)> = Vec::new();

    let mut instrumented = HashSet::new();
    let mut resume_thunks = Vec::with_capacity(targets.len());
    for (ordinal, id) in targets.iter().enumerate() {
        let empty_catch_plan: Vec<CatchRegionPlan> = Vec::new();
        let this_catch_plan = catch_plans.get(id).unwrap_or(&empty_catch_plan);
        let this_plain_catches = plain_catch_plan
            .per_function
            .get(id)
            .unwrap_or(&empty_plain_catches);
        let thunk = instrument_one_function(
            module,
            *id,
            runtime,
            &materialized_activations,
            &transformed_call_targets,
            ordinal as u32,
            this_catch_plan,
            this_plain_catches,
            &reference_analyses[id],
            unwind_frame_select,
        );
        resume_thunks.push(thunk);
        instrumented.insert(*id);
    }
    emit_resume_catalog(module, &resume_thunks);
    emit_fixed_resume_boundaries(module, runtime);
    instrumented
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum UnwindTransportKey {
    Direct(FunctionId),
    Indirect { table: TableId, ty: TypeId },
    Ref { ty: TypeId },
}

impl UnwindTransportKey {
    fn stable_sort_key(self) -> (u8, usize, usize) {
        match self {
            Self::Direct(function) => (0, function.index(), 0),
            Self::Indirect { table, ty } => (1, table.index(), ty.index()),
            Self::Ref { ty } => (2, ty.index(), 0),
        }
    }
}

fn collect_unwind_transport_keys(
    module: &Module,
    targets: &[FunctionId],
    fork_path_targets: &HashSet<FunctionId>,
    tail_call_sites: &[TailCallSite],
) -> Vec<UnwindTransportKey> {
    fn visit(
        module: &Module,
        local: &LocalFunction,
        seq: InstrSeqId,
        fork_path_targets: &HashSet<FunctionId>,
        keys: &mut HashSet<UnwindTransportKey>,
    ) {
        for (instruction, _) in &local.block(seq).instrs {
            match instruction {
                Instr::Call(call)
                    if fork_path_targets.contains(&call.func)
                        && matches!(module.funcs.get(call.func).kind, FunctionKind::Import(_)) =>
                {
                    keys.insert(UnwindTransportKey::Direct(call.func));
                }
                Instr::CallIndirect(call) => {
                    keys.insert(UnwindTransportKey::Indirect {
                        table: call.table,
                        ty: call.ty,
                    });
                }
                Instr::CallRef(call) => {
                    keys.insert(UnwindTransportKey::Ref { ty: call.ty });
                }
                _ => {}
            }
            for child in nested_seqs(instruction) {
                visit(module, local, child, fork_path_targets, keys);
            }
        }
    }

    let mut keys = HashSet::new();
    for &target in targets {
        let FunctionKind::Local(local) = &module.funcs.get(target).kind else {
            continue;
        };
        visit(
            module,
            local,
            local.entry_block(),
            fork_path_targets,
            &mut keys,
        );
    }

    for &site in tail_call_sites {
        let FunctionKind::Local(local) = &module.funcs.get(site.caller).kind else {
            panic!("fork-reaching tail site belongs to a non-local function");
        };
        let Some((instruction, _)) = local
            .block(site.sequence)
            .instrs
            .get(site.instruction_index)
        else {
            panic!("fork-reaching tail site points past its instruction sequence");
        };
        let key = match (site.kind, instruction) {
            (TailCallKind::Direct, Instr::ReturnCall(call))
                if matches!(module.funcs.get(call.func).kind, FunctionKind::Import(_)) =>
            {
                Some(UnwindTransportKey::Direct(call.func))
            }
            (TailCallKind::Direct, Instr::ReturnCall(_)) => None,
            (TailCallKind::Indirect, Instr::ReturnCallIndirect(call)) => {
                Some(UnwindTransportKey::Indirect {
                    table: call.table,
                    ty: call.ty,
                })
            }
            (TailCallKind::Ref, Instr::ReturnCallRef(call)) => {
                Some(UnwindTransportKey::Ref { ty: call.ty })
            }
            _ => panic!("fork-reaching tail-site metadata disagrees with the original instruction"),
        };
        if let Some(key) = key {
            keys.insert(key);
        }
    }

    let mut keys: Vec<_> = keys.into_iter().collect();
    keys.sort_by_key(|key| key.stable_sort_key());
    keys
}

fn emit_unwind_transport_helper(
    module: &mut Module,
    runtime: &Runtime,
    key: UnwindTransportKey,
) -> FunctionId {
    let (mut params, results, name) = match key {
        UnwindTransportKey::Direct(function) => {
            let signature = module.types.get(module.funcs.get(function).ty());
            (
                signature.params().to_vec(),
                signature.results().to_vec(),
                format!("__wpk_fork_unwind_transport_direct_{}", function.index()),
            )
        }
        UnwindTransportKey::Indirect { table, ty } => {
            let signature = module.types.get(ty);
            let mut params = signature.params().to_vec();
            params.push(if module.tables.get(table).table64 {
                ValType::I64
            } else {
                ValType::I32
            });
            (
                params,
                signature.results().to_vec(),
                format!(
                    "__wpk_fork_unwind_transport_indirect_{}_{}",
                    table.index(),
                    ty.index()
                ),
            )
        }
        UnwindTransportKey::Ref { ty } => {
            let signature = module.types.get(ty);
            let mut params = signature.params().to_vec();
            params.push(ValType::Ref(RefType::FUNCREF));
            (
                params,
                signature.results().to_vec(),
                format!("__wpk_fork_unwind_transport_ref_{}", ty.index()),
            )
        }
    };
    let arguments: Vec<_> = params.drain(..).map(|ty| module.locals.add(ty)).collect();
    let helper_params: Vec<_> = arguments
        .iter()
        .map(|argument| module.locals.get(*argument).ty())
        .collect();
    let mut builder = FunctionBuilder::new(&mut module.types, &helper_params, &results);
    builder.name(name);
    let helper = builder.finish(arguments.clone(), &mut module.funcs);

    let local = local_mut(module, helper);
    let throws_unwind = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();
    let normal_return = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();
    {
        let out = &mut local.block_mut(throws_unwind).instrs;
        push_instr(
            out,
            Instr::Throw(Throw {
                tag: runtime
                    .unwind_tag
                    .expect("unwind transport helper requires private tag"),
            }),
        );
    }
    {
        let out = &mut local.block_mut(local.entry_block()).instrs;
        for &argument in &arguments {
            push_instr(out, Instr::LocalGet(LocalGet { local: argument }));
        }
        match key {
            UnwindTransportKey::Direct(function) => {
                push_instr(out, Instr::Call(Call { func: function }));
            }
            UnwindTransportKey::Indirect { table, ty } => {
                push_instr(out, Instr::CallIndirect(CallIndirect { ty, table }));
            }
            UnwindTransportKey::Ref { ty } => {
                push_instr(
                    out,
                    Instr::RefCast(walrus::ir::RefCast {
                        nullable: false,
                        heap_type: HeapType::Concrete(ty),
                    }),
                );
                push_instr(out, Instr::CallRef(walrus::ir::CallRef { ty }));
            }
        }
        // WHY: results deliberately remain below this zero-result test only
        // inside the short helper. The source activation receives them only
        // after UNWINDING has been converted to the private tag, so engines
        // never need result-spill scratch in every recursive source frame.
        push_instr(
            out,
            Instr::GlobalGet(GlobalGet {
                global: runtime.state_global,
            }),
        );
        push_instr(
            out,
            Instr::Const(Const {
                value: Value::I32(runtime::STATE_UNWINDING),
            }),
        );
        push_instr(
            out,
            Instr::Binop(Binop {
                op: BinaryOp::I32Eq,
            }),
        );
        push_instr(
            out,
            Instr::IfElse(IfElse {
                consequent: throws_unwind,
                alternative: normal_return,
            }),
        );
    }
    helper
}

fn inject_unwind_transport_helpers(
    module: &mut Module,
    runtime: &Runtime,
    targets: &[FunctionId],
    fork_path_targets: &HashSet<FunctionId>,
    tail_call_sites: &[TailCallSite],
) -> HashMap<UnwindTransportKey, FunctionId> {
    collect_unwind_transport_keys(module, targets, fork_path_targets, tail_call_sites)
        .into_iter()
        .map(|key| (key, emit_unwind_transport_helper(module, runtime, key)))
        .collect()
}

/// Emit the cold unwind-only frame-selection path once per module.
///
/// Source activations pass only their constant frame size and static call
/// index. Keeping reserve, null-result handling, abort-scratch selection, and
/// the header write here avoids multiplying that sequence by every lexical
/// call site without adding a local to ordinary recursive activations.
fn emit_unwind_frame_select_helper(module: &mut Module, runtime: &Runtime) -> FunctionId {
    let memory = first_memory(module);
    let ptr_ty = runtime.buf_type;
    let frame_size = module.locals.add(ptr_ty);
    let call_index = module.locals.add(ValType::I32);
    let mut builder =
        FunctionBuilder::new(&mut module.types, &[ptr_ty, ValType::I32], &[ValType::I32]);
    builder.name("__wpk_fork_select_unwind_frame".into());
    let helper = builder.finish(vec![frame_size, call_index], &mut module.funcs);

    let local = local_mut(module, helper);
    let reserve_succeeded = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(Some(ValType::I32)))
        .id();
    let reserve_failed = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(Some(ValType::I32)))
        .id();

    {
        let out = &mut local.block_mut(reserve_failed).instrs;
        // WHY: `frame_reserve == 0` synchronously moves the host runtime to
        // abort replay. The descriptor's fixed prefix is therefore the only
        // module-owned frame scratch that remains valid for selecting the
        // failing live activation.
        push_instr(
            out,
            Instr::GlobalGet(GlobalGet {
                global: runtime.buf_global,
            }),
        );
        push_instr(
            out,
            Instr::GlobalGet(GlobalGet {
                global: runtime.buf_global,
            }),
        );
        push_instr(out, ptr_const(ptr_ty, runtime.frames_start_offset as i64));
        push_instr(
            out,
            Instr::Binop(Binop {
                op: ptr_add(ptr_ty),
            }),
        );
        push_instr(out, store_ptr(memory, ptr_ty, 0));
        push_current_frame_ptr(out, runtime, memory, ptr_ty);
        push_instr(out, Instr::LocalGet(LocalGet { local: call_index }));
        push_instr(out, store_i32(memory, CALL_INDEX_OFFSET));
        push_instr(
            out,
            Instr::Const(Const {
                value: Value::I32(0),
            }),
        );
    }
    {
        let out = &mut local.block_mut(reserve_succeeded).instrs;
        push_current_frame_ptr(out, runtime, memory, ptr_ty);
        push_instr(out, Instr::LocalGet(LocalGet { local: call_index }));
        push_instr(out, store_i32(memory, CALL_INDEX_OFFSET));
        push_instr(
            out,
            Instr::Const(Const {
                value: Value::I32(1),
            }),
        );
    }
    {
        let out = &mut local.block_mut(local.entry_block()).instrs;
        if let Some(frame_reserve) = runtime.frame_reserve {
            push_instr(
                out,
                Instr::GlobalGet(GlobalGet {
                    global: runtime.buf_global,
                }),
            );
            push_instr(out, Instr::LocalGet(LocalGet { local: frame_size }));
            push_instr(
                out,
                Instr::Call(Call {
                    func: frame_reserve,
                }),
            );
            push_instr(out, store_ptr(memory, ptr_ty, 0));

            push_instr(
                out,
                Instr::GlobalGet(GlobalGet {
                    global: runtime.buf_global,
                }),
            );
            push_instr(out, load_ptr(memory, ptr_ty, 0));
            push_instr(
                out,
                Instr::Unop(walrus::ir::Unop {
                    op: match ptr_ty {
                        ValType::I32 => UnaryOp::I32Eqz,
                        ValType::I64 => UnaryOp::I64Eqz,
                        other => unreachable!("unsupported pointer type {other:?}"),
                    },
                }),
            );
            push_instr(
                out,
                Instr::IfElse(IfElse {
                    consequent: reserve_failed,
                    alternative: reserve_succeeded,
                }),
            );
        } else {
            // The legacy contiguous runtime already points at its active
            // frame, so only the static call-index write is required.
            push_instr(
                out,
                Instr::Block(Block {
                    seq: reserve_succeeded,
                }),
            );
        }
    }
    helper
}

fn rewrite_activation_unwind_boundaries(
    module: &mut Module,
    targets: &[FunctionId],
    tail_call_sites: &[TailCallSite],
    helpers: &HashMap<UnwindTransportKey, FunctionId>,
) {
    fn rewrite_seq(
        local: &mut LocalFunction,
        seq: InstrSeqId,
        helpers: &HashMap<UnwindTransportKey, FunctionId>,
    ) {
        let original = std::mem::take(&mut local.block_mut(seq).instrs);
        let mut rewritten = Vec::with_capacity(original.len());
        for (instruction, location) in original {
            for child in nested_seqs(&instruction) {
                rewrite_seq(local, child, helpers);
            }
            let instruction = match instruction {
                Instr::Call(call) => helpers
                    .get(&UnwindTransportKey::Direct(call.func))
                    .map_or(Instr::Call(call), |&helper| {
                        Instr::Call(Call { func: helper })
                    }),
                Instr::CallIndirect(call) => {
                    let helper = helpers[&UnwindTransportKey::Indirect {
                        table: call.table,
                        ty: call.ty,
                    }];
                    Instr::Call(Call { func: helper })
                }
                Instr::CallRef(call) => {
                    let helper = helpers[&UnwindTransportKey::Ref { ty: call.ty }];
                    Instr::Call(Call { func: helper })
                }
                other => other,
            };
            rewritten.push((instruction, location));
        }
        local.block_mut(seq).instrs = rewritten;
    }

    for &target in targets {
        let FunctionKind::Local(local) = &mut module.funcs.get_mut(target).kind else {
            continue;
        };
        rewrite_seq(local, local.entry_block(), helpers);
    }

    for &site in tail_call_sites {
        let FunctionKind::Local(local) = &mut module.funcs.get_mut(site.caller).kind else {
            panic!("fork-reaching tail site belongs to a non-local function");
        };
        let Some((instruction, _)) = local
            .block_mut(site.sequence)
            .instrs
            .get_mut(site.instruction_index)
        else {
            panic!("fork-reaching tail site points past its instruction sequence");
        };
        let helper = match (site.kind, &*instruction) {
            (TailCallKind::Direct, Instr::ReturnCall(call)) => {
                helpers.get(&UnwindTransportKey::Direct(call.func)).copied()
            }
            (TailCallKind::Indirect, Instr::ReturnCallIndirect(call)) => Some(
                helpers[&UnwindTransportKey::Indirect {
                    table: call.table,
                    ty: call.ty,
                }],
            ),
            (TailCallKind::Ref, Instr::ReturnCallRef(call)) => {
                Some(helpers[&UnwindTransportKey::Ref { ty: call.ty }])
            }
            _ => {
                panic!("fork-reaching tail-site metadata disagrees with the rewritten instruction")
            }
        };
        if let Some(helper) = helper {
            *instruction = Instr::ReturnCall(walrus::ir::ReturnCall { func: helper });
        }
    }
}

// ----------------------------------------------------------------------
// Frame layout constants
// ----------------------------------------------------------------------

const HEADER_SIZE: u32 = 16;
const FUNC_INDEX_OFFSET: u64 = 0;
const CALL_INDEX_OFFSET: u64 = 4;
const CATCH_SELECTOR_OFFSET: u64 = 8;
const REFERENCE_VECTOR_OFFSET: u64 = 12;
const LOCALS_START_OFFSET: u32 = HEADER_SIZE;

/// One reference value addressable from a call-specific recipe vector.
#[derive(Debug, Clone, Copy)]
struct ReferenceFrameSlot {
    local: LocalId,
    ty: RefType,
    class: RefClass,
    /// Stable vector position for values present at every landing. Resume
    /// thunks need this for function parameters before the original preamble
    /// has consumed the frame.
    universal_position: Option<u32>,
}

/// Per-call reference state derived from the original IR before rewriting.
///
/// A slot is emitted only when at least one call landing needs it. Each call
/// names the exact slots to encode/decode; definitely-null live locals instead
/// receive a direct `ref.null` restore and consume no frame bytes or host
/// recipe entry.
#[derive(Debug, Clone)]
struct ReferenceFramePlan {
    slots: Vec<ReferenceFrameSlot>,
    slots_by_call: Vec<Vec<usize>>,
    null_locals_by_call: Vec<Vec<(LocalId, RefType)>>,
}

#[derive(Debug, Clone, Copy)]
struct ResumeThunk {
    func_ordinal: u32,
    function: FunctionId,
}

impl ReferenceFramePlan {
    fn frame_end(&self, start: u32) -> u32 {
        // Reference recipes live in the process transaction's compact vector
        // log. The frame owns only its vector ordinal in reserved header word
        // 12, independent of function-wide reference liveness.
        start
    }
}

type TypedSpillLocal = (LocalId, ValType);

// ----------------------------------------------------------------------
// Per-function pipeline
// ----------------------------------------------------------------------

/// Classification of a top-level fork-path call site.
#[derive(Debug, Clone, Copy)]
enum CallTarget {
    Direct(FunctionId),
    Indirect { table: TableId },
    Ref,
}

/// A top-level call site awaiting dispatch-structure emission.
struct CallSiteInfo {
    target: CallTarget,
    /// A direct lexical callee whose activation owns the next replay frame.
    ///
    /// Such calls can enter the original function without an intervening
    /// resume thunk. The callee's frame-next import still validates the exact
    /// process event before consuming it.
    direct_activation: bool,
    sig_ty: TypeId,
    resume_ty: Option<TypeId>,
    loc: InstrLocId,
}

#[derive(Debug, Clone, Copy)]
struct CatchStateLocals {
    /// Zero before any caught edge, otherwise the function-local ordinal of
    /// the exact `(try_table region, catch arm)` pair most recently selected
    /// by this activation's dynamic execution.
    catch_selector: LocalId,
}

#[derive(Debug, Clone, Copy)]
struct AbortDispatch {
    /// Partial allocation failure branches back to the dispatch loop after
    /// writing its static call index into the module-owned abort scratch.
    ///
    /// The replay preamble intentionally lives outside this loop: fresh
    /// parent/child replay consumes a committed frame once, while the still-
    /// live failing activation restarts directly at its selected call without
    /// a per-activation selector/flag local.
    restart_loop: InstrSeqId,
    /// Cold module helper which reserves/selects the frame and writes the
    /// statically supplied call index, returning one on reservation success.
    frame_select: FunctionId,
}

#[allow(clippy::too_many_arguments)]
fn instrument_one_function(
    module: &mut Module,
    func_id: FunctionId,
    runtime: &Runtime,
    activations: &HashSet<FunctionId>,
    fork_path: &HashSet<FunctionId>,
    func_ordinal: u32,
    catch_plan: &[CatchRegionPlan],
    plain_catches: &[(InstrSeqId, Vec<PlainCatchArm>)],
    reference_analysis: &FunctionReferenceAnalysis,
    unwind_frame_select: FunctionId,
) -> ResumeThunk {
    // Choose scheme based on call-site topology. Post-commit-4
    // (2026-05-14) there are TWO live schemes (guard-dispatch was deleted):
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
    // - share the same fork-resume contract (state machine, linked
    //   activation frames, and deterministic tagged-catch rethrow).
    // - skip body chunks before the chosen POST_K on REWIND, so
    //   non-fork-path calls and side-effect ops in those chunks run
    //   exactly once on NORMAL — no per-op gating needed (the
    //   pre-2.5/2.6 Phase 4g machinery was deleted with guard-
    //   dispatch in commit 4).
    if has_nested_fork_calls(module, func_id, fork_path) {
        // Nested per-block switch-dispatch uses the cascading POST_K +
        // per-region br_table transform for every validated Wasm shape.
        // Classification below is only an internal typed-stack consistency
        // check; it is not an artifact support policy.
        let nested_status = classify_nested_pattern(module, func_id, fork_path);
        if nested_status.is_supported() {
            return instrument_one_function_nested_switch(
                module,
                func_id,
                runtime,
                activations,
                fork_path,
                func_ordinal,
                catch_plan,
                plain_catches,
                reference_analysis,
                unwind_frame_select,
            );
        }
        // Every Walrus producer is typed by `typed_instruction_pushes`.
        // Reaching this branch means those exhaustive stack effects disagree
        // with validated IR, which is an instrumenter bug rather than a
        // reference/control shape the artifact is forbidden to contain.
        let func = func_name(module, func_id);
        match nested_status {
            NestedSupportStatus::AnalysisInvariantFailed => panic!(
                "fork-instrument internal error: typed nested-stack analysis \
                 disagrees with validated function `{func}`; every valid Wasm \
                 reference, GC, EH, and multi-value producer must have an \
                 activation-owned carryover type"
            ),
            NestedSupportStatus::Supported => unreachable!(),
        }
    }

    if has_top_level_stack_carryovers(module, func_id, fork_path) {
        // Switch-dispatch absorbs every typed top-level carryover through
        // in-place spill/reload. `None` can now mean only that the exhaustive
        // Walrus stack model disagreed with validated IR.
        if compute_carryover_types(module, func_id, fork_path).is_some() {
            return instrument_one_function_switch(
                module,
                func_id,
                runtime,
                activations,
                fork_path,
                func_ordinal,
                catch_plan,
                plain_catches,
                reference_analysis,
                unwind_frame_select,
            );
        }
        let func = func_name(module, func_id);
        panic!(
            "fork-instrument internal error: typed top-level stack analysis \
             disagrees with validated function `{func}`; every valid Wasm \
             reference, GC, EH, and multi-value producer must have an \
             activation-owned carryover type"
        );
    }

    instrument_one_function_switch(
        module,
        func_id,
        runtime,
        activations,
        fork_path,
        func_ordinal,
        catch_plan,
        plain_catches,
        reference_analysis,
        unwind_frame_select,
    )
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
    activations: &HashSet<FunctionId>,
    fork_path: &HashSet<FunctionId>,
    func_ordinal: u32,
    catch_plan: &[CatchRegionPlan],
    plain_catches: &[(InstrSeqId, Vec<PlainCatchArm>)],
    reference_analysis: &FunctionReferenceAnalysis,
    unwind_frame_select: FunctionId,
) -> ResumeThunk {
    // Pre-existing user locals (args + referenced in body). Validation
    // guarantees that every one is scalar and therefore frame-owned.
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
    let (mut chunks, mut call_sites) = partition_body(&original_body, fork_path, module);
    for site in &mut call_sites {
        site.direct_activation = matches!(
            site.target,
            CallTarget::Direct(target) if activations.contains(&target)
        );
        let results = module.types.get(site.sig_ty).results().to_vec();
        site.resume_ty = Some(module.types.add(&[], &results));
    }
    let n_calls = call_sites.len();
    assert_reference_call_alignment(reference_analysis, &call_sites);

    // Allocate per-function synthetic locals.
    let catch_state_locals = if catch_plan.is_empty() && plain_catches.is_empty() {
        None
    } else {
        Some(CatchStateLocals {
            catch_selector: module.locals.add(ValType::I32),
        })
    };
    // Per-call argument materialization. The default is the existing
    // spill-local path; a conservative side-effect-free suffix can instead
    // be replayed after POST_K and needs no frame-backed arg locals. Reference
    // local.get operands are saved directly in the call's recipe vector.
    let pending_arg_materializations: Vec<PendingCallArgMaterialization> = call_sites
        .iter()
        .enumerate()
        .map(|(site_idx, cs)| {
            let arg_types = call_arg_types(module, cs);
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
    let mut carryover_spills: Vec<Vec<TypedSpillLocal>> = Vec::with_capacity(n_calls);
    for site_carryovers in &carryover_types {
        let spills: Vec<TypedSpillLocal> = site_carryovers
            .iter()
            .map(|&ty| (module.locals.add(spill_storage_type(ty)), ty))
            .collect();
        carryover_spills.push(spills);
    }

    let plain_catch_state = allocate_plain_catch_state(module, plain_catches);

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
            if is_scalar(ty) {
                frame_scalars.push((lid, ty));
            }
        }
    }
    for spills in &carryover_spills {
        for &(lid, ty) in spills {
            if is_scalar(ty) {
                frame_scalars.push((lid, ty));
            }
        }
    }
    let locals_with_offsets = assign_local_offsets(&frame_scalars, LOCALS_START_OFFSET);
    let ordinary_scalar_end = HEADER_SIZE + user_locals_size(&frame_scalars);
    let catch_scalar_frame = plan_plain_catch_scalar_frame(&plain_catch_state, ordinary_scalar_end);
    let scalar_end = catch_scalar_frame.frame_end(ordinary_scalar_end);
    let mut per_call_references = vec![Vec::new(); n_calls];
    for call_idx in 0..call_sites.len() {
        arg_materializations[call_idx]
            .append_reference_inputs(module, &mut per_call_references[call_idx]);
        for &(local, ty) in &carryover_spills[call_idx] {
            if let Some(reference) = supported_reference(ty) {
                per_call_references[call_idx].push((local, reference));
            }
        }
    }
    append_resume_parameter_references(module, func_id, &mut per_call_references);
    append_plain_catch_frame_references(&mut per_call_references, &plain_catch_state);
    let reference_frame = plan_reference_frame(module, reference_analysis, per_call_references);
    let frame_size = reference_frame.frame_end(scalar_end);

    let result_types: Vec<ValType> = {
        let ty_id = module.funcs.get(func_id).ty();
        module.types.get(ty_id).results().to_vec()
    };
    let restart_loop_ty = InstrSeqType::new(&mut module.types, &[], &result_types);

    let catch_handlers = plan_catch_handlers(catch_plan, &plain_catch_state);

    // Build the new body: preamble-if + Block($unwind_save) + postamble.
    let memory = first_memory(module);
    let ptr_ty = runtime.buf_type;

    // Rewind rethrows the frame-restored tag and scalar payload. CatchRef
    // clauses then manufacture a fresh instance-local exnref.
    if !plain_catch_state.is_empty() {
        let catch_state =
            catch_state_locals.expect("tagged catch plan requires catch-state locals");
        inject_rewind_throw_stubs(
            module,
            func_id,
            runtime,
            catch_state.catch_selector,
            catch_plan,
            &plain_catch_state,
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
    let restart_loop = local.builder_mut().dangling_instr_seq(restart_loop_ty).id();
    let abort = AbortDispatch {
        restart_loop,
        frame_select: unwind_frame_select,
    };
    let catch_scalar_restore_dispatch = catch_state_locals.and_then(|catch_state| {
        build_plain_catch_scalar_dispatch(
            local,
            runtime,
            memory,
            ptr_ty,
            catch_state.catch_selector,
            &catch_scalar_frame,
            PlainCatchScalarIo::Restore,
        )
    });
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
        catch_scalar_restore_dispatch,
        &reference_frame,
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
        frame_size,
        catch_state_locals,
        abort,
    );

    // Postamble lives outside $unwind_save, in the entry block, right
    // after the Block($unwind_save) instruction. It commits this
    // activation and throws the private unwind tag; no function result
    // is fabricated merely to walk the caller stack.
    let mut postamble: Vec<(Instr, InstrLocId)> = Vec::new();
    let catch_scalar_save_dispatch = catch_state_locals.and_then(|catch_state| {
        build_plain_catch_scalar_dispatch(
            local,
            runtime,
            memory,
            ptr_ty,
            catch_state.catch_selector,
            &catch_scalar_frame,
            PlainCatchScalarIo::Save,
        )
    });
    let reference_save_dispatch =
        build_reference_save_dispatch(local, runtime, memory, ptr_ty, &reference_frame);
    populate_postamble(
        &mut postamble,
        runtime,
        memory,
        ptr_ty,
        catch_state_locals,
        &locals_with_offsets,
        catch_scalar_save_dispatch,
        reference_save_dispatch,
        frame_size,
        func_ordinal,
    );

    // The preamble is outside the result-typed live-restart loop. Fresh
    // parent/child replay consumes its committed frame once; a synchronous
    // reservation failure branches straight back to the selected call inside
    // the loop without restoring over the still-live activation.
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
            op: BinaryOp::I32GeU,
        }),
    );
    push_instr(
        entry_seq,
        Instr::IfElse(IfElse {
            consequent: preamble_then,
            alternative: preamble_else,
        }),
    );
    push_instr(entry_seq, Instr::Loop(Loop { seq: restart_loop }));
    let restart_seq = &mut local.block_mut(restart_loop).instrs;
    push_instr(restart_seq, Instr::Block(Block { seq: unwind_save }));
    restart_seq.extend(postamble);

    // Per-arm captures intercept both Catch and CatchRef dispatch after the
    // body rebuild, save only transferable state, and forward the original
    // handler operands.
    if let Some(catch_state) = catch_state_locals {
        shield_private_unwind_from_user_catches(module, func_id, runtime);
        apply_plain_catch_handlers(
            module,
            func_id,
            catch_state.catch_selector,
            &plain_catch_state,
            &catch_handlers,
        );
    } else {
        debug_assert!(plain_catches.is_empty());
        shield_private_unwind_from_user_catches(module, func_id, runtime);
    }

    ResumeThunk {
        func_ordinal,
        function: emit_resume_thunk(
            module,
            func_id,
            runtime,
            memory,
            ptr_ty,
            frame_size,
            &locals_with_offsets,
            &reference_frame,
            func_ordinal,
        ),
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
                Instr::CallIndirect(_) | Instr::CallRef(_) => {
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
/// `top_level_stack_effect` is exhaustive over Walrus instructions,
/// including Wasm GC and legacy/modern EH. A depth underflow therefore
/// indicates malformed IR or an instrumenter bug; the exact typed walk will
/// diagnose that invariant rather than treating a valid source shape as
/// unsupported.
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
            Instr::CallRef(call) => Some(module.types.get(call.ty).params().len() + 1),
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
        }
    }

    false
}

enum StackEffect {
    Delta { pops: usize, pushes: usize },
    Terminator,
}

/// Compute the stack effect of a single instruction assuming it is
/// reachable (i.e., not sitting in a polymorphic post-terminator
/// region). Only used by `has_top_level_stack_carryovers`.
fn top_level_stack_effect(module: &Module, local: &LocalFunction, instr: &Instr) -> StackEffect {
    use StackEffect::{Delta, Terminator};

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
        // br_on_null refines and preserves the non-null fallthrough value.
        // br_on_cast* likewise preserves either the source or target value on
        // fallthrough. br_on_non_null consumes the known-null fallthrough
        // value; its non-null value is carried only on the branch edge.
        Instr::BrOnNull(_) | Instr::BrOnCast(_) | Instr::BrOnCastFail(_) => {
            Delta { pops: 1, pushes: 1 }
        }
        Instr::BrOnNonNull(_) => Delta { pops: 1, pushes: 0 },

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

        // --- Wasm-GC ---
        Instr::StructNew(new) => Delta {
            pops: module.types.get(new.ty).kind().unwrap_struct().fields.len(),
            pushes: 1,
        },
        Instr::StructNewDefault(_) => Delta { pops: 0, pushes: 1 },
        Instr::StructGet(_) | Instr::StructGetS(_) | Instr::StructGetU(_) => {
            Delta { pops: 1, pushes: 1 }
        }
        Instr::StructSet(_) => Delta { pops: 2, pushes: 0 },
        Instr::ArrayNew(_) => Delta { pops: 2, pushes: 1 },
        Instr::ArrayNewDefault(_) => Delta { pops: 1, pushes: 1 },
        Instr::ArrayNewFixed(new) => Delta {
            pops: new.len as usize,
            pushes: 1,
        },
        Instr::ArrayNewData(_) | Instr::ArrayNewElem(_) => Delta { pops: 2, pushes: 1 },
        Instr::ArrayGet(_) | Instr::ArrayGetS(_) | Instr::ArrayGetU(_) => {
            Delta { pops: 2, pushes: 1 }
        }
        Instr::ArraySet(_) => Delta { pops: 3, pushes: 0 },
        Instr::ArrayLen(_) => Delta { pops: 1, pushes: 1 },
        Instr::ArrayFill(_) => Delta { pops: 4, pushes: 0 },
        Instr::ArrayCopy(_) => Delta { pops: 5, pushes: 0 },
        Instr::ArrayInitData(_) | Instr::ArrayInitElem(_) => Delta { pops: 4, pushes: 0 },
    }
}

fn seq_result_types(
    module: &Module,
    local: &LocalFunction,
    seq_id: InstrSeqId,
) -> Option<Vec<ValType>> {
    match local.block(seq_id).ty {
        InstrSeqType::Simple(None) => Some(Vec::new()),
        InstrSeqType::Simple(Some(ty)) => Some(vec![ty]),
        InstrSeqType::MultiValue(ty_id) => Some(module.types.get(ty_id).results().to_vec()),
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
        return Some(ty);
    }
    if pre_stack.len() < 3 {
        return None;
    }
    let lhs = pre_stack[pre_stack.len() - 3];
    let rhs = pre_stack[pre_stack.len() - 2];
    match (lhs, rhs) {
        (Some(a), Some(b)) if a == b => Some(a),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        _ => None,
    }
}

fn concrete_non_null_ref(ty: TypeId) -> ValType {
    ValType::Ref(RefType {
        nullable: false,
        heap_type: HeapType::Concrete(ty),
    })
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
        Instr::TableGet(table_get) => {
            Some(ValType::Ref(module.tables.get(table_get.table).element_ty))
        }
        Instr::RefNull(reference) => Some(ValType::Ref(reference.ty)),
        Instr::RefFunc(reference) => Some(ValType::Ref(RefType {
            nullable: false,
            heap_type: HeapType::Concrete(module.funcs.get(reference.func).ty()),
        })),
        Instr::BrOnNull(_) => pre_stack.last().copied().flatten().and_then(|ty| {
            let ValType::Ref(mut reference) = ty else {
                return None;
            };
            reference.nullable = false;
            Some(ValType::Ref(reference))
        }),
        Instr::BrOnCast(cast) => Some(ValType::Ref(RefType {
            nullable: cast.from_nullable,
            heap_type: cast.from_heap_type,
        })),
        Instr::BrOnCastFail(cast) => Some(ValType::Ref(RefType {
            nullable: cast.to_nullable,
            heap_type: cast.to_heap_type,
        })),
        Instr::RefAsNonNull(_) => pre_stack.last().copied().flatten().map(|ty| match ty {
            ValType::Ref(mut reference) => {
                reference.nullable = false;
                ValType::Ref(reference)
            }
            other => other,
        }),
        Instr::RefI31(_) => Some(ValType::Ref(RefType {
            nullable: false,
            heap_type: HeapType::Abstract(AbstractHeapType::I31),
        })),
        Instr::RefCast(cast) => Some(ValType::Ref(RefType {
            nullable: cast.nullable,
            heap_type: cast.heap_type,
        })),
        Instr::AnyConvertExtern(_) => Some(ValType::Ref(RefType::ANYREF)),
        Instr::ExternConvertAny(_) => Some(ValType::Ref(RefType::EXTERNREF)),
        Instr::StructNew(new) => Some(concrete_non_null_ref(new.ty)),
        Instr::StructNewDefault(new) => Some(concrete_non_null_ref(new.ty)),
        Instr::StructGet(get) => Some(
            module.types.get(get.ty).kind().unwrap_struct().fields[get.field as usize]
                .element_type
                .unpack(),
        ),
        Instr::StructGetS(_) | Instr::StructGetU(_) => Some(ValType::I32),
        Instr::ArrayNew(new) => Some(concrete_non_null_ref(new.ty)),
        Instr::ArrayNewDefault(new) => Some(concrete_non_null_ref(new.ty)),
        Instr::ArrayNewFixed(new) => Some(concrete_non_null_ref(new.ty)),
        Instr::ArrayNewData(new) => Some(concrete_non_null_ref(new.ty)),
        Instr::ArrayNewElem(new) => Some(concrete_non_null_ref(new.ty)),
        Instr::ArrayGet(get) => Some(
            module
                .types
                .get(get.ty)
                .kind()
                .unwrap_array()
                .field
                .element_type
                .unpack(),
        ),
        Instr::ArrayGetS(_) | Instr::ArrayGetU(_) | Instr::ArrayLen(_) => Some(ValType::I32),
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
        | Instr::RefTest(_)
        | Instr::RefEq(_)
        | Instr::I31GetS(_)
        | Instr::I31GetU(_) => Some(ValType::I32),
        Instr::I8x16Swizzle { .. } | Instr::I8x16Shuffle { .. } => Some(ValType::V128),
        _ => None,
    }
}

fn typed_instruction_pushes(
    module: &Module,
    local: &LocalFunction,
    instr: &Instr,
    pre_stack: &[Option<ValType>],
) -> Option<Vec<ValType>> {
    let types = match instr {
        Instr::Call(call) => module
            .types
            .get(module.funcs.get(call.func).ty())
            .results()
            .to_vec(),
        Instr::CallIndirect(call) => module.types.get(call.ty).results().to_vec(),
        Instr::CallRef(call) => module.types.get(call.ty).results().to_vec(),
        Instr::Block(block) => seq_result_types(module, local, block.seq)?,
        Instr::Loop(loop_) => seq_result_types(module, local, loop_.seq)?,
        Instr::IfElse(if_else) => seq_result_types(module, local, if_else.consequent)?,
        Instr::TryTable(try_table) => seq_result_types(module, local, try_table.seq)?,
        Instr::Try(try_) => seq_result_types(module, local, try_.seq)?,
        Instr::I64Add128 { .. }
        | Instr::I64Sub128 { .. }
        | Instr::I64MulWideS { .. }
        | Instr::I64MulWideU { .. } => vec![ValType::I64, ValType::I64],
        _ => vec![typed_single_push(module, instr, pre_stack)?],
    };
    Some(types)
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
/// - `None` only when the exhaustive typed stack model disagrees with
///   already-validated Wasm IR (underflow, count mismatch, or impossible
///   producer typing). Callers treat that as an instrumenter bug.
///
/// `typed_instruction_pushes` covers every value-producing Walrus
/// instruction, including references, GC, EH control, indirect/ref calls,
/// structured multi-value results, and SIMD.
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

    // Typed operand stack, bottom-to-top. `Option` remains as a defensive
    // assertion channel for analyzer bugs; every valid producer has an exact
    // `ValType`, including reference and GC producers.
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
            Instr::CallRef(call) => {
                let sig = module.types.get(call.ty);
                let n_args = sig.params().len() + 1;
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
                let produced = typed_instruction_pushes(module, local, instr, &pre_stack)?;
                if produced.len() != pushes {
                    return None;
                }
                stack.extend(produced.into_iter().map(Some));
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
                        Instr::CallIndirect(_) | Instr::CallRef(_) => {
                            carryovers.push(Vec::new());
                        }
                        _ => {}
                    }
                }
                break;
            }
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
/// Returns `None` only if the exhaustive stack model disagrees with
/// validated IR; reference, GC, EH, indirect/ref-call, and multi-value
/// producers all have exact types.
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
            // Mismatch means discovery and reachable typed walking disagree.
            // Dead suffixes are excluded before this activation reaches the
            // transform; a mismatch here is an internal invariant failure.
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
/// Stack values retain `Option<ValType>` as an internal consistency channel.
/// Every valid producer, including reference/GC values and CallRef results,
/// pushes `Some(ty)`; `None` can therefore reach a snapshot only through an
/// analyzer bug.
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

    // Materialize the exact typed carryover. A `None` slot means the
    // exhaustive producer model failed its internal invariant.
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
            Instr::CallRef(call) => {
                let sig = module.types.get(call.ty);
                let n_args = sig.params().len() + 1;
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
                let produced = typed_instruction_pushes(module, f, instr, &pre_stack)?;
                if produced.len() != pushes {
                    return None;
                }
                stack.extend(produced.into_iter().map(Some));
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
                    direct_activation: false,
                    sig_ty,
                    resume_ty: None,
                    loc: *loc,
                });
                chunks.push(Vec::new());
            }
            Instr::CallIndirect(ci) => {
                calls.push(CallSiteInfo {
                    target: CallTarget::Indirect { table: ci.table },
                    direct_activation: false,
                    sig_ty: ci.ty,
                    resume_ty: None,
                    loc: *loc,
                });
                chunks.push(Vec::new());
            }
            Instr::CallRef(call) => {
                calls.push(CallSiteInfo {
                    target: CallTarget::Ref,
                    direct_activation: false,
                    sig_ty: call.ty,
                    resume_ty: None,
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

fn assert_reference_call_alignment(analysis: &FunctionReferenceAnalysis, calls: &[CallSiteInfo]) {
    assert_eq!(
        analysis.call_sites.len(),
        calls.len(),
        "original reference analysis and top-level transform discovered different call counts"
    );
    for (reference, call) in analysis.call_sites.iter().zip(calls) {
        let aligned = match (reference.kind, call.target) {
            (OriginalCallKind::Direct(expected), CallTarget::Direct(actual)) => expected == actual,
            (
                OriginalCallKind::Indirect {
                    table: expected_table,
                    ty: expected_ty,
                },
                CallTarget::Indirect {
                    table: actual_table,
                },
            ) => expected_table == actual_table && expected_ty == call.sig_ty,
            (OriginalCallKind::Ref { ty }, CallTarget::Ref) => ty == call.sig_ty,
            _ => false,
        };
        assert!(
            aligned,
            "reference analysis call {:?} does not align with transformed call target {:?}",
            reference.kind, call.target
        );
    }
}

fn call_arg_types(module: &Module, cs: &CallSiteInfo) -> Vec<ValType> {
    let params = module.types.get(cs.sig_ty).params().to_vec();
    let mut arg_types = params;
    match cs.target {
        CallTarget::Indirect { .. } => arg_types.push(ValType::I32),
        CallTarget::Ref => arg_types.push(ValType::Ref(RefType::FUNCREF)),
        CallTarget::Direct(_) => {}
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
        types: Vec<ValType>,
    },
    PureTail {
        tail: Vec<(Instr, InstrLocId)>,
        tail_len: usize,
    },
}

impl CallArgMaterialization {
    fn spill_locals(&self) -> &[LocalId] {
        match self {
            Self::Spill { locals, .. } => locals,
            Self::PureTail { .. } => &[],
        }
    }

    fn tail_len(&self) -> usize {
        match self {
            Self::Spill { .. } => 0,
            Self::PureTail { tail_len, .. } => *tail_len,
        }
    }

    fn append_reference_inputs(&self, module: &Module, references: &mut Vec<(LocalId, RefType)>) {
        match self {
            Self::Spill { locals, types } => {
                for (&local, &ty) in locals.iter().zip(types) {
                    if let Some(reference) = supported_reference(ty) {
                        references.push((local, reference));
                    }
                }
            }
            Self::PureTail { tail, .. } => {
                // WHY: replaying a reference local.get is side-effect-free,
                // but only if that exact local is itself activation-owned.
                // Recording it here avoids a per-call reference spill local
                // while ensuring the preamble restores it before reissuing
                // the pure argument suffix.
                for (instr, _) in tail {
                    let Instr::LocalGet(LocalGet { local }) = instr else {
                        continue;
                    };
                    let ValType::Ref(reference) = module.locals.get(*local).ty() else {
                        continue;
                    };
                    references.push((*local, reference));
                }
            }
        }
    }
}

fn plan_call_arg_materialization(
    module: &Module,
    chunk: &[(Instr, InstrLocId)],
    arg_types: Vec<ValType>,
) -> PendingCallArgMaterialization {
    if let Some((tail_len, tail)) = split_pure_replay_tail(module, chunk, &arg_types) {
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
            let locals = arg_types
                .iter()
                .map(|&ty| module.locals.add(spill_storage_type(ty)))
                .collect();
            CallArgMaterialization::Spill {
                locals,
                types: arg_types,
            }
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

fn split_pure_replay_tail(
    module: &Module,
    chunk: &[(Instr, InstrLocId)],
    expected_outputs: &[ValType],
) -> Option<(usize, Vec<(Instr, InstrLocId)>)> {
    if expected_outputs.is_empty() {
        return None;
    }

    for start in 0..chunk.len() {
        let tail = &chunk[start..];
        if let Some(outputs) = pure_replay_tail_outputs(module, tail) {
            if outputs == expected_outputs {
                return Some((tail.len(), tail.to_vec()));
            }
        }
    }

    None
}

fn pure_replay_tail_outputs(module: &Module, tail: &[(Instr, InstrLocId)]) -> Option<Vec<ValType>> {
    let mut stack: Vec<ValType> = Vec::new();
    for (instr, _) in tail {
        match instr {
            Instr::Const(c) => stack.push(pure_const_type(c)?),
            Instr::LocalGet(LocalGet { local }) => {
                let ty = module.locals.get(*local).ty();
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
            op: BinaryOp::I32GeU,
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
            op: BinaryOp::I32GeU,
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
    carryover_spills: &[Vec<TypedSpillLocal>],
    catch_handlers: &[CatchHandlerInfo],
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    frame_size: u32,
    catch_state_locals: Option<CatchStateLocals>,
    abort: AbortDispatch,
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
        frame_size,
        catch_state_locals,
        abort,
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
    carryover_spills: &[Vec<TypedSpillLocal>],
    catch_handlers: &[CatchHandlerInfo],
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    frame_size: u32,
    catch_state_locals: Option<CatchStateLocals>,
    abort: AbortDispatch,
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
            frame_size,
            catch_state_locals,
            abort,
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
            frame_size,
            catch_state_locals,
            abort,
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
    carryover_spills: &[Vec<TypedSpillLocal>],
    catch_handlers: &[CatchHandlerInfo],
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    frame_size: u32,
    catch_state_locals: Option<CatchStateLocals>,
    abort: AbortDispatch,
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
            frame_size,
            catch_state_locals,
            abort,
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
        frame_size,
        catch_state_locals,
        abort,
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
    carryover_spills: &[Vec<TypedSpillLocal>],
    catch_handlers: &[CatchHandlerInfo],
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    frame_size: u32,
    catch_state_locals: Option<CatchStateLocals>,
    abort: AbortDispatch,
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
            frame_size,
            catch_state_locals,
            function_unwind_save,
            abort,
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
        frame_size,
        catch_state_locals,
        function_unwind_save,
        abort,
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
fn emit_spill_args(
    out: &mut Vec<(Instr, InstrLocId)>,
    spills: &[LocalId],
    carryovers: &[TypedSpillLocal],
) {
    for &local in spills.iter().rev() {
        push_instr(out, Instr::LocalSet(LocalSet { local }));
    }
    for &(local, _ty) in carryovers.iter().rev() {
        push_instr(out, Instr::LocalSet(LocalSet { local }));
    }
}

fn emit_spill_call_tail(
    out: &mut Vec<(Instr, InstrLocId)>,
    arg_materialization: &CallArgMaterialization,
    carryovers: &[TypedSpillLocal],
) {
    emit_spill_args(out, arg_materialization.spill_locals(), carryovers);
}

fn emit_materialized_call_args(
    out: &mut Vec<(Instr, InstrLocId)>,
    arg_materialization: &CallArgMaterialization,
) {
    match arg_materialization {
        CallArgMaterialization::Spill { locals, types } => {
            for (&local, &ty) in locals.iter().zip(types) {
                push_typed_local_get(out, local, ty);
            }
        }
        CallArgMaterialization::PureTail { tail, .. } => {
            out.extend(tail.iter().cloned());
        }
    }
}

/// Handle the private unwind tag at one statically known call site.
///
/// Successful reservation records the static call index and branches to the
/// common frame postamble. A synchronous allocation failure instead selects
/// the header-sized abort scratch, records the same index, and restarts the
/// live activation at the dispatch loop. Since the replay preamble is outside
/// that loop, no activation-local selector/flag is required.
fn emit_static_call_unwind_handler(
    local: &mut LocalFunction,
    seq_id: InstrSeqId,
    ptr_ty: ValType,
    frame_size: u32,
    call_idx: u32,
    unwind_save: InstrSeqId,
    abort: AbortDispatch,
) {
    let reserve_succeeded = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();
    let reserve_failed = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();

    {
        let s = &mut local.block_mut(seq_id).instrs;
        push_instr(s, ptr_const(ptr_ty, frame_size as i64));
        push_instr(
            s,
            Instr::Const(Const {
                value: Value::I32(call_idx as i32),
            }),
        );
        push_instr(
            s,
            Instr::Call(Call {
                func: abort.frame_select,
            }),
        );
        push_instr(
            s,
            Instr::IfElse(IfElse {
                consequent: reserve_succeeded,
                alternative: reserve_failed,
            }),
        );
    }

    {
        let s = &mut local.block_mut(reserve_failed).instrs;
        push_instr(
            s,
            Instr::Br(Br {
                block: abort.restart_loop,
            }),
        );
    }

    {
        let s = &mut local.block_mut(reserve_succeeded).instrs;
        push_instr(s, Instr::Br(Br { block: unwind_save }));
    }
}

// ----------------------------------------------------------------------
// Preamble / postamble
// ----------------------------------------------------------------------

fn reference_plan_runs(
    plan: &ReferenceFramePlan,
) -> Vec<(usize, usize, Vec<usize>, Vec<(LocalId, RefType)>)> {
    let mut runs = Vec::new();
    let mut start = 0usize;
    while start < plan.slots_by_call.len() {
        let slots = &plan.slots_by_call[start];
        let nulls = &plan.null_locals_by_call[start];
        let mut end = start;
        while end + 1 < plan.slots_by_call.len()
            && plan.slots_by_call[end + 1] == *slots
            && plan.null_locals_by_call[end + 1] == *nulls
        {
            end += 1;
        }
        if !slots.is_empty() || !nulls.is_empty() {
            runs.push((start, end, slots.clone(), nulls.clone()));
        }
        start = end + 1;
    }
    runs
}

fn push_call_index_in_range(
    out: &mut Vec<(Instr, InstrLocId)>,
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    first: usize,
    last: usize,
) {
    push_current_call_index(out, runtime, memory, ptr_ty);
    push_instr(
        out,
        Instr::Const(Const {
            value: Value::I32(first as i32),
        }),
    );
    if first == last {
        push_instr(
            out,
            Instr::Binop(Binop {
                op: BinaryOp::I32Eq,
            }),
        );
        return;
    }
    push_instr(
        out,
        Instr::Binop(Binop {
            op: BinaryOp::I32GeU,
        }),
    );
    push_current_call_index(out, runtime, memory, ptr_ty);
    push_instr(
        out,
        Instr::Const(Const {
            value: Value::I32(last as i32),
        }),
    );
    push_instr(
        out,
        Instr::Binop(Binop {
            op: BinaryOp::I32LeU,
        }),
    );
    push_instr(
        out,
        Instr::Binop(Binop {
            op: BinaryOp::I32And,
        }),
    );
}

#[allow(clippy::too_many_arguments)]
fn emit_reference_restore_dispatch(
    local: &mut LocalFunction,
    seq: InstrSeqId,
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    plan: &ReferenceFramePlan,
) {
    let codecs = runtime
        .reference_codecs
        .expect("linked fork reference plan requires typed host codecs");
    let vector_get = runtime
        .reference_vector_get
        .expect("linked fork reference plan requires recipe-vector lookup");
    for (first, last, slots, nulls) in reference_plan_runs(plan) {
        let then_seq = local
            .builder_mut()
            .dangling_instr_seq(InstrSeqType::Simple(None))
            .id();
        let else_seq = local
            .builder_mut()
            .dangling_instr_seq(InstrSeqType::Simple(None))
            .id();
        {
            let out = &mut local.block_mut(then_seq).instrs;
            for (position, slot_idx) in slots.into_iter().enumerate() {
                let slot = plan.slots[slot_idx];
                let class = slot.class;
                push_current_frame_ptr(out, runtime, memory, ptr_ty);
                push_instr(out, load_i32(memory, REFERENCE_VECTOR_OFFSET));
                push_instr(
                    out,
                    Instr::Const(Const {
                        value: Value::I32(position as i32),
                    }),
                );
                push_instr(out, Instr::Call(Call { func: vector_get }));
                push_instr(
                    out,
                    Instr::Call(Call {
                        func: class.decoder(codecs),
                    }),
                );
                push_decoded_reference_narrowing(out, class, slot.ty);
                push_instr(out, Instr::LocalSet(LocalSet { local: slot.local }));
            }
            for (local, ty) in nulls {
                push_instr(out, Instr::RefNull(RefNull { ty }));
                push_instr(out, Instr::LocalSet(LocalSet { local }));
            }
        }
        let out = &mut local.block_mut(seq).instrs;
        push_call_index_in_range(out, runtime, memory, ptr_ty, first, last);
        push_instr(
            out,
            Instr::IfElse(IfElse {
                consequent: then_seq,
                alternative: else_seq,
            }),
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn build_reference_save_dispatch(
    local: &mut LocalFunction,
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    plan: &ReferenceFramePlan,
) -> Option<InstrSeqId> {
    if plan.slots_by_call.iter().all(Vec::is_empty) {
        return None;
    }
    let codecs = runtime
        .reference_codecs
        .expect("linked fork reference plan requires typed host codecs");
    let vector_begin = runtime
        .reference_vector_begin
        .expect("linked fork reference plan requires recipe-vector allocation");
    let vector_append = runtime
        .reference_vector_append
        .expect("linked fork reference plan requires recipe-vector append");
    let vector_finish = runtime
        .reference_vector_finish
        .expect("linked fork reference plan requires recipe-vector finish");
    let root = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();
    for (first, last, slots, _nulls) in reference_plan_runs(plan) {
        if slots.is_empty() {
            continue;
        }
        let then_seq = local
            .builder_mut()
            .dangling_instr_seq(InstrSeqType::Simple(None))
            .id();
        let else_seq = local
            .builder_mut()
            .dangling_instr_seq(InstrSeqType::Simple(None))
            .id();
        {
            let out = &mut local.block_mut(then_seq).instrs;
            push_current_frame_ptr(out, runtime, memory, ptr_ty);
            push_instr(
                out,
                Instr::Const(Const {
                    value: Value::I32(slots.len() as i32),
                }),
            );
            push_instr(out, Instr::Call(Call { func: vector_begin }));
            push_instr(out, store_i32(memory, REFERENCE_VECTOR_OFFSET));
            for slot_idx in slots {
                let slot = plan.slots[slot_idx];
                let class = slot.class;
                push_current_frame_ptr(out, runtime, memory, ptr_ty);
                push_instr(out, load_i32(memory, REFERENCE_VECTOR_OFFSET));
                push_typed_local_get(out, slot.local, ValType::Ref(slot.ty));
                push_instr(
                    out,
                    Instr::Call(Call {
                        func: class.encoder(codecs),
                    }),
                );
                push_instr(
                    out,
                    Instr::Call(Call {
                        func: vector_append,
                    }),
                );
            }
            // WHY: the frame must hold a durable canonical ordinal, never the
            // transaction-local builder handle returned by vector_begin. This
            // also interns identical vectors across recursive activations
            // without adding a source-function local or frame byte.
            push_current_frame_ptr(out, runtime, memory, ptr_ty);
            push_current_frame_ptr(out, runtime, memory, ptr_ty);
            push_instr(out, load_i32(memory, REFERENCE_VECTOR_OFFSET));
            push_instr(
                out,
                Instr::Call(Call {
                    func: vector_finish,
                }),
            );
            push_instr(out, store_i32(memory, REFERENCE_VECTOR_OFFSET));
        }
        let out = &mut local.block_mut(root).instrs;
        push_call_index_in_range(out, runtime, memory, ptr_ty, first, last);
        push_instr(
            out,
            Instr::IfElse(IfElse {
                consequent: then_seq,
                alternative: else_seq,
            }),
        );
    }
    Some(root)
}

#[allow(clippy::too_many_arguments)]
fn populate_preamble_then(
    local: &mut LocalFunction,
    preamble_then: InstrSeqId,
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    catch_state_locals: Option<CatchStateLocals>,
    locals_with_offsets: &[(LocalId, ValType, u32)],
    catch_scalar_restore_dispatch: Option<InstrSeqId>,
    reference_plan: &ReferenceFramePlan,
    frame_size: u32,
) {
    // Store the frame selected for replay in *(buf + 0). The linked format
    // asks the host-managed chain for the next committed frame; the legacy
    // format walks its contiguous buffer backward.
    let s = &mut local.block_mut(preamble_then).instrs;
    push_instr(
        s,
        Instr::GlobalGet(GlobalGet {
            global: runtime.buf_global,
        }),
    );
    if let Some(frame_next) = runtime.frame_next {
        push_instr(s, ptr_const(ptr_ty, frame_size as i64));
        push_instr(s, Instr::Call(Call { func: frame_next }));
    } else {
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
    }
    push_instr(s, store_ptr(memory, ptr_ty, 0));

    if let Some(catch_state) = catch_state_locals {
        // Frame word +8 owns the exact `(region, arm)` selector. Scalar arm
        // payloads are restored separately from their overlaid union.
        push_current_frame_ptr(s, runtime, memory, ptr_ty);
        push_instr(s, load_i32(memory, CATCH_SELECTOR_OFFSET));
        push_instr(
            s,
            Instr::LocalSet(LocalSet {
                local: catch_state.catch_selector,
            }),
        );
    }

    // Restore scalar user locals (includes arg-spill locals).
    for &(lid, ty, off) in locals_with_offsets {
        push_current_frame_ptr(s, runtime, memory, ptr_ty);
        push_instr(s, load_scalar(memory, ty, off as u64));
        push_instr(s, Instr::LocalSet(LocalSet { local: lid }));
    }
    if let Some(dispatch) = catch_scalar_restore_dispatch {
        push_instr(s, Instr::Block(Block { seq: dispatch }));
    }
    emit_reference_restore_dispatch(
        local,
        preamble_then,
        runtime,
        memory,
        ptr_ty,
        reference_plan,
    );
}

#[allow(clippy::too_many_arguments)]
fn populate_postamble(
    out: &mut Vec<(Instr, InstrLocId)>,
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    catch_state_locals: Option<CatchStateLocals>,
    locals_with_offsets: &[(LocalId, ValType, u32)],
    catch_scalar_save_dispatch: Option<InstrSeqId>,
    reference_save_dispatch: Option<InstrSeqId>,
    frame_size: u32,
    func_ordinal: u32,
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
        // frame[8] = exact non-zero `(region, arm)` selector in a catch.
        push_current_frame_ptr(out, runtime, memory, ptr_ty);
        push_instr(
            out,
            Instr::LocalGet(LocalGet {
                local: catch_state.catch_selector,
            }),
        );
        push_instr(out, store_i32(memory, CATCH_SELECTOR_OFFSET));
    } else {
        // frame[8] = no active catch region.
        push_current_frame_ptr(out, runtime, memory, ptr_ty);
        push_instr(
            out,
            Instr::Const(Const {
                value: Value::I32(0),
            }),
        );
        push_instr(out, store_i32(memory, CATCH_SELECTOR_OFFSET));
    }
    // frame[12] starts as the canonical empty reference-vector ordinal. The
    // call-specific save dispatch replaces it only when this landing owns
    // non-null recipe values.
    push_current_frame_ptr(out, runtime, memory, ptr_ty);
    push_instr(
        out,
        Instr::Const(Const {
            value: Value::I32(0),
        }),
    );
    push_instr(out, store_i32(memory, REFERENCE_VECTOR_OFFSET));

    // Save scalar user + arg-spill locals
    for &(lid, ty, off) in locals_with_offsets {
        push_current_frame_ptr(out, runtime, memory, ptr_ty);
        push_instr(out, Instr::LocalGet(LocalGet { local: lid }));
        push_instr(out, store_scalar(memory, ty, off as u64));
    }
    if let Some(dispatch) = catch_scalar_save_dispatch {
        push_instr(out, Instr::Block(Block { seq: dispatch }));
    }

    if let Some(dispatch) = reference_save_dispatch {
        // The call selector was written before entering this common postamble.
        // Each case encodes only values live for that original call landing.
        push_instr(out, Instr::Block(Block { seq: dispatch }));
    }

    if let Some(frame_commit) = runtime.frame_commit {
        // Publish only after the complete activation-owned payload exists.
        push_current_frame_ptr(out, runtime, memory, ptr_ty);
        push_instr(out, Instr::Call(Call { func: frame_commit }));
    } else {
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
    }

    // WHY: a synthesized default is not a value owned by this activation,
    // and non-nullable reference results do not have a valid default at all.
    // The process-owned tag is independent of the function's result type and
    // therefore transports unwind through every Wasm signature truthfully.
    let unwind_tag = runtime
        .unwind_tag
        .expect("fork-path instrumentation requires the linked unwind tag");
    push_instr(out, Instr::Throw(Throw { tag: unwind_tag }));
}

/// Post-call sequence for call site K, appended to sequence `seq_id`.
///
/// The one-based call selector is installed before entering the callee. Every
/// fork boundary either is an instrumented local function, whose postamble
/// throws the private unwind tag, or a generated transport helper which
/// converts a normal `STATE_UNWINDING` return to that tag before exposing its
/// results. The function-level catch therefore owns all frame reservation and
/// no source result remains on the operand stack across a state probe here.
fn populate_lexical_call(
    local: &mut LocalFunction,
    sequence: InstrSeqId,
    target: CallTarget,
    sig_ty: TypeId,
    location: InstrLocId,
    arguments: &CallArgMaterialization,
) {
    let out = &mut local.block_mut(sequence).instrs;
    emit_materialized_call_args(out, arguments);
    if matches!(target, CallTarget::Ref) {
        push_instr(
            out,
            Instr::RefCast(walrus::ir::RefCast {
                nullable: false,
                heap_type: HeapType::Concrete(sig_ty),
            }),
        );
    }
    let instruction = match target {
        CallTarget::Direct(func) => Instr::Call(Call { func }),
        CallTarget::Indirect { table } => Instr::CallIndirect(CallIndirect { ty: sig_ty, table }),
        CallTarget::Ref => Instr::CallRef(walrus::ir::CallRef { ty: sig_ty }),
    };
    out.push((instruction, location));
}

#[allow(clippy::too_many_arguments)]
fn emit_resume_selected_call(
    local: &mut LocalFunction,
    sequence: InstrSeqId,
    target: CallTarget,
    sig_ty: TypeId,
    resume_ty: TypeId,
    location: InstrLocId,
    arguments: &CallArgMaterialization,
    runtime: &Runtime,
    diagnostic_type: i32,
) {
    let resume_peek = runtime
        .resume_peek
        .expect("replay-routed call requires process resume peek");
    let resume_table = runtime
        .resume_table
        .expect("replay-routed call requires process resume table");
    let branch_ty = InstrSeqType::MultiValue(resume_ty);
    let lexical_sentinel = local.builder_mut().dangling_instr_seq(branch_ty).id();
    let dispatch = local.builder_mut().dangling_instr_seq(branch_ty).id();

    populate_lexical_call(local, lexical_sentinel, target, sig_ty, location, arguments);
    {
        let out = &mut local.block_mut(dispatch).instrs;
        // `resume_peek` is non-consuming and the journal pins its selection
        // until frame_next. Calling it again on this replay-only branch avoids
        // adding one live i32 local to every ordinary function activation.
        push_instr(
            out,
            Instr::Const(Const {
                value: Value::I32(diagnostic_type),
            }),
        );
        push_instr(out, Instr::Call(Call { func: resume_peek }));
        push_instr(
            out,
            Instr::CallIndirect(CallIndirect {
                ty: resume_ty,
                table: resume_table,
            }),
        );
    }
    {
        let out = &mut local.block_mut(sequence).instrs;
        // The ordinal is diagnostic only. Exact template/event identity picks
        // the target; Wasm call_indirect is the authoritative recursive-type
        // compatibility check and leaves the event unconsumed on mismatch.
        push_instr(
            out,
            Instr::Const(Const {
                value: Value::I32(diagnostic_type),
            }),
        );
        push_instr(out, Instr::Call(Call { func: resume_peek }));
        push_instr(
            out,
            Instr::Unop(walrus::ir::Unop {
                op: UnaryOp::I32Eqz,
            }),
        );
        push_instr(
            out,
            Instr::IfElse(IfElse {
                consequent: lexical_sentinel,
                alternative: dispatch,
            }),
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn emit_replay_routed_call(
    local: &mut LocalFunction,
    sequence: InstrSeqId,
    target: CallTarget,
    direct_activation: bool,
    sig_ty: TypeId,
    resume_ty: TypeId,
    location: InstrLocId,
    arguments: &CallArgMaterialization,
    runtime: &Runtime,
) {
    let branch_ty = InstrSeqType::MultiValue(resume_ty);
    let normal = local.builder_mut().dangling_instr_seq(branch_ty).id();
    let replay = local.builder_mut().dangling_instr_seq(branch_ty).id();
    populate_lexical_call(local, normal, target, sig_ty, location, arguments);
    if direct_activation {
        // WHY: adding a no-argument resume thunk in front of every ordinary
        // recursive activation doubles native rewind depth. A materialized
        // direct callee already owns the selected event; its preamble
        // validates activation/function identity through frame_next before
        // consuming it. Tail-transparent, indirect, and reference calls still
        // require the process router because their lexical target need not be
        // the next materialized activation.
        debug_assert!(matches!(target, CallTarget::Direct(_)));
        populate_lexical_call(local, replay, target, sig_ty, location, arguments);
    } else {
        emit_resume_selected_call(
            local,
            replay,
            target,
            sig_ty,
            resume_ty,
            location,
            arguments,
            runtime,
            sig_ty.index() as i32,
        );
    }
    let out = &mut local.block_mut(sequence).instrs;
    push_instr(
        out,
        Instr::GlobalGet(GlobalGet {
            global: runtime.state_global,
        }),
    );
    push_instr(
        out,
        Instr::Const(Const {
            value: Value::I32(runtime::STATE_REWINDING),
        }),
    );
    push_instr(
        out,
        Instr::Binop(Binop {
            op: BinaryOp::I32GeU,
        }),
    );
    push_instr(
        out,
        Instr::IfElse(IfElse {
            consequent: replay,
            alternative: normal,
        }),
    );
}

/// Emit one result-typed private-tag boundary around a fork-reaching call.
///
/// Values carried below the call remain below `result_boundary`; a normal
/// call branches out with only its declared results. A private unwind lands
/// after `catch_boundary`, where the statically known call index selects the
/// frame or live-abort restart without any source-function selector local.
#[allow(clippy::too_many_arguments)]
fn emit_replay_routed_call_with_unwind_boundary(
    local: &mut LocalFunction,
    sequence: InstrSeqId,
    target: CallTarget,
    direct_activation: bool,
    sig_ty: TypeId,
    resume_ty: TypeId,
    location: InstrLocId,
    arguments: &CallArgMaterialization,
    call_idx: u32,
    runtime: &Runtime,
    _memory: MemoryId,
    ptr_ty: ValType,
    frame_size: u32,
    unwind_save: InstrSeqId,
    abort: AbortDispatch,
) {
    let result_ty = InstrSeqType::MultiValue(resume_ty);
    let result_boundary = local.builder_mut().dangling_instr_seq(result_ty).id();
    let catch_boundary = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();
    let call_body = local.builder_mut().dangling_instr_seq(result_ty).id();

    emit_replay_routed_call(
        local,
        call_body,
        target,
        direct_activation,
        sig_ty,
        resume_ty,
        location,
        arguments,
        runtime,
    );
    {
        let out = &mut local.block_mut(catch_boundary).instrs;
        push_instr(
            out,
            Instr::TryTable(TryTable {
                seq: call_body,
                catches: vec![TryTableCatch::Catch {
                    tag: runtime
                        .unwind_tag
                        .expect("fork call boundary requires private unwind tag"),
                    label: catch_boundary,
                }],
            }),
        );
        // On the normal edge the call's results satisfy the result boundary.
        // The catch edge branches to the end of this simple block and enters
        // the static unwind handler below with no fabricated result values.
        push_instr(
            out,
            Instr::Br(Br {
                block: result_boundary,
            }),
        );
    }
    {
        let out = &mut local.block_mut(result_boundary).instrs;
        push_instr(
            out,
            Instr::Block(Block {
                seq: catch_boundary,
            }),
        );
    }
    emit_static_call_unwind_handler(
        local,
        result_boundary,
        ptr_ty,
        frame_size,
        call_idx,
        unwind_save,
        abort,
    );
    // Both handler arms branch away, but make that fact explicit to the
    // validator: the result-typed boundary has no fallthrough value on the
    // caught edge.
    push_instr(
        &mut local.block_mut(result_boundary).instrs,
        Instr::Unreachable(Unreachable {}),
    );
    push_instr(
        &mut local.block_mut(sequence).instrs,
        Instr::Block(Block {
            seq: result_boundary,
        }),
    );
}

#[allow(clippy::too_many_arguments)]
fn emit_post_call_via_local(
    local: &mut LocalFunction,
    seq_id: InstrSeqId,
    call: &CallSiteInfo,
    call_idx: usize,
    arg_materialization: &CallArgMaterialization,
    carryovers: &[TypedSpillLocal],
    _catch_handlers: &[CatchHandlerInfo],
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    frame_size: u32,
    _catch_state_locals: Option<CatchStateLocals>,
    unwind_save: InstrSeqId,
    abort: AbortDispatch,
) {
    // Reload carryovers (deepest first), then args (deepest first).
    // The call pops only its args, leaving the carryovers + result on
    // the stack — matching the original code's expected shape.
    {
        let s = &mut local.block_mut(seq_id).instrs;
        for &(local, ty) in carryovers {
            push_typed_local_get(s, local, ty);
        }
    }
    emit_replay_routed_call_with_unwind_boundary(
        local,
        seq_id,
        call.target,
        call.direct_activation,
        call.sig_ty,
        call.resume_ty
            .expect("call site resume type was not assigned"),
        call.loc,
        arg_materialization,
        call_idx as u32,
        runtime,
        memory,
        ptr_ty,
        frame_size,
        unwind_save,
        abort,
    );
}

#[allow(clippy::too_many_arguments)]
fn emit_resume_thunk(
    module: &mut Module,
    resumed_function: FunctionId,
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    frame_size: u32,
    scalar_offsets: &[(LocalId, ValType, u32)],
    references: &ReferenceFramePlan,
    func_ordinal: u32,
) -> FunctionId {
    let frame_peek = runtime
        .frame_peek
        .expect("activation resume thunk requires linked frame peek");
    let codecs = runtime
        .reference_codecs
        .expect("activation resume thunk requires reference codecs");
    let vector_get = runtime
        .reference_vector_get
        .expect("activation resume thunk requires recipe-vector lookup");
    let (arguments, results) = {
        let function = module.funcs.get(resumed_function);
        let FunctionKind::Local(local) = &function.kind else {
            unreachable!("resume thunk target must be a local function");
        };
        (
            local.args.clone(),
            module.types.get(function.ty()).results().to_vec(),
        )
    };
    let scalar_offsets: HashMap<LocalId, (ValType, u32)> = scalar_offsets
        .iter()
        .map(|&(local, ty, offset)| (local, (ty, offset)))
        .collect();
    let reference_slots: HashMap<LocalId, ReferenceFrameSlot> = references
        .slots
        .iter()
        .copied()
        .map(|slot| (slot.local, slot))
        .collect();
    let frame = module.locals.add(ptr_ty);
    let mut builder = FunctionBuilder::new(&mut module.types, &[], &results);
    builder.name(format!("__wpk_fork_resume_{func_ordinal}"));
    {
        let mut body = builder.func_body();
        let out = body.instrs_mut();
        push_instr(out, ptr_const(ptr_ty, frame_size as i64));
        push_instr(out, Instr::Call(Call { func: frame_peek }));
        push_instr(out, Instr::LocalSet(LocalSet { local: frame }));

        for argument in arguments {
            let ty = module.locals.get(argument).ty();
            match ty {
                ValType::Ref(reference) => {
                    let slot = reference_slots.get(&argument).unwrap_or_else(|| {
                        panic!("resume thunk parameter {argument:?} has no activation-owned recipe")
                    });
                    let position = slot.universal_position.unwrap_or_else(|| {
                        panic!(
                            "resume thunk parameter {argument:?} does not have a stable recipe-vector position"
                        )
                    });
                    push_instr(out, Instr::LocalGet(LocalGet { local: frame }));
                    push_instr(out, load_i32(memory, REFERENCE_VECTOR_OFFSET));
                    push_instr(
                        out,
                        Instr::Const(Const {
                            value: Value::I32(position as i32),
                        }),
                    );
                    push_instr(out, Instr::Call(Call { func: vector_get }));
                    push_instr(
                        out,
                        Instr::Call(Call {
                            func: slot.class.decoder(codecs),
                        }),
                    );
                    push_decoded_reference_narrowing(out, slot.class, reference);
                }
                scalar => {
                    let &(saved_ty, offset) = scalar_offsets.get(&argument).unwrap_or_else(|| {
                        panic!("resume thunk scalar parameter {argument:?} has no frame offset")
                    });
                    debug_assert_eq!(scalar, saved_ty);
                    push_instr(out, Instr::LocalGet(LocalGet { local: frame }));
                    push_instr(out, load_scalar(memory, scalar, offset as u64));
                }
            }
        }
        push_instr(
            out,
            Instr::Call(Call {
                func: resumed_function,
            }),
        );
    }
    builder.finish(Vec::new(), &mut module.funcs)
}

fn emit_resume_catalog(module: &mut Module, thunks: &[ResumeThunk]) {
    let size = thunks.len() as u64;
    let table = module
        .tables
        .add_local(false, size, Some(size), RefType::FUNCREF);
    module.tables.get_mut(table).name = Some(RESUME_CATALOG_EXPORT.into());
    if !thunks.is_empty() {
        module.elements.add(
            ElementKind::Active {
                table,
                offset: walrus::ConstExpr::Value(Value::I32(0)),
            },
            ElementItems::Functions(thunks.iter().map(|thunk| thunk.function).collect()),
        );
    }
    module.exports.add(RESUME_CATALOG_EXPORT, table);

    // The host already validates the exact module template and event target.
    // Function type equivalence remains the engine's job at the generated
    // call_indirect site, avoiding a second recursive-type implementation.
    let mut data = Vec::with_capacity(usize::from(RESUME_CATALOG_HEADER_SIZE) + thunks.len() * 8);
    data.extend_from_slice(&RESUME_CATALOG_MAGIC);
    data.extend_from_slice(&RESUME_CATALOG_VERSION.to_le_bytes());
    data.extend_from_slice(&RESUME_CATALOG_HEADER_SIZE.to_le_bytes());
    data.extend_from_slice(&(thunks.len() as u32).to_le_bytes());
    for (slot, thunk) in thunks.iter().enumerate() {
        debug_assert_eq!(thunk.func_ordinal, slot as u32);
        data.extend_from_slice(&thunk.func_ordinal.to_le_bytes());
        data.extend_from_slice(&(slot as u32).to_le_bytes());
    }
    module.customs.add(RawCustomSection {
        name: RESUME_CATALOG_SECTION.into(),
        data,
    });
}

fn exported_function(module: &Module, name: &str) -> Option<FunctionId> {
    module.exports.iter().find_map(|export| {
        if export.name != name {
            return None;
        }
        match export.item {
            ExportItem::Function(function) => Some(function),
            _ => None,
        }
    })
}

fn exported_table(module: &Module, name: &str) -> Option<TableId> {
    module.exports.iter().find_map(|export| {
        if export.name != name {
            return None;
        }
        match export.item {
            ExportItem::Table(table) => Some(table),
            _ => None,
        }
    })
}

fn emit_fixed_resume_boundaries(module: &mut Module, runtime: &Runtime) {
    if runtime.resume_peek.is_none() || runtime.resume_table.is_none() {
        return;
    }

    if let Some(start) = exported_function(module, "_start") {
        let start_ty = module.funcs.get(start).ty();
        let signature = module.types.get(start_ty);
        if signature.params().is_empty() && signature.results().is_empty() {
            let resume_ty = module.types.add(&[], &[]);
            let mut builder = FunctionBuilder::new(&mut module.types, &[], &[]);
            builder.name(RESUME_START_EXPORT.into());
            let wrapper = builder.finish(Vec::new(), &mut module.funcs);
            let entry = local_mut(module, wrapper).entry_block();
            emit_resume_selected_call(
                local_mut(module, wrapper),
                entry,
                CallTarget::Direct(start),
                start_ty,
                resume_ty,
                InstrLocId::default(),
                &CallArgMaterialization::Spill {
                    locals: Vec::new(),
                    types: Vec::new(),
                },
                runtime,
                0,
            );
            module.exports.add(RESUME_START_EXPORT, wrapper);
        }
    }

    if let Some(function_table) = exported_table(module, "__indirect_function_table") {
        let ptr_ty = runtime.buf_type;
        let thread_ty = module.types.add(&[ptr_ty], &[ptr_ty]);
        let resume_ty = module.types.add(&[], &[ptr_ty]);
        let table_index = module.locals.add(ValType::I32);
        let argument = module.locals.add(ptr_ty);
        let mut builder =
            FunctionBuilder::new(&mut module.types, &[ValType::I32, ptr_ty], &[ptr_ty]);
        builder.name(RESUME_THREAD_EXPORT.into());
        let wrapper = builder.finish(vec![table_index, argument], &mut module.funcs);
        let entry = local_mut(module, wrapper).entry_block();
        emit_resume_selected_call(
            local_mut(module, wrapper),
            entry,
            CallTarget::Indirect {
                table: function_table,
            },
            thread_ty,
            resume_ty,
            InstrLocId::default(),
            &CallArgMaterialization::Spill {
                // call_indirect consumes function parameters first and its
                // table index last; the public wrapper keeps the ergonomic
                // host ABI `(table_index, arg)`.
                locals: vec![argument, table_index],
                types: vec![ptr_ty, ValType::I32],
            },
            runtime,
            0,
        );
        module.exports.add(RESUME_THREAD_EXPORT, wrapper);
    }
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

fn append_resume_parameter_references(
    module: &Module,
    func_id: FunctionId,
    per_call_references: &mut [Vec<(LocalId, RefType)>],
) {
    let FunctionKind::Local(local) = &module.funcs.get(func_id).kind else {
        return;
    };
    let params = module.types.get(module.funcs.get(func_id).ty()).params();
    debug_assert_eq!(local.args.len(), params.len());
    for (&argument, &ty) in local.args.iter().zip(params) {
        let Some(reference) = supported_reference(ty) else {
            continue;
        };
        // WHY: a resume thunk has no parameters so callers with a different
        // lexical signature can bypass eliminated tail frames. Even a dead
        // non-nullable parameter needs a valid value to enter the original
        // function, whose preamble then consumes and restores this frame.
        for references in per_call_references.iter_mut() {
            references.push((argument, reference));
        }
    }
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

fn supported_reference(ty: ValType) -> Option<RefType> {
    match ty {
        ValType::Ref(reference) => Some(reference),
        _ => None,
    }
}

fn spill_storage_type(ty: ValType) -> ValType {
    match supported_reference(ty) {
        Some(reference) if !reference.nullable => {
            let mut storage = reference;
            storage.nullable = true;
            ValType::Ref(storage)
        }
        _ => ty,
    }
}

fn push_typed_local_get(out: &mut Vec<(Instr, InstrLocId)>, local: LocalId, expected: ValType) {
    push_instr(out, Instr::LocalGet(LocalGet { local }));
    if matches!(expected, ValType::Ref(reference) if !reference.nullable) {
        push_instr(out, Instr::RefAsNonNull(RefAsNonNull {}));
    }
}

fn push_decoded_reference_narrowing(
    out: &mut Vec<(Instr, InstrLocId)>,
    class: RefClass,
    expected: RefType,
) {
    let broad = class.nullable_type();
    if expected.heap_type != broad.heap_type {
        push_instr(
            out,
            Instr::RefCast(walrus::ir::RefCast {
                nullable: expected.nullable,
                heap_type: expected.heap_type,
            }),
        );
    } else if !expected.nullable {
        push_instr(out, Instr::RefAsNonNull(RefAsNonNull {}));
    }
}

fn plan_reference_frame(
    module: &Module,
    analysis: &FunctionReferenceAnalysis,
    mut per_call_synthetic: Vec<Vec<(LocalId, RefType)>>,
) -> ReferenceFramePlan {
    debug_assert_eq!(analysis.call_sites.len(), per_call_synthetic.len());
    let call_count = analysis.call_sites.len();
    let mut per_call_refs: Vec<BTreeMap<LocalId, RefType>> = vec![BTreeMap::new(); call_count];
    let mut null_locals_by_call = vec![Vec::new(); call_count];

    for (call_idx, site) in analysis.call_sites.iter().enumerate() {
        if site.reachable {
            // The replayed callee can still throw after the child-side fork
            // return. Preserve references used by either normal continuation
            // or an exceptional successor; definitely-null cleanup locals
            // remain recipe-free below.
            for &local in &site.live_ref_locals_on_any_successor {
                let ty = analysis.reference_locals[&local];
                match site
                    .local_nullability_before_call
                    .get(&local)
                    .copied()
                    .unwrap_or(ReferenceNullability::MaybeNonNull)
                {
                    ReferenceNullability::DefinitelyNull if ty.nullable => {
                        null_locals_by_call[call_idx].push((local, ty));
                    }
                    ReferenceNullability::DefinitelyNull | ReferenceNullability::MaybeNonNull => {
                        per_call_refs[call_idx].insert(local, ty);
                    }
                }
            }
        }
        for (local, ty) in per_call_synthetic[call_idx].drain(..) {
            per_call_refs[call_idx]
                .entry(local)
                .and_modify(|existing| {
                    debug_assert_eq!(RefClass::of(module, *existing), RefClass::of(module, ty));
                    existing.nullable &= ty.nullable;
                })
                .or_insert(ty);
        }
    }

    let mut union = BTreeMap::<LocalId, RefType>::new();
    let mut occurrence_count = BTreeMap::<LocalId, usize>::new();
    for refs in &per_call_refs {
        for (&local, &ty) in refs {
            union
                .entry(local)
                .and_modify(|existing| existing.nullable &= ty.nullable)
                .or_insert(ty);
            *occurrence_count.entry(local).or_default() += 1;
        }
    }

    let mut slots = Vec::with_capacity(union.len());
    let mut slot_by_local = BTreeMap::<LocalId, usize>::new();
    // Values present at every landing form a stable vector prefix. Function
    // reference parameters are deliberately added to every landing, allowing
    // a no-parameter resume thunk to decode them without a synthetic local or
    // a call-index dispatch.
    let mut ordered: Vec<_> = union.into_iter().collect();
    ordered.sort_by_key(|(local, _)| {
        (
            occurrence_count.get(local).copied().unwrap_or(0) != call_count,
            *local,
        )
    });
    let universal_count = ordered
        .iter()
        .take_while(|(local, _)| occurrence_count.get(local).copied().unwrap_or(0) == call_count)
        .count();
    for (position, (local, ty)) in ordered.into_iter().enumerate() {
        let index = slots.len();
        slots.push(ReferenceFrameSlot {
            local,
            ty,
            class: RefClass::of(module, ty),
            universal_position: (position < universal_count).then_some(position as u32),
        });
        slot_by_local.insert(local, index);
    }
    let slots_by_call = per_call_refs
        .into_iter()
        .map(|refs| {
            let mut slots: Vec<_> = refs
                .into_keys()
                .map(|local| slot_by_local[&local])
                .collect();
            slots.sort_unstable();
            slots
        })
        .collect();

    ReferenceFramePlan {
        slots,
        slots_by_call,
        null_locals_by_call,
    }
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
// Tagged-catch region planning
// ----------------------------------------------------------------------

fn plan_catch_regions(
    module: &Module,
    targets: &[FunctionId],
) -> HashMap<FunctionId, Vec<CatchRegionPlan>> {
    let mut catch_plans: HashMap<FunctionId, Vec<CatchRegionPlan>> = HashMap::new();
    for &id in targets {
        let bodies = discover_try_table_bodies(module, id);
        let mut per_func: Vec<CatchRegionPlan> = Vec::with_capacity(bodies.len());
        for (lex_idx, body_seq) in bodies.into_iter().enumerate() {
            per_func.push(CatchRegionPlan {
                body_seq,
                catch_region_id: (lex_idx as u32) + 1,
            });
        }
        if !per_func.is_empty() {
            catch_plans.insert(id, per_func);
        }
    }
    catch_plans
}

#[derive(Debug, Clone, Copy)]
pub struct CatchRegionPlan {
    pub body_seq: InstrSeqId,
    pub catch_region_id: u32,
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

/// A statically tagged catch shape whose identity and scalar payload can be
/// serialized in an activation frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaggedCatchKind {
    Plain,
    Ref,
    /// A user CatchAll retargeted through CatchAllRef so the activation owns
    /// the otherwise-hidden exception identity.
    AllPlain,
    AllRef,
}

impl TaggedCatchKind {
    fn is_plain(self) -> bool {
        matches!(self, Self::Plain | Self::AllPlain)
    }

    fn is_ref(self) -> bool {
        matches!(self, Self::Ref | Self::AllRef)
    }
}

/// Describes one catch clause in a fork-path try_table.
#[derive(Debug, Clone)]
pub struct PlainCatchArm {
    /// Index of this arm within its try_table's `catches` list. The emitted
    /// state assigns the `(catch_region_id, arm_idx)` pair one non-zero
    /// function-local selector stored directly in frame word +8.
    pub arm_idx: u32,
    /// Whether normal handler entry receives only the tag payload or the tag
    /// payload followed by an instance-local exnref.
    pub kind: TaggedCatchKind,
    /// Tag this arm catches, or `None` for CatchAll/CatchAllRef.
    pub tag: Option<TagId>,
    /// Label the arm branches to on catch (target block id).
    pub label: InstrSeqId,
    /// Tag's operand types (matches the params of the type that
    /// `module.tags.get(tag).ty()` references). Cached at discovery
    /// time so we don't re-look-up on emission.
    pub operand_tys: Vec<ValType>,
    /// JavaScript cannot inspect `v128`, `exnref`, or GC/reference payloads.
    /// Capture the entire exception as one exnref recipe and replay it with
    /// `throw_ref` instead of serializing those operands independently.
    pub uses_exception_recipe: bool,
}

/// Stage 1 (B1) — for each try_table in `func_id`, returns
/// `(body_seq, catch_arms)` where every tagged and catch-all arm is represented.
/// CatchAll is retargeted through CatchAllRef so an arbitrary Wasm/JSTag/raw
/// exception has the same positive broker/recipe path as an explicit
/// CatchAllRef. Tagged payloads that JavaScript cannot inspect are likewise
/// captured through CatchRef and owned by one exnref recipe.
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
                let (kind, tag, label) = match c {
                    TryTableCatch::Catch { tag, label } => {
                        (TaggedCatchKind::Plain, Some(*tag), *label)
                    }
                    TryTableCatch::CatchRef { tag, label } => {
                        (TaggedCatchKind::Ref, Some(*tag), *label)
                    }
                    TryTableCatch::CatchAll { label } => (TaggedCatchKind::AllPlain, None, *label),
                    TryTableCatch::CatchAllRef { label } => (TaggedCatchKind::AllRef, None, *label),
                };
                let operand_tys: Vec<ValType> = tag
                    .map(|tag| {
                        module
                            .types
                            .get(module.tags.get(tag).ty())
                            .params()
                            .to_vec()
                    })
                    .unwrap_or_default();
                let uses_exception_recipe = tag.is_none()
                    || operand_tys
                        .iter()
                        .any(|ty| matches!(ty, ValType::Ref(_) | ValType::V128));
                arms.push(PlainCatchArm {
                    arm_idx: i as u32,
                    kind,
                    tag,
                    label,
                    operand_tys,
                    uses_exception_recipe,
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

/// Module-wide static tagged-catch plan.
#[derive(Debug, Clone, Default)]
pub struct PlainCatchPlan {
    /// Per-function per-region arm metadata. Outer Vec
    /// parallels `discover_plain_catch_arms`'s return shape (one
    /// entry per try_table that has at least one plain-catch arm).
    pub per_function: std::collections::HashMap<FunctionId, Vec<(InstrSeqId, Vec<PlainCatchArm>)>>,
}

/// Discover every tagged and catch-all clause across fork-path functions.
///
/// Every arm receives either exact scalar payload ownership or one complete
/// exception recipe. Silently omitting an arm would be an instrumenter bug
/// that surfaced only in a fresh child.
pub fn plan_plain_catches(module: &Module, targets: &[FunctionId]) -> PlainCatchPlan {
    let mut plan = PlainCatchPlan::default();
    for &fid in targets {
        let arms_per_region = discover_plain_catch_arms(module, fid);
        if arms_per_region.is_empty() {
            continue;
        }
        plan.per_function.insert(fid, arms_per_region);
    }
    plan
}

/// Activation-owned plain-catch state for one static arm.
#[derive(Debug, Clone)]
struct PlainCatchArmState {
    arm: PlainCatchArm,
    /// Non-zero function-local identity for this exact `(region, arm)` pair.
    ///
    /// WHY: frame word +8 is copied to a fresh child. Keeping the selector in
    /// that existing header word avoids both a frame-backed `active_arm` local
    /// and any module-instance auxiliary state.
    selector: u32,
    /// Typed per-region union used to forward the original tag payload and,
    /// for scalar arms, back the selector-overlaid frame bytes. Recipe-backed
    /// arms do not serialize these values independently because the exception
    /// codec owns their payload atomically.
    operand_locals: Vec<LocalId>,
    /// Function-shared CatchRef forwarding scratch for scalar arms, or
    /// region-shared activation state for recipe-backed exceptions. Only the
    /// latter is added to the linked frame's reference plan.
    captured_exnref: Option<LocalId>,
}

/// Activation-owned state for one try_table with plain catches.
///
/// WHY: these locals are added to the ordinary function frame, so recursive
/// calls and later activations cannot alias one module-wide scratch tuple.
#[derive(Debug, Clone)]
struct PlainCatchRegionState {
    body_seq: InstrSeqId,
    /// Function-wide retained exception selected by frame word +8.
    ///
    /// WHY: only one catch selector is activation-live at a time. A retained
    /// complete-exception recipe that cannot be named by that selector is not
    /// replay state; user-visible exceptions that remain live have separate
    /// typed local/operand ownership. Sharing this slot across regions keeps
    /// static catch-region count out of the native activation footprint and
    /// out of the process reference vector.
    retained_recipe_exnref: Option<LocalId>,
    /// Arms in a region receive one contiguous selector interval, allowing
    /// the rewind guard to recognize the region with two unsigned compares.
    first_selector: u32,
    last_selector: u32,
    arms: Vec<PlainCatchArmState>,
}

fn allocate_plain_catch_state(
    module: &mut Module,
    plain_catches: &[(InstrSeqId, Vec<PlainCatchArm>)],
) -> Vec<PlainCatchRegionState> {
    let forwarding_exnref_scratch = plain_catches
        .iter()
        .flat_map(|(_, arms)| arms)
        .any(|arm| arm.kind.is_ref() && !arm.uses_exception_recipe)
        .then(|| {
            module.locals.add(ValType::Ref(RefType {
                nullable: true,
                heap_type: HeapType::Abstract(AbstractHeapType::Exn),
            }))
        });
    let retained_recipe_exnref = plain_catches
        .iter()
        .flat_map(|(_, arms)| arms)
        .any(|arm| arm.uses_exception_recipe)
        .then(|| {
            module.locals.add(ValType::Ref(RefType {
                nullable: true,
                heap_type: HeapType::Abstract(AbstractHeapType::Exn),
            }))
        });
    let mut next_selector = 1u32;
    let mut regions = Vec::with_capacity(plain_catches.len());
    let mut operand_pools: Vec<(ValType, Vec<LocalId>)> = Vec::new();
    for (body_seq, arms) in plain_catches {
        debug_assert!(!arms.is_empty());
        let first_selector = next_selector;
        let mut arm_states = Vec::with_capacity(arms.len());
        for arm in arms.iter().cloned() {
            let selector = next_selector;
            next_selector = next_selector
                .checked_add(1)
                .expect("a Wasm function cannot contain 2^32 catch arms");
            let mut uses_by_type: Vec<(ValType, usize)> = Vec::new();
            let mut operand_locals = Vec::with_capacity(arm.operand_tys.len());
            for &ty in &arm.operand_tys {
                let storage_ty = spill_storage_type(ty);
                let ordinal = match uses_by_type
                    .iter_mut()
                    .find(|(candidate, _)| *candidate == storage_ty)
                {
                    Some((_, next)) => {
                        let ordinal = *next;
                        *next += 1;
                        ordinal
                    }
                    None => {
                        uses_by_type.push((storage_ty, 1));
                        0
                    }
                };
                let pool_index = operand_pools
                    .iter()
                    .position(|(candidate, _)| *candidate == storage_ty)
                    .unwrap_or_else(|| {
                        operand_pools.push((storage_ty, Vec::new()));
                        operand_pools.len() - 1
                    });
                let pool = &mut operand_pools[pool_index].1;
                if pool.len() == ordinal {
                    pool.push(module.locals.add(storage_ty));
                }
                // WHY: catch capture publishes one dynamically latest selector
                // per activation, and the capture tail contains no call or
                // throw between overwriting this typed scratch and publishing
                // that selector. A function-wide typed union therefore cannot
                // be observed half-updated by fork. Guest-visible values from
                // earlier handlers have ordinary local/operand liveness
                // ownership; this scratch exists only to rethrow the selected
                // catch. Recursive activations still receive distinct native
                // local tuples.
                operand_locals.push(pool[ordinal]);
            }
            let captured_exnref = if arm.uses_exception_recipe {
                // The single latest-catch selector owns this value. An older
                // synthetic recipe cannot be replayed after another catch
                // supersedes its selector; any guest-visible exception that
                // remains live is captured independently by typed liveness.
                retained_recipe_exnref
            } else if arm.kind.is_ref() {
                // WHY: a scalar CatchRef needs this local only to move the
                // non-null exception past its scalar payload. The generated
                // capture tail contains no call or throw and clears the local
                // before entering user code, so mutually exclusive arms can
                // share one function-local scratch without retaining a GC
                // root or increasing every activation by one exnref per arm.
                forwarding_exnref_scratch
            } else {
                None
            };
            arm_states.push(PlainCatchArmState {
                arm,
                selector,
                operand_locals,
                captured_exnref,
            });
        }
        regions.push(PlainCatchRegionState {
            body_seq: *body_seq,
            retained_recipe_exnref,
            first_selector,
            last_selector: next_selector - 1,
            arms: arm_states,
        });
    }
    regions
}

#[derive(Debug, Clone)]
struct PlainCatchScalarArmFrame {
    selector: u32,
    fields: Vec<(LocalId, ValType, u32)>,
}

/// One overlaid scalar payload range shared by every catch arm in a function.
///
/// Only one `(region, arm)` selector can own a continuation landing. Giving
/// each arm offsets relative to the same `start` therefore preserves the
/// selected payload in `max(arm_size)` bytes instead of summing all static
/// arms. Save/restore dispatch below makes the aliasing explicit and prevents
/// inactive locals from overwriting the active arm.
#[derive(Debug, Clone, Default)]
struct PlainCatchScalarFrame {
    arms: Vec<PlainCatchScalarArmFrame>,
    byte_len: u32,
}

impl PlainCatchScalarFrame {
    fn frame_end(&self, start: u32) -> u32 {
        start
            .checked_add(self.byte_len)
            .expect("catch payload frame exceeds the 32-bit continuation format")
    }
}

fn plan_plain_catch_scalar_frame(
    regions: &[PlainCatchRegionState],
    start: u32,
) -> PlainCatchScalarFrame {
    let mut plan = PlainCatchScalarFrame::default();
    for region in regions {
        for arm in &region.arms {
            let mut relative = 0u32;
            let mut fields = Vec::new();
            if !arm.arm.uses_exception_recipe {
                for (&local, &ty) in arm.operand_locals.iter().zip(&arm.arm.operand_tys) {
                    fields.push((
                        local,
                        ty,
                        start
                            .checked_add(relative)
                            .expect("catch payload offset exceeds the frame format"),
                    ));
                    relative = relative
                        .checked_add(scalar_size(ty))
                        .expect("catch payload exceeds the frame format");
                }
            }
            plan.byte_len = plan.byte_len.max(relative);
            plan.arms.push(PlainCatchScalarArmFrame {
                selector: arm.selector,
                fields,
            });
        }
    }
    plan
}

#[derive(Debug, Clone, Copy)]
enum PlainCatchScalarIo {
    Save,
    Restore,
}

/// Build a selector-guarded frame I/O tree for the overlaid catch payload.
///
/// Inactive arms intentionally perform no memory access. A non-zero selector
/// not present in the static function plan is corrupt continuation state and
/// traps before replay can branch into user code.
fn build_plain_catch_scalar_dispatch(
    local: &mut LocalFunction,
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    catch_selector: LocalId,
    plan: &PlainCatchScalarFrame,
    io: PlainCatchScalarIo,
) -> Option<InstrSeqId> {
    if plan.arms.is_empty() {
        return None;
    }

    let empty = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();
    let invalid = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();
    push_instr(
        &mut local.block_mut(invalid).instrs,
        Instr::Unreachable(Unreachable {}),
    );

    // Selector zero is the common path outside a catch. Every other value
    // must match an exact static arm below.
    let mut chain = local
        .builder_mut()
        .dangling_instr_seq(InstrSeqType::Simple(None))
        .id();
    {
        let out = &mut local.block_mut(chain).instrs;
        push_instr(
            out,
            Instr::LocalGet(LocalGet {
                local: catch_selector,
            }),
        );
        push_instr(
            out,
            Instr::Unop(walrus::ir::Unop {
                op: UnaryOp::I32Eqz,
            }),
        );
        push_instr(
            out,
            Instr::IfElse(IfElse {
                consequent: empty,
                alternative: invalid,
            }),
        );
    }

    for arm in plan.arms.iter().rev() {
        let action = local
            .builder_mut()
            .dangling_instr_seq(InstrSeqType::Simple(None))
            .id();
        {
            let out = &mut local.block_mut(action).instrs;
            for &(field, ty, offset) in &arm.fields {
                match io {
                    PlainCatchScalarIo::Save => {
                        push_current_frame_ptr(out, runtime, memory, ptr_ty);
                        push_instr(out, Instr::LocalGet(LocalGet { local: field }));
                        push_instr(out, store_scalar(memory, ty, offset as u64));
                    }
                    PlainCatchScalarIo::Restore => {
                        push_current_frame_ptr(out, runtime, memory, ptr_ty);
                        push_instr(out, load_scalar(memory, ty, offset as u64));
                        push_instr(out, Instr::LocalSet(LocalSet { local: field }));
                    }
                }
            }
        }

        let select = local
            .builder_mut()
            .dangling_instr_seq(InstrSeqType::Simple(None))
            .id();
        {
            let out = &mut local.block_mut(select).instrs;
            push_instr(
                out,
                Instr::LocalGet(LocalGet {
                    local: catch_selector,
                }),
            );
            push_instr(
                out,
                Instr::Const(Const {
                    value: Value::I32(arm.selector as i32),
                }),
            );
            push_instr(
                out,
                Instr::Binop(Binop {
                    op: BinaryOp::I32Eq,
                }),
            );
            push_instr(
                out,
                Instr::IfElse(IfElse {
                    consequent: action,
                    alternative: chain,
                }),
            );
        }
        chain = select;
    }
    Some(chain)
}

fn append_plain_catch_frame_references(
    per_call_references: &mut [Vec<(LocalId, RefType)>],
    regions: &[PlainCatchRegionState],
) {
    let exnref = RefType {
        nullable: true,
        heap_type: HeapType::Abstract(AbstractHeapType::Exn),
    };
    let Some(exception) = regions
        .iter()
        .find_map(|region| region.retained_recipe_exnref)
    else {
        return;
    };
    debug_assert!(
        regions
            .iter()
            .all(|region| region.retained_recipe_exnref == Some(exception))
    );
    debug_assert!(
        regions
            .iter()
            .flat_map(|region| &region.arms)
            .filter(|arm| arm.arm.uses_exception_recipe)
            .all(|arm| arm.captured_exnref == Some(exception))
    );
    // Any call can be reached while a handler activation is live. Encoding
    // null when no recipe catch is selected is the deterministic zero-recipe
    // fast path; the selected arm's non-null exception is activation state and
    // appears exactly once in each call-specific reference vector.
    for references in per_call_references.iter_mut() {
        references.push((exception, exnref));
    }
}

// ----------------------------------------------------------------------
// Phase 6c — rewind-throw stub injection
// ----------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
/// Phase 6c (extended by B1 Stage 2 Task 2.3) — prepend a rewind-throw
/// stub at the top of each fork-path try_table body.
///
/// On REWIND, when `catch_selector_local` falls in this region's selector
/// interval, the stub re-enters the try_table's catch dispatch so the original
/// handler observes the same exception that was caught pre-fork.
///
/// Both Catch and CatchRef restore the exact selector from frame word +8 and
/// scalar tag operands from the overlaid payload range, then throw the matching
/// tag. The original CatchRef clause creates a fresh exnref in the child.
fn inject_rewind_throw_stubs(
    module: &mut Module,
    func_id: FunctionId,
    runtime: &Runtime,
    catch_selector_local: LocalId,
    catch_plan: &[CatchRegionPlan],
    plain_catches: &[PlainCatchRegionState],
) {
    let plain_lookup: HashMap<InstrSeqId, &PlainCatchRegionState> = plain_catches
        .iter()
        .map(|region| (region.body_seq, region))
        .collect();

    for plan in catch_plan {
        let body_seq_id = plan.body_seq;
        let Some(region) = plain_lookup.get(&body_seq_id).copied() else {
            continue;
        };

        // An unknown arm means the continuation is corrupt or from an
        // incompatible artifact. There is no module-instance reference
        // fallback in ABI 43.
        let invalid_arm = {
            let local = local_mut(module, func_id);
            let s = local
                .builder_mut()
                .dangling_instr_seq(InstrSeqType::Simple(None))
                .id();
            let block = &mut local.block_mut(s).instrs;
            push_instr(block, Instr::Unreachable(Unreachable {}));
            s
        };

        let dispatch_seq_id =
            build_plain_catch_dispatch(module, func_id, region, catch_selector_local, invalid_arm);

        // Build the empty else for the outer REWIND-match guard.
        let else_id = {
            let local = local_mut(module, func_id);
            local
                .builder_mut()
                .dangling_instr_seq(InstrSeqType::Simple(None))
                .id()
        };

        // Prepend the outer guard. Selectors are allocated contiguously per
        // region, so two unsigned comparisons recognize this exact lexical
        // try_table without another activation-local word.
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
                op: BinaryOp::I32GeU,
            }),
        );
        push_instr(
            body,
            Instr::LocalGet(LocalGet {
                local: catch_selector_local,
            }),
        );
        push_instr(
            body,
            Instr::Const(Const {
                value: Value::I32(region.first_selector as i32),
            }),
        );
        push_instr(
            body,
            Instr::Binop(Binop {
                op: BinaryOp::I32GeU,
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
            Instr::LocalGet(LocalGet {
                local: catch_selector_local,
            }),
        );
        push_instr(
            body,
            Instr::Const(Const {
                value: Value::I32(region.last_selector as i32),
            }),
        );
        push_instr(
            body,
            Instr::Binop(Binop {
                op: BinaryOp::I32LeU,
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

/// Build a dangling sequence that rethrows one frame-restored tagged catch.
fn build_plain_catch_dispatch(
    module: &mut Module,
    func_id: FunctionId,
    region: &PlainCatchRegionState,
    catch_selector_local: LocalId,
    invalid_arm: InstrSeqId,
) -> InstrSeqId {
    debug_assert!(!region.arms.is_empty());

    let mut chain = invalid_arm;
    for arm in region.arms.iter().rev() {
        let throw_id = {
            let local = local_mut(module, func_id);
            local
                .builder_mut()
                .dangling_instr_seq(InstrSeqType::Simple(None))
                .id()
        };
        let local = local_mut(module, func_id);
        let s = &mut local.block_mut(throw_id).instrs;
        if arm.arm.uses_exception_recipe {
            let exception = arm
                .captured_exnref
                .expect("recipe-backed catch must own an exnref local");
            push_instr(s, Instr::LocalGet(LocalGet { local: exception }));
            push_instr(s, Instr::RefAsNonNull(RefAsNonNull {}));
            push_instr(s, Instr::ThrowRef(walrus::ir::ThrowRef {}));
        } else {
            for (&operand, &ty) in arm.operand_locals.iter().zip(&arm.arm.operand_tys) {
                push_typed_local_get(s, operand, ty);
            }
            push_instr(
                s,
                Instr::Throw(Throw {
                    tag: arm
                        .arm
                        .tag
                        .expect("scalar tagged catch dispatch must have a tag"),
                }),
            );
        }

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
            push_instr(
                s,
                Instr::LocalGet(LocalGet {
                    local: catch_selector_local,
                }),
            );
            push_instr(
                s,
                Instr::Const(Const {
                    value: Value::I32(arm.selector as i32),
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
    body_seq: InstrSeqId,
}

fn plan_catch_handlers(
    catch_plan: &[CatchRegionPlan],
    plain_catches: &[PlainCatchRegionState],
) -> Vec<CatchHandlerInfo> {
    plain_catches
        .iter()
        .filter_map(|region| {
            catch_plan
                .iter()
                .find(|plan| plan.body_seq == region.body_seq)
                .map(|plan| CatchHandlerInfo {
                    body_seq: plan.body_seq,
                })
        })
        .collect()
}

// ----------------------------------------------------------------------
// Per-arm capture-block emission for tagged catches
// ----------------------------------------------------------------------

/// Ensure a user `catch_all`/`catch_all_ref` can never consume the
/// process-owned unwind transport.
///
/// A modern `try_table` catch transfers directly to an enclosing label, so a
/// zero-result shield block is inserted around the original instruction:
///
/// ```text
/// block $outer (param P) (result R)
///   block $private_shield (param P)
///     try_table (param P) (result R)
///       (catch $__wpk_fork_unwind $private_shield)
///       ...original catches...
///     br $outer
///   end
///   throw $__wpk_fork_unwind
/// end
/// ```
///
/// Typed block parameters preserve the original operand stack without
/// allocating reference temporaries (which would themselves become stale GC
/// roots). Legacy EH has explicit handler sequences, so it only needs a typed
/// private handler inserted immediately before its catch-all.
fn shield_private_unwind_from_user_catches(
    module: &mut Module,
    func_id: FunctionId,
    runtime: &Runtime,
) {
    #[derive(Clone, Copy)]
    enum Site {
        TryTable { body: InstrSeqId, depth: u32 },
        LegacyTry { body: InstrSeqId, depth: u32 },
    }

    fn collect(
        local: &LocalFunction,
        seq: InstrSeqId,
        depth: u32,
        seen: &mut HashSet<InstrSeqId>,
        out: &mut Vec<Site>,
    ) {
        if !seen.insert(seq) {
            return;
        }
        for (instr, _) in &local.block(seq).instrs {
            match instr {
                Instr::TryTable(tt)
                    if tt.catches.iter().any(|catch| {
                        matches!(
                            catch,
                            TryTableCatch::CatchAll { .. } | TryTableCatch::CatchAllRef { .. }
                        )
                    }) =>
                {
                    out.push(Site::TryTable {
                        body: tt.seq,
                        depth,
                    });
                }
                Instr::Try(legacy)
                    if legacy
                        .catches
                        .iter()
                        .any(|catch| matches!(catch, LegacyCatch::CatchAll { .. })) =>
                {
                    out.push(Site::LegacyTry {
                        body: legacy.seq,
                        depth,
                    });
                }
                _ => {}
            }
            for child in nested_seqs(instr) {
                collect(local, child, depth + 1, seen, out);
            }
        }
    }

    let unwind_tag = runtime
        .unwind_tag
        .expect("fork-path instrumentation requires the linked unwind tag");
    let mut sites = Vec::new();
    {
        let local = match &module.funcs.get(func_id).kind {
            FunctionKind::Local(local) => local,
            _ => return,
        };
        collect(
            local,
            local.entry_block(),
            0,
            &mut HashSet::new(),
            &mut sites,
        );
    }
    sites.sort_by_key(|site| match site {
        Site::TryTable { depth, .. } | Site::LegacyTry { depth, .. } => std::cmp::Reverse(*depth),
    });

    for site in sites {
        match site {
            Site::TryTable { body, .. } => {
                let Some((parent, index, loc, mut table, body_ty)) = ({
                    let local = match &module.funcs.get(func_id).kind {
                        FunctionKind::Local(local) => local,
                        _ => return,
                    };
                    find_try_table_instr_site(local, local.entry_block(), body)
                }) else {
                    continue;
                };

                let params = match body_ty {
                    InstrSeqType::Simple(_) => Vec::new(),
                    InstrSeqType::MultiValue(ty) => module.types.get(ty).params().to_vec(),
                };
                let shield_ty = InstrSeqType::new(&mut module.types, &params, &[]);
                let (outer, shield) = {
                    let local = local_mut(module, func_id);
                    let outer = local.builder_mut().dangling_instr_seq(body_ty).id();
                    let shield = local.builder_mut().dangling_instr_seq(shield_ty).id();
                    (outer, shield)
                };

                let catch_all_index = table
                    .catches
                    .iter()
                    .position(|catch| {
                        matches!(
                            catch,
                            TryTableCatch::CatchAll { .. } | TryTableCatch::CatchAllRef { .. }
                        )
                    })
                    .expect("collected try_table still has a catch-all");
                table.catches.insert(
                    catch_all_index,
                    TryTableCatch::Catch {
                        tag: unwind_tag,
                        label: shield,
                    },
                );

                {
                    let local = local_mut(module, func_id);
                    let s = &mut local.block_mut(shield).instrs;
                    push_instr(s, Instr::TryTable(table));
                    push_instr(s, Instr::Br(Br { block: outer }));
                }
                {
                    let local = local_mut(module, func_id);
                    let s = &mut local.block_mut(outer).instrs;
                    push_instr(s, Instr::Block(Block { seq: shield }));
                    push_instr(s, Instr::Throw(Throw { tag: unwind_tag }));
                }
                local_mut(module, func_id).block_mut(parent).instrs[index] =
                    (Instr::Block(Block { seq: outer }), loc);
            }
            Site::LegacyTry { body, .. } => {
                let Some((parent, index, body_ty)) = ({
                    let local = match &module.funcs.get(func_id).kind {
                        FunctionKind::Local(local) => local,
                        _ => return,
                    };
                    find_legacy_try_instr_site(local, local.entry_block(), body)
                }) else {
                    continue;
                };
                let results = match body_ty {
                    InstrSeqType::Simple(None) => Vec::new(),
                    InstrSeqType::Simple(Some(result)) => vec![result],
                    InstrSeqType::MultiValue(ty) => module.types.get(ty).results().to_vec(),
                };
                let handler_ty = InstrSeqType::new(&mut module.types, &[], &results);
                let handler = {
                    let local = local_mut(module, func_id);
                    local.builder_mut().dangling_instr_seq(handler_ty).id()
                };
                {
                    let local = local_mut(module, func_id);
                    push_instr(
                        &mut local.block_mut(handler).instrs,
                        Instr::Throw(Throw { tag: unwind_tag }),
                    );
                    let Instr::Try(legacy) = &mut local.block_mut(parent).instrs[index].0 else {
                        unreachable!("legacy try site changed during shielding");
                    };
                    let catch_all_index = legacy
                        .catches
                        .iter()
                        .position(|catch| matches!(catch, LegacyCatch::CatchAll { .. }))
                        .expect("collected legacy try still has a catch-all");
                    legacy.catches.insert(
                        catch_all_index,
                        LegacyCatch::Catch {
                            tag: unwind_tag,
                            handler,
                        },
                    );
                }
            }
        }
    }
}

fn find_try_table_instr_site(
    local: &LocalFunction,
    seq: InstrSeqId,
    body: InstrSeqId,
) -> Option<(InstrSeqId, usize, InstrLocId, TryTable, InstrSeqType)> {
    for (index, (instr, loc)) in local.block(seq).instrs.iter().enumerate() {
        if let Instr::TryTable(table) = instr {
            if table.seq == body {
                return Some((seq, index, *loc, table.clone(), local.block(body).ty));
            }
        }
        for child in nested_seqs(instr) {
            if let Some(site) = find_try_table_instr_site(local, child, body) {
                return Some(site);
            }
        }
    }
    None
}

fn find_legacy_try_instr_site(
    local: &LocalFunction,
    seq: InstrSeqId,
    body: InstrSeqId,
) -> Option<(InstrSeqId, usize, InstrSeqType)> {
    for (index, (instr, _)) in local.block(seq).instrs.iter().enumerate() {
        if let Instr::Try(legacy) = instr {
            if legacy.seq == body {
                return Some((seq, index, local.block(body).ty));
            }
        }
        for child in nested_seqs(instr) {
            if let Some(site) = find_legacy_try_instr_site(local, child, body) {
                return Some(site);
            }
        }
    }
    None
}

/// Emit per-arm capture blocks that intercept tagged Catch and CatchRef
/// dispatch.
///
/// Each capture spills its scalar operands to activation-owned frame locals,
/// records the active region/arm, re-pushes the original operands, and branches
/// to the user's handler. CatchRef captures only the scalar tag payload; its
/// instance-local exnref is forwarded and then cleared from the synthetic
/// local so it does not survive as a stale GC root.
fn apply_plain_catch_handlers(
    module: &mut Module,
    func_id: FunctionId,
    catch_selector_local: LocalId,
    plain_catches: &[PlainCatchRegionState],
    catch_handlers: &[CatchHandlerInfo],
) {
    if plain_catches.is_empty() {
        return;
    }

    for region in plain_catches {
        let body_seq = region.body_seq;
        let arm_states = &region.arms;
        if arm_states.is_empty() {
            continue;
        }

        let (parent_seq, original_catches, try_table_type) = {
            let local = match &module.funcs.get(func_id).kind {
                FunctionKind::Local(l) => l,
                _ => continue,
            };
            let (parent, tt) = match find_try_table_parent_seq(local, local.entry_block(), body_seq)
            {
                Some(v) => v,
                None => continue,
            };
            (parent, tt.catches.clone(), local.block(body_seq).ty)
        };

        debug_assert!(catch_handlers.iter().any(|h| h.body_seq == body_seq));

        // ----------------------------------------------------------
        // Build dangling sequences: outer + N caps.
        // Caps are ordered outer-to-inner so `cap_seq_ids[J]` is the
        // J-th outermost (and corresponds to `arm_states[J]`). The
        // innermost cap (`cap_seq_ids[N-1]`) holds the inner try_table
        // and the `br $b1_outer` that handles normal exit.
        // ----------------------------------------------------------
        let outer_seq_id = {
            let local = local_mut(module, func_id);
            local.builder_mut().dangling_instr_seq(try_table_type).id()
        };

        // The original target label already carries the exact catch branch
        // type. For CatchRef that is tag.params followed by a non-null exnref.
        // Reusing it avoids weakening concrete EH reference types.
        let mut cap_seq_ids: Vec<InstrSeqId> = Vec::with_capacity(arm_states.len());
        for state in arm_states {
            let original_ty = {
                let local = match &module.funcs.get(func_id).kind {
                    FunctionKind::Local(local) => local,
                    _ => continue,
                };
                local.block(state.arm.label).ty
            };
            let cap_ty = if state.arm.kind.is_plain() && state.arm.uses_exception_recipe {
                let mut results = match original_ty {
                    InstrSeqType::Simple(None) => Vec::new(),
                    InstrSeqType::Simple(Some(result)) => vec![result],
                    InstrSeqType::MultiValue(ty) => module.types.get(ty).results().to_vec(),
                };
                // Retarget a plain catch to CatchRef so the capture owns
                // the complete exception. The extra non-null exnref is
                // consumed by the synthetic tail and never reaches the
                // original plain handler.
                results.push(ValType::Ref(RefType {
                    nullable: false,
                    heap_type: HeapType::Abstract(AbstractHeapType::Exn),
                }));
                InstrSeqType::new(&mut module.types, &[], &results)
            } else {
                original_ty
            };
            let local = local_mut(module, func_id);
            cap_seq_ids.push(local.builder_mut().dangling_instr_seq(cap_ty).id());
        }

        // ----------------------------------------------------------
        // Rewrite every planned tagged arm to its activation capture.
        //
        // We map by arm position within `arm_states` -- each entry's
        // `arm.arm_idx` is the arm's index in the original try_table's
        // catches list before private-unwind shielding. Locate the live clause
        // by its original label/tag instead of indexing directly: shielding
        // inserts a private catch immediately before a user catch-all.
        // ----------------------------------------------------------
        let mut new_catches: Vec<TryTableCatch> = original_catches.clone();
        for (j, state) in arm_states.iter().enumerate() {
            let arm_idx = new_catches
                .iter()
                .position(|catch| match (state.arm.kind, catch) {
                    (TaggedCatchKind::Plain, TryTableCatch::Catch { tag, label })
                    | (TaggedCatchKind::Ref, TryTableCatch::CatchRef { tag, label }) => {
                        Some(*tag) == state.arm.tag && *label == state.arm.label
                    }
                    (TaggedCatchKind::AllPlain, TryTableCatch::CatchAll { label })
                    | (TaggedCatchKind::AllRef, TryTableCatch::CatchAllRef { label }) => {
                        *label == state.arm.label
                    }
                    _ => false,
                })
                .expect("planned user catch no longer exists after private shielding");
            if let Some(c) = new_catches.get_mut(arm_idx) {
                let replacement = match (state.arm.kind, &*c) {
                    (TaggedCatchKind::Plain, TryTableCatch::Catch { tag, .. })
                        if state.arm.uses_exception_recipe =>
                    {
                        TryTableCatch::CatchRef {
                            tag: *tag,
                            label: cap_seq_ids[j],
                        }
                    }
                    (TaggedCatchKind::Plain, TryTableCatch::Catch { tag, .. }) => {
                        TryTableCatch::Catch {
                            tag: *tag,
                            label: cap_seq_ids[j],
                        }
                    }
                    (TaggedCatchKind::Ref, TryTableCatch::CatchRef { tag, .. }) => {
                        TryTableCatch::CatchRef {
                            tag: *tag,
                            label: cap_seq_ids[j],
                        }
                    }
                    (TaggedCatchKind::AllPlain, TryTableCatch::CatchAll { .. }) => {
                        TryTableCatch::CatchAllRef {
                            label: cap_seq_ids[j],
                        }
                    }
                    (TaggedCatchKind::AllRef, TryTableCatch::CatchAllRef { .. }) => {
                        TryTableCatch::CatchAllRef {
                            label: cap_seq_ids[j],
                        }
                    }
                    _ => unreachable!("validated catch plan no longer matches try_table"),
                };
                *c = replacement;
            }
        }

        // ----------------------------------------------------------
        // Populate innermost cap (cap_seq_ids[N-1]):
        //   try_table(...)
        //   br $b1_outer
        // ----------------------------------------------------------
        //
        // D-06 fix (2026-05-14): emit_capture_save_and_branch's
        // "capture tail" (spill payload to frame locals, set flags,
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
        let n = arm_states.len();
        {
            let local = local_mut(module, func_id);
            let s = &mut local.block_mut(cap_seq_ids[n - 1]).instrs;
            push_instr(
                s,
                Instr::TryTable(TryTable {
                    seq: body_seq,
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
                cap_seq_ids[j],
                &arm_states[j + 1],
                catch_selector_local,
                region.retained_recipe_exnref,
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
            outer_seq_id,
            &arm_states[0],
            catch_selector_local,
            region.retained_recipe_exnref,
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
                .position(|(i, _)| matches!(i, Instr::TryTable(tt) if tt.seq == body_seq))
                .expect("try_table not found in its parent (B1 stage 2 emission)");
            parent_instrs[tt_idx].0 = Instr::Block(Block { seq: outer_seq_id });
        }
    }
}

/// Emit the capture-block tail for one tagged catch. The operand stack holds
/// `tag.params()` and, for CatchRef, a final exnref.
///
///   1. Temporarily pop CatchRef's exnref, then spill scalar operands.
///   2. Replace this activation's latest-catch selector with this exact arm.
///   4. Re-push operands and, for the user's CatchRef, the exnref.
///      Clear capture-only reference locals; retain a recipe-owned exception
///      until this activation no longer needs catch replay.
///   5. `br arm.label` (original handler).
fn emit_capture_save_and_branch(
    module: &mut Module,
    func_id: FunctionId,
    cap_seq_id: InstrSeqId,
    arm: &PlainCatchArmState,
    catch_selector_local: LocalId,
    retained_recipe_exnref: Option<LocalId>,
) {
    let local = local_mut(module, func_id);
    let s = &mut local.block_mut(cap_seq_id).instrs;

    // CatchRef appends exnref after the tag payload, so it is first off the
    // stack. A converted plain Catch also arrives here through CatchRef when
    // the typed Wasm codec must own a reference/v128-bearing payload.
    if let Some(captured_exnref) = arm.captured_exnref {
        push_instr(
            s,
            Instr::LocalSet(LocalSet {
                local: captured_exnref,
            }),
        );
    }

    // 1. Spill operands. Operands were declared L-to-R but appear on
    //    the stack with the LAST one on top — so we spill in reverse
    //    declaration order: spills[M-1] first, then [M-2], ..., [0].
    for i in (0..arm.operand_locals.len()).rev() {
        push_instr(
            s,
            Instr::LocalSet(LocalSet {
                local: arm.operand_locals[i],
            }),
        );
    }

    // 2. Record the dynamically latest catch for this activation.
    //
    // WHY: replay needs the most recently taken exception edge, not the
    // lexically last try_table that ever caught. A loop can execute region B
    // and later region A, and nested handlers can likewise supersede one
    // another. One activation-local selector naturally follows that dynamic
    // order and avoids both stale per-region markers and one native i32 local
    // per static try_table.
    push_instr(
        s,
        Instr::Const(Const {
            value: Value::I32(arm.selector as i32),
        }),
    );
    push_instr(
        s,
        Instr::LocalSet(LocalSet {
            local: catch_selector_local,
        }),
    );
    if !arm.arm.uses_exception_recipe {
        if let Some(retained_recipe_exnref) = retained_recipe_exnref {
            // WHY: a scalar catch has just superseded the only selector that
            // could name the previous complete-exception recipe. Clear the
            // function-wide slot before entering user code so the obsolete
            // exception is neither serialized nor retained as a hidden GC
            // root. Guest-visible references have independent typed owners.
            push_instr(
                s,
                Instr::RefNull(RefNull {
                    ty: RefType {
                        nullable: true,
                        heap_type: HeapType::Abstract(AbstractHeapType::Exn),
                    },
                }),
            );
            push_instr(
                s,
                Instr::LocalSet(LocalSet {
                    local: retained_recipe_exnref,
                }),
            );
        }
    }

    // 4. Re-push operands in declaration order.
    for (&operand, &ty) in arm.operand_locals.iter().zip(&arm.arm.operand_tys) {
        push_typed_local_get(s, operand, ty);
    }
    // Capture-only payload locals must not retain reference values as hidden
    // GC roots after the branch. The already-pushed handler operands remain on
    // the operand stack while these nullable storage locals are cleared.
    for (&operand, &ty) in arm.operand_locals.iter().zip(&arm.arm.operand_tys) {
        let ValType::Ref(mut reference) = ty else {
            continue;
        };
        reference.nullable = true;
        push_instr(s, Instr::RefNull(RefNull { ty: reference }));
        push_instr(s, Instr::LocalSet(LocalSet { local: operand }));
    }
    if arm.arm.kind.is_ref() {
        let captured_exnref = arm
            .captured_exnref
            .expect("CatchRef capture must own an exnref local");
        push_instr(
            s,
            Instr::LocalGet(LocalGet {
                local: captured_exnref,
            }),
        );
        push_instr(s, Instr::RefAsNonNull(RefAsNonNull {}));
    }
    if let Some(captured_exnref) = arm
        .captured_exnref
        .filter(|_| !arm.arm.uses_exception_recipe)
    {
        // Scalar CatchRef replay reconstructs from the tag/payload, so its
        // forwarding local is scratch and must not retain a stale exception.
        push_instr(
            s,
            Instr::RefNull(RefNull {
                ty: RefType {
                    nullable: true,
                    heap_type: HeapType::Abstract(AbstractHeapType::Exn),
                },
            }),
        );
        push_instr(
            s,
            Instr::LocalSet(LocalSet {
                local: captured_exnref,
            }),
        );
    }

    // 5. Branch to original handler.
    push_instr(
        s,
        Instr::Br(Br {
            block: arm.arm.label,
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
// Guard-dispatch was deleted after nested switch-dispatch absorbed structured
// carryovers and multi-value parameters. Fork-reachable legacy handlers are
// now normalized to activation-owned modern EH before this file runs. The
// trampoline scaffolding below remains unwired historical implementation.
//
// It was originally intended for three historical classes:
//   (a) Nested fork-path call inside a Loop/IfElse/TryTable body that
//       `classify_nested_pattern` could not type.
//   (b) Top-level fork-path call with operand-stack carryover.
//   (c) Nested call_indirect to a fork-path callee, in combination
//       with a carryover shape absent from the old typed model.
// Nested switch-dispatch now owns all three.
//
// Per-function dispatch table (open Q #3, resolved 2026-05-13):
// each instrumented fork-path function emits its own
// `(table $<fn>_post_table funcref)` populated with the extracted
// post-call functions for that function. Entry-point REWIND check
// does `call_indirect $<fn>_post_table (local.get $call_idx)`.
//
// State after sub-commit 2.2 (this commit): the function below is
// defined but UNREACHABLE — no caller exists. The body emission
// landed in 2.3; later sub-commits wired carryovers, call_indirect, and
// nested typed state one class at a time. Guard-dispatch has since been
// deleted.

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
    _catch_plan: &[CatchRegionPlan],
    _plain_catches: &[(InstrSeqId, Vec<PlainCatchArm>)],
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
// `Loop`, `TryTable`, or normalized legacy-handler body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NestedSupportStatus {
    Supported,
    /// Exhaustive stack effects disagreed with already-validated Wasm IR.
    /// This is an instrumenter invariant failure, never a source-shape policy.
    AnalysisInvariantFailed,
}

impl NestedSupportStatus {
    fn is_supported(self) -> bool {
        matches!(self, NestedSupportStatus::Supported)
    }
}

/// Verify that nested switch-dispatch can statically type every activation
/// carryover. Structured control, multi-value parameters, modern EH, and
/// normalized legacy handlers all use this path.
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

    // Direct fork-path call landings with operand-stack carryovers are
    // absorbed by per-call typed spill locals. Failure here means the
    // exhaustive stack model disagreed with validated IR.
    if compute_nested_carryover_types(module, func_id, fork_path).is_none() {
        return NestedSupportStatus::AnalysisInvariantFailed;
    }

    NestedSupportStatus::Supported
}

fn classify_seq(
    module: &Module,
    f: &LocalFunction,
    seq: InstrSeqId,
    fork_path: &HashSet<FunctionId>,
) -> NestedSupportStatus {
    if seq_stack_analysis_invariant_failed(module, f, seq) {
        return NestedSupportStatus::AnalysisInvariantFailed;
    }

    for (instr, _) in &f.block(seq).instrs {
        match instr {
            Instr::Loop(_) | Instr::Block(_) | Instr::IfElse(_) | Instr::TryTable(_) => {
                // Loops, blocks, ifs, and try_tables are handled by
                // per-block dispatch. For IfElse, the condition rewrite
                // selects between the original condition (NORMAL) and the
                // replay force flag. Catch handlers use activation-owned
                // selector/payload or complete-exception recipes.
            }
            Instr::Try(_) => {
                // Fork-reachable legacy handlers were converted to modern
                // try_table/catch_ref before this classifier runs. A surviving
                // legacy try can therefore only be a handler-free delegate,
                // whose body follows the ordinary nested-switch route.
            }
            _ => {}
        }
        for child in nested_seqs(instr) {
            // Multi-value SubRegion parameters use the same typed
            // `CarryoverPlan::spill_locals` machinery: spill at the chunk
            // tail and restore before entering the SubRegion.
            let status = classify_seq(module, f, child, fork_path);
            if !status.is_supported() {
                return status;
            }
        }
    }
    NestedSupportStatus::Supported
}

/// Check that the depth-only structured walk agrees with validated Wasm IR.
///
/// All carryover types—including references, GC values, EH references, and
/// multi-value parameters/results—are handled by the typed spill planners.
/// A `true` result here therefore signals an analyzer invariant failure, not a
/// source shape the instrumenter intentionally excludes.
fn seq_stack_analysis_invariant_failed(
    module: &Module,
    f: &LocalFunction,
    seq: InstrSeqId,
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
        match top_level_stack_effect(module, f, instr) {
            StackEffect::Delta { pops, pushes } => {
                if depth < pops {
                    return true;
                }
                depth = depth - pops + pushes;
            }
            StackEffect::Terminator => return false,
        }
    }
    false
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
/// Returns `None` only if the exhaustive producer model disagrees with
/// validated IR. Reference, GC, EH, and multi-value spill types are all
/// preserved exactly.
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
            Instr::CallRef(_) => true,
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

        // Advance the exact typed stack. Fork-path Call/CallIndirect/CallRef
        // pops args and pushes its declared result types.
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
            Instr::CallRef(call) => {
                let sig = module.types.get(call.ty);
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
                let produced = typed_instruction_pushes(module, f, instr, &pre_stack)?;
                if produced.len() != pushes {
                    return None;
                }
                stack.extend(produced.into_iter().map(Some));
            }
            StackEffect::Terminator => return Some(out),
        }
    }

    Some(out)
}

// --- Discovery: walk the function in DFS order, assigning call_idx --

#[derive(Debug, Clone, Copy)]
enum NestedTarget {
    Direct(FunctionId),
    Indirect { table: TableId },
    Ref,
}

#[derive(Debug, Clone)]
struct NestedCallSite {
    call_idx: u32,
    seq_id: InstrSeqId,
    target: NestedTarget,
    direct_activation: bool,
    sig_ty: TypeId,
    resume_ty: Option<TypeId>,
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
                    direct_activation: false,
                    sig_ty: module.funcs.get(c.func).ty(),
                    resume_ty: None,
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
                    direct_activation: false,
                    sig_ty: ci.ty,
                    resume_ty: None,
                    loc: *loc,
                });
                my_idxs.push(idx);
            }
            Instr::CallRef(call) => {
                let idx = *next_idx;
                *next_idx += 1;
                sites.push(NestedCallSite {
                    call_idx: idx,
                    seq_id: seq,
                    target: NestedTarget::Ref,
                    direct_activation: false,
                    sig_ty: call.ty,
                    resume_ty: None,
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

fn assert_nested_reference_call_alignment(
    analysis: &FunctionReferenceAnalysis,
    sites: &[NestedCallSite],
) {
    assert_eq!(
        analysis.call_sites.len(),
        sites.len(),
        "original reference analysis and nested transform discovered different call counts"
    );
    for (reference, site) in analysis.call_sites.iter().zip(sites) {
        let aligned = match (reference.kind, site.target) {
            (OriginalCallKind::Direct(expected), NestedTarget::Direct(actual)) => {
                expected == actual
            }
            (
                OriginalCallKind::Indirect {
                    table: expected_table,
                    ty: expected_ty,
                },
                NestedTarget::Indirect {
                    table: actual_table,
                },
            ) => expected_table == actual_table && expected_ty == site.sig_ty,
            (OriginalCallKind::Ref { ty }, NestedTarget::Ref) => ty == site.sig_ty,
            _ => false,
        };
        assert!(
            aligned,
            "reference analysis call {:?} does not align with nested target {:?}",
            reference.kind, site.target
        );
    }
}

// --- The main transform ----------------------------------------------

#[allow(clippy::too_many_arguments)]
fn instrument_one_function_nested_switch(
    module: &mut Module,
    func_id: FunctionId,
    runtime: &Runtime,
    activations: &HashSet<FunctionId>,
    fork_path: &HashSet<FunctionId>,
    func_ordinal: u32,
    catch_plan: &[CatchRegionPlan],
    plain_catches: &[(InstrSeqId, Vec<PlainCatchArm>)],
    reference_analysis: &FunctionReferenceAnalysis,
    unwind_frame_select: FunctionId,
) -> ResumeThunk {
    // Pre-existing user locals.
    let all_user_locals = collect_user_locals(module, func_id);
    let user_scalar_locals: Vec<(LocalId, ValType)> = all_user_locals
        .iter()
        .copied()
        .filter(|(_, ty)| is_scalar(*ty))
        .collect();

    // Discover all fork-path call sites (with assigned call_idxs in
    // DFS order) and the per-seq region info.
    let (mut sites, regions) = discover_calls_and_regions(module, func_id, fork_path);
    for site in &mut sites {
        site.direct_activation = matches!(
            site.target,
            NestedTarget::Direct(target) if activations.contains(&target)
        );
        let results = module.types.get(site.sig_ty).results().to_vec();
        site.resume_ty = Some(module.types.add(&[], &results));
    }
    assert_nested_reference_call_alignment(reference_analysis, &sites);
    let n_calls = sites.len();
    if n_calls == 0 {
        // Defensive: function should have at least one fork-path call
        // by virtue of being in fork_path. Bail out to existing
        // top-level switch-dispatch (which handles n_calls==0 cleanly).
        return instrument_one_function_switch(
            module,
            func_id,
            runtime,
            activations,
            fork_path,
            func_ordinal,
            catch_plan,
            plain_catches,
            reference_analysis,
            unwind_frame_select,
        );
    }

    // `HashMap` deliberately randomizes its iteration order. Keep one stable
    // sequence for every pass that allocates module locals or instruction
    // sequences from the region set; otherwise identical inputs can receive
    // different Walrus IDs and produce byte-different instrumented modules.
    let mut region_ids: Vec<InstrSeqId> = regions.keys().copied().collect();
    region_ids.sort();

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
    // frame. Side-effect-free argument tails are replayed after POST_K;
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
    // Classification already proved the exact typed stack model. Do not turn
    // a later analyzer disagreement into empty carryovers: that would silently
    // lose activation state.
    let nested_carryover_types: HashMap<u32, Vec<ValType>> =
        compute_nested_carryover_types(module, func_id, fork_path).unwrap_or_else(|| {
            panic!("typed nested carryover analysis changed after classification")
        });
    let mut carryover_spills: HashMap<u32, Vec<TypedSpillLocal>> = HashMap::new();
    for site in &sites {
        let cr_types: &[ValType] = nested_carryover_types
            .get(&site.call_idx)
            .map(Vec::as_slice)
            .unwrap_or_else(|| panic!("typed carryover plan omitted call {}", site.call_idx));
        let spills: Vec<TypedSpillLocal> = cr_types
            .iter()
            .map(|&ty| (module.locals.add(spill_storage_type(ty)), ty))
            .collect();
        carryover_spills.insert(site.call_idx, spills);
    }

    let plain_catch_state = allocate_plain_catch_state(module, plain_catches);

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
            if is_scalar(ty) {
                frame_scalars.push((lid, ty));
            }
        }
    }
    for site in &sites {
        for &(lid, ty) in &carryover_spills[&site.call_idx] {
            if is_scalar(ty) {
                frame_scalars.push((lid, ty));
            }
        }
    }
    // Synthetic locals.
    let catch_state_locals = if catch_plan.is_empty() && plain_catches.is_empty() {
        None
    } else {
        Some(CatchStateLocals {
            catch_selector: module.locals.add(ValType::I32),
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
        for &seq_id in &region_ids {
            let direct = direct_idxs_per_seq.get(&seq_id).unwrap_or(&empty_idxs);
            // The typed analyser captures both SubRegion parameters and extra
            // carryovers. An analysis failure here is an internal invariant;
            // defaulting to no spills would silently lose activation state.
            let spill_types = analyze_subregion_spill_types(
                module, local_ro, seq_id, fork_path, direct, &regions,
            )
            .unwrap_or_else(|| {
                panic!("typed SubRegion carryover analysis failed after classification")
            });
            let original = &local_ro.block(seq_id).instrs;
            let (chunks, landings) =
                partition_region_instrs(local_ro, original, direct, &regions, fork_path);
            assert_eq!(
                spill_types.len(),
                landings.len(),
                "typed SubRegion carryover analysis and landing partition disagree"
            );
            for (landing_idx, landing) in landings.iter().enumerate() {
                let types = &spill_types[landing_idx];
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
                        split_pure_replay_tail(module, &chunks[landing_idx], types)
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
                        let lid = module.locals.add(spill_storage_type(ty));
                        if is_scalar(ty) {
                            frame_scalars.push((lid, ty));
                        }
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
        for &seq_id in &region_ids {
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
                let lid = module.locals.add(spill_storage_type(ty));
                locals.push((lid, ty));
            }
            body_param_locals.insert(seq_id, locals);
        }
    }

    let locals_with_offsets = assign_local_offsets(&frame_scalars, LOCALS_START_OFFSET);
    let ordinary_scalar_end = HEADER_SIZE + user_locals_size(&frame_scalars);
    let catch_scalar_frame = plan_plain_catch_scalar_frame(&plain_catch_state, ordinary_scalar_end);
    let scalar_end = catch_scalar_frame.frame_end(ordinary_scalar_end);
    let mut per_call_references = vec![Vec::new(); n_calls];
    for site in &sites {
        let call_idx = site.call_idx as usize;
        arg_materializations[&site.call_idx]
            .append_reference_inputs(module, &mut per_call_references[call_idx]);
        for &(local, ty) in &carryover_spills[&site.call_idx] {
            if let Some(reference) = supported_reference(ty) {
                per_call_references[call_idx].push((local, reference));
            }
        }
    }
    {
        let local_ro = match &module.funcs.get(func_id).kind {
            FunctionKind::Local(local) => local,
            _ => unreachable!(),
        };
        let empty_idxs = Vec::new();
        for &seq_id in &region_ids {
            let direct = direct_idxs_per_seq.get(&seq_id).unwrap_or(&empty_idxs);
            let original = &local_ro.block(seq_id).instrs;
            let (_, landings) =
                partition_region_instrs(local_ro, original, direct, &regions, fork_path);
            for (landing_idx, landing) in landings.iter().enumerate() {
                let Some(CarryoverPlan::Spill { spill_locals }) =
                    carryover_plans.get(&(seq_id, landing_idx))
                else {
                    continue;
                };
                let (first, last) = match landing.kind {
                    LandingKind::SubRegion { range_lo, range_hi }
                    | LandingKind::SubRegionIfElse {
                        range_lo, range_hi, ..
                    } => (range_lo, range_hi),
                    LandingKind::DirectCall { .. } => continue,
                };
                for &(local, ty) in spill_locals {
                    let Some(reference) = supported_reference(ty) else {
                        continue;
                    };
                    for call_idx in first..=last {
                        per_call_references[call_idx as usize].push((local, reference));
                    }
                }
            }
        }
    }
    append_resume_parameter_references(module, func_id, &mut per_call_references);
    append_plain_catch_frame_references(&mut per_call_references, &plain_catch_state);
    let reference_frame = plan_reference_frame(module, reference_analysis, per_call_references);
    let frame_size = reference_frame.frame_end(scalar_end);

    let result_types: Vec<ValType> = {
        let ty_id = module.funcs.get(func_id).ty();
        module.types.get(ty_id).results().to_vec()
    };
    let restart_loop_ty = InstrSeqType::new(&mut module.types, &[], &result_types);

    let catch_handlers = plan_catch_handlers(catch_plan, &plain_catch_state);

    let memory = first_memory(module);
    let ptr_ty = runtime.buf_type;

    if !plain_catch_state.is_empty() {
        let catch_state =
            catch_state_locals.expect("tagged catch plan requires catch-state locals");
        inject_rewind_throw_stubs(
            module,
            func_id,
            runtime,
            catch_state.catch_selector,
            catch_plan,
            &plain_catch_state,
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
    let restart_loop = local.builder_mut().dangling_instr_seq(restart_loop_ty).id();
    let abort = AbortDispatch {
        restart_loop,
        frame_select: unwind_frame_select,
    };
    let catch_scalar_restore_dispatch = catch_state_locals.and_then(|catch_state| {
        build_plain_catch_scalar_dispatch(
            local,
            runtime,
            memory,
            ptr_ty,
            catch_state.catch_selector,
            &catch_scalar_frame,
            PlainCatchScalarIo::Restore,
        )
    });

    populate_preamble_then(
        local,
        preamble_then,
        runtime,
        memory,
        ptr_ty,
        catch_state_locals,
        &locals_with_offsets,
        catch_scalar_restore_dispatch,
        &reference_frame,
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
    let mut non_entry_regions: Vec<InstrSeqId> = region_ids
        .iter()
        .copied()
        .filter(|&s| s != entry_id)
        .collect();
    // Sort by depth (deepest first). Walrus doesn't expose depth
    // directly, so compute via parent-seq walk.
    let depth_map = compute_seq_depths(local, entry_id);
    non_entry_regions.sort_by_key(|s| {
        (
            std::cmp::Reverse(depth_map.get(s).copied().unwrap_or(0)),
            *s,
        )
    });

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
            frame_size,
            cond_swap_local,
            catch_state_locals,
            unwind_save,
            abort,
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
        frame_size,
        cond_swap_local,
        catch_state_locals,
        unwind_save,
        abort,
        &result_types,
    );

    // Build postamble — same as switch-dispatch.
    let mut postamble: Vec<(Instr, InstrLocId)> = Vec::new();
    let catch_scalar_save_dispatch = catch_state_locals.and_then(|catch_state| {
        build_plain_catch_scalar_dispatch(
            local,
            runtime,
            memory,
            ptr_ty,
            catch_state.catch_selector,
            &catch_scalar_frame,
            PlainCatchScalarIo::Save,
        )
    });
    let reference_save_dispatch =
        build_reference_save_dispatch(local, runtime, memory, ptr_ty, &reference_frame);
    populate_postamble(
        &mut postamble,
        runtime,
        memory,
        ptr_ty,
        catch_state_locals,
        &locals_with_offsets,
        catch_scalar_save_dispatch,
        reference_save_dispatch,
        frame_size,
        func_ordinal,
    );

    // Wrap entry block with [preamble-if-else, live-restart loop].
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
            op: BinaryOp::I32GeU,
        }),
    );
    push_instr(
        entry_seq,
        Instr::IfElse(IfElse {
            consequent: preamble_then,
            alternative: preamble_else,
        }),
    );
    push_instr(entry_seq, Instr::Loop(Loop { seq: restart_loop }));
    let restart_seq = &mut local.block_mut(restart_loop).instrs;
    push_instr(restart_seq, Instr::Block(Block { seq: unwind_save }));
    restart_seq.extend(postamble);

    // Tagged-catch capture emission runs after the nested body rebuild.
    if let Some(catch_state) = catch_state_locals {
        shield_private_unwind_from_user_catches(module, func_id, runtime);
        apply_plain_catch_handlers(
            module,
            func_id,
            catch_state.catch_selector,
            &plain_catch_state,
            &catch_handlers,
        );
    } else {
        debug_assert!(plain_catches.is_empty());
        shield_private_unwind_from_user_catches(module, func_id, runtime);
    }

    ResumeThunk {
        func_ordinal,
        function: emit_resume_thunk(
            module,
            func_id,
            runtime,
            memory,
            ptr_ty,
            frame_size,
            &locals_with_offsets,
            &reference_frame,
            func_ordinal,
        ),
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
    carryover_spills: &HashMap<u32, Vec<TypedSpillLocal>>,
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
            let empty: Vec<TypedSpillLocal> = Vec::new();
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
    match site.target {
        NestedTarget::Indirect { .. } => arg_types.push(ValType::I32),
        NestedTarget::Ref => arg_types.push(ValType::Ref(RefType::FUNCREF)),
        NestedTarget::Direct(_) => {}
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
    carryover_spills: &HashMap<u32, Vec<TypedSpillLocal>>,
    carryover_plans: &HashMap<(InstrSeqId, usize), CarryoverPlan>,
    catch_handlers: &[CatchHandlerInfo],
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    frame_size: u32,
    cond_swap_local: LocalId,
    catch_state_locals: Option<CatchStateLocals>,
    unwind_save: InstrSeqId,
    abort: AbortDispatch,
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
        for &(local, ty) in body_param_locals {
            push_typed_local_get(&mut prefix, local, ty);
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
        frame_size,
        cond_swap_local,
        catch_state_locals,
        unwind_save,
        abort,
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
    carryover_spills: &HashMap<u32, Vec<TypedSpillLocal>>,
    carryover_plans: &HashMap<(InstrSeqId, usize), CarryoverPlan>,
    catch_handlers: &[CatchHandlerInfo],
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    frame_size: u32,
    cond_swap_local: LocalId,
    catch_state_locals: Option<CatchStateLocals>,
    unwind_save: InstrSeqId,
    abort: AbortDispatch,
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
        frame_size,
        cond_swap_local,
        catch_state_locals,
        unwind_save,
        abort,
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
            Instr::CallRef(_) => true,
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
            op: BinaryOp::I32GeU,
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
    carryover_spills: &HashMap<u32, Vec<TypedSpillLocal>>,
    catch_handlers: &[CatchHandlerInfo],
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    frame_size: u32,
    cond_swap_local: LocalId,
    catch_state_locals: Option<CatchStateLocals>,
    unwind_save: InstrSeqId,
    abort: AbortDispatch,
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
            frame_size,
            cond_swap_local,
            catch_state_locals,
            unwind_save,
            abort,
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
        frame_size,
        cond_swap_local,
        catch_state_locals,
        unwind_save,
        abort,
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
    carryover_spills: &HashMap<u32, Vec<TypedSpillLocal>>,
    _catch_handlers: &[CatchHandlerInfo],
    runtime: &Runtime,
    memory: MemoryId,
    ptr_ty: ValType,
    frame_size: u32,
    cond_swap_local: LocalId,
    _catch_state_locals: Option<CatchStateLocals>,
    unwind_save: InstrSeqId,
    abort: AbortDispatch,
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
            let empty: Vec<TypedSpillLocal> = Vec::new();
            let carryovers = carryover_spills.get(call_idx).unwrap_or(&empty);
            {
                let s = &mut local.block_mut(seq_id).instrs;
                for &(local, ty) in carryovers {
                    push_typed_local_get(s, local, ty);
                }
            }
            let target = match site.target {
                NestedTarget::Direct(func) => CallTarget::Direct(func),
                NestedTarget::Indirect { table } => CallTarget::Indirect { table },
                NestedTarget::Ref => CallTarget::Ref,
            };
            emit_replay_routed_call_with_unwind_boundary(
                local,
                seq_id,
                target,
                site.direct_activation,
                site.sig_ty,
                site.resume_ty
                    .expect("nested call site resume type was not assigned"),
                site.loc,
                &arg_materializations[call_idx],
                *call_idx,
                runtime,
                memory,
                ptr_ty,
                frame_size,
                unwind_save,
                abort,
            );
            // The statically scoped private-tag boundary records this exact
            // call before any result becomes visible to the continuation.
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
                        for &(local, ty) in spill_locals {
                            push_typed_local_get(s, local, ty);
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
                    for &(local, ty) in spill_locals.iter().take(spill_locals.len() - 1) {
                        push_typed_local_get(s, local, ty);
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
                    op: BinaryOp::I32GeU,
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
    fn compute_carryover_types_preserves_reference_for_validation() {
        // A reference producer's value is the carryover at a fork-path call.
        // Preserve the exact type so the activation recipe planner can assign
        // its codec class and call-specific vector ownership.
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
        assert_eq!(result, Some(vec![vec![ValType::Ref(RefType::EXTERNREF)]]));
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
