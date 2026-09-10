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

/// One value type in its **binary** encoding, retained beside the contract
/// family.
///
/// [`ValueType`] deliberately collapses every GC reference into the family the
/// fork contract compares, which is the right granularity for judging an
/// artifact. It is the wrong granularity for a host that must decide how to
/// *route a value across the JavaScript boundary*: `externref` can be handed to
/// JavaScript and `exnref`/`contref`/`v128` cannot, and those distinctions live
/// in the encoding, not in the family.
///
/// # Canonical, not verbatim
///
/// A single reference type has two legal spellings — the one-byte shorthand
/// (`externref` = `0x6F`) and the long form (`ref null extern` =
/// `0x63 -0x11`) — and `wasmparser` normalizes them, so the *original* spelling
/// is not recoverable. This encoder therefore emits a **canonical** spelling:
/// the shorthand whenever the type has one (nullable, abstract, unshared), and
/// the long form otherwise. Every consumer predicate accepts both spellings of
/// the same type, so canonicalizing preserves meaning; a consumer that ever
/// distinguished them would be reading a property of the *producer*, not of the
/// artifact.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BinaryValueType {
    /// The leading binary opcode: a numeric type, a reference shorthand, or
    /// `0x63`/`0x64` (`ref null ht` / `ref ht`) for the long form.
    pub code: u8,
    /// The signed heap type of a long-form reference. `None` for the numeric
    /// types and for every shorthand, which encodes its heap type in `code`.
    pub heap_type: Option<i64>,
    /// Whether a long-form reference carries the shared heap-type prefix.
    pub shared: bool,
}

/// Long-form `ref null ht`.
const REF_NULL_CODE: u8 = 0x63;
/// Long-form `ref ht`.
const REF_CODE: u8 = 0x64;

/// The signed heap-type code for an abstract heap type, per the binary format.
fn abstract_heap_type_code(ty: wasmparser::AbstractHeapType) -> i64 {
    use wasmparser::AbstractHeapType as A;
    match ty {
        A::Func => -0x10,
        A::Extern => -0x11,
        A::Any => -0x12,
        A::Eq => -0x13,
        A::I31 => -0x14,
        A::Struct => -0x15,
        A::Array => -0x16,
        A::None => -0x0F,
        A::NoExtern => -0x0E,
        A::NoFunc => -0x0D,
        A::Exn => -0x17,
        A::NoExn => -0x0C,
        A::Cont => -0x18,
        A::NoCont => -0x0B,
    }
}

/// The one-byte shorthand for a *nullable, unshared* abstract heap type.
fn abstract_shorthand_code(ty: wasmparser::AbstractHeapType) -> u8 {
    use wasmparser::AbstractHeapType as A;
    match ty {
        A::Func => 0x70,
        A::Extern => 0x6F,
        A::Any => 0x6E,
        A::Eq => 0x6D,
        A::I31 => 0x6C,
        A::Struct => 0x6B,
        A::Array => 0x6A,
        A::Exn => 0x69,
        A::None => 0x71,
        A::NoExtern => 0x72,
        A::NoFunc => 0x73,
        A::NoExn => 0x74,
        A::Cont => 0x68,
        A::NoCont => 0x75,
    }
}

