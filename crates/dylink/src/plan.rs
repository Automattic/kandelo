//! The staged load: a driver that emits acts and consumes their results.
//!
//! Ports `instantiateSharedLibrarySteps` and `loadSharedLibrarySyncSteps`
//! (`host/src/dylink.ts:1152-2560`). Those are JavaScript generators because
//! the guest, not the host, drives initialization: `libc/glue/dlopen.c:127-166`
//! does
//!
//! ```c
//! transaction = __wasm_dlopen_prepare(bytes, len, path, name_len, flags);
//! for (;;) {
//!     entry = __wasm_dlopen_next(transaction, &handle);  /* a table index */
//!     if (entry == 0) break;
//!     ((void(*)(void))entry)();                          /* the GUEST calls it */
//! }
//! ```
//!
//! The host never re-enters wasm while a `dlopen` import frame is live. That is
//! already an act-queue protocol driven from the guest side, which is why this
//! port is a driver rather than a straight-line function: the same shape serves
//! a synchronous native embedder, a JS generator, and libc's staged loader
//! without any of them changing the others' semantics.
//!
//! # Driving a plan
//!
//! ```text
//! let mut plan = LinkPlan::begin(&mut linker, request)?;
//! loop {
//!     let step = plan.step(&mut linker)?;
//!     let result = match step {
//!         PlanStep::Act(act)   => executor.perform(act)?,
//!         PlanStep::Host(req)  => host.perform(req)?,
//!         PlanStep::Call(call) => { guest.invoke(call)?; ActResult::Done }
//!         PlanStep::Finished   => break,
//!     };
//!     plan.resume(&mut linker, result)?;
//! }
//! let library = plan.finish(&linker)?;
//! ```
//!
//! Every transition is total: a plan driven out of order returns
//! [`DylinkError::UnexpectedActSequence`] rather than misbehaving. `step` is
//! only legal when no result is outstanding, and `resume` only when one is.

use alloc::collections::{BTreeMap, BTreeSet, VecDeque};
use alloc::string::String;
use alloc::vec::Vec;

use fork_codec::dylink_archive::{
    DylinkAllocation, DylinkInitializationStage, DylinkModule, DylinkTransaction,
};

use crate::act::{
    ActResult, BindingValue, GlobalId, ImportBinding, ImportPlan, InstanceExport, InstanceId,
    LinkAct, ModuleId, ModuleSource, PointerWidth, TableValue, TagId, WasmValue,
};
use crate::error::{DylinkError, DylinkResult};
use crate::got::{
    decide_got_cell, GotCell, GotInit, GotPlacement, GotRequest, GotTable, UnresolvedPolicy,
};
use crate::metadata::{parse_dylink_section, DylinkMetadata, GotKind};
use crate::placement::{
    check_allocation, check_archived_allocations, check_tls, plan_memory, plan_table,
    MemoryPlacement,
};
use crate::scope::{
    is_fork_runtime_export, is_public_dylink_export, DataBinding, LinkerScope, LoadState,
    LoadedLibrary, SymbolValue,
};
use crate::wasm::{
    read_module_shape, require_passive_data_segments, without_borrowed_replay_start, ExternKind,
    ImportDecl, ImportType, ModuleShape, ValType,
};

/// The three points at which the guest, not the host, runs loader code.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum InitializationStage {
    /// `wpk_fork_module_bootstrap`. Registering an activation must not itself
    /// enter guest code, so bootstrap stays at the loader boundary where libc's
    /// staged loader can replace the direct call with an ordinary table call.
    Bootstrap,
    /// `__wasm_apply_data_relocs`.
    Relocations,
    /// `__wasm_call_ctors`.
    Constructors,
}

impl InitializationStage {
    pub const fn export_name(self) -> &'static str {
        match self {
            InitializationStage::Bootstrap => "wpk_fork_module_bootstrap",
            InitializationStage::Relocations => "__wasm_apply_data_relocs",
            InitializationStage::Constructors => "__wasm_call_ctors",
        }
    }

    /// Translate the KFLA archive's stage code.
    pub fn from_archive(stage: DylinkInitializationStage) -> Self {
        match stage {
            DylinkInitializationStage::Bootstrap => InitializationStage::Bootstrap,
            DylinkInitializationStage::Relocations => InitializationStage::Relocations,
            DylinkInitializationStage::Constructors => InitializationStage::Constructors,
        }
    }
}

/// One guest entry the loader hands back for the guest to call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StagedCall {
    pub library: String,
    pub stage: InitializationStage,
    pub instance: InstanceId,
    /// The export the guest must invoke. Always `() -> ()`.
    pub export: &'static str,
}

/// Work the process host performs that is not a JS-API act.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostRequest {
    /// Allocate side-module data in the process address space. In a process
    /// worker this is a synchronous `SYS_MMAP` on the syscall channel; the
    /// standalone-linker path never reaches it. Answered with
    /// [`ActResult::Index`] carrying the address.
    AllocateMemory { library: String, size: u64, align: u64 },
    /// Reconnect copied mapping ownership in a fork child without issuing a
    /// second `mmap`. Answered with [`ActResult::Done`].
    AdoptMapping { library: String, allocation: DylinkAllocation },
    /// Release an allocation during rollback. Answered with [`ActResult::Done`].
    ReleaseMapping { library: String, allocation: DylinkAllocation },
    /// Reserve one fork activation with the process coordinator. Answered with
    /// [`ActResult::Index`] carrying a nonzero activation id.
    PrepareActivation { library: String, replay_activation_id: Option<u32> },
    /// Bind the prepared activation to the instance the executor just made.
    RegisterActivation { library: String, activation: u32, instance: InstanceId },
    /// Release a prepared activation after a failed load. The coordinator is
    /// the only authority that can free the id, resume catalog, typed roots and
    /// continuation binding atomically.
    UnregisterActivation { library: String, activation: u32 },
    /// Journal host-written table slots into the same activation-owned sparse
    /// table state that instrumented `table.set` writes reach, so fork captures
    /// the function as an activation+ordinal recipe rather than as an opaque
    /// callable with no reconstruction recipe.
    JournalTableMutation { first_index: u64, length: u64 },
}

/// What the driver must do next.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PlanStep {
    /// A JS-API act. Resume with the matching [`ActResult`].
    Act(LinkAct),
    /// Process-host work. Resume with the matching [`ActResult`].
    Host(HostRequest),
    /// A guest entry point. Invoke it, then resume with [`ActResult::Done`].
    Call(StagedCall),
    /// The load is complete; call [`LinkPlan::finish`].
    Finished,
}

/// A `dlopen` request.
#[derive(Clone, Debug)]
pub struct LoadRequest {
    pub name: String,
    /// The loader keeps this immutable snapshot for the lifetime of the object;
    /// the fork archive stores the same bytes.
    pub module_bytes: Vec<u8>,
    /// `RTLD_GLOBAL` when true, `RTLD_LOCAL` when false.
    pub global_visibility: bool,
    pub replay: Option<ReplayInputs>,
    /// A borrowed (vfork) replay shares the suspended parent's live memory, so
    /// loader-controlled instantiation must be provably read-only.
    pub borrowed_memory: bool,
}

impl LoadRequest {
    pub fn new(name: impl Into<String>, module_bytes: Vec<u8>) -> Self {
        LoadRequest {
            name: name.into(),
            module_bytes,
            global_visibility: true,
            replay: None,
            borrowed_memory: false,
        }
    }

    /// `RTLD_LOCAL`.
    pub fn local(mut self) -> Self {
        self.global_visibility = false;
        self
    }
}

