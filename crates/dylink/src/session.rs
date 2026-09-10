//! The process's loader session: many concurrent transactions, dependency
//! resolution, `dlsym` address materialization, and `dlclose` unload.
//!
//! # Why this layer exists
//!
//! [`crate::plan::LinkPlan`] links ONE object whose dependencies are already in
//! scope. That is the whole of what a `dlopen` needs *after* the loader has
//! decided which objects to load, in what order, and what to do when the
//! program asks for a symbol or gives one back. Those decisions were the six
//! things `host/src/dylink.ts` still owned, and each one of them is linker
//! policy:
//!
//! 1. **`DT_NEEDED` resolution.** Which paths are searched, in what order, and
//!    what a miss means. The driver performs `openat`/`read`/`close` for one
//!    named candidate ([`HostRequest::ReadDependency`]) and decides nothing.
//! 2. **`dlsym` → address.** A C function pointer is an indirect-function-table
//!    index. When a resolved function has no slot yet the loader must take one,
//!    which is a table mutation the session ORDERS and the driver performs.
//! 3. **Concurrent transactions.** A constructor may call `dlopen`, so a
//!    session holds a map of live transactions rather than one slot.
//! 4. **Fork state capture** and 5. **fork reconcile**: [`Session::fork_state`]
//!    and [`Session::fork_reconcile_begin`], which share this file's frame
//!    machinery because a replay is a load whose layout is dictated.
//! 6. **`dlclose` unload.** Which objects become unloadable, in what order
//!    their table slots are cleared and mappings released, and how the global
//!    scope is rebuilt afterwards.
//!
//! # One drive loop
//!
//! Every transaction — a load, a `dlsym`, a `dlclose`, a fork reconcile — is
//! driven by the same [`Session::step`] / [`Session::resume`] pair, and a
//! rollback re-arms that same loop rather than introducing a second one. A
//! driver therefore implements the loop once.
//!
//! # Transactions are not handles
//!
//! A token is private to libc's prepare/next/commit protocol. It is allocated
//! from a separate counter, it is never returned to the program as a `dlopen`
//! handle, and it is forgotten when the transaction finishes.

use alloc::collections::{BTreeMap, BTreeSet, VecDeque};
use alloc::string::{String, ToString};
use alloc::vec::Vec;

use fork_codec::dylink_archive::encode::dylink_module_template_digest;
use fork_codec::dylink_archive::walk::ArchiveWalk;
use fork_codec::dylink_archive::{
    DylinkArchive, DylinkInitialization, DylinkInitializationStage, DylinkModule, DylinkTablePatch,
    DylinkTransaction,
};

use crate::act::{ActResult, InstanceId, LinkAct, TableValue, TagId};
use crate::archive::{
    next_generation, ArchiveState, SyncFlow, MAX_TABLE_PATCH_BYTES, MAX_TABLE_PATCH_RECORDS,
    TABLE_PATCH_HEADER_BYTES, TABLE_PATCH_RUN_BYTES,
};
use crate::error::{DylinkError, DylinkResult};
use crate::got::refresh_shared_cells;
use crate::handles::{CloseOutcome, HandleTable, MAIN_PROGRAM_HANDLE};
use crate::metadata::parse_dylink_section;
use crate::plan::{
    HostRequest, InitializationStage, LinkPlan, Linker, LinkerConfig, LoadRequest, PlanStep,
    ReplayInputs,
};
use crate::scope::{is_fork_runtime_export, ResolvedSymbol, SymbolValue};

/// Everything a fork child needs to rebuild one object the parent had loaded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayModule {
    pub module_bytes: Vec<u8>,
    pub inputs: ReplayInputs,
    /// The parent's exact `dlopen` handle, when the object had one. A child
    /// that renumbered handles would hand back a value the program has never
    /// seen, because the guest holds the parent's in copied memory.
    pub handle: Option<u32>,
    pub ref_count: u32,
}

/// Whether a replay owns its memory or is reading a suspended parent's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum MemoryOwnership {
    #[default]
    Copied,
    /// A `vfork` child shares the parent's live memory: loader-controlled
    /// instantiation must be provably read-only.
    Borrowed,
}

/// What the last answer was for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Awaiting {
    /// The bytes of one `DT_NEEDED` search-path candidate.
    Dependency,
    /// A result belonging to the frame's [`LinkPlan`].
    Plan,
    /// A step the session itself emitted; only [`ActResult::Done`] answers it.
    SessionDone,
    /// A `GrowTable` the session emitted for `dlsym`.
    SessionIndex,
    /// An `AllocateArchive` the archive planner emitted.
    SessionAllocate,
    /// A `ReadArchive` range the archive walker asked for.
    SessionBytes,
}

/// One object being resolved and linked inside a transaction.
struct Frame {
    request: LoadRequest,
    /// `DT_NEEDED` names not yet known to be in scope.
    needed: VecDeque<String>,
    /// The dependency currently being looked for, the path in flight, and the
    /// candidates left to try after it.
    current: Option<String>,
    current_path: Option<String>,
    candidates: VecDeque<String>,
    plan: Option<LinkPlan>,
}

struct LoadFlow {
    root: String,
    global_visibility: bool,
    frames: Vec<Frame>,
    /// Roots still to link, in archive order. Empty for an ordinary `dlopen`;
    /// a fork reconcile rebuilds many objects under one transaction so the
    /// driver runs one loop for the whole child.
    pending_roots: VecDeque<LoadRequest>,
    /// Names this transaction inserted into scope, dependency-first. The order
    /// is the archive's order and the rollback's reverse order.
    completed: Vec<String>,
    /// Work decided together and emitted one at a time.
    queue: VecDeque<PlanStep>,
    /// Which library's constructors are running, for provider-edge recording.
    constructing: Option<String>,
    /// The table slot the driver published the last staged `() -> ()` entry
    /// into, so a fork capture can record where the child must resume.
    staged_slot: Option<u64>,
    commit_planned: bool,
    finished: bool,
    /// Table length before this transaction grew it, so an abort can null what
    /// it made addressable. A table cannot shrink.
    table_growth_start: u64,
    /// A replay pins each object's handle; an ordinary load allocates one.
    replay: bool,
}

struct SymFlow {
    /// `None` until resolved, and `None` FOREVER on a miss — which is a
    /// successful call carrying nothing, as POSIX requires.
    address: Option<u64>,
    /// A resolved function still needing a table slot.
    slot_for: Option<(InstanceId, String)>,
    queue: VecDeque<PlanStep>,
    finished: bool,
}

struct CloseFlow {
    outcome: CloseOutcome,
    queue: VecDeque<PlanStep>,
    finished: bool,
}

/// Walking the process archive's record chain, one fetched range at a time.
struct ReadFlow {
    walk: ArchiveWalk,
    finished: bool,
}

