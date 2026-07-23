//! Injects the state-machine runtime into a module.
//!
//! This is "the infrastructure" that every fork-instrumented module
//! needs, independent of *which* functions end up instrumented:
//!
//! - Two mutable globals: `_wpk_fork_state` (i32) and `_wpk_fork_buf`
//!   (i32 for wasm32, i64 for wasm64).
//! - Seven exported control functions: `wpk_fork_unwind_begin`,
//!   `wpk_fork_unwind_end`, `wpk_fork_rewind_begin`,
//!   `wpk_fork_rewind_end`, `wpk_fork_abort_begin`,
//!   `wpk_fork_abort_end`, and `wpk_fork_state`.
//! - In the ABI 42 linked format, three host imports that reserve, commit, and
//!   replay variable-sized frame nodes.
//!
//! ## Phase 4e additions: saved-globals area
//!
//! To fork correctly, the child process's Wasm instance must see the
//! same mutable globals as the parent at fork time. `wpk_fork_unwind_begin`
//! takes a snapshot of every pre-existing mutable *scalar* global
//! into the root chunk's fixed prefix, and `wpk_fork_rewind_begin` reloads it. The
//! two runtime-owned globals (`_wpk_fork_state`, `_wpk_fork_buf`) are
//! excluded: they are set explicitly by each begin function to the
//! known transition values.
//!
//! Ref-typed mutable globals (funcref/externref/exnref) require
//! auxiliary tables (Phase 4f); this phase skips them.
//!
//! Module-prefix layout (all offsets byte-exact; `P` is pointer width —
//! 4 bytes on wasm32, 8 on wasm64; `B` is the B1 plain-catch scratch
//! reservation, 0 when no fork-path function has a plain catch):
//!
//! ```text
//! +0          P     active_frame       Current frame payload during save/replay
//! +P          P     reserved           Reserved pointer word
//! +2P         N     saved_globals[]    Mutable scalar globals, declaration order
//! +2P+N       B     b1_scratch[]       Per-arm scratch tuples (Stage 1 B1)
//! +2P+N+B     16    abort_selector     Live-frame call-site selector
//! ```
//!
//! `frames_start_offset` in [`Runtime`] exposes the abort-selector offset
//! `2P + N + B`; `fixed_prefix_size` includes the following 16 bytes. In the
//! linked runtime, frame payloads live after per-node headers in host-managed
//! chunks rather than directly after this prefix.
//! `b1_scratch_base` exposes `2P + N` (== `frames_start_offset` when
//! `B == 0`) and `b1_scratch_size` exposes `B` (rounded up to 8).

use walrus::{
    ConstExpr, FunctionBuilder, FunctionId, GlobalId, InstrSeqBuilder, MemoryId, Module, ValType,
    ir::{BinaryOp, LoadKind, MemArg, StoreKind, Value},
};

/// State machine values: must agree with the contract in
/// `docs/plans/2026-04-20-fork-instrumentation-design.md`.
pub const STATE_NORMAL: i32 = 0;
pub const STATE_UNWINDING: i32 = 1;
pub const STATE_REWINDING: i32 = 2;
pub const STATE_ABORT_UNWINDING: i32 = 3;
pub const ABORT_SELECTOR_SIZE: u32 = 16;

/// Names for the runtime globals and exported control functions.
/// Centralized so the rest of the crate doesn't hardcode spellings.
pub mod names {
    pub const GLOBAL_STATE: &str = "_wpk_fork_state";
    pub const GLOBAL_BUF: &str = "_wpk_fork_buf";