/// Encode `ty` canonically. See [`BinaryValueType`] for why this is canonical
/// rather than verbatim.
pub fn binary_value_type(ty: ValType) -> BinaryValueType {
    let plain = |code: u8| BinaryValueType {
        code,
        heap_type: None,
        shared: false,
    };
    match ty {
        ValType::I32 => plain(0x7F),
        ValType::I64 => plain(0x7E),
        ValType::F32 => plain(0x7D),
        ValType::F64 => plain(0x7C),
        ValType::V128 => plain(0x7B),
        ValType::Ref(r) => match r.heap_type() {
            HeapType::Abstract { shared, ty } if r.is_nullable() && !shared => {
                plain(abstract_shorthand_code(ty))
            }
            HeapType::Abstract { shared, ty } => BinaryValueType {
                code: if r.is_nullable() { REF_NULL_CODE } else { REF_CODE },
                heap_type: Some(abstract_heap_type_code(ty)),
                shared,
            },
            // A concrete reference names a type index, which the binary format
            // writes as a NON-negative signed LEB. `Exact` is a refinement of
            // the same index; it constrains subtyping, not identity, so it
            // encodes here as the index it names.
            HeapType::Concrete(index) | HeapType::Exact(index) => BinaryValueType {
                code: if r.is_nullable() { REF_NULL_CODE } else { REF_CODE },
                heap_type: Some(i64::from(index.as_module_index().unwrap_or(0))),
                shared: false,
            },
        },
    }
}

/// One import entry, in declaration order, reduced to identity and kind.
///
/// The keyed maps above answer "what is imported under this name"; this answers
/// "what does the import section say, in order", which is a different question
/// and the one a descriptor ordinal is defined against.
#[derive(Debug, Clone)]
pub struct ImportDescriptor {
    pub module: String,
    pub name: String,
    pub kind: DescriptorKind,
}

/// One export entry, in declaration order.
#[derive(Debug, Clone)]
pub struct ExportDescriptor {
    pub name: String,
    pub kind: DescriptorKind,
}

/// The five external kinds an import or export can name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DescriptorKind {
    Function,
    Table,
    Memory,
    Global,
    Tag,
}

impl DescriptorKind {
    /// The binary-format kind byte, which is also the host wire value.
    pub fn code(self) -> u8 {
        match self {
            DescriptorKind::Function => 0,
            DescriptorKind::Table => 1,
            DescriptorKind::Memory => 2,
            DescriptorKind::Global => 3,
            DescriptorKind::Tag => 4,
        }
    }

    fn from_external(kind: ExternalKind) -> DescriptorKind {
        match kind {
            // `FuncExact` is the exact-reference refinement of a function
            // export. The exactness bound constrains subtyping, not the
            // external kind, so it names a function here exactly as `Func`
            // does — the same rule the import walk applies to
            // `TypeRef::FuncExact`.
            ExternalKind::Func | ExternalKind::FuncExact => DescriptorKind::Function,
            ExternalKind::Table => DescriptorKind::Table,
            ExternalKind::Memory => DescriptorKind::Memory,
            ExternalKind::Global => DescriptorKind::Global,
            ExternalKind::Tag => DescriptorKind::Tag,
        }
    }
}

