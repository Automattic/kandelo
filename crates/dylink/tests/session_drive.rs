//! The six decisions that kept `host/src/dylink.ts` alive, driven end to end.
//!
//! `plan_drive.rs` proves the planner links ONE object whose dependencies are
//! already in scope. These tests prove the layer around it: dependency
//! resolution, concurrent transactions, `dlsym` address materialization,
//! `dlclose` unload, and the fork capture/reconcile pair.
//!
//! The executor is the same shape as `plan_drive.rs`'s — a recording stand-in
//! for a real engine — because that is the whole claim: a host implements ONE
//! typed executor and gets the loader.

mod support;

use std::collections::BTreeMap;

use dylink::act::{ActResult, GlobalId, InstanceExport, LinkAct, TableValue, WasmValue};
use dylink::error::DylinkError;
use dylink::handles::CloseOutcome;
use dylink::plan::{HostRequest, LinkerConfig, LoadRequest, PlanStep, StagedCall};
use dylink::scope::SymbolValue;
use dylink::session::{MemoryOwnership, Session};
use support::{DylinkSection, Export, Import, SideModule};

/// A recording stand-in for a real engine, plus the process filesystem the
/// session asks about.
#[derive(Default)]
struct Executor {
    acts: Vec<LinkAct>,
    hosts: Vec<HostRequest>,
    calls: Vec<StagedCall>,
    table_length: u64,
    memory_cursor: u64,
    globals: BTreeMap<GlobalId, WasmValue>,
    table: BTreeMap<u64, TableValue>,
    /// What `ReadExports` reports, per instance index.
    exports: BTreeMap<u32, Vec<InstanceExport>>,
    /// The process filesystem: absolute path to `.so` image.
    files: BTreeMap<String, Vec<u8>>,
    /// Every path the session asked about, in order. This is the search order,
    /// recorded so it can be asserted rather than assumed.
    probed: Vec<String>,
    next_activation: u32,
    released: Vec<u64>,
    /// The parent's saved `GOT.func` indexes, as the activation coordinator
    /// would report them during a fork replay.
    saved_got_func: BTreeMap<String, u32>,
}

impl Executor {
    fn new(table_length: u64, memory_cursor: u64) -> Self {
        Executor {
            table_length,
            memory_cursor,
            next_activation: 1,
            ..Default::default()
        }
    }

    fn perform(&mut self, act: LinkAct) -> ActResult {
        self.acts.push(act.clone());
        match act {
            LinkAct::Compile { .. } => ActResult::Done,
            LinkAct::NewGlobal { global, init, .. } => {
                self.globals.insert(global, init);
                ActResult::Done
            }
            LinkAct::ReadGlobal { global } => ActResult::Value(
                self.globals.get(&global).copied().unwrap_or(WasmValue::I32(0)),
            ),
            LinkAct::WriteGlobal { global, value } => {
                self.globals.insert(global, value);
                ActResult::Done
            }
            LinkAct::GrowTable { delta } => {
                let previous = self.table_length;
                self.table_length += delta;
                ActResult::Index(previous)
            }
            LinkAct::WriteTable { index, value } => {
                self.table.insert(index, value);
                ActResult::Done
            }
            LinkAct::GrowMemory { .. } | LinkAct::NewTag { .. } | LinkAct::Instantiate { .. } => {
                ActResult::Done
            }
            LinkAct::ReadExports { instance } => ActResult::Exports(
                self.exports.get(&instance.index()).cloned().unwrap_or_default(),
            ),
            LinkAct::ZeroMemory { .. } => ActResult::Done,
        }
    }

    fn perform_host(&mut self, request: HostRequest) -> ActResult {
        self.hosts.push(request.clone());
        match request {
            HostRequest::AllocateMemory { size, align, .. } => {
                let aligned = self.memory_cursor.next_multiple_of(align.max(1));
                self.memory_cursor = aligned + size;
                ActResult::Index(aligned)
            }
            HostRequest::PrepareActivation { replay_activation_id, .. } => {
                let activation = replay_activation_id.unwrap_or_else(|| {
                    let next = self.next_activation;
                    self.next_activation += 1;
                    next
                });
                ActResult::Index(u64::from(activation))
            }
            HostRequest::ReadDependency { path, .. } => {
                self.probed.push(path.clone());
                ActResult::Bytes(self.files.get(&path).cloned())
            }
            HostRequest::ReleaseMapping { allocation, .. } => {
                self.released.push(allocation.address);
                ActResult::Done
            }
            HostRequest::SavedGotFunc { symbol, .. } => ActResult::Value(WasmValue::I32(
                self.saved_got_func.get(&symbol).copied().unwrap_or(0),
            )),
            _ => ActResult::Done,
        }
    }