enum Flow {
    Load(LoadFlow),
    Sym(SymFlow),
    Close(CloseFlow),
    /// Publishing the loader's state into the process archive.
    Sync(SyncFlow),
    /// Reading the process archive back out of guest memory.
    Read(ReadFlow),
    /// A transaction that failed and is draining its rollback through the same
    /// drive loop.
    RollingBack(VecDeque<PlanStep>),
}

struct Transaction {
    awaiting: Option<Awaiting>,
    flow: Flow,
}

/// The process's loader.
pub struct Session {
    pub linker: Linker,
    pub handles: HandleTable,
    transactions: BTreeMap<u32, Transaction>,
    next_token: u32,
    /// The path each `DT_NEEDED` name resolved to. A sibling dependency of the
    /// same object is looked for beside it first, which is what makes a private
    /// directory of shared objects work without a search-path entry.
    resolved_paths: BTreeMap<String, String>,
    /// Replay inputs for a fork reconcile in progress.
    replay_modules: BTreeMap<String, ReplayModule>,
    /// What this process has published into guest memory, and where.
    published: ArchiveState,
    /// The archive the last [`Session::archive_read_begin`] decoded.
    archive: Option<DylinkArchive>,
    /// Funcref table patches the activation coordinator has handed over, which
    /// ride in the same record chain and are published with it.
    table_patches: Vec<DylinkTablePatch>,
    table_state_root: u64,
    table_checkpoint_generation: u64,
}

impl Session {
    pub fn new(config: LinkerConfig) -> Self {
        Session {
            linker: Linker::new(config),
            handles: HandleTable::new(),
            transactions: BTreeMap::new(),
            next_token: 1,
            resolved_paths: BTreeMap::new(),
            replay_modules: BTreeMap::new(),
            published: ArchiveState::default(),
            archive: None,
            table_patches: Vec::new(),
            table_state_root: 0,
            table_checkpoint_generation: 0,
        }
    }

    /// Drop every loader transaction and all scope. `exec` replaces the process
    /// image, so nothing survives it.
    pub fn reset(&mut self, config: LinkerConfig) {
        *self = Session::new(config);
    }

    pub fn contains(&self, token: u32) -> bool {
        self.transactions.contains_key(&token)
    }

    /// Has `token`'s drive loop reached `Finished`?
    ///
    /// A transaction whose staged initializer is still outstanding is not a
    /// FAILED transaction — it is one the guest has not finished driving, and
    /// committing it early is a misuse the caller must be able to distinguish
    /// from a load that cannot complete. Rolling it back on that mistake would
    /// destroy a `dlopen` that was going to succeed.
    pub fn is_finished(&self, token: u32) -> bool {
        match self.transactions.get(&token) {
            Some(transaction) => match &transaction.flow {
                Flow::Load(load) => load.finished,
                Flow::Sym(sym) => sym.finished,
                Flow::Close(close) => close.finished,
                Flow::Sync(sync) => sync.finished,
                Flow::Read(read) => read.finished,
                Flow::RollingBack(queue) => queue.is_empty(),
            },
            None => false,
        }
    }

    /// Live transaction tokens, oldest first.
    pub fn tokens(&self) -> Vec<u32> {
        self.transactions.keys().copied().collect()
    }

    /// Adopt the process's existing exception tags under ids the driver has
    /// already bound them to.
    ///
    /// C++ exceptions and `longjmp` crossing a side-module call require tag
    /// IDENTITY, not just a matching payload type, and the identity is the main
    /// image's. A planner that created its own tags would give every side module
    /// a realm the main image cannot catch in — which fails only when an
    /// exception actually crosses, long after the load looked successful.
    pub fn adopt_process_tags(&mut self, longjmp: Option<TagId>, cpp_exception: Option<TagId>) {
        let highest = [longjmp, cpp_exception]
            .into_iter()
            .flatten()
            .map(|tag| tag.index())
            .max();
        self.linker.longjmp_tag = longjmp;
        self.linker.cpp_exception_tag = cpp_exception;
        if let Some(highest) = highest {
            // The planner allocates tag ids from a counter; adopted ones must
            // not be handed out again to a tag it creates later.
            self.linker.reserve_tags(highest + 1);
        }
    }

    /// The plan currently linking an object inside `token`, if any.
    ///
    /// This is the layout a caller has to record: the innermost frame is the
    /// object being placed right now, which for a load with dependencies is the
    /// dependency, not the root.
    pub fn active_plan(&self, token: u32) -> Option<&LinkPlan> {
        match &self.transactions.get(&token)?.flow {
            Flow::Load(load) => load.frames.last()?.plan.as_ref(),
            _ => None,
        }
    }

    fn allocate_token(&mut self) -> DylinkResult<u32> {
        let token = self.next_token;
        self.next_token = token
            .checked_add(1)
            .ok_or(DylinkError::HandleOutOfRange { handle: token })?;
        Ok(token)
    }

    fn transaction(&mut self, token: u32) -> DylinkResult<&mut Transaction> {
        self.transactions
            .get_mut(&token)
            .ok_or(DylinkError::UnknownTransaction { token })
    }

    // -----------------------------------------------------------------------
    // dlopen
    // -----------------------------------------------------------------------

    /// Begin a `dlopen`. Returns the transaction token to drive.
    ///
    /// A second concurrent begin is not refused: a constructor calling `dlopen`
    /// is legal POSIX, and it is the reason [`crate::scope::LoadState`] has an
    /// `Initializing` state at all.
    pub fn open_begin(&mut self, request: LoadRequest) -> DylinkResult<u32> {
        let token = self.allocate_token()?;
        let table_growth_start = self.linker.scope.table_length();
        let already_loaded = self.linker.scope.contains(&request.name);
        if already_loaded && request.replay.is_some() {
            // A parent archive lists each object once. Two records for one name
            // would mean the child had already reconstructed it, and replaying
            // the second would allocate a second layout for the same object.
            return Err(DylinkError::DuplicateLibrary { library: request.name });
        }
        let root = request.name.clone();
        let global_visibility = request
            .replay
            .as_ref()
            .map(|replay| replay.global_visibility)
            .unwrap_or(request.global_visibility);
        let frames = if already_loaded {
            Vec::new()
        } else {
            alloc::vec![Frame::new(request)?]
        };
        let flow = LoadFlow {
            root,
            global_visibility,
            frames,
            pending_roots: VecDeque::new(),
            completed: Vec::new(),
            queue: VecDeque::new(),
            constructing: None,
            staged_slot: None,
            commit_planned: false,
            finished: false,
            table_growth_start,
            replay: false,
        };
        self.transactions
            .insert(token, Transaction { awaiting: None, flow: Flow::Load(flow) });
        Ok(token)
    }