/// One imported function with everything a fork-safe import router needs: the
/// two join keys a descriptor can refer to, and the artifact-declared signature
/// in its binary encoding.
///
/// WHY the binary encoding rather than the family: `WebAssembly.Module.imports()`
/// omits function types entirely, so a host that routes imports by name alone
/// can bind a provider whose scalar words mean something else. The signature
/// has to come from the artifact.
#[derive(Debug, Clone)]
pub struct FunctionImport {
    pub module: String,
    pub name: String,
    /// Ordinal among *every* import entry, regardless of kind.
    pub import_ordinal: u32,
    /// Index in the core function index space.
    pub function_index: u32,
    pub params: Vec<BinaryValueType>,
    pub results: Vec<BinaryValueType>,
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
    /// Whether a `dylink.0` section is present, i.e. this is a position-
    /// independent SIDE MODULE.
    pub is_relocatable: bool,
    /// Whether this is an unlinked relocatable OBJECT: it carries `linking`
    /// and/or `reloc.*` sections and has not been through `wasm-ld`.
    ///
    /// Distinct from [`Self::is_relocatable`], and the distinction decides
    /// policy. A side module has been linked and must carry the fork contract;
    /// an object file has not been linked at all, so requiring the contract of
    /// it would reject every intermediate artifact the build produces. Both are
    /// "relocatable" in ordinary speech and neither substitutes for the other.
    pub is_relocatable_object: bool,
    /// Whether any export name begins with `asyncify_`, the legacy transform
    /// this epoch does not support.
    pub contains_legacy_asyncify: bool,
    /// Every import entry in declaration order.
    ///
    /// The keyed maps answer "what is imported under this name". This answers
    /// "what does the import section say, in order" — a different question, and
    /// the one an ordinal is defined against.
    pub import_descriptors: Vec<ImportDescriptor>,
    /// Every export entry in declaration order, including duplicates.
    pub export_descriptors: Vec<ExportDescriptor>,
    /// Imported functions in declaration order, with both join keys and the
    /// artifact-declared signature in its binary encoding.
    pub function_import_entries: Vec<FunctionImport>,
    /// Type index of each function in the function index space, imports first.
    pub function_type_indices: Vec<u32>,
    /// `(parameter count, result count)` per type index; `None` where the type
    /// index does not name a function type.
    pub type_arities: Vec<Option<(u32, u32)>>,
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
    // The same signatures in their binary encoding, for the host consumers that
    // must route a value across the JavaScript boundary by its exact reference
    // form rather than by its contract family.
    let mut type_binary_signatures: Vec<Option<(Vec<BinaryValueType>, Vec<BinaryValueType>)>> =
        Vec::new();
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
                                type_binary_signatures.push(Some((
                                    func.params().iter().copied().map(binary_value_type).collect(),
                                    func.results().iter().copied().map(binary_value_type).collect(),
                                )));
                                facts.type_arities.push(Some((
                                    func.params().len() as u32,
                                    func.results().len() as u32,
                                )));
                            }
                            _ => {
                                type_signatures.push(None);
                                type_binary_signatures.push(None);
                                facts.type_arities.push(None);
                            }
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
                            let function_index = function_type_indices.len() as u32;
                            function_type_indices.push(type_index);
                            let (params, results) = type_binary_signatures
                                .get(type_index as usize)
                                .cloned()
                                .flatten()
                                .unwrap_or_default();
                            facts.function_import_entries.push(FunctionImport {
                                module: import.module.to_string(),
                                name: import.name.to_string(),
                                import_ordinal,
                                function_index,
                                params,
                                results,
                            });
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
                        facts.import_descriptors.push(ImportDescriptor {
                            module: import.module.to_string(),
                            name: import.name.to_string(),
                            kind: match import.ty {
                                TypeRef::Func(_) | TypeRef::FuncExact(_) => {
                                    DescriptorKind::Function
                                }
                                TypeRef::Table(_) => DescriptorKind::Table,
                                TypeRef::Memory(_) => DescriptorKind::Memory,
                                TypeRef::Global(_) => DescriptorKind::Global,
                                TypeRef::Tag(_) => DescriptorKind::Tag,
                            },
                        });
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
                    facts.export_descriptors.push(ExportDescriptor {
                        name: export.name.to_string(),
                        kind: DescriptorKind::from_external(export.kind),
                    });
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
                if name.starts_with("reloc.") {
                    facts.is_relocatable_object = true;
                }
                let data = section.data().to_vec();
                match name {
                    "dylink.0" | "dylink" => facts.is_relocatable = true,
                    "linking" => facts.is_relocatable_object = true,
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

    facts.function_type_indices = function_type_indices;

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
    read_i32_const_from_function(index, imported_functions, &bodies, 0)
}

/// How far a wrapper chain is followed before giving up.
///
/// `wasm-fork-instrument` wraps exported command functions, so the marker a
/// caller asks for may be one `call` away from the export. In practice the
/// chain is one link; four is generous and bounds a malformed or hostile
/// artifact that made its markers mutually recursive.
const MAX_MARKER_WRAPPER_DEPTH: u32 = 4;

