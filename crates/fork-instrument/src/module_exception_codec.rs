//! Exact-tag exception codecs injected into the owning Wasm module.
//!
//! A separate provider module cannot import a module's local tags until that
//! module exists, while the module cannot import an `exnref` codec from that
//! provider before it is instantiated. Injecting the codec here removes that
//! bootstrap cycle and preserves canonical concrete tag and payload types.
//!
//! Cross-activation routing still has scalar-only JavaScript signatures:
//!
//! * encode delegates an unknown exception by asking the host broker to catch
//!   `throw_slot(slot)` and call the selected owner's `encode_ingress(token)`;
//! * decode asks the broker to call the selected owner's `throw_recipe(id)`,
//!   then catches that thrown value with `CatchAllRef` in the requesting
//!   module.
//!
//! Recipe identity is claimed before recursive payload encoding. Decode caches
//! every materialized exception by shared recipe ID, preserving aliases.

use anyhow::{Result, ensure};
use walrus::{
    AbstractHeapType, FunctionBuilder, FunctionId, FunctionKind, GlobalId, HeapType, ImportKind,
    LocalFunction, LocalId, MemoryId, Module, RawCustomSection, RefType, TableId, TagId, ValType,
    ir::{
        BinaryOp, Binop, Block, Call, Const, Drop, GlobalGet, IfElse, Instr, InstrLocId,
        InstrSeqId, InstrSeqType, Load, LoadKind, LocalGet, LocalSet, LocalTee, MemArg,
        RefAsNonNull, RefCast, RefIsNull, RefNull, Return, Store, StoreKind, TableFill, TableGet,
        TableGrow, TableSet, TableSize, Throw, ThrowRef, TryTable, TryTableCatch, UnaryOp, Unop,
        Unreachable, Value,
    },
};
use wasm_posix_shared::abi::{
    WPK_FORK_EXCEPTION_CODEC_HEADER_SIZE, WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE,
    WPK_FORK_EXCEPTION_CODEC_SECTION, WPK_FORK_EXCEPTION_CODEC_TAG_RECORD_SIZE,
    WPK_FORK_EXCEPTION_CODEC_VERSION, WPK_FORK_EXCEPTION_EXPORT_ABORT,
    WPK_FORK_EXCEPTION_EXPORT_CLEAR, WPK_FORK_EXCEPTION_EXPORT_DECODE,
    WPK_FORK_EXCEPTION_EXPORT_ENCODE, WPK_FORK_EXCEPTION_EXPORT_ENCODE_INGRESS,
    WPK_FORK_EXCEPTION_EXPORT_MATERIALIZE, WPK_FORK_EXCEPTION_EXPORT_THROW_RECIPE,
    WPK_FORK_EXCEPTION_EXPORT_THROW_SLOT, WPK_FORK_EXCEPTION_IMPORT_ACTIVATION,
    WPK_FORK_EXCEPTION_IMPORT_BROKER_ENCODE, WPK_FORK_EXCEPTION_IMPORT_BROKER_THROW_RECIPE,
    WPK_FORK_EXCEPTION_IMPORT_CACHE_INDEX, WPK_FORK_EXCEPTION_IMPORT_CLAIM,
    WPK_FORK_EXCEPTION_IMPORT_DEFINE, WPK_FORK_EXCEPTION_IMPORT_INGRESS_THROW,
    WPK_FORK_EXCEPTION_IMPORT_LOAD, WPK_FORK_EXCEPTION_IMPORT_LOOKUP,
    WPK_FORK_EXCEPTION_IMPORT_ROUTE, WPK_FORK_REFERENCE_IMPORT_SCRATCH_RELEASE,
    WPK_FORK_REFERENCE_IMPORT_SCRATCH_RESERVE,
};

use crate::runtime::{ReferenceCodecClass, names as runtime_names};

pub const FORMAT_SECTION: &str = WPK_FORK_EXCEPTION_CODEC_SECTION;
pub const FORMAT_VERSION: u8 = WPK_FORK_EXCEPTION_CODEC_VERSION;
pub const FORMAT_HEADER_SIZE: usize = WPK_FORK_EXCEPTION_CODEC_HEADER_SIZE as usize;
pub const FORMAT_TAG_RECORD_SIZE: usize = WPK_FORK_EXCEPTION_CODEC_TAG_RECORD_SIZE as usize;

pub const HOST_IMPORT_MODULE: &str = WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE;
pub const IMPORT_ACTIVATION: &str = WPK_FORK_EXCEPTION_IMPORT_ACTIVATION;
pub const IMPORT_LOOKUP: &str = WPK_FORK_EXCEPTION_IMPORT_LOOKUP;
pub const IMPORT_CLAIM: &str = WPK_FORK_EXCEPTION_IMPORT_CLAIM;
pub const IMPORT_DEFINE: &str = WPK_FORK_EXCEPTION_IMPORT_DEFINE;
pub const IMPORT_LOAD: &str = WPK_FORK_EXCEPTION_IMPORT_LOAD;
pub const IMPORT_ROUTE: &str = WPK_FORK_EXCEPTION_IMPORT_ROUTE;
pub const IMPORT_CACHE_INDEX: &str = WPK_FORK_EXCEPTION_IMPORT_CACHE_INDEX;
pub const IMPORT_BROKER_ENCODE: &str = WPK_FORK_EXCEPTION_IMPORT_BROKER_ENCODE;
pub const IMPORT_BROKER_THROW_RECIPE: &str = WPK_FORK_EXCEPTION_IMPORT_BROKER_THROW_RECIPE;
pub const IMPORT_INGRESS_THROW: &str = WPK_FORK_EXCEPTION_IMPORT_INGRESS_THROW;
pub const IMPORT_SCRATCH_RESERVE: &str = WPK_FORK_REFERENCE_IMPORT_SCRATCH_RESERVE;
pub const IMPORT_SCRATCH_RELEASE: &str = WPK_FORK_REFERENCE_IMPORT_SCRATCH_RELEASE;

pub const EXPORT_ENCODE: &str = WPK_FORK_EXCEPTION_EXPORT_ENCODE;
pub const EXPORT_DECODE: &str = WPK_FORK_EXCEPTION_EXPORT_DECODE;
pub const EXPORT_THROW_SLOT: &str = WPK_FORK_EXCEPTION_EXPORT_THROW_SLOT;
pub const EXPORT_THROW_RECIPE: &str = WPK_FORK_EXCEPTION_EXPORT_THROW_RECIPE;
pub const EXPORT_ENCODE_INGRESS: &str = WPK_FORK_EXCEPTION_EXPORT_ENCODE_INGRESS;
pub const EXPORT_MATERIALIZE: &str = WPK_FORK_EXCEPTION_EXPORT_MATERIALIZE;
pub const EXPORT_CLEAR: &str = WPK_FORK_EXCEPTION_EXPORT_CLEAR;
pub const EXPORT_ABORT: &str = WPK_FORK_EXCEPTION_EXPORT_ABORT;