/// The fork parent's exact layout for one object.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReplayInputs {
    pub memory_base: u64,
    pub table_base: u64,
    pub activation_id: Option<u32>,
    pub tls_base: Option<u64>,
    pub global_visibility: bool,
    pub committed_global_root: bool,
    pub provider_dependencies: Vec<String>,
    pub allocations: Vec<DylinkAllocation>,
    /// Rebuild a plan stopped before this direct libc table call.
    pub initialization_stage: Option<InitializationStage>,
    /// Saved `GOT.func` values recovered from the parent's module state.
    /// Funcref identity in a child must match the parent exactly, so these win
    /// over anything the planner would otherwise re-derive.
    pub saved_got_func: BTreeMap<String, WasmValue>,
}

impl ReplayInputs {
    /// Build replay inputs straight from a decoded KFLA archive record.
    ///
    /// This is the wiring that gives `crates/fork-codec/src/dylink_archive.rs`
    /// its first caller: the decoder already materializes every field a replay
    /// needs, so the planner consumes those records instead of a second copy of
    /// the same types.
    pub fn from_archive(module: &DylinkModule) -> Self {
        ReplayInputs {
            memory_base: module.memory_base,
            table_base: module.table_base,
            activation_id: module.activation_id,
            tls_base: module.tls_base,
            global_visibility: module.global_visibility,
            committed_global_root: module.committed_global_root,
            provider_dependencies: module.provider_dependencies.clone(),
            allocations: module.allocations.clone(),
            initialization_stage: module
                .initialization
                .as_ref()
                .map(|initialization| InitializationStage::from_archive(initialization.stage)),
            saved_got_func: BTreeMap::new(),
        }
    }
}

/// A staged `dlopen` transaction stopped in ordinary wasm code.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingTransaction {
    pub token: u32,
    pub name: String,
    pub module_bytes: Vec<u8>,
    pub global_visibility: bool,
}

impl PendingTransaction {
    /// The archive's other unwired record type: an outer-to-inner loader
    /// transaction the parent had open when it forked.
    pub fn from_archive(transaction: &DylinkTransaction) -> Self {
        PendingTransaction {
            token: transaction.token,
            name: transaction.name.clone(),
            module_bytes: transaction.module_bytes.clone(),
            global_visibility: transaction.global_visibility,
        }
    }
}

/// Process-wide configuration the planner reads.
#[derive(Clone, Debug)]
pub struct LinkerConfig {
    pub pointer_width: PointerWidth,
    /// True when the process supplies a memory allocator. Every SDK-built guest
    /// that can call `dlopen` does; only standalone linker tests and non-POSIX
    /// embedders do not.
    pub has_allocator: bool,
    /// True when a fork activation coordinator is available. A fully
    /// instrumented side module cannot be loaded without one, and an
    /// uninstrumented one cannot be loaded WITH one.
    pub fork_activation_available: bool,
    /// A precise rebuild/boundary diagnostic when it is not.
    pub fork_activation_unavailable_reason: String,
    pub unresolved_policy: UnresolvedPolicy,
    /// Current linear-memory size in bytes.
    pub memory_bytes: u64,
    /// Whether the memory is shared. A borrowed replay requires it.
    pub shared_memory: bool,
    /// Host-held heap high-water mark, for embedders with no allocator.
    pub heap_pointer: Option<u64>,
}

impl Default for LinkerConfig {
    fn default() -> Self {
        LinkerConfig {
            pointer_width: PointerWidth::W32,
            has_allocator: true,
            fork_activation_available: false,
            fork_activation_unavailable_reason: String::from(
                "side modules require a process activation owner",
            ),
            unresolved_policy: UnresolvedPolicy::ElfStrict,
            memory_bytes: 0,
            shared_memory: false,
            heap_pointer: None,
        }
    }
}

/// The process's linker: scope, GOT, and executor id allocation.
#[derive(Clone, Debug, Default)]
pub struct Linker {
    pub config: LinkerConfig,
    pub scope: LinkerScope,
    pub got: GotTable,
    next_module: u32,
    next_instance: u32,
    next_tag: u32,
    /// Process-owned exception tags shared by the main image and every side
    /// module. C++ exceptions crossing a side-module call require tag IDENTITY
    /// as well as a matching payload type, so these must not be allocated per
    /// `dlopen`.
    pub longjmp_tag: Option<TagId>,
    pub cpp_exception_tag: Option<TagId>,
}

impl Linker {
    pub fn new(config: LinkerConfig) -> Self {
        Linker {
            config,
            scope: LinkerScope::new(),
            got: GotTable::new(),
            next_module: 0,
            // Instance 0 is the main image; the planner never creates it.
            next_instance: 1,
            next_tag: 0,
            longjmp_tag: None,
            cpp_exception_tag: None,
        }
    }

    fn allocate_module(&mut self) -> ModuleId {
        let id = ModuleId(self.next_module);
        self.next_module += 1;
        id
    }

    fn allocate_instance(&mut self) -> InstanceId {
        let id = InstanceId(self.next_instance);
        self.next_instance += 1;
        id
    }

    fn allocate_tag(&mut self) -> TagId {
        let id = TagId(self.next_tag);
        self.next_tag += 1;
        id
    }

    fn width(&self) -> PointerWidth {
        self.config.pointer_width
    }
}

/// Which of the loader's synthetic globals is being created.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BaseGlobal {
    Memory,
    Table,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TagSlot {
    Longjmp,
    CppException,
}

/// What result the plan is waiting for.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Pending {
    Compile,
    Allocate,
    Adopt(usize),
    Zero,
    GrowMemory,
    TablePad,
    TableReserve,
    BaseGlobal(BaseGlobal),
    Tag(TagSlot),
    GotGlobal(usize),
    PrepareActivation,
    Instantiate,
    RegisterActivation,
    ReadExports,
    Stage(InitializationStage),
    RelocatedGlobal(usize),
    ExportTableGrow(usize),
    ExportTableWrite(usize),
    ExportJournal(usize),
    GotWrite(usize),
}

/// Coarse progress through the load.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Phase {
    Compile,
    Memory,
    Table,
    BaseGlobals,
    Tags,
    Got,
    Activation,
    Instantiate,
    Register,
    Exports,
    Bootstrap,
    Tls,
    Relocate,
    Publish,
    GotWrites,
    Commit,
    Relocations,
    Constructors,
    Finished,
}

/// One in-flight `dlopen`.
pub struct LinkPlan {
    request: LoadRequest,
    metadata: DylinkMetadata,
    shape: ModuleShape,
    dependency_scope: Vec<String>,

    module: ModuleId,
    instance: InstanceId,
    source: ModuleSource,

    phase: Phase,
    pending: Option<Pending>,
    /// Steps decided together and emitted one at a time. `step` drains this
    /// before consulting the phase machine, which is what lets a single
    /// decision (an allocation, a table publication) expand into an ordered run
    /// of acts without a state for each.
    queue: VecDeque<(PlanStep, Pending)>,

    width: PointerWidth,
    policy: UnresolvedPolicy,

    memory_planned: bool,
    table_planned: bool,
    memory_base: u64,
    allocations: Vec<DylinkAllocation>,
    table_base: u64,
    table_pad: u64,
    table_growth_start: u64,

    memory_base_global: Option<GlobalId>,
    table_base_global: Option<GlobalId>,
    longjmp_tag: Option<TagId>,
    cpp_exception_tag: Option<TagId>,
    needs_longjmp_tag: bool,
    needs_cpp_tag: bool,

    /// GOT import declarations, in import-section order.
    got_imports: Vec<GotImportSite>,
    got_cursor: usize,
    /// The final ordered binding list, one entry per import declaration.
    bindings: Option<Vec<ImportBinding>>,