    /// Drive one transaction to `Finished`.
    fn drive(&mut self, session: &mut Session, token: u32) -> Result<(), DylinkError> {
        loop {
            let result = match session.step(token)? {
                PlanStep::Finished => return Ok(()),
                PlanStep::Act(act) => self.perform(act),
                PlanStep::Host(request) => self.perform_host(request),
                PlanStep::Call(call) => {
                    self.calls.push(call);
                    ActResult::Done
                }
            };
            session.resume(token, result)?;
        }
    }
}

fn process_session() -> Session {
    Session::new(LinkerConfig {
        memory_bytes: 1 << 20,
        library_search_paths: vec![
            String::from("/lib"),
            String::from("/usr/lib"),
            String::from("/usr/local/lib"),
        ],
        ..LinkerConfig::default()
    })
}

/// A side module with no dependencies, exporting `symbol` as a function.
fn leaf(symbol: &str) -> Vec<u8> {
    SideModule {
        dylink: DylinkSection {
            memory_size: 64,
            memory_align: 4,
            table_size: 1,
            table_align: 0,
            ..Default::default()
        },
        imports: vec![
            Import::Memory { module: "env".into(), field: "memory".into() },
            Import::immutable_global("env", "__memory_base"),
            Import::immutable_global("env", "__table_base"),
        ],
        exports: vec![Export::func(symbol, 0)],
        ..Default::default()
    }
    .encode()
}

/// A side module that declares `DT_NEEDED` on `needed`.
fn consumer(symbol: &str, needed: &[&str]) -> Vec<u8> {
    SideModule {
        dylink: DylinkSection {
            memory_size: 64,
            memory_align: 4,
            table_size: 1,
            table_align: 0,
            needed: needed.iter().map(|name| String::from(*name)).collect(),
            ..Default::default()
        },
        imports: vec![
            Import::Memory { module: "env".into(), field: "memory".into() },
            Import::immutable_global("env", "__memory_base"),
            Import::immutable_global("env", "__table_base"),
        ],
        exports: vec![Export::func(symbol, 0)],
        ..Default::default()
    }
    .encode()
}

fn load(
    session: &mut Session,
    executor: &mut Executor,
    request: LoadRequest,
) -> Result<u32, DylinkError> {
    let token = session.open_begin(request)?;
    executor.drive(session, token)?;
    session.open_finish(token, None)
}

// ---------------------------------------------------------------------------
// 1. DT_NEEDED resolution
// ---------------------------------------------------------------------------

/// The session resolves the dependency itself. The driver is asked for one
/// named path at a time and decides nothing.
#[test]
fn a_dt_needed_dependency_is_fetched_and_linked_before_its_consumer() {
    let mut session = process_session();
    let mut executor = Executor::new(0, 0x1000);
    executor.exports.insert(1, vec![InstanceExport::func("leaf_value")]);
    executor.exports.insert(2, vec![InstanceExport::func("top")]);
    executor
        .files
        .insert(String::from("/usr/lib/libleaf.so"), leaf("leaf_value"));

    let handle = load(
        &mut session,
        &mut executor,
        LoadRequest::new("libtop.so", consumer("top", &["libleaf.so"])),
    )
    .expect("the consumer loads once its dependency is in scope");

    assert!(handle > 1, "the root gets a real handle: {handle}");
    assert!(
        session.linker.scope.contains("libleaf.so"),
        "the dependency is in scope",
    );
    // Dependency-first: the leaf took instance 1 because it was linked first.
    assert_eq!(
        session.linker.scope.library("libleaf.so").expect("leaf").instance.index(),
        1,
    );
    assert_eq!(
        session.linker.scope.library("libtop.so").expect("top").instance.index(),
        2,
    );
}

