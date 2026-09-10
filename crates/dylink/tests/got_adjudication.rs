//! D4: what an unresolved GOT symbol resolves to.
//!
//! The adjudication and its ELF reasoning are documented in
//! `crates/dylink/src/got.rs`. These tests pin the behaviour on BOTH sides of
//! it — the correct ELF answer, and the legacy answer the differential harness
//! uses to name what changed — so neither can drift silently.
//!
//! Per the value plan's generic-first rule, every case here is stated in terms
//! of ELF symbol binding, not in terms of which symbols any particular library
//! leaves unresolved.

mod support;

use dylink::{
    decide_got_cell, parse_dylink_section, DylinkError, GotInit, GotKind, GotPlacement, GotRequest,
    InstanceId, PointerWidth, ResolvedSymbol, SymbolValue, UnresolvedPolicy, WasmValue,
};
use support::{DylinkSection, SideModule, FLAG_WEAK};

fn metadata_with(imports: Vec<(&str, &str, u32)>) -> dylink::DylinkMetadata {
    let bytes = SideModule {
        dylink: DylinkSection {
            import_info: imports
                .into_iter()
                .map(|(module, field, flags)| (module.into(), field.into(), flags))
                .collect(),
            ..Default::default()
        },
        ..Default::default()
    }
    .encode();
    parse_dylink_section(&bytes).expect("dylink.0")
}

fn request<'a>(
    metadata: &'a dylink::DylinkMetadata,
    kind: GotKind,
    symbol: &'a str,
    resolved: Option<&'a ResolvedSymbol>,
    policy: UnresolvedPolicy,
) -> GotRequest<'a> {
    GotRequest {
        library: "libtest.so",
        metadata,
        kind,
        symbol,
        resolved,
        resolved_table_index: None,
        self_export: false,
        replay_value: None,
        width: PointerWidth::W32,
        policy,
    }
}

fn global(value: SymbolValue, owner: Option<&str>, globally_visible: bool) -> ResolvedSymbol {
    ResolvedSymbol {
        value,
        owner: owner.map(String::from),
        globally_visible,
    }
}

// ---------------------------------------------------------------------------
// D4: the ELF answer
// ---------------------------------------------------------------------------

/// `RTLD_LAZY` never defers a DATA relocation. An undefined, strongly-bound
/// data symbol fails the load with its name, exactly as `dlerror()` would
/// report `undefined symbol: <name>` on any other ELF loader. It does not
/// become a NULL the guest dereferences some unbounded time later.
#[test]
fn a_strong_undefined_data_symbol_fails_the_load() {
    let metadata = metadata_with(vec![("GOT.mem", "sapi_module", 0)]);
    let error = decide_got_cell(request(
        &metadata,
        GotKind::Mem,
        "sapi_module",
        None,
        UnresolvedPolicy::ElfStrict,
    ))
    .expect_err("a strong undefined data symbol must fail the load");
    assert_eq!(
        error,
        DylinkError::UndefinedSymbol {
            library: "libtest.so".into(),
            symbol: "sapi_module".into(),
            kind: "mem",
        }
    );
    assert_eq!(
        alloc_to_string(&error),
        "libtest.so: undefined symbol: sapi_module (GOT.mem)"
    );
}

/// A `GOT.func` cell holds the value of `&func` as stored in data — in ELF
/// terms an address-take, which is a `GLOB_DAT` data relocation resolved
/// eagerly under every mode. There is no wasm PLT and no resolver stub, so
/// there is no mechanism by which it could be lazily bound.
#[test]
fn a_strong_undefined_function_address_fails_the_load() {
    let metadata = metadata_with(vec![("GOT.func", "on_modify", 0)]);
    let error = decide_got_cell(request(
        &metadata,
        GotKind::Func,
        "on_modify",
        None,
        UnresolvedPolicy::ElfStrict,
    ))
    .expect_err("a strong undefined function address must fail the load");
    assert!(matches!(error, DylinkError::UndefinedSymbol { .. }));
}