    /// Complete a load and return its `dlopen` handle.
    ///
    /// `replay_handle` pins the parent's exact handle during fork replay.
    pub fn open_finish(&mut self, token: u32, replay_handle: Option<u32>) -> DylinkResult<u32> {
        let transaction = self
            .transactions
            .remove(&token)
            .ok_or(DylinkError::UnknownTransaction { token })?;
        let Flow::Load(flow) = transaction.flow else {
            return Err(DylinkError::UnexpectedActSequence);
        };
        if !flow.finished {
            self.transactions
                .insert(token, Transaction { awaiting: None, flow: Flow::Load(flow) });
            return Err(DylinkError::UnexpectedActSequence);
        }
        let handle = self.handles.open(&flow.root, replay_handle)?;
        let edges: Vec<(String, BTreeSet<String>)> = flow
            .completed
            .iter()
            .filter_map(|name| {
                self.linker
                    .scope
                    .library(name)
                    .map(|library| (name.clone(), library.runtime_dependency_names()))
            })
            .collect();
        self.handles.register_dependency_edges(edges)?;
        Ok(handle)
    }

    /// Abandon a transaction and re-arm its drive loop with the rollback.
    ///
    /// Returns the table range the driver must null, when the transaction made
    /// slots addressable: a `WebAssembly.Table` cannot shrink, so the length
    /// stays and the slots are cleared.
    pub fn abort(&mut self, token: u32) -> DylinkResult<Option<(u64, u64)>> {
        let flow = core::mem::replace(
            &mut self
                .transactions
                .get_mut(&token)
                .ok_or(DylinkError::UnknownTransaction { token })?
                .flow,
            Flow::RollingBack(VecDeque::new()),
        );
        let mut steps: VecDeque<PlanStep> = VecDeque::new();
        let mut range = None;
        match flow {
            Flow::Load(mut flow) => {
                let end = self.linker.scope.table_length();
                if end > flow.table_growth_start {
                    range = Some((flow.table_growth_start, end - flow.table_growth_start));
                }
                // Innermost frame first: each plan restores the scope as it was
                // when it began, which already includes the dependencies below
                // it in the stack.
                while let Some(frame) = flow.frames.pop() {
                    if let Some(plan) = frame.plan {
                        for request in plan.rollback(&mut self.linker) {
                            steps.push_back(PlanStep::Host(request));
                        }
                    }
                }
                // Dependencies this transaction had already finished are not
                // covered by any surviving plan snapshot, so they are unloaded
                // the same way `dlclose` unloads them.
                for name in flow.completed.iter().rev() {
                    self.plan_release(name, &mut steps)?;
                }
            }
            // A query or an unload has taken nothing it can give back, and an
            // archive transaction abandoned before its generation was published
            // left the previous image reachable and complete.
            Flow::Sym(_) | Flow::Close(_) | Flow::Read(_) | Flow::Sync(_) => {}
            Flow::RollingBack(queue) => steps = queue,
        }
        let transaction = self.transaction(token)?;
        transaction.flow = Flow::RollingBack(steps);
        transaction.awaiting = None;
        Ok(range)
    }

    /// Forget a transaction whose rollback has drained.
    pub fn discard(&mut self, token: u32) {
        self.transactions.remove(&token);
    }

    // -----------------------------------------------------------------------
    // dlsym
    // -----------------------------------------------------------------------

    /// Begin a `dlsym`. Drive the returned token, then read
    /// [`Session::sym_result`].
    ///
    /// This is a transaction rather than a plain call because a resolved
    /// function may have no table slot yet, and taking one is a table mutation
    /// only the driver can perform.
    pub fn sym_begin(&mut self, handle: u32, name: &str) -> DylinkResult<u32> {
        let token = self.allocate_token()?;
        let mut flow = SymFlow {
            address: None,
            slot_for: None,
            queue: VecDeque::new(),
            finished: false,
        };
        let resolved = self.resolve_symbol(handle, name)?;
        if let Some(symbol) = resolved {
            self.record_constructor_provider(symbol.owner.as_deref());
            match symbol.value {
                SymbolValue::Data { address, .. } => {
                    flow.address = Some(address);
                    flow.finished = true;
                }
                SymbolValue::Func { instance, export } => {
                    match self.linker.scope.function_table_index(instance, &export) {
                        Some(index) => {
                            flow.address = Some(index);
                            flow.finished = true;
                        }
                        None => {
                            // No slot yet. `dylink.ts:4037-4067` found one by
                            // scanning the table for JS `Function` identity;
                            // the scope's `(instance, export)` map is the same
                            // answer without an engine object to compare.
                            flow.slot_for = Some((instance, export));
                            flow.queue
                                .push_back(PlanStep::Act(LinkAct::GrowTable { delta: 1 }));
                        }
                    }
                }
            }
        } else {
            flow.finished = true;
            self.handles
                .set_error(alloc::format!("symbol not found: {name}"));
        }
        self.transactions
            .insert(token, Transaction { awaiting: None, flow: Flow::Sym(flow) });
        Ok(token)
    }

    /// The resolved address, or `None` for a miss. Consumes the transaction.
    pub fn sym_result(&mut self, token: u32) -> DylinkResult<Option<u64>> {
        let transaction = self
            .transactions
            .remove(&token)
            .ok_or(DylinkError::UnknownTransaction { token })?;
        let Flow::Sym(flow) = transaction.flow else {
            return Err(DylinkError::UnexpectedActSequence);
        };
        if !flow.finished {
            return Err(DylinkError::UnexpectedActSequence);
        }
        Ok(flow.address)
    }

    /// `dlsym`'s lookup order, which is ELF's: the process-global scope first
    /// (interposition), then the requesting object's own dependency closure.
    fn resolve_symbol(&self, handle: u32, name: &str) -> DylinkResult<Option<ResolvedSymbol>> {
        if is_fork_runtime_export(name) {
            // Activation-control machinery, not an ELF-visible symbol.
            return Ok(None);
        }
        if handle == MAIN_PROGRAM_HANDLE || handle == 0 {
            return Ok(self.linker.scope.global_symbol(name).cloned());
        }
        let library = self
            .handles
            .library_for(handle)
            .ok_or(DylinkError::InvalidHandle { handle })?
            .to_string();
        let roots = [library.clone()];
        let scope = self.linker.scope.dependency_scope(&library, &roots)?;
        Ok(self.linker.scope.scoped_symbol(&scope, name))
    }

    /// Record that the object whose constructors are running captured a symbol
    /// from `owner`.
    ///
    /// A constructor-time `dlsym` is a lifetime edge nothing else records: the
    /// consumer's `DT_NEEDED` list does not name the provider, so a fork child
    /// rebuilding from `dylink.0` alone could unload it out from under the
    /// consumer. Ports `recordConstructorProvider` (`dylink.ts:4069-4086`).
    fn record_constructor_provider(&mut self, owner: Option<&str>) {
        let Some(owner) = owner else { return };
        let consumer = self.transactions.values().rev().find_map(|transaction| {
            match &transaction.flow {
                Flow::Load(flow) => flow.constructing.clone(),
                _ => None,
            }
        });
        let Some(consumer) = consumer else { return };
        if consumer == owner {
            return;
        }
        if let Some(library) = self.linker.scope.library_mut(&consumer) {
            library.provider_dependencies.insert(String::from(owner));
        }
    }

