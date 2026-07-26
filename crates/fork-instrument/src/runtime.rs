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
//! - In the ABI 42+ linked format, three host imports that reserve, commit, and
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
//! Mutable reference globals are deliberately absent from this scalar prefix.
//! ABI 43 emits activation-local module-state helpers that encode them into
//! the process reference graph during capture and reconstruct them in each
//! fresh child instance before continuation replay.
//!
//! Module-prefix layout (all offsets byte-exact; `P` is pointer width —
//! 4 bytes on wasm32 and 8 on wasm64):
//!
//! ```text
//! +0          P     active_frame       Current frame payload during save/replay
//! +P          P     reserved           Reserved pointer word
//! +2P         N     saved_globals[]    Mutable scalar globals, declaration order
//! +2P+N    16    abort_selector     Live-frame call-site selector
//! ```
//!
//! `frames_start_offset` in [`Runtime`] exposes the abort-selector offset
//! `2P + N`; `fixed_prefix_size` includes the following 16 bytes. In the
//! linked runtime, frame payloads live after per-node headers in host-managed
//! chunks rather than directly after this prefix.

use walrus::{
    AbstractHeapType, ConstExpr, FunctionBuilder, FunctionId, GlobalId, HeapType, InstrSeqBuilder,
    MemoryId, Module, RefType, TableId, TagId, ValType,
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
    pub const IMPORT_FRAME_PEEK: &str = wasm_posix_shared::abi::WPK_FORK_FRAME_IMPORT_PEEK;
    pub const IMPORT_RESUME_PEEK: &str = wasm_posix_shared::abi::WPK_FORK_RESUME_IMPORT_PEEK;
    pub const IMPORT_RESUME_TABLE: &str = wasm_posix_shared::abi::WPK_FORK_RESUME_IMPORT_TABLE;
    pub const IMPORT_REFERENCE_VECTOR_BEGIN: &str =
        wasm_posix_shared::abi::WPK_FORK_REFERENCE_IMPORT_VECTOR_BEGIN;
    pub const IMPORT_REFERENCE_VECTOR_APPEND: &str =
        wasm_posix_shared::abi::WPK_FORK_REFERENCE_IMPORT_VECTOR_APPEND;
    pub const IMPORT_REFERENCE_VECTOR_FINISH: &str =
        wasm_posix_shared::abi::WPK_FORK_REFERENCE_IMPORT_VECTOR_FINISH;
    pub const IMPORT_REFERENCE_VECTOR_GET: &str =
        wasm_posix_shared::abi::WPK_FORK_REFERENCE_IMPORT_VECTOR_GET;

    /// Process-owned zero-payload tag used only to transport the internal
    /// unwind across arbitrary Wasm result types.
    pub const IMPORT_UNWIND_TAG_MODULE: &str = "env";
    pub const IMPORT_UNWIND_TAG: &str = "__wpk_fork_unwind";

    /// Activation-owned reference recipe codecs. Encoders return a numeric
    /// recipe ID that can be stored in linear memory; decoders resolve that ID
    /// against the fresh child's reconstruction arena.
    pub const IMPORT_REFERENCE_CODEC_MODULE: &str =
        wasm_posix_shared::abi::WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE;
    pub const IMPORT_REF_ENCODE_FUNCREF: &str =
        wasm_posix_shared::abi::WPK_FORK_REFERENCE_IMPORT_ENCODE_FUNCREF;
    pub const IMPORT_REF_DECODE_FUNCREF: &str =
        wasm_posix_shared::abi::WPK_FORK_REFERENCE_IMPORT_DECODE_FUNCREF;
    pub const IMPORT_REF_ENCODE_EXTERNREF: &str =
        wasm_posix_shared::abi::WPK_FORK_REFERENCE_IMPORT_ENCODE_EXTERNREF;
    pub const IMPORT_REF_DECODE_EXTERNREF: &str =
        wasm_posix_shared::abi::WPK_FORK_REFERENCE_IMPORT_DECODE_EXTERNREF;
    pub const IMPORT_REF_ENCODE_EXNREF: &str =
        wasm_posix_shared::abi::WPK_FORK_REFERENCE_IMPORT_ENCODE_EXNREF;
    pub const IMPORT_REF_DECODE_EXNREF: &str =
        wasm_posix_shared::abi::WPK_FORK_REFERENCE_IMPORT_DECODE_EXNREF;
    pub const IMPORT_REF_ENCODE_ANYREF: &str =
        wasm_posix_shared::abi::WPK_FORK_REFERENCE_IMPORT_ENCODE_ANYREF;
    pub const IMPORT_REF_DECODE_ANYREF: &str =
        wasm_posix_shared::abi::WPK_FORK_REFERENCE_IMPORT_DECODE_ANYREF;
}

