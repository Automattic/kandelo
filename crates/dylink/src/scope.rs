//! Symbol scope, interposition, and the dependency graph.
//!
//! Ports `symbolOwners`, `functionTableIndex`, `isPublicDylinkExport`,
//! `publishGlobalLibrarySymbols`, `promoteLibraryGlobal`,
//! `appendDependencyScope`, `runtimeDependencyNames` and `scopedSymbol`
//! (`host/src/dylink.ts:866-995`), plus the linker-owned table bookkeeping the
//! GOT planner needs.
//!
//! ## The lookup order, and why it is ELF's
//!
//! `dlsym`/import resolution consults, in order:
//!
//! 1. the process-global scope (the main image plus every `RTLD_GLOBAL`
//!    object), first definition wins — ELF interposition; and
//! 2. the requesting object's own dependency closure, breadth-first over
//!    `DT_NEEDED`, which is the `RTLD_LOCAL` scope.
//!
//! First-definition-wins in (1) is what makes a symbol non-interposable once
//! published, which is why a `RTLD_LOCAL` dependency's symbols must NOT reach
//! the global GOT (see `got.rs`).
//!
//! ## D5: the function→table-index map
//!
//! `dylink.ts:875-884` finds a function's table index by scanning every slot
//! and comparing JS `Function` identity. The planner has no engine objects to
//! compare, so it maintains the map it needs directly: a function is identified
//! by `(instance, export name)`, which is the identity wasm itself assigns.
//! Entries come from three places, all deterministic — the main image's element
//! segments (parsed from its bytes), each side module's published exports, and
//! any slot the loader appends for an address-take. No scan, no identity test,
//! and nothing about the structure is tuned to a particular library's symbol
//! profile: it is one map keyed by the identity wasm already has.
//!
//! Per D5 this is a structural consequence of not having JS objects, not a
//! performance claim; no claim is made here and none should be made without
//! before/after evidence on Node and browser.

use alloc::collections::{BTreeMap, BTreeSet, VecDeque};
use alloc::string::String;
use alloc::vec::Vec;

use wasm_posix_shared::abi::WPK_FORK_REQUIRED_EXPORTS;

use crate::act::{GlobalId, InstanceId};
use crate::error::{DylinkError, DylinkResult};
use crate::metadata::DylinkMetadata;

/// The main image's instance. It is not loaded by the linker; it is the
/// process's program, and it is the implicit root of the global scope.
pub const MAIN_INSTANCE: InstanceId = InstanceId(0);

/// Is this the name of a fork-instrument runtime export?
///
/// Read from `crates/shared`'s `WPK_FORK_REQUIRED_EXPORTS` rather than the
/// hand-copied list `dylink.ts:46-54` derives from the generated TypeScript
/// mirror. Same authority, one fewer copy.
pub fn is_fork_runtime_export(name: &str) -> bool {
    WPK_FORK_REQUIRED_EXPORTS.iter().any(|export| export.name == name)
}

/// Would this export be visible to `dlsym` and to the process-global scope?
///
/// Reserved (`__`-prefixed) names and fork-instrument entry points are
/// activation-control machinery, not ELF-visible application symbols.
/// Publishing them would put post-catalog instrumenter helpers into the
/// mutable process table and manufacture reference state with no
/// source-function reconstruction recipe (`dylink.ts:2126-2131`).
pub fn is_public_dylink_export(name: &str) -> bool {
    !name.starts_with("__") && !is_fork_runtime_export(name)
}

/// How a data symbol's defining global is reached.
///
/// A GOT cell needs only the symbol's ADDRESS, but a direct `env.<sym>`
/// immutable-global import needs the global OBJECT, and the two are not always
/// the same thing: the main image's data symbols are its own global exports,
/// while a side module's are loader-created globals holding the raw export
/// value plus the module's base. Recording which it is keeps
/// [`crate::act::BindingValue`] constructible without a second lookup.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DataBinding {
    /// The defining instance's own global export.
    Export { instance: InstanceId, name: String },
    /// A loader-created relocated global.
    Global(GlobalId),
}

/// What a resolved symbol denotes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SymbolValue {
    /// A data symbol: its address in linear memory, already relocated.
    Data { address: u64, binding: DataBinding },
    /// A function symbol, named by the instance that exports it.
    Func { instance: InstanceId, export: String },
}