const MAX_RECIPE_ID: i32 = 0x7fff_fffe;

pub fn is_reserved_host_import(name: &str) -> bool {
    matches!(
        name,
        IMPORT_ACTIVATION
            | IMPORT_LOOKUP
            | IMPORT_CLAIM
            | IMPORT_DEFINE
            | IMPORT_LOAD
            | IMPORT_ROUTE
            | IMPORT_CACHE_INDEX
            | IMPORT_BROKER_ENCODE
            | IMPORT_BROKER_THROW_RECIPE
            | IMPORT_INGRESS_THROW
            | IMPORT_SCRATCH_RESERVE
            | IMPORT_SCRATCH_RELEASE
    )
}

#[derive(Debug, Clone, Copy)]
pub struct ReferenceDependencies {
    pub encode_funcref: FunctionId,
    pub decode_funcref: FunctionId,
    pub encode_externref: FunctionId,
    pub decode_externref: FunctionId,
    pub encode_anyref: FunctionId,
    pub decode_anyref: FunctionId,
}

#[derive(Debug, Clone, Copy)]
pub struct InjectedExceptionCodec {
    pub encode: FunctionId,
    pub decode: FunctionId,
    pub throw_slot: FunctionId,
    pub throw_recipe: FunctionId,
    pub encode_ingress: FunctionId,
    pub materialize: FunctionId,
    pub clear: FunctionId,
    pub abort: FunctionId,
    pub memory: MemoryId,
    pub references: ReferenceDependencies,
}

#[derive(Debug, Clone, Copy)]
struct HostImports {
    activation: GlobalId,
    lookup: FunctionId,
    claim: FunctionId,
    define: FunctionId,
    load: FunctionId,
    route: FunctionId,
    cache_index: FunctionId,
    broker_encode: FunctionId,
    broker_throw_recipe: FunctionId,
    ingress_throw: FunctionId,
    scratch_reserve: FunctionId,
    scratch_release: FunctionId,
}

#[derive(Debug, Clone)]
struct PayloadLayout {
    ty: ValType,
    scalar_offset: Option<u32>,
    reference_offset: Option<u32>,
}

#[derive(Debug, Clone)]
struct TagLayout {
    tag: TagId,
    ordinal: u32,
    layout_id: u32,
    scalar_len: u32,
    references_ptr: u32,
    reference_count: u32,
    payloads: Vec<PayloadLayout>,
}

impl TagLayout {
    fn staging_len(&self) -> u32 {
        self.references_ptr
            .checked_add(self.reference_count.saturating_mul(4))
            .expect("validated exception staging layout")
            .max(1)
    }
}

#[derive(Debug, Clone, Copy)]
struct PayloadLocals {
    value: LocalId,
    recipe: Option<LocalId>,
}

#[derive(Debug, Clone)]
struct HandlerLocals {
    payloads: Vec<PayloadLocals>,
}

const NULLABLE_EXNREF: RefType = RefType {
    nullable: true,
    heap_type: HeapType::Abstract(AbstractHeapType::Exn),
};
const NON_NULL_EXNREF: RefType = RefType {
    nullable: false,
    heap_type: HeapType::Abstract(AbstractHeapType::Exn),
};

/// Inject the exact-tag codec before the generic continuation runtime.
///
/// The module-state plan and function catalog must already be frozen: codec
/// tables are temporary reconstruction caches, not guest mutable table state,
/// and codec helper functions are not source-level `ref.func` targets.
pub fn inject(module: &mut Module, memory: MemoryId) -> Result<InjectedExceptionCodec> {
    inject_with_reference_overrides(module, memory, None, None)
}

pub fn inject_with_anyref(
    module: &mut Module,
    memory: MemoryId,
    anyref: Option<(FunctionId, FunctionId)>,
) -> Result<InjectedExceptionCodec> {
    inject_with_reference_overrides(module, memory, None, anyref)
}

pub fn inject_with_reference_overrides(
    module: &mut Module,
    memory: MemoryId,
    externref: Option<(FunctionId, FunctionId)>,
    anyref: Option<(FunctionId, FunctionId)>,
) -> Result<InjectedExceptionCodec> {
    let layouts = plan_tags(module)?;
    let ptr_ty = if module.memories.get(memory).memory64 {
        ValType::I64
    } else {
        ValType::I32
    };
    let scratch = module.tables.add_local(false, 1, Some(1), NULLABLE_EXNREF);
    module.tables.get_mut(scratch).name = Some("__wpk_fork_ref_exn_scratch".into());
    let replay = module.tables.add_local(false, 1, None, NULLABLE_EXNREF);
    module.tables.get_mut(replay).name = Some("__wpk_fork_ref_exn_replay".into());

    let imports = inject_host_imports(module, ptr_ty);
    let references = inject_reference_dependencies(module, externref, anyref);

    let (encode, encode_args) = add_stub(
        module,
        &[ValType::Ref(NULLABLE_EXNREF)],
        &[ValType::I32],
        EXPORT_ENCODE,
    );
    let (decode, decode_args) = add_stub(
        module,
        &[ValType::I32],
        &[ValType::Ref(NULLABLE_EXNREF)],
        EXPORT_DECODE,
    );
    let (throw_slot, throw_slot_args) = add_stub(module, &[ValType::I32], &[], EXPORT_THROW_SLOT);
    let (throw_recipe, throw_recipe_args) =
        add_stub(module, &[ValType::I32], &[], EXPORT_THROW_RECIPE);
    let (encode_ingress, encode_ingress_args) = add_stub(
        module,
        &[ValType::I32],
        &[ValType::I32],
        EXPORT_ENCODE_INGRESS,
    );
    let (materialize, materialize_args) =
        add_stub(module, &[ValType::I32], &[], EXPORT_MATERIALIZE);
    let (clear, _) = add_stub(module, &[], &[], EXPORT_CLEAR);
    let (abort, _) = add_stub(module, &[], &[], EXPORT_ABORT);

    emit_encode(
        module,
        encode,
        encode_args[0],
        scratch,
        memory,
        ptr_ty,
        imports,
        references,
        &layouts,
    );
    emit_decode(
        module,
        decode,
        decode_args[0],
        replay,
        memory,
        ptr_ty,
        imports,
        references,
        &layouts,
    );
    emit_throw_slot(module, throw_slot, throw_slot_args[0], scratch);
    emit_throw_recipe(module, throw_recipe, throw_recipe_args[0], decode);
    emit_encode_ingress(
        module,
        encode_ingress,
        encode_ingress_args[0],
        imports.ingress_throw,
        encode,
    );
    emit_materialize(module, materialize, materialize_args[0], decode);
    emit_clear(module, clear, scratch, replay);
    emit_clear(module, abort, scratch, replay);

    for (name, function) in [
        (EXPORT_ENCODE, encode),
        (EXPORT_DECODE, decode),
        (EXPORT_THROW_SLOT, throw_slot),
        (EXPORT_THROW_RECIPE, throw_recipe),
        (EXPORT_ENCODE_INGRESS, encode_ingress),
        (EXPORT_MATERIALIZE, materialize),
        (EXPORT_CLEAR, clear),
        (EXPORT_ABORT, abort),
    ] {
        module.exports.add(name, function);
    }
    replace_descriptor(module, &layouts);

    Ok(InjectedExceptionCodec {
        encode,
        decode,
        throw_slot,
        throw_recipe,
        encode_ingress,
        materialize,
        clear,
        abort,
        memory,
        references,
    })
}

