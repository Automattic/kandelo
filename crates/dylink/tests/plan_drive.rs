//! Driving a whole `dlopen` against a recording executor.
//!
//! The point of the planner is that a host implements ONE typed executor and
//! gets the linker. This file is that executor, at ~120 lines, standing in for
//! all three real ones (browser, Node, wasmtime). If a new act kind ever
//! appears, this `match` stops compiling — which is the exhaustiveness the
//! whole migration is for.

mod support;

use std::collections::BTreeMap;

use dylink::{
    ActResult, BindingValue, DylinkError, ExternKind, GlobalId, HostRequest, ImportBinding,
    InstanceExport, InstanceId, LinkAct, LinkPlan, Linker, LinkerConfig, LoadRequest, LoadedLibrary,
    ModuleSource, PlanStep, StagedCall, SymbolValue, TableValue, WasmValue, MAIN_INSTANCE,
};
use support::{DylinkSection, Export, Import, SideModule};

/// A recording stand-in for a real engine.
#[derive(Default)]
struct Executor {
    acts: Vec<LinkAct>,
    hosts: Vec<HostRequest>,
    calls: Vec<StagedCall>,
    table_length: u64,
    memory_cursor: u64,
    globals: BTreeMap<GlobalId, WasmValue>,
    table: BTreeMap<u64, TableValue>,
    zeroed: Vec<(u64, u64)>,
    /// What `ReadExports` will report.
    exports: Vec<InstanceExport>,
    next_activation: u32,
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
            LinkAct::ReadGlobal { global } => {
                ActResult::Value(self.globals.get(&global).copied().unwrap_or(WasmValue::I32(0)))
            }
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
            LinkAct::GrowMemory { .. } => ActResult::Done,
            LinkAct::NewTag { .. } => ActResult::Done,
            LinkAct::Instantiate { .. } => ActResult::Done,
            LinkAct::ReadExports { .. } => ActResult::Exports(self.exports.clone()),
            LinkAct::ZeroMemory { address, length } => {
                self.zeroed.push((address, length));
                ActResult::Done
            }
        }
    }

    fn perform_host(&mut self, request: HostRequest) -> ActResult {
        self.hosts.push(request.clone());
        match request {
            HostRequest::AllocateMemory { size, align, .. } => {
                let aligned = self.memory_cursor.next_multiple_of(align);
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
            _ => ActResult::Done,
        }
    }

    fn drive(
        &mut self,
        linker: &mut Linker,
        plan: &mut LinkPlan,
    ) -> Result<(), DylinkError> {
        loop {
            let result = match plan.step(linker)? {
                PlanStep::Finished => return Ok(()),
                PlanStep::Act(act) => self.perform(act),
                PlanStep::Host(request) => self.perform_host(request),
                PlanStep::Call(call) => {
                    self.calls.push(call);
                    ActResult::Done
                }
            };
            plan.resume(linker, result)?;
        }
    }

    fn act_names(&self) -> Vec<&'static str> {
        self.acts
            .iter()
            .map(|act| match act {
                LinkAct::Compile { .. } => "Compile",
                LinkAct::NewGlobal { .. } => "NewGlobal",
                LinkAct::ReadGlobal { .. } => "ReadGlobal",
                LinkAct::WriteGlobal { .. } => "WriteGlobal",
                LinkAct::GrowTable { .. } => "GrowTable",
                LinkAct::WriteTable { .. } => "WriteTable",
                LinkAct::GrowMemory { .. } => "GrowMemory",
                LinkAct::NewTag { .. } => "NewTag",
                LinkAct::Instantiate { .. } => "Instantiate",
                LinkAct::ReadExports { .. } => "ReadExports",
                LinkAct::ZeroMemory { .. } => "ZeroMemory",
            })
            .collect()
    }
}

fn process_linker() -> Linker {
    Linker::new(LinkerConfig {
        memory_bytes: 1 << 20,
        ..LinkerConfig::default()
    })
}

fn load(
    linker: &mut Linker,
    executor: &mut Executor,
    request: LoadRequest,
) -> Result<LoadedLibrary, DylinkError> {
    let mut plan = LinkPlan::begin(linker, request)?;
    executor.drive(linker, &mut plan)?;
    plan.finish(linker)
}