    pub const EXPORT_UNWIND_BEGIN: &str = wasm_posix_shared::abi::WPK_FORK_EXPORT_UNWIND_BEGIN;
    pub const EXPORT_UNWIND_END: &str = wasm_posix_shared::abi::WPK_FORK_EXPORT_UNWIND_END;
    pub const EXPORT_REWIND_BEGIN: &str = wasm_posix_shared::abi::WPK_FORK_EXPORT_REWIND_BEGIN;
    pub const EXPORT_REWIND_END: &str = wasm_posix_shared::abi::WPK_FORK_EXPORT_REWIND_END;
    pub const EXPORT_ABORT_BEGIN: &str = wasm_posix_shared::abi::WPK_FORK_EXPORT_ABORT_BEGIN;
    pub const EXPORT_ABORT_END: &str = wasm_posix_shared::abi::WPK_FORK_EXPORT_ABORT_END;
    pub const EXPORT_STATE: &str = wasm_posix_shared::abi::WPK_FORK_EXPORT_STATE;

    pub const IMPORT_FRAME_RESERVE: &str = wasm_posix_shared::abi::WPK_FORK_FRAME_IMPORT_RESERVE;
    pub const IMPORT_FRAME_COMMIT: &str = wasm_posix_shared::abi::WPK_FORK_FRAME_IMPORT_COMMIT;
    pub const IMPORT_FRAME_NEXT: &str = wasm_posix_shared::abi::WPK_FORK_FRAME_IMPORT_NEXT;
}

/// Metadata about a saved mutable global.
#[derive(Debug, Clone, Copy)]
pub struct SavedGlobal {
    pub id: GlobalId,
    pub ty: ValType,
    /// Byte offset from the save-buffer base.
    pub offset: u32,
}

/// Handles to the runtime primitives we injected. Returned from
/// [`inject_runtime`] so later instrumentation phases can reference
/// the globals and exported functions without re-looking-them-up.
#[derive(Debug, Clone)]
pub struct Runtime {
    pub state_global: GlobalId,
    pub buf_global: GlobalId,
    pub buf_type: ValType,

    pub unwind_begin: FunctionId,
    pub unwind_end: FunctionId,
    pub rewind_begin: FunctionId,
    pub rewind_end: FunctionId,
    pub abort_begin: FunctionId,
    pub abort_end: FunctionId,
    pub state: FunctionId,

    /// Host-managed linked-frame hooks. All three are present together for
    /// the scalable format and absent for the legacy contiguous format.
    pub frame_reserve: Option<FunctionId>,
    pub frame_commit: Option<FunctionId>,
    pub frame_next: Option<FunctionId>,

    /// Mutable scalar globals that `wpk_fork_unwind_begin` snapshots
    /// and `wpk_fork_rewind_begin` restores. Declaration order.
    pub saved_globals: Vec<SavedGlobal>,

    /// Offset of the linked runtime's abort selector. Includes any space
    /// reserved for B1's plain-catch scratch area
    /// (see `b1_scratch_base` / `b1_scratch_size`).
    /// `wpk_fork_unwind_begin` adds the module-buffer base to this value for
    /// the initial active-frame word. Linked postambles replace that word with
    /// the payload returned by the reserve hook before writing any frame data.
    pub frames_start_offset: u32,

    /// Host-visible fixed prefix. Linked runtimes reserve one selector-sized
    /// area after `frames_start_offset` for the still-live activation that
    /// reverses a failed partial unwind.
    pub fixed_prefix_size: u32,

    /// Stage 1 (B1): byte offset at which the plain-catch scratch
    /// area begins. Equals `2P + N` (header + saved_globals).
    pub b1_scratch_base: u32,
    /// Stage 1 (B1): bytes reserved for the plain-catch scratch area.
    /// Zero when no fork-path function in the module has a plain catch.
    /// `b1_scratch_base + b1_scratch_size == frames_start_offset`.
    pub b1_scratch_size: u32,
}

/// Return the pointer type appropriate for the module's primary
/// memory: `i64` if the memory is declared memory64, `i32` otherwise.
///
/// If the module has no memory at all, default to `i32`.
fn ptr_type(module: &Module) -> ValType {
    let default_memory = module.memories.iter().next();
    match default_memory {
        Some(mem) if mem.memory64 => ValType::I64,
        _ => ValType::I32,
    }
}

fn ptr_align(ptr_ty: ValType) -> u32 {
    match ptr_ty {
        ValType::I32 => 4,
        ValType::I64 => 8,
        _ => unreachable!(),
    }
}