/// The four disjoint WebAssembly reference hierarchies used by the recipe
/// provider. Concrete function references travel through `funcref`; concrete
/// struct/array references travel through `anyref` and are cast back to their
/// exact guest type after decoding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReferenceCodecClass {
    Func,
    Extern,
    Exn,
    Any,
}

impl ReferenceCodecClass {
    pub fn of(module: &Module, reference: RefType) -> Self {
        match reference.heap_type {
            HeapType::Abstract(AbstractHeapType::Func | AbstractHeapType::NoFunc) => Self::Func,
            HeapType::Abstract(AbstractHeapType::Extern | AbstractHeapType::NoExtern) => {
                Self::Extern
            }
            HeapType::Abstract(AbstractHeapType::Exn | AbstractHeapType::NoExn) => Self::Exn,
            HeapType::Abstract(
                AbstractHeapType::Any
                | AbstractHeapType::None
                | AbstractHeapType::Eq
                | AbstractHeapType::Struct
                | AbstractHeapType::Array
                | AbstractHeapType::I31,
            ) => Self::Any,
            HeapType::Concrete(ty) | HeapType::Exact(ty) => {
                if module.types.get(ty).is_function() {
                    Self::Func
                } else {
                    Self::Any
                }
            }
            // Walrus marks heap types non-exhaustive. New internal reference
            // hierarchies must travel through the Wasm sidecar until they gain
            // a more specific codec class.
            _ => Self::Any,
        }
    }

    pub fn nullable_type(self) -> RefType {
        match self {
            Self::Func => RefType::FUNCREF,
            Self::Extern => RefType::EXTERNREF,
            Self::Exn => RefType::EXNREF,
            Self::Any => RefType::ANYREF,
        }
    }

    pub fn encoder(self, codecs: ReferenceCodecs) -> FunctionId {
        match self {
            Self::Func => codecs.encode_funcref,
            Self::Extern => codecs.encode_externref,
            Self::Exn => codecs.encode_exnref,
            Self::Any => codecs.encode_anyref,
        }
    }

    pub fn decoder(self, codecs: ReferenceCodecs) -> FunctionId {
        match self {
            Self::Func => codecs.decode_funcref,
            Self::Extern => codecs.decode_externref,
            Self::Exn => codecs.decode_exnref,
            Self::Any => codecs.decode_anyref,
        }
    }
}

/// Typed imported hooks used to turn instance-local references into
/// deterministic reconstruction recipe IDs and back again. A provider may be
/// a JavaScript host function for JS-compatible reference types or a Wasm
/// sidecar when the JS API cannot express the signature.
#[derive(Debug, Clone, Copy)]
pub struct ReferenceCodecs {
    pub encode_funcref: FunctionId,
    pub decode_funcref: FunctionId,
    pub encode_externref: FunctionId,
    pub decode_externref: FunctionId,
    pub encode_exnref: FunctionId,
    pub decode_exnref: FunctionId,
    pub encode_anyref: FunctionId,
    pub decode_anyref: FunctionId,
}