// ---------------------------------------------------------------------------

/// The smallest complete load, act by act. The order is the contract: memory
/// before table, bases before GOT cells, every cell before instantiation,
/// exports read only after the instance exists.
#[test]
fn a_minimal_side_module_produces_an_ordered_act_sequence() {
    let bytes = SideModule {
        dylink: DylinkSection {
            memory_size: 256,
            memory_align: 4,
            table_size: 2,
            table_align: 0,
            ..Default::default()
        },
        imports: vec![
            Import::Memory { module: "env".into(), field: "memory".into() },
            Import::immutable_global("env", "__memory_base"),
            Import::immutable_global("env", "__table_base"),
        ],
        exports: vec![Export::func("my_entry", 0), Export::func("__wasm_call_ctors", 1)],
        ..Default::default()
    }
    .encode();

    let mut linker = process_linker();
    let mut executor = Executor::new(0, 0x1000);
    executor.exports = vec![
        InstanceExport::func("my_entry"),
        InstanceExport::func("__wasm_call_ctors"),
    ];

    let library = load(&mut linker, &mut executor, LoadRequest::new("libmin.so", bytes))
        .expect("load");

    assert_eq!(
        executor.act_names(),
        vec![
            "Compile",
            "ZeroMemory",
            "GrowTable",   // the module's own 2-slot reservation
            "NewGlobal",   // __memory_base
            "NewGlobal",   // __table_base
            "Instantiate",
            "ReadExports",
            "GrowTable",   // a slot for the exported function
            "WriteTable",
        ]
    );
    // `__wasm_call_ctors` is reserved and never published as a symbol, but it
    // IS the constructors stage the guest must run.
    assert_eq!(executor.calls.len(), 1);
    assert_eq!(executor.calls[0].export, "__wasm_call_ctors");
    assert_eq!(library.memory_base, 0x1000);
    assert_eq!(library.table_base, 0);
    assert_eq!(executor.zeroed, vec![(0x1000, 256)]);
    assert!(library.exports.contains_key("my_entry"));
    assert!(!library.exports.contains_key("__wasm_call_ctors"));
    assert_eq!(linker.scope.global_symbol("my_entry").is_some(), true);
}

/// The load-bearing invariant, end to end: the binding list has exactly one
/// entry per import declaration, in declaration order, with duplicate
/// `(module, name)` pairs preserved and flagged.
#[test]
fn import_bindings_are_one_per_declaration_in_order() {
    let bytes = SideModule {
        dylink: DylinkSection { memory_size: 16, memory_align: 2, ..Default::default() },
        imports: vec![
            Import::Memory { module: "env".into(), field: "memory".into() },
            Import::Table { module: "env".into(), field: "__indirect_function_table".into() },
            Import::immutable_global("env", "__memory_base"),
            Import::immutable_global("env", "__table_base"),
            Import::immutable_global("env", "__stack_pointer"),
            Import::func("env", "interposable"),
            Import::got("GOT.mem", "shared_data"),
            // A SECOND declaration of the same `(module, name)`. `wasm-ld`
            // emits these; the engine calls Get once per entry.
            Import::func("env", "interposable"),
            Import::got("GOT.mem", "shared_data"),
        ],
        // Two function imports occupy indices 0 and 1, so index 2 is this
        // module's first DEFINED function.
        exports: vec![Export::func("interposable", 2)],
        ..Default::default()
    }
    .encode();

    let mut linker = process_linker();
    linker.scope.publish_main_image(
        [(String::from("shared_data"), SymbolValue::main_data("shared_data", 0x5000))],
        [],
        4,
    );
    let mut executor = Executor::new(4, 0x2000);
    executor.exports = vec![InstanceExport::func("interposable")];

    let mut plan = LinkPlan::begin(&mut linker, LoadRequest::new("libdup.so", bytes.clone()))
        .expect("begin");
    executor.drive(&mut linker, &mut plan).expect("drive");

    let bindings: &[ImportBinding] = plan.bindings().expect("bindings");
    let shape = dylink::read_module_shape(&bytes).expect("shape");
    dylink::ImportPlan::validate_against(bindings, &shape.imports)
        .expect("one binding per declaration, in order");

    assert_eq!(bindings.len(), 9);
    assert_eq!(bindings[0].value, BindingValue::ProcessMemory);
    assert_eq!(bindings[1].value, BindingValue::ProcessTable);
    assert_eq!(bindings[4].value, BindingValue::ProcessStackPointer);

    // The duplicates: same name, distinct positions, second one flagged.
    assert!(!bindings[5].duplicate_occurrence);
    assert!(bindings[7].duplicate_occurrence);
    assert_eq!(bindings[5].name, "interposable");
    assert_eq!(bindings[7].name, "interposable");
    assert_eq!(bindings[5].position, 5);
    assert_eq!(bindings[7].position, 7);

    // A GOT duplicate resolves to the SAME cell, exactly as the TypeScript
    // Proxy returns the same Global on a second read of the property.
    assert_eq!(bindings[6].value, bindings[8].value);
    assert!(matches!(bindings[6].value, BindingValue::Global(_)));
    assert!(bindings[8].duplicate_occurrence);
}