fn plan_tags(module: &Module) -> Result<Vec<TagLayout>> {
    let mut layouts = Vec::new();
    for (ordinal, tag) in module.tags.iter().enumerate() {
        let ty = module.types.get(tag.ty());
        ensure!(
            ty.results().is_empty(),
            "fork-instrument: exception tag {ordinal} unexpectedly has results"
        );
        let mut scalar_len = 0u32;
        let mut reference_count = 0u32;
        let mut payloads = Vec::new();
        for payload in ty.params().iter().copied() {
            match payload {
                ValType::I32 | ValType::F32 => {
                    let offset = scalar_len;
                    scalar_len = scalar_len
                        .checked_add(4)
                        .ok_or_else(|| anyhow::anyhow!("exception scalar layout overflow"))?;
                    payloads.push(PayloadLayout {
                        ty: payload,
                        scalar_offset: Some(offset),
                        reference_offset: None,
                    });
                }
                ValType::I64 | ValType::F64 => {
                    let offset = scalar_len;
                    scalar_len = scalar_len
                        .checked_add(8)
                        .ok_or_else(|| anyhow::anyhow!("exception scalar layout overflow"))?;
                    payloads.push(PayloadLayout {
                        ty: payload,
                        scalar_offset: Some(offset),
                        reference_offset: None,
                    });
                }
                ValType::V128 => {
                    let offset = scalar_len;
                    scalar_len = scalar_len
                        .checked_add(16)
                        .ok_or_else(|| anyhow::anyhow!("exception scalar layout overflow"))?;
                    payloads.push(PayloadLayout {
                        ty: payload,
                        scalar_offset: Some(offset),
                        reference_offset: None,
                    });
                }
                ValType::Ref(_) => {
                    payloads.push(PayloadLayout {
                        ty: payload,
                        scalar_offset: None,
                        reference_offset: Some(reference_count),
                    });
                    reference_count = reference_count
                        .checked_add(1)
                        .ok_or_else(|| anyhow::anyhow!("exception reference layout overflow"))?;
                }
            }
        }
        let references_ptr = align_up(scalar_len, 4)?;
        layouts.push(TagLayout {
            tag: tag.id(),
            ordinal: ordinal as u32,
            layout_id: ordinal as u32,
            scalar_len,
            references_ptr,
            reference_count,
            payloads,
        });
    }
    Ok(layouts)
}

fn align_up(value: u32, alignment: u32) -> Result<u32> {
    let mask = alignment - 1;
    value
        .checked_add(mask)
        .map(|value| value & !mask)
        .ok_or_else(|| anyhow::anyhow!("exception staging layout overflow"))
}

fn inject_host_imports(module: &mut Module, ptr_ty: ValType) -> HostImports {
    let existing_activation = module.imports.iter().find_map(|import| {
        (import.module == HOST_IMPORT_MODULE && import.name == IMPORT_ACTIVATION)
            .then_some(&import.kind)
            .and_then(|kind| match kind {
                ImportKind::Global(global) => Some(*global),
                _ => None,
            })
    });
    let activation = match existing_activation {
        Some(activation) => activation,
        None => {
            module
                .add_import_global(
                    HOST_IMPORT_MODULE,
                    IMPORT_ACTIVATION,
                    ValType::I32,
                    false,
                    false,
                )
                .0
        }
    };
    let lookup = import_function(module, IMPORT_LOOKUP, &[ValType::I32], &[ValType::I32]);
    let claim = import_function(module, IMPORT_CLAIM, &[ValType::I32], &[ValType::I32]);
    let define = import_function(
        module,
        IMPORT_DEFINE,
        &[
            ValType::I32,
            ValType::I32,
            ValType::I32,
            ValType::I32,
            ptr_ty,
            ValType::I32,
            ptr_ty,
            ValType::I32,
        ],
        &[],
    );
    let load = import_function(
        module,
        IMPORT_LOAD,
        &[
            ValType::I32,
            ValType::I32,
            ValType::I32,
            ValType::I32,
            ptr_ty,
            ValType::I32,
            ptr_ty,
            ValType::I32,
        ],
        &[ValType::I32],
    );
    let route = import_function(
        module,
        IMPORT_ROUTE,
        &[ValType::I32, ValType::I32],
        &[ValType::I32],
    );
    let cache_index = import_function(module, IMPORT_CACHE_INDEX, &[ValType::I32], &[ValType::I32]);
    let broker_encode = import_function(
        module,
        IMPORT_BROKER_ENCODE,
        &[ValType::I32],
        &[ValType::I32],
    );
    let broker_throw_recipe =
        import_function(module, IMPORT_BROKER_THROW_RECIPE, &[ValType::I32], &[]);
    let ingress_throw = import_function(module, IMPORT_INGRESS_THROW, &[ValType::I32], &[]);
    let scratch_reserve = import_function(module, IMPORT_SCRATCH_RESERVE, &[ptr_ty], &[ptr_ty]);
    let scratch_release = import_function(module, IMPORT_SCRATCH_RELEASE, &[ptr_ty, ptr_ty], &[]);
    HostImports {
        activation,
        lookup,
        claim,
        define,
        load,
        route,
        cache_index,
        broker_encode,
        broker_throw_recipe,
        ingress_throw,
        scratch_reserve,
        scratch_release,
    }
}

fn inject_reference_dependencies(
    module: &mut Module,
    externref: Option<(FunctionId, FunctionId)>,
    anyref: Option<(FunctionId, FunctionId)>,
) -> ReferenceDependencies {
    fn pair(
        module: &mut Module,
        reference: RefType,
        encode_name: &str,
        decode_name: &str,
    ) -> (FunctionId, FunctionId) {
        let value = ValType::Ref(reference);
        (
            import_function(module, encode_name, &[value], &[ValType::I32]),
            import_function(module, decode_name, &[ValType::I32], &[value]),
        )
    }
    let (encode_funcref, decode_funcref) = pair(
        module,
        RefType::FUNCREF,
        runtime_names::IMPORT_REF_ENCODE_FUNCREF,
        runtime_names::IMPORT_REF_DECODE_FUNCREF,
    );
    let (encode_externref, decode_externref) = externref.unwrap_or_else(|| {
        pair(
            module,
            RefType::EXTERNREF,
            runtime_names::IMPORT_REF_ENCODE_EXTERNREF,
            runtime_names::IMPORT_REF_DECODE_EXTERNREF,
        )
    });
    let (encode_anyref, decode_anyref) = anyref.unwrap_or_else(|| {
        pair(
            module,
            RefType::ANYREF,
            runtime_names::IMPORT_REF_ENCODE_ANYREF,
            runtime_names::IMPORT_REF_DECODE_ANYREF,
        )
    });
    ReferenceDependencies {
        encode_funcref,
        decode_funcref,
        encode_externref,
        decode_externref,
        encode_anyref,
        decode_anyref,
    }
}