fn scalar_size(ty: ValType) -> u32 {
    match ty {
        ValType::I32 | ValType::F32 => 4,
        ValType::I64 | ValType::F64 => 8,
        ValType::V128 => 16,
        ValType::Ref(_) => panic!("scalar_size on ref type"),
    }
}

fn zero_const(ptr_ty: ValType) -> ConstExpr {
    match ptr_ty {
        ValType::I32 => ConstExpr::Value(Value::I32(0)),
        ValType::I64 => ConstExpr::Value(Value::I64(0)),
        other => panic!("unsupported pointer type for fork buf: {other:?}"),
    }
}

/// Injects the state-machine globals, control functions, and — when
/// the module has linear memory — the per-global save/restore
/// machinery in `wpk_fork_unwind_begin` / `wpk_fork_rewind_begin`.
///
/// `b1_scratch_size` is the number of bytes B1 (Stage 1 plain-catch
/// scratch area) needs reserved between `saved_globals` and
/// `frame data` in the save buffer. It is zero when no fork-path
/// function in the module has a plain catch — preserving byte-identical
/// behavior to pre-B1 for modules that don't exercise the feature.
/// The value is rounded up to 8-byte alignment internally so frame
/// data starts aligned regardless of saved-globals payload size.
///
/// **Why a parameter and not a setter:** `frames_start_offset` gets
/// baked into `wpk_fork_unwind_begin`'s body as a constant during this
/// call (see step 3 in [`emit_unwind_begin`]). Shifting the offset
/// after `inject_runtime` returns would silently desync the const and
/// the host-visible offset. Computing the B1 plan first and passing
/// the size in keeps everything consistent.
pub fn inject_runtime(module: &mut Module, b1_scratch_size: u32) -> Runtime {
    inject_runtime_with_frame_storage(module, b1_scratch_size, false)
}

pub fn inject_linked_runtime(module: &mut Module, b1_scratch_size: u32) -> Runtime {
    inject_runtime_with_frame_storage(module, b1_scratch_size, true)
}