/// `wasm-ld` can make an interposable definition both an `env` import and a
/// module export. The process wins when it supplies the symbol; otherwise the
/// genuine self-definition is routed back — and a trampoline is NEVER
/// manufactured for an arbitrary unresolved import.
#[test]
fn a_self_defined_import_gets_a_trampoline_but_an_unknown_one_does_not() {
    let self_defined = SideModule {
        dylink: DylinkSection { memory_size: 16, memory_align: 2, ..Default::default() },
        imports: vec![Import::func("env", "operator_new")],
        // Index 1 is a DEFINED function (index 0 is the import).
        exports: vec![Export::func("operator_new", 1)],
        ..Default::default()
    }
    .encode();

    let mut linker = process_linker();
    let mut executor = Executor::new(0, 0x1000);
    executor.exports = vec![InstanceExport::func("operator_new")];
    let mut plan =
        LinkPlan::begin(&mut linker, LoadRequest::new("libcxx.so", self_defined)).expect("begin");
    executor.drive(&mut linker, &mut plan).expect("drive");
    assert_eq!(
        plan.bindings().expect("bindings")[0].value,
        BindingValue::SelfImport { name: "operator_new".into() }
    );

    let unknown = SideModule {
        dylink: DylinkSection { memory_size: 16, memory_align: 2, ..Default::default() },
        imports: vec![Import::func("env", "no_such_symbol")],
        ..Default::default()
    }
    .encode();
    let mut linker = process_linker();
    let mut executor = Executor::new(0, 0x1000);
    let error = load(&mut linker, &mut executor, LoadRequest::new("libbad.so", unknown))
        .expect_err("an unresolved strong import must fail the load");
    assert!(matches!(error, DylinkError::UndefinedSymbol { .. }));
}

/// The main image's definition wins, so a resolved `env` import binds to the
/// main instance rather than to a trampoline.
#[test]
fn a_process_supplied_symbol_outranks_a_self_definition() {
    let bytes = SideModule {
        dylink: DylinkSection { memory_size: 16, memory_align: 2, ..Default::default() },
        imports: vec![Import::func("env", "operator_new")],
        exports: vec![Export::func("operator_new", 1)],
        ..Default::default()
    }
    .encode();

    let mut linker = process_linker();
    linker.scope.publish_main_image(
        [(
            String::from("operator_new"),
            SymbolValue::Func { instance: MAIN_INSTANCE, export: "operator_new".into() },
        )],
        [(2, MAIN_INSTANCE, String::from("operator_new"))],
        4,
    );
    let mut executor = Executor::new(4, 0x1000);
    executor.exports = vec![InstanceExport::func("operator_new")];
    let mut plan =
        LinkPlan::begin(&mut linker, LoadRequest::new("libcxx.so", bytes)).expect("begin");
    executor.drive(&mut linker, &mut plan).expect("drive");
    assert_eq!(
        plan.bindings().expect("bindings")[0].value,
        BindingValue::Export { instance: MAIN_INSTANCE, name: "operator_new".into() }
    );
}