    fork_instrumented: bool,
    activation_id: Option<u32>,

    exports: Vec<InstanceExport>,
    relocations: Vec<PendingRelocation>,
    relocation_cursor: usize,
    relocated: BTreeMap<String, SymbolValue>,

    publish: Vec<PublishSite>,
    publish_cursor: usize,
    got_writes: Vec<GotWrite>,
    got_write_cursor: usize,
    got_writes_planned: bool,

    tls_base: Option<u64>,
    owned_table_entries: BTreeSet<u64>,
    provider_dependencies: BTreeSet<String>,
    local_got: BTreeMap<(GotKind, String), GotCell>,
    scope_snapshot: crate::scope::ScopeSnapshot,
    got_snapshot: crate::got::GotSnapshot,
}

#[derive(Clone, Debug)]
struct GotImportSite {
    /// Index into the module's import declarations.
    declaration: usize,
    kind: GotKind,
    symbol: String,
    placement: GotPlacement,
    global: Option<GlobalId>,
    init: WasmValue,
    /// True when the cell must be republished once this module's exports land.
    pending_self_definition: bool,
}

#[derive(Clone, Debug)]
struct PendingRelocation {
    name: String,
    raw: WasmValue,
    base: u64,
    global: GlobalId,
}

#[derive(Clone, Debug)]
struct PublishSite {
    name: String,
    kind: ExternKind,
    /// For a function: the slot it occupies.
    table_index: Option<u64>,
    /// For a data symbol: its relocated address and how to bind it.
    address: Option<u64>,
    binding: Option<DataBinding>,
}

#[derive(Clone, Debug)]
struct GotWrite {
    kind: GotKind,
    symbol: String,
    global: GlobalId,
    value: WasmValue,
    placement: GotPlacement,
}

impl LinkPlan {
    /// Start a load. Everything deterministic that can be decided before the
    /// first act is decided here, so a rejected artifact costs no engine work.
    pub fn begin(linker: &mut Linker, request: LoadRequest) -> DylinkResult<Self> {
        if linker.scope.contains(&request.name) {
            return Err(DylinkError::DuplicateLibrary { library: request.name });
        }
        let metadata = parse_dylink_section(&request.module_bytes)?;
        let shape = read_module_shape(&request.module_bytes)?;

        // Borrowed (vfork) replay shares the parent's live memory: nothing the
        // loader does may write it before the host can recover.
        let source = if request.borrowed_memory {
            if !linker.config.shared_memory {
                return Err(DylinkError::BorrowedReplayRequiresSharedMemory {
                    library: request.name.clone(),
                });
            }
            if request
                .replay
                .as_ref()
                .is_some_and(|replay| replay.initialization_stage.is_some())
            {
                return Err(DylinkError::BorrowedReplayCannotResume {
                    library: request.name.clone(),
                });
            }
            require_passive_data_segments(&request.module_bytes)?;
            match without_borrowed_replay_start(&request.module_bytes)? {
                Some(rewritten) => ModuleSource::Rewritten(rewritten),
                None => ModuleSource::Original,
            }
        } else {
            ModuleSource::Original
        };

        // Fork-artifact admission: K12's contracts evaluated at the loader's
        // call site. A partially instrumented artifact is stale, not
        // supportable, and must be rebuilt rather than tolerated.
        let present = fork_export_count(&shape);
        let required = wasm_posix_shared::abi::WPK_FORK_REQUIRED_EXPORTS.len();
        let fork_instrumented = present == required;
        if present > 0 && !fork_instrumented {
            return Err(DylinkError::IncompleteForkInstrumentation {
                library: request.name.clone(),
            });
        }
        if fork_instrumented && !linker.config.fork_activation_available {
            return Err(DylinkError::ForkActivationOwnerUnavailable {
                library: request.name.clone(),
                reason: linker.config.fork_activation_unavailable_reason.clone(),
            });
        }
        if linker.config.fork_activation_available && !fork_instrumented {
            return Err(DylinkError::IncompleteForkInstrumentation {
                library: request.name.clone(),
            });
        }
        match (&request.replay, fork_instrumented) {
            (Some(replay), true) if replay.activation_id.is_none() => {
                return Err(DylinkError::MissingReplayActivationId {
                    library: request.name.clone(),
                });
            }
            (Some(replay), false) if replay.activation_id.is_some() => {
                return Err(DylinkError::UnexpectedReplayActivationId {
                    library: request.name.clone(),
                });
            }
            _ => {}
        }

        // Every DT_NEEDED dependency must already be loaded. The caller loads
        // them depth-first; a missing one is a hard error rather than a silent
        // fresh allocation, which in a fork child would choose new addresses
        // and corrupt every copied relocation.
        let dependency_scope = linker
            .scope
            .dependency_scope(&request.name, &metadata.needed_dynlibs)?;

        let needs_longjmp_tag = shape.imports_named("env", "__c_longjmp", ExternKind::Tag);
        let needs_cpp_tag = shape.imports_named("env", "__cpp_exception", ExternKind::Tag);

        let got_imports = shape
            .imports
            .iter()
            .enumerate()
            .filter_map(|(index, decl)| {
                GotKind::from_namespace(&decl.module).map(|kind| GotImportSite {
                    declaration: index,
                    kind,
                    symbol: decl.name.clone(),
                    placement: GotPlacement::Shared,
                    global: None,
                    init: WasmValue::I32(0),
                    pending_self_definition: false,
                })
            })
            .collect();

        let module = linker.allocate_module();
        let instance = linker.allocate_instance();
        let width = linker.width();
        let policy = linker.config.unresolved_policy;
        let provider_dependencies = request
            .replay
            .as_ref()
            .map(|replay| replay.provider_dependencies.iter().cloned().collect())
            .unwrap_or_default();
        let table_growth_start = linker.scope.table_length();

        Ok(LinkPlan {
            request,
            metadata,
            shape,
            dependency_scope,
            module,
            instance,
            source,
            phase: Phase::Compile,
            pending: None,
            queue: VecDeque::new(),
            width,
            policy,
            memory_planned: false,
            table_planned: false,
            memory_base: 0,
            allocations: Vec::new(),
            table_base: 0,
            table_pad: 0,
            table_growth_start,
            memory_base_global: None,
            table_base_global: None,
            longjmp_tag: linker.longjmp_tag,
            cpp_exception_tag: linker.cpp_exception_tag,
            needs_longjmp_tag,
            needs_cpp_tag,
            got_imports,
            got_cursor: 0,
            bindings: None,
            fork_instrumented,
            activation_id: None,
            exports: Vec::new(),
            relocations: Vec::new(),
            relocation_cursor: 0,
            relocated: BTreeMap::new(),
            publish: Vec::new(),
            publish_cursor: 0,
            got_writes: Vec::new(),
            got_write_cursor: 0,
            got_writes_planned: false,
            tls_base: None,
            owned_table_entries: BTreeSet::new(),
            provider_dependencies,
            local_got: BTreeMap::new(),
            scope_snapshot: linker.scope.snapshot(),
            got_snapshot: linker.got.snapshot(),
        })
    }

    pub fn library_name(&self) -> &str {
        &self.request.name
    }

    pub fn instance(&self) -> InstanceId {
        self.instance
    }

    pub fn metadata(&self) -> &DylinkMetadata {
        &self.metadata
    }

    pub fn module_shape(&self) -> &ModuleShape {
        &self.shape
    }

    pub fn memory_base(&self) -> u64 {
        self.memory_base
    }

    pub fn table_base(&self) -> u64 {
        self.table_base
    }

    pub fn tls_base(&self) -> Option<u64> {
        self.tls_base
    }