/// The search order is the loader's, and it is the ELF one: the requesting
/// object's own directory, the bare name, then the configured defaults. Recorded
/// as an assertion because a driver that chose the candidates would be making
/// this decision instead.
#[test]
fn the_search_order_is_the_sessions_and_stops_at_the_first_hit() {
    let mut session = process_session();
    let mut executor = Executor::new(0, 0x1000);
    executor.exports.insert(1, vec![InstanceExport::func("leaf_value")]);
    executor.exports.insert(2, vec![InstanceExport::func("top")]);
    executor
        .files
        .insert(String::from("/usr/local/lib/libleaf.so"), leaf("leaf_value"));

    load(
        &mut session,
        &mut executor,
        LoadRequest::new("libtop.so", consumer("top", &["libleaf.so"])),
    )
    .expect("load");

    assert_eq!(
        executor.probed,
        vec![
            // No `/` in the requester name, so no sibling directory to try.
            "libleaf.so",
            "/lib/libleaf.so",
            "/usr/lib/libleaf.so",
            "/usr/local/lib/libleaf.so",
        ],
        "the session tries every candidate in order and stops at the hit",
    );
}

/// A dependency that is nowhere is a NAMED failure, not a silently skipped
/// object whose symbols would then be undefined at instantiation.
#[test]
fn an_unfindable_dependency_names_itself() {
    let mut session = process_session();
    let mut executor = Executor::new(0, 0x1000);

    let token = session
        .open_begin(LoadRequest::new("libtop.so", consumer("top", &["libmissing.so"])))
        .expect("begin");
    let error = executor.drive(&mut session, token).expect_err("must fail");
    assert!(
        matches!(
            &error,
            DylinkError::DependencyNotFound { library, dependency }
                if library == "libtop.so" && dependency == "libmissing.so"
        ),
        "got {error:?}",
    );
}

/// A dependency already in scope is not re-fetched. Loading it twice would
/// choose a second layout for one object.
#[test]
fn a_dependency_already_in_scope_is_not_searched_for() {
    let mut session = process_session();
    let mut executor = Executor::new(0, 0x1000);
    executor.exports.insert(1, vec![InstanceExport::func("leaf_value")]);
    executor.exports.insert(2, vec![InstanceExport::func("top")]);

    load(&mut session, &mut executor, LoadRequest::new("libleaf.so", leaf("leaf_value")))
        .expect("leaf loads directly");
    executor.probed.clear();

    load(
        &mut session,
        &mut executor,
        LoadRequest::new("libtop.so", consumer("top", &["libleaf.so"])),
    )
    .expect("the consumer finds its dependency in scope");
    assert!(executor.probed.is_empty(), "nothing was searched for: {:?}", executor.probed);
}

// ---------------------------------------------------------------------------
// 3. Concurrent transactions
// ---------------------------------------------------------------------------

/// A constructor calling `dlopen` is legal POSIX. Two transactions can be open
/// at once, each with its own token.
///
/// This is the positive form of the gap `host/test/dylink-planner-drive.test.ts`
/// pinned: the old surface had ONE slot and refused the second begin, which is
/// why `worker-main.ts` kept a map of pending tokens beside it.
#[test]
fn two_loads_can_be_in_flight_at_once() {
    let mut session = process_session();
    let mut executor = Executor::new(0, 0x1000);
    executor.exports.insert(1, vec![InstanceExport::func("a")]);
    executor.exports.insert(2, vec![InstanceExport::func("b")]);

    let first = session
        .open_begin(LoadRequest::new("liba.so", leaf("a")))
        .expect("the first load begins");
    let second = session
        .open_begin(LoadRequest::new("libb.so", leaf("b")))
        .expect("a nested load begins rather than being refused");
    assert_ne!(first, second);
    assert!(session.contains(first) && session.contains(second));

    // The inner one completes first, as a constructor-time `dlopen` does.
    executor.drive(&mut session, second).expect("drive inner");
    let inner = session.open_finish(second, None).expect("finish inner");
    executor.drive(&mut session, first).expect("drive outer");
    let outer = session.open_finish(first, None).expect("finish outer");

    assert_ne!(inner, outer, "each load gets its own handle");
    assert!(!session.contains(first) && !session.contains(second));
}

