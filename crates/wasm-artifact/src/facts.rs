//! One walk over a WebAssembly container, producing every fact the ABI-epoch
//! artifact contract is judged against.
//!
//! WHY this exists as a single walker: the contract is a *joint* statement
//! about a module's types, imports, exports, memories and `wpk_fork` custom
//! sections. Names alone can look complete while the host and guest disagree
//! about whether a pointer is `i32` or `i64`, so a checker that reads only
//! names accepts artifacts that trap on the first frame. Everything the
//! validators need is therefore collected in one pass and cross-checked
//! afterwards, rather than re-walked per question.
//!
//! This walker is deliberately *not* a validator. It decodes and records; the
//! judgements live in `crate::policy` and `crate::fork_contract`, and every
//! `wpk_fork` descriptor byte format is decoded by the module in `fork-codec`
//! that already owns it.

use alloc::collections::BTreeMap;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use alloc::format;

use wasm_posix_shared::abi;
use wasmparser::{
    CompositeInnerType, ExternalKind, HeapType, Parser, Payload, RefType, TableType, TypeRef,
    ValType,
};

/// A value type reduced to what the artifact contract actually distinguishes.
///
/// The contract compares against [`abi::ProgramArtifactValueType`], which knows
/// `i32`/`i64`/`funcref`/`externref`/`exnref`/`anyref` and a width-sensitive
/// `Pointer`. Concrete GC heap types collapse into the reference family they
/// belong to, exactly as the fork module-state encoder does, because that is
/// the granularity at which a global can be saved and restored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueType {
    I32,
    I64,
    F32,
    F64,
    V128,
    FuncRef,
    ExternRef,
    ExnRef,
    /// Any other reference: `anyref`, `eqref`, `i31ref`, `structref`,
    /// `arrayref`, `contref`, the null families, and every concrete GC type
    /// that is not a function type.
    AnyRef,
}

impl ValueType {
    /// The `wpk_fork` module-state global type code for this value type, or
    /// `None` when a global of this type has no save/restore recipe.
    pub fn module_state_global_type_code(self) -> Option<u8> {
        Some(match self {
            ValueType::I32 => abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32,
            ValueType::I64 => abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64,
            ValueType::F32 => abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F32,
            ValueType::F64 => abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F64,
            ValueType::V128 => abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_V128,
            ValueType::FuncRef => abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
            ValueType::ExternRef => abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
            ValueType::ExnRef => abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF,
            ValueType::AnyRef => abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF,
        })
    }

    /// Whether this value type satisfies a requirement-table entry, given the
    /// artifact's pointer width. `Pointer` is the only width-sensitive entry.
    pub fn satisfies(self, required: abi::ProgramArtifactValueType, pointer_width: u8) -> bool {
        use abi::ProgramArtifactValueType as P;
        match required {
            P::Pointer => {
                self == if pointer_width == 8 {
                    ValueType::I64
                } else {
                    ValueType::I32
                }
            }
            P::I32 => self == ValueType::I32,
            P::I64 => self == ValueType::I64,
            P::FuncRef => self == ValueType::FuncRef,
            P::ExternRef => self == ValueType::ExternRef,
            P::ExnRef => self == ValueType::ExnRef,
            P::AnyRef => self == ValueType::AnyRef,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            ValueType::I32 => "i32",
            ValueType::I64 => "i64",
            ValueType::F32 => "f32",
            ValueType::F64 => "f64",
            ValueType::V128 => "v128",
            ValueType::FuncRef => "funcref",
            ValueType::ExternRef => "externref",
            ValueType::ExnRef => "exnref",
            ValueType::AnyRef => "anyref",
        }
    }
}

