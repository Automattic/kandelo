//! Guest-owned snapshot and reconstruction of module-instance state.
//!
//! A fork child is a fresh WebAssembly instance. Mutable globals, tables, and
//! passive-segment lifetime therefore do not survive merely because linear
//! memory was copied. This module emits typed guest helpers:
//!
//! * `wpk_fork_module_state_save(activation_id)` encodes every reference root
//!   and table entry into the process-wide recipe transaction and writes only
//!   recipe IDs/metadata into the KFMS arena.
//! * `wpk_fork_module_state_restore(activation_id)` decodes those IDs inside
//!   the fresh instance, restores globals, and replays static table baselines
//!   while passive segments are still available to later activations.
//! * `wpk_fork_module_state_finish_restore(activation_id)` restores the one
//!   canonical sparse overlay for each physical table, then reapplies the
//!   parent instance's `elem.drop`/`data.drop` state after the complete
//!   activation graph has consumed every segment-backed initializer.
//!
//! The helpers never expose references through the JavaScript Table/Global
//! APIs. `exnref` and GC values cross only typed Wasm-to-Wasm codec imports.

use std::collections::{HashMap, HashSet};

use anyhow::Result;
use sha2::{Digest, Sha256};
use walrus::{
    ConstExpr, DataId, DataKind, ElementId, ElementItems, ElementKind, ExportItem, FunctionBuilder,
    FunctionId, FunctionKind, GlobalId, InstrSeqBuilder, LocalFunction, LocalId, MemoryId, Module,
    RawCustomSection, RefType, TableId, TypeId, ValType,
    ir::{
        BinaryOp, Block, Br, BrIf, Call, CallIndirect, DataDrop, ElemDrop, ExtendedLoad, IfElse,
        Instr, InstrLocId, InstrSeqId, LegacyCatch, LoadKind, Loop, MemArg, MemoryInit,
        RefAsNonNull, RefCast, ReturnCall, ReturnCallIndirect, StoreKind, TableCopy, TableFill,
        TableGet, TableGrow, TableInit, TableSet, TableSize, TryTable, UnaryOp, Unreachable, Value,
    },
};
use wasm_posix_shared::abi::{
    WPK_FORK_EXPORT_MODULE_BOOTSTRAP, WPK_FORK_EXPORT_MODULE_STATE_FINISH_RESTORE,
    WPK_FORK_EXPORT_MODULE_STATE_RESTORE, WPK_FORK_EXPORT_MODULE_STATE_SAVE,
    WPK_FORK_EXPORT_MODULE_TABLE_STATE_RESTORE, WPK_FORK_EXPORT_MODULE_TABLE_STATE_SAVE,
    WPK_FORK_EXPORT_MODULE_THREAD_BOOTSTRAP, WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX,
    WPK_FORK_IMPORTED_GLOBAL_FLAG_MUTABLE, WPK_FORK_IMPORTED_GLOBAL_FLAG_SHARED,
    WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE, WPK_FORK_IMPORTED_GLOBALS_MAGIC,
    WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE, WPK_FORK_IMPORTED_GLOBALS_SECTION,
    WPK_FORK_IMPORTED_GLOBALS_VERSION, WPK_FORK_IMPORTED_TABLE_FLAG_TABLE64,
    WPK_FORK_IMPORTED_TABLES_HEADER_SIZE, WPK_FORK_IMPORTED_TABLES_MAGIC,
    WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE, WPK_FORK_IMPORTED_TABLES_SECTION,
    WPK_FORK_IMPORTED_TABLES_VERSION, WPK_FORK_MODULE_STATE_DATA_SEGMENT_HEADER_SIZE,
    WPK_FORK_MODULE_STATE_ELEMENT_SEGMENT_HEADER_SIZE, WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE,
    WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF, WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF,
    WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF, WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F32,
    WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F64, WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
    WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32, WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64,
    WPK_FORK_MODULE_STATE_GLOBAL_TYPE_V128, WPK_FORK_MODULE_STATE_IMPORT_MODULE,
    WPK_FORK_MODULE_STATE_IMPORT_RECORD_COMMIT, WPK_FORK_MODULE_STATE_IMPORT_RECORD_FIND,
    WPK_FORK_MODULE_STATE_IMPORT_RECORD_RESERVE, WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_COUNT,
    WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_MARK, WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_PAGE,
    WPK_FORK_MODULE_STATE_IMPORT_TABLE_GENERATION_ADDR,
    WPK_FORK_MODULE_STATE_IMPORT_TABLE_MUTATION_ABORT,
    WPK_FORK_MODULE_STATE_IMPORT_TABLE_MUTATION_BEGIN,
    WPK_FORK_MODULE_STATE_IMPORT_TABLE_MUTATION_COMMIT,
    WPK_FORK_MODULE_STATE_IMPORT_TABLE_RECONCILE, WPK_FORK_MODULE_STATE_IMPORT_TABLE_STATE_OWNED,
    WPK_FORK_MODULE_STATE_RECORD_KIND_DATA_SEGMENTS,
    WPK_FORK_MODULE_STATE_RECORD_KIND_ELEMENT_SEGMENTS,
    WPK_FORK_MODULE_STATE_RECORD_KIND_MUTABLE_GLOBAL, WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE,
    WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE_PAGE,
    WPK_FORK_MODULE_STATE_TABLE_DESCRIPTOR_PAYLOAD_SIZE,
    WPK_FORK_MODULE_STATE_TABLE_FLAG_SPARSE_OVERRIDES,
    WPK_FORK_MODULE_STATE_TABLE_PAGE_HEADER_SIZE, WPK_FORK_MODULE_STATE_TABLE_PAGE_SHIFT,
    WPK_FORK_MODULE_STATE_TABLE_RUN_HEADER_SIZE, WPK_FORK_RESUME_IMPORT_TABLE,
    WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX,
};

use crate::runtime::{ReferenceCodecClass, ReferenceCodecs, Runtime};

const TABLE_PAGE_SHIFT: u32 = WPK_FORK_MODULE_STATE_TABLE_PAGE_SHIFT as u32;
const TABLE_PAGE_SIZE: u64 = 1 << TABLE_PAGE_SHIFT;
const GLOBAL_RECIPE_PAYLOAD_SIZE: u32 = 4;
const WASM32_MAX_PAGES: u64 = 1 << 16;

#[derive(Debug, Clone, Copy)]
struct GlobalState {
    id: GlobalId,
    owner: u32,
    ty: ValType,
    restore: bool,
}

#[derive(Debug, Clone)]
struct ImportedGlobalState {
    module: String,
    name: String,
    import_ordinal: u32,
    owner: u32,
    ty: ValType,
    mutable: bool,
    shared: bool,
}

#[derive(Debug, Clone)]
struct ImportedTableState {
    module: String,
    name: String,
    import_ordinal: u32,
    owner: u32,
    table64: bool,
    ty: RefType,
}

#[derive(Debug, Clone, Copy)]
struct TableState {
    id: TableId,
    owner: u32,
    table64: bool,
    ty: RefType,
    baseline_len: u64,
    baseline_fingerprint: [u8; 32],
    synchronized: bool,
}

#[derive(Debug, Clone)]
struct ActiveElement {
    id: ElementId,
    table: TableId,
    offset: ConstExpr,
    offset_global: GlobalId,
    len: u64,
}

#[derive(Debug, Clone)]
struct ActiveData {
    id: DataId,
    memory: MemoryId,
    offset_global: GlobalId,
    len: u64,
}

/// Original module-instance state captured before the instrumenter adds its
/// private function catalog, imports, globals, and helper functions.
#[derive(Debug, Default)]
pub struct ModuleStatePlan {
    /// Every source global, including immutable locals and child-only host
    /// bindings, exported under a deterministic private name.
    ///
    /// WHY: a WebAssembly.Global is the only JavaScript API value that can
    /// carry an exnref binding into a fresh instance. The loader records which
    /// consumer import aliases which provider cell, then resolves the same
    /// cell from this catalog before instantiating the consumer.
    global_catalog: Vec<(GlobalId, u32)>,
    table_catalog: Vec<(TableId, u32)>,
    globals: Vec<GlobalState>,
    imported_globals: Vec<ImportedGlobalState>,
    imported_tables: Vec<ImportedTableState>,
    tables: Vec<TableState>,
    elements: Vec<(ElementId, bool)>,
    data: Vec<(DataId, bool)>,
    active_elements: Vec<ActiveElement>,
    active_data: Vec<ActiveData>,
    original_start: Option<FunctionId>,
    original_functions: Vec<FunctionId>,
}

/// Imported record operations shared by every generated helper.
#[derive(Debug, Clone, Copy)]
pub struct ModuleStateImports {
    pub reserve: FunctionId,
    pub commit: FunctionId,
    pub find: FunctionId,
    pub table_dirty_mark: FunctionId,
    pub table_dirty_count: FunctionId,
    pub table_dirty_page: FunctionId,
    pub table_state_owned: FunctionId,
    pub table_mutation_begin: FunctionId,
    pub table_mutation_commit: FunctionId,
    pub table_mutation_abort: FunctionId,
    pub table_reconcile: FunctionId,
    pub table_generation_addr: GlobalId,
}

/// Plan all state whose owner is a WebAssembly module activation.
pub fn plan(module: &mut Module) -> ModuleStatePlan {
    let import_ordinals: HashMap<_, _> = module
        .imports
        .iter()
        .enumerate()
        .map(|(ordinal, import)| {
            (
                import.id(),
                u32::try_from(ordinal).expect("import ordinal fits u32"),
            )
        })
        .collect();
    let mut original_functions: Vec<_> = module
        .funcs
        .iter()
        .filter_map(|func| matches!(func.kind, FunctionKind::Local(_)).then_some(func.id()))
        .collect();
    original_functions.sort();

    let mut globals: Vec<_> = module.globals.iter().map(|global| global.id()).collect();
    globals.sort();
    let global_catalog = globals
        .iter()
        .copied()
        .enumerate()
        .map(|(ordinal, id)| {
            (
                id,
                u32::try_from(ordinal + 1).expect("global owner ordinal fits u32"),
            )
        })
        .collect();
    let mut state_globals = Vec::new();
    let mut imported_globals = Vec::new();
    for (ordinal, id) in globals.into_iter().enumerate() {
        let global = module.globals.get(id);
        let imported = match global.kind {
            walrus::GlobalKind::Import(import_id) => Some(module.imports.get(import_id)),
            walrus::GlobalKind::Local(_) => None,
        };
        if imported_global_is_child_binding(module, global)
            || (!global.mutable && imported.is_none())
        {
            continue;
        }
        let owner = u32::try_from(ordinal + 1).expect("global owner ordinal fits u32");
        state_globals.push(GlobalState {
            id,
            owner,
            ty: global.ty,
            restore: global.mutable,
        });
        if let Some(import) = imported {
            // Preserve every declaration, including repeated JS property
            // identities. Immutable raw imports are coerced independently by
            // their declared Wasm types, so collapsing aliases here can lose
            // information even though one import-object property supplies all
            // declarations.
            imported_globals.push(ImportedGlobalState {
                module: import.module.to_owned(),
                name: import.name.to_owned(),
                import_ordinal: import_ordinals[&import.id()],
                owner,
                ty: global.ty,
                mutable: global.mutable,
                shared: global.shared,
            });
        }
    }

    let mut element_ids: Vec<_> = module.elements.iter().map(|elem| elem.id()).collect();
    element_ids.sort();
    let mut elements = Vec::with_capacity(element_ids.len());
    let mut active_elements = Vec::new();
    for id in element_ids {
        let initially_dropped = !matches!(module.elements.get(id).kind, ElementKind::Passive);
        elements.push((id, initially_dropped));
        let active = match &module.elements.get(id).kind {
            ElementKind::Active { table, offset } => Some((
                *table,
                offset.clone(),
                match &module.elements.get(id).items {
                    ElementItems::Functions(items) => items.len() as u64,
                    ElementItems::Expressions(_, items) => items.len() as u64,
                },
            )),
            _ => None,
        };
        if let Some((table, offset, len)) = active {
            let offset_global = module.globals.add_local(
                if module.tables.get(table).table64 {
                    ValType::I64
                } else {
                    ValType::I32
                },
                false,
                false,
                offset.clone(),
            );
            module.elements.get_mut(id).kind = ElementKind::Passive;
            active_elements.push(ActiveElement {
                id,
                table,
                offset,
                offset_global,
                len,
            });
        }
    }

    let mut data_ids: Vec<_> = module.data.iter().map(|data| data.id()).collect();
    data_ids.sort();
    let mut data = Vec::with_capacity(data_ids.len());
    let mut active_data = Vec::new();
    for id in data_ids {
        let initially_dropped = !matches!(module.data.get(id).kind, DataKind::Passive);
        data.push((id, initially_dropped));
        let active = match &module.data.get(id).kind {
            DataKind::Active { memory, offset } => Some((
                *memory,
                offset.clone(),
                module.data.get(id).value.len() as u64,
            )),
            DataKind::Passive => None,
        };
        if let Some((memory, offset, len)) = active {
            let offset_global = module.globals.add_local(
                if module.memories.get(memory).memory64 {
                    ValType::I64
                } else {
                    ValType::I32
                },
                false,
                false,
                offset.clone(),
            );
            module.data.get_mut(id).kind = DataKind::Passive;
            active_data.push(ActiveData {
                id,
                memory,
                offset_global,
                len,
            });
        }
    }

    let mut table_ids: Vec<_> = module.tables.iter().map(|table| table.id()).collect();
    table_ids.sort();
    let runtime_mutated_tables = collect_source_mutated_tables(module, &original_functions);
    let process_indirect_tables: HashSet<_> =
        if crate::call_graph::has_dynamic_linker_imports(module) {
            module
                .exports
                .iter()
                .filter_map(|export| {
                    (export.name == "__indirect_function_table")
                        .then_some(export.item)
                        .and_then(|item| match item {
                            ExportItem::Table(table) => Some(table),
                            _ => None,
                        })
                })
                .collect()
        } else {
            HashSet::new()
        };
    let table_catalog = table_ids
        .iter()
        .copied()
        .enumerate()
        .map(|(ordinal, id)| {
            (
                id,
                u32::try_from(ordinal + 1).expect("table owner ordinal fits u32"),
            )
        })
        .collect();
    let mut imported_tables = Vec::new();
    let tables = table_ids
        .into_iter()
        .enumerate()
        .filter_map(|(ordinal, id)| {
            let table = module.tables.get(id);
            if imported_table_is_resume_binding(module, table) {
                return None;
            }
            let owner = u32::try_from(ordinal + 1).expect("table owner ordinal fits u32");
            if let Some(import_id) = table.import {
                let import = module.imports.get(import_id);
                imported_tables.push(ImportedTableState {
                    module: import.module.to_owned(),
                    name: import.name.to_owned(),
                    import_ordinal: import_ordinals[&import.id()],
                    owner,
                    table64: table.table64,
                    ty: table.element_ty,
                });
            }
            Some(TableState {
                id,
                owner,
                table64: table.table64,
                ty: table.element_ty,
                baseline_len: table.initial,
                baseline_fingerprint: table_baseline_fingerprint(
                    module,
                    id,
                    owner,
                    &active_elements,
                ),
                // WHY: a local table with no runtime writer and no host-owned
                // process-table role is fully reconstructed by its declared
                // minimum plus static element initializers. Synchronizing it
                // would add a generation fence to ordinary table reads while
                // carrying no state that can differ between Workers.
                //
                // Imported tables stay synchronized because another
                // activation can mutate the aliased physical table. Kandelo's
                // dynamic linker mutates only the exact process indirect
                // table, and only an artifact importing its dlopen surface can
                // activate that writer. wasm-ld exports this table broadly,
                // so its name alone is not evidence of mutable state.
                synchronized: table.import.is_some()
                    || process_indirect_tables.contains(&id)
                    || runtime_mutated_tables.contains(&id),
            })
        })
        .collect();

    ModuleStatePlan {
        global_catalog,
        table_catalog,
        globals: state_globals,
        imported_globals,
        imported_tables,
        tables,
        elements,
        data,
        active_elements,
        active_data,
        original_start: module.start.take(),
        original_functions,
    }
}