/// An immutable global export is a data address relative to the module's base
/// and is relocated; a mutable one is instance state and passes through.
#[test]
fn immutable_global_exports_are_relocated_and_mutable_ones_are_not() {
    let bytes = SideModule {
        dylink: DylinkSection { memory_size: 4096, memory_align: 4, ..Default::default() },
        exports: vec![Export::global("my_table", 0), Export::global("my_counter", 1)],
        ..Default::default()
    }
    .encode();

    let mut linker = process_linker();
    let mut executor = Executor::new(0, 0x4000);
    executor.exports = vec![
        InstanceExport::global("my_table", WasmValue::I32(0x40), false),
        InstanceExport::global("my_counter", WasmValue::I32(7), true),
    ];

    let library =
        load(&mut linker, &mut executor, LoadRequest::new("libdata.so", bytes)).expect("load");
    assert_eq!(library.memory_base, 0x4000);
    assert_eq!(library.exports["my_table"].address(), Some(0x4040));
    assert_eq!(library.exports["my_counter"].address(), Some(7));
}

/// A `GOT.func` cell for a symbol the module defines itself starts at zero and
/// is republished with the real table index once the export lands. That is the
/// `PendingSelfDefinition` path, and it must produce exactly one `WriteGlobal`.
#[test]
fn a_self_defined_got_func_cell_is_republished_with_its_slot() {
    let bytes = SideModule {
        dylink: DylinkSection { memory_size: 16, memory_align: 2, ..Default::default() },
        imports: vec![Import::got("GOT.func", "my_callback")],
        exports: vec![Export::func("my_callback", 0)],
        ..Default::default()
    }
    .encode();

    let mut linker = process_linker();
    let mut executor = Executor::new(10, 0x1000);
    executor.exports = vec![InstanceExport::func("my_callback")];

    load(&mut linker, &mut executor, LoadRequest::new("libcb.so", bytes)).expect("load");

    let writes: Vec<&LinkAct> = executor
        .acts
        .iter()
        .filter(|act| matches!(act, LinkAct::WriteGlobal { .. }))
        .collect();
    assert_eq!(writes.len(), 1);
    let LinkAct::WriteGlobal { value, .. } = writes[0] else {
        unreachable!();
    };
    // The table grew from 10, so the export took slot 10.
    assert_eq!(*value, WasmValue::I32(10));
    assert_eq!(
        executor.table.get(&10),
        Some(&TableValue::Export { instance: InstanceId(1), name: "my_callback".into() })
    );
}

/// The exception tags are process-owned and allocated ONCE: C++ exceptions
/// crossing a side-module call require tag identity, not merely a matching
/// payload type.
#[test]
fn exception_tags_are_allocated_once_per_process() {
    let make = |name: &str| {
        (
            String::from(name),
            SideModule {
                dylink: DylinkSection { memory_size: 16, memory_align: 2, ..Default::default() },
                imports: vec![
                    Import::tag("env", "__c_longjmp"),
                    Import::tag("env", "__cpp_exception"),
                ],
                ..Default::default()
            }
            .encode(),
        )
    };

    let mut linker = process_linker();
    let mut executor = Executor::new(0, 0x1000);
    for name in ["libone.so", "libtwo.so"] {
        let (name, bytes) = make(name);
        load(&mut linker, &mut executor, LoadRequest::new(name, bytes)).expect("load");
    }
    let tags = executor
        .acts
        .iter()
        .filter(|act| matches!(act, LinkAct::NewTag { .. }))
        .count();
    assert_eq!(tags, 2, "one longjmp tag and one C++ tag for the whole process");
}