fn import_function(
    module: &mut Module,
    name: &str,
    params: &[ValType],
    results: &[ValType],
) -> FunctionId {
    let ty = module.types.add(params, results);
    module.add_import_func(HOST_IMPORT_MODULE, name, ty).0
}

fn add_stub(
    module: &mut Module,
    params: &[ValType],
    results: &[ValType],
    name: &str,
) -> (FunctionId, Vec<LocalId>) {
    let args: Vec<_> = params
        .iter()
        .copied()
        .map(|ty| module.locals.add(ty))
        .collect();
    let mut builder = FunctionBuilder::new(&mut module.types, params, results);
    builder.name(name.into());
    let function = builder.finish(args.clone(), &mut module.funcs);
    (function, args)
}

#[allow(clippy::too_many_arguments)]
fn emit_encode(
    module: &mut Module,
    function: FunctionId,
    exception: LocalId,
    scratch: TableId,
    memory: MemoryId,
    ptr_ty: ValType,
    imports: HostImports,
    references: ReferenceDependencies,
    layouts: &[TagLayout],
) {
    let recipe = module.locals.add(ValType::I32);
    let staging = module.locals.add(ptr_ty);
    let handler_locals: Vec<_> = layouts
        .iter()
        .map(|layout| HandlerLocals {
            payloads: layout
                .payloads
                .iter()
                .map(|payload| PayloadLocals {
                    value: module.locals.add(storage_type(payload.ty)),
                    recipe: matches!(payload.ty, ValType::Ref(_))
                        .then(|| module.locals.add(ValType::I32)),
                })
                .collect(),
        })
        .collect();

    let null_then = dangling(module, function, InstrSeqType::Simple(None));
    {
        let instrs = instrs_mut(module, function, null_then);
        constant_i32(instrs, 0);
        push(instrs, Instr::Return(Return {}));
    }
    let empty_else = dangling(module, function, InstrSeqType::Simple(None));

    let existing_then = dangling(module, function, InstrSeqType::Simple(None));
    {
        let instrs = instrs_mut(module, function, existing_then);
        emit_clear_scratch(instrs, scratch);
        local_get(instrs, recipe);
        push(instrs, Instr::Return(Return {}));
    }
    let existing_else = dangling(module, function, InstrSeqType::Simple(None));

    let outer = dangling(module, function, InstrSeqType::Simple(Some(ValType::I32)));
    let mut caps = Vec::new();
    for layout in layouts {
        let mut results: Vec<_> = layout.payloads.iter().map(|payload| payload.ty).collect();
        results.push(ValType::Ref(NON_NULL_EXNREF));
        let ty = InstrSeqType::new(&mut module.types, &[], &results);
        caps.push(dangling(module, function, ty));
    }
    let fallback_ty = InstrSeqType::new(&mut module.types, &[], &[ValType::Ref(NON_NULL_EXNREF)]);
    let fallback = dangling(module, function, fallback_ty);
    caps.push(fallback);

    let throw_body = dangling(module, function, InstrSeqType::Simple(None));
    {
        let instrs = instrs_mut(module, function, throw_body);
        local_get(instrs, exception);
        push(instrs, Instr::RefAsNonNull(RefAsNonNull {}));
        push(instrs, Instr::ThrowRef(ThrowRef {}));
    }
    let catches: Vec<_> = layouts
        .iter()
        .zip(caps.iter())
        .map(|(layout, cap)| TryTableCatch::CatchRef {
            tag: layout.tag,
            label: *cap,
        })
        .chain(std::iter::once(TryTableCatch::CatchAllRef {
            label: fallback,
        }))
        .collect();
    {
        let innermost = *caps.last().expect("fallback cap always exists");
        let instrs = instrs_mut(module, function, innermost);
        push(
            instrs,
            Instr::TryTable(TryTable {
                seq: throw_body,
                catches,
            }),
        );
        push(instrs, Instr::Unreachable(Unreachable {}));
    }

    for index in (0..caps.len() - 1).rev() {
        let child = caps[index + 1];
        push(
            instrs_mut(module, function, caps[index]),
            Instr::Block(Block { seq: child }),
        );
        if index + 1 == layouts.len() {
            emit_unknown_encode_handler(
                module,
                function,
                caps[index],
                scratch,
                imports.broker_encode,
                recipe,
            );
        } else {
            emit_known_encode_handler(
                module,
                function,
                caps[index],
                &layouts[index + 1],
                &handler_locals[index + 1],
                scratch,
                memory,
                ptr_ty,
                staging,
                imports,
                references,
                function,
                recipe,
            );
        }
    }
    push(
        instrs_mut(module, function, outer),
        Instr::Block(Block { seq: caps[0] }),
    );
    if layouts.is_empty() {
        emit_unknown_encode_handler(
            module,
            function,
            outer,
            scratch,
            imports.broker_encode,
            recipe,
        );
    } else {
        emit_known_encode_handler(
            module,
            function,
            outer,
            &layouts[0],
            &handler_locals[0],
            scratch,
            memory,
            ptr_ty,
            staging,
            imports,
            references,
            function,
            recipe,
        );
    }

    let entry = entry(function, module);
    let instrs = instrs_mut(module, function, entry);
    local_get(instrs, exception);
    push(instrs, Instr::RefIsNull(RefIsNull {}));
    push(
        instrs,
        Instr::IfElse(IfElse {
            consequent: null_then,
            alternative: empty_else,
        }),
    );
    constant_i32(instrs, 0);
    local_get(instrs, exception);
    push(instrs, Instr::TableSet(TableSet { table: scratch }));
    constant_i32(instrs, 0);
    call(instrs, imports.lookup);
    push(instrs, Instr::LocalTee(LocalTee { local: recipe }));
    push(
        instrs,
        Instr::IfElse(IfElse {
            consequent: existing_then,
            alternative: existing_else,
        }),
    );
    push(instrs, Instr::Block(Block { seq: outer }));
}