/// Reduce a reference type to its contract family.
///
/// A concrete heap type (`ref $t`) is a function reference when `$t` names a
/// function type in this module's type section and an aggregate reference
/// otherwise — the same rule the fork module-state encoder applies when it
/// decides how to reconstruct a global.
fn ref_type_family(ref_type: RefType, func_type_indices: &[bool]) -> ValueType {
    match ref_type.heap_type() {
        HeapType::Abstract { ty, .. } => {
            use wasmparser::AbstractHeapType as A;
            match ty {
                A::Func | A::NoFunc => ValueType::FuncRef,
                A::Extern | A::NoExtern => ValueType::ExternRef,
                A::Exn | A::NoExn => ValueType::ExnRef,
                _ => ValueType::AnyRef,
            }
        }
        // A concrete reference — `ref $t`, and its `exact` refinement — is a
        // function reference exactly when `$t` names a function type in this
        // module, and an aggregate reference otherwise. That is the same rule
        // the fork module-state encoder applies when it decides how to
        // reconstruct a global, so the two cannot disagree.
        HeapType::Concrete(index) | HeapType::Exact(index) => {
            let idx = index.as_module_index().unwrap_or(u32::MAX) as usize;
            if func_type_indices.get(idx).copied().unwrap_or(false) {
                ValueType::FuncRef
            } else {
                ValueType::AnyRef
            }
        }
    }
}

fn value_type_family(ty: ValType, func_type_indices: &[bool]) -> ValueType {
    match ty {
        ValType::I32 => ValueType::I32,
        ValType::I64 => ValueType::I64,
        ValType::F32 => ValueType::F32,
        ValType::F64 => ValueType::F64,
        ValType::V128 => ValueType::V128,
        ValType::Ref(r) => ref_type_family(r, func_type_indices),
    }
}

/// A function signature reduced to contract families.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Signature {
    pub params: Vec<ValueType>,
    pub results: Vec<ValueType>,
}

impl Signature {
    /// Whether this signature satisfies a requirement-table entry.
    pub fn matches(
        &self,
        params: &[abi::ProgramArtifactValueType],
        results: &[abi::ProgramArtifactValueType],
        pointer_width: u8,
    ) -> bool {
        self.params.len() == params.len()
            && self.results.len() == results.len()
            && self
                .params
                .iter()
                .zip(params)
                .all(|(have, want)| have.satisfies(*want, pointer_width))
            && self
                .results
                .iter()
                .zip(results)
                .all(|(have, want)| have.satisfies(*want, pointer_width))
    }

    pub fn describe(&self) -> String {
        let render = |types: &[ValueType]| -> String {
            let mut out = String::new();
            for (i, ty) in types.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                out.push_str(ty.name());
            }
            out
        };
        format!("({}) -> ({})", render(&self.params), render(&self.results))
    }
}

/// Render a requirement-table signature for a diagnostic, resolving `Pointer`
/// against the artifact's own width so the message names what was expected of
/// *this* artifact rather than an abstract shape.
pub fn describe_required_signature(
    params: &[abi::ProgramArtifactValueType],
    results: &[abi::ProgramArtifactValueType],
    pointer_width: u8,
) -> String {
    use abi::ProgramArtifactValueType as P;
    let render = |types: &[P]| -> String {
        let mut out = String::new();
        for (i, ty) in types.iter().enumerate() {
            if i > 0 {
                out.push_str(", ");
            }
            out.push_str(match ty {
                P::Pointer => {
                    if pointer_width == 8 {
                        "i64"
                    } else {
                        "i32"
                    }
                }
                P::I32 => "i32",
                P::I64 => "i64",
                P::FuncRef => "funcref",
                P::ExternRef => "externref",
                P::ExnRef => "exnref",
                P::AnyRef => "anyref",
            });
        }
        out
    };
    format!("({}) -> ({})", render(params), render(results))
}

/// One imported global, with everything the imported-globals descriptor is
/// cross-checked against.
#[derive(Debug, Clone)]
pub struct GlobalImport {
    pub module: String,
    pub name: String,
    /// Ordinal among *every* import entry, regardless of kind. The descriptor
    /// records this, so it is the join key.
    pub import_ordinal: u32,
    /// Index in the global index space.
    pub index: u32,
    pub value_type: ValueType,
    pub mutable: bool,
    pub shared: bool,
}

/// One table, imported or defined.
#[derive(Debug, Clone)]
pub struct Table {
    pub element: ValueType,
    pub table64: bool,
    pub minimum: u64,
    pub maximum: Option<u64>,
}