    pub fn activation_id(&self) -> Option<u32> {
        self.activation_id
    }

    /// The ordered import bindings, available once the plan has emitted
    /// [`LinkAct::Instantiate`]. Exposed for the differential harness.
    pub fn bindings(&self) -> Option<&[ImportBinding]> {
        self.bindings.as_deref()
    }

    /// Undo the scope and GOT mutations this plan made.
    ///
    /// Table LENGTH is not restored — a `WebAssembly.Table` cannot shrink — so
    /// the caller nulls the slots this plan claimed (see
    /// [`LinkPlan::rollback_table_range`]) and lets the next successful archive
    /// entry record the resulting exact base. The returned requests release
    /// process mappings and the prepared activation.
    pub fn rollback(&self, linker: &mut Linker) -> Vec<HostRequest> {
        linker.scope.restore(self.scope_snapshot.clone());
        linker.got.restore(self.got_snapshot.clone());
        let mut requests = Vec::new();
        if let Some(activation) = self.activation_id {
            requests.push(HostRequest::UnregisterActivation {
                library: self.request.name.clone(),
                activation,
            });
        }
        for allocation in self.allocations.iter().rev() {
            requests.push(HostRequest::ReleaseMapping {
                library: self.request.name.clone(),
                allocation: allocation.clone(),
            });
        }
        requests
    }

    /// The slots this plan made addressable, as `(first, length)`, so a
    /// rollback can null them.
    pub fn rollback_table_range(&self, linker: &Linker) -> Option<(u64, u64)> {
        let end = linker.scope.table_length();
        (end > self.table_growth_start).then_some((
            self.table_growth_start,
            end - self.table_growth_start,
        ))
    }

    /// Advance to the next thing the driver must do.
    pub fn step(&mut self, linker: &mut Linker) -> DylinkResult<PlanStep> {
        if self.pending.is_some() {
            return Err(DylinkError::UnexpectedActSequence);
        }
        loop {
            if let Some((step, pending)) = self.queue.pop_front() {
                self.pending = Some(pending);
                return Ok(step);
            }
            match self.phase {
                Phase::Compile => {
                    self.emit(
                        PlanStep::Act(LinkAct::Compile {
                            module: self.module,
                            source: self.source.clone(),
                        }),
                        Pending::Compile,
                    );
                }
                Phase::Memory => self.plan_memory_phase(linker)?,
                Phase::Table => self.plan_table_phase(linker)?,
                Phase::BaseGlobals => self.plan_base_globals(linker)?,
                Phase::Tags => self.plan_tags(linker)?,
                Phase::Got => self.plan_got(linker)?,
                Phase::Activation => {
                    if self.fork_instrumented && self.activation_id.is_none() {
                        self.emit(
                            PlanStep::Host(HostRequest::PrepareActivation {
                                library: self.request.name.clone(),
                                replay_activation_id: self
                                    .request
                                    .replay
                                    .as_ref()
                                    .and_then(|replay| replay.activation_id),
                            }),
                            Pending::PrepareActivation,
                        );
                    } else {
                        self.phase = Phase::Instantiate;
                    }
                }
                Phase::Instantiate => {
                    let bindings = self.build_bindings(linker)?;
                    self.bindings = Some(bindings.clone());
                    self.emit(
                        PlanStep::Act(LinkAct::Instantiate {
                            module: self.module,
                            instance: self.instance,
                            bindings,
                        }),
                        Pending::Instantiate,
                    );
                }
                Phase::Register => {
                    if let Some(activation) = self.activation_id {
                        self.emit(
                            PlanStep::Host(HostRequest::RegisterActivation {
                                library: self.request.name.clone(),
                                activation,
                                instance: self.instance,
                            }),
                            Pending::RegisterActivation,
                        );
                    } else {
                        self.phase = Phase::Exports;
                    }
                }
                Phase::Exports => {
                    self.emit(
                        PlanStep::Act(LinkAct::ReadExports { instance: self.instance }),
                        Pending::ReadExports,
                    );
                }
                Phase::Bootstrap => self.plan_stage(InitializationStage::Bootstrap, Phase::Tls),
                Phase::Tls => {
                    self.plan_tls(linker)?;
                    self.plan_relocations()?;
                    self.phase = Phase::Relocate;
                }
                Phase::Relocate => self.plan_relocate(linker)?,
                Phase::Publish => self.plan_publish()?,
                Phase::GotWrites => self.plan_got_writes(linker)?,
                Phase::Commit => {
                    self.commit_symbols(linker)?;
                    self.phase = Phase::Relocations;
                }
                Phase::Relocations => {
                    self.plan_stage(InitializationStage::Relocations, Phase::Constructors)
                }
                Phase::Constructors => {
                    self.plan_stage(InitializationStage::Constructors, Phase::Finished)
                }
                Phase::Finished => return Ok(PlanStep::Finished),
            }
        }
    }

    fn emit(&mut self, step: PlanStep, pending: Pending) {
        self.queue.push_back((step, pending));
    }