#[allow(clippy::too_many_arguments)]
fn emit_known_encode_handler(
    module: &mut Module,
    function: FunctionId,
    seq: InstrSeqId,
    layout: &TagLayout,
    locals: &HandlerLocals,
    scratch: TableId,
    memory: MemoryId,
    ptr_ty: ValType,
    staging: LocalId,
    imports: HostImports,
    references: ReferenceDependencies,
    encode_exnref: FunctionId,
    recipe: LocalId,
) {
    let encoders: Vec<_> = layout
        .payloads
        .iter()
        .map(|payload| match payload.ty {
            ValType::Ref(reference) => Some(reference_encoder(
                module,
                references,
                encode_exnref,
                reference,
            )),
            _ => None,
        })
        .collect();
    let instrs = instrs_mut(module, function, seq);
    push(instrs, Instr::Drop(Drop {}));
    for payload in locals.payloads.iter().rev() {
        local_set(instrs, payload.value);
    }
    constant_i32(instrs, 0);
    call(instrs, imports.claim);
    local_set(instrs, recipe);
    emit_clear_scratch(instrs, scratch);

    // WHY: transaction scratch is disjoint for recursive payload codecs and
    // lives in the one process memory copied into the child. It is transient
    // exchange storage, never continuation evidence.
    constant_ptr(instrs, ptr_ty, u64::from(layout.staging_len()));
    call(instrs, imports.scratch_reserve);
    local_set(instrs, staging);

    for ((payload, local), encoder) in layout.payloads.iter().zip(&locals.payloads).zip(encoders) {
        let ValType::Ref(reference) = payload.ty else {
            continue;
        };
        local_get(instrs, local.value);
        let _ = reference;
        call(instrs, encoder.expect("reference payload encoder"));
        local_set(
            instrs,
            local.recipe.expect("reference payload has recipe local"),
        );
    }
    for (payload, local) in layout.payloads.iter().zip(&locals.payloads) {
        if let Some(offset) = payload.scalar_offset {
            emit_staging_address(instrs, staging, ptr_ty, 0);
            local_get(instrs, local.value);
            push(
                instrs,
                Instr::Store(Store {
                    memory,
                    kind: scalar_store(payload.ty),
                    arg: MemArg {
                        align: 1,
                        offset: u64::from(offset),
                    },
                }),
            );
        } else {
            let index = payload.reference_offset.expect("reference payload index");
            emit_staging_address(instrs, staging, ptr_ty, 0);
            local_get(
                instrs,
                local.recipe.expect("reference payload recipe local"),
            );
            push(
                instrs,
                Instr::Store(Store {
                    memory,
                    kind: StoreKind::I32 { atomic: false },
                    arg: MemArg {
                        align: 4,
                        offset: u64::from(layout.references_ptr + index * 4),
                    },
                }),
            );
        }
    }
    local_get(instrs, recipe);
    push(
        instrs,
        Instr::GlobalGet(GlobalGet {
            global: imports.activation,
        }),
    );
    constant_i32(instrs, layout.ordinal as i32);
    constant_i32(instrs, layout.layout_id as i32);
    emit_staging_address(instrs, staging, ptr_ty, 0);
    constant_i32(instrs, layout.scalar_len as i32);
    emit_staging_address(instrs, staging, ptr_ty, layout.references_ptr);
    constant_i32(instrs, layout.reference_count as i32);
    call(instrs, imports.define);
    local_get(instrs, staging);
    constant_ptr(instrs, ptr_ty, u64::from(layout.staging_len()));
    call(instrs, imports.scratch_release);
    local_get(instrs, recipe);
    push(instrs, Instr::Return(Return {}));
}

fn emit_unknown_encode_handler(
    module: &mut Module,
    function: FunctionId,
    seq: InstrSeqId,
    scratch: TableId,
    broker_encode: FunctionId,
    recipe: LocalId,
) {
    let instrs = instrs_mut(module, function, seq);
    push(instrs, Instr::Drop(Drop {}));
    constant_i32(instrs, 0);
    call(instrs, broker_encode);
    local_set(instrs, recipe);
    emit_clear_scratch(instrs, scratch);
    local_get(instrs, recipe);
    push(instrs, Instr::Return(Return {}));
}