fn inject_runtime_with_frame_storage(
    module: &mut Module,
    b1_scratch_size: u32,
    linked_frames: bool,
) -> Runtime {
    let ptr_ty = ptr_type(module);
    let memory = module.memories.iter().next().map(|m| m.id());

    // --- Saveable globals scan ---
    //
    // Capture mutable scalar globals *before* adding our two runtime
    // globals so we don't snapshot them.
    //
    // Buffer header (for both wasm32 and wasm64):
    //   +0     P    current_pos
    //   +P     P    end_pos
    //   +2P    ...  saved_globals
    let header_size = 2 * ptr_align(ptr_ty);
    let mut saved_globals: Vec<SavedGlobal> = Vec::new();
    let mut next_off = header_size;
    for g in module.globals.iter() {
        if !g.mutable {
            continue;
        }
        if matches!(g.ty, ValType::Ref(_)) {
            // Ref-typed globals need auxiliary tables (Phase 4f).
            continue;
        }
        if matches!(g.kind, walrus::GlobalKind::Import(_)) {
            // Imported globals are host-managed and per-instance. The host
            // creates a fresh `WebAssembly.Global` for each process (e.g.
            // `env.__channel_base` gets the child's channel offset, not the
            // parent's). Overwriting them from the parent's fork buffer
            // would corrupt cross-process isolation — the child would end
            // up making syscalls against the parent's channel region.
            continue;
        }
        saved_globals.push(SavedGlobal {
            id: g.id(),
            ty: g.ty,
            offset: next_off,
        });
        next_off += scalar_size(g.ty);
    }
    // B1 plain-catch scratch area sits between saved_globals and
    // frame data. When `b1_scratch_size == 0` (the common case for
    // modules without plain-catch fork) this is a no-op and
    // `frames_start_offset` is byte-identical to pre-B1.
    let b1_scratch_base = next_off;
    let aligned_b1_size = align_up_8(b1_scratch_size);
    let frames_start_offset = b1_scratch_base + aligned_b1_size;
    let fixed_prefix_size = frames_start_offset
        + if linked_frames {
            ABORT_SELECTOR_SIZE
        } else {
            0
        };
    // Invariant: `b1_scratch_base + b1_scratch_size == frames_start_offset`
    // holds by construction here — `frames_start_offset` is defined as
    // the sum on the previous line, and `b1_scratch_size` is stored as
    // `aligned_b1_size`. This is documented in the `Runtime` struct doc
    // and the leading buffer-layout comment block; we don't enforce it
    // via debug_assert! because any check using the same locals is
    // tautological, and a stronger check (e.g., 8-alignment of
    // `frames_start_offset`) doesn't hold for all currently-shipping
    // modules — the pre-B1 code already permits non-aligned values
    // because wasm tolerates unaligned i64 stores.

    // --- Runtime globals (state + buf) ---
    let state_global = module.globals.add_local(
        ValType::I32,
        /* mutable */ true,
        /* shared */ false,
        ConstExpr::Value(Value::I32(STATE_NORMAL)),
    );
    let buf_global = module.globals.add_local(
        ptr_ty,
        /* mutable */ true,
        /* shared */ false,
        zero_const(ptr_ty),
    );

    let (frame_reserve, frame_commit, frame_next) = if linked_frames {
        let reserve_ty = module.types.add(&[ptr_ty], &[ptr_ty]);
        let commit_ty = module.types.add(&[ptr_ty], &[]);
        let next_ty = module.types.add(&[ptr_ty], &[ptr_ty]);
        let import_module = wasm_posix_shared::abi::WPK_FORK_FRAME_IMPORT_MODULE;
        let (reserve, _) =
            module.add_import_func(import_module, names::IMPORT_FRAME_RESERVE, reserve_ty);
        let (commit, _) =
            module.add_import_func(import_module, names::IMPORT_FRAME_COMMIT, commit_ty);
        let (next, _) = module.add_import_func(import_module, names::IMPORT_FRAME_NEXT, next_ty);
        (Some(reserve), Some(commit), Some(next))
    } else {
        (None, None, None)
    };

    // --- Control functions ---
    let unwind_begin = emit_unwind_begin(
        module,
        ptr_ty,
        state_global,
        buf_global,
        memory,
        &saved_globals,
        frames_start_offset,
    );
    let unwind_end = emit_end_fn(module, state_global);
    let rewind_begin = emit_rewind_begin(
        module,
        ptr_ty,
        state_global,
        buf_global,
        memory,
        &saved_globals,
        STATE_REWINDING,
    );
    let rewind_end = emit_end_fn(module, state_global);
    let abort_begin = emit_rewind_begin(
        module,
        ptr_ty,
        state_global,
        buf_global,
        memory,
        &saved_globals,
        STATE_ABORT_UNWINDING,
    );
    let abort_end = emit_end_fn(module, state_global);
    let state = emit_state_fn(module, state_global);

    // --- Exports ---
    module.exports.add(names::EXPORT_UNWIND_BEGIN, unwind_begin);
    module.exports.add(names::EXPORT_UNWIND_END, unwind_end);
    module.exports.add(names::EXPORT_REWIND_BEGIN, rewind_begin);
    module.exports.add(names::EXPORT_REWIND_END, rewind_end);
    module.exports.add(names::EXPORT_ABORT_BEGIN, abort_begin);
    module.exports.add(names::EXPORT_ABORT_END, abort_end);
    module.exports.add(names::EXPORT_STATE, state);

    module.globals.get_mut(state_global).name = Some(names::GLOBAL_STATE.into());
    module.globals.get_mut(buf_global).name = Some(names::GLOBAL_BUF.into());
    module.funcs.get_mut(unwind_begin).name = Some(names::EXPORT_UNWIND_BEGIN.into());
    module.funcs.get_mut(unwind_end).name = Some(names::EXPORT_UNWIND_END.into());
    module.funcs.get_mut(rewind_begin).name = Some(names::EXPORT_REWIND_BEGIN.into());
    module.funcs.get_mut(rewind_end).name = Some(names::EXPORT_REWIND_END.into());
    module.funcs.get_mut(abort_begin).name = Some(names::EXPORT_ABORT_BEGIN.into());
    module.funcs.get_mut(abort_end).name = Some(names::EXPORT_ABORT_END.into());
    module.funcs.get_mut(state).name = Some(names::EXPORT_STATE.into());

    Runtime {
        state_global,
        buf_global,
        buf_type: ptr_ty,
        unwind_begin,
        unwind_end,
        rewind_begin,
        rewind_end,
        abort_begin,
        abort_end,
        state,
        frame_reserve,
        frame_commit,
        frame_next,
        saved_globals,
        frames_start_offset,
        fixed_prefix_size,
        b1_scratch_base,
        b1_scratch_size: aligned_b1_size,
    }
}