/// A token is not a handle. They come from different counters, and confusing
/// them would hand the program a loader-private value.
#[test]
fn a_token_is_not_a_handle() {
    let mut session = process_session();
    let mut executor = Executor::new(0, 0x1000);
    executor.exports.insert(1, vec![InstanceExport::func("a")]);

    let token = session
        .open_begin(LoadRequest::new("liba.so", leaf("a")))
        .expect("begin");
    executor.drive(&mut session, token).expect("drive");
    let handle = session.open_finish(token, None).expect("finish");
    assert_eq!(token, 1, "tokens start at 1");
    assert_eq!(handle, 2, "handles start above the main-image pseudo-handle");
}

// ---------------------------------------------------------------------------
// 2. dlsym to an address
// ---------------------------------------------------------------------------

/// A resolved function with no table slot gets one, and the acts that take it
/// are ordered by the session rather than improvised by the driver.
///
/// The main image is where this happens in practice: `wasm-ld` puts a function
/// in an element segment only when the program takes its address, so a symbol a
/// side module asks for by `dlsym` may have no index at all yet.
#[test]
fn dlsym_of_an_unslotted_function_takes_a_table_slot_and_journals_it() {
    let mut session = process_session();
    let mut executor = Executor::new(4, 0x1000);
    // Published with NO element slot for `main_helper`, so nothing has taken
    // its address and it has no index.
    session.linker.scope.publish_main_image(
        [(
            String::from("main_helper"),
            SymbolValue::Func {
                instance: dylink::scope::MAIN_INSTANCE,
                export: String::from("main_helper"),
            },
        )],
        [],
        4,
    );

    let token = session.sym_begin(1, "main_helper").expect("sym begins");
    executor.drive(&mut session, token).expect("drive");
    let address = session.sym_result(token).expect("result").expect("a hit");

    assert_eq!(address, 4, "the slot is the table length before the growth");
    assert!(
        matches!(executor.acts.first(), Some(LinkAct::GrowTable { delta: 1 })),
        "the slot is taken by growing the table by one: {:?}",
        executor.acts,
    );
    assert!(
        matches!(
            executor.acts.get(1),
            Some(LinkAct::WriteTable { index, value: TableValue::Export { name, .. } })
                if *index == address && name == "main_helper"
        ),
        "the export is written into the slot the grow reported: {:?}",
        executor.acts,
    );
    assert!(
        executor.hosts.iter().any(|request| matches!(
            request,
            HostRequest::JournalTableMutation { first_index, length }
                if *first_index == address && *length == 1
        )),
        "the mutation is journalled, so fork can rebuild the funcref",
    );

    // The second lookup finds the slot the first one recorded, with no acts at
    // all. `dylink.ts:4037-4067` scanned the whole table for JS `Function`
    // identity on every call.
    let quiet = executor.acts.len();
    let token = session.sym_begin(1, "main_helper").expect("sym begins");
    executor.drive(&mut session, token).expect("drive");
    assert_eq!(session.sym_result(token).expect("result"), Some(address));
    assert_eq!(executor.acts.len(), quiet, "no engine work the second time");
}

/// A side module's own export already has a slot: the load published it. So
/// `dlsym` answers from the map with no engine work at all.
#[test]
fn dlsym_of_a_published_side_module_function_needs_no_engine_work() {
    let mut session = process_session();
    let mut executor = Executor::new(4, 0x1000);
    session.linker.scope.set_table_length(4);
    executor.exports.insert(1, vec![InstanceExport::func("leaf_value")]);

    let handle = load(
        &mut session,
        &mut executor,
        LoadRequest::new("libleaf.so", leaf("leaf_value")),
    )
    .expect("load");

    let before = executor.acts.len();
    let token = session.sym_begin(handle, "leaf_value").expect("sym begins");
    executor.drive(&mut session, token).expect("drive");
    let address = session.sym_result(token).expect("result").expect("a hit");
    assert_eq!(executor.acts.len(), before, "the slot was already recorded");
    assert!(
        session
            .linker
            .scope
            .library("libleaf.so")
            .expect("leaf")
            .owned_table_entries
            .contains(&address),
        "and it is a slot the object owns, so its unload clears it",
    );
}

