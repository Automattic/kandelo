//! Activation-owned codecs for WebAssembly GC references.
//!
//! The durable representation is a scalar recipe graph in copied linear
//! memory. A process-owned `anyref` table is only a transaction-local routing
//! bus: slot zero carries one synchronous probe value and slot `recipe + 1`
//! carries the parent or freshly reconstructed child identity. The host clears
//! every slot on successful replay, abort, and exec.
//!
//! Immutable arrays need constructor provenance. Unlike structs, an arbitrary
//! immutable array cannot be populated after allocation, and
//! `array.new_fixed` has a statically encoded arity. Planning therefore gives
//! every non-generic constructor site a deterministic layout id so replay can
//! execute the same typed constructor in the fresh instance.

use std::collections::{HashMap, HashSet};

use anyhow::{Result, ensure};
use walrus::{
    AbstractHeapType, CompositeType, DataId, ElementId, FieldType, FunctionBuilder, FunctionId,
    FunctionKind, GlobalId, HeapType, ImportKind, LocalFunction, LocalId, MemoryId, Module,
    RawCustomSection, RefType, StorageType, TableId, TypeId, ValType,
    ir::{
        AnyConvertExtern, ArrayGet, ArrayLen, ArrayNew, ArrayNewData, ArrayNewDefault,
        ArrayNewElem, ArrayNewFixed, ArraySet, BinaryOp, Binop, Br, BrIf, Call, Const,
        ExternConvertAny, GlobalGet, IfElse, Instr, InstrLocId, Load, LoadKind, LocalGet, LocalSet,
        LocalTee, Loop, MemArg, RefAsNonNull, RefCast, RefFunc, RefI31, RefIsNull, RefNull,
        RefTest, Return, Store, StoreKind, StructGet, StructGetU, StructNew, StructNewDefault,
        StructSet, TableGet, TableSet, Throw, TryTable, TryTableCatch, UnaryOp, Unop, Unreachable,
        Value, Visitor, VisitorMut, dfs_in_order, dfs_pre_order_mut,
    },
};

use crate::{module_exception_codec, runtime};
use wasm_posix_shared::abi::{
    WPK_FORK_EXCEPTION_IMPORT_ACTIVATION, WPK_FORK_GC_CODEC_FIELD_RECORD_SIZE,
    WPK_FORK_GC_CODEC_HEADER_SIZE, WPK_FORK_GC_CODEC_LAYOUT_RECORD_SIZE, WPK_FORK_GC_CODEC_MAGIC,
    WPK_FORK_GC_CODEC_SECTION, WPK_FORK_GC_CODEC_VERSION, WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
    WPK_FORK_REFERENCE_EXPORT_GC_ALLOCATE, WPK_FORK_REFERENCE_EXPORT_GC_ENCODE_SLOT,
    WPK_FORK_REFERENCE_EXPORT_GC_FILL, WPK_FORK_REFERENCE_EXPORT_GC_PROBE,
    WPK_FORK_REFERENCE_EXPORT_GC_PUBLISH_EXTERNREF, WPK_FORK_REFERENCE_IMPORT_GC_BROKER_ENCODE,
    WPK_FORK_REFERENCE_IMPORT_GC_CAPTURE_LAYOUT, WPK_FORK_REFERENCE_IMPORT_GC_CLAIM,
    WPK_FORK_REFERENCE_IMPORT_GC_DEFINE, WPK_FORK_REFERENCE_IMPORT_GC_I31,
    WPK_FORK_REFERENCE_IMPORT_GC_LOAD, WPK_FORK_REFERENCE_IMPORT_GC_LOOKUP,
    WPK_FORK_REFERENCE_IMPORT_GC_PAYLOAD_LEN, WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_BEGIN,
    WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_END, WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_REF,
    WPK_FORK_REFERENCE_IMPORT_GC_ROUTE, WPK_FORK_REFERENCE_IMPORT_GC_TRANSIT,
};

pub const FORMAT_SECTION: &str = WPK_FORK_GC_CODEC_SECTION;
pub const FORMAT_MAGIC: [u8; 4] = WPK_FORK_GC_CODEC_MAGIC;
pub const FORMAT_VERSION: u16 = WPK_FORK_GC_CODEC_VERSION;
pub const FORMAT_HEADER_SIZE: u16 = WPK_FORK_GC_CODEC_HEADER_SIZE;
pub const FORMAT_LAYOUT_RECORD_SIZE: u16 = WPK_FORK_GC_CODEC_LAYOUT_RECORD_SIZE;
pub const FORMAT_FIELD_RECORD_SIZE: u16 = WPK_FORK_GC_CODEC_FIELD_RECORD_SIZE;

pub const KIND_STRUCT: u8 = 1;
pub const KIND_ARRAY: u8 = 2;

pub const CONSTRUCTOR_STRUCT: u8 = 0;
pub const CONSTRUCTOR_ARRAY_GENERIC: u8 = 1;
pub const CONSTRUCTOR_ARRAY_NEW: u8 = 2;
pub const CONSTRUCTOR_ARRAY_DEFAULT: u8 = 3;
pub const CONSTRUCTOR_ARRAY_FIXED: u8 = 4;
pub const CONSTRUCTOR_ARRAY_DATA: u8 = 5;
pub const CONSTRUCTOR_ARRAY_ELEMENT: u8 = 6;

pub const LAYOUT_FLAG_REQUIRES_PROVENANCE: u16 = 1 << 0;
pub const LAYOUT_FLAG_DEFAULTABLE_SHELL: u16 = 1 << 1;
pub const LAYOUT_KNOWN_FLAGS: u16 = LAYOUT_FLAG_REQUIRES_PROVENANCE | LAYOUT_FLAG_DEFAULTABLE_SHELL;

pub const FIELD_FLAG_MUTABLE: u8 = 1 << 0;
pub const FIELD_FLAG_NULLABLE: u8 = 1 << 1;
pub const FIELD_FLAG_REFERENCE: u8 = 1 << 2;
pub const FIELD_FLAG_ALLOCATION_DEPENDENCY: u8 = 1 << 3;
pub const FIELD_KNOWN_FLAGS: u8 = FIELD_FLAG_MUTABLE
    | FIELD_FLAG_NULLABLE
    | FIELD_FLAG_REFERENCE
    | FIELD_FLAG_ALLOCATION_DEPENDENCY;

pub const STORAGE_I8: u8 = 1;
pub const STORAGE_I16: u8 = 2;
pub const STORAGE_I32: u8 = 3;
pub const STORAGE_I64: u8 = 4;
pub const STORAGE_F32: u8 = 5;
pub const STORAGE_F64: u8 = 6;
pub const STORAGE_V128: u8 = 7;
pub const STORAGE_REFERENCE: u8 = 8;

const NO_ORDINAL: u32 = u32::MAX;

pub const HOST_IMPORT_MODULE: &str = WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE;
pub const IMPORT_TRANSIT_TABLE: &str = WPK_FORK_REFERENCE_IMPORT_GC_TRANSIT;
pub const IMPORT_LOOKUP: &str = WPK_FORK_REFERENCE_IMPORT_GC_LOOKUP;
pub const IMPORT_CLAIM: &str = WPK_FORK_REFERENCE_IMPORT_GC_CLAIM;
pub const IMPORT_I31: &str = WPK_FORK_REFERENCE_IMPORT_GC_I31;
pub const IMPORT_DEFINE: &str = WPK_FORK_REFERENCE_IMPORT_GC_DEFINE;
pub const IMPORT_ROUTE: &str = WPK_FORK_REFERENCE_IMPORT_GC_ROUTE;
pub const IMPORT_PAYLOAD_LEN: &str = WPK_FORK_REFERENCE_IMPORT_GC_PAYLOAD_LEN;
pub const IMPORT_LOAD: &str = WPK_FORK_REFERENCE_IMPORT_GC_LOAD;
pub const IMPORT_BROKER_ENCODE: &str = WPK_FORK_REFERENCE_IMPORT_GC_BROKER_ENCODE;
pub const IMPORT_CAPTURE_LAYOUT: &str = WPK_FORK_REFERENCE_IMPORT_GC_CAPTURE_LAYOUT;
pub const IMPORT_PROVENANCE_BEGIN: &str = WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_BEGIN;
pub const IMPORT_PROVENANCE_REF: &str = WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_REF;
pub const IMPORT_PROVENANCE_END: &str = WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_END;

pub const EXPORT_PROBE: &str = WPK_FORK_REFERENCE_EXPORT_GC_PROBE;
pub const EXPORT_ENCODE_SLOT: &str = WPK_FORK_REFERENCE_EXPORT_GC_ENCODE_SLOT;
pub const EXPORT_ALLOCATE: &str = WPK_FORK_REFERENCE_EXPORT_GC_ALLOCATE;
pub const EXPORT_FILL: &str = WPK_FORK_REFERENCE_EXPORT_GC_FILL;
pub const EXPORT_PUBLISH_EXTERNREF: &str = WPK_FORK_REFERENCE_EXPORT_GC_PUBLISH_EXTERNREF;
pub const LOCAL_ENCODE_ANYREF: &str = "__wpk_fork_ref_encode_anyref";
pub const LOCAL_DECODE_ANYREF: &str = "__wpk_fork_ref_decode_anyref";
pub const LOCAL_ENCODE_EXTERNREF: &str = "__wpk_fork_ref_encode_externref";
pub const LOCAL_DECODE_EXTERNREF: &str = "__wpk_fork_ref_decode_externref";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GcLayoutKind {
    Struct,
    Array,
}