impl SymbolValue {
    /// A data symbol defined by the main image.
    pub fn main_data(name: impl Into<String>, address: u64) -> Self {
        SymbolValue::Data {
            address,
            binding: DataBinding::Export { instance: MAIN_INSTANCE, name: name.into() },
        }
    }

    pub fn address(&self) -> Option<u64> {
        match self {
            SymbolValue::Data { address, .. } => Some(*address),
            SymbolValue::Func { .. } => None,
        }
    }

    pub fn kind_str(&self) -> &'static str {
        match self {
            SymbolValue::Data { .. } => "data object",
            SymbolValue::Func { .. } => "function",
        }
    }
}

/// A symbol in a scope, with the object that defined it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedSymbol {
    pub value: SymbolValue,
    /// The defining library's name; `None` means the main image.
    pub owner: Option<String>,
    /// True when this came from the process-global scope rather than from the
    /// requester's own dependency closure. A globally-resolved symbol may take
    /// a shared GOT cell; a locally-resolved one may not.
    pub globally_visible: bool,
}

/// One loaded shared object.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoadedLibrary {
    pub name: String,
    /// The immutable `.so` image this object was linked from.
    ///
    /// Retained because a fork child has to RE-LINK every live object from the
    /// same bytes: the archive record carries the image, and a child that had
    /// only the parent's layout could not reconstruct the module. The loader
    /// already keeps this alive for the object's lifetime (`dylink.ts` stores
    /// it on `LoadedSharedLibrary.moduleBytes` for the same reason), so this
    /// moves an existing lifetime rather than adding one.
    pub module_bytes: Vec<u8>,
    pub instance: InstanceId,
    pub metadata: DylinkMetadata,
    pub memory_base: u64,
    pub table_base: u64,
    pub tls_base: Option<u64>,
    pub activation_id: Option<u32>,
    /// Whether this object contributes to the `RTLD_DEFAULT` scope.
    pub global_visibility: bool,
    /// True when a completed `RTLD_GLOBAL` `dlopen` selected this as its root.
    pub committed_global_root: bool,
    /// Exports visible to `dlsym`, name → value.
    pub exports: BTreeMap<String, SymbolValue>,
    /// Table slots whose callable values belong to this object.
    pub owned_table_entries: BTreeSet<u64>,
    /// GOT cells this object consumed, with their exact kind.
    pub got_imports: BTreeMap<String, crate::metadata::GotKind>,
    /// Objects whose symbols this one captured outside its `DT_NEEDED` edges
    /// (constructor-time `dlsym`, for instance). These are lifetime edges that
    /// a fresh fork child cannot re-derive, so they are explicit state.
    pub provider_dependencies: BTreeSet<String>,
    /// Process mappings owned until rollback or final unload.
    pub allocations: Vec<fork_codec::dylink_archive::DylinkAllocation>,
    pub load_state: LoadState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoadState {
    /// Visible to nested loader transactions but not yet committed.
    Initializing,
    Loaded,
}

impl LoadedLibrary {
    /// `DT_NEEDED` edges plus runtime provider edges, excluding self.
    pub fn runtime_dependency_names(&self) -> BTreeSet<String> {
        let mut names: BTreeSet<String> = self.metadata.needed_dynlibs.iter().cloned().collect();
        names.extend(self.provider_dependencies.iter().cloned());
        names.remove(&self.name);
        names
    }
}

/// The process-wide linker state a plan reads and updates.
#[derive(Clone, Debug, Default)]
pub struct LinkerScope {
    /// Dependency-first insertion order, which is also the archive's order.
    order: Vec<String>,
    libraries: BTreeMap<String, LoadedLibrary>,
    /// The process-global symbol table. First definition wins.
    global_symbols: BTreeMap<String, ResolvedSymbol>,
    /// Function identity → indirect-function-table index. See D5 above.
    table_index_by_function: BTreeMap<(InstanceId, String), u64>,
    /// Current table length. The table cannot shrink.
    table_length: u64,
}

impl LinkerScope {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn table_length(&self) -> u64 {
        self.table_length
    }

    pub fn set_table_length(&mut self, length: u64) {
        self.table_length = length;
    }