/// Optional module-local providers for reference classes whose signatures
/// cannot cross the JavaScript API boundary.
///
/// The default runtime imports every pair. Exact-tag exception and concrete
/// GC codecs override only the classes they own, while keeping the same
/// `ReferenceCodecs` call sites throughout frame and module-state emission.
#[derive(Debug, Clone, Copy, Default)]
pub struct ReferenceCodecOverrides {
    pub funcref: Option<(FunctionId, FunctionId)>,
    pub externref: Option<(FunctionId, FunctionId)>,
    pub exnref: Option<(FunctionId, FunctionId)>,
    pub anyref: Option<(FunctionId, FunctionId)>,
    /// Clears provider-only alias/scratch roots at every completed transition.
    pub cleanup: Option<FunctionId>,
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
    /// Non-consuming view of the next payload in this module activation's
    /// continuation. Resume thunks use it to materialize their call operands;
    /// the original function preamble consumes the same frame with
    /// `frame_next`.
    pub frame_peek: Option<FunctionId>,
    /// Process-wide replay router. Slot zero means the lexical callee must run;
    /// nonzero slots select an activation resume thunk in `resume_table`.
    pub resume_peek: Option<FunctionId>,
    pub resume_table: Option<TableId>,
    pub reference_vector_begin: Option<FunctionId>,
    pub reference_vector_append: Option<FunctionId>,
    pub reference_vector_finish: Option<FunctionId>,
    pub reference_vector_get: Option<FunctionId>,

    /// Private process-owned unwind transport. Linked fork runtimes import
    /// this tag so every activation can propagate unwind without fabricating
    /// a value of its declared result type.
    pub unwind_tag: Option<TagId>,

    /// Present only in a linked fork runtime. Inert, no-seed modules must not
    /// acquire host imports merely because they were passed through the
    /// instrumenter.
    pub reference_codecs: Option<ReferenceCodecs>,

    /// Mutable scalar globals that `wpk_fork_unwind_begin` snapshots
    /// and `wpk_fork_rewind_begin` restores. Declaration order.
    pub saved_globals: Vec<SavedGlobal>,

    /// Offset of the linked runtime's abort selector.
    /// `wpk_fork_unwind_begin` adds the module-buffer base to this value for
    /// the initial active-frame word. Linked postambles replace that word with
    /// the payload returned by the reserve hook before writing any frame data.
    pub frames_start_offset: u32,