/// A complete fork replay reuses the parent's exact bases, adopts its mapping
/// ownership rather than allocating, does NOT zero the copied memory, and does
/// NOT re-run constructors — the parent already ran them and post-startup state
/// lives in the copied bytes.
#[test]
fn a_complete_replay_reuses_the_parent_and_reruns_nothing() {
    let bytes = SideModule {
        dylink: DylinkSection {
            memory_size: 4096,
            memory_align: 4,
            table_size: 2,
            table_align: 0,
            ..Default::default()
        },
        exports: vec![Export::func("entry", 0), Export::func("__wasm_call_ctors", 1)],
        ..Default::default()
    }
    .encode();

    let mut linker = process_linker();
    let mut executor = Executor::new(0, 0);
    executor.exports = vec![
        InstanceExport::func("entry"),
        InstanceExport::func("__wasm_call_ctors"),
    ];

    let mut request = LoadRequest::new("libreplay.so", bytes);
    request.replay = Some(dylink::ReplayInputs {
        memory_base: 0x9000,
        table_base: 8,
        global_visibility: true,
        allocations: vec![fork_codec::dylink_archive::DylinkAllocation {
            address: 0x9000,
            size: 4096,
            mapping_address: 0x9000,
            mapping_size: 4096,
        }],
        ..Default::default()
    });

    let library = load(&mut linker, &mut executor, request).expect("replay");
    assert_eq!(library.memory_base, 0x9000);
    assert_eq!(library.table_base, 8);
    assert!(executor.zeroed.is_empty(), "copied memory must not be zeroed");
    assert!(
        executor
            .hosts
            .iter()
            .any(|request| matches!(request, HostRequest::AdoptMapping { .. })),
        "mapping ownership is adopted, not re-allocated"
    );
    assert!(
        !executor
            .hosts
            .iter()
            .any(|request| matches!(request, HostRequest::AllocateMemory { .. }))
    );
    assert!(executor.calls.is_empty(), "a complete replay re-runs no stage");
    // The table was padded from 0 up to the parent's base of 8.
    assert!(executor.acts.contains(&LinkAct::GrowTable { delta: 8 }));
}

/// A rollback restores the scope and GOT and names the mappings to release, but
/// deliberately does not shrink the table, which wasm cannot do.
#[test]
fn a_failed_load_rolls_back_scope_and_names_its_mappings() {
    let bytes = SideModule {
        dylink: DylinkSection { memory_size: 256, memory_align: 4, ..Default::default() },
        // A strong undefined symbol: the load must fail at binding time, after
        // memory has been allocated.
        imports: vec![Import::func("env", "missing_symbol")],
        ..Default::default()
    }
    .encode();

    let mut linker = process_linker();
    let mut executor = Executor::new(4, 0x1000);
    let mut plan =
        LinkPlan::begin(&mut linker, LoadRequest::new("libfail.so", bytes)).expect("begin");
    let error = executor.drive(&mut linker, &mut plan).expect_err("undefined symbol");
    assert!(matches!(error, DylinkError::UndefinedSymbol { .. }));

    let requests = plan.rollback(&mut linker);
    assert!(requests
        .iter()
        .any(|request| matches!(request, HostRequest::ReleaseMapping { .. })));
    assert!(linker.scope.library("libfail.so").is_none());
}

/// A plan driven out of order is an error, not a silent misbinding.
#[test]
fn a_plan_driven_out_of_order_is_rejected() {
    let mut linker = process_linker();
    let mut plan = LinkPlan::begin(
        &mut linker,
        LoadRequest::new("libmin.so", support::trivial_side_module()),
    )
    .expect("begin");

    // Resuming before stepping.
    assert_eq!(
        plan.resume(&mut linker, ActResult::Done),
        Err(DylinkError::UnexpectedActSequence)
    );
    // Stepping twice without resuming.
    plan.step(&mut linker).expect("first step");
    assert_eq!(plan.step(&mut linker), Err(DylinkError::UnexpectedActSequence));
    // Answering with the wrong result kind.
    assert_eq!(
        plan.resume(&mut linker, ActResult::Index(0)),
        Err(DylinkError::ActResultMismatch { expected: "Done" })
    );
}

/// Finishing before the plan reports `Finished` is an error.
#[test]
fn finishing_early_is_rejected() {
    let mut linker = process_linker();
    let plan = LinkPlan::begin(
        &mut linker,
        LoadRequest::new("libmin.so", support::trivial_side_module()),
    )
    .expect("begin");
    assert_eq!(plan.finish(&linker), Err(DylinkError::UnexpectedActSequence));
}