/// Emit `wpk_fork_unwind_begin(buf: ptr) -> ()`:
/// 1. `_wpk_fork_state := UNWINDING`
/// 2. `_wpk_fork_buf := buf`
/// 3. `*(buf + 0) := buf + frames_start_offset` — seed the active-frame word;
///    linked postambles replace it with each reserved payload address.
/// 4. For each saved global `g` at offset `off`:
///        `*(buf + off) = g`
///
/// The global snapshot must happen *after* buf is written, since the
/// store addresses come from the buf global we just set. Reading
/// `__stack_pointer` / `__tls_base` inside our tiny body is safe —
/// we never touch the shadow stack here.
fn emit_unwind_begin(
    module: &mut Module,
    ptr_ty: ValType,
    state_global: GlobalId,
    buf_global: GlobalId,
    memory: Option<MemoryId>,
    saved_globals: &[SavedGlobal],
    frames_start_offset: u32,
) -> FunctionId {
    let mut builder = FunctionBuilder::new(&mut module.types, &[ptr_ty], &[]);
    let buf_param = module.locals.add(ptr_ty);

    {
        let mut body = builder.func_body();
        body.i32_const(STATE_UNWINDING)
            .global_set(state_global)
            .local_get(buf_param)
            .global_set(buf_global);

        if let Some(mem) = memory {
            // Step 3: seed the active-frame word at buf + 0. The linked
            // emitter overwrites it with the host-reserved payload before any
            // frame write; legacy direct-runtime tests retain cursor behavior.
            body.local_get(buf_param);
            match ptr_ty {
                ValType::I32 => {
                    body.local_get(buf_param)
                        .i32_const(frames_start_offset as i32)
                        .binop(BinaryOp::I32Add);
                }
                ValType::I64 => {
                    body.local_get(buf_param)
                        .i64_const(frames_start_offset as i64)
                        .binop(BinaryOp::I64Add);
                }
                other => unreachable!("unsupported ptr_ty: {other:?}"),
            }
            body.store(
                mem,
                store_kind_for(ptr_ty),
                MemArg {
                    align: ptr_align(ptr_ty),
                    offset: 0,
                },
            );

            // Step 4: snapshot mutable scalar globals into the buffer.
            emit_save_globals(&mut body, mem, buf_global, ptr_ty, saved_globals);
        }
    }
    builder.finish(vec![buf_param], &mut module.funcs)
}