/// One imported table, with the descriptor join key.
#[derive(Debug, Clone)]
pub struct TableImport {
    pub module: String,
    pub name: String,
    pub import_ordinal: u32,
    /// Index in the table index space.
    pub index: u32,
    pub table: Table,
}

/// One export entry, keyed by name.
#[derive(Debug, Clone, Copy)]
pub struct ExportEntry {
    pub kind: ExternalKind,
    pub index: u32,
}

/// Everything one walk over the container established.
///
/// Multi-valued maps keep *every* occurrence rather than the last, because
/// several contract failures are "there is more than one of these" — a
/// duplicate export or a duplicated fork import is exactly the shape a partial
/// or copied instrumentation pass produces.
#[derive(Debug, Default)]
pub struct ArtifactFacts {
    /// `module.name` -> every signature imported under it.
    pub function_imports: BTreeMap<String, Vec<Signature>>,
    /// `module.name` -> every global imported under it.
    pub global_imports: BTreeMap<String, Vec<GlobalImport>>,
    /// `module.name` -> every table imported under it.
    pub table_imports: BTreeMap<String, Vec<TableImport>>,
    /// `module.name` -> every tag imported under it.
    pub tag_imports: BTreeMap<String, Vec<Signature>>,
    /// Every table in the table index space, imports first then defined.
    pub tables: Vec<Table>,
    /// Count of imported tables, so a defined-table index can be recognised.
    pub imported_table_count: u32,
    /// Export name -> every entry exported under it.
    pub exports: BTreeMap<String, Vec<ExportEntry>>,
    /// Export name -> signature, for function exports only.
    pub function_exports: BTreeMap<String, Vec<Signature>>,
    /// Pointer width (4 or 8) of every memory, imported and defined.
    pub memory_pointer_widths: Vec<u8>,
    /// Payloads of each `wpk_fork` descriptor family, in section order.
    pub fork_capabilities: Vec<Vec<u8>>,
    pub linked_frame_descriptors: Vec<Vec<u8>>,
    pub module_state_descriptors: Vec<Vec<u8>>,
    pub exception_codec_descriptors: Vec<Vec<u8>>,
    pub imported_globals_descriptors: Vec<Vec<u8>>,
    pub imported_tables_descriptors: Vec<Vec<u8>>,
    pub static_root_descriptors: Vec<Vec<u8>>,
    pub unwind_transport_descriptors: Vec<Vec<u8>>,
    /// Every custom section name, in order, including duplicates.
    pub custom_section_names: Vec<String>,
    /// A retained native `start` section. Instrumentation must move
    /// initialization into `wpk_fork_module_bootstrap`, so a surviving start
    /// section proves the transform did not complete.
    pub native_start_count: u32,
    /// Whether the module imports `kernel.kernel_fork`, which is what makes it
    /// a main-program fork participant rather than a side module.
    pub imports_kernel_fork: bool,
    /// Whether a `dylink.0` section is present, i.e. this is a relocatable
    /// (side) module rather than a linked program.
    pub is_relocatable: bool,
    /// Whether any export name begins with `asyncify_`, the legacy transform
    /// this epoch does not support.
    pub contains_legacy_asyncify: bool,
}

/// Why a container could not be read.
///
/// A malformed artifact is a *policy failure*, not a crash: every caller turns
/// this into a human-readable refusal, so the message carries the reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FactsError(pub String);

impl FactsError {
    fn new(message: impl Into<String>) -> Self {
        FactsError(message.into())
    }
}

