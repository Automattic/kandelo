//! Symbol scope and interposition, placement arithmetic, and handle lifetime.

mod support;

use std::collections::{BTreeMap, BTreeSet};

use dylink::{
    align_up, check_allocation, check_archived_allocations, check_tls, is_public_dylink_export,
    parse_dylink_section, plan_memory, plan_table, CloseOutcome, DylinkError, DylinkMetadata,
    HandleTable, InstanceId, LinkerScope, LoadState, LoadedLibrary, MemoryPlacement, SymbolValue,
    MAIN_PROGRAM_HANDLE,
};
use fork_codec::dylink_archive::DylinkAllocation;
use support::{DylinkSection, SideModule};

fn metadata(needed: &[&str]) -> DylinkMetadata {
    let bytes = SideModule {
        dylink: DylinkSection {
            memory_size: 64,
            memory_align: 4,
            needed: needed.iter().map(|entry| String::from(*entry)).collect(),
            ..Default::default()
        },
        ..Default::default()
    }
    .encode();
    parse_dylink_section(&bytes).expect("dylink.0")
}

fn library(name: &str, instance: u32, needed: &[&str], global: bool) -> LoadedLibrary {
    LoadedLibrary {
        name: name.into(),
        instance: InstanceId(instance),
        metadata: metadata(needed),
        memory_base: 0x1000 * u64::from(instance),
        table_base: u64::from(instance) * 16,
        tls_base: None,
        activation_id: None,
        global_visibility: global,
        committed_global_root: false,
        exports: BTreeMap::new(),
        owned_table_entries: BTreeSet::new(),
        got_imports: BTreeMap::new(),
        provider_dependencies: BTreeSet::new(),
        allocations: Vec::new(),
        load_state: LoadState::Loaded,
    }
}

// ---------------------------------------------------------------------------
// Scope and interposition
// ---------------------------------------------------------------------------

/// ELF interposition: the first definition in the global scope wins, and the
/// main image wins over everything, so a later object cannot silently replace a
/// symbol the guest already holds pointers to.
#[test]
fn the_first_global_definition_wins() {
    let mut scope = LinkerScope::new();
    scope.publish_main_image(
        [(String::from("malloc"), SymbolValue::main_data("malloc", 0x100))],
        [],
        0,
    );

    let mut first = library("libone.so", 1, &[], true);
    first
        .exports
        .insert("malloc".into(), SymbolValue::main_data("malloc", 0x200));
    first
        .exports
        .insert("only_here".into(), SymbolValue::main_data("only_here", 0x201));
    scope.insert(first).expect("insert");
    scope.publish_global_library_symbols("libone.so").expect("publish");

    let resolved = scope.global_symbol("malloc").expect("malloc");
    assert_eq!(resolved.value, SymbolValue::main_data("malloc", 0x100));
    assert_eq!(resolved.owner, None, "the main image keeps the definition");
    assert_eq!(
        scope.global_symbol("only_here").map(|symbol| symbol.owner.clone()),
        Some(Some("libone.so".into()))
    );
}

/// Reserved names and fork-instrument entry points are activation-control
/// machinery, not ELF-visible application symbols.
#[test]
fn reserved_and_fork_runtime_exports_are_not_published() {
    assert!(is_public_dylink_export("php_module_startup"));
    assert!(!is_public_dylink_export("__wasm_call_ctors"));
    assert!(!is_public_dylink_export("__tls_base"));
    assert!(!dylink::is_public_dylink_export("wpk_fork_module_bootstrap"));
    assert!(dylink::is_fork_runtime_export("wpk_fork_module_bootstrap"));
}

/// An `RTLD_LOCAL` object's symbols are reachable from its dependents' scope
/// but not from the process-global one.
#[test]
fn a_local_object_is_scoped_not_global() {
    let mut scope = LinkerScope::new();
    let mut local = library("libprivate.so", 1, &[], false);
    local
        .exports
        .insert("helper".into(), SymbolValue::main_data("helper", 0x500));
    scope.insert(local).expect("insert");
    scope.publish_global_library_symbols("libprivate.so").expect("publish");

    assert!(scope.global_symbol("helper").is_none());
    let resolved = scope
        .scoped_symbol(&[String::from("libprivate.so")], "helper")
        .expect("visible through the dependency scope");
    assert!(!resolved.globally_visible);
    assert_eq!(resolved.owner.as_deref(), Some("libprivate.so"));
}