/// Read the constant a trivial marker export returns, following a wrapper.
///
/// # Why this walks instructions rather than requiring a bare body
///
/// A marker export is *conceptually* `i32.const N; end`, and requiring exactly
/// that is what the first version of this function did. Real artifacts are not
/// that shape: the SDK emits a constructors `call` ahead of the constant, and
/// `wasm-fork-instrument` may replace the body with a wrapper that calls the
/// real marker. Requiring the bare shape reads `None` from both, and `None`
/// means "this binary predates the marker" — so an instrumented artifact would
/// have silently downgraded a hard ABI-epoch MISMATCH into a rollout warning.
/// That is the exact failure mode the marker exists to prevent.
///
/// The rule is therefore the one the artifact's shape actually implies: the
/// value a marker returns is the constant, or the callee's constant, that is
/// immediately followed by a `return` or by the body's final `end`.
fn read_i32_const_from_function(
    function_index: u32,
    imported_functions: u32,
    bodies: &[(u32, Vec<u8>)],
    depth: u32,
) -> Option<i32> {
    if depth > MAX_MARKER_WRAPPER_DEPTH {
        return None;
    }
    // A constant accessor is always module-defined; an imported function has no
    // body to read.
    let defined_ordinal = function_index.checked_sub(imported_functions)?;
    let (_, body) = bodies.iter().find(|(ord, _)| *ord == defined_ordinal)?;

    // `OperatorsReader` decodes each instruction's immediates properly, which is
    // the whole reason this is not a hand-rolled byte skipper: the previous
    // TypeScript had to enumerate every opcode's immediate shape, and an opcode
    // it did not know desynchronized the walk silently.
    let reader = wasmparser::BinaryReader::new(body, 0);
    let mut body_reader = wasmparser::FunctionBody::new(reader);
    let mut locals = body_reader.get_locals_reader().ok()?;
    for _ in 0..locals.get_count() {
        locals.read().ok()?;
    }
    let operators = body_reader.get_operators_reader().ok()?;

    let mut pending: Option<Pending> = None;
    for operator in operators.into_iter() {
        let operator = operator.ok()?;
        match (&pending, &operator) {
            // A value immediately returned, or falling out of the body's final
            // `end`, is the marker's answer.
            (Some(_), wasmparser::Operator::Return)
            | (Some(_), wasmparser::Operator::End) => {
                return match pending.take()? {
                    Pending::Constant(value) => Some(value),
                    Pending::Call(callee) => read_i32_const_from_function(
                        callee,
                        imported_functions,
                        bodies,
                        depth + 1,
                    ),
                };
            }
            _ => {}
        }
        pending = match operator {
            wasmparser::Operator::I32Const { value } => Some(Pending::Constant(value)),
            wasmparser::Operator::Call { function_index } => {
                Some(Pending::Call(function_index))
            }
            // Anything else discards the candidate: only a value produced
            // immediately before the return is the one the marker yields.
            _ => None,
        };
    }
    None
}

/// A value that would be the marker's answer if a `return` or the final `end`
/// came next.
enum Pending {
    Constant(i32),
    Call(u32),
}