impl core::fmt::Display for FactsError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Whether `bytes` opens with the WebAssembly magic and version 1 preamble.
///
/// This is the cheapest possible question and the only one some callers ask,
/// so it never walks the container.
pub fn is_wasm_module(bytes: &[u8]) -> bool {
    bytes.len() >= 8 && bytes[..8] == [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
}

fn table_from(ty: &TableType, func_type_indices: &[bool]) -> Table {
    Table {
        element: ref_type_family(ty.element_type, func_type_indices),
        table64: ty.table64,
        minimum: ty.initial,
        maximum: ty.maximum,
    }
}

/// Walk `bytes` once and collect every artifact fact.
///
/// Errors describe the first structural problem found. A truncated or
/// malformed module is reported rather than silently yielding partial facts,
/// because a partial fact set reads as "requirement absent" and would turn a
/// corrupt artifact into a *contract* failure with a misleading message.
pub fn read_artifact_facts(bytes: &[u8]) -> Result<ArtifactFacts, FactsError> {
    if !is_wasm_module(bytes) {
        return Err(FactsError::new("not a WebAssembly module"));
    }

    let mut facts = ArtifactFacts::default();

    // Which type indices name a function type. Needed to classify a concrete
    // heap type, and populated as the type section is read, which is always
    // before any use of a concrete reference in a later section.
    let mut func_type_indices: Vec<bool> = Vec::new();
    // Signatures by type index, for resolving function imports/exports.
    let mut type_signatures: Vec<Option<Signature>> = Vec::new();
    // Type index of each function in the function index space, imports first.
    let mut function_type_indices: Vec<u32> = Vec::new();
    // Export entries naming a function, resolved after the whole module is
    // walked because the export section may precede nothing but is simplest to
    // resolve once every function index is known.
    let mut pending_function_exports: Vec<(String, u32)> = Vec::new();
    let mut import_ordinal: u32 = 0;
    let mut global_index: u32 = 0;
    let mut table_index: u32 = 0;

    for payload in Parser::new(0).parse_all(bytes) {
        let payload =
            payload.map_err(|e| FactsError::new(format!("malformed WebAssembly module: {e}")))?;
        match payload {
            Payload::TypeSection(reader) => {
                for group in reader {
                    let group = group
                        .map_err(|e| FactsError::new(format!("malformed type section: {e}")))?;
                    for sub in group.into_types() {
                        let is_func =
                            matches!(sub.composite_type.inner, CompositeInnerType::Func(_));
                        func_type_indices.push(is_func);
                        match sub.composite_type.inner {
                            CompositeInnerType::Func(ref func) => {
                                // Classification uses the type indices known so
                                // far, which is every index a valid module can
                                // reference from here (rec groups aside, where
                                // a self-reference is an aggregate either way).
                                let signature = Signature {
                                    params: func
                                        .params()
                                        .iter()
                                        .map(|t| value_type_family(*t, &func_type_indices))
                                        .collect(),
                                    results: func
                                        .results()
                                        .iter()
                                        .map(|t| value_type_family(*t, &func_type_indices))
                                        .collect(),
                                };
                                type_signatures.push(Some(signature));
                            }
                            _ => type_signatures.push(None),
                        }
                    }
                }
            }
            Payload::ImportSection(reader) => {
                // An import section entry is a *group*: the compact-imports
                // encoding lets one entry expand to many imports sharing a
                // module name or a type. Ordinals are therefore counted over
                // the expanded imports, which is what a descriptor record
                // refers to, not over the groups.
                for group in reader {
                    let group = group
                        .map_err(|e| FactsError::new(format!("malformed import section: {e}")))?;
                    for expanded in group {
                        let (_offset, import) = expanded.map_err(|e| {
                            FactsError::new(format!("malformed import section: {e}"))
                        })?;
                    let identity = format!("{}.{}", import.module, import.name);
                    match import.ty {
                        // `FuncExact` is the exact-reference refinement of a
                        // function import. It names a type index the same way
                        // `Func` does, so it enters the function index space
                        // identically; the exactness bound constrains
                        // subtyping, not the signature this contract compares.
                        TypeRef::Func(type_index) | TypeRef::FuncExact(type_index) => {
                            let signature = type_signatures
                                .get(type_index as usize)
                                .cloned()
                                .flatten()
                                .ok_or_else(|| {
                                    FactsError::new(format!(
                                        "imported function {identity} refers to unknown type {type_index}"
                                    ))
                                })?;
                            function_type_indices.push(type_index);
                            facts
                                .function_imports
                                .entry(identity.clone())
                                .or_default()
                                .push(signature);
                            if import.module == abi::WPK_FORK_PROCESS_IMPORT.module
                                && import.name == abi::WPK_FORK_PROCESS_IMPORT.name
                            {
                                facts.imports_kernel_fork = true;
                            }
                        }
                        TypeRef::Global(global) => {
                            facts
                                .global_imports
                                .entry(identity.clone())
                                .or_default()
                                .push(GlobalImport {
                                    module: import.module.to_string(),
                                    name: import.name.to_string(),
                                    import_ordinal,
                                    index: global_index,
                                    value_type: value_type_family(
                                        global.content_type,
                                        &func_type_indices,
                                    ),
                                    mutable: global.mutable,
                                    shared: global.shared,
                                });
                            global_index += 1;
                        }
                        TypeRef::Table(table) => {
                            let decoded = table_from(&table, &func_type_indices);
                            facts.tables.push(decoded.clone());
                            facts
                                .table_imports
                                .entry(identity.clone())
                                .or_default()
                                .push(TableImport {
                                    module: import.module.to_string(),
                                    name: import.name.to_string(),
                                    import_ordinal,
                                    index: table_index,
                                    table: decoded,
                                });
                            table_index += 1;
                            facts.imported_table_count += 1;
                        }
                        TypeRef::Memory(memory) => {
                            facts
                                .memory_pointer_widths
                                .push(if memory.memory64 { 8 } else { 4 });
                        }
                        TypeRef::Tag(tag) => {
                            let type_index = tag.func_type_idx;
                            let signature = type_signatures
                                .get(type_index as usize)
                                .cloned()
                                .flatten()
                                .ok_or_else(|| {
                                    FactsError::new(format!(
                                        "imported tag {identity} refers to unknown type {type_index}"
                                    ))
                                })?;
                            facts
                                .tag_imports
                                .entry(identity.clone())
                                .or_default()
                                .push(signature);
                        }
                    }
                        import_ordinal += 1;
                    }
                }
            }
            Payload::FunctionSection(reader) => {
                for type_index in reader {
                    let type_index = type_index
                        .map_err(|e| FactsError::new(format!("malformed function section: {e}")))?;
                    function_type_indices.push(type_index);
                }
            }
            Payload::TableSection(reader) => {
                for table in reader {
                    let table = table
                        .map_err(|e| FactsError::new(format!("malformed table section: {e}")))?;
                    facts.tables.push(table_from(&table.ty, &func_type_indices));
                    table_index += 1;
                }
            }
            Payload::MemorySection(reader) => {
                for memory in reader {
                    let memory = memory
                        .map_err(|e| FactsError::new(format!("malformed memory section: {e}")))?;
                    facts
                        .memory_pointer_widths
                        .push(if memory.memory64 { 8 } else { 4 });
                }
            }
            Payload::ExportSection(reader) => {
                for export in reader {
                    let export = export
                        .map_err(|e| FactsError::new(format!("malformed export section: {e}")))?;
                    if export.name.starts_with("asyncify_") {
                        facts.contains_legacy_asyncify = true;
                    }
                    facts
                        .exports
                        .entry(export.name.to_string())
                        .or_default()
                        .push(ExportEntry {
                            kind: export.kind,
                            index: export.index,
                        });
                    if export.kind == ExternalKind::Func {
                        pending_function_exports.push((export.name.to_string(), export.index));
                    }
                }
            }
            Payload::StartSection { .. } => {
                facts.native_start_count += 1;
            }
            Payload::CustomSection(section) => {
                let name = section.name();
                facts.custom_section_names.push(name.to_string());
                let data = section.data().to_vec();
                match name {
                    "dylink.0" | "dylink" => facts.is_relocatable = true,
                    n if n == abi::WPK_FORK_CAPABILITIES_SECTION => {
                        facts.fork_capabilities.push(data)
                    }
                    n if n == abi::WPK_FORK_LINKED_FRAME_FORMAT_SECTION => {
                        facts.linked_frame_descriptors.push(data)
                    }
                    n if n == abi::WPK_FORK_MODULE_STATE_FORMAT_SECTION => {
                        facts.module_state_descriptors.push(data)
                    }
                    n if n == abi::WPK_FORK_EXCEPTION_CODEC_SECTION => {
                        facts.exception_codec_descriptors.push(data)
                    }
                    n if n == abi::WPK_FORK_IMPORTED_GLOBALS_SECTION => {
                        facts.imported_globals_descriptors.push(data)
                    }
                    n if n == abi::WPK_FORK_IMPORTED_TABLES_SECTION => {
                        facts.imported_tables_descriptors.push(data)
                    }
                    n if n == abi::WPK_FORK_STATIC_ROOT_CATALOG_SECTION => {
                        facts.static_root_descriptors.push(data)
                    }
                    n if n == abi::WPK_FORK_UNWIND_TRANSPORT_SECTION => {
                        facts.unwind_transport_descriptors.push(data)
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    for (name, function_index) in pending_function_exports {
        let type_index = function_type_indices
            .get(function_index as usize)
            .copied()
            .ok_or_else(|| {
                FactsError::new(format!(
                    "exported function {name} names unknown function index {function_index}"
                ))
            })?;
        let signature = type_signatures
            .get(type_index as usize)
            .cloned()
            .flatten()
            .ok_or_else(|| {
                FactsError::new(format!(
                    "exported function {name} refers to unknown type {type_index}"
                ))
            })?;
        facts
            .function_exports
            .entry(name)
            .or_default()
            .push(signature);
    }

    Ok(facts)
}

impl ArtifactFacts {
    /// The artifact's pointer width in bytes, from its memories.
    ///
    /// A module with no memory at all is treated as wasm32: that is the
    /// default data model, and a memory-less module has no pointers to
    /// disagree about.
    pub fn pointer_width(&self) -> u8 {
        self.memory_pointer_widths.first().copied().unwrap_or(4)
    }

    /// Whether the memories disagree with each other about pointer width.
    pub fn has_mixed_memory_widths(&self) -> bool {
        let mut widths = self.memory_pointer_widths.iter();
        match widths.next() {
            None => false,
            Some(first) => widths.any(|w| w != first),
        }
    }

    /// Whether the module carries any surface that only fork instrumentation
    /// produces — an export, an import, or one of the descriptor sections.
    ///
    /// This is the gate that decides whether the fork contract applies at all,
    /// so it is deliberately generous: any single trace of the transform makes
    /// the artifact answerable for the whole contract, which is what stops a
    /// partially instrumented module from passing by having too little of it.
    pub fn has_fork_artifact_surface(&self) -> bool {
        let unwind_tag = format!(
            "{}.{}",
            abi::WPK_FORK_UNWIND_TAG_IMPORT_MODULE,
            abi::WPK_FORK_UNWIND_TAG_IMPORT_NAME
        );
        abi::WPK_FORK_REQUIRED_EXPORTS
            .iter()
            .any(|e| self.function_exports.contains_key(e.name))
            || abi::WPK_FORK_REQUIRED_IMPORTS.iter().any(|i| {
                self.function_imports
                    .contains_key(&format!("{}.{}", i.module, i.name))
            })
            || !self.linked_frame_descriptors.is_empty()
            || !self.fork_capabilities.is_empty()
            || !self.module_state_descriptors.is_empty()
            || !self.exception_codec_descriptors.is_empty()
            || !self.imported_globals_descriptors.is_empty()
            || !self.imported_tables_descriptors.is_empty()
            || !self.unwind_transport_descriptors.is_empty()
            || self.tag_imports.contains_key(&unwind_tag)
    }

    /// Every export name, deduplicated in name order.
    pub fn export_names(&self) -> Vec<&str> {
        self.exports.keys().map(|k| k.as_str()).collect()
    }

    /// Every import identity (`module.name`) across all kinds.
    pub fn import_names(&self) -> Vec<String> {
        let mut names: Vec<String> = Vec::new();
        names.extend(self.function_imports.keys().cloned());
        names.extend(self.global_imports.keys().cloned());
        names.extend(self.table_imports.keys().cloned());
        names.extend(self.tag_imports.keys().cloned());
        names.sort();
        names.dedup();
        names
    }
}

/// Read one custom section's payload by name, without collecting every fact.
///
/// Used by callers that want a single stamp (the ABI-contract digest) and
/// nothing else, including the one that reads the *kernel's* own stamp before
/// the kernel exists.
pub fn read_custom_section<'a>(bytes: &'a [u8], name: &str) -> Option<&'a [u8]> {
    if !is_wasm_module(bytes) {
        return None;
    }
    for payload in Parser::new(0).parse_all(bytes) {
        let Ok(Payload::CustomSection(section)) = payload else {
            continue;
        };
        if section.name() == name {
            return Some(section.data());
        }
    }
    None
}

/// Detect whether an artifact is wasm32 or wasm64, returning the pointer width
/// in bytes.
///
/// Reads memories in index order — imported memories first, then defined — and
/// answers from the first one found, which is the memory a program's pointers
/// refer to. Defaults to 4 (wasm32) when the module declares no memory.
pub fn detect_pointer_width(bytes: &[u8]) -> u8 {
    if !is_wasm_module(bytes) {
        return 4;
    }
    let mut defined: Option<u8> = None;
    for payload in Parser::new(0).parse_all(bytes) {
        match payload {
            Ok(Payload::ImportSection(reader)) => {
                for (_, import) in reader.into_iter().flatten().flatten().flatten() {
                    if let TypeRef::Memory(memory) = import.ty {
                        return if memory.memory64 { 8 } else { 4 };
                    }
                }
            }
            Ok(Payload::MemorySection(reader)) => {
                if defined.is_none() {
                    if let Some(Ok(memory)) = reader.into_iter().next() {
                        defined = Some(if memory.memory64 { 8 } else { 4 });
                    }
                }
            }
            _ => {}
        }
    }
    defined.unwrap_or(4)
}

/// Read a constant-returning `i32` function export, as the SDK emits for
/// `__abi_version` and the pthread slot declaration.
///
/// Returns `None` when the export is absent or its body is anything other than
/// a single `i32.const` followed by `end`, which is the only shape the SDK
/// emits and the only shape that can be answered without executing code.
pub fn read_i32_const_export(bytes: &[u8], export_name: &str) -> Option<i32> {
    if !is_wasm_module(bytes) {
        return None;
    }
    let mut function_index: Option<u32> = None;
    let mut imported_functions: u32 = 0;
    let mut bodies: Vec<(u32, Vec<u8>)> = Vec::new();
    let mut body_ordinal: u32 = 0;

    for payload in Parser::new(0).parse_all(bytes) {
        match payload {
            Ok(Payload::ImportSection(reader)) => {
                for (_, import) in reader.into_iter().flatten().flatten().flatten() {
                    if matches!(import.ty, TypeRef::Func(_) | TypeRef::FuncExact(_)) {
                        imported_functions += 1;
                    }
                }
            }
            Ok(Payload::ExportSection(reader)) => {
                for export in reader.into_iter().flatten() {
                    if export.kind == ExternalKind::Func && export.name == export_name {
                        function_index = Some(export.index);
                    }
                }
            }
            Ok(Payload::CodeSectionEntry(body)) => {
                if let Ok(range) = body.get_binary_reader().read_bytes(
                    body.range().end - body.get_binary_reader().original_position(),
                ) {
                    bodies.push((body_ordinal, range.to_vec()));
                }
                body_ordinal += 1;
            }
            _ => {}
        }
    }

    let index = function_index?;
    // A constant accessor is always module-defined; an imported function has no
    // body to read.
    let defined_ordinal = index.checked_sub(imported_functions)?;
    let (_, body) = bodies.iter().find(|(ord, _)| *ord == defined_ordinal)?;
    decode_i32_const_body(body)
}

/// Decode a function body that must be `(local decls) i32.const N end`.
fn decode_i32_const_body(body: &[u8]) -> Option<i32> {
    let mut reader = wasmparser::BinaryReader::new(body, 0);
    // Local declaration groups, all of which must be empty for a constant
    // accessor, but are tolerated so a debug build with locals still reads.
    let local_groups = reader.read_var_u32().ok()?;
    for _ in 0..local_groups {
        let _count = reader.read_var_u32().ok()?;
        let _ty = reader.read::<ValType>().ok()?;
    }
    let opcode = reader.read_u8().ok()?;
    if opcode != 0x41 {
        return None;
    }
    let value = reader.read_var_i32().ok()?;
    let end = reader.read_u8().ok()?;
    if end != 0x0b {
        return None;
    }
    Some(value)
}

/// Read the `__heap_base` global's address.
///
/// Returns the address as `u64` so one reader serves wasm32 and wasm64. A
/// module without the export, or one whose initializer is not a single
/// `i32.const`/`i64.const`, yields `None` — the caller then places the control
/// region at the fixed fallback base rather than guessing.
pub fn read_heap_base(bytes: &[u8]) -> Option<u64> {
    if !is_wasm_module(bytes) {
        return None;
    }
    let mut global_index: Option<u32> = None;
    let mut imported_globals: u32 = 0;
    let mut defined: Vec<Option<u64>> = Vec::new();

    for payload in Parser::new(0).parse_all(bytes) {
        match payload {
            Ok(Payload::ImportSection(reader)) => {
                for (_, import) in reader.into_iter().flatten().flatten().flatten() {
                    if matches!(import.ty, TypeRef::Global(_)) {
                        imported_globals += 1;
                    }
                }
            }
            Ok(Payload::ExportSection(reader)) => {
                for export in reader.into_iter().flatten() {
                    if export.kind == ExternalKind::Global && export.name == "__heap_base" {
                        global_index = Some(export.index);
                    }
                }
            }
            Ok(Payload::GlobalSection(reader)) => {
                for global in reader.into_iter().flatten() {
                    defined.push(const_expr_address(&global));
                }
            }
            _ => {}
        }
    }

    let index = global_index?;
    let defined_index = index.checked_sub(imported_globals)? as usize;
    defined.get(defined_index).copied().flatten()
}

fn const_expr_address(global: &wasmparser::Global<'_>) -> Option<u64> {
    let mut ops = global.init_expr.get_operators_reader();
    let first = ops.read().ok()?;
    match first {
        wasmparser::Operator::I32Const { value } => Some(value as u32 as u64),
        wasmparser::Operator::I64Const { value } => Some(value as u64),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_module() -> Vec<u8> {
        vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
    }

    #[test]
    fn rejects_non_wasm_bytes() {
        assert!(!is_wasm_module(b""));
        assert!(!is_wasm_module(b"\0asm"));
        assert!(!is_wasm_module(&[0x00, 0x61, 0x73, 0x6d, 0x02, 0x00, 0x00, 0x00]));
        assert!(is_wasm_module(&empty_module()));
        assert_eq!(
            read_artifact_facts(b"not wasm at all").unwrap_err(),
            FactsError::new("not a WebAssembly module")
        );
    }

    #[test]
    fn empty_module_has_no_fork_surface() {
        let facts = read_artifact_facts(&empty_module()).expect("walks");
        assert!(!facts.has_fork_artifact_surface());
        assert_eq!(facts.pointer_width(), 4);
        assert_eq!(facts.native_start_count, 0);
        assert!(!facts.imports_kernel_fork);
    }

    #[test]
    fn pointer_width_defaults_to_wasm32_without_a_memory() {
        assert_eq!(detect_pointer_width(&empty_module()), 4);
        assert_eq!(detect_pointer_width(b"garbage"), 4);
    }

    #[test]
    fn signature_matching_resolves_pointer_by_width() {
        use abi::ProgramArtifactValueType as P;
        let sig32 = Signature {
            params: vec![ValueType::I32],
            results: vec![],
        };
        let sig64 = Signature {
            params: vec![ValueType::I64],
            results: vec![],
        };
        assert!(sig32.matches(&[P::Pointer], &[], 4));
        assert!(!sig32.matches(&[P::Pointer], &[], 8));
        assert!(sig64.matches(&[P::Pointer], &[], 8));
        assert!(!sig64.matches(&[P::Pointer], &[], 4));
    }

    #[test]
    fn mixed_memory_widths_are_detected() {
        let mut facts = ArtifactFacts::default();
        assert!(!facts.has_mixed_memory_widths());
        facts.memory_pointer_widths = vec![4, 4];
        assert!(!facts.has_mixed_memory_widths());
        facts.memory_pointer_widths = vec![4, 8];
        assert!(facts.has_mixed_memory_widths());
    }
}