fn table_baseline_fingerprint(
    module: &Module,
    table_id: TableId,
    owner: u32,
    active_elements: &[ActiveElement],
) -> [u8; 32] {
    let table = module.tables.get(table_id);
    let mut hasher = Sha256::new();
    hasher.update(b"kandelo-kfms-table-baseline-v1\0");
    hasher.update(owner.to_le_bytes());
    hasher.update([u8::from(table.table64)]);
    hasher.update(table.initial.to_le_bytes());
    hasher.update(table.maximum.unwrap_or(u64::MAX).to_le_bytes());
    hasher.update(format!("{:?}", table.element_ty).as_bytes());
    hasher.update(format!("{:?}", table.init).as_bytes());
    for active in active_elements
        .iter()
        .filter(|active| active.table == table_id)
    {
        hasher.update(format!("{:?}", active.offset).as_bytes());
        hasher.update(active.len.to_le_bytes());
        hasher.update(format!("{:?}", module.elements.get(active.id).items).as_bytes());
    }
    hasher.finalize().into()
}

/// Return the process-memory view used to exchange KFMS record payloads with
/// the host, adding Kandelo's standard side-module memory import when the
/// original module has no memory.
///
/// WHY: a module without guest loads/stores can still own mutable globals and
/// tables. The record callbacks return addresses in the process memory copied
/// to a fork child, so a private local memory would write the same numeric
/// address in the wrong allocation. `env.memory` gives every module activation
/// the same staging address space without imposing an artifact-shape failure.
pub fn ensure_staging_memory(module: &mut Module) -> MemoryId {
    if let Some(memory) = module.memories.iter().next() {
        return memory.id();
    }
    let (memory, _) = module.add_import_memory(
        "env",
        "memory",
        true,
        false,
        0,
        Some(WASM32_MAX_PAGES),
        None,
    );
    memory
}

fn imported_global_is_child_binding(module: &Module, global: &walrus::Global) -> bool {
    let walrus::GlobalKind::Import(import_id) = global.kind else {
        return false;
    };
    let import = module.imports.get(import_id);
    import.module == "env" && import.name == "__channel_base"
}

fn imported_table_is_resume_binding(module: &Module, table: &walrus::Table) -> bool {
    let Some(import_id) = table.import else {
        return false;
    };
    let import = module.imports.get(import_id);
    import.module == WPK_FORK_MODULE_STATE_IMPORT_MODULE
        && import.name == WPK_FORK_RESUME_IMPORT_TABLE
}

fn scalar_size(ty: ValType) -> u32 {
    match ty {
        ValType::I32 | ValType::F32 => 4,
        ValType::I64 | ValType::F64 => 8,
        ValType::V128 => 16,
        ValType::Ref(_) => unreachable!("reference globals store a recipe id"),
    }
}

fn scalar_align(ty: ValType) -> u32 {
    scalar_size(ty)
}

fn scalar_store_kind(ty: ValType) -> StoreKind {
    match ty {
        ValType::I32 => StoreKind::I32 { atomic: false },
        ValType::I64 => StoreKind::I64 { atomic: false },
        ValType::F32 => StoreKind::F32,
        ValType::F64 => StoreKind::F64,
        ValType::V128 => StoreKind::V128,
        ValType::Ref(_) => unreachable!("reference globals store a recipe id"),
    }
}

fn scalar_load_kind(ty: ValType) -> LoadKind {
    match ty {
        ValType::I32 => LoadKind::I32 { atomic: false },
        ValType::I64 => LoadKind::I64 { atomic: false },
        ValType::F32 => LoadKind::F32,
        ValType::F64 => LoadKind::F64,
        ValType::V128 => LoadKind::V128,
        ValType::Ref(_) => unreachable!("reference globals load a recipe id"),
    }
}

fn global_type_code(ty: ValType, class: Option<ReferenceCodecClass>) -> u8 {
    match (ty, class) {
        (ValType::I32, None) => WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32,
        (ValType::I64, None) => WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64,
        (ValType::F32, None) => WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F32,
        (ValType::F64, None) => WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F64,
        (ValType::V128, None) => WPK_FORK_MODULE_STATE_GLOBAL_TYPE_V128,
        (ValType::Ref(_), Some(ReferenceCodecClass::Func)) => {
            WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF
        }
        (ValType::Ref(_), Some(ReferenceCodecClass::Extern)) => {
            WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF
        }
        (ValType::Ref(_), Some(ReferenceCodecClass::Exn)) => {
            WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF
        }
        (ValType::Ref(_), Some(ReferenceCodecClass::Any)) => {
            WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF
        }
        _ => unreachable!("global type and codec class disagree"),
    }
}

#[derive(Debug)]
struct SegmentTracker<T> {
    segments: Vec<T>,
    globals: Vec<GlobalId>,
}

#[derive(Debug)]
struct Trackers {
    elements: SegmentTracker<ElementId>,
    data: SegmentTracker<DataId>,
}

/// Inject the KFMS record imports and the two typed guest helpers.
pub fn inject(
    module: &mut Module,
    runtime: &Runtime,
    plan: ModuleStatePlan,
) -> Result<FunctionId> {
    let memory = module
        .memories
        .iter()
        .next()
        .expect("module-state staging memory is injected before the runtime")
        .id();
    let codecs = runtime
        .reference_codecs
        .expect("linked module-state helpers require reference codecs");
    let imports = inject_record_imports(module, runtime.buf_type);
    let table_markers = inject_table_dirty_markers(module, imports, &plan);
    let (table_reconcile_guard, table_mutation_begin) =
        inject_table_reconcile_guard(module, memory, runtime.buf_type, imports);
    rewrite_table_mutations(
        module,
        &plan,
        &table_markers,
        table_reconcile_guard,
        table_mutation_begin,
        runtime.resume_table,
    );
    let trackers = inject_segment_trackers(module, &plan);
    rewrite_segment_drops(module, &trackers);
    let bootstrap_done =
        module
            .globals
            .add_local(ValType::I32, true, false, ConstExpr::Value(Value::I32(0)));
    let save = emit_save_helper(
        module,
        memory,
        runtime.buf_type,
        codecs,
        imports,
        &plan,
        &trackers,
    );
    let restore = emit_restore_helper(
        module,
        memory,
        runtime.buf_type,
        codecs,
        imports,
        &plan,
        bootstrap_done,
    )?;
    let finish_restore = emit_finish_restore_helper(
        module,
        memory,
        runtime.buf_type,
        codecs,
        imports,
        &plan,
        &trackers,
        bootstrap_done,
    );
    let table_save =
        emit_table_save_helper(module, memory, runtime.buf_type, codecs, imports, &plan);
    let table_restore =
        emit_table_restore_helper(module, memory, runtime.buf_type, codecs, imports, &plan);
    let bootstrap = emit_bootstrap_helper(module, &plan, bootstrap_done)?;
    let thread_bootstrap = emit_thread_bootstrap_helper(module, &plan, bootstrap_done)?;
    export_helpers(
        module,
        bootstrap,
        thread_bootstrap,
        save,
        restore,
        finish_restore,
        table_save,
        table_restore,
    );
    export_global_catalog(module, &plan.global_catalog);
    export_table_catalog(module, &plan.table_catalog);
    replace_imported_globals_section(module, &plan.imported_globals);
    replace_imported_tables_section(module, &plan.imported_tables);
    Ok(bootstrap)
}

fn export_global_catalog(module: &mut Module, globals: &[(GlobalId, u32)]) {
    for (global, owner) in globals {
        let name = format!("{WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX}{owner}");
        module.exports.add(&name, *global);
    }
}

fn export_table_catalog(module: &mut Module, tables: &[(TableId, u32)]) {
    for (table, owner) in tables {
        let name = format!("{WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX}{owner}");
        module.exports.add(&name, *table);
    }
}

fn replace_imported_globals_section(module: &mut Module, globals: &[ImportedGlobalState]) {
    loop {
        let existing = module
            .customs
            .iter()
            .find(|(_, section)| section.name() == WPK_FORK_IMPORTED_GLOBALS_SECTION)
            .map(|(id, _)| id);
        let Some(existing) = existing else { break };
        module.customs.delete(existing);
    }

    let records: Vec<_> = globals
        .iter()
        .map(|global| {
            let class = match global.ty {
                ValType::Ref(ty) => Some(ReferenceCodecClass::of(module, ty)),
                _ => None,
            };
            let module_len =
                u32::try_from(global.module.len()).expect("Wasm import module name fits u32");
            let name_len = u32::try_from(global.name.len()).expect("Wasm import name fits u32");
            let record_size =
                u32::from(WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE) + module_len + name_len;
            (
                global,
                global_type_code(global.ty, class),
                module_len,
                name_len,
                record_size,
            )
        })
        .collect();
    let capacity = usize::from(WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE)
        + records
            .iter()
            .map(|record| usize::try_from(record.4).unwrap())
            .sum::<usize>();
    let mut data = Vec::with_capacity(capacity);
    data.extend_from_slice(&WPK_FORK_IMPORTED_GLOBALS_MAGIC);
    data.extend_from_slice(&WPK_FORK_IMPORTED_GLOBALS_VERSION.to_le_bytes());
    data.extend_from_slice(&WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE.to_le_bytes());
    data.extend_from_slice(
        &u32::try_from(records.len())
            .expect("imported global count fits u32")
            .to_le_bytes(),
    );
    data.extend_from_slice(&0u32.to_le_bytes());
    for (global, type_code, module_len, name_len, record_size) in records {
        data.extend_from_slice(&record_size.to_le_bytes());
        data.extend_from_slice(&global.owner.to_le_bytes());
        data.push(type_code);
        data.push(
            (if global.mutable {
                WPK_FORK_IMPORTED_GLOBAL_FLAG_MUTABLE
            } else {
                0
            }) | (if global.shared {
                WPK_FORK_IMPORTED_GLOBAL_FLAG_SHARED
            } else {
                0
            }),
        );
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&module_len.to_le_bytes());
        data.extend_from_slice(&name_len.to_le_bytes());
        data.extend_from_slice(&global.import_ordinal.to_le_bytes());
        data.extend_from_slice(global.module.as_bytes());
        data.extend_from_slice(global.name.as_bytes());
    }
    debug_assert_eq!(data.len(), capacity);
    module.customs.add(RawCustomSection {
        name: WPK_FORK_IMPORTED_GLOBALS_SECTION.into(),
        data,
    });
}