/// A data symbol answers with its relocated address and takes no table slot.
#[test]
fn dlsym_of_a_data_symbol_answers_with_its_address() {
    let mut session = process_session();
    let mut executor = Executor::new(0, 0x1000);
    session.linker.scope.publish_main_image(
        [(String::from("environ"), SymbolValue::main_data("environ", 0x2000))],
        [],
        4,
    );

    let token = session.sym_begin(1, "environ").expect("sym begins");
    executor.drive(&mut session, token).expect("drive");
    assert_eq!(session.sym_result(token).expect("result"), Some(0x2000));
    assert!(executor.acts.is_empty(), "a data address needs no engine act");
}

/// A miss is a SUCCESSFUL call carrying nothing, with the reason in `dlerror`.
/// Conflating it with a failure would make a legitimately absent weak symbol
/// indistinguishable from a broken lookup.
#[test]
fn a_dlsym_miss_is_an_answer_with_a_dlerror_not_a_failure() {
    let mut session = process_session();
    let mut executor = Executor::new(0, 0x1000);

    let token = session.sym_begin(1, "nowhere").expect("sym begins");
    executor.drive(&mut session, token).expect("drive");
    assert_eq!(session.sym_result(token).expect("result"), None);
    let message = session.handles.take_error().expect("a dlerror message");
    assert!(message.contains("nowhere"), "the message names the symbol: {message}");
}

/// Fork-instrument entry points are activation-control machinery, not
/// ELF-visible symbols, so `dlsym` must not hand one out.
#[test]
fn dlsym_refuses_a_fork_runtime_export() {
    let mut session = process_session();
    let mut executor = Executor::new(0, 0x1000);
    let token = session
        .sym_begin(1, "wpk_fork_module_bootstrap")
        .expect("sym begins");
    executor.drive(&mut session, token).expect("drive");
    assert_eq!(session.sym_result(token).expect("result"), None);
}

// ---------------------------------------------------------------------------
// 6. dlclose unload
// ---------------------------------------------------------------------------

/// The last handle reference releases the object: its table slots are nulled,
/// its mappings released, and the global scope rebuilt without it.
#[test]
fn dlclose_of_the_last_reference_unloads_and_clears_its_slots() {
    let mut session = process_session();
    let mut executor = Executor::new(4, 0x1000);
    session.linker.scope.set_table_length(4);
    executor.exports.insert(1, vec![InstanceExport::func("leaf_value")]);

    let handle = load(
        &mut session,
        &mut executor,
        LoadRequest::new("libleaf.so", leaf("leaf_value")),
    )
    .expect("load");
    assert!(session.linker.scope.global_symbol("leaf_value").is_some());
    let allocation = session
        .linker
        .scope
        .library("libleaf.so")
        .expect("leaf")
        .allocations
        .first()
        .expect("one mapping")
        .address;

    let token = session.close_begin(handle).expect("close begins");
    executor.drive(&mut session, token).expect("drive");
    let outcome = session.close_result(token).expect("result");
    assert!(
        matches!(&outcome, CloseOutcome::Released { library } if library == "libleaf.so"),
        "got {outcome:?}",
    );
    assert!(!session.linker.scope.contains("libleaf.so"), "the object is gone");
    assert!(
        session.linker.scope.global_symbol("leaf_value").is_none(),
        "its symbols left the global scope",
    );
    assert!(
        executor.released.contains(&allocation),
        "its mapping was released: {:?}",
        executor.released,
    );
}

/// A second `dlopen` of the same object takes a reference; the first `dlclose`
/// must not unload it.
#[test]
fn dlclose_with_a_reference_left_keeps_the_object_loaded() {
    let mut session = process_session();
    let mut executor = Executor::new(4, 0x1000);
    session.linker.scope.set_table_length(4);
    executor.exports.insert(1, vec![InstanceExport::func("leaf_value")]);

    let bytes = leaf("leaf_value");
    let first = load(&mut session, &mut executor, LoadRequest::new("libleaf.so", bytes.clone()))
        .expect("first open");
    let second = load(&mut session, &mut executor, LoadRequest::new("libleaf.so", bytes))
        .expect("second open");
    assert_eq!(first, second, "one object, one handle");

    let token = session.close_begin(first).expect("close begins");
    executor.drive(&mut session, token).expect("drive");
    assert!(
        matches!(
            session.close_result(token).expect("result"),
            CloseOutcome::StillReferenced { remaining: 1, .. }
        ),
    );
    assert!(session.linker.scope.contains("libleaf.so"), "still loaded");
}