#[allow(clippy::too_many_arguments)]
fn emit_decode(
    module: &mut Module,
    function: FunctionId,
    recipe: LocalId,
    replay: TableId,
    memory: MemoryId,
    ptr_ty: ValType,
    imports: HostImports,
    references: ReferenceDependencies,
    layouts: &[TagLayout],
) {
    let route = module.locals.add(ValType::I32);
    let cache_index = module.locals.add(ValType::I32);
    let cached = module.locals.add(ValType::Ref(NULLABLE_EXNREF));
    let staging = module.locals.add(ptr_ty);
    let null_then = dangling(module, function, InstrSeqType::Simple(None));
    {
        let instrs = instrs_mut(module, function, null_then);
        push(
            instrs,
            Instr::RefNull(RefNull {
                ty: NULLABLE_EXNREF,
            }),
        );
        push(instrs, Instr::Return(Return {}));
    }
    let empty_else = dangling(module, function, InstrSeqType::Simple(None));
    let invalid_then = dangling(module, function, InstrSeqType::Simple(None));
    push(
        instrs_mut(module, function, invalid_then),
        Instr::Unreachable(Unreachable {}),
    );
    let invalid_else = dangling(module, function, InstrSeqType::Simple(None));
    let grow_then = dangling(module, function, InstrSeqType::Simple(None));
    {
        let failed_then = dangling(module, function, InstrSeqType::Simple(None));
        push(
            instrs_mut(module, function, failed_then),
            Instr::Unreachable(Unreachable {}),
        );
        let failed_else = dangling(module, function, InstrSeqType::Simple(None));
        let instrs = instrs_mut(module, function, grow_then);
        push(
            instrs,
            Instr::RefNull(RefNull {
                ty: NULLABLE_EXNREF,
            }),
        );
        local_get(instrs, cache_index);
        constant_i32(instrs, 1);
        binop(instrs, BinaryOp::I32Add);
        push(instrs, Instr::TableSize(TableSize { table: replay }));
        binop(instrs, BinaryOp::I32Sub);
        push(instrs, Instr::TableGrow(TableGrow { table: replay }));
        constant_i32(instrs, -1);
        binop(instrs, BinaryOp::I32Eq);
        push(
            instrs,
            Instr::IfElse(IfElse {
                consequent: failed_then,
                alternative: failed_else,
            }),
        );
    }
    let grow_else = dangling(module, function, InstrSeqType::Simple(None));
    let cached_then = dangling(module, function, InstrSeqType::Simple(None));
    {
        let instrs = instrs_mut(module, function, cached_then);
        local_get(instrs, cached);
        push(instrs, Instr::Return(Return {}));
    }
    let cached_else = dangling(module, function, InstrSeqType::Simple(None));

    let broker_then = dangling(module, function, InstrSeqType::Simple(None));
    emit_broker_decode(
        module,
        function,
        broker_then,
        recipe,
        cache_index,
        cached,
        replay,
        imports.broker_throw_recipe,
    );
    let broker_else = dangling(module, function, InstrSeqType::Simple(None));

    let known_locals: Vec<_> = layouts
        .iter()
        .map(|layout| HandlerLocals {
            payloads: layout
                .payloads
                .iter()
                .map(|payload| PayloadLocals {
                    value: module.locals.add(storage_type(payload.ty)),
                    recipe: matches!(payload.ty, ValType::Ref(_))
                        .then(|| module.locals.add(ValType::I32)),
                })
                .collect(),
        })
        .collect();
    let known_blocks: Vec<_> = layouts
        .iter()
        .zip(&known_locals)
        .map(|(layout, locals)| {
            let seq = dangling(module, function, InstrSeqType::Simple(None));
            emit_known_decode(
                module,
                function,
                seq,
                recipe,
                cache_index,
                cached,
                replay,
                memory,
                ptr_ty,
                staging,
                imports,
                references,
                function,
                layout,
                locals,
            );
            seq
        })
        .collect();

    let entry = entry(function, module);
    let instrs = instrs_mut(module, function, entry);
    local_get(instrs, recipe);
    unop(instrs, UnaryOp::I32Eqz);
    push(
        instrs,
        Instr::IfElse(IfElse {
            consequent: null_then,
            alternative: empty_else,
        }),
    );
    local_get(instrs, recipe);
    constant_i32(instrs, 0);
    binop(instrs, BinaryOp::I32LtS);
    local_get(instrs, recipe);
    constant_i32(instrs, MAX_RECIPE_ID);
    binop(instrs, BinaryOp::I32GtU);
    binop(instrs, BinaryOp::I32Or);
    push(
        instrs,
        Instr::IfElse(IfElse {
            consequent: invalid_then,
            alternative: invalid_else,
        }),
    );
    local_get(instrs, recipe);
    call(instrs, imports.cache_index);
    push(instrs, Instr::LocalTee(LocalTee { local: cache_index }));
    unop(instrs, UnaryOp::I32Eqz);
    push(
        instrs,
        Instr::IfElse(IfElse {
            consequent: invalid_then,
            alternative: invalid_else,
        }),
    );
    local_get(instrs, cache_index);
    push(instrs, Instr::TableSize(TableSize { table: replay }));
    binop(instrs, BinaryOp::I32GeU);
    push(
        instrs,
        Instr::IfElse(IfElse {
            consequent: grow_then,
            alternative: grow_else,
        }),
    );
    local_get(instrs, cache_index);
    push(instrs, Instr::TableGet(TableGet { table: replay }));
    push(instrs, Instr::LocalTee(LocalTee { local: cached }));
    push(instrs, Instr::RefIsNull(RefIsNull {}));
    unop(instrs, UnaryOp::I32Eqz);
    push(
        instrs,
        Instr::IfElse(IfElse {
            consequent: cached_then,
            alternative: cached_else,
        }),
    );
    local_get(instrs, recipe);
    push(
        instrs,
        Instr::GlobalGet(GlobalGet {
            global: imports.activation,
        }),
    );
    call(instrs, imports.route);
    push(instrs, Instr::LocalTee(LocalTee { local: route }));
    constant_i32(instrs, -1);
    binop(instrs, BinaryOp::I32Eq);
    push(
        instrs,
        Instr::IfElse(IfElse {
            consequent: broker_then,
            alternative: broker_else,
        }),
    );
    for (layout, block) in layouts.iter().zip(known_blocks) {
        let next = dangling(module, function, InstrSeqType::Simple(None));
        local_get(instrs_mut(module, function, entry), route);
        constant_i32(instrs_mut(module, function, entry), layout.layout_id as i32);
        binop(instrs_mut(module, function, entry), BinaryOp::I32Eq);
        push(
            instrs_mut(module, function, entry),
            Instr::IfElse(IfElse {
                consequent: block,
                alternative: next,
            }),
        );
    }
    push(
        instrs_mut(module, function, entry),
        Instr::Unreachable(Unreachable {}),
    );
}

fn emit_broker_decode(
    module: &mut Module,
    function: FunctionId,
    seq: InstrSeqId,
    recipe: LocalId,
    cache_index: LocalId,
    cached: LocalId,
    replay: TableId,
    broker_throw: FunctionId,
) {
    let cap_ty = InstrSeqType::new(&mut module.types, &[], &[ValType::Ref(NON_NULL_EXNREF)]);
    let cap = dangling(module, function, cap_ty);
    let body = dangling(module, function, InstrSeqType::Simple(None));
    {
        let instrs = instrs_mut(module, function, body);
        local_get(instrs, recipe);
        call(instrs, broker_throw);
        push(instrs, Instr::Unreachable(Unreachable {}));
    }
    {
        let instrs = instrs_mut(module, function, cap);
        push(
            instrs,
            Instr::TryTable(TryTable {
                seq: body,
                catches: vec![TryTableCatch::CatchAllRef { label: cap }],
            }),
        );
        push(instrs, Instr::Unreachable(Unreachable {}));
    }
    let instrs = instrs_mut(module, function, seq);
    push(instrs, Instr::Block(Block { seq: cap }));
    local_set(instrs, cached);
    emit_cache_and_return(instrs, cache_index, cached, replay);
}