/// The one ELF case in which zero is correct: `STB_WEAK` + `SHN_UNDEF` has
/// value 0 by specification, raises no error, and C code is expected to test
/// `if (&sym)`. `dylink.0` records exactly this per import.
#[test]
fn a_weak_undefined_symbol_is_zero_with_no_error() {
    let metadata = metadata_with(vec![
        ("GOT.mem", "optional_config", FLAG_WEAK),
        ("GOT.func", "optional_hook", FLAG_WEAK),
    ]);
    for (kind, symbol) in [(GotKind::Mem, "optional_config"), (GotKind::Func, "optional_hook")] {
        let decision = decide_got_cell(request(
            &metadata,
            kind,
            symbol,
            None,
            UnresolvedPolicy::ElfStrict,
        ))
        .expect("a weak undefined symbol is not an error");
        assert_eq!(decision.init, GotInit::WeakZero);
        assert_eq!(decision.init.value(PointerWidth::W32), Ok(WasmValue::I32(0)));
    }
}

/// The legacy policy exists ONLY so the differential harness can name every
/// symbol whose treatment changed. No product path selects it.
#[test]
fn the_legacy_policy_reproduces_the_typescript_zero() {
    let metadata = metadata_with(vec![("GOT.mem", "sapi_module", 0)]);
    let decision = decide_got_cell(request(
        &metadata,
        GotKind::Mem,
        "sapi_module",
        None,
        UnresolvedPolicy::LegacyZero,
    ))
    .expect("the legacy policy never fails");
    assert_eq!(decision.init, GotInit::WeakZero);
}

/// A symbol the module defines itself is NOT unresolved — the definition
/// exists, it is simply not observable until the instance's exports are read.
/// Failing it under the strict policy would reject every self-referencing
/// module.
#[test]
fn a_self_defined_symbol_is_pending_not_undefined() {
    let metadata = metadata_with(vec![("GOT.func", "my_callback", 0)]);
    let mut req = request(
        &metadata,
        GotKind::Func,
        "my_callback",
        None,
        UnresolvedPolicy::ElfStrict,
    );
    req.self_export = true;
    let decision = decide_got_cell(req).expect("a self definition is not undefined");
    assert_eq!(decision.init, GotInit::PendingSelfDefinition);
    assert!(decision.self_definition);
    // It is instance-local: publishing an interposable self-definition into the
    // process-global table would let it interpose for objects that cannot see it.
    assert_eq!(decision.placement, GotPlacement::Local);
}

/// A resolved provider that has no table slot yet is likewise pending, never
/// zero: the function exists and the planner appends a slot for it.
#[test]
fn a_resolved_function_without_a_slot_is_pending_not_zero() {
    let metadata = metadata_with(vec![("GOT.func", "handler", 0)]);
    let resolved = global(
        SymbolValue::Func { instance: InstanceId(0), export: "handler".into() },
        None,
        true,
    );
    let decision = decide_got_cell(request(
        &metadata,
        GotKind::Func,
        "handler",
        Some(&resolved),
        UnresolvedPolicy::ElfStrict,
    ))
    .expect("a resolved function is never undefined");
    assert_eq!(decision.init, GotInit::PendingSelfDefinition);
}

// ---------------------------------------------------------------------------
// Kind agreement, which D4 does not affect
// ---------------------------------------------------------------------------

#[test]
fn a_data_symbol_cannot_satisfy_a_function_address() {
    let metadata = metadata_with(vec![("GOT.func", "value", 0)]);
    let resolved = global(SymbolValue::Data { address: 0x1000 }, None, true);
    assert_eq!(
        decide_got_cell(request(
            &metadata,
            GotKind::Func,
            "value",
            Some(&resolved),
            UnresolvedPolicy::ElfStrict,
        )),
        Err(DylinkError::SymbolKindMismatch {
            library: "libtest.so".into(),
            symbol: "value".into(),
            expected: "function",
        })
    );
}

#[test]
fn a_function_cannot_satisfy_a_data_address() {
    let metadata = metadata_with(vec![("GOT.mem", "table", 0)]);
    let resolved = global(
        SymbolValue::Func { instance: InstanceId(1), export: "table".into() },
        Some("libother.so"),
        true,
    );
    assert!(matches!(
        decide_got_cell(request(
            &metadata,
            GotKind::Mem,
            "table",
            Some(&resolved),
            UnresolvedPolicy::ElfStrict,
        )),
        Err(DylinkError::SymbolKindMismatch { .. })
    ));
}