/// An object another object still needs stays loaded, and is released when the
/// consumer goes. This is POSIX's rule that an object lives while anything
/// needs it, and it is why the two counts are separate.
#[test]
fn a_dependency_outlives_its_consumers_dlclose_until_the_consumer_is_gone() {
    let mut session = process_session();
    let mut executor = Executor::new(4, 0x1000);
    session.linker.scope.set_table_length(4);
    executor.exports.insert(1, vec![InstanceExport::func("leaf_value")]);
    executor.exports.insert(2, vec![InstanceExport::func("top")]);
    executor
        .files
        .insert(String::from("/usr/lib/libleaf.so"), leaf("leaf_value"));

    let top = load(
        &mut session,
        &mut executor,
        LoadRequest::new("libtop.so", consumer("top", &["libleaf.so"])),
    )
    .expect("load");

    // The dependency has no handle of its own -- it was pulled in, not opened --
    // so only the retain from `libtop.so` keeps it alive.
    assert_eq!(session.handles.handle_for("libleaf.so"), None);
    assert_eq!(session.handles.dependency_retains("libleaf.so"), 1);

    let token = session.close_begin(top).expect("close begins");
    executor.drive(&mut session, token).expect("drive");
    session.close_result(token).expect("result");

    assert!(!session.linker.scope.contains("libtop.so"));
    assert!(
        !session.linker.scope.contains("libleaf.so"),
        "the dependency is released with its last consumer",
    );
}

/// The main-image pseudo-handle is not closeable, and saying so is not an
/// error: POSIX makes `dlclose(RTLD_DEFAULT)` a no-op.
#[test]
fn closing_the_main_image_handle_is_a_no_op_not_a_failure() {
    let mut session = process_session();
    let mut executor = Executor::new(0, 0x1000);
    let token = session.close_begin(1).expect("close begins");
    executor.drive(&mut session, token).expect("drive");
    assert!(matches!(
        session.close_result(token).expect("result"),
        CloseOutcome::MainImage
    ));
}

/// An invalid handle is refused at `begin`, before any transaction exists.
#[test]
fn closing_an_invalid_handle_is_refused() {
    let mut session = process_session();
    assert!(matches!(
        session.close_begin(99),
        Err(DylinkError::InvalidHandle { handle: 99 })
    ));
}

// ---------------------------------------------------------------------------
// 4 and 5. Fork capture and reconcile
// ---------------------------------------------------------------------------

/// The capture records what a child needs and nothing it can derive: the exact
/// layout, the image, the handle and its reference count.
#[test]
fn fork_state_captures_the_live_closure_with_its_exact_layout() {
    let mut session = process_session();
    let mut executor = Executor::new(4, 0x1000);
    session.linker.scope.set_table_length(4);
    executor.exports.insert(1, vec![InstanceExport::func("leaf_value")]);
    executor.exports.insert(2, vec![InstanceExport::func("top")]);
    executor
        .files
        .insert(String::from("/usr/lib/libleaf.so"), leaf("leaf_value"));

    let handle = load(
        &mut session,
        &mut executor,
        LoadRequest::new("libtop.so", consumer("top", &["libleaf.so"])),
    )
    .expect("load");

    let archive = session.fork_state().expect("capture");
    assert_eq!(
        archive.modules.iter().map(|module| module.name.as_str()).collect::<Vec<_>>(),
        vec!["libleaf.so", "libtop.so"],
        "dependency-first, which is also the order a child must replay in",
    );
    let top = archive.modules.last().expect("top");
    assert_eq!(top.handle, Some(handle));
    assert_eq!(top.ref_count, Some(1));
    assert_eq!(
        top.memory_base,
        session.linker.scope.library("libtop.so").expect("top").memory_base,
    );
    let leaf_record = &archive.modules[0];
    assert_eq!(leaf_record.handle, None, "a pulled-in dependency has no handle");
    assert_eq!(archive.next_handle, u64::from(session.handles.next_handle()));
}