/// `dlopen(RTLD_GLOBAL)` of an already-loaded local object promotes it AND its
/// whole `DT_NEEDED` closure; otherwise a global object would depend on symbols
/// nothing else can see.
#[test]
fn promotion_reaches_the_whole_dependency_closure() {
    let mut scope = LinkerScope::new();
    let mut leaf = library("libleaf.so", 1, &[], false);
    leaf.exports
        .insert("leaf_symbol".into(), SymbolValue::main_data("leaf_symbol", 0x10));
    let mut mid = library("libmid.so", 2, &["libleaf.so"], false);
    mid.exports
        .insert("mid_symbol".into(), SymbolValue::main_data("mid_symbol", 0x20));
    scope.insert(leaf).expect("insert");
    scope.insert(mid).expect("insert");

    scope.promote_library_global("libmid.so").expect("promote");
    assert!(scope.library("libleaf.so").expect("leaf").global_visibility);
    assert!(scope.library("libmid.so").expect("mid").global_visibility);
    assert!(scope.global_symbol("leaf_symbol").is_some());
    assert!(scope.global_symbol("mid_symbol").is_some());
}

/// The dependency scope is breadth-first over `DT_NEEDED`, and a cycle
/// terminates instead of recursing.
#[test]
fn the_dependency_scope_is_breadth_first_and_cycle_safe() {
    let mut scope = LinkerScope::new();
    scope.insert(library("a.so", 1, &["b.so", "c.so"], true)).expect("insert");
    scope.insert(library("b.so", 2, &["d.so"], true)).expect("insert");
    scope.insert(library("c.so", 3, &["d.so"], true)).expect("insert");
    // d depends back on a: a legal ELF graph, and one a naive recursion would
    // not survive.
    scope.insert(library("d.so", 4, &["a.so"], true)).expect("insert");

    let order = scope
        .dependency_scope("consumer", &[String::from("a.so")])
        .expect("scope");
    assert_eq!(order, vec!["a.so", "b.so", "c.so", "d.so"]);
}

#[test]
fn a_missing_dependency_is_named_not_guessed() {
    let mut scope = LinkerScope::new();
    scope.insert(library("a.so", 1, &["absent.so"], true)).expect("insert");
    assert_eq!(
        scope.dependency_scope("a.so", &[String::from("a.so")]),
        Err(DylinkError::DependencyMissing {
            library: "a.so".into(),
            dependency: "absent.so".into(),
        })
    );
}

/// D5's data structure: a function's table index comes from the identity wasm
/// already assigns it, not from scanning the table and comparing objects.
#[test]
fn function_table_indexes_come_from_a_map_not_a_scan() {
    let mut scope = LinkerScope::new();
    scope.publish_main_image(
        [],
        [
            (3, InstanceId(0), String::from("on_modify")),
            (4, InstanceId(0), String::from("on_update")),
        ],
        16,
    );
    assert_eq!(scope.function_table_index(InstanceId(0), "on_modify"), Some(3));
    assert_eq!(scope.function_table_index(InstanceId(0), "absent"), None);

    scope.record_function_slot(InstanceId(2), "side_export", 20);
    assert_eq!(scope.function_table_index(InstanceId(2), "side_export"), Some(20));
    // First placement wins: a function keeps the slot the guest already holds.
    scope.record_function_slot(InstanceId(2), "side_export", 21);
    assert_eq!(scope.function_table_index(InstanceId(2), "side_export"), Some(20));
}