/// A main module is not loadable as a shared library, and a second load of the
/// same name is a duplicate rather than a silent replacement.
#[test]
fn begin_rejects_a_main_module_and_a_duplicate() {
    let mut linker = process_linker();
    let main = SideModule { omit_dylink: true, ..Default::default() }.encode();
    assert!(matches!(
        LinkPlan::begin(&mut linker, LoadRequest::new("main.wasm", main)).err(),
        Some(DylinkError::NotASharedLibrary)
    ));

    let mut executor = Executor::new(0, 0x1000);
    load(
        &mut linker,
        &mut executor,
        LoadRequest::new("libmin.so", support::trivial_side_module()),
    )
    .expect("first load");
    assert!(matches!(
        LinkPlan::begin(
            &mut linker,
            LoadRequest::new("libmin.so", support::trivial_side_module())
        )
        .err(),
        Some(DylinkError::DuplicateLibrary { .. })
    ));
}

/// A `DT_NEEDED` dependency must already be loaded. Allocating it here would
/// choose fresh addresses and, in a fork child, corrupt copied relocations.
#[test]
fn a_missing_dt_needed_dependency_stops_the_load() {
    let bytes = SideModule {
        dylink: DylinkSection {
            memory_size: 16,
            memory_align: 2,
            needed: vec!["libabsent.so".into()],
            ..Default::default()
        },
        ..Default::default()
    }
    .encode();
    let mut linker = process_linker();
    assert!(matches!(
        LinkPlan::begin(&mut linker, LoadRequest::new("libdep.so", bytes)).err(),
        Some(DylinkError::DependencyMissing { .. })
    ));
}

/// An `RTLD_LOCAL` object's exports do not reach the process-global scope, so a
/// later unrelated object cannot resolve against them.
#[test]
fn an_rtld_local_load_does_not_publish_globally() {
    let bytes = SideModule {
        dylink: DylinkSection { memory_size: 16, memory_align: 2, ..Default::default() },
        exports: vec![Export::func("private_entry", 0)],
        ..Default::default()
    }
    .encode();

    let mut linker = process_linker();
    let mut executor = Executor::new(0, 0x1000);
    executor.exports = vec![InstanceExport::func("private_entry")];
    let library = load(
        &mut linker,
        &mut executor,
        LoadRequest::new("libpriv.so", bytes).local(),
    )
    .expect("load");

    assert!(!library.global_visibility);
    assert!(linker.scope.global_symbol("private_entry").is_none());
    assert!(library.exports.contains_key("private_entry"));
}

/// A borrowed (vfork) replay needs shared memory and passive data segments; it
/// strips only `wasm-ld`'s recognized memory-initialization start section.
#[test]
fn a_borrowed_replay_requires_shared_memory_and_rewrites_the_start_section() {
    let bytes = SideModule {
        dylink: DylinkSection { memory_size: 64, memory_align: 4, ..Default::default() },
        exports: vec![Export::func("__wasm_init_memory", 0)],
        data_segments: vec![true],
        start_function: Some(0),
        ..Default::default()
    }
    .encode();

    // Without shared memory the borrow is refused rather than silently copied.
    let mut linker = process_linker();
    let mut request = LoadRequest::new("libborrow.so", bytes.clone());
    request.borrowed_memory = true;
    request.replay = Some(dylink::ReplayInputs {
        memory_base: 0x7000,
        table_base: 0,
        global_visibility: true,
        allocations: vec![fork_codec::dylink_archive::DylinkAllocation {
            address: 0x7000,
            size: 64,
            mapping_address: 0x7000,
            mapping_size: 64,
        }],
        ..Default::default()
    });
    assert!(matches!(
        LinkPlan::begin(&mut linker, request.clone()).err(),
        Some(DylinkError::BorrowedReplayRequiresSharedMemory { .. })
    ));

    let mut linker = Linker::new(LinkerConfig {
        memory_bytes: 1 << 20,
        shared_memory: true,
        ..LinkerConfig::default()
    });
    let mut executor = Executor::new(0, 0);
    let mut plan = LinkPlan::begin(&mut linker, request).expect("begin");
    executor.drive(&mut linker, &mut plan).expect("drive");
    let LinkAct::Compile { source, .. } = &executor.acts[0] else {
        unreachable!("the first act is always a compile");
    };
    assert!(
        matches!(source, ModuleSource::Rewritten(rewritten) if rewritten.len() < bytes.len()),
        "the start section is stripped so instantiation cannot write borrowed memory"
    );
}