    /// Feed the executor's answer back into the plan.
    pub fn resume(&mut self, linker: &mut Linker, result: ActResult) -> DylinkResult<()> {
        let pending = self.pending.take().ok_or(DylinkError::UnexpectedActSequence)?;
        match pending {
            Pending::Compile => {
                result.expect_done()?;
                self.phase = Phase::Memory;
            }
            Pending::Allocate => {
                let address = result.expect_index()?;
                let size = self.metadata.memory_size;
                check_allocation(&self.request.name, address, size, linker.config.memory_bytes)?;
                self.memory_base = address;
                self.allocations.push(DylinkAllocation {
                    address,
                    size,
                    mapping_address: address,
                    mapping_size: size,
                });
                // A fresh allocation is not guaranteed to be zeroed by the
                // process allocator, and a side module's `.bss` must be.
                self.emit(
                    PlanStep::Act(LinkAct::ZeroMemory { address, length: size }),
                    Pending::Zero,
                );
            }
            Pending::Adopt(index) => {
                result.expect_done()?;
                let next = index + 1;
                if next < self.allocations.len() {
                    let allocation = self.allocations[next].clone();
                    self.emit(
                        PlanStep::Host(HostRequest::AdoptMapping {
                            library: self.request.name.clone(),
                            allocation,
                        }),
                        Pending::Adopt(next),
                    );
                }
            }
            Pending::Zero | Pending::GrowMemory => {
                result.expect_done()?;
            }
            Pending::TablePad => {
                result.expect_index()?;
                linker.scope.set_table_length(self.table_base);
            }
            Pending::TableReserve => {
                let previous = result.expect_index()?;
                if previous != self.table_base {
                    return Err(DylinkError::ReplayTablePastBase {
                        library: self.request.name.clone(),
                        current: previous,
                        parent: self.table_base,
                    });
                }
                linker
                    .scope
                    .set_table_length(self.table_base + self.metadata.table_size);
                for offset in 0..self.metadata.table_size {
                    self.owned_table_entries.insert(self.table_base + offset);
                }
            }
            Pending::BaseGlobal(_) => result.expect_done()?,
            Pending::Tag(slot) => {
                result.expect_done()?;
                match slot {
                    TagSlot::Longjmp => linker.longjmp_tag = self.longjmp_tag,
                    TagSlot::CppException => linker.cpp_exception_tag = self.cpp_exception_tag,
                }
            }
            Pending::GotGlobal(index) => {
                result.expect_done()?;
                let site = &self.got_imports[index];
                let cell = GotCell {
                    global: site.global.ok_or(DylinkError::UnexpectedActSequence)?,
                    kind: site.kind,
                    placement: site.placement,
                    value: site.init,
                };
                match site.placement {
                    GotPlacement::Shared => linker.got.insert_shared(&site.symbol, cell),
                    GotPlacement::Local => {
                        self.local_got.insert((site.kind, site.symbol.clone()), cell);
                    }
                }
                self.got_cursor = index + 1;
            }
            Pending::PrepareActivation => {
                let activation = u32::try_from(result.expect_index()?)
                    .ok()
                    .filter(|activation| *activation != 0)
                    .ok_or(DylinkError::ActResultMismatch { expected: "a nonzero activation id" })?;
                if let Some(expected) =
                    self.request.replay.as_ref().and_then(|replay| replay.activation_id)
                {
                    if expected != activation {
                        return Err(DylinkError::ActivationIdMismatch {
                            library: self.request.name.clone(),
                            prepared: activation,
                            expected,
                        });
                    }
                }
                self.activation_id = Some(activation);
                self.phase = Phase::Instantiate;
            }
            Pending::Instantiate => {
                result.expect_done()?;
                self.phase = Phase::Register;
            }
            Pending::RegisterActivation => {
                result.expect_done()?;
                self.phase = Phase::Exports;
            }
            Pending::ReadExports => {
                self.exports = result.expect_exports()?;
                self.phase = Phase::Bootstrap;
            }
            Pending::Stage(stage) => {
                result.expect_done()?;
                self.phase = match stage {
                    InitializationStage::Bootstrap => Phase::Tls,
                    InitializationStage::Relocations => Phase::Constructors,
                    InitializationStage::Constructors => Phase::Finished,
                };
            }
            Pending::RelocatedGlobal(index) => {
                result.expect_done()?;
                let relocation = &self.relocations[index];
                let address = relocation.raw.as_u64().checked_add(relocation.base).ok_or(
                    DylinkError::AllocationEscapesMemory { library: self.request.name.clone() },
                )?;
                self.relocated.insert(
                    relocation.name.clone(),
                    SymbolValue::Data {
                        address,
                        binding: DataBinding::Global(relocation.global),
                    },
                );
                self.relocation_cursor = index + 1;
            }
            Pending::ExportTableGrow(index) => {
                let slot = result.expect_index()?;
                self.publish[index].table_index = Some(slot);
                linker.scope.set_table_length(slot + 1);
                self.owned_table_entries.insert(slot);
                let name = self.publish[index].name.clone();
                self.emit(
                    PlanStep::Act(LinkAct::WriteTable {
                        index: slot,
                        value: TableValue::Export { instance: self.instance, name },
                    }),
                    Pending::ExportTableWrite(index),
                );
                // A host-written slot is journaled into the same
                // activation-owned sparse table state instrumented `table.set`
                // writes reach, so fork captures the function as an
                // activation+ordinal recipe.
                self.emit(
                    PlanStep::Host(HostRequest::JournalTableMutation {
                        first_index: slot,
                        length: 1,
                    }),
                    Pending::ExportJournal(index),
                );
            }
            Pending::ExportTableWrite(_) => result.expect_done()?,
            Pending::ExportJournal(index) => {
                result.expect_done()?;
                if let Some(slot) = self.publish[index].table_index {
                    let name = self.publish[index].name.clone();
                    linker.scope.record_function_slot(self.instance, &name, slot);
                }
                self.publish_cursor = index + 1;
            }
            Pending::GotWrite(index) => {
                result.expect_done()?;
                let write = self.got_writes[index].clone();
                match write.placement {
                    GotPlacement::Shared => {
                        linker.got.set_shared_value(&write.symbol, write.value)
                    }
                    GotPlacement::Local => {
                        if let Some(cell) =
                            self.local_got.get_mut(&(write.kind, write.symbol.clone()))
                        {
                            cell.value = write.value;
                        }
                    }
                }
                self.got_write_cursor = index + 1;
            }
        }
        Ok(())
    }

    // ---- phases ----

    fn plan_memory_phase(&mut self, linker: &mut Linker) -> DylinkResult<()> {
        if self.memory_planned {
            self.phase = Phase::Table;
            return Ok(());
        }
        self.memory_planned = true;

        if self.metadata.memory_size == 0 {
            if self
                .request
                .replay
                .as_ref()
                .is_some_and(|replay| !replay.allocations.is_empty())
            {
                return Err(DylinkError::ZeroMemoryModuleOwnsMappings {
                    library: self.request.name.clone(),
                });
            }
            self.phase = Phase::Table;
            return Ok(());
        }

        let replay_base = self.request.replay.as_ref().map(|replay| replay.memory_base);
        let placement = plan_memory(
            &self.request.name,
            self.metadata.memory_size,
            self.metadata.memory_align_bytes()?,
            replay_base,
            linker.config.has_allocator,
            linker.config.heap_pointer,
            linker.config.memory_bytes,
        )?;
        match placement {
            MemoryPlacement::None => {}
            MemoryPlacement::Allocate { size, align } => {
                self.emit(
                    PlanStep::Host(HostRequest::AllocateMemory {
                        library: self.request.name.clone(),
                        size,
                        align,
                    }),
                    Pending::Allocate,
                );
            }
            MemoryPlacement::BumpHeap { base, end, grow_pages } => {
                self.memory_base = base;
                linker.config.heap_pointer = Some(end);
                if grow_pages > 0 {
                    linker.config.memory_bytes += grow_pages * 65_536;
                    self.emit(
                        PlanStep::Act(LinkAct::GrowMemory { delta_pages: grow_pages }),
                        Pending::GrowMemory,
                    );
                }
                self.emit(
                    PlanStep::Act(LinkAct::ZeroMemory {
                        address: base,
                        length: self.metadata.memory_size,
                    }),
                    Pending::Zero,
                );
            }
            MemoryPlacement::Replay { base } => {
                self.memory_base = base;
                let allocations = self
                    .request
                    .replay
                    .as_ref()
                    .map(|replay| replay.allocations.clone())
                    .unwrap_or_default();
                check_archived_allocations(
                    &self.request.name,
                    &allocations,
                    base,
                    self.metadata.memory_size,
                    linker.config.memory_bytes,
                    linker.config.has_allocator,
                )?;
                self.allocations = allocations;
                if let Some(allocation) = self.allocations.first().cloned() {
                    self.emit(
                        PlanStep::Host(HostRequest::AdoptMapping {
                            library: self.request.name.clone(),
                            allocation,
                        }),
                        Pending::Adopt(0),
                    );
                }
                // A replay's memory already holds the parent's post-startup
                // bytes; zeroing it would erase live state.
            }
        }
        Ok(())
    }

    fn plan_table_phase(&mut self, linker: &mut Linker) -> DylinkResult<()> {
        if self.table_planned {
            self.phase = Phase::BaseGlobals;
            return Ok(());
        }
        self.table_planned = true;

        let placement = plan_table(
            &self.request.name,
            linker.scope.table_length(),
            self.metadata.table_size,
            self.request.replay.as_ref().map(|replay| replay.table_base),
        )?;
        self.table_base = placement.base;
        self.table_pad = placement.pad;
        if placement.pad > 0 {
            self.emit(
                PlanStep::Act(LinkAct::GrowTable { delta: placement.pad }),
                Pending::TablePad,
            );
        }
        if placement.reserve > 0 {
            self.emit(
                PlanStep::Act(LinkAct::GrowTable { delta: placement.reserve }),
                Pending::TableReserve,
            );
        }
        Ok(())
    }