fn replace_imported_tables_section(module: &mut Module, tables: &[ImportedTableState]) {
    loop {
        let existing = module
            .customs
            .iter()
            .find(|(_, section)| section.name() == WPK_FORK_IMPORTED_TABLES_SECTION)
            .map(|(id, _)| id);
        let Some(existing) = existing else { break };
        module.customs.delete(existing);
    }

    let records: Vec<_> = tables
        .iter()
        .map(|table| {
            let type_code = global_type_code(
                ValType::Ref(table.ty),
                Some(ReferenceCodecClass::of(module, table.ty)),
            );
            let module_len =
                u32::try_from(table.module.len()).expect("Wasm import module name fits u32");
            let name_len = u32::try_from(table.name.len()).expect("Wasm import name fits u32");
            let record_size =
                u32::from(WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE) + module_len + name_len;
            (table, type_code, module_len, name_len, record_size)
        })
        .collect();
    let capacity = usize::from(WPK_FORK_IMPORTED_TABLES_HEADER_SIZE)
        + records
            .iter()
            .map(|record| usize::try_from(record.4).unwrap())
            .sum::<usize>();
    let mut data = Vec::with_capacity(capacity);
    data.extend_from_slice(&WPK_FORK_IMPORTED_TABLES_MAGIC);
    data.extend_from_slice(&WPK_FORK_IMPORTED_TABLES_VERSION.to_le_bytes());
    data.extend_from_slice(&WPK_FORK_IMPORTED_TABLES_HEADER_SIZE.to_le_bytes());
    data.extend_from_slice(
        &u32::try_from(records.len())
            .expect("imported table count fits u32")
            .to_le_bytes(),
    );
    data.extend_from_slice(&0u32.to_le_bytes());
    for (table, type_code, module_len, name_len, record_size) in records {
        data.extend_from_slice(&record_size.to_le_bytes());
        data.extend_from_slice(&table.owner.to_le_bytes());
        data.push(type_code);
        data.push(if table.table64 {
            WPK_FORK_IMPORTED_TABLE_FLAG_TABLE64
        } else {
            0
        });
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&module_len.to_le_bytes());
        data.extend_from_slice(&name_len.to_le_bytes());
        data.extend_from_slice(&table.import_ordinal.to_le_bytes());
        data.extend_from_slice(table.module.as_bytes());
        data.extend_from_slice(table.name.as_bytes());
    }
    debug_assert_eq!(data.len(), capacity);
    module.customs.add(RawCustomSection {
        name: WPK_FORK_IMPORTED_TABLES_SECTION.into(),
        data,
    });
}

fn export_helpers(
    module: &mut Module,
    bootstrap: FunctionId,
    thread_bootstrap: FunctionId,
    save: FunctionId,
    restore: FunctionId,
    finish_restore: FunctionId,
    table_save: FunctionId,
    table_restore: FunctionId,
) {
    module
        .exports
        .add(WPK_FORK_EXPORT_MODULE_BOOTSTRAP, bootstrap);
    module
        .exports
        .add(WPK_FORK_EXPORT_MODULE_THREAD_BOOTSTRAP, thread_bootstrap);
    module.exports.add(WPK_FORK_EXPORT_MODULE_STATE_SAVE, save);
    module
        .exports
        .add(WPK_FORK_EXPORT_MODULE_STATE_RESTORE, restore);
    module
        .exports
        .add(WPK_FORK_EXPORT_MODULE_STATE_FINISH_RESTORE, finish_restore);
    module
        .exports
        .add(WPK_FORK_EXPORT_MODULE_TABLE_STATE_SAVE, table_save);
    module
        .exports
        .add(WPK_FORK_EXPORT_MODULE_TABLE_STATE_RESTORE, table_restore);
    module.funcs.get_mut(bootstrap).name = Some(WPK_FORK_EXPORT_MODULE_BOOTSTRAP.into());
    module.funcs.get_mut(thread_bootstrap).name =
        Some(WPK_FORK_EXPORT_MODULE_THREAD_BOOTSTRAP.into());
    module.funcs.get_mut(save).name = Some(WPK_FORK_EXPORT_MODULE_STATE_SAVE.into());
    module.funcs.get_mut(restore).name = Some(WPK_FORK_EXPORT_MODULE_STATE_RESTORE.into());
    module.funcs.get_mut(finish_restore).name =
        Some(WPK_FORK_EXPORT_MODULE_STATE_FINISH_RESTORE.into());
    module.funcs.get_mut(table_save).name = Some(WPK_FORK_EXPORT_MODULE_TABLE_STATE_SAVE.into());
    module.funcs.get_mut(table_restore).name =
        Some(WPK_FORK_EXPORT_MODULE_TABLE_STATE_RESTORE.into());
}

fn inject_record_imports(module: &mut Module, ptr_ty: ValType) -> ModuleStateImports {
    let reserve_ty = module.types.add(
        &[ValType::I32, ValType::I32, ValType::I32, ptr_ty],
        &[ptr_ty],
    );
    let commit_ty = module.types.add(&[ptr_ty], &[]);
    let find_ty = module.types.add(
        &[ValType::I32, ValType::I32, ValType::I32, ValType::I32],
        &[ptr_ty],
    );
    let table_dirty_mark_ty = module
        .types
        .add(&[ValType::I32, ValType::I64, ValType::I64], &[]);
    let table_dirty_count_ty = module.types.add(&[ValType::I32], &[ValType::I32]);
    let table_dirty_page_ty = module
        .types
        .add(&[ValType::I32, ValType::I32], &[ValType::I64]);
    let table_state_owned_ty = module.types.add(&[ValType::I32], &[ValType::I32]);
    let table_mutation_begin_ty = module.types.add(&[], &[ValType::I64]);
    let table_mutation_commit_ty = module
        .types
        .add(&[ValType::I32, ValType::I64, ValType::I64], &[]);
    let table_mutation_abort_ty = module.types.add(&[], &[]);
    let table_reconcile_ty = module.types.add(&[], &[ValType::I64]);
    let (reserve, _) = module.add_import_func(
        WPK_FORK_MODULE_STATE_IMPORT_MODULE,
        WPK_FORK_MODULE_STATE_IMPORT_RECORD_RESERVE,
        reserve_ty,
    );
    let (commit, _) = module.add_import_func(
        WPK_FORK_MODULE_STATE_IMPORT_MODULE,
        WPK_FORK_MODULE_STATE_IMPORT_RECORD_COMMIT,
        commit_ty,
    );
    let (find, _) = module.add_import_func(
        WPK_FORK_MODULE_STATE_IMPORT_MODULE,
        WPK_FORK_MODULE_STATE_IMPORT_RECORD_FIND,
        find_ty,
    );
    let (table_dirty_count, _) = module.add_import_func(
        WPK_FORK_MODULE_STATE_IMPORT_MODULE,
        WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_COUNT,
        table_dirty_count_ty,
    );
    let (table_dirty_mark, _) = module.add_import_func(
        WPK_FORK_MODULE_STATE_IMPORT_MODULE,
        WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_MARK,
        table_dirty_mark_ty,
    );
    let (table_dirty_page, _) = module.add_import_func(
        WPK_FORK_MODULE_STATE_IMPORT_MODULE,
        WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_PAGE,
        table_dirty_page_ty,
    );
    let (table_state_owned, _) = module.add_import_func(
        WPK_FORK_MODULE_STATE_IMPORT_MODULE,
        WPK_FORK_MODULE_STATE_IMPORT_TABLE_STATE_OWNED,
        table_state_owned_ty,
    );
    let (table_mutation_begin, _) = module.add_import_func(
        WPK_FORK_MODULE_STATE_IMPORT_MODULE,
        WPK_FORK_MODULE_STATE_IMPORT_TABLE_MUTATION_BEGIN,
        table_mutation_begin_ty,
    );
    let (table_mutation_commit, _) = module.add_import_func(
        WPK_FORK_MODULE_STATE_IMPORT_MODULE,
        WPK_FORK_MODULE_STATE_IMPORT_TABLE_MUTATION_COMMIT,
        table_mutation_commit_ty,
    );
    let (table_mutation_abort, _) = module.add_import_func(
        WPK_FORK_MODULE_STATE_IMPORT_MODULE,
        WPK_FORK_MODULE_STATE_IMPORT_TABLE_MUTATION_ABORT,
        table_mutation_abort_ty,
    );
    let (table_reconcile, _) = module.add_import_func(
        WPK_FORK_MODULE_STATE_IMPORT_MODULE,
        WPK_FORK_MODULE_STATE_IMPORT_TABLE_RECONCILE,
        table_reconcile_ty,
    );
    let (table_generation_addr, _) = module.add_import_global(
        WPK_FORK_MODULE_STATE_IMPORT_MODULE,
        WPK_FORK_MODULE_STATE_IMPORT_TABLE_GENERATION_ADDR,
        ValType::I64,
        false,
        false,
    );
    ModuleStateImports {
        reserve,
        commit,
        find,
        table_dirty_mark,
        table_dirty_count,
        table_dirty_page,
        table_state_owned,
        table_mutation_begin,
        table_mutation_commit,
        table_mutation_abort,
        table_reconcile,
        table_generation_addr,
    }
}

#[derive(Debug, Clone, Copy)]
struct TableDirtyMarker {
    mark: FunctionId,
    grow: FunctionId,
}

fn inject_table_dirty_markers(
    module: &mut Module,
    imports: ModuleStateImports,
    plan: &ModuleStatePlan,
) -> HashMap<TableId, TableDirtyMarker> {
    let mut markers = HashMap::new();
    for table in plan.tables.iter().filter(|table| table.synchronized) {
        let last_page =
            module
                .globals
                .add_local(ValType::I64, true, false, ConstExpr::Value(Value::I64(-1)));
        let start = module.locals.add(ValType::I64);
        let count = module.locals.add(ValType::I64);
        let first_page = module.locals.add(ValType::I64);
        let last_page_local = module.locals.add(ValType::I64);
        let mut mark_builder =
            FunctionBuilder::new(&mut module.types, &[ValType::I64, ValType::I64], &[]);
        {
            let mut body = mark_builder.func_body();
            body.local_get(count)
                .i64_const(0)
                .binop(BinaryOp::I64Ne)
                .if_else(
                    None,
                    |nonempty| {
                        nonempty
                            .local_get(start)
                            .i64_const(i64::from(TABLE_PAGE_SHIFT))
                            .binop(BinaryOp::I64ShrU)
                            .local_set(first_page)
                            .local_get(start)
                            .local_get(count)
                            .binop(BinaryOp::I64Add)
                            .i64_const(1)
                            .binop(BinaryOp::I64Sub)
                            .i64_const(i64::from(TABLE_PAGE_SHIFT))
                            .binop(BinaryOp::I64ShrU)
                            .local_set(last_page_local)
                            .local_get(first_page)
                            .local_get(last_page_local)
                            .binop(BinaryOp::I64Eq)
                            .global_get(last_page)
                            .local_get(last_page_local)
                            .binop(BinaryOp::I64Eq)
                            .binop(BinaryOp::I32And)
                            .unop(UnaryOp::I32Eqz)
                            .if_else(
                                None,
                                |uncached| {
                                    uncached
                                        .i32_const(table.owner as i32)
                                        .local_get(first_page)
                                        .local_get(last_page_local)
                                        .local_get(first_page)
                                        .binop(BinaryOp::I64Sub)
                                        .i64_const(1)
                                        .binop(BinaryOp::I64Add)
                                        .call(imports.table_dirty_mark)
                                        .local_get(last_page_local)
                                        .global_set(last_page);
                                },
                                |_| {},
                            )
                            // WHY: dirty-page caching is sufficient for one
                            // later fork capture, but another pthread owns a
                            // different Table object and may consume this
                            // mutation immediately. Commit while the process
                            // writer lock is still held.
                            .i32_const(table.owner as i32)
                            .local_get(start)
                            .local_get(count)
                            .call(imports.table_mutation_commit);
                    },
                    |empty| {
                        // A zero-length fill/copy/init/grow has no state to
                        // publish, but its pre-op reconciliation still owns
                        // one writer-lock depth that must be balanced.
                        empty.call(imports.table_mutation_abort);
                    },
                );
        }
        let mark = mark_builder.finish(vec![start, count], &mut module.funcs);

        let old = module.locals.add(ValType::I64);
        let delta = module.locals.add(ValType::I64);
        let failed = if table.table64 {
            u64::MAX
        } else {
            u64::from(u32::MAX)
        };
        let mut grow_builder =
            FunctionBuilder::new(&mut module.types, &[ValType::I64, ValType::I64], &[]);
        {
            let mut body = grow_builder.func_body();
            body.local_get(old)
                .i64_const(failed as i64)
                .binop(BinaryOp::I64Ne)
                .if_else(
                    None,
                    |succeeded| {
                        succeeded.local_get(old).local_get(delta).call(mark);
                    },
                    |failed| {
                        // table.grow reports failure instead of trapping. End
                        // the mutation transaction without publishing state.
                        failed.call(imports.table_mutation_abort);
                    },
                );
        }
        let grow = grow_builder.finish(vec![old, delta], &mut module.funcs);
        markers.insert(table.id, TableDirtyMarker { mark, grow });
    }
    markers
}