    /// Record the main image's exports and its element-segment table layout.
    ///
    /// The main image is the root of the global scope: `dlopen`ed objects
    /// resolve against it first, and it can interpose any symbol.
    pub fn publish_main_image(
        &mut self,
        exports: impl IntoIterator<Item = (String, SymbolValue)>,
        element_slots: impl IntoIterator<Item = (u64, InstanceId, String)>,
        table_length: u64,
    ) {
        self.table_length = table_length;
        for (slot, instance, export) in element_slots {
            self.table_index_by_function.entry((instance, export)).or_insert(slot);
        }
        for (name, value) in exports {
            if !is_public_dylink_export(&name) {
                continue;
            }
            self.global_symbols.entry(name).or_insert(ResolvedSymbol {
                value,
                owner: None,
                globally_visible: true,
            });
        }
    }

    /// Look up a function's table index without scanning the table.
    pub fn function_table_index(&self, instance: InstanceId, export: &str) -> Option<u64> {
        self.table_index_by_function
            .get(&(instance, String::from(export)))
            .copied()
    }

    /// Remember that a function now lives at `index`.
    pub fn record_function_slot(&mut self, instance: InstanceId, export: &str, index: u64) {
        self.table_index_by_function
            .entry((instance, String::from(export)))
            .or_insert(index);
    }

    pub fn forget_function_slot(&mut self, instance: InstanceId, export: &str) {
        self.table_index_by_function.remove(&(instance, String::from(export)));
    }

    pub fn library(&self, name: &str) -> Option<&LoadedLibrary> {
        self.libraries.get(name)
    }

    pub fn library_mut(&mut self, name: &str) -> Option<&mut LoadedLibrary> {
        self.libraries.get_mut(name)
    }

    pub fn contains(&self, name: &str) -> bool {
        self.libraries.contains_key(name)
    }

    /// Libraries in dependency-first load order.
    pub fn libraries(&self) -> impl Iterator<Item = &LoadedLibrary> {
        self.order.iter().filter_map(move |name| self.libraries.get(name))
    }

    pub fn len(&self) -> usize {
        self.libraries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.libraries.is_empty()
    }

    pub fn insert(&mut self, library: LoadedLibrary) -> DylinkResult<()> {
        if self.libraries.contains_key(&library.name) {
            return Err(DylinkError::DuplicateLibrary { library: library.name });
        }
        self.order.push(library.name.clone());
        self.libraries.insert(library.name.clone(), library);
        Ok(())
    }

    pub fn remove(&mut self, name: &str) -> Option<LoadedLibrary> {
        self.order.retain(|entry| entry != name);
        self.libraries.remove(name)
    }

    pub fn global_symbol(&self, name: &str) -> Option<&ResolvedSymbol> {
        self.global_symbols.get(name)
    }

    pub fn global_symbols(&self) -> impl Iterator<Item = (&str, &ResolvedSymbol)> {
        self.global_symbols.iter().map(|(name, symbol)| (name.as_str(), symbol))
    }

    /// Publish an `RTLD_GLOBAL` object's public exports. First wins.
    pub fn publish_global_library_symbols(&mut self, name: &str) -> DylinkResult<()> {
        let Some(library) = self.libraries.get(name) else {
            return Ok(());
        };
        if !library.global_visibility {
            return Ok(());
        }
        let owner = library.name.clone();
        let published: Vec<(String, SymbolValue)> = library
            .exports
            .iter()
            .filter(|(export_name, _)| is_public_dylink_export(export_name))
            .filter(|(export_name, _)| !self.global_symbols.contains_key(export_name.as_str()))
            .map(|(export_name, value)| (export_name.clone(), value.clone()))
            .collect();
        for (export_name, value) in published {
            self.global_symbols.insert(
                export_name,
                ResolvedSymbol { value, owner: Some(owner.clone()), globally_visible: true },
            );
        }
        Ok(())
    }