    fn plan_base_globals(&mut self, linker: &mut Linker) -> DylinkResult<()> {
        if self.memory_base_global.is_some() {
            self.phase = Phase::Tags;
            return Ok(());
        }
        let memory_global = linker.got.allocate_global();
        let table_global = linker.got.allocate_global();
        self.memory_base_global = Some(memory_global);
        self.table_base_global = Some(table_global);
        self.emit(
            PlanStep::Act(LinkAct::NewGlobal {
                global: memory_global,
                ty: self.width.val_type(),
                mutable: false,
                init: WasmValue::address(self.width, self.memory_base)?,
            }),
            Pending::BaseGlobal(BaseGlobal::Memory),
        );
        self.emit(
            PlanStep::Act(LinkAct::NewGlobal {
                global: table_global,
                ty: self.width.val_type(),
                mutable: false,
                init: WasmValue::address(self.width, self.table_base)?,
            }),
            Pending::BaseGlobal(BaseGlobal::Table),
        );
        Ok(())
    }

    fn plan_tags(&mut self, linker: &mut Linker) -> DylinkResult<()> {
        if self.needs_longjmp_tag && self.longjmp_tag.is_none() {
            let tag = linker.allocate_tag();
            self.longjmp_tag = Some(tag);
            self.emit(
                PlanStep::Act(LinkAct::NewTag {
                    tag,
                    parameters: alloc::vec![self.width.val_type()],
                }),
                Pending::Tag(TagSlot::Longjmp),
            );
            return Ok(());
        }
        if self.needs_cpp_tag && self.cpp_exception_tag.is_none() {
            let tag = linker.allocate_tag();
            self.cpp_exception_tag = Some(tag);
            self.emit(
                PlanStep::Act(LinkAct::NewTag {
                    tag,
                    parameters: alloc::vec![self.width.val_type()],
                }),
                Pending::Tag(TagSlot::CppException),
            );
            return Ok(());
        }
        self.phase = Phase::Got;
        Ok(())
    }

    fn plan_got(&mut self, linker: &mut Linker) -> DylinkResult<()> {
        while self.got_cursor < self.got_imports.len() {
            let index = self.got_cursor;
            let (kind, symbol) =
                (self.got_imports[index].kind, self.got_imports[index].symbol.clone());

            // A duplicate GOT declaration reuses the cell the first one made,
            // exactly as the TypeScript `Proxy` returns the same Global on a
            // second read of the same property.
            if let Some(cell) = self.local_got.get(&(kind, symbol.clone())) {
                self.got_imports[index].placement = GotPlacement::Local;
                self.got_imports[index].global = Some(cell.global);
                self.got_imports[index].init = cell.value;
                self.got_cursor += 1;
                continue;
            }

            crate::got::require_stable_kind(&linker.got, &self.request.name, &symbol, kind)?;

            let resolved = linker.scope.scoped_symbol(&self.dependency_scope, &symbol);
            let resolved_table_index =
                resolved.as_ref().and_then(|resolved| match &resolved.value {
                    SymbolValue::Func { instance, export } => {
                        linker.scope.function_table_index(*instance, export)
                    }
                    SymbolValue::Data { .. } => None,
                });
            let self_export = match kind {
                GotKind::Mem => self
                    .shape
                    .export(&symbol)
                    .is_some_and(|export| export.kind == ExternKind::Global),
                GotKind::Func => self.shape.exports_function(&symbol),
            };
            let replay_value = self
                .request
                .replay
                .as_ref()
                .filter(|_| kind == GotKind::Func)
                .and_then(|replay| replay.saved_got_func.get(&symbol).copied());

            let decision = decide_got_cell(GotRequest {
                library: &self.request.name,
                metadata: &self.metadata,
                kind,
                symbol: &symbol,
                resolved: resolved.as_ref(),
                resolved_table_index,
                self_export,
                replay_value,
                width: self.width,
                policy: self.policy,
            })?;
            if let Some(provider) = decision.provider.clone() {
                if provider != self.request.name {
                    self.provider_dependencies.insert(provider);
                }
            }

            // An existing shared cell is reused; a cell that resolves better
            // now is rewritten by the publish phase, not here.
            if decision.placement == GotPlacement::Shared {
                if let Some(cell) = linker.got.shared_cell(&symbol) {
                    self.got_imports[index].placement = GotPlacement::Shared;
                    self.got_imports[index].global = Some(cell.global);
                    self.got_imports[index].init = cell.value;
                    self.got_cursor += 1;
                    continue;
                }
            }

            let init = decision.init.value(self.width)?;
            let global = linker.got.allocate_global();
            self.got_imports[index].placement = decision.placement;
            self.got_imports[index].global = Some(global);
            self.got_imports[index].init = init;
            self.got_imports[index].pending_self_definition =
                matches!(decision.init, GotInit::PendingSelfDefinition);
            self.emit(
                PlanStep::Act(LinkAct::NewGlobal {
                    global,
                    ty: self.width.val_type(),
                    mutable: true,
                    init,
                }),
                Pending::GotGlobal(index),
            );
            return Ok(());
        }
        self.phase = Phase::Activation;
        Ok(())
    }

    /// Build the ordered import bindings: one per declaration, in order.
    fn build_bindings(&mut self, linker: &Linker) -> DylinkResult<Vec<ImportBinding>> {
        let mut plan = ImportPlan::with_capacity(self.shape.imports.len());
        for (index, decl) in self.shape.imports.iter().enumerate() {
            let value = if let Some(kind) = GotKind::from_namespace(&decl.module) {
                let site = self
                    .got_imports
                    .iter()
                    .find(|site| site.declaration == index && site.kind == kind)
                    .ok_or(DylinkError::UnexpectedActSequence)?;
                BindingValue::Global(site.global.ok_or(DylinkError::UnexpectedActSequence)?)
            } else if decl.module == "env" {
                self.bind_env_import(linker, decl)?
            } else if self.fork_instrumented {
                // Non-`env`, non-GOT namespaces belong to the fork activation
                // coordinator (frame/reference/exception/GC imports and the
                // private unwind transport). The planner binds them by name and
                // never inspects them; the fork side keeps ownership of
                // activations, frame flips and reference flips.
                BindingValue::ActivationEnv { name: decl.name.clone() }
            } else {
                return Err(DylinkError::UndefinedSymbol {
                    library: self.request.name.clone(),
                    symbol: decl.name.clone(),
                    kind: "import",
                });
            };
            plan.bind(decl, value)?;
        }
        plan.finish(&self.shape.imports)
    }