// ---------------------------------------------------------------------------
// Placement: shared vs instance-local
// ---------------------------------------------------------------------------

/// A globally-visible provider may take the process-shared cell.
#[test]
fn a_globally_resolved_symbol_shares_its_cell() {
    let metadata = metadata_with(vec![("GOT.mem", "environ", 0)]);
    let resolved = global(SymbolValue::Data { address: 0x2000 }, None, true);
    let decision = decide_got_cell(request(
        &metadata,
        GotKind::Mem,
        "environ",
        Some(&resolved),
        UnresolvedPolicy::ElfStrict,
    ))
    .expect("resolved");
    assert_eq!(decision.placement, GotPlacement::Shared);
    assert_eq!(decision.init, GotInit::Resolved(WasmValue::I32(0x2000)));
    assert_eq!(decision.provider, None);
}

/// An `RTLD_LOCAL` provider must NOT. The global table is
/// first-definition-wins, so publishing a local provider there would let it
/// interpose for objects that cannot see it.
#[test]
fn a_locally_resolved_symbol_takes_an_instance_local_cell() {
    let metadata = metadata_with(vec![("GOT.mem", "private_state", 0)]);
    let resolved = global(
        SymbolValue::Data { address: 0x3000 },
        Some("libprivate.so"),
        false,
    );
    let decision = decide_got_cell(request(
        &metadata,
        GotKind::Mem,
        "private_state",
        Some(&resolved),
        UnresolvedPolicy::ElfStrict,
    ))
    .expect("resolved");
    assert_eq!(decision.placement, GotPlacement::Local);
    // The provider becomes an explicit lifetime edge, because a fork child
    // cannot re-derive a runtime provider relationship.
    assert_eq!(decision.provider.as_deref(), Some("libprivate.so"));
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/// Funcref identity in a fork child must match the parent exactly, so an
/// archived value wins over anything the planner would re-derive — including
/// over a resolution that looks better now.
#[test]
fn an_archived_value_wins_over_fresh_resolution() {
    let metadata = metadata_with(vec![("GOT.func", "callback", 0)]);
    let resolved = global(
        SymbolValue::Func { instance: InstanceId(2), export: "callback".into() },
        Some("libother.so"),
        true,
    );
    let mut req = request(
        &metadata,
        GotKind::Func,
        "callback",
        Some(&resolved),
        UnresolvedPolicy::ElfStrict,
    );
    req.resolved_table_index = Some(9);
    req.replay_value = Some(WasmValue::I32(41));
    let decision = decide_got_cell(req).expect("replay");
    assert_eq!(decision.init, GotInit::Resolved(WasmValue::I32(41)));
}

/// A wasm64 process's cells are `i64`, and an address that does not fit the
/// process pointer width is an error rather than a truncation.
#[test]
fn pointer_width_is_honoured_in_both_directions() {
    let metadata = metadata_with(vec![("GOT.mem", "big", 0)]);
    let resolved = global(SymbolValue::Data { address: 0x1_0000_0000 }, None, true);
    let mut req = request(
        &metadata,
        GotKind::Mem,
        "big",
        Some(&resolved),
        UnresolvedPolicy::ElfStrict,
    );
    req.width = PointerWidth::W64;
    let decision = decide_got_cell(req).expect("wasm64");
    assert_eq!(decision.init, GotInit::Resolved(WasmValue::I64(0x1_0000_0000)));

    let mut narrow = request(
        &metadata,
        GotKind::Mem,
        "big",
        Some(&resolved),
        UnresolvedPolicy::ElfStrict,
    );
    narrow.width = PointerWidth::W32;
    assert!(decide_got_cell(narrow).is_err());
}

fn alloc_to_string(error: &DylinkError) -> String {
    use std::fmt::Write;
    let mut rendered = String::new();
    write!(&mut rendered, "{error}").expect("format");
    rendered
}