fn inject_table_reconcile_guard(
    module: &mut Module,
    memory: MemoryId,
    ptr_ty: ValType,
    imports: ModuleStateImports,
) -> (FunctionId, FunctionId) {
    let last_generation =
        module
            .globals
            .add_local(ValType::I64, true, false, ConstExpr::Value(Value::I64(0)));
    let memory_is_shared = module.memories.get(memory).shared;
    let mut builder = FunctionBuilder::new(&mut module.types, &[], &[]);
    {
        let mut body = builder.func_body();
        body.global_get(imports.table_generation_addr);
        if ptr_ty == ValType::I32 {
            body.unop(UnaryOp::I32WrapI64);
        }
        body.load(
            memory,
            LoadKind::I64 {
                // Atomic loads are required for cross-Worker publication.
                // Keep standalone/unshared test modules valid: there is no
                // peer Agent in that shape, so an ordinary aligned load is
                // already race-free.
                atomic: memory_is_shared,
            },
            MemArg {
                align: 8,
                offset: 0,
            },
        )
        .global_get(last_generation)
        .binop(BinaryOp::I64Ne)
        .if_else(
            None,
            |changed| {
                // The host returns the exact generation it applied. Do
                // not reread the shared fence here: a writer may publish a
                // newer generation after reconcile returns, and caching
                // that unapplied value would skip the next guard.
                changed
                    .call(imports.table_reconcile)
                    .global_set(last_generation);
            },
            |_| {},
        );
    }
    let guard = builder.finish(Vec::new(), &mut module.funcs);
    module.funcs.get_mut(guard).name = Some("__wpk_fork_table_generation_guard".into());
    let mut mutation_builder = FunctionBuilder::new(&mut module.types, &[], &[]);
    mutation_builder
        .func_body()
        .call(imports.table_mutation_begin)
        .global_set(last_generation);
    let mutation_begin = mutation_builder.finish(Vec::new(), &mut module.funcs);
    module.funcs.get_mut(mutation_begin).name = Some("__wpk_fork_table_mutation_begin".into());
    (guard, mutation_begin)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum TableOperation {
    Set(TableId),
    Fill(TableId),
    Copy { src: TableId, dst: TableId },
    Init { table: TableId, elem: ElementId },
    Grow(TableId),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum TableConsumer {
    Get(TableId),
    Size(TableId),
    CallIndirect { table: TableId, ty: TypeId },
    ReturnCallIndirect { table: TableId, ty: TypeId },
}

fn rewrite_table_mutations(
    module: &mut Module,
    plan: &ModuleStatePlan,
    markers: &HashMap<TableId, TableDirtyMarker>,
    reconcile_guard: FunctionId,
    mutation_begin: FunctionId,
    resume_table: Option<TableId>,
) {
    let table_states: HashMap<_, _> = plan.tables.iter().map(|table| (table.id, *table)).collect();
    let synchronized_tables: HashSet<_> = plan
        .tables
        .iter()
        .filter(|table| table.synchronized)
        .map(|table| table.id)
        .collect();
    let mut operations = HashSet::new();
    let mut consumers = HashSet::new();
    for function in &plan.original_functions {
        let FunctionKind::Local(local) = &module.funcs.get(*function).kind else {
            continue;
        };
        collect_table_operations(
            local,
            local.entry_block(),
            resume_table,
            &synchronized_tables,
            &mut operations,
            &mut consumers,
        );
    }
    let helpers: HashMap<_, _> = operations
        .into_iter()
        .map(|operation| {
            let helper = emit_table_operation_helper(
                module,
                &table_states,
                markers,
                mutation_begin,
                operation,
            );
            (operation, helper)
        })
        .collect();
    let consumer_helpers: HashMap<_, _> = consumers
        .into_iter()
        .map(|consumer| {
            let helper =
                emit_table_consumer_helper(module, &table_states, reconcile_guard, consumer);
            (consumer, helper)
        })
        .collect();
    for function in &plan.original_functions {
        let FunctionKind::Local(local) = &mut module.funcs.get_mut(*function).kind else {
            continue;
        };
        rewrite_table_mutation_seq(
            local,
            local.entry_block(),
            &helpers,
            &consumer_helpers,
            resume_table,
            false,
        );
    }

    // Fork call-transport helpers are emitted after module_state::plan, so
    // they are not in original_functions. Guard them at entry, before their
    // parameters are reloaded for the one indirect call, and leave that call
    // in place to avoid reintroducing an operand-stack scratch local.
    let transport_helpers: Vec<_> = module
        .funcs
        .iter()
        .filter(|function| {
            function
                .name
                .as_deref()
                .is_some_and(|name| name.starts_with("__wpk_fork_unwind_transport_indirect_"))
                && matches!(function.kind, FunctionKind::Local(_))
        })
        .map(|function| function.id())
        .collect();
    for function in transport_helpers {
        let FunctionKind::Local(local) = &module.funcs.get(function).kind else {
            unreachable!()
        };
        let mut transport_operations = HashSet::new();
        let mut transport_consumers = HashSet::new();
        collect_table_operations(
            local,
            local.entry_block(),
            resume_table,
            &synchronized_tables,
            &mut transport_operations,
            &mut transport_consumers,
        );
        let guard_at_entry = !transport_consumers.is_empty();
        let FunctionKind::Local(local) = &mut module.funcs.get_mut(function).kind else {
            unreachable!()
        };
        let entry = local.entry_block();
        if guard_at_entry {
            let loc = local
                .block(entry)
                .instrs
                .first()
                .map(|(_, loc)| *loc)
                .unwrap_or_default();
            local.block_mut(entry).instrs.insert(
                0,
                (
                    Call {
                        func: reconcile_guard,
                    }
                    .into(),
                    loc,
                ),
            );
        }
        rewrite_table_mutation_seq(
            local,
            entry,
            &helpers,
            &consumer_helpers,
            resume_table,
            guard_at_entry,
        );
    }
}

fn collect_table_operations(
    local: &LocalFunction,
    seq: InstrSeqId,
    resume_table: Option<TableId>,
    synchronized_tables: &HashSet<TableId>,
    operations: &mut HashSet<TableOperation>,
    consumers: &mut HashSet<TableConsumer>,
) {
    for (instr, _) in &local.block(seq).instrs {
        for child in nested_seqs(instr) {
            collect_table_operations(
                local,
                child,
                resume_table,
                synchronized_tables,
                operations,
                consumers,
            );
        }
        let operation = match instr {
            Instr::TableSet(set) => Some(TableOperation::Set(set.table)),
            Instr::TableFill(fill) => Some(TableOperation::Fill(fill.table)),
            Instr::TableCopy(copy) => Some(TableOperation::Copy {
                src: copy.src,
                dst: copy.dst,
            }),
            Instr::TableInit(init) => Some(TableOperation::Init {
                table: init.table,
                elem: init.elem,
            }),
            Instr::TableGrow(grow) => Some(TableOperation::Grow(grow.table)),
            _ => None,
        };
        if let Some(operation) = operation {
            operations.insert(operation);
        }
        let consumer = match instr {
            Instr::TableGet(get)
                if Some(get.table) != resume_table && synchronized_tables.contains(&get.table) =>
            {
                Some(TableConsumer::Get(get.table))
            }
            Instr::TableSize(size)
                if Some(size.table) != resume_table
                    && synchronized_tables.contains(&size.table) =>
            {
                Some(TableConsumer::Size(size.table))
            }
            Instr::CallIndirect(call)
                if Some(call.table) != resume_table
                    && synchronized_tables.contains(&call.table) =>
            {
                Some(TableConsumer::CallIndirect {
                    table: call.table,
                    ty: call.ty,
                })
            }
            Instr::ReturnCallIndirect(call)
                if Some(call.table) != resume_table
                    && synchronized_tables.contains(&call.table) =>
            {
                Some(TableConsumer::ReturnCallIndirect {
                    table: call.table,
                    ty: call.ty,
                })
            }
            _ => None,
        };
        if let Some(consumer) = consumer {
            consumers.insert(consumer);
        }
    }
}

fn collect_source_mutated_tables(module: &Module, functions: &[FunctionId]) -> HashSet<TableId> {
    fn visit(local: &LocalFunction, seq: InstrSeqId, mutated: &mut HashSet<TableId>) {
        for (instr, _) in &local.block(seq).instrs {
            for child in nested_seqs(instr) {
                visit(local, child, mutated);
            }
            match instr {
                Instr::TableSet(set) => {
                    mutated.insert(set.table);
                }
                Instr::TableFill(fill) => {
                    mutated.insert(fill.table);
                }
                Instr::TableCopy(copy) => {
                    mutated.insert(copy.dst);
                }
                Instr::TableInit(init) => {
                    mutated.insert(init.table);
                }
                Instr::TableGrow(grow) => {
                    mutated.insert(grow.table);
                }
                _ => {}
            }
        }
    }

    let mut mutated = HashSet::new();
    for function in functions {
        let FunctionKind::Local(local) = &module.funcs.get(*function).kind else {
            continue;
        };
        visit(local, local.entry_block(), &mut mutated);
    }
    mutated
}

fn emit_table_operation_helper(
    module: &mut Module,
    tables: &HashMap<TableId, TableState>,
    markers: &HashMap<TableId, TableDirtyMarker>,
    mutation_begin: FunctionId,
    operation: TableOperation,
) -> FunctionId {
    let (function, name) = match operation {
        TableOperation::Set(table_id) => {
            let table = tables[&table_id];
            let marker = markers[&table_id];
            let index_ty = table_index_type(table);
            let index = module.locals.add(index_ty);
            let reference = module.locals.add(ValType::Ref(table.ty));
            let mut builder =
                FunctionBuilder::new(&mut module.types, &[index_ty, ValType::Ref(table.ty)], &[]);
            {
                let mut body = builder.func_body();
                body.call(mutation_begin)
                    .local_get(index)
                    .local_get(reference)
                    .instr(TableSet { table: table_id });
                builder_index_as_i64(&mut body, index_ty, index);
                body.i64_const(1).call(marker.mark);
            }
            (
                builder.finish(vec![index, reference], &mut module.funcs),
                format!("__wpk_fork_table_set_{}", table.owner),
            )
        }
        TableOperation::Fill(table_id) => {
            let table = tables[&table_id];
            let marker = markers[&table_id];
            let index_ty = table_index_type(table);
            let dst = module.locals.add(index_ty);
            let reference = module.locals.add(ValType::Ref(table.ty));
            let count = module.locals.add(index_ty);
            let mut builder = FunctionBuilder::new(
                &mut module.types,
                &[index_ty, ValType::Ref(table.ty), index_ty],
                &[],
            );
            {
                let mut body = builder.func_body();
                body.call(mutation_begin)
                    .local_get(dst)
                    .local_get(reference)
                    .local_get(count)
                    .instr(TableFill { table: table_id });
                builder_index_as_i64(&mut body, index_ty, dst);
                builder_index_as_i64(&mut body, index_ty, count);
                body.call(marker.mark);
            }
            (
                builder.finish(vec![dst, reference, count], &mut module.funcs),
                format!("__wpk_fork_table_fill_{}", table.owner),
            )
        }
        TableOperation::Copy { src, dst } => {
            let src_table = tables[&src];
            let dst_table = tables[&dst];
            let marker = markers[&dst];
            let src_ty = table_index_type(src_table);
            let dst_ty = table_index_type(dst_table);
            let count_ty = if src_ty == ValType::I32 || dst_ty == ValType::I32 {
                ValType::I32
            } else {
                ValType::I64
            };
            let dst_index = module.locals.add(dst_ty);
            let src_index = module.locals.add(src_ty);
            let count = module.locals.add(count_ty);
            let mut builder =
                FunctionBuilder::new(&mut module.types, &[dst_ty, src_ty, count_ty], &[]);
            {
                let mut body = builder.func_body();
                body.call(mutation_begin)
                    .local_get(dst_index)
                    .local_get(src_index)
                    .local_get(count)
                    .instr(TableCopy { src, dst });
                builder_index_as_i64(&mut body, dst_ty, dst_index);
                builder_index_as_i64(&mut body, count_ty, count);
                body.call(marker.mark);
            }
            (
                builder.finish(vec![dst_index, src_index, count], &mut module.funcs),
                format!(
                    "__wpk_fork_table_copy_{}_from_{}",
                    dst_table.owner, src_table.owner
                ),
            )
        }
        TableOperation::Init {
            table: table_id,
            elem,
        } => {
            let table = tables[&table_id];
            let marker = markers[&table_id];
            let index_ty = table_index_type(table);
            let dst = module.locals.add(index_ty);
            let src = module.locals.add(ValType::I32);
            let count = module.locals.add(ValType::I32);
            let mut builder = FunctionBuilder::new(
                &mut module.types,
                &[index_ty, ValType::I32, ValType::I32],
                &[],
            );
            {
                let mut body = builder.func_body();
                body.call(mutation_begin)
                    .local_get(dst)
                    .local_get(src)
                    .local_get(count)
                    .instr(TableInit {
                        table: table_id,
                        elem,
                    });
                builder_index_as_i64(&mut body, index_ty, dst);
                builder_index_as_i64(&mut body, ValType::I32, count);
                body.call(marker.mark);
            }
            (
                builder.finish(vec![dst, src, count], &mut module.funcs),
                format!("__wpk_fork_table_init_{}_{}", table.owner, elem.index()),
            )
        }
        TableOperation::Grow(table_id) => {
            let table = tables[&table_id];
            let marker = markers[&table_id];
            let index_ty = table_index_type(table);
            let reference = module.locals.add(ValType::Ref(table.ty));
            let delta = module.locals.add(index_ty);
            let result = module.locals.add(index_ty);
            let mut builder = FunctionBuilder::new(
                &mut module.types,
                &[ValType::Ref(table.ty), index_ty],
                &[index_ty],
            );
            {
                let mut body = builder.func_body();
                body.call(mutation_begin)
                    .local_get(reference)
                    .local_get(delta)
                    .instr(TableGrow { table: table_id })
                    .local_set(result);
                builder_index_as_i64(&mut body, index_ty, result);
                builder_index_as_i64(&mut body, index_ty, delta);
                body.call(marker.grow).local_get(result);
            }
            (
                builder.finish(vec![reference, delta], &mut module.funcs),
                format!("__wpk_fork_table_grow_{}", table.owner),
            )
        }
    };
    module.funcs.get_mut(function).name = Some(name);
    function
}

fn emit_table_consumer_helper(
    module: &mut Module,
    tables: &HashMap<TableId, TableState>,
    reconcile_guard: FunctionId,
    consumer: TableConsumer,
) -> FunctionId {
    let (function, name) = match consumer {
        TableConsumer::Get(table_id) => {
            let table = tables[&table_id];
            let index_ty = table_index_type(table);
            let index = module.locals.add(index_ty);
            let mut builder =
                FunctionBuilder::new(&mut module.types, &[index_ty], &[ValType::Ref(table.ty)]);
            builder
                .func_body()
                .call(reconcile_guard)
                .local_get(index)
                .instr(TableGet { table: table_id });
            (
                builder.finish(vec![index], &mut module.funcs),
                format!("__wpk_fork_table_get_{}", table.owner),
            )
        }
        TableConsumer::Size(table_id) => {
            let table = tables[&table_id];
            let index_ty = table_index_type(table);
            let mut builder = FunctionBuilder::new(&mut module.types, &[], &[index_ty]);
            builder
                .func_body()
                .call(reconcile_guard)
                .instr(TableSize { table: table_id });
            (
                builder.finish(Vec::new(), &mut module.funcs),
                format!("__wpk_fork_table_size_{}", table.owner),
            )
        }
        TableConsumer::CallIndirect { table, ty } => {
            let table_state = tables[&table];
            let signature = module.types.get(ty);
            let params = signature.params().to_vec();
            let results = signature.results().to_vec();
            let mut args: Vec<_> = params
                .iter()
                .map(|param| module.locals.add(*param))
                .collect();
            let index_ty = table_index_type(table_state);
            let index = module.locals.add(index_ty);
            let mut helper_params = params;
            helper_params.push(index_ty);
            let mut builder = FunctionBuilder::new(&mut module.types, &helper_params, &results);
            {
                let mut body = builder.func_body();
                body.call(reconcile_guard);
                for arg in &args {
                    body.local_get(*arg);
                }
                body.local_get(index).instr(CallIndirect { table, ty });
            }
            args.push(index);
            (
                builder.finish(args, &mut module.funcs),
                format!(
                    "__wpk_fork_table_call_indirect_{}_{}",
                    table_state.owner,
                    ty.index()
                ),
            )
        }
        TableConsumer::ReturnCallIndirect { table, ty } => {
            let table_state = tables[&table];
            let signature = module.types.get(ty);
            let params = signature.params().to_vec();
            let results = signature.results().to_vec();
            let mut args: Vec<_> = params
                .iter()
                .map(|param| module.locals.add(*param))
                .collect();
            let index_ty = table_index_type(table_state);
            let index = module.locals.add(index_ty);
            let mut helper_params = params;
            helper_params.push(index_ty);
            let mut builder = FunctionBuilder::new(&mut module.types, &helper_params, &results);
            {
                let mut body = builder.func_body();
                body.call(reconcile_guard);
                for arg in &args {
                    body.local_get(*arg);
                }
                body.local_get(index)
                    .instr(ReturnCallIndirect { table, ty });
            }
            args.push(index);
            (
                builder.finish(args, &mut module.funcs),
                format!(
                    "__wpk_fork_table_return_call_indirect_{}_{}",
                    table_state.owner,
                    ty.index()
                ),
            )
        }
    };
    module.funcs.get_mut(function).name = Some(name);
    function
}

fn builder_index_as_i64(body: &mut InstrSeqBuilder, ty: ValType, local: LocalId) {
    body.local_get(local);
    if ty == ValType::I32 {
        body.unop(UnaryOp::I64ExtendUI32);
    }
}

fn rewrite_table_mutation_seq(
    local: &mut LocalFunction,
    seq: InstrSeqId,
    helpers: &HashMap<TableOperation, FunctionId>,
    consumer_helpers: &HashMap<TableConsumer, FunctionId>,
    resume_table: Option<TableId>,
    consumers_guarded_at_entry: bool,
) {
    let old = std::mem::take(&mut local.block_mut(seq).instrs);
    let mut rewritten = Vec::with_capacity(old.len());
    for (instr, loc) in old {
        for child in nested_seqs(&instr) {
            rewrite_table_mutation_seq(
                local,
                child,
                helpers,
                consumer_helpers,
                resume_table,
                consumers_guarded_at_entry,
            );
        }
        match instr {
            Instr::TableSet(set) => {
                push(
                    &mut rewritten,
                    Call {
                        func: helpers[&TableOperation::Set(set.table)],
                    },
                    loc,
                );
            }
            Instr::TableFill(fill) => {
                push(
                    &mut rewritten,
                    Call {
                        func: helpers[&TableOperation::Fill(fill.table)],
                    },
                    loc,
                );
            }
            Instr::TableCopy(copy) => {
                push(
                    &mut rewritten,
                    Call {
                        func: helpers[&TableOperation::Copy {
                            src: copy.src,
                            dst: copy.dst,
                        }],
                    },
                    loc,
                );
            }
            Instr::TableInit(init) => {
                push(
                    &mut rewritten,
                    Call {
                        func: helpers[&TableOperation::Init {
                            table: init.table,
                            elem: init.elem,
                        }],
                    },
                    loc,
                );
            }
            Instr::TableGrow(grow) => {
                push(
                    &mut rewritten,
                    Call {
                        func: helpers[&TableOperation::Grow(grow.table)],
                    },
                    loc,
                );
            }
            other @ Instr::CallIndirect(CallIndirect { table, .. })
                if Some(table) == resume_table || consumers_guarded_at_entry =>
            {
                // WHY: this private dispatch table is host-built, immutable,
                // and already excluded from module-state ownership. Keeping
                // the guard out of resume_peek -> call_indirect also preserves
                // the operand-stack shape that Binaryen can lower without a
                // per-call-site scratch local.
                rewritten.push((other, loc));
            }
            other @ Instr::ReturnCallIndirect(ReturnCallIndirect { table, .. })
                if Some(table) == resume_table || consumers_guarded_at_entry =>
            {
                rewritten.push((other, loc));
            }
            other @ Instr::TableGet(TableGet { table })
                if Some(table) == resume_table || consumers_guarded_at_entry =>
            {
                rewritten.push((other, loc));
            }
            other @ Instr::TableSize(TableSize { table })
                if Some(table) == resume_table || consumers_guarded_at_entry =>
            {
                rewritten.push((other, loc));
            }
            Instr::CallIndirect(call) => {
                let consumer = TableConsumer::CallIndirect {
                    table: call.table,
                    ty: call.ty,
                };
                if let Some(&func) = consumer_helpers.get(&consumer) {
                    push(&mut rewritten, Call { func }, loc);
                } else {
                    rewritten.push((Instr::CallIndirect(call), loc));
                }
            }
            Instr::ReturnCallIndirect(call) => {
                let consumer = TableConsumer::ReturnCallIndirect {
                    table: call.table,
                    ty: call.ty,
                };
                if let Some(&func) = consumer_helpers.get(&consumer) {
                    push(&mut rewritten, ReturnCall { func }, loc);
                } else {
                    rewritten.push((Instr::ReturnCallIndirect(call), loc));
                }
            }
            Instr::TableGet(get) => {
                if let Some(&func) = consumer_helpers.get(&TableConsumer::Get(get.table)) {
                    push(&mut rewritten, Call { func }, loc);
                } else {
                    rewritten.push((Instr::TableGet(get), loc));
                }
            }
            Instr::TableSize(size) => {
                if let Some(&func) = consumer_helpers.get(&TableConsumer::Size(size.table)) {
                    push(&mut rewritten, Call { func }, loc);
                } else {
                    rewritten.push((Instr::TableSize(size), loc));
                }
            }
            other => rewritten.push((other, loc)),
        }
    }
    local.block_mut(seq).instrs = rewritten;
}

fn push<T: Into<Instr>>(out: &mut Vec<(Instr, InstrLocId)>, instr: T, loc: InstrLocId) {
    out.push((instr.into(), loc));
}

fn inject_segment_trackers(module: &mut Module, plan: &ModuleStatePlan) -> Trackers {
    fn tracker<T: Copy>(module: &mut Module, segments: &[(T, bool)]) -> SegmentTracker<T> {
        let mut globals = Vec::with_capacity(segments.len().div_ceil(32));
        for chunk in segments.chunks(32) {
            let mut initial = 0u32;
            for (bit, (_, dropped)) in chunk.iter().enumerate() {
                if *dropped {
                    initial |= 1 << bit;
                }
            }
            globals.push(module.globals.add_local(
                ValType::I32,
                true,
                false,
                ConstExpr::Value(Value::I32(initial as i32)),
            ));
        }
        SegmentTracker {
            segments: segments.iter().map(|(id, _)| *id).collect(),
            globals,
        }
    }

    Trackers {
        elements: tracker(module, &plan.elements),
        data: tracker(module, &plan.data),
    }
}

fn rewrite_segment_drops(module: &mut Module, trackers: &Trackers) {
    let element_bits: HashMap<_, _> = trackers
        .elements
        .segments
        .iter()
        .enumerate()
        .map(|(index, id)| (*id, index))
        .collect();
    let data_bits: HashMap<_, _> = trackers
        .data
        .segments
        .iter()
        .enumerate()
        .map(|(index, id)| (*id, index))
        .collect();
    let funcs: Vec<_> = module
        .funcs
        .iter()
        .filter_map(|func| matches!(func.kind, FunctionKind::Local(_)).then_some(func.id()))
        .collect();
    for func in funcs {
        let FunctionKind::Local(local) = &mut module.funcs.get_mut(func).kind else {
            unreachable!()
        };
        rewrite_drop_seq(
            local,
            local.entry_block(),
            &element_bits,
            &trackers.elements.globals,
            &data_bits,
            &trackers.data.globals,
        );
    }
}

fn rewrite_drop_seq(
    local: &mut LocalFunction,
    seq: InstrSeqId,
    element_bits: &HashMap<ElementId, usize>,
    element_globals: &[GlobalId],
    data_bits: &HashMap<DataId, usize>,
    data_globals: &[GlobalId],
) {
    let old = std::mem::take(&mut local.block_mut(seq).instrs);
    let mut rewritten = Vec::with_capacity(old.len());
    for (instr, loc) in old {
        for child in nested_seqs(&instr) {
            rewrite_drop_seq(
                local,
                child,
                element_bits,
                element_globals,
                data_bits,
                data_globals,
            );
        }
        let tracked = match &instr {
            Instr::ElemDrop(ElemDrop { elem }) => element_bits
                .get(elem)
                .map(|index| (*index, element_globals)),
            Instr::DataDrop(DataDrop { data }) => {
                data_bits.get(data).map(|index| (*index, data_globals))
            }
            _ => None,
        };
        rewritten.push((instr, loc));
        if let Some((index, globals)) = tracked {
            let word = globals[index / 32];
            rewritten.push((
                Instr::GlobalGet(walrus::ir::GlobalGet { global: word }),
                loc,
            ));
            rewritten.push((
                Instr::Const(walrus::ir::Const {
                    value: Value::I32((1u32 << (index % 32)) as i32),
                }),
                loc,
            ));
            rewritten.push((
                Instr::Binop(walrus::ir::Binop {
                    op: BinaryOp::I32Or,
                }),
                loc,
            ));
            rewritten.push((
                Instr::GlobalSet(walrus::ir::GlobalSet { global: word }),
                loc,
            ));
        }
    }
    local.block_mut(seq).instrs = rewritten;
}

fn nested_seqs(instr: &Instr) -> Vec<InstrSeqId> {
    match instr {
        Instr::Block(Block { seq }) => vec![*seq],
        Instr::Loop(Loop { seq }) => vec![*seq],
        Instr::IfElse(IfElse {
            consequent,
            alternative,
        }) => vec![*consequent, *alternative],
        Instr::TryTable(TryTable { seq, .. }) => vec![*seq],
        Instr::Try(try_) => {
            let mut ids = vec![try_.seq];
            for catch in &try_.catches {
                match catch {
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

#[derive(Debug, Clone, Copy)]
struct TableLocals {
    payload: LocalId,
    len: LocalId,
    current_len: LocalId,
    page_count: LocalId,
    record_page_count: LocalId,
    page_ordinal: LocalId,
    page_index: LocalId,
    page_start_wide: LocalId,
    page_start: LocalId,
    count: LocalId,
    index: LocalId,
}

fn allocate_table_locals(module: &mut Module, ptr_ty: ValType, table64: bool) -> TableLocals {
    let index_ty = if table64 { ValType::I64 } else { ValType::I32 };
    TableLocals {
        payload: module.locals.add(ptr_ty),
        len: module.locals.add(index_ty),
        current_len: module.locals.add(index_ty),
        page_count: module.locals.add(ValType::I32),
        record_page_count: module.locals.add(ValType::I32),
        page_ordinal: module.locals.add(ValType::I32),
        page_index: module.locals.add(ValType::I64),
        page_start_wide: module.locals.add(ValType::I64),
        page_start: module.locals.add(index_ty),
        count: module.locals.add(index_ty),
        index: module.locals.add(index_ty),
    }
}

fn emit_save_helper(
    module: &mut Module,
    memory: MemoryId,
    ptr_ty: ValType,
    codecs: ReferenceCodecs,
    imports: ModuleStateImports,
    plan: &ModuleStatePlan,
    trackers: &Trackers,
) -> FunctionId {
    let global_classes: Vec<_> = plan
        .globals
        .iter()
        .map(|global| match global.ty {
            ValType::Ref(ty) => Some(ReferenceCodecClass::of(module, ty)),
            _ => None,
        })
        .collect();
    let synchronized_tables: Vec<_> = plan
        .tables
        .iter()
        .filter(|table| table.synchronized)
        .copied()
        .collect();
    let table_classes: Vec<_> = synchronized_tables
        .iter()
        .map(|table| ReferenceCodecClass::of(module, table.ty))
        .collect();
    let table_locals: Vec<_> = synchronized_tables
        .iter()
        .map(|table| allocate_table_locals(module, ptr_ty, table.table64))
        .collect();
    let payload = module.locals.add(ptr_ty);
    let activation = module.locals.add(ValType::I32);
    let mut builder = FunctionBuilder::new(&mut module.types, &[ValType::I32], &[]);
    {
        let mut body = builder.func_body();
        for (global, class) in plan.globals.iter().zip(global_classes) {
            let value_size = class
                .map(|_| GLOBAL_RECIPE_PAYLOAD_SIZE)
                .unwrap_or_else(|| scalar_size(global.ty));
            let payload_size = u32::from(WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE) + value_size;
            reserve_static_record(
                &mut body,
                imports,
                ptr_ty,
                activation,
                WPK_FORK_MODULE_STATE_RECORD_KIND_MUTABLE_GLOBAL,
                global.owner,
                payload_size,
                payload,
            );
            body.local_get(payload)
                .i32_const(i32::from(global_type_code(global.ty, class)))
                .store(
                    memory,
                    StoreKind::I32_8 { atomic: false },
                    MemArg {
                        align: 1,
                        offset: 0,
                    },
                )
                .local_get(payload)
                .i32_const(value_size as i32)
                .store(
                    memory,
                    StoreKind::I32_8 { atomic: false },
                    MemArg {
                        align: 1,
                        offset: 1,
                    },
                )
                .local_get(payload)
                .i32_const(0)
                .store(
                    memory,
                    StoreKind::I32_16 { atomic: false },
                    MemArg {
                        align: 2,
                        offset: 2,
                    },
                )
                .local_get(payload)
                .i32_const(0)
                .store(
                    memory,
                    StoreKind::I32 { atomic: false },
                    MemArg {
                        align: 4,
                        offset: 4,
                    },
                );
            body.local_get(payload).global_get(global.id);
            match class {
                Some(class) => {
                    body.call(class.encoder(codecs)).store(
                        memory,
                        StoreKind::I32 { atomic: false },
                        MemArg {
                            align: 4,
                            offset: u64::from(WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE),
                        },
                    );
                }
                None => {
                    body.store(
                        memory,
                        scalar_store_kind(global.ty),
                        MemArg {
                            align: scalar_align(global.ty),
                            offset: u64::from(WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE),
                        },
                    );
                }
            }
            body.local_get(payload).call(imports.commit);
        }

        emit_save_segments(
            &mut body,
            memory,
            ptr_ty,
            imports,
            activation,
            payload,
            WPK_FORK_MODULE_STATE_RECORD_KIND_ELEMENT_SEGMENTS,
            u32::from(WPK_FORK_MODULE_STATE_ELEMENT_SEGMENT_HEADER_SIZE),
            &trackers.elements,
        );
        emit_save_segments(
            &mut body,
            memory,
            ptr_ty,
            imports,
            activation,
            payload,
            WPK_FORK_MODULE_STATE_RECORD_KIND_DATA_SEGMENTS,
            u32::from(WPK_FORK_MODULE_STATE_DATA_SEGMENT_HEADER_SIZE),
            &trackers.data,
        );

        for ((table, class), locals) in synchronized_tables
            .iter()
            .zip(table_classes)
            .zip(table_locals)
        {
            body.i32_const(table.owner as i32)
                .call(imports.table_state_owned)
                .if_else(
                    None,
                    |owned| {
                        // WHY: imported aliases name one physical Table. Only
                        // its canonical activation writes sparse state, while
                        // every alias still contributes mutation marks to the
                        // shared journal.
                        emit_save_table(
                            owned, memory, ptr_ty, codecs, imports, activation, *table, class,
                            locals,
                        );
                    },
                    |_| {},
                );
        }
    }
    builder.finish(vec![activation], &mut module.funcs)
}

fn emit_restore_helper(
    module: &mut Module,
    memory: MemoryId,
    ptr_ty: ValType,
    codecs: ReferenceCodecs,
    imports: ModuleStateImports,
    plan: &ModuleStatePlan,
    bootstrap_done: GlobalId,
) -> Result<FunctionId> {
    let global_classes: Vec<_> = plan
        .globals
        .iter()
        .map(|global| match global.ty {
            ValType::Ref(ty) => Some(ReferenceCodecClass::of(module, ty)),
            _ => None,
        })
        .collect();
    let payload = module.locals.add(ptr_ty);
    let activation = module.locals.add(ValType::I32);
    let mut builder = FunctionBuilder::new(&mut module.types, &[ValType::I32], &[]);
    {
        let mut body = builder.func_body();
        for (global, class) in plan.globals.iter().zip(global_classes) {
            if !global.restore {
                continue;
            }
            find_record(
                &mut body,
                imports,
                activation,
                WPK_FORK_MODULE_STATE_RECORD_KIND_MUTABLE_GLOBAL,
                global.owner,
                0,
                payload,
            );
            body.local_get(payload);
            match class {
                Some(class) => {
                    body.load(
                        memory,
                        LoadKind::I32 { atomic: false },
                        MemArg {
                            align: 4,
                            offset: u64::from(WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE),
                        },
                    )
                    .call(class.decoder(codecs));
                    let ValType::Ref(reference) = global.ty else {
                        unreachable!("reference codec assigned to scalar global")
                    };
                    emit_narrow_reference(&mut body, class, reference);
                }
                None => {
                    body.load(
                        memory,
                        scalar_load_kind(global.ty),
                        MemArg {
                            align: scalar_align(global.ty),
                            offset: u64::from(WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE),
                        },
                    );
                }
            }
            body.global_set(global.id);
        }

        // WHY: active element offsets can depend on globals. Restore globals
        // first and recreate only this activation's deterministic table
        // baseline. Sparse overlays are intentionally deferred until every
        // activation has replayed its baseline, matching parent
        // instantiation order without serializing shared tables per alias.
        // Data initialization and the original start are deliberately absent
        // because child linear memory was copied.
        body.global_get(bootstrap_done)
            .unop(UnaryOp::I32Eqz)
            .if_else(
                None,
                |baseline| {
                    emit_active_element_initializers(baseline, &plan.active_elements, false)
                        .expect("active element segment length fits u32");
                },
                |_| {},
            );

        // WHY: reference recipes can contain array.new_data/array.new_elem
        // nodes owned by another activation. Keep every passive segment
        // physically live until all activations have restored values/tables;
        // the finish helper reapplies the parent-visible drop state globally.
        body.i32_const(1).global_set(bootstrap_done);
    }
    Ok(builder.finish(vec![activation], &mut module.funcs))
}

fn emit_finish_restore_helper(
    module: &mut Module,
    memory: MemoryId,
    ptr_ty: ValType,
    codecs: ReferenceCodecs,
    imports: ModuleStateImports,
    plan: &ModuleStatePlan,
    trackers: &Trackers,
    bootstrap_done: GlobalId,
) -> FunctionId {
    let synchronized_tables: Vec<_> = plan
        .tables
        .iter()
        .filter(|table| table.synchronized)
        .copied()
        .collect();
    let table_classes: Vec<_> = synchronized_tables
        .iter()
        .map(|table| ReferenceCodecClass::of(module, table.ty))
        .collect();
    let table_locals: Vec<_> = synchronized_tables
        .iter()
        .map(|table| allocate_table_locals(module, ptr_ty, table.table64))
        .collect();
    let payload = module.locals.add(ptr_ty);
    let activation = module.locals.add(ValType::I32);
    let mut builder = FunctionBuilder::new(&mut module.types, &[ValType::I32], &[]);
    {
        let mut body = builder.func_body();
        body.global_get(bootstrap_done)
            .unop(UnaryOp::I32Eqz)
            .if_else(
                None,
                |invalid| {
                    // A pre-restore finish would destroy constructor inputs
                    // before globals/tables had a chance to decode them.
                    invalid.unreachable();
                },
                |_| {},
            );
        for ((table, class), locals) in synchronized_tables
            .iter()
            .zip(table_classes)
            .zip(table_locals)
        {
            body.i32_const(table.owner as i32)
                .call(imports.table_state_owned)
                .if_else(
                    None,
                    |owned| {
                        // WHY: all activation baselines now exist. Reapply the
                        // final sparse overlay exactly once for the physical
                        // Table, so later aliases cannot overwrite it.
                        emit_restore_table(
                            owned, memory, ptr_ty, codecs, imports, activation, *table, class,
                            locals,
                        );
                    },
                    |_| {},
                );
        }
        emit_restore_segments(
            &mut body,
            memory,
            imports,
            activation,
            payload,
            WPK_FORK_MODULE_STATE_RECORD_KIND_ELEMENT_SEGMENTS,
            &trackers.elements,
            |body, elem| {
                body.instr(ElemDrop { elem });
            },
        );
        emit_restore_segments(
            &mut body,
            memory,
            imports,
            activation,
            payload,
            WPK_FORK_MODULE_STATE_RECORD_KIND_DATA_SEGMENTS,
            &trackers.data,
            |body, data| {
                body.instr(DataDrop { data });
            },
        );
    }
    builder.finish(vec![activation], &mut module.funcs)
}

fn emit_table_save_helper(
    module: &mut Module,
    memory: MemoryId,
    ptr_ty: ValType,
    codecs: ReferenceCodecs,
    imports: ModuleStateImports,
    plan: &ModuleStatePlan,
) -> FunctionId {
    let synchronized_tables: Vec<_> = plan
        .tables
        .iter()
        .filter(|table| table.synchronized)
        .copied()
        .collect();
    let table_classes: Vec<_> = synchronized_tables
        .iter()
        .map(|table| ReferenceCodecClass::of(module, table.ty))
        .collect();
    let table_locals: Vec<_> = synchronized_tables
        .iter()
        .map(|table| allocate_table_locals(module, ptr_ty, table.table64))
        .collect();
    let activation = module.locals.add(ValType::I32);
    let mut builder = FunctionBuilder::new(&mut module.types, &[ValType::I32], &[]);
    {
        let mut body = builder.func_body();
        for ((table, class), locals) in synchronized_tables
            .iter()
            .zip(table_classes)
            .zip(table_locals)
        {
            body.i32_const(table.owner as i32)
                .call(imports.table_state_owned)
                .if_else(
                    None,
                    |owned| {
                        emit_save_table(
                            owned, memory, ptr_ty, codecs, imports, activation, *table, class,
                            locals,
                        );
                    },
                    |_| {},
                );
        }
    }
    builder.finish(vec![activation], &mut module.funcs)
}

fn emit_table_restore_helper(
    module: &mut Module,
    memory: MemoryId,
    ptr_ty: ValType,
    codecs: ReferenceCodecs,
    imports: ModuleStateImports,
    plan: &ModuleStatePlan,
) -> FunctionId {
    let synchronized_tables: Vec<_> = plan
        .tables
        .iter()
        .filter(|table| table.synchronized)
        .copied()
        .collect();
    let table_classes: Vec<_> = synchronized_tables
        .iter()
        .map(|table| ReferenceCodecClass::of(module, table.ty))
        .collect();
    let table_locals: Vec<_> = synchronized_tables
        .iter()
        .map(|table| allocate_table_locals(module, ptr_ty, table.table64))
        .collect();
    let activation = module.locals.add(ValType::I32);
    let mut builder = FunctionBuilder::new(&mut module.types, &[ValType::I32], &[]);
    {
        let mut body = builder.func_body();
        for ((table, class), locals) in synchronized_tables
            .iter()
            .zip(table_classes)
            .zip(table_locals)
        {
            body.i32_const(table.owner as i32)
                .call(imports.table_state_owned)
                .if_else(
                    None,
                    |owned| {
                        emit_restore_table(
                            owned, memory, ptr_ty, codecs, imports, activation, *table, class,
                            locals,
                        );
                    },
                    |_| {},
                );
        }
    }
    builder.finish(vec![activation], &mut module.funcs)
}

fn emit_bootstrap_helper(
    module: &mut Module,
    plan: &ModuleStatePlan,
    bootstrap_done: GlobalId,
) -> Result<FunctionId> {
    let mut builder = FunctionBuilder::new(&mut module.types, &[], &[]);
    {
        let mut body = builder.func_body();
        body.global_get(bootstrap_done)
            .unop(UnaryOp::I32Eqz)
            .if_else(
                None,
                |initialize| {
                    // Native instantiation applies element segments, then data
                    // segments, then invokes the start function. Keep that
                    // ordering observable while allowing pthread instances
                    // and fork children to skip the parent-only phase.
                    emit_active_element_initializers(initialize, &plan.active_elements, true)
                        .expect("active element segment length fits u32");
                    emit_active_data_initializers(initialize, &plan.active_data)
                        .expect("active data segment length fits u32");
                    initialize.i32_const(1).global_set(bootstrap_done);
                    if let Some(start) = plan.original_start {
                        initialize.call(start);
                    }
                },
                |_| {},
            );
    }
    Ok(builder.finish(Vec::new(), &mut module.funcs))
}

fn emit_thread_bootstrap_helper(
    module: &mut Module,
    plan: &ModuleStatePlan,
    bootstrap_done: GlobalId,
) -> Result<FunctionId> {
    let mut builder = FunctionBuilder::new(&mut module.types, &[], &[]);
    {
        let mut body = builder.func_body();
        body.global_get(bootstrap_done)
            .unop(UnaryOp::I32Eqz)
            .if_else(
                None,
                |initialize| {
                    // WHY: pthread instances have instance-local tables but
                    // share the parent's already-initialized linear memory.
                    // Recreate and consume only the element baseline; consume
                    // converted active data without copying or rerunning start.
                    emit_active_element_initializers(initialize, &plan.active_elements, true)
                        .expect("active element segment length fits u32");
                    for active in &plan.active_data {
                        initialize.instr(DataDrop { data: active.id });
                    }
                    initialize.i32_const(1).global_set(bootstrap_done);
                },
                |_| {},
            );
    }
    Ok(builder.finish(Vec::new(), &mut module.funcs))
}

fn emit_active_element_initializers(
    body: &mut InstrSeqBuilder<'_>,
    active_elements: &[ActiveElement],
    drop_after: bool,
) -> Result<()> {
    for active in active_elements {
        // WHY: retaining the original const expression in an immutable
        // global makes Walrus/WebAssembly own extended-const semantics. The
        // runtime helper reads the already-evaluated index and therefore does
        // not impose an instruction whitelist or evaluate the expression more
        // than once when active segments are converted to passive segments.
        body.global_get(active.offset_global);
        body.i32_const(0)
            .i32_const(
                u32::try_from(active.len)
                    .map_err(|_| anyhow::anyhow!("element segment length exceeds u32"))?
                    as i32,
            )
            .instr(TableInit {
                table: active.table,
                elem: active.id,
            });
        if drop_after {
            body.instr(ElemDrop { elem: active.id });
        }
    }
    Ok(())
}

fn emit_active_data_initializers(
    body: &mut InstrSeqBuilder<'_>,
    active_data: &[ActiveData],
) -> Result<()> {
    for active in active_data {
        body.global_get(active.offset_global);
        body.i32_const(0)
            .i32_const(
                u32::try_from(active.len)
                    .map_err(|_| anyhow::anyhow!("data segment length exceeds u32"))?
                    as i32,
            )
            .instr(MemoryInit {
                memory: active.memory,
                data: active.id,
            })
            .instr(DataDrop { data: active.id });
    }
    Ok(())
}

fn reserve_static_record(
    body: &mut InstrSeqBuilder<'_>,
    imports: ModuleStateImports,
    ptr_ty: ValType,
    activation: LocalId,
    kind: u16,
    owner: u32,
    size: u32,
    payload: LocalId,
) {
    body.i32_const(i32::from(kind))
        .local_get(activation)
        .i32_const(owner as i32);
    emit_ptr_const(body, ptr_ty, u64::from(size));
    body.call(imports.reserve).local_set(payload);
}

fn find_record(
    body: &mut InstrSeqBuilder<'_>,
    imports: ModuleStateImports,
    activation: LocalId,
    kind: u16,
    owner: u32,
    ordinal: u32,
    payload: LocalId,
) {
    body.i32_const(i32::from(kind))
        .local_get(activation)
        .i32_const(owner as i32)
        .i32_const(ordinal as i32)
        .call(imports.find)
        .local_set(payload);
}

fn emit_save_segments<T: Copy>(
    body: &mut InstrSeqBuilder<'_>,
    memory: MemoryId,
    ptr_ty: ValType,
    imports: ModuleStateImports,
    activation: LocalId,
    payload: LocalId,
    kind: u16,
    header_size: u32,
    tracker: &SegmentTracker<T>,
) {
    if tracker.segments.is_empty() {
        return;
    }
    let bitmap_bytes = tracker.segments.len().div_ceil(8);
    reserve_static_record(
        body,
        imports,
        ptr_ty,
        activation,
        kind,
        1,
        header_size + bitmap_bytes as u32,
        payload,
    );
    body.local_get(payload)
        .i32_const(tracker.segments.len() as i32)
        .store(
            memory,
            StoreKind::I32 { atomic: false },
            MemArg {
                align: 4,
                offset: 0,
            },
        )
        .local_get(payload)
        .i32_const(bitmap_bytes as i32)
        .store(
            memory,
            StoreKind::I32 { atomic: false },
            MemArg {
                align: 4,
                offset: 4,
            },
        );
    for byte in 0..bitmap_bytes {
        let word = tracker.globals[byte / 4];
        body.local_get(payload).global_get(word);
        if byte % 4 != 0 {
            body.i32_const((byte % 4 * 8) as i32)
                .binop(BinaryOp::I32ShrU);
        }
        body.store(
            memory,
            StoreKind::I32_8 { atomic: false },
            MemArg {
                align: 1,
                offset: u64::from(header_size) + byte as u64,
            },
        );
    }
    body.local_get(payload).call(imports.commit);
}

fn emit_restore_segments<T: Copy>(
    body: &mut InstrSeqBuilder<'_>,
    memory: MemoryId,
    imports: ModuleStateImports,
    activation: LocalId,
    payload: LocalId,
    kind: u16,
    tracker: &SegmentTracker<T>,
    mut emit_drop: impl FnMut(&mut InstrSeqBuilder<'_>, T),
) {
    if tracker.segments.is_empty() {
        return;
    }
    find_record(body, imports, activation, kind, 1, 0, payload);
    let bitmap_bytes = tracker.segments.len().div_ceil(8);
    for (word_index, global) in tracker.globals.iter().copied().enumerate() {
        // Assemble the bitmap word from exact byte loads. The KFMS validator
        // guarantees the declared payload length, but a guest helper must not
        // make correctness depend on allocator padding beyond that payload.
        body.i32_const(0);
        let first_byte = word_index * 4;
        let word_bytes = bitmap_bytes.saturating_sub(first_byte).min(4);
        for byte in 0..word_bytes {
            body.local_get(payload).load(
                memory,
                LoadKind::I32_8 {
                    kind: ExtendedLoad::ZeroExtend,
                },
                MemArg {
                    align: 1,
                    offset: 8 + (first_byte + byte) as u64,
                },
            );
            if byte != 0 {
                body.i32_const((byte * 8) as i32).binop(BinaryOp::I32Shl);
            }
            body.binop(BinaryOp::I32Or);
        }
        let remaining = tracker.segments.len().saturating_sub(word_index * 32);
        if remaining < 32 {
            let mask = if remaining == 0 {
                0
            } else {
                (1u32 << remaining) - 1
            };
            body.i32_const(mask as i32).binop(BinaryOp::I32And);
        }
        body.global_set(global);
    }
    for (index, segment) in tracker.segments.iter().copied().enumerate() {
        body.global_get(tracker.globals[index / 32])
            .i32_const((1u32 << (index % 32)) as i32)
            .binop(BinaryOp::I32And)
            .if_else(None, |then| emit_drop(then, segment), |_| {});
    }
}

fn emit_save_table(
    body: &mut InstrSeqBuilder<'_>,
    memory: MemoryId,
    ptr_ty: ValType,
    codecs: ReferenceCodecs,
    imports: ModuleStateImports,
    activation: LocalId,
    table: TableState,
    class: ReferenceCodecClass,
    locals: TableLocals,
) {
    body.instr(TableSize { table: table.id })
        .local_set(locals.len)
        .i32_const(table.owner as i32)
        .call(imports.table_dirty_count)
        .local_set(locals.page_count);

    reserve_static_record(
        body,
        imports,
        ptr_ty,
        activation,
        WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE,
        table.owner,
        u32::from(WPK_FORK_MODULE_STATE_TABLE_DESCRIPTOR_PAYLOAD_SIZE),
        locals.payload,
    );
    body.local_get(locals.payload)
        .i32_const(if table.table64 { 8 } else { 4 })
        .store(
            memory,
            StoreKind::I32_8 { atomic: false },
            MemArg {
                align: 1,
                offset: 0,
            },
        )
        .local_get(locals.payload)
        .i32_const(TABLE_PAGE_SHIFT as i32)
        .store(
            memory,
            StoreKind::I32_8 { atomic: false },
            MemArg {
                align: 1,
                offset: 1,
            },
        )
        .local_get(locals.payload)
        .i32_const(WPK_FORK_MODULE_STATE_TABLE_FLAG_SPARSE_OVERRIDES as i32)
        .store(
            memory,
            StoreKind::I32_16 { atomic: false },
            MemArg {
                align: 2,
                offset: 2,
            },
        )
        .local_get(locals.payload)
        .local_get(locals.page_count)
        .store(
            memory,
            StoreKind::I32 { atomic: false },
            MemArg {
                align: 4,
                offset: 4,
            },
        )
        .local_get(locals.payload)
        .local_get(locals.len);
    emit_index_to_i64(body, table);
    body.store(
        memory,
        StoreKind::I64 { atomic: false },
        MemArg {
            align: 8,
            offset: 8,
        },
    )
    .local_get(locals.payload)
    .i64_const(table.baseline_len as i64)
    .store(
        memory,
        StoreKind::I64 { atomic: false },
        MemArg {
            align: 8,
            offset: 16,
        },
    );
    for (chunk, bytes) in table.baseline_fingerprint.chunks_exact(8).enumerate() {
        body.local_get(locals.payload)
            .i64_const(i64::from_le_bytes(bytes.try_into().unwrap()))
            .store(
                memory,
                StoreKind::I64 { atomic: false },
                MemArg {
                    align: 8,
                    offset: 24 + (chunk as u64 * 8),
                },
            );
    }
    body.local_get(locals.payload)
        .call(imports.commit)
        .i32_const(0)
        .local_set(locals.page_ordinal);

    body.block(None, |done| {
        let done_id = done.id();
        done.loop_(None, |page_loop| {
            let loop_id = page_loop.id();
            page_loop
                .local_get(locals.page_ordinal)
                .local_get(locals.page_count)
                .binop(BinaryOp::I32GeU)
                .instr(BrIf { block: done_id });

            page_loop
                .i32_const(table.owner as i32)
                .local_get(locals.page_ordinal)
                .call(imports.table_dirty_page)
                .local_set(locals.page_index)
                .local_get(locals.page_index)
                .i64_const(i64::from(TABLE_PAGE_SHIFT))
                .binop(BinaryOp::I64Shl);
            if !table.table64 {
                page_loop
                    .local_set(locals.page_start_wide)
                    .local_get(locals.page_start_wide)
                    .i64_const(i64::from(u32::MAX))
                    .binop(BinaryOp::I64GtU);
                emit_trap_if(page_loop);
                page_loop
                    .local_get(locals.page_start_wide)
                    .unop(UnaryOp::I32WrapI64);
            }
            page_loop.local_set(locals.page_start);
            page_loop.local_get(locals.page_start).local_get(locals.len);
            emit_index_binop(page_loop, table, BinaryOp::I32GeU, BinaryOp::I64GeU);
            emit_trap_if(page_loop);
            emit_page_entry_count(page_loop, table, locals);
            page_loop
                .i32_const(i32::from(WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE_PAGE))
                .local_get(activation)
                .i32_const(table.owner as i32)
                .local_get(locals.count);
            emit_index_to_ptr(page_loop, table, ptr_ty);
            emit_ptr_const(page_loop, ptr_ty, 4);
            emit_ptr_binop(page_loop, ptr_ty, BinaryOp::I32Mul, BinaryOp::I64Mul);
            emit_ptr_const(
                page_loop,
                ptr_ty,
                u64::from(
                    WPK_FORK_MODULE_STATE_TABLE_PAGE_HEADER_SIZE
                        + WPK_FORK_MODULE_STATE_TABLE_RUN_HEADER_SIZE,
                ),
            );
            emit_ptr_binop(page_loop, ptr_ty, BinaryOp::I32Add, BinaryOp::I64Add);
            page_loop.call(imports.reserve).local_set(locals.payload);

            page_loop
                .local_get(locals.payload)
                .local_get(locals.page_index)
                .store(
                    memory,
                    StoreKind::I64 { atomic: false },
                    MemArg {
                        align: 8,
                        offset: 0,
                    },
                )
                .local_get(locals.payload)
                .i32_const(1)
                .store(
                    memory,
                    StoreKind::I32 { atomic: false },
                    MemArg {
                        align: 4,
                        offset: 8,
                    },
                )
                .local_get(locals.payload)
                .local_get(locals.count);
            emit_index_to_i32(page_loop, table);
            page_loop
                .store(
                    memory,
                    StoreKind::I32 { atomic: false },
                    MemArg {
                        align: 4,
                        offset: 12,
                    },
                )
                .local_get(locals.payload)
                .i32_const(0)
                .store(
                    memory,
                    StoreKind::I32 { atomic: false },
                    MemArg {
                        align: 4,
                        offset: 16,
                    },
                )
                .local_get(locals.payload)
                .local_get(locals.count);
            emit_index_to_i32(page_loop, table);
            page_loop.store(
                memory,
                StoreKind::I32 { atomic: false },
                MemArg {
                    align: 4,
                    offset: 20,
                },
            );

            emit_index_const(page_loop, table, 0);
            page_loop.local_set(locals.index);
            page_loop.block(None, |entries_done| {
                let entries_done_id = entries_done.id();
                entries_done.loop_(None, |entry_loop| {
                    let entry_loop_id = entry_loop.id();
                    entry_loop.local_get(locals.index).local_get(locals.count);
                    emit_index_binop(entry_loop, table, BinaryOp::I32GeU, BinaryOp::I64GeU);
                    entry_loop.instr(BrIf {
                        block: entries_done_id,
                    });
                    emit_table_recipe_addr(entry_loop, ptr_ty, table, locals.payload, locals.index);
                    entry_loop
                        .local_get(locals.page_start)
                        .local_get(locals.index);
                    emit_index_binop(entry_loop, table, BinaryOp::I32Add, BinaryOp::I64Add);
                    entry_loop
                        .instr(TableGet { table: table.id })
                        .call(class.encoder(codecs))
                        .store(
                            memory,
                            StoreKind::I32 { atomic: false },
                            MemArg {
                                align: 4,
                                offset: 0,
                            },
                        )
                        .local_get(locals.index);
                    emit_index_const(entry_loop, table, 1);
                    emit_index_binop(entry_loop, table, BinaryOp::I32Add, BinaryOp::I64Add);
                    entry_loop.local_set(locals.index).instr(Br {
                        block: entry_loop_id,
                    });
                });
            });
            page_loop
                .local_get(locals.payload)
                .call(imports.commit)
                .local_get(locals.page_ordinal)
                .i32_const(1)
                .binop(BinaryOp::I32Add)
                .local_set(locals.page_ordinal)
                .instr(Br { block: loop_id });
        });
    });
}

fn emit_restore_table(
    body: &mut InstrSeqBuilder<'_>,
    memory: MemoryId,
    ptr_ty: ValType,
    codecs: ReferenceCodecs,
    imports: ModuleStateImports,
    activation: LocalId,
    table: TableState,
    class: ReferenceCodecClass,
    locals: TableLocals,
) {
    find_record(
        body,
        imports,
        activation,
        WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE,
        table.owner,
        0,
        locals.payload,
    );
    body.local_get(locals.payload).load(
        memory,
        LoadKind::I64 { atomic: false },
        MemArg {
            align: 8,
            offset: 8,
        },
    );
    emit_i64_to_index(body, table);
    body.local_set(locals.len)
        .local_get(locals.payload)
        .load(
            memory,
            LoadKind::I32 { atomic: false },
            MemArg {
                align: 4,
                offset: 4,
            },
        )
        .local_set(locals.record_page_count);
    body.local_get(locals.payload)
        .load(
            memory,
            LoadKind::I64 { atomic: false },
            MemArg {
                align: 8,
                offset: 16,
            },
        )
        .i64_const(table.baseline_len as i64)
        .binop(BinaryOp::I64Ne);
    emit_trap_if(body);
    for (chunk, bytes) in table.baseline_fingerprint.chunks_exact(8).enumerate() {
        body.local_get(locals.payload)
            .load(
                memory,
                LoadKind::I64 { atomic: false },
                MemArg {
                    align: 8,
                    offset: 24 + (chunk as u64 * 8),
                },
            )
            .i64_const(i64::from_le_bytes(bytes.try_into().unwrap()))
            .binop(BinaryOp::I64Ne);
        emit_trap_if(body);
    }
    body.instr(TableSize { table: table.id })
        .local_set(locals.current_len)
        .local_get(locals.current_len)
        .local_get(locals.len);
    emit_index_binop(body, table, BinaryOp::I32GtU, BinaryOp::I64GtU);
    body.if_else(
        None,
        |then| {
            then.instr(Unreachable {});
        },
        |_| {},
    );

    body.i32_const(0).local_set(locals.page_ordinal);
    body.block(None, |done| {
        let done_id = done.id();
        done.loop_(None, |page_loop| {
            let loop_id = page_loop.id();
            page_loop
                .local_get(locals.page_ordinal)
                .local_get(locals.record_page_count)
                .binop(BinaryOp::I32GeU)
                .instr(BrIf { block: done_id });
            page_loop
                .i32_const(i32::from(WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE_PAGE))
                .local_get(activation)
                .i32_const(table.owner as i32)
                .local_get(locals.page_ordinal)
                .call(imports.find)
                .local_set(locals.payload);
            page_loop
                .local_get(locals.payload)
                .load(
                    memory,
                    LoadKind::I64 { atomic: false },
                    MemArg {
                        align: 8,
                        offset: 0,
                    },
                )
                .local_set(locals.page_index)
                .local_get(locals.page_index)
                .i64_const(i64::from(TABLE_PAGE_SHIFT))
                .binop(BinaryOp::I64Shl);
            if table.table64 {
                page_loop.local_set(locals.page_start);
            } else {
                page_loop
                    .local_set(locals.page_start_wide)
                    .local_get(locals.page_start_wide)
                    .i64_const(i64::from(u32::MAX))
                    .binop(BinaryOp::I64GtU);
                emit_trap_if(page_loop);
                page_loop
                    .local_get(locals.page_start_wide)
                    .unop(UnaryOp::I32WrapI64)
                    .local_set(locals.page_start);
            }
            page_loop.local_get(locals.page_start).local_get(locals.len);
            emit_index_binop(page_loop, table, BinaryOp::I32GeU, BinaryOp::I64GeU);
            emit_trap_if(page_loop);
            emit_page_entry_count(page_loop, table, locals);
            emit_validate_sparse_page(page_loop, memory, table, locals);

            // A grown table needs one valid reference before its entries can
            // be overlaid. Every successful grow dirties the page containing
            // the old end, so the first page spanning current_len owns that
            // initializer without a full-table scan.
            page_loop
                .local_get(locals.current_len)
                .local_get(locals.len);
            emit_index_binop(page_loop, table, BinaryOp::I32LtU, BinaryOp::I64LtU);
            page_loop.if_else(
                None,
                |needs_growth| {
                    needs_growth
                        .local_get(locals.current_len)
                        .local_get(locals.page_start);
                    emit_index_binop(needs_growth, table, BinaryOp::I32GeU, BinaryOp::I64GeU);
                    needs_growth
                        .local_get(locals.current_len)
                        .local_get(locals.page_start)
                        .local_get(locals.count);
                    emit_index_binop(needs_growth, table, BinaryOp::I32Add, BinaryOp::I64Add);
                    emit_index_binop(needs_growth, table, BinaryOp::I32LtU, BinaryOp::I64LtU);
                    needs_growth.binop(BinaryOp::I32And).if_else(
                        None,
                        |spans_old_end| {
                            spans_old_end
                                .local_get(locals.current_len)
                                .local_get(locals.page_start);
                            emit_index_binop(
                                spans_old_end,
                                table,
                                BinaryOp::I32Sub,
                                BinaryOp::I64Sub,
                            );
                            spans_old_end.local_set(locals.index);
                            emit_table_recipe_addr(
                                spans_old_end,
                                ptr_ty,
                                table,
                                locals.payload,
                                locals.index,
                            );
                            spans_old_end
                                .load(
                                    memory,
                                    LoadKind::I32 { atomic: false },
                                    MemArg {
                                        align: 4,
                                        offset: 0,
                                    },
                                )
                                .call(class.decoder(codecs));
                            emit_narrow_reference(spans_old_end, class, table.ty);
                            spans_old_end
                                .local_get(locals.len)
                                .local_get(locals.current_len);
                            emit_index_binop(
                                spans_old_end,
                                table,
                                BinaryOp::I32Sub,
                                BinaryOp::I64Sub,
                            );
                            spans_old_end.instr(TableGrow { table: table.id });
                            emit_index_const(spans_old_end, table, u64::MAX);
                            emit_index_binop(
                                spans_old_end,
                                table,
                                BinaryOp::I32Eq,
                                BinaryOp::I64Eq,
                            );
                            emit_trap_if(spans_old_end);
                            spans_old_end
                                .local_get(locals.len)
                                .local_set(locals.current_len);
                        },
                        |_| {},
                    );
                },
                |_| {},
            );

            emit_index_const(page_loop, table, 0);
            page_loop.local_set(locals.index);
            page_loop.block(None, |entries_done| {
                let entries_done_id = entries_done.id();
                entries_done.loop_(None, |entry_loop| {
                    let entry_loop_id = entry_loop.id();
                    entry_loop.local_get(locals.index).local_get(locals.count);
                    emit_index_binop(entry_loop, table, BinaryOp::I32GeU, BinaryOp::I64GeU);
                    entry_loop.instr(BrIf {
                        block: entries_done_id,
                    });
                    entry_loop
                        .local_get(locals.page_start)
                        .local_get(locals.index);
                    emit_index_binop(entry_loop, table, BinaryOp::I32Add, BinaryOp::I64Add);
                    emit_table_recipe_addr(entry_loop, ptr_ty, table, locals.payload, locals.index);
                    entry_loop
                        .load(
                            memory,
                            LoadKind::I32 { atomic: false },
                            MemArg {
                                align: 4,
                                offset: 0,
                            },
                        )
                        .call(class.decoder(codecs));
                    emit_narrow_reference(entry_loop, class, table.ty);
                    entry_loop
                        .instr(TableSet { table: table.id })
                        .local_get(locals.index);
                    emit_index_const(entry_loop, table, 1);
                    emit_index_binop(entry_loop, table, BinaryOp::I32Add, BinaryOp::I64Add);
                    entry_loop.local_set(locals.index).instr(Br {
                        block: entry_loop_id,
                    });
                });
            });
            page_loop
                .i32_const(table.owner as i32)
                .local_get(locals.page_index)
                .i64_const(1)
                .call(imports.table_dirty_mark)
                .local_get(locals.page_ordinal)
                .i32_const(1)
                .binop(BinaryOp::I32Add)
                .local_set(locals.page_ordinal)
                .instr(Br { block: loop_id });
        });
    });
    body.local_get(locals.current_len).local_get(locals.len);
    emit_index_binop(body, table, BinaryOp::I32Ne, BinaryOp::I64Ne);
    emit_trap_if(body);
}

fn emit_page_entry_count(body: &mut InstrSeqBuilder<'_>, table: TableState, locals: TableLocals) {
    // select(page_size, len-page_start, remaining > page_size)
    emit_index_const(body, table, TABLE_PAGE_SIZE);
    body.local_get(locals.len).local_get(locals.page_start);
    emit_index_binop(body, table, BinaryOp::I32Sub, BinaryOp::I64Sub);
    body.local_get(locals.len).local_get(locals.page_start);
    emit_index_binop(body, table, BinaryOp::I32Sub, BinaryOp::I64Sub);
    emit_index_const(body, table, TABLE_PAGE_SIZE);
    emit_index_binop(body, table, BinaryOp::I32GtU, BinaryOp::I64GtU);
    body.instr(walrus::ir::Select {
        ty: Some(table_index_type(table)),
    })
    .local_set(locals.count);
}

fn emit_validate_sparse_page(
    body: &mut InstrSeqBuilder<'_>,
    memory: MemoryId,
    table: TableState,
    locals: TableLocals,
) {
    body.local_get(locals.payload)
        .load(
            memory,
            LoadKind::I64 { atomic: false },
            MemArg {
                align: 8,
                offset: 0,
            },
        )
        .local_get(locals.page_index)
        .binop(BinaryOp::I64Ne);
    emit_trap_if(body);
    for (offset, expected) in [(8, 1), (16, 0)] {
        body.local_get(locals.payload)
            .load(
                memory,
                LoadKind::I32 { atomic: false },
                MemArg { align: 4, offset },
            )
            .i32_const(expected)
            .binop(BinaryOp::I32Ne);
        emit_trap_if(body);
    }
    for offset in [12, 20] {
        body.local_get(locals.payload).load(
            memory,
            LoadKind::I32 { atomic: false },
            MemArg { align: 4, offset },
        );
        body.local_get(locals.count);
        emit_index_to_i32(body, table);
        body.binop(BinaryOp::I32Ne);
        emit_trap_if(body);
    }
}

fn emit_trap_if(body: &mut InstrSeqBuilder<'_>) {
    body.if_else(
        None,
        |invalid| {
            invalid.instr(Unreachable {});
        },
        |_| {},
    );
}

fn emit_table_recipe_addr(
    body: &mut InstrSeqBuilder<'_>,
    ptr_ty: ValType,
    table: TableState,
    payload: LocalId,
    index: LocalId,
) {
    body.local_get(payload).local_get(index);
    emit_index_to_ptr(body, table, ptr_ty);
    emit_ptr_const(body, ptr_ty, 4);
    emit_ptr_binop(body, ptr_ty, BinaryOp::I32Mul, BinaryOp::I64Mul);
    emit_ptr_const(
        body,
        ptr_ty,
        u64::from(
            WPK_FORK_MODULE_STATE_TABLE_PAGE_HEADER_SIZE
                + WPK_FORK_MODULE_STATE_TABLE_RUN_HEADER_SIZE,
        ),
    );
    emit_ptr_binop(body, ptr_ty, BinaryOp::I32Add, BinaryOp::I64Add);
    emit_ptr_binop(body, ptr_ty, BinaryOp::I32Add, BinaryOp::I64Add);
}

fn emit_narrow_reference(
    body: &mut InstrSeqBuilder<'_>,
    class: ReferenceCodecClass,
    expected: RefType,
) {
    let broad = class.nullable_type();
    if expected.heap_type != broad.heap_type {
        body.instr(RefCast {
            nullable: expected.nullable,
            heap_type: expected.heap_type,
        });
    } else if !expected.nullable {
        body.instr(RefAsNonNull {});
    }
}

fn table_index_type(table: TableState) -> ValType {
    if table.table64 {
        ValType::I64
    } else {
        ValType::I32
    }
}

fn emit_ptr_const(body: &mut InstrSeqBuilder<'_>, ptr_ty: ValType, value: u64) {
    match ptr_ty {
        ValType::I32 => {
            body.i32_const(value as u32 as i32);
        }
        ValType::I64 => {
            body.i64_const(value as i64);
        }
        other => unreachable!("unsupported KFMS pointer type {other:?}"),
    }
}

fn emit_index_const(body: &mut InstrSeqBuilder<'_>, table: TableState, value: u64) {
    if table.table64 {
        body.i64_const(value as i64);
    } else {
        body.i32_const(value as u32 as i32);
    }
}

fn emit_ptr_binop(body: &mut InstrSeqBuilder<'_>, ptr_ty: ValType, op32: BinaryOp, op64: BinaryOp) {
    body.binop(match ptr_ty {
        ValType::I32 => op32,
        ValType::I64 => op64,
        other => unreachable!("unsupported KFMS pointer type {other:?}"),
    });
}

fn emit_index_binop(
    body: &mut InstrSeqBuilder<'_>,
    table: TableState,
    op32: BinaryOp,
    op64: BinaryOp,
) {
    body.binop(if table.table64 { op64 } else { op32 });
}

fn emit_index_to_i32(body: &mut InstrSeqBuilder<'_>, table: TableState) {
    if table.table64 {
        body.unop(UnaryOp::I32WrapI64);
    }
}

fn emit_index_to_i64(body: &mut InstrSeqBuilder<'_>, table: TableState) {
    if !table.table64 {
        body.unop(UnaryOp::I64ExtendUI32);
    }
}

fn emit_i64_to_index(body: &mut InstrSeqBuilder<'_>, table: TableState) {
    if !table.table64 {
        // KFMS validation rejects table32 lengths above u32::MAX before this
        // helper is called, so the narrowing conversion is exact.
        body.unop(UnaryOp::I32WrapI64);
    }
}

fn emit_index_to_ptr(body: &mut InstrSeqBuilder<'_>, table: TableState, ptr_ty: ValType) {
    match (table.table64, ptr_ty) {
        (false, ValType::I32) | (true, ValType::I64) => {}
        (false, ValType::I64) => {
            body.unop(UnaryOp::I64ExtendUI32);
        }
        (true, ValType::I32) => {
            body.unop(UnaryOp::I32WrapI64);
        }
        (_, other) => unreachable!("unsupported KFMS pointer type {other:?}"),
    }
}