    fn bind_env_import(
        &self,
        linker: &Linker,
        decl: &ImportDecl,
    ) -> DylinkResult<BindingValue> {
        match decl.name.as_str() {
            "memory" => return Ok(BindingValue::ProcessMemory),
            "__indirect_function_table" => return Ok(BindingValue::ProcessTable),
            "__stack_pointer" => return Ok(BindingValue::ProcessStackPointer),
            "__memory_base" => {
                return Ok(BindingValue::Global(
                    self.memory_base_global.ok_or(DylinkError::UnexpectedActSequence)?,
                ));
            }
            "__table_base" => {
                return Ok(BindingValue::Global(
                    self.table_base_global.ok_or(DylinkError::UnexpectedActSequence)?,
                ));
            }
            "__c_longjmp" => {
                return Ok(BindingValue::Tag(
                    self.longjmp_tag.ok_or(DylinkError::UnexpectedActSequence)?,
                ));
            }
            "__cpp_exception" => {
                return Ok(BindingValue::Tag(
                    self.cpp_exception_tag.ok_or(DylinkError::UnexpectedActSequence)?,
                ));
            }
            _ => {}
        }

        // Activation-owned names never fall through to a process symbol:
        // splitting ownership between the loader and the coordinator would bind
        // a continuation to the wrong activation. A missing one fails here,
        // before the side module executes.
        if self.fork_instrumented
            && (decl.name == "fork" || decl.name.starts_with("__wpk_fork_"))
        {
            return Ok(BindingValue::ActivationEnv { name: decl.name.clone() });
        }

        if let Some(resolved) = linker.scope.scoped_symbol(&self.dependency_scope, &decl.name) {
            return Ok(match resolved.value {
                SymbolValue::Func { instance, export } => {
                    BindingValue::Export { instance, name: export }
                }
                SymbolValue::Data { binding, .. } => match binding {
                    DataBinding::Export { instance, name } => {
                        BindingValue::Export { instance, name }
                    }
                    DataBinding::Global(global) => BindingValue::Global(global),
                },
            });
        }

        // `wasm-ld` can make an interposable C++ definition both an `env`
        // import and a module export. The process wins when it supplies the
        // symbol; otherwise route this genuine self-definition back. A
        // trampoline is NEVER manufactured for an arbitrary unresolved import:
        // that would turn an ABI gap into a delayed failure on a possibly
        // unexecuted path.
        if decl.ty.kind() == ExternKind::Func
            && self.shape.defined_function_exports().any(|name| name == decl.name)
        {
            return Ok(BindingValue::SelfImport { name: decl.name.clone() });
        }

        // ELF: a weak undefined symbol is zero. Anything else is a load error
        // named after the symbol, which is what every other loader reports.
        if matches!(self.policy, UnresolvedPolicy::ElfStrict)
            && !self.metadata.is_weak_import("env", &decl.name)
        {
            return Err(DylinkError::UndefinedSymbol {
                library: self.request.name.clone(),
                symbol: decl.name.clone(),
                kind: "import",
            });
        }
        Ok(BindingValue::WeakUndefined)
    }

    fn plan_stage(&mut self, stage: InitializationStage, skip_to: Phase) {
        if self.runs_stage(stage) {
            let call = self.staged_call(stage);
            self.emit(PlanStep::Call(call), Pending::Stage(stage));
        } else {
            self.phase = skip_to;
        }
    }

    fn runs_stage(&self, stage: InitializationStage) -> bool {
        // A complete fork replay receives already-relocated, already-constructed
        // live bytes from the parent; re-running these entries would relocate
        // pointers twice and clobber post-startup state (opcache's
        // `accel_globals`, registered INI entries). An IN-FLIGHT replay still
        // yields the full sequence so the archived selector can stop at the
        // exact guest call being resumed.
        if self
            .request
            .replay
            .as_ref()
            .is_some_and(|replay| replay.initialization_stage.is_none())
        {
            return false;
        }
        match stage {
            InitializationStage::Bootstrap => self.activation_id.is_some(),
            _ => self.exports_function(stage.export_name()),
        }
    }

    fn exports_function(&self, name: &str) -> bool {
        self.exports
            .iter()
            .any(|export| export.kind == ExternKind::Func && export.name == name)
    }

    fn staged_call(&self, stage: InitializationStage) -> StagedCall {
        StagedCall {
            library: self.request.name.clone(),
            stage,
            instance: self.instance,
            export: stage.export_name(),
        }
    }

    /// Validate the instance's TLS region.
    ///
    /// A threaded `wasm-ld` side module initializes `__tls_base` from
    /// `__memory_base` in its start function. Fork-child memory already carries
    /// the parent's `__wasm_init_memory_flag == 2`, so the fresh child instance
    /// skips that initialization; replay restores the captured value WITHOUT
    /// calling `__wasm_init_tls`, which would overwrite live copied TLS state
    /// (including the C++ unwinder's landing-pad context) with `.tdata`.
    fn plan_tls(&mut self, linker: &Linker) -> DylinkResult<()> {
        let replay_tls = self.request.replay.as_ref().and_then(|replay| replay.tls_base);
        let tls_size = self.global_export_value("__tls_size").map(WasmValue::as_u64);
        if !self.metadata.tls_exports.is_empty() && tls_size.is_none() {
            return Err(DylinkError::MissingTlsExport {
                library: self.request.name.clone(),
                export: "__tls_size",
            });
        }
        let Some(tls_size) = tls_size.filter(|size| *size > 0) else {
            if replay_tls.is_some() {
                return Err(DylinkError::UnexpectedReplayTlsState {
                    library: self.request.name.clone(),
                });
            }
            return Ok(());
        };

        let align = self
            .global_export_value("__tls_align")
            .map(WasmValue::as_u64)
            .ok_or(DylinkError::MissingTlsExport {
                library: self.request.name.clone(),
                export: "__tls_align",
            })?;
        let instance_base = self
            .exports
            .iter()
            .find(|export| export.name == "__tls_base" && export.kind == ExternKind::Global)
            .ok_or(DylinkError::MissingTlsExport {
                library: self.request.name.clone(),
                export: "__tls_base",
            })?;
        // Fork replay must be able to WRITE this global back, so an immutable
        // one is a rebuild boundary rather than something to work around.
        if instance_base.mutable != Some(true) {
            return Err(DylinkError::MissingTlsExport {
                library: self.request.name.clone(),
                export: "a mutable __tls_base",
            });
        }
        let base = match replay_tls {
            Some(base) => base,
            None => instance_base.value.map(WasmValue::as_u64).unwrap_or(0),
        };
        if self.request.replay.is_some() && base == 0 {
            return Err(DylinkError::MissingReplayTlsBase {
                library: self.request.name.clone(),
            });
        }
        let region = check_tls(
            &self.request.name,
            base,
            tls_size,
            align,
            self.memory_base,
            self.metadata.memory_size,
            linker.config.memory_bytes.max(base + tls_size),
        )?;
        self.tls_base = Some(region.base);
        Ok(())
    }

    fn global_export_value(&self, name: &str) -> Option<WasmValue> {
        self.exports
            .iter()
            .find(|export| export.name == name && export.kind == ExternKind::Global)
            .and_then(|export| export.value)
    }