/// A child rebuilds the parent's closure at the parent's exact addresses and
/// with the parent's exact handles, driving one loop for the whole reconcile.
#[test]
fn a_child_reconciles_the_whole_closure_from_the_archive() {
    let mut parent = process_session();
    let mut executor = Executor::new(4, 0x1000);
    parent.linker.scope.set_table_length(4);
    executor.exports.insert(1, vec![InstanceExport::func("leaf_value")]);
    executor.exports.insert(2, vec![InstanceExport::func("top")]);
    executor
        .files
        .insert(String::from("/usr/lib/libleaf.so"), leaf("leaf_value"));

    let handle = load(
        &mut parent,
        &mut executor,
        LoadRequest::new("libtop.so", consumer("top", &["libleaf.so"])),
    )
    .expect("load");
    let archive = parent.fork_state().expect("capture");

    // The child starts empty and is handed the copied memory, so its allocator
    // must NOT be asked for new addresses.
    let mut child = process_session();
    child.linker.scope.set_table_length(4);
    let mut child_executor = Executor::new(4, 0x1000);
    child_executor.exports.insert(1, vec![InstanceExport::func("leaf_value")]);
    child_executor.exports.insert(2, vec![InstanceExport::func("top")]);

    let token = child
        .fork_reconcile_begin(&archive, MemoryOwnership::Copied)
        .expect("reconcile begins");
    child_executor.drive(&mut child, token).expect("drive");
    child.fork_reconcile_finish(token, &archive).expect("adopt handles");

    for module in &archive.modules {
        let rebuilt = child
            .linker
            .scope
            .library(&module.name)
            .unwrap_or_else(|| panic!("{} was not rebuilt", module.name));
        assert_eq!(rebuilt.memory_base, module.memory_base, "{}", module.name);
        assert_eq!(rebuilt.table_base, module.table_base, "{}", module.name);
    }
    assert_eq!(child.handles.handle_for("libtop.so"), Some(handle));
    assert_eq!(child.handles.next_handle(), parent.handles.next_handle());
    assert!(
        child_executor.probed.is_empty(),
        "a replay supplies every image, so nothing is searched for: {:?}",
        child_executor.probed,
    );
    assert!(
        child_executor.hosts.iter().any(|request| matches!(
            request,
            HostRequest::AdoptMapping { .. }
        )),
        "copied mappings are ADOPTED, not re-mapped",
    );
}

/// An object a pthread peer already rebuilt is VERIFIED against the archive,
/// not skipped. A child running two layouts for one name would corrupt every
/// relocation derived from the loser.
#[test]
fn a_peer_rebuilt_object_that_disagrees_with_the_archive_is_refused() {
    let mut parent = process_session();
    let mut executor = Executor::new(4, 0x1000);
    parent.linker.scope.set_table_length(4);
    executor.exports.insert(1, vec![InstanceExport::func("leaf_value")]);
    load(&mut parent, &mut executor, LoadRequest::new("libleaf.so", leaf("leaf_value")))
        .expect("load");
    let mut archive = parent.fork_state().expect("capture");
    archive.modules[0].memory_base += 0x1000;

    let error = parent
        .fork_reconcile_begin(&archive, MemoryOwnership::Copied)
        .expect_err("a disagreement must be refused");
    assert!(
        matches!(&error, DylinkError::ArchivedAllocationMismatch { library } if library == "libleaf.so"),
        "got {error:?}",
    );
}

/// A child whose parent loaded nothing has nothing to reconcile, and says so by
/// finishing immediately rather than by failing.
#[test]
fn an_empty_archive_reconciles_to_nothing() {
    let mut session = process_session();
    let mut executor = Executor::new(0, 0x1000);
    let archive = session.fork_state().expect("capture");
    assert!(archive.modules.is_empty());

    let token = session
        .fork_reconcile_begin(&archive, MemoryOwnership::Copied)
        .expect("reconcile begins");
    executor.drive(&mut session, token).expect("drive");
    session.fork_reconcile_finish(token, &archive).expect("finish");
    assert!(executor.acts.is_empty(), "nothing to do means no engine work");
}