    /// Promote a previously-`RTLD_LOCAL` object and its whole `DT_NEEDED`
    /// closure to `RTLD_GLOBAL`, then publish their symbols.
    ///
    /// A `dlopen(RTLD_GLOBAL)` of an already-loaded local object promotes it;
    /// promotion must reach its dependencies too, or a global object would
    /// depend on symbols nothing else can see.
    pub fn promote_library_global(&mut self, name: &str) -> DylinkResult<()> {
        let mut visited = BTreeSet::new();
        let mut queue = VecDeque::new();
        queue.push_back(String::from(name));
        // Post-order: dependencies are promoted and published before the
        // object that needs them, matching `promoteLibraryGlobal`'s recursion.
        let mut ordered = Vec::new();
        while let Some(current) = queue.pop_front() {
            if !visited.insert(current.clone()) {
                continue;
            }
            let Some(library) = self.libraries.get(&current) else {
                return Err(DylinkError::DependencyMissing {
                    library: String::from(name),
                    dependency: current,
                });
            };
            for dependency in &library.metadata.needed_dynlibs {
                if !self.libraries.contains_key(dependency) {
                    return Err(DylinkError::DependencyMissing {
                        library: current.clone(),
                        dependency: dependency.clone(),
                    });
                }
                queue.push_back(dependency.clone());
            }
            ordered.push(current);
        }
        for library_name in ordered.iter().rev() {
            if let Some(library) = self.libraries.get_mut(library_name) {
                library.global_visibility = true;
            }
        }
        for library_name in ordered.iter().rev() {
            self.publish_global_library_symbols(library_name)?;
        }
        Ok(())
    }

    /// Breadth-first `DT_NEEDED` closure of `roots`, in resolution order.
    ///
    /// This is the requester's `RTLD_LOCAL` scope. Cycles terminate rather than
    /// recurse: an object already in the scope is skipped.
    pub fn dependency_scope(
        &self,
        requester: &str,
        roots: &[String],
    ) -> DylinkResult<Vec<String>> {
        let mut seen = BTreeSet::new();
        let mut scope = Vec::new();
        let mut queue: VecDeque<String> = roots.iter().cloned().collect();
        while let Some(current) = queue.pop_front() {
            if !seen.insert(current.clone()) {
                continue;
            }
            let Some(library) = self.libraries.get(&current) else {
                return Err(DylinkError::DependencyMissing {
                    library: String::from(requester),
                    dependency: current,
                });
            };
            scope.push(current);
            for dependency in &library.metadata.needed_dynlibs {
                if !seen.contains(dependency) {
                    queue.push_back(dependency.clone());
                }
            }
        }
        Ok(scope)
    }

    /// Resolve `name` for a requester with this dependency scope.
    ///
    /// Global scope first (ELF interposition), then the local closure.
    pub fn scoped_symbol(&self, scope: &[String], name: &str) -> Option<ResolvedSymbol> {
        if let Some(symbol) = self.global_symbols.get(name) {
            return Some(symbol.clone());
        }
        for dependency in scope {
            let library = self.libraries.get(dependency)?;
            if !is_public_dylink_export(name) {
                continue;
            }
            if let Some(value) = library.exports.get(name) {
                return Some(ResolvedSymbol {
                    value: value.clone(),
                    owner: Some(library.name.clone()),
                    globally_visible: false,
                });
            }
        }
        None
    }

    /// Snapshot the mutable scope for transaction rollback.
    pub fn snapshot(&self) -> ScopeSnapshot {
        ScopeSnapshot {
            order: self.order.clone(),
            libraries: self.libraries.clone(),
            global_symbols: self.global_symbols.clone(),
            table_index_by_function: self.table_index_by_function.clone(),
            table_length: self.table_length,
        }
    }

    /// Restore a snapshot. Table LENGTH is deliberately not restored: a
    /// `WebAssembly.Table` cannot shrink, so a rolled-back load leaves
    /// addressable slots behind. The caller nulls them and the next successful
    /// archive entry records the resulting exact base.
    pub fn restore(&mut self, snapshot: ScopeSnapshot) {
        let length = self.table_length.max(snapshot.table_length);
        self.order = snapshot.order;
        self.libraries = snapshot.libraries;
        self.global_symbols = snapshot.global_symbols;
        self.table_index_by_function = snapshot.table_index_by_function;
        self.table_length = length;
    }
}

#[derive(Clone, Debug)]
pub struct ScopeSnapshot {
    order: Vec<String>,
    libraries: BTreeMap<String, LoadedLibrary>,
    global_symbols: BTreeMap<String, ResolvedSymbol>,
    table_index_by_function: BTreeMap<(InstanceId, String), u64>,
    table_length: u64,
}