    /// Decide which exported globals are data addresses needing relocation.
    ///
    /// An IMMUTABLE global export is a data address relative to the module's own
    /// base; a mutable one is instance state and passes through. `__tls_size`
    /// and `__tls_align` are scalar ABI facts, not addresses.
    ///
    /// `dylink.ts:2071-2098` distinguishes the two by attempting a
    /// self-assignment and catching the throw, which is the only reflection the
    /// JS API offers. The executor reports mutability directly instead.
    fn plan_relocations(&mut self) -> DylinkResult<()> {
        for export in &self.exports {
            match export.kind {
                ExternKind::Global => {
                    let (Some(raw), Some(mutable)) = (export.value, export.mutable) else {
                        continue;
                    };
                    if mutable || export.name == "__tls_size" || export.name == "__tls_align" {
                        self.relocated.insert(
                            export.name.clone(),
                            SymbolValue::Data {
                                address: raw.as_u64(),
                                binding: DataBinding::Export {
                                    instance: self.instance,
                                    name: export.name.clone(),
                                },
                            },
                        );
                        continue;
                    }
                    let base = if self.metadata.tls_exports.contains(&export.name) {
                        self.tls_base.ok_or(DylinkError::MissingReplayTlsBase {
                            library: self.request.name.clone(),
                        })?
                    } else {
                        self.memory_base
                    };
                    self.relocations.push(PendingRelocation {
                        name: export.name.clone(),
                        raw,
                        base,
                        global: GlobalId(u32::MAX),
                    });
                }
                ExternKind::Func => {
                    self.relocated.insert(
                        export.name.clone(),
                        SymbolValue::Func {
                            instance: self.instance,
                            export: export.name.clone(),
                        },
                    );
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn plan_relocate(&mut self, linker: &mut Linker) -> DylinkResult<()> {
        if self.relocation_cursor < self.relocations.len() {
            let index = self.relocation_cursor;
            let global = linker.got.allocate_global();
            self.relocations[index].global = global;
            let relocation = &self.relocations[index];
            let value = WasmValue::address(
                self.width,
                relocation.raw.as_u64().checked_add(relocation.base).ok_or(
                    DylinkError::AllocationEscapesMemory {
                        library: self.request.name.clone(),
                    },
                )?,
            )?;
            self.emit(
                PlanStep::Act(LinkAct::NewGlobal {
                    global,
                    ty: self.width.val_type(),
                    mutable: false,
                    init: value,
                }),
                Pending::RelocatedGlobal(index),
            );
            return Ok(());
        }
        self.plan_publications();
        self.phase = Phase::Publish;
        Ok(())
    }

    /// Choose which exports become process-visible symbols and table entries.
    fn plan_publications(&mut self) {
        for export in &self.exports {
            if !is_public_dylink_export(&export.name) || is_fork_runtime_export(&export.name) {
                continue;
            }
            match export.kind {
                ExternKind::Func => self.publish.push(PublishSite {
                    name: export.name.clone(),
                    kind: ExternKind::Func,
                    table_index: None,
                    address: None,
                    binding: None,
                }),
                ExternKind::Global => {
                    let relocated = self.relocated.get(&export.name);
                    self.publish.push(PublishSite {
                        name: export.name.clone(),
                        kind: ExternKind::Global,
                        table_index: None,
                        address: relocated.and_then(SymbolValue::address),
                        binding: relocated.and_then(|value| match value {
                            SymbolValue::Data { binding, .. } => Some(binding.clone()),
                            SymbolValue::Func { .. } => None,
                        }),
                    });
                }
                _ => {}
            }
        }
    }

    fn plan_publish(&mut self) -> DylinkResult<()> {
        // Every exported function needs a table slot before anything can take
        // its address.
        while self.publish_cursor < self.publish.len() {
            let index = self.publish_cursor;
            if self.publish[index].kind == ExternKind::Func
                && self.publish[index].table_index.is_none()
            {
                self.emit(
                    PlanStep::Act(LinkAct::GrowTable { delta: 1 }),
                    Pending::ExportTableGrow(index),
                );
                return Ok(());
            }
            self.publish_cursor += 1;
        }
        self.phase = Phase::GotWrites;
        Ok(())
    }

    fn plan_got_writes(&mut self, linker: &Linker) -> DylinkResult<()> {
        if !self.got_writes_planned {
            self.got_writes_planned = true;
            self.collect_got_writes(linker)?;
        }
        if self.got_write_cursor < self.got_writes.len() {
            let write = self.got_writes[self.got_write_cursor].clone();
            self.emit(
                PlanStep::Act(LinkAct::WriteGlobal {
                    global: write.global,
                    value: write.value,
                }),
                Pending::GotWrite(self.got_write_cursor),
            );
            return Ok(());
        }
        self.phase = Phase::Commit;
        Ok(())
    }

    /// Republish every GOT cell this module's own exports now satisfy.
    fn collect_got_writes(&mut self, linker: &Linker) -> DylinkResult<()> {
        for site in &self.publish {
            let (kind, value) = match (site.kind, site.table_index, site.address) {
                (ExternKind::Func, Some(index), _) => {
                    (GotKind::Func, WasmValue::address(self.width, index)?)
                }
                (ExternKind::Global, _, Some(address)) => {
                    (GotKind::Mem, WasmValue::address(self.width, address)?)
                }
                _ => continue,
            };
            if let Some(cell) = self.local_got.get(&(kind, site.name.clone())) {
                if cell.value != value {
                    self.got_writes.push(GotWrite {
                        kind,
                        symbol: site.name.clone(),
                        global: cell.global,
                        value,
                        placement: GotPlacement::Local,
                    });
                }
            }
            // A shared cell is republished only when this object is the
            // symbol's FIRST definition. Overwriting an existing global
            // definition would break ELF interposition: the first definition
            // wins for the whole process, and the guest already holds pointers
            // derived from it.
            let already_defined = linker.scope.global_symbol(&site.name).is_some();
            if self.request.global_visibility && !already_defined {
                if let Some(cell) = linker.got.shared_cell(&site.name) {
                    if cell.kind != kind {
                        return Err(DylinkError::ConflictingSymbolKind {
                            library: self.request.name.clone(),
                            symbol: site.name.clone(),
                        });
                    }
                    if cell.value != value {
                        self.got_writes.push(GotWrite {
                            kind,
                            symbol: site.name.clone(),
                            global: cell.global,
                            value,
                            placement: GotPlacement::Shared,
                        });
                    }
                }
            }
        }
        Ok(())
    }

    fn commit_symbols(&mut self, linker: &mut Linker) -> DylinkResult<()> {
        let mut exports = BTreeMap::new();
        for site in &self.publish {
            let value = match (site.kind, site.address, &site.binding) {
                (ExternKind::Func, _, _) => SymbolValue::Func {
                    instance: self.instance,
                    export: site.name.clone(),
                },
                (ExternKind::Global, Some(address), Some(binding)) => SymbolValue::Data {
                    address,
                    binding: binding.clone(),
                },
                _ => continue,
            };
            exports.insert(site.name.clone(), value);
        }
        let library = LoadedLibrary {
            name: self.request.name.clone(),
            module_bytes: self.request.module_bytes.clone(),
            instance: self.instance,
            metadata: self.metadata.clone(),
            memory_base: self.memory_base,
            table_base: self.table_base,
            tls_base: self.tls_base,
            activation_id: self.activation_id,
            global_visibility: self
                .request
                .replay
                .as_ref()
                .map(|replay| replay.global_visibility)
                .unwrap_or(self.request.global_visibility),
            committed_global_root: self
                .request
                .replay
                .as_ref()
                .is_some_and(|replay| replay.committed_global_root),
            exports,
            owned_table_entries: self.owned_table_entries.clone(),
            got_imports: self
                .got_imports
                .iter()
                .filter(|site| site.placement == GotPlacement::Shared)
                .map(|site| (site.symbol.clone(), site.kind))
                .collect(),
            provider_dependencies: self.provider_dependencies.clone(),
            allocations: self.allocations.clone(),
            load_state: LoadState::Loaded,
        };
        let name = library.name.clone();
        linker.scope.insert(library)?;
        linker.scope.publish_global_library_symbols(&name)?;
        Ok(())
    }

    /// Take the loaded object out of the plan once `step` reports
    /// [`PlanStep::Finished`].
    pub fn finish(self, linker: &Linker) -> DylinkResult<LoadedLibrary> {
        if self.phase != Phase::Finished {
            return Err(DylinkError::UnexpectedActSequence);
        }
        linker
            .scope
            .library(&self.request.name)
            .cloned()
            .ok_or(DylinkError::UnexpectedActSequence)
    }
}

fn fork_export_count(shape: &ModuleShape) -> usize {
    wasm_posix_shared::abi::WPK_FORK_REQUIRED_EXPORTS
        .iter()
        .filter(|required| shape.exports_function(required.name))
        .count()
}

/// A `GOT.*` import must be a mutable pointer-width global. Exposed so an
/// executor can assert the module it is handed agrees with the process's
/// pointer width before anything is constructed.
pub fn is_valid_got_import_type(ty: &ImportType, width: PointerWidth) -> bool {
    matches!(
        ty,
        ImportType::Global { value_type, mutable: true }
            if *value_type == width.val_type()
    )
}

/// The value type a pointer-width global must have.
pub fn pointer_val_type(width: PointerWidth) -> ValType {
    width.val_type()
}