impl GcLayoutKind {
    fn wire(self) -> u8 {
        match self {
            Self::Struct => KIND_STRUCT,
            Self::Array => KIND_ARRAY,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GcConstructorKind {
    Struct,
    ArrayGeneric,
    ArrayNew,
    ArrayDefault,
    ArrayFixed { len: u32 },
    ArrayData { segment_ordinal: u32 },
    ArrayElement { segment_ordinal: u32 },
}

impl GcConstructorKind {
    fn wire(self) -> u8 {
        match self {
            Self::Struct => CONSTRUCTOR_STRUCT,
            Self::ArrayGeneric => CONSTRUCTOR_ARRAY_GENERIC,
            Self::ArrayNew => CONSTRUCTOR_ARRAY_NEW,
            Self::ArrayDefault => CONSTRUCTOR_ARRAY_DEFAULT,
            Self::ArrayFixed { .. } => CONSTRUCTOR_ARRAY_FIXED,
            Self::ArrayData { .. } => CONSTRUCTOR_ARRAY_DATA,
            Self::ArrayElement { .. } => CONSTRUCTOR_ARRAY_ELEMENT,
        }
    }

    fn auxiliary(self) -> u32 {
        match self {
            Self::Struct | Self::ArrayGeneric | Self::ArrayNew | Self::ArrayDefault => 0,
            Self::ArrayFixed { len } => len,
            Self::ArrayData { segment_ordinal } | Self::ArrayElement { segment_ordinal } => {
                segment_ordinal
            }
        }
    }

    fn requires_provenance(self) -> bool {
        !matches!(self, Self::Struct | Self::ArrayGeneric)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct GcFieldLayout {
    pub field: FieldType,
    pub scalar_offset: Option<u32>,
    pub reference_ordinal: Option<u32>,
    pub allocation_dependency: bool,
}

impl GcFieldLayout {
    pub fn is_allocation_dependency(self) -> bool {
        self.allocation_dependency
    }
}

#[derive(Debug, Clone)]
pub struct GcLayout {
    pub id: u32,
    pub type_id: TypeId,
    pub type_ordinal: u32,
    /// Base type layout accepted by `capture_layout` for this constructor.
    pub base_layout_id: u32,
    pub kind: GcLayoutKind,
    pub constructor: GcConstructorKind,
    pub scalar_len_or_stride: u32,
    pub fields: Vec<GcFieldLayout>,
    pub super_type_ordinal: Option<u32>,
    pub subtype_depth: u32,
    pub defaultable_shell: bool,
    /// The current fields are not sufficient to allocate a safe shell.
    ///
    /// For immutable fields the final snapshot values are constructor inputs.
    /// Mutable non-null fields can have diverged from their constructor inputs,
    /// so their original seed references are retained by a weak-keyed
    /// provenance record and serialized only if the aggregate reaches fork.
    pub requires_provenance: bool,
    /// Constructor-only scalar bytes prepended to the snapshot scalar payload.
    pub provenance_scalar_len: u32,
    /// Constructor-only recipe ids prepended to the snapshot edge vector.
    pub provenance_reference_count: u32,
}

#[derive(Debug, Clone)]
pub struct GcCodecPlan {
    layouts: Vec<GcLayout>,
    dispatch_layouts: Vec<u32>,
}

impl GcCodecPlan {
    pub fn layouts(&self) -> &[GcLayout] {
        &self.layouts
    }

    /// Base layouts ordered most-specific-first for exact dynamic dispatch.
    pub fn dispatch_layouts(&self) -> &[u32] {
        &self.dispatch_layouts
    }

    pub fn descriptor(&self) -> Vec<u8> {
        encode_descriptor(self)
    }
}

#[derive(Debug, Clone, Copy)]
struct HostImports {
    activation: GlobalId,
    lookup: FunctionId,
    claim: FunctionId,
    i31: FunctionId,
    define: FunctionId,
    route: FunctionId,
    payload_len: FunctionId,
    load: FunctionId,
    broker_encode: FunctionId,
    capture_layout: FunctionId,
    provenance_begin: FunctionId,
    provenance_ref: FunctionId,
    provenance_end: FunctionId,
}

/// Stubs are declared before the exception codec so an exception payload that
/// contains an internal GC reference calls back into this module-local codec,
/// never through a typed JavaScript `anyref` import.
#[derive(Debug)]
pub struct DeclaredGcCodec {
    pub encode_anyref: FunctionId,
    pub decode_anyref: FunctionId,
    pub encode_externref: FunctionId,
    pub decode_externref: FunctionId,
    pub probe: FunctionId,
    pub encode_slot: FunctionId,
    pub allocate: FunctionId,
    pub fill: FunctionId,
    pub publish_externref: FunctionId,
    pub transit: TableId,
    pub memory: MemoryId,
    pub ptr_ty: ValType,
    plan: GcCodecPlan,
    imports: HostImports,
    probe_args: Vec<LocalId>,
    encode_anyref_args: Vec<LocalId>,
    decode_anyref_args: Vec<LocalId>,
    encode_externref_args: Vec<LocalId>,
    decode_externref_args: Vec<LocalId>,
    encode_slot_args: Vec<LocalId>,
    allocate_args: Vec<LocalId>,
    fill_args: Vec<LocalId>,
    publish_externref_args: Vec<LocalId>,
}

#[derive(Debug, Clone, Copy)]
pub struct InjectedGcCodec {
    pub encode_anyref: FunctionId,
    pub decode_anyref: FunctionId,
    pub encode_externref: FunctionId,
    pub decode_externref: FunctionId,
    pub probe: FunctionId,
    pub encode_slot: FunctionId,
    pub allocate: FunctionId,
    pub fill: FunctionId,
    pub publish_externref: FunctionId,
    pub transit: TableId,
}

/// Freeze source GC types and install the versioned host surface.
///
/// Emission is split from declaration because exception payloads and GC
/// fields can recursively refer to each other. The two codecs first exchange
/// typed local function ids and only then emit their bodies.
pub fn declare(module: &mut Module, memory: MemoryId) -> Result<DeclaredGcCodec> {
    let plan = plan(module)?;
    let mut source_functions: Vec<_> = module
        .funcs
        .iter()
        .filter_map(|function| {
            matches!(function.kind, FunctionKind::Local(_)).then_some(function.id())
        })
        .collect();
    source_functions.sort();
    let ptr_ty = if module.memories.get(memory).memory64 {
        ValType::I64
    } else {
        ValType::I32
    };
    let (transit, _) = module.add_import_table(
        HOST_IMPORT_MODULE,
        IMPORT_TRANSIT_TABLE,
        false,
        1,
        None,
        RefType::ANYREF,
    );
    let imports = inject_host_imports(module, ptr_ty);
    inject_provenance_wrappers(module, &plan, transit, imports, &source_functions)?;
    let (encode_anyref, encode_anyref_args) = add_stub(
        module,
        &[ValType::Ref(RefType::ANYREF)],
        &[ValType::I32],
        LOCAL_ENCODE_ANYREF,
    );
    let (decode_anyref, decode_anyref_args) = add_stub(
        module,
        &[ValType::I32],
        &[ValType::Ref(RefType::ANYREF)],
        LOCAL_DECODE_ANYREF,
    );
    let (encode_externref, encode_externref_args) = add_stub(
        module,
        &[ValType::Ref(RefType::EXTERNREF)],
        &[ValType::I32],
        LOCAL_ENCODE_EXTERNREF,
    );
    let (decode_externref, decode_externref_args) = add_stub(
        module,
        &[ValType::I32],
        &[ValType::Ref(RefType::EXTERNREF)],
        LOCAL_DECODE_EXTERNREF,
    );
    let (probe, probe_args) = add_stub(module, &[ValType::I32], &[ValType::I64], EXPORT_PROBE);
    let (encode_slot, encode_slot_args) =
        add_stub(module, &[ValType::I32], &[ValType::I32], EXPORT_ENCODE_SLOT);
    let (allocate, allocate_args) = add_stub(module, &[ValType::I32], &[], EXPORT_ALLOCATE);
    let (fill, fill_args) = add_stub(module, &[ValType::I32], &[], EXPORT_FILL);
    let (publish_externref, publish_externref_args) = add_stub(
        module,
        &[ValType::I32, ValType::Ref(RefType::EXTERNREF)],
        &[],
        EXPORT_PUBLISH_EXTERNREF,
    );

    for (name, function) in [
        (EXPORT_PROBE, probe),
        (EXPORT_ENCODE_SLOT, encode_slot),
        (EXPORT_ALLOCATE, allocate),
        (EXPORT_FILL, fill),
        (EXPORT_PUBLISH_EXTERNREF, publish_externref),
    ] {
        module.exports.add(name, function);
    }
    replace_descriptor(module, &plan);

    Ok(DeclaredGcCodec {
        encode_anyref,
        decode_anyref,
        encode_externref,
        decode_externref,
        probe,
        encode_slot,
        allocate,
        fill,
        publish_externref,
        transit,
        memory,
        ptr_ty,
        plan,
        imports,
        probe_args,
        encode_anyref_args,
        decode_anyref_args,
        encode_externref_args,
        decode_externref_args,
        encode_slot_args,
        allocate_args,
        fill_args,
        publish_externref_args,
    })
}

fn inject_provenance_wrappers(
    module: &mut Module,
    plan: &GcCodecPlan,
    transit: TableId,
    imports: HostImports,
    source_functions: &[FunctionId],
) -> Result<()> {
    let mut struct_wrappers = HashMap::new();
    let mut array_wrappers = HashMap::new();
    for layout in plan.layouts() {
        let needs_wrapper = match layout.constructor {
            GcConstructorKind::Struct => layout.provenance_reference_count != 0,
            GcConstructorKind::ArrayGeneric => false,
            _ => true,
        };
        if !needs_wrapper {
            continue;
        }
        let wrapper = add_provenance_wrapper(module, layout, transit, imports)?;
        match layout.constructor {
            GcConstructorKind::Struct => {
                struct_wrappers.insert(layout.type_id, wrapper);
            }
            constructor => {
                array_wrappers.insert(
                    (layout.type_id, constructor.wire(), constructor.auxiliary()),
                    wrapper,
                );
            }
        }
    }

    let data_ordinals: HashMap<DataId, u32> = module
        .data
        .iter()
        .enumerate()
        .map(|(ordinal, data)| (data.id(), ordinal as u32))
        .collect();
    let element_ordinals: HashMap<ElementId, u32> = module
        .elements
        .iter()
        .enumerate()
        .map(|(ordinal, element)| (element.id(), ordinal as u32))
        .collect();
    struct Rewrite {
        structs: HashMap<TypeId, FunctionId>,
        arrays: HashMap<(TypeId, u8, u32), FunctionId>,
        data_ordinals: HashMap<DataId, u32>,
        element_ordinals: HashMap<ElementId, u32>,
    }
    impl VisitorMut for Rewrite {
        fn visit_instr_mut(&mut self, instr: &mut Instr, _loc: &mut InstrLocId) {
            let wrapper = match instr {
                Instr::StructNew(StructNew { ty }) => self.structs.get(ty).copied(),
                Instr::ArrayNew(ArrayNew { ty }) => {
                    self.arrays.get(&(*ty, CONSTRUCTOR_ARRAY_NEW, 0)).copied()
                }
                Instr::ArrayNewDefault(ArrayNewDefault { ty }) => self
                    .arrays
                    .get(&(*ty, CONSTRUCTOR_ARRAY_DEFAULT, 0))
                    .copied(),
                Instr::ArrayNewFixed(ArrayNewFixed { ty, len }) => self
                    .arrays
                    .get(&(*ty, CONSTRUCTOR_ARRAY_FIXED, *len))
                    .copied(),
                Instr::ArrayNewData(ArrayNewData { ty, data }) => self
                    .data_ordinals
                    .get(data)
                    .and_then(|ordinal| self.arrays.get(&(*ty, CONSTRUCTOR_ARRAY_DATA, *ordinal)))
                    .copied(),
                Instr::ArrayNewElem(ArrayNewElem { ty, elem }) => self
                    .element_ordinals
                    .get(elem)
                    .and_then(|ordinal| {
                        self.arrays.get(&(*ty, CONSTRUCTOR_ARRAY_ELEMENT, *ordinal))
                    })
                    .copied(),
                _ => None,
            };
            if let Some(wrapper) = wrapper {
                *instr = Instr::Call(Call { func: wrapper });
            }
        }
    }
    let mut rewrite = Rewrite {
        structs: struct_wrappers,
        arrays: array_wrappers,
        data_ordinals,
        element_ordinals,
    };
    for &function in source_functions {
        let local = local_mut(module, function);
        let entry = local.entry_block();
        dfs_pre_order_mut(&mut rewrite, local, entry);
    }
    Ok(())
}

fn add_provenance_wrapper(
    module: &mut Module,
    layout: &GcLayout,
    transit: TableId,
    imports: HostImports,
) -> Result<FunctionId> {
    let params: Vec<ValType> = match layout.constructor {
        GcConstructorKind::Struct => layout
            .fields
            .iter()
            .map(|field| field.field.element_type.unpack())
            .collect(),
        GcConstructorKind::ArrayNew => {
            vec![layout.fields[0].field.element_type.unpack(), ValType::I32]
        }
        GcConstructorKind::ArrayDefault
        | GcConstructorKind::ArrayData { .. }
        | GcConstructorKind::ArrayElement { .. } => vec![ValType::I32, ValType::I32],
        GcConstructorKind::ArrayFixed { len } => {
            vec![layout.fields[0].field.element_type.unpack(); len as usize]
        }
        GcConstructorKind::ArrayGeneric => unreachable!(
            "generic GC array layouts never receive provenance wrappers"
        ),
    };
    // `array.new_default` has only its dynamic length operand.
    let params = if matches!(layout.constructor, GcConstructorKind::ArrayDefault) {
        vec![ValType::I32]
    } else {
        params
    };
    let result_ty = ValType::Ref(RefType {
        nullable: false,
        heap_type: HeapType::Concrete(layout.type_id),
    });
    let name = format!("__wpk_fork_ref_gc_construct_{}", layout.id);
    let (wrapper, args) = add_stub(module, &params, &[result_ty], &name);
    let result = module.locals.add(ValType::Ref(RefType {
        nullable: true,
        heap_type: HeapType::Concrete(layout.type_id),
    }));
    let token = module.locals.add(ValType::I32);
    let constructor = match layout.constructor {
        GcConstructorKind::Struct => Instr::StructNew(StructNew { ty: layout.type_id }),
        GcConstructorKind::ArrayNew => Instr::ArrayNew(ArrayNew { ty: layout.type_id }),
        GcConstructorKind::ArrayDefault => {
            Instr::ArrayNewDefault(ArrayNewDefault { ty: layout.type_id })
        }
        GcConstructorKind::ArrayFixed { len } => Instr::ArrayNewFixed(ArrayNewFixed {
            ty: layout.type_id,
            len,
        }),
        GcConstructorKind::ArrayData { segment_ordinal } => {
            let data = module
                .data
                .iter()
                .nth(segment_ordinal as usize)
                .ok_or_else(|| anyhow::anyhow!("GC provenance data segment disappeared"))?
                .id();
            Instr::ArrayNewData(ArrayNewData {
                ty: layout.type_id,
                data,
            })
        }
        GcConstructorKind::ArrayElement { segment_ordinal } => {
            let elem = module
                .elements
                .iter()
                .nth(segment_ordinal as usize)
                .ok_or_else(|| anyhow::anyhow!("GC provenance element segment disappeared"))?
                .id();
            Instr::ArrayNewElem(ArrayNewElem {
                ty: layout.type_id,
                elem,
            })
        }
        GcConstructorKind::ArrayGeneric => unreachable!(),
    };
    let entry = entry(wrapper, module);
    {
        let instrs = instrs_mut(module, wrapper, entry);
        for &arg in &args {
            local_get(instrs, arg);
        }
        push(instrs, constructor);
        local_set(instrs, result);

        constant_i32(instrs, 0);
        local_get(instrs, result);
        push(instrs, Instr::TableSet(TableSet { table: transit }));
        constant_i32(instrs, 0);
        push(
            instrs,
            Instr::GlobalGet(GlobalGet {
                global: imports.activation,
            }),
        );
        constant_i32(instrs, layout.base_layout_id as i32);
        constant_i32(instrs, layout.id as i32);
        emit_provenance_scalars(instrs, layout, &args);
        constant_i32(instrs, layout.provenance_reference_count as i32);
        call(instrs, imports.provenance_begin);
        local_set(instrs, token);
        clear_transit_slot(instrs, transit, 0);
    }

    let reference_args = provenance_reference_args(module, layout);
    for (ordinal, arg) in reference_args.into_iter().enumerate() {
        let instrs = instrs_mut(module, wrapper, entry);
        constant_i32(instrs, 0);
        local_get(instrs, args[arg]);
        push(instrs, Instr::TableSet(TableSet { table: transit }));
        local_get(instrs, token);
        constant_i32(instrs, ordinal as i32);
        constant_i32(instrs, 0);
        call(instrs, imports.provenance_ref);
        clear_transit_slot(instrs, transit, 0);
    }
    let instrs = instrs_mut(module, wrapper, entry);
    local_get(instrs, token);
    call(instrs, imports.provenance_end);
    local_get(instrs, result);
    push(instrs, Instr::RefAsNonNull(RefAsNonNull {}));
    Ok(wrapper)
}

fn provenance_reference_args(module: &Module, layout: &GcLayout) -> Vec<usize> {
    match layout.constructor {
        GcConstructorKind::Struct => layout
            .fields
            .iter()
            .enumerate()
            .filter_map(|(index, field)| match field.field.element_type {
                StorageType::Val(ValType::Ref(reference))
                    if field.field.mutable
                        && !reference.nullable
                        && is_internal_gc_reference(module, reference) =>
                {
                    Some(index)
                }
                _ => None,
            })
            .collect(),
        GcConstructorKind::ArrayNew => match layout.fields[0].field.element_type {
            StorageType::Val(ValType::Ref(reference))
                if is_internal_gc_reference(module, reference) =>
            {
                vec![0]
            }
            _ => Vec::new(),
        },
        GcConstructorKind::ArrayFixed { len } => match layout.fields[0].field.element_type {
            StorageType::Val(ValType::Ref(reference))
                if layout.fields[0].field.mutable
                    && !reference.nullable
                    && is_internal_gc_reference(module, reference) =>
            {
                (0..len as usize).collect()
            }
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

fn emit_provenance_scalars(
    instrs: &mut Vec<(Instr, InstrLocId)>,
    layout: &GcLayout,
    args: &[LocalId],
) {
    match layout.constructor {
        GcConstructorKind::ArrayNew => match layout.fields[0].field.element_type {
            StorageType::Val(ValType::Ref(_)) => {
                constant_i64(instrs, 0);
                constant_i64(instrs, 0);
            }
            storage => {
                emit_scalar_as_i64_pair(instrs, storage, args[0]);
            }
        },
        GcConstructorKind::ArrayData { .. } | GcConstructorKind::ArrayElement { .. } => {
            // WHY: the wire record owns exactly eight provenance bytes for the
            // two i32 constructor operands. Pack both into scalarLo; the host
            // intentionally truncates scalarLo/scalarHi to that declared
            // length and would otherwise discard the second operand.
            local_get(instrs, args[0]);
            push(
                instrs,
                Instr::Unop(Unop {
                    op: UnaryOp::I64ExtendUI32,
                }),
            );
            local_get(instrs, args[1]);
            push(
                instrs,
                Instr::Unop(Unop {
                    op: UnaryOp::I64ExtendUI32,
                }),
            );
            constant_i64(instrs, 32);
            binop(instrs, BinaryOp::I64Shl);
            binop(instrs, BinaryOp::I64Or);
            constant_i64(instrs, 0);
        }
        _ => {
            constant_i64(instrs, 0);
            constant_i64(instrs, 0);
        }
    }
}

fn emit_scalar_as_i64_pair(
    instrs: &mut Vec<(Instr, InstrLocId)>,
    storage: StorageType,
    value: LocalId,
) {
    match storage {
        StorageType::I8 | StorageType::I16 | StorageType::Val(ValType::I32) => {
            local_get(instrs, value);
            push(
                instrs,
                Instr::Unop(Unop {
                    op: UnaryOp::I64ExtendUI32,
                }),
            );
            constant_i64(instrs, 0);
        }
        StorageType::Val(ValType::I64) => {
            local_get(instrs, value);
            constant_i64(instrs, 0);
        }
        StorageType::Val(ValType::F32) => {
            local_get(instrs, value);
            push(
                instrs,
                Instr::Unop(Unop {
                    op: UnaryOp::I32ReinterpretF32,
                }),
            );
            push(
                instrs,
                Instr::Unop(Unop {
                    op: UnaryOp::I64ExtendUI32,
                }),
            );
            constant_i64(instrs, 0);
        }
        StorageType::Val(ValType::F64) => {
            local_get(instrs, value);
            push(
                instrs,
                Instr::Unop(Unop {
                    op: UnaryOp::I64ReinterpretF64,
                }),
            );
            constant_i64(instrs, 0);
        }
        StorageType::Val(ValType::V128) => {
            local_get(instrs, value);
            push(
                instrs,
                Instr::Unop(Unop {
                    op: UnaryOp::I64x2ExtractLane { idx: 0 },
                }),
            );
            local_get(instrs, value);
            push(
                instrs,
                Instr::Unop(Unop {
                    op: UnaryOp::I64x2ExtractLane { idx: 1 },
                }),
            );
        }
        StorageType::Val(ValType::Ref(_)) => unreachable!(),
    }
}

/// Emit the type-test probe. The remaining functions are emitted once their
/// recursive reference codec dependencies have been declared.
pub fn emit_probe(module: &mut Module, codec: &DeclaredGcCodec) {
    let value = module.locals.add(ValType::Ref(RefType::ANYREF));
    let entry = entry(codec.probe, module);
    {
        let instrs = instrs_mut(module, codec.probe, entry);
        local_get(instrs, codec.probe_args[0]);
        push(
            instrs,
            Instr::TableGet(TableGet {
                table: codec.transit,
            }),
        );
        local_set(instrs, value);
    }

    for &layout_id in codec.plan.dispatch_layouts() {
        let layout = &codec.plan.layouts()[(layout_id - 1) as usize];
        let yes = dangling(module, codec.probe, walrus::ir::InstrSeqType::Simple(None));
        {
            let instrs = instrs_mut(module, codec.probe, yes);
            let packed = (u64::from(layout.type_ordinal) << 32) | u64::from(layout.id);
            push(
                instrs,
                Instr::Const(Const {
                    value: Value::I64(packed as i64),
                }),
            );
            push(instrs, Instr::Return(Return {}));
        }
        let no = dangling(module, codec.probe, walrus::ir::InstrSeqType::Simple(None));
        let instrs = instrs_mut(module, codec.probe, entry);
        local_get(instrs, value);
        push(
            instrs,
            Instr::RefTest(RefTest {
                nullable: false,
                heap_type: HeapType::Concrete(layout.type_id),
            }),
        );
        push(
            instrs,
            Instr::IfElse(IfElse {
                consequent: yes,
                alternative: no,
            }),
        );
    }
    let instrs = instrs_mut(module, codec.probe, entry);
    push(
        instrs,
        Instr::Const(Const {
            value: Value::I64(0),
        }),
    );
}

pub fn finish_declaration(
    module: &mut Module,
    codec: DeclaredGcCodec,
    exception: module_exception_codec::InjectedExceptionCodec,
    runtime: &runtime::Runtime,
) -> Result<InjectedGcCodec> {
    let deps = emit_dependencies(module, exception, runtime)?;
    let seeds = ReferenceSeeds::inject(module, &codec.plan);
    emit_probe(module, &codec);
    emit_encode_anyref(module, &codec, deps);
    emit_decode_anyref(module, &codec);
    emit_externref_bridge(module, &codec);
    emit_encode_slot(module, &codec);
    emit_publish_externref(module, &codec);
    // Allocation/fill are deliberately separate. Mutable/defaultable shells
    // are allocated for the entire graph before any edge is filled; immutable
    // and non-defaultable layouts are constructed in dependency order.
    emit_allocate(module, &codec, deps, &seeds)?;
    emit_fill(module, &codec, deps)?;
    Ok(InjectedGcCodec {
        encode_anyref: codec.encode_anyref,
        decode_anyref: codec.decode_anyref,
        encode_externref: codec.encode_externref,
        decode_externref: codec.decode_externref,
        probe: codec.probe,
        encode_slot: codec.encode_slot,
        allocate: codec.allocate,
        fill: codec.fill,
        publish_externref: codec.publish_externref,
        transit: codec.transit,
    })
}

#[derive(Debug, Clone, Copy)]
struct EmitDependencies {
    activation: GlobalId,
    codecs: runtime::ReferenceCodecs,
    vector_begin: FunctionId,
    vector_append: FunctionId,
    vector_finish: FunctionId,
    vector_get: FunctionId,
    scratch_reserve: FunctionId,
    scratch_release: FunctionId,
}

#[derive(Debug)]
struct ReferenceSeeds {
    abstract_func: FunctionId,
    concrete_funcs: HashMap<TypeId, FunctionId>,
    exn: FunctionId,
}

impl ReferenceSeeds {
    fn inject(module: &mut Module, plan: &GcCodecPlan) -> Self {
        let abstract_func = add_trapping_function(module, &[], &[], "__wpk_fork_ref_seed_func");
        let mut concrete_funcs = HashMap::new();
        for layout in plan.layouts() {
            for field in &layout.fields {
                let StorageType::Val(ValType::Ref(reference)) = field.field.element_type else {
                    continue;
                };
                let ty = match reference.heap_type {
                    HeapType::Concrete(ty) | HeapType::Exact(ty)
                        if module.types.get(ty).is_function() =>
                    {
                        ty
                    }
                    _ => continue,
                };
                concrete_funcs.entry(ty).or_insert_with(|| {
                    let signature = module.types.get(ty);
                    let params = signature.params().to_vec();
                    let results = signature.results().to_vec();
                    add_trapping_function(
                        module,
                        &params,
                        &results,
                        &format!("__wpk_fork_ref_seed_func_{}", ty.index()),
                    )
                });
            }
        }
        let exn = add_seed_exception_function(module);
        Self {
            abstract_func,
            concrete_funcs,
            exn,
        }
    }
}

fn add_trapping_function(
    module: &mut Module,
    params: &[ValType],
    results: &[ValType],
    name: &str,
) -> FunctionId {
    let (function, _) = add_stub(module, params, results, name);
    push(
        instrs_mut(module, function, entry(function, module)),
        Instr::Unreachable(Unreachable {}),
    );
    function
}

fn add_seed_exception_function(module: &mut Module) -> FunctionId {
    let tag_ty = module.types.add(&[], &[]);
    let tag = module.tags.add(tag_ty);
    module.tags.get_mut(tag).name = Some("__wpk_fork_ref_seed_tag".into());
    let result_ty = ValType::Ref(RefType {
        nullable: false,
        heap_type: HeapType::Abstract(AbstractHeapType::Exn),
    });
    let (function, _) = add_stub(module, &[], &[result_ty], "__wpk_fork_ref_seed_exn");
    let capture = dangling(
        module,
        function,
        walrus::ir::InstrSeqType::Simple(Some(result_ty)),
    );
    let body = dangling(module, function, walrus::ir::InstrSeqType::Simple(None));
    push(
        instrs_mut(module, function, body),
        Instr::Throw(Throw { tag }),
    );
    {
        let instrs = instrs_mut(module, function, capture);
        push(
            instrs,
            Instr::TryTable(TryTable {
                seq: body,
                catches: vec![TryTableCatch::CatchAllRef { label: capture }],
            }),
        );
        push(instrs, Instr::Unreachable(Unreachable {}));
    }
    push(
        instrs_mut(module, function, entry(function, module)),
        Instr::Block(walrus::ir::Block { seq: capture }),
    );
    function
}

fn emit_dependencies(
    module: &Module,
    exception: module_exception_codec::InjectedExceptionCodec,
    runtime: &runtime::Runtime,
) -> Result<EmitDependencies> {
    let activation = find_import_global(
        module,
        module_exception_codec::HOST_IMPORT_MODULE,
        module_exception_codec::IMPORT_ACTIVATION,
    )?;
    let mut codecs = runtime
        .reference_codecs
        .ok_or_else(|| anyhow::anyhow!("GC codec requires linked reference codecs"))?;
    // The exception codec is the exact local owner even if a caller assembled
    // runtime overrides differently.
    codecs.encode_exnref = exception.encode;
    codecs.decode_exnref = exception.decode;
    let vector_begin = runtime
        .reference_vector_begin
        .ok_or_else(|| anyhow::anyhow!("GC codec requires reference-vector begin"))?;
    let vector_append = runtime
        .reference_vector_append
        .ok_or_else(|| anyhow::anyhow!("GC codec requires reference-vector append"))?;
    let vector_finish = runtime
        .reference_vector_finish
        .ok_or_else(|| anyhow::anyhow!("GC codec requires reference-vector finish"))?;
    let vector_get = runtime
        .reference_vector_get
        .ok_or_else(|| anyhow::anyhow!("GC codec requires reference-vector get"))?;
    Ok(EmitDependencies {
        activation,
        codecs,
        vector_begin,
        vector_append,
        vector_finish,
        vector_get,
        scratch_reserve: find_import_function(
            module,
            module_exception_codec::HOST_IMPORT_MODULE,
            module_exception_codec::IMPORT_SCRATCH_RESERVE,
        )?,
        scratch_release: find_import_function(
            module,
            module_exception_codec::HOST_IMPORT_MODULE,
            module_exception_codec::IMPORT_SCRATCH_RELEASE,
        )?,
    })
}

fn find_import_global(module: &Module, import_module: &str, name: &str) -> Result<GlobalId> {
    module
        .imports
        .iter()
        .find_map(|import| {
            (import.module == import_module && import.name == name)
                .then_some(&import.kind)
                .and_then(|kind| match kind {
                    ImportKind::Global(global) => Some(*global),
                    _ => None,
                })
        })
        .ok_or_else(|| anyhow::anyhow!("missing generated import `{import_module}.{name}`"))
}

fn find_import_function(module: &Module, import_module: &str, name: &str) -> Result<FunctionId> {
    module
        .imports
        .iter()
        .find_map(|import| {
            (import.module == import_module && import.name == name)
                .then_some(&import.kind)
                .and_then(|kind| match kind {
                    ImportKind::Function(function) => Some(*function),
                    _ => None,
                })
        })
        .ok_or_else(|| anyhow::anyhow!("missing generated import `{import_module}.{name}`"))
}

fn emit_decode_anyref(module: &mut Module, codec: &DeclaredGcCodec) {
    let recipe = codec.decode_anyref_args[0];
    let null = dangling(
        module,
        codec.decode_anyref,
        walrus::ir::InstrSeqType::Simple(None),
    );
    {
        let instrs = instrs_mut(module, codec.decode_anyref, null);
        push(
            instrs,
            Instr::RefNull(RefNull {
                ty: RefType::ANYREF,
            }),
        );
        push(instrs, Instr::Return(Return {}));
    }
    let nonnull = dangling(
        module,
        codec.decode_anyref,
        walrus::ir::InstrSeqType::Simple(None),
    );
    let entry = entry(codec.decode_anyref, module);
    let instrs = instrs_mut(module, codec.decode_anyref, entry);
    local_get(instrs, recipe);
    push(
        instrs,
        Instr::Unop(Unop {
            op: UnaryOp::I32Eqz,
        }),
    );
    push(
        instrs,
        Instr::IfElse(IfElse {
            consequent: null,
            alternative: nonnull,
        }),
    );
    local_get(instrs, recipe);
    constant_i32(instrs, 1);
    binop(instrs, BinaryOp::I32Add);
    push(
        instrs,
        Instr::TableGet(TableGet {
            table: codec.transit,
        }),
    );
}

fn emit_externref_bridge(module: &mut Module, codec: &DeclaredGcCodec) {
    {
        let entry = entry(codec.encode_externref, module);
        let instrs = instrs_mut(module, codec.encode_externref, entry);
        local_get(instrs, codec.encode_externref_args[0]);
        // WHY: extern.convert_any may have exposed a module-local GC identity
        // as externref. Convert it back inside Wasm before classification so
        // the ordinary typed graph owns it instead of an opaque host handle.
        push(instrs, Instr::AnyConvertExtern(AnyConvertExtern {}));
        call(instrs, codec.encode_anyref);
    }
    {
        let entry = entry(codec.decode_externref, module);
        let instrs = instrs_mut(module, codec.decode_externref, entry);
        local_get(instrs, codec.decode_externref_args[0]);
        call(instrs, codec.decode_anyref);
        push(instrs, Instr::ExternConvertAny(ExternConvertAny {}));
    }
}

fn emit_encode_slot(module: &mut Module, codec: &DeclaredGcCodec) {
    let entry = entry(codec.encode_slot, module);
    let instrs = instrs_mut(module, codec.encode_slot, entry);
    local_get(instrs, codec.encode_slot_args[0]);
    push(
        instrs,
        Instr::TableGet(TableGet {
            table: codec.transit,
        }),
    );
    call(instrs, codec.encode_anyref);
}

fn emit_publish_externref(module: &mut Module, codec: &DeclaredGcCodec) {
    let entry = entry(codec.publish_externref, module);
    let instrs = instrs_mut(module, codec.publish_externref, entry);
    local_get(instrs, codec.publish_externref_args[0]);
    constant_i32(instrs, 1);
    binop(instrs, BinaryOp::I32Add);
    local_get(instrs, codec.publish_externref_args[1]);
    // WHY: JavaScript cannot directly manufacture an `anyref` transit value.
    // The process owner supplies only its canonical externref token; this
    // module-local conversion creates the child-side host reference consumed
    // by the same anyref decoder used for GC graph edges.
    push(instrs, Instr::AnyConvertExtern(AnyConvertExtern {}));
    push(
        instrs,
        Instr::TableSet(TableSet {
            table: codec.transit,
        }),
    );
}

fn emit_encode_anyref(module: &mut Module, codec: &DeclaredGcCodec, deps: EmitDependencies) {
    let value = codec.encode_anyref_args[0];
    let recipe = module.locals.add(ValType::I32);
    let selected_layout = module.locals.add(ValType::I32);

    let null = dangling(
        module,
        codec.encode_anyref,
        walrus::ir::InstrSeqType::Simple(None),
    );
    {
        let instrs = instrs_mut(module, codec.encode_anyref, null);
        constant_i32(instrs, 0);
        push(instrs, Instr::Return(Return {}));
    }
    let nonnull = dangling(
        module,
        codec.encode_anyref,
        walrus::ir::InstrSeqType::Simple(None),
    );

    let i31 = dangling(
        module,
        codec.encode_anyref,
        walrus::ir::InstrSeqType::Simple(None),
    );
    {
        let instrs = instrs_mut(module, codec.encode_anyref, i31);
        local_get(instrs, value);
        push(
            instrs,
            Instr::RefCast(RefCast {
                nullable: false,
                heap_type: HeapType::Abstract(AbstractHeapType::I31),
            }),
        );
        push(instrs, Instr::I31GetS(walrus::ir::I31GetS {}));
        call(instrs, codec.imports.i31);
        local_set(instrs, recipe);
        // Parent replay reads the same process-owned transit table as child
        // replay. Publish i31 identity here because JavaScript receives only
        // its scalar payload and cannot manufacture an `i31ref`.
        local_get(instrs, recipe);
        constant_i32(instrs, 1);
        binop(instrs, BinaryOp::I32Add);
        local_get(instrs, value);
        push(
            instrs,
            Instr::TableSet(TableSet {
                table: codec.transit,
            }),
        );
        local_get(instrs, recipe);
        push(instrs, Instr::Return(Return {}));
    }
    let not_i31 = dangling(
        module,
        codec.encode_anyref,
        walrus::ir::InstrSeqType::Simple(None),
    );

    let existing = dangling(
        module,
        codec.encode_anyref,
        walrus::ir::InstrSeqType::Simple(None),
    );
    {
        let instrs = instrs_mut(module, codec.encode_anyref, existing);
        clear_transit_slot(instrs, codec.transit, 0);
        local_get(instrs, recipe);
        push(instrs, Instr::Return(Return {}));
    }
    let fresh = dangling(
        module,
        codec.encode_anyref,
        walrus::ir::InstrSeqType::Simple(None),
    );

    let entry = entry(codec.encode_anyref, module);
    {
        let instrs = instrs_mut(module, codec.encode_anyref, entry);
        local_get(instrs, value);
        push(instrs, Instr::RefIsNull(RefIsNull {}));
        push(
            instrs,
            Instr::IfElse(IfElse {
                consequent: null,
                alternative: nonnull,
            }),
        );
        local_get(instrs, value);
        push(
            instrs,
            Instr::RefTest(RefTest {
                nullable: false,
                heap_type: HeapType::Abstract(AbstractHeapType::I31),
            }),
        );
        push(
            instrs,
            Instr::IfElse(IfElse {
                consequent: i31,
                alternative: not_i31,
            }),
        );
        constant_i32(instrs, 0);
        local_get(instrs, value);
        push(
            instrs,
            Instr::TableSet(TableSet {
                table: codec.transit,
            }),
        );
        constant_i32(instrs, 0);
        call(instrs, codec.imports.lookup);
        push(instrs, Instr::LocalTee(LocalTee { local: recipe }));
        push(
            instrs,
            Instr::IfElse(IfElse {
                consequent: existing,
                alternative: fresh,
            }),
        );
    }

    for &layout_id in codec.plan.dispatch_layouts() {
        let layout = codec.plan.layouts()[(layout_id - 1) as usize].clone();
        let yes = dangling(
            module,
            codec.encode_anyref,
            walrus::ir::InstrSeqType::Simple(None),
        );
        emit_encode_layout(
            module,
            codec,
            deps,
            yes,
            &layout,
            value,
            recipe,
            selected_layout,
        );
        let no = dangling(
            module,
            codec.encode_anyref,
            walrus::ir::InstrSeqType::Simple(None),
        );
        let instrs = instrs_mut(module, codec.encode_anyref, entry);
        local_get(instrs, value);
        push(
            instrs,
            Instr::RefTest(RefTest {
                nullable: false,
                heap_type: HeapType::Concrete(layout.type_id),
            }),
        );
        push(
            instrs,
            Instr::IfElse(IfElse {
                consequent: yes,
                alternative: no,
            }),
        );
    }

    let instrs = instrs_mut(module, codec.encode_anyref, entry);
    // A structurally canonical GC value may have entered through another
    // module activation. The broker probes registered module-local codecs and
    // routes the shared transit slot without exposing `anyref` to JavaScript.
    constant_i32(instrs, 0);
    call(instrs, codec.imports.broker_encode);
    local_set(instrs, recipe);
    // `broker_encode` grows the shared table through recipe+1. Publish the
    // original internal identity before clearing slot zero so parent replay
    // and a later anyref/externref alias both use the canonical recipe.
    local_get(instrs, recipe);
    constant_i32(instrs, 1);
    binop(instrs, BinaryOp::I32Add);
    local_get(instrs, value);
    push(
        instrs,
        Instr::TableSet(TableSet {
            table: codec.transit,
        }),
    );
    clear_transit_slot(instrs, codec.transit, 0);
    local_get(instrs, recipe);
}

#[allow(clippy::too_many_arguments)]
fn emit_encode_layout(
    module: &mut Module,
    codec: &DeclaredGcCodec,
    deps: EmitDependencies,
    seq: walrus::ir::InstrSeqId,
    layout: &GcLayout,
    value: LocalId,
    recipe: LocalId,
    selected_layout: LocalId,
) {
    let concrete = RefType {
        nullable: true,
        heap_type: HeapType::Concrete(layout.type_id),
    };
    let typed = module.locals.add(ValType::Ref(concrete));
    let staging = module.locals.add(codec.ptr_ty);
    let scalar_len = module.locals.add(ValType::I32);
    let vector = module.locals.add(ValType::I32);
    let array_len = (layout.kind == GcLayoutKind::Array).then(|| module.locals.add(ValType::I32));

    {
        let instrs = instrs_mut(module, codec.encode_anyref, seq);
        constant_i32(instrs, 0);
        call(instrs, codec.imports.claim);
        local_set(instrs, recipe);

        // Claim grows the process-owned transit table through recipe+1 before
        // returning. Publishing the source identity before recursive fields
        // is what makes aliases and cycles terminate deterministically.
        local_get(instrs, recipe);
        constant_i32(instrs, 1);
        binop(instrs, BinaryOp::I32Add);
        local_get(instrs, value);
        push(
            instrs,
            Instr::TableSet(TableSet {
                table: codec.transit,
            }),
        );

        constant_i32(instrs, 0);
        push(
            instrs,
            Instr::GlobalGet(GlobalGet {
                global: deps.activation,
            }),
        );
        constant_i32(instrs, layout.id as i32);
        call(instrs, codec.imports.capture_layout);
        local_set(instrs, selected_layout);

        local_get(instrs, value);
        push(
            instrs,
            Instr::RefCast(RefCast {
                nullable: true,
                heap_type: HeapType::Concrete(layout.type_id),
            }),
        );
        local_set(instrs, typed);
        clear_transit_slot(instrs, codec.transit, 0);
    }

    match layout.kind {
        GcLayoutKind::Struct => emit_encode_struct_payload(
            module,
            codec,
            deps,
            seq,
            layout,
            typed,
            recipe,
            selected_layout,
            staging,
            scalar_len,
            vector,
        ),
        GcLayoutKind::Array => emit_encode_array_payload(
            module,
            codec,
            deps,
            seq,
            layout,
            typed,
            recipe,
            selected_layout,
            staging,
            scalar_len,
            vector,
            array_len.expect("array length local"),
        ),
    }
    let instrs = instrs_mut(module, codec.encode_anyref, seq);
    local_get(instrs, recipe);
    push(instrs, Instr::Return(Return {}));
}

#[allow(clippy::too_many_arguments)]
fn emit_encode_struct_payload(
    module: &mut Module,
    codec: &DeclaredGcCodec,
    deps: EmitDependencies,
    seq: walrus::ir::InstrSeqId,
    layout: &GcLayout,
    typed: LocalId,
    recipe: LocalId,
    selected_layout: LocalId,
    staging: LocalId,
    scalar_len: LocalId,
    vector: LocalId,
) {
    let reference_count = layout
        .fields
        .iter()
        .filter(|field| field.reference_ordinal.is_some())
        .count() as u32;
    let reservation_len = layout.scalar_len_or_stride.max(1);
    let encoders: Vec<_> = layout
        .fields
        .iter()
        .map(|field| match field.field.element_type {
            StorageType::Val(ValType::Ref(reference)) => {
                Some(reference_encoder(module, deps.codecs, reference))
            }
            _ => None,
        })
        .collect();

    let instrs = instrs_mut(module, codec.encode_anyref, seq);
    constant_i32(instrs, layout.scalar_len_or_stride as i32);
    local_set(instrs, scalar_len);
    constant_ptr(instrs, codec.ptr_ty, u64::from(reservation_len));
    call(instrs, deps.scratch_reserve);
    local_set(instrs, staging);
    if reference_count == 0 {
        constant_i32(instrs, 0);
    } else {
        constant_i32(instrs, reference_count as i32);
        call(instrs, deps.vector_begin);
    }
    local_set(instrs, vector);

    for (index, (field, encoder)) in layout.fields.iter().zip(encoders).enumerate() {
        if let Some(offset) = field.scalar_offset {
            local_get(instrs, staging);
            local_get(instrs, typed);
            emit_struct_get(
                instrs,
                layout.type_id,
                index as u32,
                field.field.element_type,
            );
            push(
                instrs,
                Instr::Store(Store {
                    memory: codec.memory,
                    kind: scalar_store(field.field.element_type),
                    arg: MemArg {
                        align: 1,
                        offset: u64::from(offset),
                    },
                }),
            );
        } else {
            local_get(instrs, vector);
            local_get(instrs, typed);
            emit_struct_get(
                instrs,
                layout.type_id,
                index as u32,
                field.field.element_type,
            );
            call(instrs, encoder.expect("reference struct field encoder"));
            call(instrs, deps.vector_append);
        }
    }
    if reference_count != 0 {
        // WHY: vector_begin returns a transaction-local builder handle. Only
        // finish publishes a canonical wire ordinal suitable for durable GC
        // recipes and deduplicates identical recursive activation vectors.
        local_get(instrs, vector);
        call(instrs, deps.vector_finish);
        local_set(instrs, vector);
    }
    emit_define(
        instrs,
        codec,
        deps,
        recipe,
        selected_layout,
        layout,
        KIND_STRUCT,
        staging,
        scalar_len,
        vector,
    );
    local_get(instrs, staging);
    constant_ptr(instrs, codec.ptr_ty, u64::from(reservation_len));
    call(instrs, deps.scratch_release);
}

#[allow(clippy::too_many_arguments)]
fn emit_encode_array_payload(
    module: &mut Module,
    codec: &DeclaredGcCodec,
    deps: EmitDependencies,
    seq: walrus::ir::InstrSeqId,
    layout: &GcLayout,
    typed: LocalId,
    recipe: LocalId,
    selected_layout: LocalId,
    staging: LocalId,
    scalar_len: LocalId,
    vector: LocalId,
    array_len: LocalId,
) {
    let index = module.locals.add(ValType::I32);
    let field = layout.fields[0];
    let reference = match field.field.element_type {
        StorageType::Val(ValType::Ref(reference)) => Some(reference),
        _ => None,
    };

    {
        let instrs = instrs_mut(module, codec.encode_anyref, seq);
        local_get(instrs, typed);
        push(instrs, Instr::ArrayLen(ArrayLen {}));
        local_set(instrs, array_len);
        emit_array_scalar_len(
            module,
            codec,
            seq,
            field.field.element_type,
            layout.scalar_len_or_stride,
            array_len,
            scalar_len,
        );
        let instrs = instrs_mut(module, codec.encode_anyref, seq);
        local_get(instrs, scalar_len);
        emit_i32_to_ptr(instrs, codec.ptr_ty);
        call(instrs, deps.scratch_reserve);
        local_set(instrs, staging);
        local_get(instrs, staging);
        local_get(instrs, array_len);
        push(
            instrs,
            Instr::Store(Store {
                memory: codec.memory,
                kind: StoreKind::I32 { atomic: false },
                arg: MemArg {
                    align: 1,
                    offset: 0,
                },
            }),
        );
    }

    if reference.is_some() {
        let yes = dangling(
            module,
            codec.encode_anyref,
            walrus::ir::InstrSeqType::Simple(Some(ValType::I32)),
        );
        {
            let instrs = instrs_mut(module, codec.encode_anyref, yes);
            local_get(instrs, array_len);
            call(instrs, deps.vector_begin);
        }
        let no = dangling(
            module,
            codec.encode_anyref,
            walrus::ir::InstrSeqType::Simple(Some(ValType::I32)),
        );
        constant_i32(instrs_mut(module, codec.encode_anyref, no), 0);
        let instrs = instrs_mut(module, codec.encode_anyref, seq);
        local_get(instrs, array_len);
        push(
            instrs,
            Instr::IfElse(IfElse {
                consequent: yes,
                alternative: no,
            }),
        );
    } else {
        constant_i32(instrs_mut(module, codec.encode_anyref, seq), 0);
    }
    local_set(instrs_mut(module, codec.encode_anyref, seq), vector);
    constant_i32(instrs_mut(module, codec.encode_anyref, seq), 0);
    local_set(instrs_mut(module, codec.encode_anyref, seq), index);

    let outer = dangling(
        module,
        codec.encode_anyref,
        walrus::ir::InstrSeqType::Simple(None),
    );
    let body = dangling(
        module,
        codec.encode_anyref,
        walrus::ir::InstrSeqType::Simple(None),
    );
    let reference_encoder =
        reference.map(|reference| reference_encoder(module, deps.codecs, reference));
    {
        let instrs = instrs_mut(module, codec.encode_anyref, body);
        local_get(instrs, index);
        local_get(instrs, array_len);
        binop(instrs, BinaryOp::I32GeU);
        push(instrs, Instr::BrIf(BrIf { block: outer }));
        if reference.is_some() {
            local_get(instrs, vector);
            local_get(instrs, typed);
            local_get(instrs, index);
            push(instrs, Instr::ArrayGet(ArrayGet { ty: layout.type_id }));
            call(
                instrs,
                reference_encoder.expect("reference array element encoder"),
            );
            call(instrs, deps.vector_append);
        } else {
            emit_array_scalar_address(
                instrs,
                staging,
                codec.ptr_ty,
                index,
                layout.scalar_len_or_stride,
            );
            local_get(instrs, typed);
            local_get(instrs, index);
            emit_array_get(instrs, layout.type_id, field.field.element_type);
            push(
                instrs,
                Instr::Store(Store {
                    memory: codec.memory,
                    kind: scalar_store(field.field.element_type),
                    arg: MemArg {
                        align: 1,
                        offset: 0,
                    },
                }),
            );
        }
        local_get(instrs, index);
        constant_i32(instrs, 1);
        binop(instrs, BinaryOp::I32Add);
        local_set(instrs, index);
        push(instrs, Instr::Br(Br { block: body }));
    }
    push(
        instrs_mut(module, codec.encode_anyref, outer),
        Instr::Loop(Loop { seq: body }),
    );
    push(
        instrs_mut(module, codec.encode_anyref, seq),
        Instr::Block(walrus::ir::Block { seq: outer }),
    );

    if reference.is_some() {
        let finish = dangling(
            module,
            codec.encode_anyref,
            walrus::ir::InstrSeqType::Simple(None),
        );
        {
            let instrs = instrs_mut(module, codec.encode_anyref, finish);
            local_get(instrs, vector);
            call(instrs, deps.vector_finish);
            local_set(instrs, vector);
        }
        let empty = dangling(
            module,
            codec.encode_anyref,
            walrus::ir::InstrSeqType::Simple(None),
        );
        let instrs = instrs_mut(module, codec.encode_anyref, seq);
        local_get(instrs, array_len);
        push(
            instrs,
            Instr::IfElse(IfElse {
                consequent: finish,
                alternative: empty,
            }),
        );
    }

    let instrs = instrs_mut(module, codec.encode_anyref, seq);
    emit_define(
        instrs,
        codec,
        deps,
        recipe,
        selected_layout,
        layout,
        KIND_ARRAY,
        staging,
        scalar_len,
        vector,
    );
    local_get(instrs, staging);
    local_get(instrs, scalar_len);
    emit_i32_to_ptr(instrs, codec.ptr_ty);
    call(instrs, deps.scratch_release);
}

#[allow(clippy::too_many_arguments)]
fn emit_define(
    instrs: &mut Vec<(Instr, InstrLocId)>,
    codec: &DeclaredGcCodec,
    deps: EmitDependencies,
    recipe: LocalId,
    selected_layout: LocalId,
    layout: &GcLayout,
    kind: u8,
    staging: LocalId,
    scalar_len: LocalId,
    vector: LocalId,
) {
    local_get(instrs, recipe);
    push(
        instrs,
        Instr::GlobalGet(GlobalGet {
            global: deps.activation,
        }),
    );
    constant_i32(instrs, layout.type_ordinal as i32);
    local_get(instrs, selected_layout);
    constant_i32(instrs, i32::from(kind));
    local_get(instrs, staging);
    local_get(instrs, scalar_len);
    local_get(instrs, vector);
    call(instrs, codec.imports.define);
}

fn reference_encoder(
    module: &Module,
    codecs: runtime::ReferenceCodecs,
    reference: RefType,
) -> FunctionId {
    runtime::ReferenceCodecClass::of(module, reference).encoder(codecs)
}

fn emit_struct_get(
    instrs: &mut Vec<(Instr, InstrLocId)>,
    ty: TypeId,
    field: u32,
    storage: StorageType,
) {
    match storage {
        StorageType::I8 | StorageType::I16 => {
            push(instrs, Instr::StructGetU(StructGetU { ty, field }))
        }
        StorageType::Val(_) => push(instrs, Instr::StructGet(StructGet { ty, field })),
    }
}

fn emit_array_get(instrs: &mut Vec<(Instr, InstrLocId)>, ty: TypeId, storage: StorageType) {
    match storage {
        StorageType::I8 | StorageType::I16 => {
            push(instrs, Instr::ArrayGetU(walrus::ir::ArrayGetU { ty }))
        }
        StorageType::Val(_) => push(instrs, Instr::ArrayGet(ArrayGet { ty })),
    }
}

fn scalar_store(storage: StorageType) -> StoreKind {
    match storage {
        StorageType::I8 => StoreKind::I32_8 { atomic: false },
        StorageType::I16 => StoreKind::I32_16 { atomic: false },
        StorageType::Val(ValType::I32) => StoreKind::I32 { atomic: false },
        StorageType::Val(ValType::I64) => StoreKind::I64 { atomic: false },
        StorageType::Val(ValType::F32) => StoreKind::F32,
        StorageType::Val(ValType::F64) => StoreKind::F64,
        StorageType::Val(ValType::V128) => StoreKind::V128,
        StorageType::Val(ValType::Ref(_)) => unreachable!("reference field uses recipe vector"),
    }
}

fn emit_array_scalar_len(
    module: &mut Module,
    codec: &DeclaredGcCodec,
    seq: walrus::ir::InstrSeqId,
    storage: StorageType,
    stride: u32,
    length: LocalId,
    destination: LocalId,
) {
    if matches!(storage, StorageType::Val(ValType::Ref(_))) {
        let instrs = instrs_mut(module, codec.encode_anyref, seq);
        constant_i32(instrs, 4);
        local_set(instrs, destination);
        return;
    }
    let maximum_length = (u32::MAX - 4) / stride;
    let too_large = dangling(
        module,
        codec.encode_anyref,
        walrus::ir::InstrSeqType::Simple(None),
    );
    push(
        instrs_mut(module, codec.encode_anyref, too_large),
        Instr::Unreachable(Unreachable {}),
    );
    let okay = dangling(
        module,
        codec.encode_anyref,
        walrus::ir::InstrSeqType::Simple(None),
    );
    let instrs = instrs_mut(module, codec.encode_anyref, seq);
    local_get(instrs, length);
    constant_i32(instrs, maximum_length as i32);
    binop(instrs, BinaryOp::I32GtU);
    push(
        instrs,
        Instr::IfElse(IfElse {
            consequent: too_large,
            alternative: okay,
        }),
    );
    local_get(instrs, length);
    constant_i32(instrs, stride as i32);
    binop(instrs, BinaryOp::I32Mul);
    constant_i32(instrs, 4);
    binop(instrs, BinaryOp::I32Add);
    local_set(instrs, destination);
}

fn emit_array_scalar_address(
    instrs: &mut Vec<(Instr, InstrLocId)>,
    staging: LocalId,
    ptr_ty: ValType,
    index: LocalId,
    stride: u32,
) {
    local_get(instrs, staging);
    constant_ptr(instrs, ptr_ty, 4);
    binop(instrs, pointer_add(ptr_ty));
    local_get(instrs, index);
    constant_i32(instrs, stride as i32);
    binop(instrs, BinaryOp::I32Mul);
    emit_i32_to_ptr(instrs, ptr_ty);
    binop(instrs, pointer_add(ptr_ty));
}

#[derive(Debug, Clone, Copy)]
struct BaseType {
    type_id: TypeId,
    type_ordinal: u32,
    layout_id: u32,
    needs_constructor_provenance: bool,
}

/// Freeze original GC types and constructor sites before module-state/runtime
/// helpers add synthetic functions and types.
pub fn plan(module: &Module) -> Result<GcCodecPlan> {
    let mut type_ordinals = HashMap::new();
    for ty in module.types.iter() {
        if matches!(
            ty.kind(),
            CompositeType::Struct(_) | CompositeType::Array(_)
        ) {
            let ordinal = u32::try_from(type_ordinals.len())
                .map_err(|_| anyhow::anyhow!("GC type catalog exceeds u32"))?;
            type_ordinals.insert(ty.id(), ordinal);
        }
    }

    let mut layouts = Vec::with_capacity(type_ordinals.len());
    let mut base_types = HashMap::new();
    for ty in module.types.iter() {
        let Some(&type_ordinal) = type_ordinals.get(&ty.id()) else {
            continue;
        };
        let id = u32::try_from(layouts.len() + 1)
            .map_err(|_| anyhow::anyhow!("GC layout catalog exceeds u31"))?;
        ensure!(id <= 0x7fff_ffff, "GC layout catalog exceeds u31");
        let super_type_ordinal = ty
            .supertype
            .and_then(|supertype| type_ordinals.get(&supertype).copied());
        let subtype_depth = subtype_depth(module, ty.id())?;
        match ty.kind() {
            CompositeType::Struct(structure) => {
                let (fields, scalar_len) = layout_fields(module, &structure.fields)?;
                let defaultable_shell = structure
                    .fields
                    .iter()
                    .all(|field| field.mutable && defaultable_field(field));
                let requires_provenance = structure.fields.iter().any(|field| {
                    field.mutable
                        && matches!(
                            field.element_type,
                            StorageType::Val(ValType::Ref(reference))
                                if !reference.nullable
                                    && is_internal_gc_reference(module, reference)
                        )
                });
                let provenance_reference_count = structure
                    .fields
                    .iter()
                    .filter(|field| {
                        field.mutable
                            && matches!(
                                field.element_type,
                                StorageType::Val(ValType::Ref(reference))
                                    if !reference.nullable
                                        && is_internal_gc_reference(module, reference)
                            )
                    })
                    .count() as u32;
                layouts.push(GcLayout {
                    id,
                    type_id: ty.id(),
                    type_ordinal,
                    base_layout_id: id,
                    kind: GcLayoutKind::Struct,
                    constructor: GcConstructorKind::Struct,
                    scalar_len_or_stride: scalar_len,
                    fields,
                    super_type_ordinal,
                    subtype_depth,
                    defaultable_shell,
                    requires_provenance,
                    provenance_scalar_len: 0,
                    provenance_reference_count,
                });
                base_types.insert(
                    ty.id(),
                    BaseType {
                        type_id: ty.id(),
                        type_ordinal,
                        layout_id: id,
                        needs_constructor_provenance: requires_provenance,
                    },
                );
            }
            CompositeType::Array(array) => {
                let (fields, stride) = layout_fields(module, std::slice::from_ref(&array.field))?;
                let defaultable_shell = defaultable_field(&array.field) && array.field.mutable;
                let needs_constructor_provenance =
                    !array.field.mutable || !defaultable_field(&array.field);
                layouts.push(GcLayout {
                    id,
                    type_id: ty.id(),
                    type_ordinal,
                    base_layout_id: id,
                    kind: GcLayoutKind::Array,
                    constructor: GcConstructorKind::ArrayGeneric,
                    scalar_len_or_stride: stride,
                    fields,
                    super_type_ordinal,
                    subtype_depth,
                    defaultable_shell,
                    requires_provenance: needs_constructor_provenance,
                    provenance_scalar_len: 0,
                    provenance_reference_count: 0,
                });
                base_types.insert(
                    ty.id(),
                    BaseType {
                        type_id: ty.id(),
                        type_ordinal,
                        layout_id: id,
                        needs_constructor_provenance,
                    },
                );
            }
            CompositeType::Function(_) => unreachable!(),
        }
    }

    let data_ordinals: HashMap<_, _> = module
        .data
        .iter()
        .enumerate()
        .map(|(ordinal, data)| (data.id(), ordinal as u32))
        .collect();
    let element_ordinals: HashMap<_, _> = module
        .elements
        .iter()
        .enumerate()
        .map(|(ordinal, element)| (element.id(), ordinal as u32))
        .collect();

    #[derive(Default)]
    struct Constructors {
        sites: Vec<(TypeId, GcConstructorKind)>,
    }
    impl<'instr> Visitor<'instr> for Constructors {
        fn visit_instr(&mut self, instr: &'instr Instr, _loc: &'instr InstrLocId) {
            match instr {
                Instr::ArrayNew(ArrayNew { ty }) => {
                    self.sites.push((*ty, GcConstructorKind::ArrayNew))
                }
                Instr::ArrayNewDefault(ArrayNewDefault { ty }) => {
                    self.sites.push((*ty, GcConstructorKind::ArrayDefault))
                }
                Instr::ArrayNewFixed(ArrayNewFixed { ty, len }) => self
                    .sites
                    .push((*ty, GcConstructorKind::ArrayFixed { len: *len })),
                Instr::ArrayNewData(ArrayNewData { ty, data }) => self.sites.push((
                    *ty,
                    GcConstructorKind::ArrayData {
                        segment_ordinal: data.index() as u32,
                    },
                )),
                Instr::ArrayNewElem(ArrayNewElem { ty, elem }) => self.sites.push((
                    *ty,
                    GcConstructorKind::ArrayElement {
                        segment_ordinal: elem.index() as u32,
                    },
                )),
                _ => {}
            }
        }
    }

    let mut constructors = Constructors::default();
    let mut functions: Vec<_> = module
        .funcs
        .iter()
        .filter_map(|function| match &function.kind {
            FunctionKind::Local(local) => Some((function.id(), local)),
            FunctionKind::Import(_) | FunctionKind::Uninitialized(_) => None,
        })
        .collect();
    functions.sort_by_key(|(id, _)| *id);
    for (_, function) in functions {
        dfs_in_order(&mut constructors, function, function.entry_block());
    }

    let mut emitted = HashSet::new();
    for (type_id, mut constructor) in constructors.sites {
        let Some(base) = base_types.get(&type_id).copied() else {
            continue;
        };
        if !base.needs_constructor_provenance {
            continue;
        }
        constructor = match constructor {
            GcConstructorKind::ArrayData { segment_ordinal } => {
                let data = module
                    .data
                    .iter()
                    .find(|data| data.id().index() as u32 == segment_ordinal)
                    .and_then(|data| data_ordinals.get(&data.id()).copied())
                    .ok_or_else(|| anyhow::anyhow!("GC array data segment is not catalogued"))?;
                GcConstructorKind::ArrayData {
                    segment_ordinal: data,
                }
            }
            GcConstructorKind::ArrayElement { segment_ordinal } => {
                let element = module
                    .elements
                    .iter()
                    .find(|element| element.id().index() as u32 == segment_ordinal)
                    .and_then(|element| element_ordinals.get(&element.id()).copied())
                    .ok_or_else(|| anyhow::anyhow!("GC array element segment is not catalogued"))?;
                GcConstructorKind::ArrayElement {
                    segment_ordinal: element,
                }
            }
            other => other,
        };
        let key = (type_id, constructor.wire(), constructor.auxiliary());
        if !emitted.insert(key) {
            continue;
        }
        let id = u32::try_from(layouts.len() + 1)
            .map_err(|_| anyhow::anyhow!("GC constructor catalog exceeds u31"))?;
        ensure!(id <= 0x7fff_ffff, "GC constructor catalog exceeds u31");
        let base_layout = &layouts[(base.layout_id - 1) as usize];
        let (provenance_scalar_len, provenance_reference_count) =
            constructor_provenance(module, constructor, base_layout.fields[0].field);
        layouts.push(GcLayout {
            id,
            type_id: base.type_id,
            type_ordinal: base.type_ordinal,
            base_layout_id: base.layout_id,
            kind: GcLayoutKind::Array,
            constructor,
            scalar_len_or_stride: base_layout.scalar_len_or_stride,
            fields: base_layout.fields.clone(),
            super_type_ordinal: base_layout.super_type_ordinal,
            subtype_depth: base_layout.subtype_depth,
            defaultable_shell: base_layout.defaultable_shell,
            requires_provenance: true,
            provenance_scalar_len,
            provenance_reference_count,
        });
    }

    let mut dispatch: Vec<_> = base_types.values().copied().collect();
    dispatch.sort_by(|left, right| {
        let left_layout = &layouts[(left.layout_id - 1) as usize];
        let right_layout = &layouts[(right.layout_id - 1) as usize];
        right_layout
            .subtype_depth
            .cmp(&left_layout.subtype_depth)
            .then_with(|| left.type_ordinal.cmp(&right.type_ordinal))
    });
    Ok(GcCodecPlan {
        layouts,
        dispatch_layouts: dispatch.into_iter().map(|entry| entry.layout_id).collect(),
    })
}

fn subtype_depth(module: &Module, mut ty: TypeId) -> Result<u32> {
    let mut depth = 0u32;
    let limit = module.types.iter().count();
    for _ in 0..=limit {
        let Some(supertype) = module.types.get(ty).supertype else {
            return Ok(depth);
        };
        depth = depth
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("GC subtype depth overflow"))?;
        ty = supertype;
    }
    anyhow::bail!("fork-instrument: cyclic GC supertype chain")
}

fn defaultable_field(field: &FieldType) -> bool {
    match field.element_type {
        StorageType::I8 | StorageType::I16 => true,
        StorageType::Val(ValType::Ref(reference)) => reference.nullable,
        StorageType::Val(_) => true,
    }
}

fn constructor_provenance(
    module: &Module,
    constructor: GcConstructorKind,
    field: FieldType,
) -> (u32, u32) {
    match constructor {
        GcConstructorKind::ArrayNew => match field.element_type {
            StorageType::Val(ValType::Ref(reference))
                if is_internal_gc_reference(module, reference) =>
            {
                (0, 1)
            }
            StorageType::Val(ValType::Ref(_)) => (0, 0),
            scalar => (storage_size(scalar), 0),
        },
        GcConstructorKind::ArrayFixed { len }
            if field.mutable
                && matches!(
                    field.element_type,
                    StorageType::Val(ValType::Ref(reference))
                        if !reference.nullable
                            && is_internal_gc_reference(module, reference)
                ) =>
        {
            (0, len)
        }
        GcConstructorKind::ArrayData { .. } | GcConstructorKind::ArrayElement { .. } => (8, 0),
        GcConstructorKind::Struct
        | GcConstructorKind::ArrayGeneric
        | GcConstructorKind::ArrayDefault
        | GcConstructorKind::ArrayFixed { .. } => (0, 0),
    }
}

fn layout_fields(_module: &Module, fields: &[FieldType]) -> Result<(Vec<GcFieldLayout>, u32)> {
    let mut scalar_offset = 0u32;
    let mut reference_ordinal = 0u32;
    let mut layouts = Vec::with_capacity(fields.len());
    for field in fields {
        match field.element_type {
            StorageType::Val(ValType::Ref(reference)) => {
                layouts.push(GcFieldLayout {
                    field: *field,
                    scalar_offset: None,
                    reference_ordinal: Some(reference_ordinal),
                    // Immutable edges are constructor values. Mutable
                    // internal non-null edges use the separately recorded
                    // constructor seed; other hierarchies have generated
                    // temporary seeds and are filled in phase two.
                    allocation_dependency: !field.mutable
                        && !matches!(
                            reference.heap_type,
                            HeapType::Abstract(AbstractHeapType::None)
                        ),
                });
                reference_ordinal = reference_ordinal
                    .checked_add(1)
                    .ok_or_else(|| anyhow::anyhow!("GC reference layout overflow"))?;
            }
            storage => {
                let size = storage_size(storage);
                let aligned = align_up(scalar_offset, size.min(16))?;
                layouts.push(GcFieldLayout {
                    field: *field,
                    scalar_offset: Some(aligned),
                    reference_ordinal: None,
                    allocation_dependency: false,
                });
                scalar_offset = aligned
                    .checked_add(size)
                    .ok_or_else(|| anyhow::anyhow!("GC scalar layout overflow"))?;
            }
        }
    }
    Ok((layouts, scalar_offset))
}

fn is_internal_gc_reference(module: &Module, reference: RefType) -> bool {
    runtime::ReferenceCodecClass::of(module, reference) == runtime::ReferenceCodecClass::Any
}

fn storage_size(storage: StorageType) -> u32 {
    match storage {
        StorageType::I8 => 1,
        StorageType::I16 => 2,
        StorageType::Val(ValType::I32 | ValType::F32) => 4,
        StorageType::Val(ValType::I64 | ValType::F64) => 8,
        StorageType::Val(ValType::V128) => 16,
        StorageType::Val(ValType::Ref(_)) => 4,
    }
}

fn align_up(value: u32, alignment: u32) -> Result<u32> {
    let mask = alignment - 1;
    value
        .checked_add(mask)
        .map(|value| value & !mask)
        .ok_or_else(|| anyhow::anyhow!("GC scalar layout overflow"))
}

fn storage_code(storage: StorageType) -> u8 {
    match storage {
        StorageType::I8 => STORAGE_I8,
        StorageType::I16 => STORAGE_I16,
        StorageType::Val(ValType::I32) => STORAGE_I32,
        StorageType::Val(ValType::I64) => STORAGE_I64,
        StorageType::Val(ValType::F32) => STORAGE_F32,
        StorageType::Val(ValType::F64) => STORAGE_F64,
        StorageType::Val(ValType::V128) => STORAGE_V128,
        StorageType::Val(ValType::Ref(_)) => STORAGE_REFERENCE,
    }
}

pub fn encode_descriptor(plan: &GcCodecPlan) -> Vec<u8> {
    let field_count: usize = plan.layouts.iter().map(|layout| layout.fields.len()).sum();
    let mut data = Vec::with_capacity(
        usize::from(FORMAT_HEADER_SIZE)
            + plan.layouts.len() * usize::from(FORMAT_LAYOUT_RECORD_SIZE)
            + field_count * usize::from(FORMAT_FIELD_RECORD_SIZE),
    );
    data.extend_from_slice(&FORMAT_MAGIC);
    data.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
    data.extend_from_slice(&FORMAT_HEADER_SIZE.to_le_bytes());
    data.extend_from_slice(&(plan.layouts.len() as u32).to_le_bytes());
    data.extend_from_slice(&(field_count as u32).to_le_bytes());

    let mut field_start = 0u32;
    for layout in &plan.layouts {
        let flags = (if layout.requires_provenance || layout.constructor.requires_provenance() {
            LAYOUT_FLAG_REQUIRES_PROVENANCE
        } else {
            0
        }) | (if layout.defaultable_shell {
            LAYOUT_FLAG_DEFAULTABLE_SHELL
        } else {
            0
        });
        data.extend_from_slice(&layout.id.to_le_bytes());
        data.extend_from_slice(&layout.type_ordinal.to_le_bytes());
        data.push(layout.kind.wire());
        data.push(layout.constructor.wire());
        data.extend_from_slice(&flags.to_le_bytes());
        data.extend_from_slice(&layout.scalar_len_or_stride.to_le_bytes());
        data.extend_from_slice(&field_start.to_le_bytes());
        data.extend_from_slice(&(layout.fields.len() as u32).to_le_bytes());
        data.extend_from_slice(
            &layout
                .super_type_ordinal
                .unwrap_or(NO_ORDINAL)
                .to_le_bytes(),
        );
        data.extend_from_slice(&layout.base_layout_id.to_le_bytes());
        data.extend_from_slice(&layout.constructor.auxiliary().to_le_bytes());
        data.extend_from_slice(&layout.provenance_scalar_len.to_le_bytes());
        data.extend_from_slice(&layout.provenance_reference_count.to_le_bytes());
        field_start += layout.fields.len() as u32;
    }
    for layout in &plan.layouts {
        for field in &layout.fields {
            let reference = matches!(field.field.element_type, StorageType::Val(ValType::Ref(_)));
            let nullable = matches!(
                field.field.element_type,
                StorageType::Val(ValType::Ref(reference)) if reference.nullable
            );
            let flags = (if field.field.mutable {
                FIELD_FLAG_MUTABLE
            } else {
                0
            }) | (if nullable { FIELD_FLAG_NULLABLE } else { 0 })
                | (if reference { FIELD_FLAG_REFERENCE } else { 0 })
                | (if field.is_allocation_dependency() {
                    FIELD_FLAG_ALLOCATION_DEPENDENCY
                } else {
                    0
                });
            data.push(storage_code(field.field.element_type));
            data.push(flags);
            data.extend_from_slice(&0u16.to_le_bytes());
            data.extend_from_slice(&field.scalar_offset.unwrap_or(NO_ORDINAL).to_le_bytes());
            data.extend_from_slice(&field.reference_ordinal.unwrap_or(NO_ORDINAL).to_le_bytes());
        }
    }
    data
}

fn inject_host_imports(module: &mut Module, ptr_ty: ValType) -> HostImports {
    HostImports {
        activation: module
            .add_import_global(
                HOST_IMPORT_MODULE,
                WPK_FORK_EXCEPTION_IMPORT_ACTIVATION,
                ValType::I32,
                false,
                false,
            )
            .0,
        lookup: import_function(module, IMPORT_LOOKUP, &[ValType::I32], &[ValType::I32]),
        claim: import_function(module, IMPORT_CLAIM, &[ValType::I32], &[ValType::I32]),
        i31: import_function(module, IMPORT_I31, &[ValType::I32], &[ValType::I32]),
        define: import_function(
            module,
            IMPORT_DEFINE,
            &[
                ValType::I32,
                ValType::I32,
                ValType::I32,
                ValType::I32,
                ValType::I32,
                ptr_ty,
                ValType::I32,
                ValType::I32,
            ],
            &[],
        ),
        route: import_function(
            module,
            IMPORT_ROUTE,
            &[ValType::I32, ValType::I32],
            &[ValType::I32],
        ),
        payload_len: import_function(
            module,
            IMPORT_PAYLOAD_LEN,
            &[ValType::I32, ValType::I32, ValType::I32],
            &[ValType::I32],
        ),
        load: import_function(
            module,
            IMPORT_LOAD,
            &[
                ValType::I32,
                ValType::I32,
                ValType::I32,
                ValType::I32,
                ValType::I32,
                ptr_ty,
                ValType::I32,
            ],
            &[ValType::I32],
        ),
        broker_encode: import_function(
            module,
            IMPORT_BROKER_ENCODE,
            &[ValType::I32],
            &[ValType::I32],
        ),
        capture_layout: import_function(
            module,
            IMPORT_CAPTURE_LAYOUT,
            &[ValType::I32, ValType::I32, ValType::I32],
            &[ValType::I32],
        ),
        provenance_begin: import_function(
            module,
            IMPORT_PROVENANCE_BEGIN,
            &[
                ValType::I32,
                ValType::I32,
                ValType::I32,
                ValType::I32,
                ValType::I64,
                ValType::I64,
                ValType::I32,
            ],
            &[ValType::I32],
        ),
        provenance_ref: import_function(
            module,
            IMPORT_PROVENANCE_REF,
            &[ValType::I32, ValType::I32, ValType::I32],
            &[],
        ),
        provenance_end: import_function(module, IMPORT_PROVENANCE_END, &[ValType::I32], &[]),
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

fn replace_descriptor(module: &mut Module, plan: &GcCodecPlan) {
    loop {
        let existing = module
            .customs
            .iter()
            .find(|(_, section)| section.name() == FORMAT_SECTION)
            .map(|(id, _)| id);
        let Some(existing) = existing else { break };
        module.customs.delete(existing);
    }
    module.customs.add(RawCustomSection {
        name: FORMAT_SECTION.into(),
        data: encode_descriptor(plan),
    });
}

fn dangling(
    module: &mut Module,
    function: FunctionId,
    ty: walrus::ir::InstrSeqType,
) -> walrus::ir::InstrSeqId {
    local_mut(module, function)
        .builder_mut()
        .dangling_instr_seq(ty)
        .id()
}

fn entry(function: FunctionId, module: &Module) -> walrus::ir::InstrSeqId {
    local(module, function).entry_block()
}

fn instrs_mut(
    module: &mut Module,
    function: FunctionId,
    seq: walrus::ir::InstrSeqId,
) -> &mut Vec<(Instr, InstrLocId)> {
    &mut local_mut(module, function).block_mut(seq).instrs
}

fn local(module: &Module, function: FunctionId) -> &LocalFunction {
    match &module.funcs.get(function).kind {
        FunctionKind::Local(local) => local,
        _ => unreachable!("injected GC codec function is local"),
    }
}

fn local_mut(module: &mut Module, function: FunctionId) -> &mut LocalFunction {
    match &mut module.funcs.get_mut(function).kind {
        FunctionKind::Local(local) => local,
        _ => unreachable!("injected GC codec function is local"),
    }
}

fn push(instrs: &mut Vec<(Instr, InstrLocId)>, instr: Instr) {
    instrs.push((instr, InstrLocId::default()));
}

fn local_get(instrs: &mut Vec<(Instr, InstrLocId)>, local: LocalId) {
    push(instrs, Instr::LocalGet(LocalGet { local }));
}

fn local_set(instrs: &mut Vec<(Instr, InstrLocId)>, local: LocalId) {
    push(instrs, Instr::LocalSet(LocalSet { local }));
}

fn constant_i32(instrs: &mut Vec<(Instr, InstrLocId)>, value: i32) {
    push(
        instrs,
        Instr::Const(Const {
            value: Value::I32(value),
        }),
    );
}

fn constant_i64(instrs: &mut Vec<(Instr, InstrLocId)>, value: i64) {
    push(
        instrs,
        Instr::Const(Const {
            value: Value::I64(value),
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
        other => unreachable!("unsupported GC staging pointer type {other:?}"),
    }
}

fn call(instrs: &mut Vec<(Instr, InstrLocId)>, function: FunctionId) {
    push(instrs, Instr::Call(Call { func: function }));
}

fn binop(instrs: &mut Vec<(Instr, InstrLocId)>, op: BinaryOp) {
    push(instrs, Instr::Binop(Binop { op }));
}

fn pointer_add(ptr_ty: ValType) -> BinaryOp {
    match ptr_ty {
        ValType::I32 => BinaryOp::I32Add,
        ValType::I64 => BinaryOp::I64Add,
        other => unreachable!("unsupported GC staging pointer type {other:?}"),
    }
}

fn emit_i32_to_ptr(instrs: &mut Vec<(Instr, InstrLocId)>, ptr_ty: ValType) {
    match ptr_ty {
        ValType::I32 => {}
        ValType::I64 => push(
            instrs,
            Instr::Unop(Unop {
                op: UnaryOp::I64ExtendUI32,
            }),
        ),
        other => unreachable!("unsupported GC staging pointer type {other:?}"),
    }
}

fn clear_transit_slot(instrs: &mut Vec<(Instr, InstrLocId)>, transit: TableId, slot: i32) {
    constant_i32(instrs, slot);
    push(
        instrs,
        Instr::RefNull(RefNull {
            ty: RefType::ANYREF,
        }),
    );
    push(instrs, Instr::TableSet(TableSet { table: transit }));
}

fn emit_allocate(
    module: &mut Module,
    codec: &DeclaredGcCodec,
    deps: EmitDependencies,
    seeds: &ReferenceSeeds,
) -> Result<()> {
    let recipe = codec.allocate_args[0];
    let routed_layout = module.locals.add(ValType::I32);
    let scalar_len = module.locals.add(ValType::I32);
    let reservation_len = module.locals.add(ValType::I32);
    let staging = module.locals.add(codec.ptr_ty);
    let vector = module.locals.add(ValType::I32);
    // Replay-created aggregates must become valid parents of a later fork.
    // This local exists only in the generated replay helper, never in a saved
    // user activation frame.
    let provenance_token = module.locals.add(ValType::I32);
    let entry = entry(codec.allocate, module);
    {
        let instrs = instrs_mut(module, codec.allocate, entry);
        local_get(instrs, recipe);
        push(
            instrs,
            Instr::GlobalGet(GlobalGet {
                global: deps.activation,
            }),
        );
        call(instrs, codec.imports.route);
        local_set(instrs, routed_layout);
    }

    let i31 = dangling(
        module,
        codec.allocate,
        walrus::ir::InstrSeqType::Simple(None),
    );
    emit_allocate_i31(
        module,
        codec,
        deps,
        i31,
        recipe,
        scalar_len,
        reservation_len,
        staging,
        vector,
    );
    let not_i31 = dangling(
        module,
        codec.allocate,
        walrus::ir::InstrSeqType::Simple(None),
    );
    {
        let instrs = instrs_mut(module, codec.allocate, entry);
        local_get(instrs, routed_layout);
        push(
            instrs,
            Instr::Unop(Unop {
                op: UnaryOp::I32Eqz,
            }),
        );
        push(
            instrs,
            Instr::IfElse(IfElse {
                consequent: i31,
                alternative: not_i31,
            }),
        );
    }

    for layout in codec.plan.layouts().iter().cloned() {
        let yes = dangling(
            module,
            codec.allocate,
            walrus::ir::InstrSeqType::Simple(None),
        );
        emit_allocate_layout(
            module,
            codec,
            deps,
            yes,
            &layout,
            recipe,
            scalar_len,
            reservation_len,
            staging,
            vector,
            provenance_token,
            seeds,
        )?;
        let no = dangling(
            module,
            codec.allocate,
            walrus::ir::InstrSeqType::Simple(None),
        );
        let instrs = instrs_mut(module, codec.allocate, entry);
        local_get(instrs, routed_layout);
        constant_i32(instrs, layout.id as i32);
        binop(instrs, BinaryOp::I32Eq);
        push(
            instrs,
            Instr::IfElse(IfElse {
                consequent: yes,
                alternative: no,
            }),
        );
    }
    push(
        instrs_mut(module, codec.allocate, entry),
        Instr::Unreachable(Unreachable {}),
    );
    Ok(())
}

fn emit_fill(module: &mut Module, codec: &DeclaredGcCodec, deps: EmitDependencies) -> Result<()> {
    let recipe = codec.fill_args[0];
    let routed_layout = module.locals.add(ValType::I32);
    let scalar_len = module.locals.add(ValType::I32);
    let reservation_len = module.locals.add(ValType::I32);
    let staging = module.locals.add(codec.ptr_ty);
    let vector = module.locals.add(ValType::I32);
    let entry = entry(codec.fill, module);
    {
        let instrs = instrs_mut(module, codec.fill, entry);
        local_get(instrs, recipe);
        push(
            instrs,
            Instr::GlobalGet(GlobalGet {
                global: deps.activation,
            }),
        );
        call(instrs, codec.imports.route);
        local_set(instrs, routed_layout);
    }
    for layout in codec.plan.layouts().iter().cloned() {
        let yes = dangling(module, codec.fill, walrus::ir::InstrSeqType::Simple(None));
        emit_fill_layout(
            module,
            codec,
            deps,
            yes,
            &layout,
            recipe,
            scalar_len,
            reservation_len,
            staging,
            vector,
        );
        let no = dangling(module, codec.fill, walrus::ir::InstrSeqType::Simple(None));
        let instrs = instrs_mut(module, codec.fill, entry);
        local_get(instrs, routed_layout);
        constant_i32(instrs, layout.id as i32);
        binop(instrs, BinaryOp::I32Eq);
        push(
            instrs,
            Instr::IfElse(IfElse {
                consequent: yes,
                alternative: no,
            }),
        );
    }
    push(
        instrs_mut(module, codec.fill, entry),
        Instr::Unreachable(Unreachable {}),
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn emit_load_payload(
    module: &mut Module,
    function: FunctionId,
    seq: walrus::ir::InstrSeqId,
    codec: &DeclaredGcCodec,
    deps: EmitDependencies,
    recipe: LocalId,
    layout_id: u32,
    type_ordinal: u32,
    kind: u8,
    scalar_len: LocalId,
    reservation_len: LocalId,
    staging: LocalId,
    vector: LocalId,
) {
    {
        let instrs = instrs_mut(module, function, seq);
        local_get(instrs, recipe);
        push(
            instrs,
            Instr::GlobalGet(GlobalGet {
                global: deps.activation,
            }),
        );
        constant_i32(instrs, layout_id as i32);
        call(instrs, codec.imports.payload_len);
        local_set(instrs, scalar_len);
    }
    let nonzero = dangling(
        module,
        function,
        walrus::ir::InstrSeqType::Simple(Some(ValType::I32)),
    );
    local_get(instrs_mut(module, function, nonzero), scalar_len);
    let zero = dangling(
        module,
        function,
        walrus::ir::InstrSeqType::Simple(Some(ValType::I32)),
    );
    constant_i32(instrs_mut(module, function, zero), 1);
    {
        let instrs = instrs_mut(module, function, seq);
        local_get(instrs, scalar_len);
        push(
            instrs,
            Instr::IfElse(IfElse {
                consequent: nonzero,
                alternative: zero,
            }),
        );
        local_set(instrs, reservation_len);
        local_get(instrs, reservation_len);
        emit_i32_to_ptr(instrs, codec.ptr_ty);
        call(instrs, deps.scratch_reserve);
        local_set(instrs, staging);

        local_get(instrs, recipe);
        push(
            instrs,
            Instr::GlobalGet(GlobalGet {
                global: deps.activation,
            }),
        );
        constant_i32(instrs, type_ordinal as i32);
        constant_i32(instrs, layout_id as i32);
        constant_i32(instrs, i32::from(kind));
        local_get(instrs, staging);
        local_get(instrs, scalar_len);
        call(instrs, codec.imports.load);
        local_set(instrs, vector);
    }
}

fn emit_release_payload(
    instrs: &mut Vec<(Instr, InstrLocId)>,
    codec: &DeclaredGcCodec,
    deps: EmitDependencies,
    staging: LocalId,
    reservation_len: LocalId,
) {
    local_get(instrs, staging);
    local_get(instrs, reservation_len);
    emit_i32_to_ptr(instrs, codec.ptr_ty);
    call(instrs, deps.scratch_release);
}

#[allow(clippy::too_many_arguments)]
fn emit_allocate_i31(
    module: &mut Module,
    codec: &DeclaredGcCodec,
    deps: EmitDependencies,
    seq: walrus::ir::InstrSeqId,
    recipe: LocalId,
    scalar_len: LocalId,
    reservation_len: LocalId,
    staging: LocalId,
    vector: LocalId,
) {
    emit_load_payload(
        module,
        codec.allocate,
        seq,
        codec,
        deps,
        recipe,
        0,
        NO_ORDINAL,
        0,
        scalar_len,
        reservation_len,
        staging,
        vector,
    );
    let instrs = instrs_mut(module, codec.allocate, seq);
    local_get(instrs, recipe);
    constant_i32(instrs, 1);
    binop(instrs, BinaryOp::I32Add);
    local_get(instrs, staging);
    push(
        instrs,
        Instr::Load(Load {
            memory: codec.memory,
            kind: LoadKind::I32 { atomic: false },
            arg: MemArg {
                align: 1,
                offset: 0,
            },
        }),
    );
    push(instrs, Instr::RefI31(RefI31 {}));
    push(
        instrs,
        Instr::TableSet(TableSet {
            table: codec.transit,
        }),
    );
    emit_release_payload(instrs, codec, deps, staging, reservation_len);
    push(instrs, Instr::Return(Return {}));
}

#[allow(clippy::too_many_arguments)]
fn emit_allocate_layout(
    module: &mut Module,
    codec: &DeclaredGcCodec,
    deps: EmitDependencies,
    seq: walrus::ir::InstrSeqId,
    layout: &GcLayout,
    recipe: LocalId,
    scalar_len: LocalId,
    reservation_len: LocalId,
    staging: LocalId,
    vector: LocalId,
    provenance_token: LocalId,
    seeds: &ReferenceSeeds,
) -> Result<()> {
    emit_load_payload(
        module,
        codec.allocate,
        seq,
        codec,
        deps,
        recipe,
        layout.id,
        layout.type_ordinal,
        layout.kind.wire(),
        scalar_len,
        reservation_len,
        staging,
        vector,
    );
    {
        let instrs = instrs_mut(module, codec.allocate, seq);
        local_get(instrs, recipe);
        constant_i32(instrs, 1);
        binop(instrs, BinaryOp::I32Add);
    }
    match layout.kind {
        GcLayoutKind::Struct => {
            emit_allocate_struct(module, codec, deps, seq, layout, staging, vector, seeds)
        }
        GcLayoutKind::Array => {
            emit_allocate_array(module, codec, deps, seq, layout, staging, vector, seeds)?
        }
    }
    {
        let instrs = instrs_mut(module, codec.allocate, seq);
        push(
            instrs,
            Instr::TableSet(TableSet {
                table: codec.transit,
            }),
        );
    }
    if layout.requires_provenance {
        emit_replay_provenance_registration(
            module,
            codec,
            deps,
            seq,
            layout,
            recipe,
            staging,
            vector,
            provenance_token,
        );
    }
    let instrs = instrs_mut(module, codec.allocate, seq);
    emit_release_payload(instrs, codec, deps, staging, reservation_len);
    push(instrs, Instr::Return(Return {}));
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn emit_replay_provenance_registration(
    module: &mut Module,
    codec: &DeclaredGcCodec,
    deps: EmitDependencies,
    seq: walrus::ir::InstrSeqId,
    layout: &GcLayout,
    recipe: LocalId,
    staging: LocalId,
    vector: LocalId,
    token: LocalId,
) {
    {
        let instrs = instrs_mut(module, codec.allocate, seq);
        local_get(instrs, recipe);
        constant_i32(instrs, 1);
        binop(instrs, BinaryOp::I32Add);
        push(
            instrs,
            Instr::GlobalGet(GlobalGet {
                global: deps.activation,
            }),
        );
        constant_i32(instrs, layout.base_layout_id as i32);
        constant_i32(instrs, layout.id as i32);
        emit_replayed_provenance_scalars(instrs, codec, layout, staging);
        constant_i32(instrs, layout.provenance_reference_count as i32);
        call(instrs, codec.imports.provenance_begin);
        local_set(instrs, token);
    }
    for index in 0..layout.provenance_reference_count {
        let instrs = instrs_mut(module, codec.allocate, seq);
        local_get(instrs, token);
        constant_i32(instrs, index as i32);
        local_get(instrs, vector);
        constant_i32(instrs, index as i32);
        call(instrs, deps.vector_get);
        constant_i32(instrs, 1);
        binop(instrs, BinaryOp::I32Add);
        call(instrs, codec.imports.provenance_ref);
    }
    let instrs = instrs_mut(module, codec.allocate, seq);
    local_get(instrs, token);
    call(instrs, codec.imports.provenance_end);
}

fn emit_replayed_provenance_scalars(
    instrs: &mut Vec<(Instr, InstrLocId)>,
    codec: &DeclaredGcCodec,
    layout: &GcLayout,
    staging: LocalId,
) {
    let load = |instrs: &mut Vec<(Instr, InstrLocId)>,
                kind: LoadKind,
                offset: u64| {
        local_get(instrs, staging);
        push(
            instrs,
            Instr::Load(Load {
                memory: codec.memory,
                kind,
                arg: MemArg {
                    align: 1,
                    offset,
                },
            }),
        );
    };
    match layout.provenance_scalar_len {
        0 => {
            constant_i64(instrs, 0);
            constant_i64(instrs, 0);
        }
        1 => {
            load(
                instrs,
                LoadKind::I32_8 {
                    kind: walrus::ir::ExtendedLoad::ZeroExtend,
                },
                0,
            );
            push(
                instrs,
                Instr::Unop(Unop {
                    op: UnaryOp::I64ExtendUI32,
                }),
            );
            constant_i64(instrs, 0);
        }
        2 => {
            load(
                instrs,
                LoadKind::I32_16 {
                    kind: walrus::ir::ExtendedLoad::ZeroExtend,
                },
                0,
            );
            push(
                instrs,
                Instr::Unop(Unop {
                    op: UnaryOp::I64ExtendUI32,
                }),
            );
            constant_i64(instrs, 0);
        }
        4 => {
            load(instrs, LoadKind::I32 { atomic: false }, 0);
            push(
                instrs,
                Instr::Unop(Unop {
                    op: UnaryOp::I64ExtendUI32,
                }),
            );
            constant_i64(instrs, 0);
        }
        8 => {
            load(instrs, LoadKind::I64 { atomic: false }, 0);
            constant_i64(instrs, 0);
        }
        16 => {
            load(instrs, LoadKind::I64 { atomic: false }, 0);
            load(instrs, LoadKind::I64 { atomic: false }, 8);
        }
        length => unreachable!("invalid GC provenance scalar length {length}"),
    }
}

fn emit_allocate_struct(
    module: &mut Module,
    codec: &DeclaredGcCodec,
    deps: EmitDependencies,
    seq: walrus::ir::InstrSeqId,
    layout: &GcLayout,
    staging: LocalId,
    vector: LocalId,
    seeds: &ReferenceSeeds,
) {
    if layout.defaultable_shell {
        push(
            instrs_mut(module, codec.allocate, seq),
            Instr::StructNewDefault(StructNewDefault { ty: layout.type_id }),
        );
        return;
    }

    let reference_decoders: Vec<_> = layout
        .fields
        .iter()
        .map(|field| match field.field.element_type {
            StorageType::Val(ValType::Ref(reference)) => {
                let class = runtime::ReferenceCodecClass::of(module, reference);
                Some((
                    class,
                    class.decoder(deps.codecs),
                    class.nullable_type(),
                    reference_seed(module, seeds, reference),
                ))
            }
            _ => None,
        })
        .collect();
    let mut provenance_reference = 0u32;
    for (index, field) in layout.fields.iter().enumerate() {
        let decoder = reference_decoders[index];
        let instrs = instrs_mut(module, codec.allocate, seq);
        match field.field.element_type {
            StorageType::Val(ValType::Ref(reference)) if !field.field.mutable => {
                local_get(instrs, vector);
                constant_i32(
                    instrs,
                    (layout.provenance_reference_count
                        + field.reference_ordinal.expect("reference ordinal"))
                        as i32,
                );
                call(instrs, deps.vector_get);
                let (_, decoder, broad, _) = decoder.expect("reference decoder");
                call(instrs, decoder);
                emit_narrow(instrs, broad, reference);
            }
            StorageType::Val(ValType::Ref(reference))
                if field.field.mutable && !reference.nullable =>
            {
                let (class, decoder, broad, seed) = decoder.expect("reference decoder");
                if class == runtime::ReferenceCodecClass::Any {
                    local_get(instrs, vector);
                    constant_i32(instrs, provenance_reference as i32);
                    call(instrs, deps.vector_get);
                    provenance_reference += 1;
                    call(instrs, decoder);
                    emit_narrow(instrs, broad, reference);
                } else {
                    emit_seed_reference(instrs, seed);
                }
            }
            StorageType::Val(ValType::Ref(reference)) => {
                push(instrs, Instr::RefNull(RefNull { ty: reference }));
            }
            storage if !field.field.mutable => {
                local_get(instrs, staging);
                push(
                    instrs,
                    Instr::Load(Load {
                        memory: codec.memory,
                        kind: scalar_load(storage),
                        arg: MemArg {
                            align: 1,
                            offset: u64::from(
                                layout.provenance_scalar_len
                                    + field.scalar_offset.expect("scalar offset"),
                            ),
                        },
                    }),
                );
            }
            storage => emit_default_scalar(instrs, storage),
        }
    }
    push(
        instrs_mut(module, codec.allocate, seq),
        Instr::StructNew(StructNew { ty: layout.type_id }),
    );
}

#[allow(clippy::too_many_arguments)]
fn emit_array_new_reference_seed(
    module: &mut Module,
    codec: &DeclaredGcCodec,
    deps: EmitDependencies,
    seq: walrus::ir::InstrSeqId,
    layout: &GcLayout,
    staging: LocalId,
    vector: LocalId,
    reference: RefType,
    class: runtime::ReferenceCodecClass,
    decoder: FunctionId,
    broad: RefType,
    seed: ReferenceSeed,
) {
    if class == runtime::ReferenceCodecClass::Any {
        let instrs = instrs_mut(module, codec.allocate, seq);
        local_get(instrs, vector);
        constant_i32(instrs, 0);
        call(instrs, deps.vector_get);
        call(instrs, decoder);
        emit_narrow(instrs, broad, reference);
        return;
    }
    if layout.fields[0].field.mutable {
        emit_seed_reference(instrs_mut(module, codec.allocate, seq), seed);
        return;
    }

    // Immutable array.new values equal the constructor seed whenever length
    // is nonzero. A zero-length array has no observable element, but the Wasm
    // instruction still requires a typed seed; synthesize one locally.
    let result_ty = ValType::Ref(reference);
    let nonempty = dangling(
        module,
        codec.allocate,
        walrus::ir::InstrSeqType::Simple(Some(result_ty)),
    );
    {
        let instrs = instrs_mut(module, codec.allocate, nonempty);
        local_get(instrs, vector);
        constant_i32(instrs, layout.provenance_reference_count as i32);
        call(instrs, deps.vector_get);
        call(instrs, decoder);
        emit_narrow(instrs, broad, reference);
    }
    let empty = dangling(
        module,
        codec.allocate,
        walrus::ir::InstrSeqType::Simple(Some(result_ty)),
    );
    if reference.nullable {
        push(
            instrs_mut(module, codec.allocate, empty),
            Instr::RefNull(RefNull { ty: reference }),
        );
    } else {
        emit_seed_reference(instrs_mut(module, codec.allocate, empty), seed);
    }
    let instrs = instrs_mut(module, codec.allocate, seq);
    emit_load_i32(instrs, codec.memory, staging, layout.provenance_scalar_len);
    push(
        instrs,
        Instr::IfElse(IfElse {
            consequent: nonempty,
            alternative: empty,
        }),
    );
}

fn emit_allocate_array(
    module: &mut Module,
    codec: &DeclaredGcCodec,
    deps: EmitDependencies,
    seq: walrus::ir::InstrSeqId,
    layout: &GcLayout,
    staging: LocalId,
    vector: LocalId,
    seeds: &ReferenceSeeds,
) -> Result<()> {
    let field = layout.fields[0].field;
    match layout.constructor {
        GcConstructorKind::ArrayGeneric if layout.defaultable_shell => {
            emit_load_i32(
                instrs_mut(module, codec.allocate, seq),
                codec.memory,
                staging,
                layout.provenance_scalar_len,
            );
            push(
                instrs_mut(module, codec.allocate, seq),
                Instr::ArrayNewDefault(ArrayNewDefault { ty: layout.type_id }),
            );
        }
        GcConstructorKind::ArrayNew => {
            let reference_decoder = match field.element_type {
                StorageType::Val(ValType::Ref(reference)) => {
                    let class = runtime::ReferenceCodecClass::of(module, reference);
                    Some((
                        reference,
                        class,
                        class.decoder(deps.codecs),
                        class.nullable_type(),
                        reference_seed(module, seeds, reference),
                    ))
                }
                _ => None,
            };
            if let Some((reference, class, decoder, broad, seed)) = reference_decoder {
                emit_array_new_reference_seed(
                    module, codec, deps, seq, layout, staging, vector, reference, class, decoder,
                    broad, seed,
                );
            }
            {
                let instrs = instrs_mut(module, codec.allocate, seq);
                match field.element_type {
                    StorageType::Val(ValType::Ref(_)) => {}
                    storage => {
                        local_get(instrs, staging);
                        push(
                            instrs,
                            Instr::Load(Load {
                                memory: codec.memory,
                                kind: scalar_load(storage),
                                arg: MemArg {
                                    align: 1,
                                    offset: 0,
                                },
                            }),
                        );
                    }
                }
                emit_load_i32(instrs, codec.memory, staging, layout.provenance_scalar_len);
                push(instrs, Instr::ArrayNew(ArrayNew { ty: layout.type_id }));
            }
        }
        GcConstructorKind::ArrayDefault => {
            emit_load_i32(
                instrs_mut(module, codec.allocate, seq),
                codec.memory,
                staging,
                layout.provenance_scalar_len,
            );
            push(
                instrs_mut(module, codec.allocate, seq),
                Instr::ArrayNewDefault(ArrayNewDefault { ty: layout.type_id }),
            );
        }
        GcConstructorKind::ArrayFixed { len } => {
            for index in 0..len {
                emit_load_array_snapshot_element(
                    module, codec, deps, seq, layout, staging, vector, index, seeds,
                );
            }
            push(
                instrs_mut(module, codec.allocate, seq),
                Instr::ArrayNewFixed(ArrayNewFixed {
                    ty: layout.type_id,
                    len,
                }),
            );
        }
        GcConstructorKind::ArrayData { segment_ordinal } => {
            let data = module
                .data
                .iter()
                .nth(segment_ordinal as usize)
                .ok_or_else(|| anyhow::anyhow!("GC data constructor segment disappeared"))?
                .id();
            let instrs = instrs_mut(module, codec.allocate, seq);
            emit_load_i32(instrs, codec.memory, staging, 0);
            emit_load_i32(instrs, codec.memory, staging, 4);
            push(
                instrs,
                Instr::ArrayNewData(ArrayNewData {
                    ty: layout.type_id,
                    data,
                }),
            );
        }
        GcConstructorKind::ArrayElement { segment_ordinal } => {
            let elem = module
                .elements
                .iter()
                .nth(segment_ordinal as usize)
                .ok_or_else(|| anyhow::anyhow!("GC element constructor segment disappeared"))?
                .id();
            let instrs = instrs_mut(module, codec.allocate, seq);
            emit_load_i32(instrs, codec.memory, staging, 0);
            emit_load_i32(instrs, codec.memory, staging, 4);
            push(
                instrs,
                Instr::ArrayNewElem(ArrayNewElem {
                    ty: layout.type_id,
                    elem,
                }),
            );
        }
        GcConstructorKind::Struct | GcConstructorKind::ArrayGeneric => {
            push(
                instrs_mut(module, codec.allocate, seq),
                Instr::Unreachable(Unreachable {}),
            );
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn emit_fill_layout(
    module: &mut Module,
    codec: &DeclaredGcCodec,
    deps: EmitDependencies,
    seq: walrus::ir::InstrSeqId,
    layout: &GcLayout,
    recipe: LocalId,
    scalar_len: LocalId,
    reservation_len: LocalId,
    staging: LocalId,
    vector: LocalId,
) {
    let has_mutable = layout.fields.iter().any(|field| field.field.mutable);
    if !has_mutable {
        push(
            instrs_mut(module, codec.fill, seq),
            Instr::Return(Return {}),
        );
        return;
    }
    emit_load_payload(
        module,
        codec.fill,
        seq,
        codec,
        deps,
        recipe,
        layout.id,
        layout.type_ordinal,
        layout.kind.wire(),
        scalar_len,
        reservation_len,
        staging,
        vector,
    );
    match layout.kind {
        GcLayoutKind::Struct => {
            emit_fill_struct(module, codec, deps, seq, layout, recipe, staging, vector)
        }
        GcLayoutKind::Array => {
            emit_fill_array(module, codec, deps, seq, layout, recipe, staging, vector)
        }
    }
    let instrs = instrs_mut(module, codec.fill, seq);
    emit_release_payload(instrs, codec, deps, staging, reservation_len);
    push(instrs, Instr::Return(Return {}));
}

#[allow(clippy::too_many_arguments)]
fn emit_fill_struct(
    module: &mut Module,
    codec: &DeclaredGcCodec,
    deps: EmitDependencies,
    seq: walrus::ir::InstrSeqId,
    layout: &GcLayout,
    recipe: LocalId,
    staging: LocalId,
    vector: LocalId,
) {
    let concrete = RefType {
        nullable: true,
        heap_type: HeapType::Concrete(layout.type_id),
    };
    let object = module.locals.add(ValType::Ref(concrete));
    {
        let instrs = instrs_mut(module, codec.fill, seq);
        local_get(instrs, recipe);
        constant_i32(instrs, 1);
        binop(instrs, BinaryOp::I32Add);
        push(
            instrs,
            Instr::TableGet(TableGet {
                table: codec.transit,
            }),
        );
        push(
            instrs,
            Instr::RefCast(RefCast {
                nullable: true,
                heap_type: HeapType::Concrete(layout.type_id),
            }),
        );
        local_set(instrs, object);
    }
    let reference_decoders: Vec<_> = layout
        .fields
        .iter()
        .map(|field| match field.field.element_type {
            StorageType::Val(ValType::Ref(reference)) => {
                let class = runtime::ReferenceCodecClass::of(module, reference);
                Some((class.decoder(deps.codecs), class.nullable_type()))
            }
            _ => None,
        })
        .collect();
    for (index, field) in layout.fields.iter().enumerate() {
        if !field.field.mutable {
            continue;
        }
        let instrs = instrs_mut(module, codec.fill, seq);
        local_get(instrs, object);
        match field.field.element_type {
            StorageType::Val(ValType::Ref(reference)) => {
                local_get(instrs, vector);
                constant_i32(
                    instrs,
                    (layout.provenance_reference_count
                        + field.reference_ordinal.expect("reference ordinal"))
                        as i32,
                );
                call(instrs, deps.vector_get);
                let (decoder, broad) = reference_decoders[index].expect("reference decoder");
                call(instrs, decoder);
                emit_narrow(instrs, broad, reference);
            }
            storage => {
                local_get(instrs, staging);
                push(
                    instrs,
                    Instr::Load(Load {
                        memory: codec.memory,
                        kind: scalar_load(storage),
                        arg: MemArg {
                            align: 1,
                            offset: u64::from(
                                layout.provenance_scalar_len
                                    + field.scalar_offset.expect("scalar offset"),
                            ),
                        },
                    }),
                );
            }
        }
        push(
            instrs,
            Instr::StructSet(StructSet {
                ty: layout.type_id,
                field: index as u32,
            }),
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn emit_fill_array(
    module: &mut Module,
    codec: &DeclaredGcCodec,
    deps: EmitDependencies,
    seq: walrus::ir::InstrSeqId,
    layout: &GcLayout,
    recipe: LocalId,
    staging: LocalId,
    vector: LocalId,
) {
    let concrete = RefType {
        nullable: true,
        heap_type: HeapType::Concrete(layout.type_id),
    };
    let object = module.locals.add(ValType::Ref(concrete));
    let length = module.locals.add(ValType::I32);
    let index = module.locals.add(ValType::I32);
    {
        let instrs = instrs_mut(module, codec.fill, seq);
        local_get(instrs, recipe);
        constant_i32(instrs, 1);
        binop(instrs, BinaryOp::I32Add);
        push(
            instrs,
            Instr::TableGet(TableGet {
                table: codec.transit,
            }),
        );
        push(
            instrs,
            Instr::RefCast(RefCast {
                nullable: true,
                heap_type: HeapType::Concrete(layout.type_id),
            }),
        );
        local_set(instrs, object);
        emit_load_i32(instrs, codec.memory, staging, layout.provenance_scalar_len);
        local_set(instrs, length);
        constant_i32(instrs, 0);
        local_set(instrs, index);
    }
    let outer = dangling(module, codec.fill, walrus::ir::InstrSeqType::Simple(None));
    let body = dangling(module, codec.fill, walrus::ir::InstrSeqType::Simple(None));
    let reference_decoder = match layout.fields[0].field.element_type {
        StorageType::Val(ValType::Ref(reference)) => {
            let class = runtime::ReferenceCodecClass::of(module, reference);
            Some((reference, class.decoder(deps.codecs), class.nullable_type()))
        }
        _ => None,
    };
    {
        let instrs = instrs_mut(module, codec.fill, body);
        local_get(instrs, index);
        local_get(instrs, length);
        binop(instrs, BinaryOp::I32GeU);
        push(instrs, Instr::BrIf(BrIf { block: outer }));
        local_get(instrs, object);
        local_get(instrs, index);
        if let Some((reference, decoder, broad)) = reference_decoder {
            local_get(instrs, vector);
            local_get(instrs, index);
            constant_i32(instrs, layout.provenance_reference_count as i32);
            binop(instrs, BinaryOp::I32Add);
            call(instrs, deps.vector_get);
            call(instrs, decoder);
            emit_narrow(instrs, broad, reference);
        } else {
            emit_array_scalar_address(
                instrs,
                staging,
                codec.ptr_ty,
                index,
                layout.scalar_len_or_stride,
            );
            push(
                instrs,
                Instr::Load(Load {
                    memory: codec.memory,
                    kind: scalar_load(layout.fields[0].field.element_type),
                    arg: MemArg {
                        align: 1,
                        offset: u64::from(layout.provenance_scalar_len),
                    },
                }),
            );
        }
        push(instrs, Instr::ArraySet(ArraySet { ty: layout.type_id }));
        local_get(instrs, index);
        constant_i32(instrs, 1);
        binop(instrs, BinaryOp::I32Add);
        local_set(instrs, index);
        push(instrs, Instr::Br(Br { block: body }));
    }
    push(
        instrs_mut(module, codec.fill, outer),
        Instr::Loop(Loop { seq: body }),
    );
    push(
        instrs_mut(module, codec.fill, seq),
        Instr::Block(walrus::ir::Block { seq: outer }),
    );
}

fn emit_load_array_snapshot_element(
    module: &mut Module,
    codec: &DeclaredGcCodec,
    deps: EmitDependencies,
    seq: walrus::ir::InstrSeqId,
    layout: &GcLayout,
    staging: LocalId,
    vector: LocalId,
    index: u32,
    seeds: &ReferenceSeeds,
) {
    let reference_decoder = match layout.fields[0].field.element_type {
        StorageType::Val(ValType::Ref(reference)) => {
            let class = runtime::ReferenceCodecClass::of(module, reference);
            Some((
                reference,
                class,
                class.decoder(deps.codecs),
                class.nullable_type(),
                reference_seed(module, seeds, reference),
            ))
        }
        _ => None,
    };
    let instrs = instrs_mut(module, codec.allocate, seq);
    match layout.fields[0].field.element_type {
        StorageType::Val(ValType::Ref(reference)) => {
            let (_, class, decoder, broad, seed) = reference_decoder.expect("reference decoder");
            if layout.fields[0].field.mutable {
                if class == runtime::ReferenceCodecClass::Any {
                    local_get(instrs, vector);
                    constant_i32(instrs, index as i32);
                    call(instrs, deps.vector_get);
                    call(instrs, decoder);
                    emit_narrow(instrs, broad, reference);
                } else {
                    emit_seed_reference(instrs, seed);
                }
            } else {
                local_get(instrs, vector);
                constant_i32(instrs, (layout.provenance_reference_count + index) as i32);
                call(instrs, deps.vector_get);
                call(instrs, decoder);
                emit_narrow(instrs, broad, reference);
            }
        }
        storage => {
            local_get(instrs, staging);
            push(
                instrs,
                Instr::Load(Load {
                    memory: codec.memory,
                    kind: scalar_load(storage),
                    arg: MemArg {
                        align: 1,
                        offset: u64::from(
                            layout.provenance_scalar_len + 4 + index * layout.scalar_len_or_stride,
                        ),
                    },
                }),
            );
        }
    }
}

fn emit_load_i32(
    instrs: &mut Vec<(Instr, InstrLocId)>,
    memory: MemoryId,
    staging: LocalId,
    offset: u32,
) {
    local_get(instrs, staging);
    push(
        instrs,
        Instr::Load(Load {
            memory,
            kind: LoadKind::I32 { atomic: false },
            arg: MemArg {
                align: 1,
                offset: u64::from(offset),
            },
        }),
    );
}

fn scalar_load(storage: StorageType) -> LoadKind {
    match storage {
        StorageType::I8 => LoadKind::I32_8 {
            kind: walrus::ir::ExtendedLoad::ZeroExtend,
        },
        StorageType::I16 => LoadKind::I32_16 {
            kind: walrus::ir::ExtendedLoad::ZeroExtend,
        },
        StorageType::Val(ValType::I32) => LoadKind::I32 { atomic: false },
        StorageType::Val(ValType::I64) => LoadKind::I64 { atomic: false },
        StorageType::Val(ValType::F32) => LoadKind::F32,
        StorageType::Val(ValType::F64) => LoadKind::F64,
        StorageType::Val(ValType::V128) => LoadKind::V128,
        StorageType::Val(ValType::Ref(_)) => unreachable!("reference field uses recipe vector"),
    }
}

fn emit_default_scalar(instrs: &mut Vec<(Instr, InstrLocId)>, storage: StorageType) {
    let value = match storage {
        StorageType::I8 | StorageType::I16 | StorageType::Val(ValType::I32) => Value::I32(0),
        StorageType::Val(ValType::I64) => Value::I64(0),
        StorageType::Val(ValType::F32) => Value::F32(0.0),
        StorageType::Val(ValType::F64) => Value::F64(0.0),
        StorageType::Val(ValType::V128) => Value::V128(0),
        StorageType::Val(ValType::Ref(_)) => unreachable!(),
    };
    push(instrs, Instr::Const(Const { value }));
}

#[derive(Debug, Clone, Copy)]
enum ReferenceSeed {
    Func(FunctionId),
    Extern,
    Exn(FunctionId),
    Uninhabited,
}

fn reference_seed(module: &Module, seeds: &ReferenceSeeds, reference: RefType) -> ReferenceSeed {
    match reference.heap_type {
        HeapType::Abstract(AbstractHeapType::Func) => ReferenceSeed::Func(seeds.abstract_func),
        HeapType::Concrete(ty) | HeapType::Exact(ty) if module.types.get(ty).is_function() => {
            let func = seeds
                .concrete_funcs
                .get(&ty)
                .copied()
                .expect("planned concrete function seed");
            ReferenceSeed::Func(func)
        }
        HeapType::Abstract(AbstractHeapType::Extern) => ReferenceSeed::Extern,
        HeapType::Abstract(AbstractHeapType::Exn) => ReferenceSeed::Exn(seeds.exn),
        _ => ReferenceSeed::Uninhabited,
    }
}

fn emit_seed_reference(instrs: &mut Vec<(Instr, InstrLocId)>, seed: ReferenceSeed) {
    match seed {
        ReferenceSeed::Func(func) => push(instrs, Instr::RefFunc(RefFunc { func })),
        ReferenceSeed::Extern => {
            constant_i32(instrs, 0);
            push(instrs, Instr::RefI31(RefI31 {}));
            push(instrs, Instr::ExternConvertAny(ExternConvertAny {}));
        }
        ReferenceSeed::Exn(function) => call(instrs, function),
        // Bottom reference types have no runtime inhabitant. If an aggregate
        // with such a field is somehow routed here, trap before installing a
        // partially reconstructed identity.
        ReferenceSeed::Uninhabited => push(instrs, Instr::Unreachable(Unreachable {})),
    }
}

fn emit_narrow(instrs: &mut Vec<(Instr, InstrLocId)>, broad: RefType, expected: RefType) {
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