/// Emit `wpk_fork_rewind_begin(buf: ptr) -> ()`:
/// 1. `_wpk_fork_state := REWINDING`
/// 2. `_wpk_fork_buf := buf`
/// 3. For each saved global `g` at offset `off`:
///        `g := *(buf + off)`
///
/// Subtle: restoring `__stack_pointer` mid-function is safe only
/// because this function uses no shadow-stack storage itself (no
/// address-taken locals, no aggregates). The restored value takes
/// effect for callers that return *into* rewind_begin's caller,
/// which is the host — not user code.
fn emit_rewind_begin(
    module: &mut Module,
    ptr_ty: ValType,
    state_global: GlobalId,
    buf_global: GlobalId,
    memory: Option<MemoryId>,
    saved_globals: &[SavedGlobal],
    state: i32,
) -> FunctionId {
    let mut builder = FunctionBuilder::new(&mut module.types, &[ptr_ty], &[]);
    let buf_param = module.locals.add(ptr_ty);

    {
        let mut body = builder.func_body();
        body.i32_const(state)
            .global_set(state_global)
            .local_get(buf_param)
            .global_set(buf_global);

        if let Some(mem) = memory {
            emit_restore_globals(&mut body, mem, buf_global, ptr_ty, saved_globals);
        }
    }
    builder.finish(vec![buf_param], &mut module.funcs)
}

/// For each global `g` at offset `off`, push:
///     global.get $buf, global.get $g, i{32,64,...}.store offset=off
fn emit_save_globals(
    body: &mut InstrSeqBuilder<'_>,
    memory: MemoryId,
    buf_global: GlobalId,
    _ptr_ty: ValType,
    saved_globals: &[SavedGlobal],
) {
    for sg in saved_globals {
        body.global_get(buf_global).global_get(sg.id).store(
            memory,
            store_kind_for(sg.ty),
            MemArg {
                align: natural_align(sg.ty),
                offset: sg.offset as u64,
            },
        );
    }
}

/// For each global `g` at offset `off`, push:
///     global.get $buf, i{32,64,...}.load offset=off, global.set $g
fn emit_restore_globals(
    body: &mut InstrSeqBuilder<'_>,
    memory: MemoryId,
    buf_global: GlobalId,
    _ptr_ty: ValType,
    saved_globals: &[SavedGlobal],
) {
    for sg in saved_globals {
        body.global_get(buf_global)
            .load(
                memory,
                load_kind_for(sg.ty),
                MemArg {
                    align: natural_align(sg.ty),
                    offset: sg.offset as u64,
                },
            )
            .global_set(sg.id);
    }
}

fn load_kind_for(ty: ValType) -> LoadKind {
    match ty {
        ValType::I32 => LoadKind::I32 { atomic: false },
        ValType::I64 => LoadKind::I64 { atomic: false },
        ValType::F32 => LoadKind::F32,
        ValType::F64 => LoadKind::F64,
        ValType::V128 => LoadKind::V128,
        ValType::Ref(_) => panic!("load_kind_for on ref type"),
    }
}

fn store_kind_for(ty: ValType) -> StoreKind {
    match ty {
        ValType::I32 => StoreKind::I32 { atomic: false },
        ValType::I64 => StoreKind::I64 { atomic: false },
        ValType::F32 => StoreKind::F32,
        ValType::F64 => StoreKind::F64,
        ValType::V128 => StoreKind::V128,
        ValType::Ref(_) => panic!("store_kind_for on ref type"),
    }
}

fn natural_align(ty: ValType) -> u32 {
    scalar_size(ty)
}

/// Round `x` up to the nearest 8-byte boundary. Mirrors the helper
/// in `instrument.rs`; kept private here to avoid widening visibility
/// for a one-line helper. A future cleanup pass can consolidate.
fn align_up_8(x: u32) -> u32 {
    (x + 7) & !7u32
}

/// Emit a `() -> ()` function that resets state to NORMAL.
fn emit_end_fn(module: &mut Module, state_global: GlobalId) -> FunctionId {
    let mut builder = FunctionBuilder::new(&mut module.types, &[], &[]);
    builder
        .func_body()
        .i32_const(STATE_NORMAL)
        .global_set(state_global);
    builder.finish(vec![], &mut module.funcs)
}

/// Emit a `() -> i32` function that returns the current state.
fn emit_state_fn(module: &mut Module, state_global: GlobalId) -> FunctionId {
    let mut builder = FunctionBuilder::new(&mut module.types, &[], &[ValType::I32]);
    builder.func_body().global_get(state_global);
    builder.finish(vec![], &mut module.funcs)
}