    /// Host-visible fixed prefix. Linked runtimes reserve one selector-sized
    /// area after `frames_start_offset` for the still-live activation that
    /// reverses a failed partial unwind.
    pub fixed_prefix_size: u32,
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
pub fn inject_runtime(module: &mut Module) -> Runtime {
    inject_runtime_with_frame_storage(module, false, ReferenceCodecOverrides::default())
}

pub fn inject_linked_runtime(module: &mut Module) -> Runtime {
    inject_runtime_with_frame_storage(module, true, ReferenceCodecOverrides::default())
}

pub fn inject_linked_runtime_with_reference_overrides(
    module: &mut Module,
    overrides: ReferenceCodecOverrides,
) -> Runtime {
    inject_runtime_with_frame_storage(module, true, overrides)
}

fn inject_runtime_with_frame_storage(
    module: &mut Module,
    linked_frames: bool,
    codec_overrides: ReferenceCodecOverrides,
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
            // Reference globals are owned by the typed module-state helper,
            // which is injected after this scalar prefix has been laid out.
            continue;
        }
        if imported_global_is_child_binding(module, g) {
            // `env.__channel_base` is intentionally rebound to the child's
            // syscall channel. Every other mutable scalar import has guest
            // snapshot ownership and is restored below just like a local.
            continue;
        }
        saved_globals.push(SavedGlobal {
            id: g.id(),
            ty: g.ty,
            offset: next_off,
        });
        next_off += scalar_size(g.ty);
    }
    // Plain-catch payloads are ordinary activation locals and therefore
    // serialize inside each function frame. The module prefix owns only
    // runtime-global state; no code may use it as NORMAL-state scratch.
    let frames_start_offset = next_off;
    let fixed_prefix_size = frames_start_offset
        + if linked_frames {
            ABORT_SELECTOR_SIZE
        } else {
            0
        };
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

    let (
        frame_reserve,
        frame_commit,
        frame_next,
        frame_peek,
        resume_peek,
        resume_table,
        reference_vector_begin,
        reference_vector_append,
        reference_vector_finish,
        reference_vector_get,
        unwind_tag,
        reference_codecs,
    ) = if linked_frames {
        let reserve_ty = module.types.add(&[ptr_ty], &[ptr_ty]);
        let commit_ty = module.types.add(&[ptr_ty], &[]);
        let next_ty = module.types.add(&[ptr_ty], &[ptr_ty]);
        let resume_peek_ty = module.types.add(&[ValType::I32], &[ValType::I32]);
        let reference_vector_begin_ty = module.types.add(&[ValType::I32], &[ValType::I32]);
        let reference_vector_append_ty = module.types.add(&[ValType::I32, ValType::I32], &[]);
        let reference_vector_finish_ty = module.types.add(&[ValType::I32], &[ValType::I32]);
        let reference_vector_get_ty = module
            .types
            .add(&[ValType::I32, ValType::I32], &[ValType::I32]);
        let unwind_ty = module.types.add(&[], &[]);
        let import_module = wasm_posix_shared::abi::WPK_FORK_FRAME_IMPORT_MODULE;
        let (reserve, _) =
            module.add_import_func(import_module, names::IMPORT_FRAME_RESERVE, reserve_ty);
        let (commit, _) =
            module.add_import_func(import_module, names::IMPORT_FRAME_COMMIT, commit_ty);
        let (next, _) = module.add_import_func(import_module, names::IMPORT_FRAME_NEXT, next_ty);
        let (peek, _) = module.add_import_func(import_module, names::IMPORT_FRAME_PEEK, next_ty);
        let (resume_peek, _) =
            module.add_import_func(import_module, names::IMPORT_RESUME_PEEK, resume_peek_ty);
        let (reference_vector_begin, _) = module.add_import_func(
            import_module,
            names::IMPORT_REFERENCE_VECTOR_BEGIN,
            reference_vector_begin_ty,
        );
        let (reference_vector_append, _) = module.add_import_func(
            import_module,
            names::IMPORT_REFERENCE_VECTOR_APPEND,
            reference_vector_append_ty,
        );
        let (reference_vector_finish, _) = module.add_import_func(
            import_module,
            names::IMPORT_REFERENCE_VECTOR_FINISH,
            reference_vector_finish_ty,
        );
        let (reference_vector_get, _) = module.add_import_func(
            import_module,
            names::IMPORT_REFERENCE_VECTOR_GET,
            reference_vector_get_ty,
        );
        // WHY: this table is process-owned rather than module-owned. A replay
        // edge may skip eliminated tail callers or cross a main/side-module
        // boundary, so no individual module instance can be its registry.
        // Slot zero remains null and is the explicit lexical-call sentinel.
        let (resume_table, _) = module.add_import_table(
            import_module,
            names::IMPORT_RESUME_TABLE,
            false,
            1,
            None,
            RefType::FUNCREF,
        );
        let (unwind, _) = module.add_import_tag(
            names::IMPORT_UNWIND_TAG_MODULE,
            names::IMPORT_UNWIND_TAG,
            unwind_ty,
        );
        let reference_codecs = inject_reference_codecs(module, codec_overrides);
        (
            Some(reserve),
            Some(commit),
            Some(next),
            Some(peek),
            Some(resume_peek),
            Some(resume_table),
            Some(reference_vector_begin),
            Some(reference_vector_append),
            Some(reference_vector_finish),
            Some(reference_vector_get),
            Some(unwind),
            Some(reference_codecs),
        )
    } else {
        (
            None, None, None, None, None, None, None, None, None, None, None, None,
        )
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
    let unwind_end = emit_end_fn(
        module,
        state_global,
        buf_global,
        ptr_ty,
        codec_overrides.cleanup,
    );
    let rewind_begin = emit_rewind_begin(
        module,
        ptr_ty,
        state_global,
        buf_global,
        memory,
        &saved_globals,
        STATE_REWINDING,
    );
    let rewind_end = emit_end_fn(
        module,
        state_global,
        buf_global,
        ptr_ty,
        codec_overrides.cleanup,
    );
    let abort_begin = emit_rewind_begin(
        module,
        ptr_ty,
        state_global,
        buf_global,
        memory,
        &saved_globals,
        STATE_ABORT_UNWINDING,
    );
    let abort_end = emit_end_fn(
        module,
        state_global,
        buf_global,
        ptr_ty,
        codec_overrides.cleanup,
    );
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
        frame_peek,
        resume_peek,
        resume_table,
        reference_vector_begin,
        reference_vector_append,
        reference_vector_finish,
        reference_vector_get,
        unwind_tag,
        reference_codecs,
        saved_globals,
        frames_start_offset,
        fixed_prefix_size,
    }
}