#[allow(clippy::too_many_arguments)]
fn emit_known_decode(
    module: &mut Module,
    function: FunctionId,
    seq: InstrSeqId,
    recipe: LocalId,
    cache_index: LocalId,
    cached: LocalId,
    replay: TableId,
    memory: MemoryId,
    ptr_ty: ValType,
    staging: LocalId,
    imports: HostImports,
    references: ReferenceDependencies,
    decode_exnref: FunctionId,
    layout: &TagLayout,
    locals: &HandlerLocals,
) {
    let invalid = dangling(module, function, InstrSeqType::Simple(None));
    push(
        instrs_mut(module, function, invalid),
        Instr::Unreachable(Unreachable {}),
    );
    let valid = dangling(module, function, InstrSeqType::Simple(None));
    let classes: Vec<_> = layout
        .payloads
        .iter()
        .map(|payload| match payload.ty {
            ValType::Ref(reference) => Some(ReferenceCodecClass::of(module, reference)),
            _ => None,
        })
        .collect();
    {
        let instrs = instrs_mut(module, function, seq);
        constant_ptr(instrs, ptr_ty, u64::from(layout.staging_len()));
        call(instrs, imports.scratch_reserve);
        local_set(instrs, staging);
        local_get(instrs, recipe);
        push(
            instrs,
            Instr::GlobalGet(GlobalGet {
                global: imports.activation,
            }),
        );
        constant_i32(instrs, layout.ordinal as i32);
        constant_i32(instrs, layout.layout_id as i32);
        emit_staging_address(instrs, staging, ptr_ty, 0);
        constant_i32(instrs, layout.scalar_len as i32);
        emit_staging_address(instrs, staging, ptr_ty, layout.references_ptr);
        constant_i32(instrs, layout.reference_count as i32);
        call(instrs, imports.load);
        unop(instrs, UnaryOp::I32Eqz);
        push(
            instrs,
            Instr::IfElse(IfElse {
                consequent: invalid,
                alternative: valid,
            }),
        );

        for (payload, local) in layout.payloads.iter().zip(&locals.payloads) {
            emit_staging_address(instrs, staging, ptr_ty, 0);
            if let Some(offset) = payload.scalar_offset {
                push(
                    instrs,
                    Instr::Load(Load {
                        memory,
                        kind: scalar_load(payload.ty),
                        arg: MemArg {
                            align: 1,
                            offset: u64::from(offset),
                        },
                    }),
                );
                local_set(instrs, local.value);
            } else {
                let index = payload.reference_offset.expect("reference payload index");
                push(
                    instrs,
                    Instr::Load(Load {
                        memory,
                        kind: LoadKind::I32 { atomic: false },
                        arg: MemArg {
                            align: 4,
                            offset: u64::from(layout.references_ptr + index * 4),
                        },
                    }),
                );
                local_set(
                    instrs,
                    local.recipe.expect("reference payload recipe local"),
                );
            }
        }
        // Scalar bits and child recipe IDs are now in typed locals. Releasing
        // here lets recursive decoders reserve disjoint ranges and guarantees
        // the transaction zeroes exchange bytes before reuse.
        local_get(instrs, staging);
        constant_ptr(instrs, ptr_ty, u64::from(layout.staging_len()));
        call(instrs, imports.scratch_release);
        for ((payload, local), class) in layout.payloads.iter().zip(&locals.payloads).zip(&classes)
        {
            let ValType::Ref(reference) = payload.ty else {
                continue;
            };
            local_get(
                instrs,
                local.recipe.expect("reference payload recipe local"),
            );
            let class = class.expect("reference payload class");
            call(instrs, reference_decoder(references, decode_exnref, class));
            emit_narrow(instrs, class, reference);
            local_set(instrs, local.value);
        }
    }

    let cap_ty = InstrSeqType::new(&mut module.types, &[], &[ValType::Ref(NON_NULL_EXNREF)]);
    let cap = dangling(module, function, cap_ty);
    let throw_body = dangling(module, function, InstrSeqType::Simple(None));
    {
        let throw = instrs_mut(module, function, throw_body);
        for (payload, local) in layout.payloads.iter().zip(&locals.payloads) {
            local_get(throw, local.value);
            if let ValType::Ref(reference) = payload.ty
                && !reference.nullable
            {
                push(throw, Instr::RefAsNonNull(RefAsNonNull {}));
            }
        }
        push(throw, Instr::Throw(Throw { tag: layout.tag }));
    }
    {
        let capture = instrs_mut(module, function, cap);
        push(
            capture,
            Instr::TryTable(TryTable {
                seq: throw_body,
                catches: vec![TryTableCatch::CatchAllRef { label: cap }],
            }),
        );
        push(capture, Instr::Unreachable(Unreachable {}));
    }
    push(
        instrs_mut(module, function, seq),
        Instr::Block(Block { seq: cap }),
    );
    local_set(instrs_mut(module, function, seq), cached);
    emit_cache_and_return(
        instrs_mut(module, function, seq),
        cache_index,
        cached,
        replay,
    );
}

fn emit_cache_and_return(
    instrs: &mut Vec<(Instr, InstrLocId)>,
    cache_index: LocalId,
    exception: LocalId,
    replay: TableId,
) {
    local_get(instrs, cache_index);
    local_get(instrs, exception);
    push(instrs, Instr::TableSet(TableSet { table: replay }));
    local_get(instrs, exception);
    push(instrs, Instr::Return(Return {}));
}

fn emit_throw_slot(module: &mut Module, function: FunctionId, slot: LocalId, scratch: TableId) {
    let entry = entry(function, module);
    let instrs = instrs_mut(module, function, entry);
    local_get(instrs, slot);
    push(instrs, Instr::TableGet(TableGet { table: scratch }));
    push(instrs, Instr::RefAsNonNull(RefAsNonNull {}));
    push(instrs, Instr::ThrowRef(ThrowRef {}));
}

fn emit_throw_recipe(
    module: &mut Module,
    function: FunctionId,
    recipe: LocalId,
    decode: FunctionId,
) {
    let entry = entry(function, module);
    let instrs = instrs_mut(module, function, entry);
    local_get(instrs, recipe);
    call(instrs, decode);
    push(instrs, Instr::RefAsNonNull(RefAsNonNull {}));
    push(instrs, Instr::ThrowRef(ThrowRef {}));
}

fn emit_materialize(
    module: &mut Module,
    function: FunctionId,
    recipe: LocalId,
    decode: FunctionId,
) {
    let entry = entry(function, module);
    let instrs = instrs_mut(module, function, entry);
    local_get(instrs, recipe);
    call(instrs, decode);
    // WHY: the JavaScript embedding rejects calls whose result contains
    // `exnref`. Decode and cache entirely inside the owning instance, then
    // cross the host boundary with a void result.
    push(instrs, Instr::Drop(Drop {}));
}

fn emit_encode_ingress(
    module: &mut Module,
    function: FunctionId,
    token: LocalId,
    ingress_throw: FunctionId,
    encode: FunctionId,
) {
    let cap_ty = InstrSeqType::new(&mut module.types, &[], &[ValType::Ref(NON_NULL_EXNREF)]);
    let cap = dangling(module, function, cap_ty);
    let body = dangling(module, function, InstrSeqType::Simple(None));
    {
        let instrs = instrs_mut(module, function, body);
        local_get(instrs, token);
        call(instrs, ingress_throw);
        push(instrs, Instr::Unreachable(Unreachable {}));
    }
    {
        let instrs = instrs_mut(module, function, cap);
        push(
            instrs,
            Instr::TryTable(TryTable {
                seq: body,
                catches: vec![TryTableCatch::CatchAllRef { label: cap }],
            }),
        );
        push(instrs, Instr::Unreachable(Unreachable {}));
    }
    let entry = entry(function, module);
    let instrs = instrs_mut(module, function, entry);
    push(instrs, Instr::Block(Block { seq: cap }));
    call(instrs, encode);
}

fn emit_clear(module: &mut Module, function: FunctionId, scratch: TableId, replay: TableId) {
    let entry = entry(function, module);
    let instrs = instrs_mut(module, function, entry);
    emit_clear_scratch(instrs, scratch);
    constant_i32(instrs, 0);
    push(
        instrs,
        Instr::RefNull(RefNull {
            ty: NULLABLE_EXNREF,
        }),
    );
    push(instrs, Instr::TableSize(TableSize { table: replay }));
    push(instrs, Instr::TableFill(TableFill { table: replay }));
}

fn emit_clear_scratch(instrs: &mut Vec<(Instr, InstrLocId)>, scratch: TableId) {
    constant_i32(instrs, 0);
    push(
        instrs,
        Instr::RefNull(RefNull {
            ty: NULLABLE_EXNREF,
        }),
    );
    push(instrs, Instr::TableSet(TableSet { table: scratch }));
}