    // -----------------------------------------------------------------------
    // dlclose
    // -----------------------------------------------------------------------

    /// Begin a `dlclose`. Drive the returned token, then read
    /// [`Session::close_result`].
    pub fn close_begin(&mut self, handle: u32) -> DylinkResult<u32> {
        let token = self.allocate_token()?;
        let outcome = self.handles.close(handle)?;
        let mut queue = VecDeque::new();
        if let CloseOutcome::Released { library } = &outcome {
            let library = library.clone();
            self.plan_release(&library, &mut queue)?;
            self.plan_got_refresh(&mut queue)?;
        }
        self.transactions.insert(
            token,
            Transaction {
                awaiting: None,
                flow: Flow::Close(CloseFlow { outcome, queue, finished: false }),
            },
        );
        Ok(token)
    }

    /// What the `dlclose` did. Consumes the transaction.
    pub fn close_result(&mut self, token: u32) -> DylinkResult<CloseOutcome> {
        let transaction = self
            .transactions
            .remove(&token)
            .ok_or(DylinkError::UnknownTransaction { token })?;
        let Flow::Close(flow) = transaction.flow else {
            return Err(DylinkError::UnexpectedActSequence);
        };
        if !flow.finished {
            return Err(DylinkError::UnexpectedActSequence);
        }
        Ok(flow.outcome)
    }

    /// Unload `root` and everything that becomes unretained behind it.
    ///
    /// Ports `releaseUnretainedLibrary` (`dylink.ts:3886-3936`), including its
    /// ordering rule: the consumer leaves the live closure BEFORE its providers
    /// are considered, so a recursive `DT_NEEDED` chain sees the exact
    /// remaining set rather than a half-updated one.
    fn plan_release(&mut self, root: &str, steps: &mut VecDeque<PlanStep>) -> DylinkResult<()> {
        let mut pending: Vec<String> = alloc::vec![String::from(root)];
        while let Some(name) = pending.pop() {
            if !self.handles.is_unloadable(&name) {
                continue;
            }
            let Some(library) = self.linker.scope.library(&name) else {
                continue;
            };
            let dependencies = library.runtime_dependency_names();
            let activation = library.activation_id;
            let allocations = library.allocations.clone();
            let table_entries: Vec<u64> = library.owned_table_entries.iter().copied().collect();

            // Clear the slots this object owned. Retaining a callable whose
            // activation recipe has left the archive would keep a GC root the
            // fork engine can no longer reconstruct.
            for index in &table_entries {
                steps.push_back(PlanStep::Act(LinkAct::WriteTable {
                    index: *index,
                    value: TableValue::Null,
                }));
            }
            for (first, length) in contiguous_runs(&table_entries) {
                steps.push_back(PlanStep::Host(HostRequest::JournalTableMutation {
                    first_index: first,
                    length,
                }));
            }
            if let Some(activation) = activation {
                steps.push_back(PlanStep::Host(HostRequest::UnregisterActivation {
                    library: name.clone(),
                    activation,
                }));
            }
            for allocation in allocations.iter().rev() {
                steps.push_back(PlanStep::Host(HostRequest::ReleaseMapping {
                    library: name.clone(),
                    allocation: allocation.clone(),
                }));
            }

            self.linker.scope.release(&name);
            self.handles
                .release_dependency_edges(&name, dependencies.iter().cloned())?;
            for dependency in dependencies {
                pending.push(dependency);
            }
        }
        Ok(())
    }