fn inject_reference_codecs(
    module: &mut Module,
    overrides: ReferenceCodecOverrides,
) -> ReferenceCodecs {
    fn add_pair(
        module: &mut Module,
        reference: walrus::RefType,
        encode_name: &str,
        decode_name: &str,
    ) -> (FunctionId, FunctionId) {
        let reference = ValType::Ref(reference);
        let encode_ty = module.types.add(&[reference], &[ValType::I32]);
        let decode_ty = module.types.add(&[ValType::I32], &[reference]);
        let (encode, _) =
            module.add_import_func(names::IMPORT_REFERENCE_CODEC_MODULE, encode_name, encode_ty);
        let (decode, _) =
            module.add_import_func(names::IMPORT_REFERENCE_CODEC_MODULE, decode_name, decode_ty);
        (encode, decode)
    }

    let (encode_funcref, decode_funcref) = overrides.funcref.unwrap_or_else(|| {
        add_pair(
            module,
            walrus::RefType::FUNCREF,
            names::IMPORT_REF_ENCODE_FUNCREF,
            names::IMPORT_REF_DECODE_FUNCREF,
        )
    });
    let (encode_externref, decode_externref) = overrides.externref.unwrap_or_else(|| {
        add_pair(
            module,
            walrus::RefType::EXTERNREF,
            names::IMPORT_REF_ENCODE_EXTERNREF,
            names::IMPORT_REF_DECODE_EXTERNREF,
        )
    });
    let (encode_exnref, decode_exnref) = overrides.exnref.unwrap_or_else(|| {
        add_pair(
            module,
            walrus::RefType::EXNREF,
            names::IMPORT_REF_ENCODE_EXNREF,
            names::IMPORT_REF_DECODE_EXNREF,
        )
    });
    let (encode_anyref, decode_anyref) = overrides.anyref.unwrap_or_else(|| {
        add_pair(
            module,
            walrus::RefType::ANYREF,
            names::IMPORT_REF_ENCODE_ANYREF,
            names::IMPORT_REF_DECODE_ANYREF,
        )
    });
    ReferenceCodecs {
        encode_funcref,
        decode_funcref,
        encode_externref,
        decode_externref,
        encode_exnref,
        decode_exnref,
        encode_anyref,
        decode_anyref,
    }
}

fn imported_global_is_child_binding(module: &Module, global: &walrus::Global) -> bool {
    let walrus::GlobalKind::Import(import_id) = global.kind else {
        return false;
    };
    let import = module.imports.get(import_id);
    import.module == "env" && import.name == "__channel_base"
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

/// Emit a `() -> ()` function that releases active-buffer ownership and
/// resets state to NORMAL.
fn emit_end_fn(
    module: &mut Module,
    state_global: GlobalId,
    buf_global: GlobalId,
    ptr_ty: ValType,
    codec_cleanup: Option<FunctionId>,
) -> FunctionId {
    let mut builder = FunctionBuilder::new(&mut module.types, &[], &[]);
    let mut body = builder.func_body();
    if let Some(cleanup) = codec_cleanup {
        // WHY: replay caches preserve alias identity only while a transition
        // is active. Guest locals/globals now own every surviving reference,
        // so retaining provider copies would create unbounded hidden GC roots.
        body.call(cleanup);
    }
    // WHY: a continuation mapping stops belonging to this module at every end
    // transition. Clear the alias to released/reusable storage before
    // publishing NORMAL; correctness still comes from having no NORMAL-state
    // buffer accesses, because linear-memory address zero is itself valid.
    match ptr_ty {
        ValType::I32 => {
            body.i32_const(0);
        }
        ValType::I64 => {
            body.i64_const(0);
        }
        other => unreachable!("unsupported ptr_ty: {other:?}"),
    }
    body.global_set(buf_global);
    body.i32_const(STATE_NORMAL).global_set(state_global);
    builder.finish(vec![], &mut module.funcs)
}

/// Emit a `() -> i32` function that returns the current state.
fn emit_state_fn(module: &mut Module, state_global: GlobalId) -> FunctionId {
    let mut builder = FunctionBuilder::new(&mut module.types, &[], &[ValType::I32]);
    builder.func_body().global_get(state_global);
    builder.finish(vec![], &mut module.funcs)
}