/// Decode a function body that must be `(local decls) i32.const N end`.

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

    /// The two spellings of one reference type must reduce to a form every
    /// consumer predicate accepts. `wasmparser` normalizes the spelling away,
    /// so this pins the canonical output rather than the input.
    #[test]
    fn reference_shorthands_encode_canonically() {
        use wasmparser::{AbstractHeapType, RefType};

        let externref = binary_value_type(ValType::Ref(RefType::EXTERNREF));
        assert_eq!(externref.code, 0x6F);
        assert_eq!(externref.heap_type, None);
        assert!(!externref.shared);

        let funcref = binary_value_type(ValType::Ref(RefType::FUNCREF));
        assert_eq!(funcref.code, 0x70);

        // A NON-nullable abstract reference has no shorthand, so it takes the
        // long form and carries its heap type explicitly. -0x11 is `extern`.
        let non_null_extern = RefType::new(false, HeapType::Abstract {
            shared: false,
            ty: AbstractHeapType::Extern,
        })
        .expect("extern is a valid heap type");
        let encoded = binary_value_type(ValType::Ref(non_null_extern));
        assert_eq!(encoded.code, REF_CODE);
        assert_eq!(encoded.heap_type, Some(-0x11));
    }

    /// Numeric types keep the one-byte opcodes the binary format assigns them.
    #[test]
    fn numeric_types_encode_as_their_opcodes() {
        assert_eq!(binary_value_type(ValType::I32).code, 0x7F);
        assert_eq!(binary_value_type(ValType::I64).code, 0x7E);
        assert_eq!(binary_value_type(ValType::F32).code, 0x7D);
        assert_eq!(binary_value_type(ValType::F64).code, 0x7C);
        assert_eq!(binary_value_type(ValType::V128).code, 0x7B);
    }

    /// `exnref` and `contref` must stay distinguishable from `externref` after
    /// canonicalization: the host routes the first two straight through the
    /// wasm boundary and hands the third to JavaScript, and it decides which
    /// from this encoding.
    #[test]
    fn boundary_sensitive_references_stay_distinguishable() {
        use wasmparser::{AbstractHeapType, RefType};
        let of = |ty| {
            binary_value_type(ValType::Ref(
                RefType::new(true, HeapType::Abstract { shared: false, ty })
                    .expect("valid heap type"),
            ))
            .code
        };
        assert_eq!(of(AbstractHeapType::Exn), 0x69);
        assert_eq!(of(AbstractHeapType::Cont), 0x68);
        assert_eq!(of(AbstractHeapType::Extern), 0x6F);
        assert_eq!(of(AbstractHeapType::NoExn), 0x74);
        assert_eq!(of(AbstractHeapType::NoCont), 0x75);
    }

    /// Declaration order is the whole point of the descriptor lists: the keyed
    /// maps are sorted by name and cannot answer an ordinal question.
    #[test]
    fn descriptors_and_arities_follow_declaration_order() {
        // (module "m")
        //   (import "b" "two" (func (param i32) (result i64)))
        //   (import "a" "one" (global i32))
        //   (func (export "z"))
        //   (memory (export "mem") 1)
        let wat = r#"(module
            (import "b" "two" (func (param i32) (result i64)))
            (import "a" "one" (global i32))
            (func (export "z"))
            (memory (export "mem") 1)
        )"#;
        let bytes = wat::parse_str(wat).expect("valid wat");
        let facts = read_artifact_facts(&bytes).expect("valid module");

        // Import order is "b.two" then "a.one" -- the opposite of the sorted
        // map order, which is what makes this a real check.
        let names: Vec<String> = facts
            .import_descriptors
            .iter()
            .map(|d| format!("{}.{}", d.module, d.name))
            .collect();
        assert_eq!(names, vec!["b.two", "a.one"]);
        assert_eq!(facts.import_descriptors[0].kind, DescriptorKind::Function);
        assert_eq!(facts.import_descriptors[1].kind, DescriptorKind::Global);

        // The imported function is ordinal 0 and function index 0; its
        // signature comes from the artifact, not from a name lookup.
        assert_eq!(facts.function_import_entries.len(), 1);
        let imported = &facts.function_import_entries[0];
        assert_eq!(imported.import_ordinal, 0);
        assert_eq!(imported.function_index, 0);
        assert_eq!(imported.params.len(), 1);
        assert_eq!(imported.params[0].code, 0x7F);
        assert_eq!(imported.results[0].code, 0x7E);

        let exports: Vec<(&str, DescriptorKind)> = facts
            .export_descriptors
            .iter()
            .map(|d| (d.name.as_str(), d.kind))
            .collect();
        assert_eq!(
            exports,
            vec![("z", DescriptorKind::Function), ("mem", DescriptorKind::Memory)]
        );

        // Function index 1 is the defined function; its type has no params and
        // no results.
        let type_index = facts.function_type_indices[1] as usize;
        assert_eq!(facts.type_arities[type_index], Some((0, 0)));
    }
}