    /// Recompute every shared GOT cell against the current global scope and
    /// emit one write per ACTUAL change.
    fn plan_got_refresh(&mut self, steps: &mut VecDeque<PlanStep>) -> DylinkResult<()> {
        let width = self.linker.config.pointer_width;
        let policy = self.linker.config.unresolved_policy;
        let scope = &self.linker.scope;
        let updates = refresh_shared_cells(
            &self.linker.got,
            width,
            policy,
            |symbol| scope.global_symbol(symbol).cloned(),
            |value| match value {
                SymbolValue::Func { instance, export } => {
                    scope.function_table_index(*instance, export)
                }
                SymbolValue::Data { .. } => None,
            },
            // Weakness is a property of the importing module's `dylink.0`, and
            // an unload removes the object that declared it. Treating a cell
            // whose declarer is gone as strong keeps its last good value rather
            // than zeroing a pointer the guest may still hold.
            |_, _| false,
        )?;
        for (symbol, value) in updates {
            let Some(cell) = self.linker.got.shared_cell(&symbol) else {
                continue;
            };
            let global = cell.global;
            steps.push_back(PlanStep::Act(LinkAct::WriteGlobal { global, value }));
            self.linker.got.set_shared_value(&symbol, value);
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // The drive loop
    // -----------------------------------------------------------------------

    /// What the driver must do next for `token`.
    pub fn step(&mut self, token: u32) -> DylinkResult<PlanStep> {
        if self.transaction(token)?.awaiting.is_some() {
            return Err(DylinkError::UnexpectedActSequence);
        }
        loop {
            // The flow is taken out for the duration of one iteration so the
            // session's other fields stay borrowable; every path puts it back.
            let mut flow = core::mem::replace(
                &mut self.transaction(token)?.flow,
                Flow::RollingBack(VecDeque::new()),
            );
            let outcome = self.advance(&mut flow);
            self.transaction(token)?.flow = flow;
            match outcome? {
                Advance::Emit(step, awaiting) => {
                    self.transaction(token)?.awaiting = Some(awaiting);
                    return Ok(step);
                }
                Advance::Finished => return Ok(PlanStep::Finished),
                Advance::Again => {}
            }
        }
    }

    /// Feed the driver's answer back in.
    pub fn resume(&mut self, token: u32, result: ActResult) -> DylinkResult<()> {
        let awaiting = self
            .transaction(token)?
            .awaiting
            .take()
            .ok_or(DylinkError::UnexpectedActSequence)?;
        let mut flow = core::mem::replace(
            &mut self.transaction(token)?.flow,
            Flow::RollingBack(VecDeque::new()),
        );
        let outcome = self.accept(awaiting, &mut flow, result);
        self.transaction(token)?.flow = flow;
        outcome
    }

    fn advance(&mut self, flow: &mut Flow) -> DylinkResult<Advance> {
        match flow {
            Flow::RollingBack(queue) => Ok(match queue.pop_front() {
                Some(step) => Advance::Emit(step, Awaiting::SessionDone),
                None => Advance::Finished,
            }),
            Flow::Sym(sym) => {
                if let Some(step) = sym.queue.pop_front() {
                    let awaiting = match &step {
                        PlanStep::Act(LinkAct::GrowTable { .. }) => Awaiting::SessionIndex,
                        _ => Awaiting::SessionDone,
                    };
                    return Ok(Advance::Emit(step, awaiting));
                }
                sym.finished = true;
                Ok(Advance::Finished)
            }
            Flow::Close(close) => {
                if let Some(step) = close.queue.pop_front() {
                    return Ok(Advance::Emit(step, Awaiting::SessionDone));
                }
                close.finished = true;
                Ok(Advance::Finished)
            }
            Flow::Sync(sync) => Ok(match sync.step()? {
                Some((step, allocating)) => Advance::Emit(
                    step,
                    if allocating { Awaiting::SessionAllocate } else { Awaiting::SessionDone },
                ),
                None => Advance::Finished,
            }),
            Flow::Read(read) => Ok(match read.walk.next_range() {
                Some((address, length)) => Advance::Emit(
                    PlanStep::Host(HostRequest::ReadArchive { address, length }),
                    Awaiting::SessionBytes,
                ),
                None => {
                    read.finished = true;
                    Advance::Finished
                }
            }),
            Flow::Load(load) => self.advance_load(load),
        }
    }

    fn advance_load(&mut self, load: &mut LoadFlow) -> DylinkResult<Advance> {
        if let Some(step) = load.queue.pop_front() {
            return Ok(Advance::Emit(step, Awaiting::SessionDone));
        }
        if load.frames.is_empty() {
            if let Some(request) = load.pending_roots.pop_front() {
                if self.linker.scope.contains(&request.name) {
                    // Already rebuilt, by this reconcile or by a peer worker
                    // that got there first. Its identity was verified when the
                    // reconcile was admitted.
                    return Ok(Advance::Again);
                }
                load.frames.push(Frame::new(request)?);
                return Ok(Advance::Again);
            }
            if !load.commit_planned {
                load.commit_planned = true;
                self.plan_commit(load)?;
                return Ok(Advance::Again);
            }
            load.finished = true;
            return Ok(Advance::Finished);
        }
        let last = load.frames.len() - 1;

        if load.frames[last].plan.is_none() {
            // Resolving phase: every `DT_NEEDED` object must be in scope before
            // this one can be planned, because a missing dependency in a fork
            // child would take fresh addresses and corrupt copied relocations.
            //
            // A search already in flight continues with its next candidate. The
            // list is exhausted only when nothing supplied the object, which is
            // the load's failure and not a silent skip.
            if let Some(dependency) = load.frames[last].current.clone() {
                let Some(path) = load.frames[last].candidates.pop_front() else {
                    return Err(DylinkError::DependencyNotFound {
                        library: load.frames[last].request.name.clone(),
                        dependency,
                    });
                };
                load.frames[last].current_path = Some(path.clone());
                return Ok(Advance::Emit(
                    PlanStep::Host(HostRequest::ReadDependency {
                        library: dependency,
                        path,
                    }),
                    Awaiting::Dependency,
                ));
            }
            while let Some(dependency) = load.frames[last].needed.pop_front() {
                if self.linker.scope.contains(&dependency) {
                    continue;
                }
                if let Some(replay) = self.replay_modules.get(&dependency) {
                    // A reconcile supplies the image and the parent's exact
                    // layout, so no search happens at all.
                    let borrowed = load.frames[last].request.borrowed_memory;
                    let request = replay_request(&dependency, replay, borrowed);
                    load.frames.push(Frame::new(request)?);
                    return Ok(Advance::Again);
                }
                let requester = load.frames[last].request.name.clone();
                load.frames[last].candidates =
                    self.candidate_paths(&dependency, &requester).into_iter().collect();
                load.frames[last].current = Some(dependency);
                return Ok(Advance::Again);
            }
            let request = load.frames[last].request.clone();
            let plan = LinkPlan::begin(&mut self.linker, request)?;
            load.frames[last].plan = Some(plan);
        }

        let plan = load.frames[last].plan.as_mut().expect("plan installed above");
        match plan.step(&mut self.linker)? {
            PlanStep::Finished => {
                let plan = load.frames[last].plan.take().expect("plan installed above");
                let library = plan.finish(&self.linker)?;
                load.completed.push(library.name.clone());
                load.constructing = None;
                load.frames.pop();
                Ok(Advance::Again)
            }
            step @ PlanStep::Call(_) => {
                if let PlanStep::Call(call) = &step {
                    if call.stage == InitializationStage::Constructors {
                        load.constructing = Some(call.library.clone());
                    }
                }
                Ok(Advance::Emit(step, Awaiting::Plan))
            }
            step => Ok(Advance::Emit(step, Awaiting::Plan)),
        }
    }

    /// The work a completed load owes the process before it has a handle:
    /// promote the root's closure when the `dlopen` was `RTLD_GLOBAL`, and
    /// republish the shared GOT cells that promotion changed.
    fn plan_commit(&mut self, load: &mut LoadFlow) -> DylinkResult<()> {
        if !load.global_visibility {
            return Ok(());
        }
        if !self.linker.scope.contains(&load.root) {
            return Ok(());
        }
        self.linker.scope.promote_library_global(&load.root)?;
        if let Some(library) = self.linker.scope.library_mut(&load.root) {
            library.committed_global_root = true;
        }
        self.plan_got_refresh(&mut load.queue)
    }

    fn accept(&mut self, awaiting: Awaiting, flow: &mut Flow, result: ActResult) -> DylinkResult<()> {
        match awaiting {
            Awaiting::SessionDone => result.expect_done(),
            Awaiting::SessionAllocate => {
                let address = result.expect_index()?;
                let Flow::Sync(sync) = flow else {
                    return Err(DylinkError::UnexpectedActSequence);
                };
                sync.accept_allocation(address)
            }
            Awaiting::SessionBytes => {
                let bytes = result
                    .expect_bytes()?
                    // A range the walker asked for is one the archive's own
                    // pointers named. "Not there" is a corrupt archive, not a
                    // miss to try somewhere else.
                    .ok_or(DylinkError::MalformedModule("archive range is unreadable"))?;
                let Flow::Read(read) = flow else {
                    return Err(DylinkError::UnexpectedActSequence);
                };
                read.walk
                    .supply(bytes)
                    .map_err(|_| DylinkError::MalformedModule("malformed process archive"))
            }
            Awaiting::SessionIndex => {
                let index = result.expect_index()?;
                let Flow::Sym(sym) = flow else {
                    return Err(DylinkError::UnexpectedActSequence);
                };
                let (instance, export) = sym
                    .slot_for
                    .clone()
                    .ok_or(DylinkError::UnexpectedActSequence)?;
                sym.queue.push_back(PlanStep::Act(LinkAct::WriteTable {
                    index,
                    value: TableValue::Export { instance, name: export.clone() },
                }));
                sym.queue
                    .push_back(PlanStep::Host(HostRequest::JournalTableMutation {
                        first_index: index,
                        length: 1,
                    }));
                self.linker.scope.record_function_slot(instance, &export, index);
                self.linker
                    .scope
                    .set_table_length(self.linker.scope.table_length().max(index + 1));
                sym.address = Some(index);
                Ok(())
            }
            Awaiting::Plan => {
                let Flow::Load(load) = flow else {
                    return Err(DylinkError::UnexpectedActSequence);
                };
                let frame = load
                    .frames
                    .last_mut()
                    .ok_or(DylinkError::UnexpectedActSequence)?;
                let plan = frame
                    .plan
                    .as_mut()
                    .ok_or(DylinkError::UnexpectedActSequence)?;
                plan.resume(&mut self.linker, result)
            }
            Awaiting::Dependency => {
                let Flow::Load(load) = flow else {
                    return Err(DylinkError::UnexpectedActSequence);
                };
                if load.frames.is_empty() {
                    return Err(DylinkError::UnexpectedActSequence);
                }
                let last = load.frames.len() - 1;
                let dependency = load.frames[last]
                    .current
                    .clone()
                    .ok_or(DylinkError::UnexpectedActSequence)?;
                // A miss leaves `current` set, so the next `step` tries the next
                // candidate. Only an exhausted list fails the load.
                let Some(bytes) = result.expect_bytes()? else {
                    load.frames[last].current_path = None;
                    return Ok(());
                };
                if let Some(path) = load.frames[last].current_path.take() {
                    self.record_resolved_path(&dependency, &path);
                }
                load.frames[last].current = None;
                load.frames[last].candidates.clear();
                // ELF gives a dependency the visibility of the object that
                // pulled it in: a `RTLD_LOCAL` consumer must not publish its
                // providers into the process-global scope.
                let visibility = load.frames[last].request.global_visibility;
                let request = LoadRequest::new(dependency, bytes).visibility(visibility);
                load.frames.push(Frame::new(request)?);
                Ok(())
            }
        }
    }

    /// The search-path candidates for one `DT_NEEDED` name, in order.
    ///
    /// An absolute name is taken as given. Otherwise the requesting object's
    /// own directory comes first — which is what makes a private directory of
    /// shared objects work with no search-path entry — then the bare name, then
    /// the configured defaults.
    fn candidate_paths(&self, dependency: &str, requester: &str) -> Vec<String> {
        let mut candidates: Vec<String> = Vec::new();
        let mut add = |candidate: String| {
            if !candidates.contains(&candidate) {
                candidates.push(candidate);
            }
        };
        if dependency.starts_with('/') {
            add(String::from(dependency));
            return candidates;
        }
        let requester_path = self
            .resolved_paths
            .get(requester)
            .cloned()
            .unwrap_or_else(|| String::from(requester));
        if let Some(slash) = requester_path.rfind('/') {
            let directory = if slash == 0 { "/" } else { &requester_path[..slash] };
            add(if directory == "/" {
                alloc::format!("/{dependency}")
            } else {
                alloc::format!("{directory}/{dependency}")
            });
        }
        add(String::from(dependency));
        for base in &self.linker.config.library_search_paths {
            let base = base.trim_end_matches('/');
            add(alloc::format!("{base}/{dependency}"));
        }
        candidates
    }

    /// Remember where a dependency was found, so its own siblings resolve
    /// beside it.
    pub fn record_resolved_path(&mut self, dependency: &str, path: &str) {
        self.resolved_paths
            .insert(String::from(dependency), String::from(path));
    }

    // -----------------------------------------------------------------------
    // Fork state
    // -----------------------------------------------------------------------

    /// Where the driver published the staged `() -> ()` entry the last
    /// [`PlanStep::Call`] named.
    ///
    /// The slot is an engine fact only the driver has, and a fork child needs
    /// it to resume an interrupted `dlopen` at the exact continuation point the
    /// parent stopped at.
    pub fn note_staged_slot(&mut self, token: u32, table_index: u64) -> DylinkResult<()> {
        let transaction = self.transaction(token)?;
        let Flow::Load(load) = &mut transaction.flow else {
            return Err(DylinkError::UnexpectedActSequence);
        };
        load.staged_slot = Some(table_index);
        Ok(())
    }

    /// The loader state a fork child must be able to rebuild this process from.
    ///
    /// This is the linker's half of the archive: every live object with its
    /// exact layout and image, every staged transaction still in flight, and
    /// the handle allocator's position. The table-state fields belong to the
    /// activation coordinator that publishes funcref patches, so they are left
    /// at zero here rather than guessed at.
    pub fn fork_state(&self) -> DylinkResult<DylinkArchive> {
        let mut modules = Vec::new();
        for library in self.linker.scope.libraries() {
            let handle = self.handles.handle_for(&library.name);
            let ref_count = handle.and_then(|handle| self.handles.reference_count(handle));
            modules.push(DylinkModule {
                name: library.name.clone(),
                module_bytes: library.module_bytes.clone(),
                digest: dylink_module_template_digest(&library.module_bytes),
                memory_base: library.memory_base,
                table_base: library.table_base,
                tls_base: library.tls_base,
                activation_id: library.activation_id,
                handle,
                ref_count,
                global_visibility: library.global_visibility,
                committed_global_root: library.committed_global_root,
                provider_dependencies: library.provider_dependencies.iter().cloned().collect(),
                allocations: library.allocations.clone(),
                initialization: self.initialization_for(&library.name),
            });
        }
        let mut transactions = Vec::new();
        for (token, transaction) in &self.transactions {
            let Flow::Load(load) = &transaction.flow else {
                continue;
            };
            if load.replay || load.finished {
                continue;
            }
            let Some(frame) = load.frames.first() else {
                continue;
            };
            transactions.push(DylinkTransaction {
                token: *token,
                name: load.root.clone(),
                module_bytes: frame.request.module_bytes.clone(),
                digest: dylink_module_template_digest(&frame.request.module_bytes),
                global_visibility: load.global_visibility,
            });
        }
        Ok(DylinkArchive {
            pointer_width: u8::try_from(self.linker.config.pointer_width.bytes())
                .map_err(|_| DylinkError::MalformedModule("invalid pointer width"))?,
            generation: 0,
            next_handle: u64::from(self.handles.next_handle()),
            table_state_root: 0,
            table_checkpoint_generation: 0,
            modules,
            transactions,
            table_patches: Vec::new(),
        })
    }

    /// The continuation record for an object whose initialization is suspended
    /// inside a live transaction.
    fn initialization_for(&self, library: &str) -> Option<DylinkInitialization> {
        for (token, transaction) in &self.transactions {
            let Flow::Load(load) = &transaction.flow else {
                continue;
            };
            let (Some(constructing), Some(table_index)) =
                (load.constructing.as_deref(), load.staged_slot)
            else {
                continue;
            };
            if constructing != library {
                continue;
            }
            return Some(DylinkInitialization {
                transaction_token: *token,
                // `constructing` is only ever set for the constructors stage;
                // the earlier stages run before the object is in scope, so
                // there is nothing to attach a record to.
                stage: DylinkInitializationStage::Constructors,
                table_index,
            });
        }
        None
    }

    /// Adopt a parent's archive: rebuild every object it names that this
    /// session does not already have, in the archive's dependency-first order.
    ///
    /// Ports `reconcileForkModules` (`dylink.ts:2728`). An object already
    /// present — because a pthread peer in this process rebuilt it first — is
    /// VERIFIED against the record rather than skipped, so a child that
    /// disagrees with its own archive fails loudly instead of running on two
    /// different layouts for one name.
    pub fn fork_reconcile_begin(
        &mut self,
        archive: &DylinkArchive,
        ownership: MemoryOwnership,
    ) -> DylinkResult<u32> {
        let borrowed = ownership == MemoryOwnership::Borrowed;
        self.replay_modules.clear();
        for module in &archive.modules {
            self.replay_modules.insert(
                module.name.clone(),
                ReplayModule {
                    module_bytes: module.module_bytes.clone(),
                    inputs: ReplayInputs::from_archive(module),
                    handle: module.handle,
                    ref_count: module.ref_count.unwrap_or(0),
                },
            );
        }
        let mut pending_roots = VecDeque::new();
        for module in &archive.modules {
            if self.linker.scope.contains(&module.name) {
                self.require_matching_identity(module)?;
                continue;
            }
            let replay = self
                .replay_modules
                .get(&module.name)
                .expect("just inserted");
            pending_roots.push_back(replay_request(&module.name, replay, borrowed));
        }
        let token = self.allocate_token()?;
        let table_growth_start = self.linker.scope.table_length();
        let root = archive
            .modules
            .last()
            .map(|module| module.name.clone())
            .unwrap_or_default();
        self.transactions.insert(
            token,
            Transaction {
                awaiting: None,
                flow: Flow::Load(LoadFlow {
                    root,
                    // A replay carries each object's own recorded visibility,
                    // so the transaction must not re-promote a closure the
                    // parent had left local.
                    global_visibility: false,
                    frames: Vec::new(),
                    pending_roots,
                    completed: Vec::new(),
                    queue: VecDeque::new(),
                    constructing: None,
                    staged_slot: None,
                    commit_planned: false,
                    finished: false,
                    table_growth_start,
                    replay: true,
                }),
            },
        );
        Ok(token)
    }

    /// Adopt the parent's handle table once the reconcile's drive loop has
    /// finished. Ports `reconcileForkHandleState` (`dylink.ts:3175`).
    pub fn fork_reconcile_finish(
        &mut self,
        token: u32,
        archive: &DylinkArchive,
    ) -> DylinkResult<()> {
        let transaction = self
            .transactions
            .remove(&token)
            .ok_or(DylinkError::UnknownTransaction { token })?;
        let Flow::Load(flow) = transaction.flow else {
            return Err(DylinkError::UnexpectedActSequence);
        };
        if !flow.finished {
            return Err(DylinkError::UnexpectedActSequence);
        }
        for module in &archive.modules {
            let (Some(handle), Some(references)) = (module.handle, module.ref_count) else {
                continue;
            };
            if self.handles.handle_for(&module.name) == Some(handle) {
                continue;
            }
            // The exact handle value is process state: the guest holds it in
            // copied memory, so a child that allocated a fresh one would answer
            // `dlsym` for a handle the program never received.
            for _ in 0..references.max(1) {
                self.handles.open(&module.name, Some(handle))?;
            }
        }
        let next_handle = u32::try_from(archive.next_handle)
            .map_err(|_| DylinkError::HandleOutOfRange { handle: u32::MAX })?;
        self.handles.set_next_handle(next_handle)?;
        let edges: Vec<(String, BTreeSet<String>)> = self
            .linker
            .scope
            .libraries()
            .map(|library| (library.name.clone(), library.runtime_dependency_names()))
            .collect();
        self.handles.rebuild_dependency_edges(edges)?;
        self.replay_modules.clear();
        Ok(())
    }

    // -----------------------------------------------------------------------
    // The archive in guest memory
    // -----------------------------------------------------------------------

    /// Read the process archive whose header is at `head`.
    ///
    /// `head` of zero is a process that has never published, which decodes to
    /// nothing rather than to an error.
    pub fn archive_read_begin(&mut self, head: u64) -> DylinkResult<u32> {
        let token = self.allocate_token()?;
        let pointer_width = u8::try_from(self.linker.config.pointer_width.bytes())
            .map_err(|_| DylinkError::MalformedModule("invalid pointer width"))?;
        let walk = ArchiveWalk::new(head, pointer_width, self.linker.config.memory_bytes);
        self.transactions.insert(
            token,
            Transaction {
                awaiting: None,
                flow: Flow::Read(ReadFlow { walk, finished: false }),
            },
        );
        Ok(token)
    }

    /// Decode what the read walked, and keep it as this session's view of the
    /// process archive. Consumes the transaction.
    pub fn archive_read_finish(&mut self, token: u32) -> DylinkResult<()> {
        let transaction = self
            .transactions
            .remove(&token)
            .ok_or(DylinkError::UnknownTransaction { token })?;
        let Flow::Read(read) = transaction.flow else {
            return Err(DylinkError::UnexpectedActSequence);
        };
        if !read.finished {
            return Err(DylinkError::UnexpectedActSequence);
        }
        self.archive = read
            .walk
            .finish()
            .map_err(|_| DylinkError::MalformedModule("malformed process archive"))?;
        Ok(())
    }

    /// Publish the loader's current state into the process archive.
    pub fn archive_sync_begin(&mut self) -> DylinkResult<u32> {
        let token = self.allocate_token()?;
        let mut desired = self.fork_state()?;
        desired.generation = next_generation(self.published.generation)?;
        desired.table_state_root = self.table_state_root;
        desired.table_checkpoint_generation = self.table_checkpoint_generation;
        desired.table_patches = self.table_patches.clone();
        let flow = SyncFlow::plan(&self.published, desired)?;
        self.transactions
            .insert(token, Transaction { awaiting: None, flow: Flow::Sync(flow) });
        Ok(token)
    }

    /// The head address and generation the driver must publish, once the sync's
    /// drive loop has drained. Consumes the transaction and adopts its state as
    /// the baseline the next publication diffs against.
    pub fn archive_sync_finish(&mut self, token: u32) -> DylinkResult<(u64, u64)> {
        let transaction = self
            .transactions
            .remove(&token)
            .ok_or(DylinkError::UnknownTransaction { token })?;
        let Flow::Sync(flow) = transaction.flow else {
            return Err(DylinkError::UnexpectedActSequence);
        };
        let published = flow.published()?;
        self.published = flow.committed()?;
        Ok(published)
    }

    /// The archive the last [`Session::archive_read_begin`] decoded.
    pub fn decoded_archive(&self) -> Option<&DylinkArchive> {
        self.archive.as_ref()
    }

    /// Does the decoded archive describe a process that ever loaded anything?
    pub fn archive_is_empty(&self) -> bool {
        match &self.archive {
            Some(archive) => archive.modules.is_empty() && archive.transactions.is_empty(),
            None => true,
        }
    }

    /// The generation of the decoded archive, or zero when there is none.
    pub fn archive_generation(&self) -> u64 {
        self.archive
            .as_ref()
            .map(|archive| archive.generation)
            .unwrap_or(0)
    }

    /// Begin a reconcile against the decoded archive.
    ///
    /// The `&DylinkArchive` form is what a native host calls; this one is for a
    /// driver that had the module read the archive out of guest memory in the
    /// first place, and would otherwise have to carry a second copy of it.
    pub fn reconcile_decoded_begin(&mut self, ownership: MemoryOwnership) -> DylinkResult<u32> {
        let archive = self
            .archive
            .clone()
            .ok_or(DylinkError::MalformedModule("no archive has been read"))?;
        self.fork_reconcile_begin(&archive, ownership)
    }

    /// Adopt the decoded archive's handle table.
    pub fn reconcile_decoded_finish(&mut self, token: u32) -> DylinkResult<()> {
        let archive = self
            .archive
            .clone()
            .ok_or(DylinkError::MalformedModule("no archive has been read"))?;
        // A child adopting a parent's archive inherits its record addresses
        // too: the next publication must diff against what is actually in
        // memory, not start as though nothing had ever been written.
        self.fork_reconcile_finish(token, &archive)
    }

    /// Hand the activation coordinator's funcref table patches to the archive.
    ///
    /// They are not loader state, but they ride in the same record chain and
    /// under the same generation fence, so publishing them is publishing the
    /// archive.
    pub fn set_table_patches(&mut self, patches: Vec<DylinkTablePatch>) {
        self.table_patches = patches;
    }

    /// Append one funcref patch to the journal the next publication carries.
    ///
    /// Returns false when the journal is full, in which case the caller must
    /// take a full table checkpoint instead. The limits are the archive
    /// format's, so the answer is the format's to give: a driver that guessed
    /// them would publish a record the decoder then refuses.
    pub fn append_table_patch(&mut self, patch: DylinkTablePatch) -> bool {
        if !self.can_append_table_patch(&patch) {
            return false;
        }
        self.table_patches.push(patch);
        true
    }

    /// Would [`Session::append_table_patch`] accept this patch?
    pub fn can_append_table_patch(&self, patch: &DylinkTablePatch) -> bool {
        let count = self.table_patches.len() + 1;
        if count > MAX_TABLE_PATCH_RECORDS {
            return false;
        }
        let bytes: usize = self
            .table_patches
            .iter()
            .chain(core::iter::once(patch))
            .map(|patch| TABLE_PATCH_HEADER_BYTES + patch.runs.len() * TABLE_PATCH_RUN_BYTES)
            .sum();
        bytes <= MAX_TABLE_PATCH_BYTES
    }

    /// The archived objects a fork child must name before it reconciles.
    ///
    /// A child builds its activation-to-module map for reference decoding
    /// BEFORE any object is rebuilt, because module and reference recipes name
    /// activation coordinates rather than whichever instance loads first. That
    /// map needs each object's image, and the images live in the archive this
    /// session decoded.
    pub fn archived_modules(&self) -> &[DylinkModule] {
        match &self.archive {
            Some(archive) => &archive.modules,
            None => &[],
        }
    }

    /// The archive's table-replication state: the fence, the sealed snapshot
    /// root, the checkpoint that sealed it, and the patch journal since.
    ///
    /// This is the only part of the archive a driver reads back, because the
    /// funcref table replica is the one consumer that is not the loader. The
    /// modules and transactions never cross the boundary: a reconcile drives
    /// them from inside.
    pub fn table_state(&self) -> (u64, u64, u64, &[DylinkTablePatch]) {
        match &self.archive {
            Some(archive) => (
                archive.generation,
                archive.table_state_root,
                archive.table_checkpoint_generation,
                &archive.table_patches,
            ),
            None => (0, 0, 0, &[]),
        }
    }

    /// Seal a typed table snapshot. Patches published before a checkpoint are
    /// superseded by it, so they are dropped rather than carried forward.
    pub fn set_table_state_root(&mut self, root: u64) -> DylinkResult<()> {
        self.table_state_root = root;
        self.table_checkpoint_generation = next_generation(self.published.generation)?;
        self.table_patches.clear();
        Ok(())
    }

    /// The archive state this process has published, for a child that adopted
    /// the parent's records and must diff against them.
    pub fn adopt_published(&mut self, state: ArchiveState) {
        self.published = state;
    }

    /// A module a peer already rebuilt must agree with the archive record.
    fn require_matching_identity(&self, module: &DylinkModule) -> DylinkResult<()> {
        let Some(library) = self.linker.scope.library(&module.name) else {
            return Ok(());
        };
        let matches = library.memory_base == module.memory_base
            && library.table_base == module.table_base
            && library.tls_base == module.tls_base
            && library.activation_id == module.activation_id
            && library.module_bytes.len() == module.module_bytes.len()
            && dylink_module_template_digest(&library.module_bytes) == module.digest;
        if matches {
            Ok(())
        } else {
            Err(DylinkError::ArchivedAllocationMismatch { library: module.name.clone() })
        }
    }
}

enum Advance {
    /// A step for the driver, and what its answer will be for.
    Emit(PlanStep, Awaiting),
    /// Nothing to emit; consult the machine again.
    Again,
    Finished,
}

impl Frame {
    /// Parse the image's `DT_NEEDED` list up front.
    ///
    /// Eager rather than deferred to the first `step`, so an artifact that is
    /// not a shared library at all is refused by `dlopen` itself. Swallowing
    /// the parse error here and letting `LinkPlan::begin` raise it later would
    /// hand back a live transaction token for a load that can never start.
    fn new(request: LoadRequest) -> DylinkResult<Self> {
        let metadata = parse_dylink_section(&request.module_bytes)?;
        let needed = metadata.needed_dynlibs.iter().cloned().collect();
        Ok(Frame {
            request,
            needed,
            current: None,
            current_path: None,
            candidates: VecDeque::new(),
            plan: None,
        })
    }
}

fn replay_request(name: &str, replay: &ReplayModule, borrowed: bool) -> LoadRequest {
    LoadRequest {
        name: String::from(name),
        module_bytes: replay.module_bytes.clone(),
        global_visibility: replay.inputs.global_visibility,
        replay: Some(replay.inputs.clone()),
        borrowed_memory: borrowed,
    }
}

/// Collapse a sorted index list into `(first, length)` runs, so a journal entry
/// covers a contiguous span instead of one entry per slot.
fn contiguous_runs(indexes: &[u64]) -> Vec<(u64, u64)> {
    let mut runs: Vec<(u64, u64)> = Vec::new();
    for index in indexes {
        match runs.last_mut() {
            Some((first, length)) if *first + *length == *index => *length += 1,
            _ => runs.push((*index, 1)),
        }
    }
    runs
}