/// The archive decoder's records feed the planner directly; nothing re-declares
/// them.
#[test]
fn replay_inputs_come_straight_from_an_archive_record() {
    let module = fork_codec::dylink_archive::DylinkModule {
        name: "libarchived.so".into(),
        module_bytes: support::trivial_side_module(),
        digest: [0u8; 32],
        memory_base: 0x1_2000,
        table_base: 24,
        tls_base: Some(0x1_2040),
        activation_id: Some(5),
        handle: Some(3),
        ref_count: Some(1),
        global_visibility: true,
        committed_global_root: true,
        provider_dependencies: vec!["libprov.so".into()],
        allocations: vec![fork_codec::dylink_archive::DylinkAllocation {
            address: 0x1_2000,
            size: 4096,
            mapping_address: 0x1_2000,
            mapping_size: 8192,
        }],
        initialization: Some(fork_codec::dylink_archive::DylinkInitialization {
            transaction_token: 9,
            stage: fork_codec::dylink_archive::DylinkInitializationStage::Constructors,
            table_index: 12,
        }),
    };

    let replay = dylink::ReplayInputs::from_archive(&module);
    assert_eq!(replay.memory_base, 0x1_2000);
    assert_eq!(replay.table_base, 24);
    assert_eq!(replay.tls_base, Some(0x1_2040));
    assert_eq!(replay.activation_id, Some(5));
    assert!(replay.committed_global_root);
    assert_eq!(replay.provider_dependencies, vec!["libprov.so"]);
    assert_eq!(replay.allocations.len(), 1);
    assert_eq!(
        replay.initialization_stage,
        Some(dylink::InitializationStage::Constructors)
    );
}

/// Exports the module re-exports from an import are not local definitions, so
/// they neither get a trampoline nor a table slot of this module's own.
#[test]
fn reexported_imports_are_not_published_as_this_modules_functions() {
    let bytes = SideModule {
        dylink: DylinkSection { memory_size: 16, memory_align: 2, ..Default::default() },
        imports: vec![Import::func("env", "malloc")],
        exports: vec![Export::func("malloc", 0), Export::func("real_entry", 1)],
        ..Default::default()
    }
    .encode();

    let mut linker = process_linker();
    linker.scope.publish_main_image(
        [(
            String::from("malloc"),
            SymbolValue::Func { instance: MAIN_INSTANCE, export: "malloc".into() },
        )],
        [(1, MAIN_INSTANCE, String::from("malloc"))],
        4,
    );
    let mut executor = Executor::new(4, 0x1000);
    // The instance reports both, because the export section lists both.
    executor.exports = vec![InstanceExport::func("malloc"), InstanceExport::func("real_entry")];

    let library =
        load(&mut linker, &mut executor, LoadRequest::new("libre.so", bytes)).expect("load");

    // The main image keeps `malloc`: first definition wins.
    assert_eq!(linker.scope.global_symbol("malloc").expect("malloc").owner, None);
    assert_eq!(
        linker.scope.global_symbol("real_entry").expect("real_entry").owner.as_deref(),
        Some("libre.so")
    );
    assert_eq!(library.owned_table_entries.len(), 2);
}

/// Every export kind the executor can report is handled; a `Table` or `Memory`
/// export is neither a symbol nor a table entry.
#[test]
fn non_symbol_export_kinds_are_ignored() {
    let bytes = SideModule {
        dylink: DylinkSection { memory_size: 16, memory_align: 2, ..Default::default() },
        exports: vec![Export::func("entry", 0)],
        ..Default::default()
    }
    .encode();

    let mut linker = process_linker();
    let mut executor = Executor::new(0, 0x1000);
    executor.exports = vec![
        InstanceExport::func("entry"),
        InstanceExport {
            name: "some_table".into(),
            kind: ExternKind::Table,
            value: None,
            mutable: None,
        },
    ];
    let library =
        load(&mut linker, &mut executor, LoadRequest::new("libtbl.so", bytes)).expect("load");
    assert_eq!(library.exports.len(), 1);
}