fn reference_encoder(
    module: &Module,
    references: ReferenceDependencies,
    encode_exnref: FunctionId,
    reference: RefType,
) -> FunctionId {
    match ReferenceCodecClass::of(module, reference) {
        ReferenceCodecClass::Func => references.encode_funcref,
        ReferenceCodecClass::Extern => references.encode_externref,
        ReferenceCodecClass::Exn => encode_exnref,
        ReferenceCodecClass::Any => references.encode_anyref,
    }
}

fn reference_decoder(
    references: ReferenceDependencies,
    decode_exnref: FunctionId,
    class: ReferenceCodecClass,
) -> FunctionId {
    match class {
        ReferenceCodecClass::Func => references.decode_funcref,
        ReferenceCodecClass::Extern => references.decode_externref,
        ReferenceCodecClass::Exn => decode_exnref,
        ReferenceCodecClass::Any => references.decode_anyref,
    }
}

fn emit_narrow(
    instrs: &mut Vec<(Instr, InstrLocId)>,
    class: ReferenceCodecClass,
    expected: RefType,
) {
    let broad = class.nullable_type();
    if expected.heap_type != broad.heap_type {
        push(
            instrs,
            Instr::RefCast(RefCast {
                nullable: expected.nullable,
                heap_type: expected.heap_type,
            }),
        );
    } else if !expected.nullable {
        push(instrs, Instr::RefAsNonNull(RefAsNonNull {}));
    }
}

fn storage_type(ty: ValType) -> ValType {
    match ty {
        ValType::Ref(mut reference) => {
            reference.nullable = true;
            ValType::Ref(reference)
        }
        scalar => scalar,
    }
}

fn scalar_store(ty: ValType) -> StoreKind {
    match ty {
        ValType::I32 => StoreKind::I32 { atomic: false },
        ValType::I64 => StoreKind::I64 { atomic: false },
        ValType::F32 => StoreKind::F32,
        ValType::F64 => StoreKind::F64,
        ValType::V128 => StoreKind::V128,
        ValType::Ref(_) => unreachable!("reference payload uses a recipe ID"),
    }
}

fn scalar_load(ty: ValType) -> LoadKind {
    match ty {
        ValType::I32 => LoadKind::I32 { atomic: false },
        ValType::I64 => LoadKind::I64 { atomic: false },
        ValType::F32 => LoadKind::F32,
        ValType::F64 => LoadKind::F64,
        ValType::V128 => LoadKind::V128,
        ValType::Ref(_) => unreachable!("reference payload uses a recipe ID"),
    }
}

fn replace_descriptor(module: &mut Module, layouts: &[TagLayout]) {
    loop {
        let existing = module
            .customs
            .iter()
            .find(|(_, section)| section.name() == FORMAT_SECTION)
            .map(|(id, _)| id);
        let Some(existing) = existing else { break };
        module.customs.delete(existing);
    }
    let mut data = Vec::with_capacity(FORMAT_HEADER_SIZE + layouts.len() * FORMAT_TAG_RECORD_SIZE);
    data.push(FORMAT_VERSION);
    data.push(0);
    data.extend_from_slice(&0u16.to_le_bytes());
    data.extend_from_slice(&(layouts.len() as u32).to_le_bytes());
    for layout in layouts {
        data.extend_from_slice(&layout.ordinal.to_le_bytes());
        data.extend_from_slice(&layout.layout_id.to_le_bytes());
        data.extend_from_slice(&layout.scalar_len.to_le_bytes());
        data.extend_from_slice(&layout.reference_count.to_le_bytes());
    }
    module.customs.add(RawCustomSection {
        name: FORMAT_SECTION.into(),
        data,
    });
}

fn dangling(module: &mut Module, function: FunctionId, ty: InstrSeqType) -> InstrSeqId {
    local_mut(module, function)
        .builder_mut()
        .dangling_instr_seq(ty)
        .id()
}

fn entry(function: FunctionId, module: &Module) -> InstrSeqId {
    local(module, function).entry_block()
}

fn instrs_mut(
    module: &mut Module,
    function: FunctionId,
    seq: InstrSeqId,
) -> &mut Vec<(Instr, InstrLocId)> {
    &mut local_mut(module, function).block_mut(seq).instrs
}

fn local(module: &Module, function: FunctionId) -> &LocalFunction {
    match &module.funcs.get(function).kind {
        FunctionKind::Local(local) => local,
        _ => unreachable!("injected exception codec function is local"),
    }
}

fn local_mut(module: &mut Module, function: FunctionId) -> &mut LocalFunction {
    match &mut module.funcs.get_mut(function).kind {
        FunctionKind::Local(local) => local,
        _ => unreachable!("injected exception codec function is local"),
    }
}

fn push(instrs: &mut Vec<(Instr, InstrLocId)>, instr: Instr) {
    instrs.push((instr, InstrLocId::default()));
}

fn constant_i32(instrs: &mut Vec<(Instr, InstrLocId)>, value: i32) {
    push(
        instrs,
        Instr::Const(Const {
            value: Value::I32(value),
        }),
    );
}

fn constant_ptr(instrs: &mut Vec<(Instr, InstrLocId)>, ptr_ty: ValType, value: u64) {
    match ptr_ty {
        ValType::I32 => constant_i32(instrs, value as u32 as i32),
        ValType::I64 => push(
            instrs,
            Instr::Const(Const {
                value: Value::I64(value as i64),
            }),
        ),
        other => unreachable!("unsupported exception staging pointer type {other:?}"),
    }
}

fn emit_staging_address(
    instrs: &mut Vec<(Instr, InstrLocId)>,
    staging: LocalId,
    ptr_ty: ValType,
    offset: u32,
) {
    local_get(instrs, staging);
    if offset == 0 {
        return;
    }
    constant_ptr(instrs, ptr_ty, u64::from(offset));
    binop(
        instrs,
        match ptr_ty {
            ValType::I32 => BinaryOp::I32Add,
            ValType::I64 => BinaryOp::I64Add,
            other => unreachable!("unsupported exception staging pointer type {other:?}"),
        },
    );
}

fn local_get(instrs: &mut Vec<(Instr, InstrLocId)>, local: LocalId) {
    push(instrs, Instr::LocalGet(LocalGet { local }));
}

fn local_set(instrs: &mut Vec<(Instr, InstrLocId)>, local: LocalId) {
    push(instrs, Instr::LocalSet(LocalSet { local }));
}

fn call(instrs: &mut Vec<(Instr, InstrLocId)>, function: FunctionId) {
    push(instrs, Instr::Call(Call { func: function }));
}

fn binop(instrs: &mut Vec<(Instr, InstrLocId)>, op: BinaryOp) {
    push(instrs, Instr::Binop(Binop { op }));
}

fn unop(instrs: &mut Vec<(Instr, InstrLocId)>, op: UnaryOp) {
    push(instrs, Instr::Unop(Unop { op }));
}