/// A replayed object's `GOT.func` cells take the PARENT's funcref index, and
/// the planner asks the driver for it rather than re-deriving one.
///
/// The guest holds function pointers in copied memory. Re-deriving an index in
/// the child would leave those pointers aimed at a different function, and the
/// program would not find out until it called one. `dylink.ts:1651` reads the
/// same value from the activation owner; the difference is that the request is
/// now the planner's, so a driver cannot skip it.
#[test]
fn a_replay_asks_for_the_parents_saved_got_func_value() {
    let mut session = process_session();
    let mut executor = Executor::new(0, 0);
    executor.exports.insert(1, vec![InstanceExport::func("entry")]);
    // The parent's table index for `helper`, which the child must reproduce.
    executor.saved_got_func.insert(String::from("helper"), 37);

    let bytes = SideModule {
        dylink: DylinkSection {
            memory_size: 4096,
            memory_align: 4,
            table_size: 0,
            table_align: 0,
            ..Default::default()
        },
        imports: vec![
            Import::Memory { module: "env".into(), field: "memory".into() },
            Import::immutable_global("env", "__memory_base"),
            Import::immutable_global("env", "__table_base"),
            Import::got("GOT.func", "helper"),
        ],
        exports: vec![Export::func("entry", 0)],
        ..Default::default()
    }
    .encode();

    let mut request = LoadRequest::new("libreplay.so", bytes);
    request.replay = Some(dylink::ReplayInputs {
        memory_base: 0x9000,
        table_base: 0,
        global_visibility: true,
        allocations: vec![fork_codec::dylink_archive::DylinkAllocation {
            address: 0x9000,
            size: 4096,
            mapping_address: 0x9000,
            mapping_size: 4096,
        }],
        ..Default::default()
    });

    let token = session.open_begin(request).expect("begin");
    executor.drive(&mut session, token).expect("drive");
    session.open_finish(token, None).expect("finish");

    assert!(
        executor.hosts.iter().any(|request| matches!(
            request,
            HostRequest::SavedGotFunc { library, symbol }
                if library == "libreplay.so" && symbol == "helper"
        )),
        "the planner asked for the parent's value: {:?}",
        executor.hosts,
    );
    let cell = session
        .linker
        .got
        .shared_cell("helper")
        .expect("a GOT cell for helper");
    assert_eq!(
        cell.value,
        WasmValue::I32(37),
        "the cell holds the PARENT's index, not one re-derived here",
    );
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/// An aborted load gives back everything it took, through the SAME drive loop.
/// A second loop for rollback would be a second protocol for a driver to get
/// wrong.
#[test]
fn an_aborted_load_releases_its_dependency_through_the_same_loop() {
    let mut session = process_session();
    let mut executor = Executor::new(4, 0x1000);
    session.linker.scope.set_table_length(4);
    executor.exports.insert(1, vec![InstanceExport::func("leaf_value")]);
    executor.exports.insert(2, vec![InstanceExport::func("top")]);
    executor
        .files
        .insert(String::from("/usr/lib/libleaf.so"), leaf("leaf_value"));

    let token = session
        .open_begin(LoadRequest::new("libtop.so", consumer("top", &["libleaf.so"])))
        .expect("begin");

    // Drive until the dependency is in scope and the consumer's own plan has
    // started, then abandon it.
    loop {
        let step = session.step(token).expect("step");
        if session.linker.scope.contains("libleaf.so") {
            break;
        }
        let result = match step {
            PlanStep::Finished => break,
            PlanStep::Act(act) => executor.perform(act),
            PlanStep::Host(request) => executor.perform_host(request),
            PlanStep::Call(call) => {
                executor.calls.push(call);
                ActResult::Done
            }
        };
        session.resume(token, result).expect("resume");
    }
    assert!(session.linker.scope.contains("libleaf.so"), "the dependency landed");

    session.abort(token).expect("abort re-arms the loop");
    executor.drive(&mut session, token).expect("the rollback drains through step");
    session.discard(token);

    assert!(
        !session.linker.scope.contains("libleaf.so"),
        "a dependency this transaction loaded is released with it",
    );
    assert!(!session.contains(token));
}