/// Rollback restores the scope but NOT the table length: a `WebAssembly.Table`
/// cannot shrink, so the slots stay addressable and the caller nulls them.
#[test]
fn rollback_restores_the_scope_but_not_the_table_length() {
    let mut scope = LinkerScope::new();
    scope.set_table_length(16);
    let snapshot = scope.snapshot();

    scope.insert(library("libnew.so", 1, &[], true)).expect("insert");
    scope.set_table_length(48);
    scope.restore(snapshot);

    assert!(scope.library("libnew.so").is_none());
    assert_eq!(scope.table_length(), 48);
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

#[test]
fn align_up_is_checked() {
    assert_eq!(align_up(0, 16), Ok(0));
    assert_eq!(align_up(1, 16), Ok(16));
    assert_eq!(align_up(16, 16), Ok(16));
    assert_eq!(align_up(17, 16), Ok(32));
    assert!(align_up(1, 0).is_err());
    assert!(align_up(1, 3).is_err(), "alignment must be a power of two");
    assert!(align_up(u64::MAX, 16).is_err(), "overflow is an error, not a wrap");
}

/// Every SDK-built guest that can call `dlopen` supplies an allocator, so it
/// routes address-space growth through the kernel and never grows memory
/// itself.
#[test]
fn an_allocator_backed_process_never_grows_memory_itself() {
    let placement = plan_memory("libtest.so", 4096, 16, None, true, None, 65_536)
        .expect("placement");
    assert_eq!(placement, MemoryPlacement::Allocate { size: 4096, align: 16 });
}

/// The standalone-linker path, for embedders that supply no allocator.
#[test]
fn a_bump_heap_grows_memory_by_whole_pages() {
    let placement = plan_memory("libtest.so", 4096, 16, None, false, Some(65_000), 65_536)
        .expect("placement");
    assert_eq!(
        placement,
        MemoryPlacement::BumpHeap { base: 65_008, end: 69_104, grow_pages: 1 }
    );
}

#[test]
fn no_allocator_and_no_heap_pointer_is_an_error() {
    assert_eq!(
        plan_memory("libtest.so", 4096, 16, None, false, None, 65_536),
        Err(DylinkError::AllocatorUnavailable { library: "libtest.so".into() })
    );
}

/// A fork child reuses the parent's exact base: data relocations baked into the
/// copied data section already encode `parent_base + offset`.
#[test]
fn replay_reuses_the_parents_base() {
    let placement = plan_memory("libtest.so", 4096, 16, Some(0x8000), true, None, 65_536)
        .expect("placement");
    assert_eq!(placement, MemoryPlacement::Replay { base: 0x8000 });
}

#[test]
fn an_allocation_escaping_linear_memory_is_rejected() {
    assert_eq!(check_allocation("libtest.so", 60_000, 8_000, 65_536), Err(
        DylinkError::AllocationEscapesMemory { library: "libtest.so".into() }
    ));
    assert_eq!(check_allocation("libtest.so", 60_000, 5_000, 65_536), Ok(()));
    assert!(check_allocation("libtest.so", u64::MAX, 1, u64::MAX).is_err());
}

#[test]
fn archived_mappings_must_describe_the_modules_own_region() {
    let good = [DylinkAllocation {
        address: 0x8000,
        size: 4096,
        mapping_address: 0x8000,
        mapping_size: 8192,
    }];
    assert_eq!(
        check_archived_allocations("libtest.so", &good, 0x8000, 4096, 65_536, true),
        Ok(())
    );

    let wrong_base = [DylinkAllocation {
        address: 0x9000,
        size: 4096,
        mapping_address: 0x9000,
        mapping_size: 4096,
    }];
    assert_eq!(
        check_archived_allocations("libtest.so", &wrong_base, 0x8000, 4096, 65_536, true),
        Err(DylinkError::ArchivedAllocationMismatch { library: "libtest.so".into() })
    );

    // A process with an allocator must receive mapping ownership; otherwise the
    // child's bookkeeping silently loses the parent's mmap.
    assert_eq!(
        check_archived_allocations("libtest.so", &[], 0x8000, 4096, 65_536, true),
        Err(DylinkError::MissingMappingOwnership { library: "libtest.so".into() })
    );

    let escaping = [DylinkAllocation {
        address: 0x8000,
        size: 4096,
        mapping_address: 0x8000,
        mapping_size: 1_000_000,
    }];
    assert_eq!(
        check_archived_allocations("libtest.so", &escaping, 0x8000, 4096, 65_536, true),
        Err(DylinkError::ArchivedMappingEscapesMemory { library: "libtest.so".into() })
    );
}

/// A parent's successful archive entries carry the next library's exact base,
/// including gaps left by a failed `dlopen`; the child pads up to it.
#[test]
fn replay_pads_the_table_up_to_the_parents_base() {
    let placement = plan_table("libtest.so", 16, 4, Some(32)).expect("placement");
    assert_eq!(placement.base, 32);
    assert_eq!(placement.pad, 16);
    assert_eq!(placement.reserve, 4);
}

/// A table that already grew past the parent's base cannot be reconciled, and
/// says so rather than placing the module somewhere the copied relocations do
/// not point.
#[test]
fn a_table_past_the_parents_base_is_a_truthful_failure() {
    assert_eq!(
        plan_table("libtest.so", 40, 4, Some(32)),
        Err(DylinkError::ReplayTablePastBase {
            library: "libtest.so".into(),
            current: 40,
            parent: 32,
        })
    );
}

#[test]
fn tls_must_sit_inside_the_modules_own_reservation() {
    // Address zero is the archive's explicit "no TLS" sentinel and can never be
    // a real allocation.
    assert!(check_tls("l.so", 0, 16, 8, 0x1000, 0x1000, u64::MAX).is_err());
    assert!(check_tls("l.so", 0x1004, 16, 8, 0x1000, 0x1000, u64::MAX).is_err(), "misaligned");
    assert!(check_tls("l.so", 0x900, 16, 8, 0x1000, 0x1000, u64::MAX).is_err(), "below base");
    assert!(check_tls("l.so", 0x1ff8, 16, 8, 0x1000, 0x1000, u64::MAX).is_err(), "escapes end");
    assert!(check_tls("l.so", 0x1008, 16, 8, 0x1000, 0x1000, u64::MAX).is_ok());
    assert!(check_tls("l.so", 0x1008, 16, 6, 0x1000, 0x1000, u64::MAX).is_err(), "align not 2^n");
}

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------

#[test]
fn repeat_dlopen_bumps_the_reference_count() {
    let mut handles = HandleTable::new();
    let first = handles.open("libtest.so", None).expect("open");
    let second = handles.open("libtest.so", None).expect("open");
    assert_eq!(first, second);
    assert_eq!(handles.reference_count(first), Some(2));

    assert_eq!(
        handles.close(first),
        Ok(CloseOutcome::StillReferenced { library: "libtest.so".into(), remaining: 1 })
    );
    assert_eq!(
        handles.close(first),
        Ok(CloseOutcome::Released { library: "libtest.so".into() })
    );
    assert_eq!(handles.close(first), Err(DylinkError::InvalidHandle { handle: first }));
}

/// `dlclose(dlopen(NULL, ...))` is a no-op, not an error: the main image's
/// pseudo-handle is never refcounted and never closeable.
#[test]
fn the_main_program_handle_is_never_closed() {
    let mut handles = HandleTable::new();
    assert_eq!(handles.close(MAIN_PROGRAM_HANDLE), Ok(CloseOutcome::MainImage));
    assert!(handles.open("libtest.so", None).expect("open") > MAIN_PROGRAM_HANDLE);
}

/// The guest holds the parent's handle values in its own copied memory, so a
/// child must reproduce them exactly rather than renumbering.
#[test]
fn replay_pins_the_parents_exact_handle() {
    let mut handles = HandleTable::new();
    assert_eq!(handles.open("libtest.so", Some(7)), Ok(7));
    // The allocator must not later hand 7 out again.
    assert!(handles.next_handle() > 7);
    assert_eq!(handles.open("libother.so", Some(7)), Err(DylinkError::HandleOutOfRange { handle: 7 }));
    // Re-opening the same library with a different pinned handle is a conflict.
    assert_eq!(
        handles.open("libtest.so", Some(9)),
        Err(DylinkError::HandleOutOfRange { handle: 9 })
    );
    assert_eq!(
        handles.open("libtest.so", Some(MAIN_PROGRAM_HANDLE)),
        Err(DylinkError::HandleOutOfRange { handle: MAIN_PROGRAM_HANDLE })
    );
}

/// An object stays loaded while anything still needs it, even with no handle
/// of its own — POSIX's rule, and the reason the two counts are separate.
#[test]
fn a_dependency_retain_keeps_an_unhandled_object_loaded() {
    let mut handles = HandleTable::new();
    handles
        .rebuild_dependency_edges([
            (String::from("libmid.so"), vec![String::from("libleaf.so")]),
            (String::from("libtop.so"), vec![String::from("libmid.so")]),
        ])
        .expect("edges");
    assert_eq!(handles.dependency_retains("libleaf.so"), 1);
    assert_eq!(handles.dependency_retains("libmid.so"), 1);
    assert_eq!(handles.dependency_retains("libtop.so"), 0);

    assert!(!handles.is_unloadable("libleaf.so"));
    assert!(handles.is_unloadable("libtop.so"));

    handles.open("libmid.so", None).expect("open");
    assert!(!handles.is_unloadable("libmid.so"), "a live handle also retains");

    let candidates = vec![
        String::from("libleaf.so"),
        String::from("libmid.so"),
        String::from("libtop.so"),
    ];
    let unretained: Vec<&str> = handles.unretained(&candidates).collect();
    assert_eq!(unretained, vec!["libtop.so"]);
}

/// Recounting is idempotent: an object whose edges are already counted is not
/// counted twice.
#[test]
fn dependency_edges_are_counted_once_per_object() {
    let mut handles = HandleTable::new();
    let edges = || vec![(String::from("libmid.so"), vec![String::from("libleaf.so")])];
    handles.register_dependency_edges(edges()).expect("edges");
    handles.register_dependency_edges(edges()).expect("edges");
    assert_eq!(handles.dependency_retains("libleaf.so"), 1);

    handles.rebuild_dependency_edges(edges()).expect("edges");
    assert_eq!(handles.dependency_retains("libleaf.so"), 1);
}

/// POSIX `dlerror()` returns the pending message and clears it; a second call
/// with no intervening failure returns nothing.
#[test]
fn dlerror_reports_once() {
    let mut handles = HandleTable::new();
    assert_eq!(handles.take_error(), None);
    handles.set_error("libtest.so: undefined symbol: sapi_module (GOT.mem)");
    assert_eq!(
        handles.take_error().as_deref(),
        Some("libtest.so: undefined symbol: sapi_module (GOT.mem)")
    );
    assert_eq!(handles.take_error(), None);

    // A successful call clears any stale error.
    handles.set_error("stale");
    handles.open("libtest.so", None).expect("open");
    assert_eq!(handles.take_error(), None);
}
