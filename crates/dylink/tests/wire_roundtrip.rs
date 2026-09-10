//! The `PlanStep` / `ActResult` wire format.
//!
//! This is the ONE boundary in K5's design that is crossed by bytes rather than
//! by a Rust `match`: the planner is wasm and the JavaScript executor is not,
//! so `dl_step` writes a record the driver reads back. Everything asserted here
//! is a property the two sides silently disagreeing about would corrupt a
//! `dlopen` rather than fail it.
//!
//! Three families:
//!
//! 1. **Round-trip fidelity** for every variant of every enum, so a driver
//!    written against this format and a native executor matching on the enum
//!    cannot mean different things by the same bytes.
//! 2. **Truncation is an error**, at every prefix of a valid record. The
//!    TypeScript readers this crate replaces index past the end of a
//!    `Uint8Array` and yield `undefined`; a `dlopen` built on that reads a
//!    garbage address rather than failing.
//! 3. **The ordered-binding invariant survives the encoding**, which is the
//!    single correctness risk the K5 grounding named for the whole item.

use dylink::act::{
    ActResult, BindingValue, GlobalId, ImportBinding, InstanceExport, InstanceId, LinkAct, ModuleId,
    ModuleSource, TableValue, TagId, WasmValue,
};
use dylink::plan::{HostRequest, InitializationStage, PlanStep, StagedCall};
use dylink::wasm::{ExternKind, ValType};
use dylink::wire::{decode_act_result, decode_plan_step, encode_act_result, encode_plan_step};

use fork_codec::dylink_archive::DylinkAllocation;

fn binding(position: u32, module: &str, name: &str, value: BindingValue, dup: bool) -> ImportBinding {
    ImportBinding {
        position,
        module: module.into(),
        name: name.into(),
        kind: ExternKind::Func,
        value,
        duplicate_occurrence: dup,
    }
}

/// Every `PlanStep` shape the planner can emit, including one act of each kind.
fn every_step() -> Vec<PlanStep> {
    vec![
        PlanStep::Finished,
        PlanStep::Act(LinkAct::Compile {
            module: ModuleId(3),
            source: ModuleSource::Original,
        }),
        PlanStep::Act(LinkAct::Compile {
            module: ModuleId(4),
            source: ModuleSource::Rewritten(vec![0, 97, 115, 109, 1, 0, 0, 0]),
        }),
        PlanStep::Act(LinkAct::NewGlobal {
            global: GlobalId(7),
            ty: ValType::I32,
            mutable: false,
            init: WasmValue::I32(0x1234_5678),
        }),
        PlanStep::Act(LinkAct::NewGlobal {
            global: GlobalId(8),
            ty: ValType::Opaque(0x7b),
            mutable: true,
            init: WasmValue::I64(u64::MAX),
        }),
        PlanStep::Act(LinkAct::ReadGlobal {
            global: GlobalId(9),
        }),
        PlanStep::Act(LinkAct::WriteGlobal {
            global: GlobalId(10),
            value: WasmValue::I64(1 << 40),
        }),
        PlanStep::Act(LinkAct::GrowTable { delta: 12 }),
        PlanStep::Act(LinkAct::WriteTable {
            index: 5,
            value: TableValue::Null,
        }),
        PlanStep::Act(LinkAct::WriteTable {
            index: 6,
            value: TableValue::Export {
                instance: InstanceId(2),
                name: "php_module_startup".into(),
            },
        }),
        PlanStep::Act(LinkAct::GrowMemory { delta_pages: 17 }),
        PlanStep::Act(LinkAct::NewTag {
            tag: TagId(1),
            parameters: vec![ValType::I32, ValType::I64, ValType::F32, ValType::F64],
        }),
        PlanStep::Act(LinkAct::NewTag {
            tag: TagId(2),
            parameters: vec![],
        }),
        PlanStep::Act(LinkAct::Instantiate {
            module: ModuleId(4),
            instance: InstanceId(5),
            bindings: vec![
                binding(0, "env", "memory", BindingValue::ProcessMemory, false),
                binding(1, "env", "__indirect_function_table", BindingValue::ProcessTable, false),
                binding(2, "env", "__stack_pointer", BindingValue::ProcessStackPointer, false),
                binding(3, "GOT.mem", "shared_data", BindingValue::Global(GlobalId(11)), false),
                binding(4, "env", "__c_longjmp", BindingValue::Tag(TagId(1)), false),
                binding(
                    5,
                    "env",
                    "zend_hash_find",
                    BindingValue::Export {
                        instance: InstanceId(0),
                        name: "zend_hash_find".into(),
                    },
                    false,
                ),
                binding(6, "env", "interposable", BindingValue::SelfImport { name: "interposable".into() }, false),
                binding(7, "env", "fork", BindingValue::ActivationEnv { name: "fork".into() }, false),
                binding(8, "env", "maybe_absent", BindingValue::WeakUndefined, false),
                // The second occurrence of an already-bound (module, name).
                binding(9, "env", "interposable", BindingValue::SelfImport { name: "interposable".into() }, true),
            ],
        }),
        PlanStep::Act(LinkAct::ReadExports {
            instance: InstanceId(5),
        }),
        PlanStep::Act(LinkAct::ZeroMemory {
            address: 0x1_0000,
            length: 4096,
        }),
        PlanStep::Host(HostRequest::AllocateMemory {
            library: "opcache.so".into(),
            size: 65536,
            align: 16,
        }),
        PlanStep::Host(HostRequest::AdoptMapping {
            library: "opcache.so".into(),
            allocation: DylinkAllocation {
                address: 0x2_0000,
                size: 4096,
                mapping_address: 0x2_0000,
                mapping_size: 65536,
            },
        }),
        PlanStep::Host(HostRequest::ReleaseMapping {
            library: "opcache.so".into(),
            allocation: DylinkAllocation {
                address: 1,
                size: 2,
                mapping_address: 3,
                mapping_size: 4,
            },
        }),
        PlanStep::Host(HostRequest::PrepareActivation {
            library: "opcache.so".into(),
            replay_activation_id: None,
        }),
        PlanStep::Host(HostRequest::PrepareActivation {
            library: "opcache.so".into(),
            replay_activation_id: Some(9),
        }),
        PlanStep::Host(HostRequest::RegisterActivation {
            library: "opcache.so".into(),
            activation: 9,
            instance: InstanceId(5),
        }),
        PlanStep::Host(HostRequest::UnregisterActivation {
            library: "opcache.so".into(),
            activation: 9,
        }),
        PlanStep::Host(HostRequest::JournalTableMutation {
            first_index: 1024,
            length: 8,
        }),
        PlanStep::Call(StagedCall {
            library: "opcache.so".into(),
            stage: InitializationStage::Bootstrap,
            instance: InstanceId(5),
            export: InitializationStage::Bootstrap.export_name(),
        }),
        PlanStep::Call(StagedCall {
            library: "opcache.so".into(),
            stage: InitializationStage::Relocations,
            instance: InstanceId(5),
            export: InitializationStage::Relocations.export_name(),
        }),
        PlanStep::Call(StagedCall {
            library: "opcache.so".into(),
            stage: InitializationStage::Constructors,
            instance: InstanceId(5),
            export: InitializationStage::Constructors.export_name(),
        }),
    ]
}

fn every_result() -> Vec<ActResult> {
    vec![
        ActResult::Done,
        ActResult::Value(WasmValue::I32(0)),
        ActResult::Value(WasmValue::I64(u64::MAX)),
        ActResult::Index(0),
        ActResult::Index(u64::MAX),
        ActResult::Exports(vec![]),
        ActResult::Exports(vec![
            InstanceExport::func("php_module_startup"),
            InstanceExport::global("__memory_base", WasmValue::I32(0x1_0000), false),
            InstanceExport::global("errno_location", WasmValue::I64(1 << 33), true),
            InstanceExport {
                name: "some_tag".into(),
                kind: ExternKind::Tag,
                value: None,
                mutable: None,
            },
            InstanceExport {
                name: "a_table".into(),
                kind: ExternKind::Table,
                value: None,
                mutable: None,
            },
            InstanceExport {
                name: "a_memory".into(),
                kind: ExternKind::Memory,
                value: None,
                mutable: None,
            },
        ]),
    ]
}

#[test]
fn every_plan_step_round_trips() {
    for step in every_step() {
        let bytes = encode_plan_step(&step).expect("encode");
        let decoded = decode_plan_step(&bytes).expect("decode");
        assert_eq!(decoded, step, "round trip changed the step");
    }
}

#[test]
fn every_act_result_round_trips() {
    for result in every_result() {
        let bytes = encode_act_result(&result).expect("encode");
        let decoded = decode_act_result(&bytes).expect("decode");
        assert_eq!(decoded, result, "round trip changed the result");
    }
}

/// Every proper prefix of every valid record must be rejected. This is the
/// property that distinguishes a bounds-checked reader from one that reads
/// `undefined` off the end and carries a garbage address into a relocation.
#[test]
fn truncation_is_always_an_error_never_a_silent_value() {
    for step in every_step() {
        let bytes = encode_plan_step(&step).expect("encode");
        for cut in 0..bytes.len() {
            assert!(
                decode_plan_step(&bytes[..cut]).is_err(),
                "a {cut}-byte prefix of {step:?} decoded instead of failing",
            );
        }
    }
    for result in every_result() {
        let bytes = encode_act_result(&result).expect("encode");
        for cut in 0..bytes.len() {
            assert!(
                decode_act_result(&bytes[..cut]).is_err(),
                "a {cut}-byte prefix of {result:?} decoded instead of failing",
            );
        }
    }
}

/// A record with anything after it is a disagreement about the format, not a
/// record with padding. Accepting it would let one side add a field the other
/// silently drops.
#[test]
fn trailing_bytes_are_rejected() {
    for step in every_step() {
        let mut bytes = encode_plan_step(&step).expect("encode");
        bytes.push(0);
        assert!(decode_plan_step(&bytes).is_err(), "trailing byte accepted for {step:?}");
    }
    for result in every_result() {
        let mut bytes = encode_act_result(&result).expect("encode");
        bytes.push(0);
        assert!(decode_act_result(&bytes).is_err(), "trailing byte accepted for {result:?}");
    }
}

/// Unknown discriminants must fail rather than fall through to a default. A
/// driver one version ahead of the planner is a bug to surface, not to absorb.
#[test]
fn unknown_discriminants_are_rejected() {
    assert!(decode_plan_step(&[4]).is_err(), "unknown plan step tag accepted");
    assert!(decode_act_result(&[4]).is_err(), "unknown act result tag accepted");
    // Unknown act kind inside a known Act step.
    assert!(decode_plan_step(&[0, 99]).is_err(), "unknown link act tag accepted");
    // Unknown host request inside a known Host step.
    assert!(decode_plan_step(&[1, 99]).is_err(), "unknown host request tag accepted");
}

/// The one behaviour the fork seam depends on: duplicate `(module, name)`
/// declarations stay distinct, keep their positions, and keep the flag that
/// tells a counting `Proxy` which read this entry answers. Collapsing them —
/// which any name-keyed encoding would do — captures the wrong provider.
#[test]
fn duplicate_bindings_survive_the_encoding_in_order() {
    let step = every_step()
        .into_iter()
        .find(|step| matches!(step, PlanStep::Act(LinkAct::Instantiate { .. })))
        .expect("an Instantiate step");
    let bytes = encode_plan_step(&step).expect("encode");
    let PlanStep::Act(LinkAct::Instantiate { bindings, .. }) =
        decode_plan_step(&bytes).expect("decode")
    else {
        panic!("decoded a different step kind");
    };

    assert_eq!(bindings.len(), 10, "one entry per declaration");
    for (index, bound) in bindings.iter().enumerate() {
        assert_eq!(
            bound.position, index as u32,
            "position must restate the vector index after decoding",
        );
    }

    let interposable: Vec<&ImportBinding> = bindings
        .iter()
        .filter(|bound| bound.module == "env" && bound.name == "interposable")
        .collect();
    assert_eq!(interposable.len(), 2, "the duplicate pair was collapsed");
    assert_eq!(interposable[0].position, 6);
    assert!(!interposable[0].duplicate_occurrence, "first read is not a duplicate");
    assert_eq!(interposable[1].position, 9);
    assert!(interposable[1].duplicate_occurrence, "second read must be flagged");
}

/// `ModuleSource::Original` deliberately carries no bytes: the driver already
/// holds the caller's image. A `Compile` of a multi-megabyte `.so` must
/// therefore encode to a handful of bytes, not to a second copy.
#[test]
fn compiling_the_original_image_transfers_no_bytes() {
    let original = encode_plan_step(&PlanStep::Act(LinkAct::Compile {
        module: ModuleId(1),
        source: ModuleSource::Original,
    }))
    .expect("encode");
    assert_eq!(
        original.len(),
        // step tag + act tag + module id + source tag
        1 + 1 + 4 + 1,
        "Original must be tags and an id only",
    );

    let rewritten = encode_plan_step(&PlanStep::Act(LinkAct::Compile {
        module: ModuleId(1),
        source: ModuleSource::Rewritten(vec![7; 1000]),
    }))
    .expect("encode");
    assert_eq!(
        rewritten.len(),
        original.len() + 4 + 1000,
        "Rewritten must carry exactly its bytes and a length",
    );
}

/// `StagedCall::export` is derived from the stage rather than transferred, so
/// the encoder is the place a planner bug pairing the two wrongly is caught.
#[test]
fn a_staged_call_whose_export_contradicts_its_stage_is_refused() {
    let mismatched = PlanStep::Call(StagedCall {
        library: "opcache.so".into(),
        stage: InitializationStage::Constructors,
        instance: InstanceId(1),
        export: InitializationStage::Bootstrap.export_name(),
    });
    assert!(
        encode_plan_step(&mismatched).is_err(),
        "an export that does not match its stage must not encode",
    );
}

/// A corrupt vector length must fail on the bounds check rather than attempt a
/// huge allocation first.
#[test]
fn a_vector_length_larger_than_the_record_is_rejected() {
    // ReadExports answered with a claimed 0xFFFF_FFFF exports and no payload.
    let mut bytes = vec![3u8];
    bytes.extend_from_slice(&u32::MAX.to_le_bytes());
    assert!(
        decode_act_result(&bytes).is_err(),
        "an impossible export count must be rejected",
    );
}

// ---------------------------------------------------------------------------
// Session records
// ---------------------------------------------------------------------------
//
// The records above cross the boundary once per ACT. These cross it once per
// SESSION: the process config, the main image, one `dlopen` request, and the
// `dlsym` / `dlclose` answers. They carry the fields a driver is most likely to
// drop silently -- every one of them is `Option`-shaped or a collection -- so
// the same three families apply.

use dylink::got::UnresolvedPolicy;
use dylink::handles::CloseOutcome;
use dylink::plan::{LinkerConfig, LoadRequest, ReplayInputs};
use dylink::scope::{DataBinding, ResolvedSymbol, SymbolValue};
use dylink::wire::{
    decode_close_outcome, decode_linker_config, decode_load_request, decode_main_image,
    decode_resolved_symbol, encode_close_outcome, encode_linker_config, encode_load_request,
    encode_main_image, encode_resolved_symbol, MainImage,
};

fn every_config() -> Vec<LinkerConfig> {
    vec![
        LinkerConfig::default(),
        LinkerConfig {
            pointer_width: dylink::act::PointerWidth::W64,
            has_allocator: false,
            fork_activation_available: true,
            fork_activation_unavailable_reason: String::new(),
            unresolved_policy: UnresolvedPolicy::LegacyZero,
            memory_bytes: 1 << 32,
            shared_memory: true,
            heap_pointer: Some(0xdead_beef),
        },
    ]
}

#[test]
fn every_linker_config_round_trips() {
    for config in every_config() {
        let bytes = encode_linker_config(&config).expect("encode config");
        let decoded = decode_linker_config(&bytes).expect("decode config");
        assert_eq!(decoded.pointer_width, config.pointer_width);
        assert_eq!(decoded.has_allocator, config.has_allocator);
        assert_eq!(
            decoded.fork_activation_available,
            config.fork_activation_available
        );
        assert_eq!(
            decoded.fork_activation_unavailable_reason,
            config.fork_activation_unavailable_reason
        );
        assert_eq!(decoded.unresolved_policy, config.unresolved_policy);
        assert_eq!(decoded.memory_bytes, config.memory_bytes);
        assert_eq!(decoded.shared_memory, config.shared_memory);
        assert_eq!(decoded.heap_pointer, config.heap_pointer);
    }
}

/// The `heap_pointer` embedder case is the one a driver is most likely to drop:
/// `None` and `Some(0)` are different process states (no allocator vs a heap
/// that starts at zero) and they must not encode to the same bytes.
#[test]
fn an_absent_heap_pointer_is_distinct_from_a_zero_one() {
    let absent = LinkerConfig {
        heap_pointer: None,
        ..LinkerConfig::default()
    };
    let zero = LinkerConfig {
        heap_pointer: Some(0),
        ..LinkerConfig::default()
    };
    assert_ne!(
        encode_linker_config(&absent).expect("encode absent"),
        encode_linker_config(&zero).expect("encode zero"),
        "no allocator and a zero-based heap must not encode identically",
    );
}

fn every_symbol() -> Vec<ResolvedSymbol> {
    vec![
        ResolvedSymbol {
            value: SymbolValue::main_data("environ", 0x1000),
            owner: None,
            globally_visible: true,
        },
        ResolvedSymbol {
            value: SymbolValue::Data {
                address: 0xffff_ffff_ffff,
                binding: DataBinding::Global(GlobalId(7)),
            },
            owner: Some("opcache.so".into()),
            globally_visible: false,
        },
        ResolvedSymbol {
            value: SymbolValue::Func {
                instance: InstanceId(3),
                export: "zend_extension_entry".into(),
            },
            owner: Some("opcache.so".into()),
            globally_visible: true,
        },
    ]
}

#[test]
fn every_resolved_symbol_round_trips() {
    for symbol in every_symbol() {
        let bytes = encode_resolved_symbol(Some(&symbol)).expect("encode symbol");
        let decoded = decode_resolved_symbol(&bytes).expect("decode symbol");
        assert_eq!(decoded.as_ref(), Some(&symbol));
    }
}

/// A `dlsym` miss is an ordinary POSIX answer, not a transport failure, so it
/// must decode as `None` rather than as an error.
#[test]
fn a_dlsym_miss_round_trips_as_an_answer_not_an_error() {
    let bytes = encode_resolved_symbol(None).expect("encode miss");
    assert_eq!(decode_resolved_symbol(&bytes).expect("decode miss"), None);
}

#[test]
fn a_main_image_round_trips_with_its_element_segment_map() {
    let image = MainImage {
        table_length: 4096,
        exports: vec![
            ("environ".into(), SymbolValue::main_data("environ", 0x2000)),
            (
                "malloc".into(),
                SymbolValue::Func {
                    instance: InstanceId(0),
                    export: "malloc".into(),
                },
            ),
        ],
        element_slots: vec![
            (12, InstanceId(0), "malloc".into()),
            (13, InstanceId(0), "free".into()),
        ],
    };
    let bytes = encode_main_image(&image).expect("encode main image");
    assert_eq!(decode_main_image(&bytes).expect("decode main image"), image);
}

fn a_replay() -> ReplayInputs {
    let mut saved_got_func = std::collections::BTreeMap::new();
    saved_got_func.insert("zend_hash_add".to_string(), WasmValue::I32(0x40));
    ReplayInputs {
        memory_base: 0x10_0000,
        table_base: 512,
        activation_id: Some(3),
        tls_base: Some(0x20_0000),
        global_visibility: true,
        committed_global_root: true,
        provider_dependencies: vec!["libc.so".into()],
        allocations: vec![DylinkAllocation {
            address: 0x10_0000,
            size: 0x1000,
            mapping_address: 0x10_0000,
            mapping_size: 0x1000,
        }],
        initialization_stage: Some(InitializationStage::Constructors),
        saved_got_func,
    }
}

#[test]
fn a_load_request_round_trips_with_and_without_replay() {
    for replay in [None, Some(a_replay())] {
        let request = LoadRequest {
            name: "opcache.so".into(),
            module_bytes: vec![0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0],
            global_visibility: false,
            replay: replay.clone(),
            borrowed_memory: true,
        };
        let bytes = encode_load_request(&request).expect("encode request");
        let decoded = decode_load_request(&bytes).expect("decode request");
        assert_eq!(decoded.name, request.name);
        assert_eq!(decoded.module_bytes, request.module_bytes);
        assert_eq!(decoded.global_visibility, request.global_visibility);
        assert_eq!(decoded.borrowed_memory, request.borrowed_memory);
        match (&decoded.replay, &replay) {
            (None, None) => {}
            (Some(decoded), Some(expected)) => assert_eq!(decoded, expected),
            _ => panic!("replay presence did not survive the encoding"),
        }
    }
}

/// The saved `GOT.func` map is the field whose LOSS is silent: a fork child
/// that re-derives a funcref instead of restoring the parent's gets a callable
/// with a different identity, and nothing fails until a comparison does.
#[test]
fn saved_got_func_entries_survive_a_load_request_round_trip() {
    let request = LoadRequest {
        name: "opcache.so".into(),
        module_bytes: Vec::new(),
        global_visibility: true,
        replay: Some(a_replay()),
        borrowed_memory: false,
    };
    let bytes = encode_load_request(&request).expect("encode request");
    let decoded = decode_load_request(&bytes).expect("decode request");
    let replay = decoded.replay.expect("replay survived");
    assert_eq!(
        replay.saved_got_func.get("zend_hash_add"),
        Some(&WasmValue::I32(0x40)),
    );
}

#[test]
fn every_close_outcome_round_trips() {
    for outcome in [
        CloseOutcome::MainImage,
        CloseOutcome::StillReferenced {
            library: "opcache.so".into(),
            remaining: 2,
        },
        CloseOutcome::Released {
            library: "opcache.so".into(),
        },
    ] {
        let bytes = encode_close_outcome(&outcome).expect("encode outcome");
        assert_eq!(
            decode_close_outcome(&bytes).expect("decode outcome"),
            outcome
        );
    }
}

/// Truncation, for the session records too. Every prefix of a valid record must
/// be an error rather than a partially-populated value: a `LoadRequest` decoded
/// from a short buffer with `replay: None` silently turns a fork replay into a
/// fresh load.
#[test]
fn every_prefix_of_a_session_record_is_rejected() {
    let request = LoadRequest {
        name: "opcache.so".into(),
        module_bytes: vec![1, 2, 3, 4],
        global_visibility: true,
        replay: Some(a_replay()),
        borrowed_memory: false,
    };
    let bytes = encode_load_request(&request).expect("encode request");
    for cut in 0..bytes.len() {
        assert!(
            decode_load_request(&bytes[..cut]).is_err(),
            "a {cut}-byte prefix of a load request must not decode",
        );
    }

    let config = LinkerConfig::default();
    let bytes = encode_linker_config(&config).expect("encode config");
    for cut in 0..bytes.len() {
        assert!(
            decode_linker_config(&bytes[..cut]).is_err(),
            "a {cut}-byte prefix of a linker config must not decode",
        );
    }
}

/// Trailing bytes are a disagreement about the format, not a harmless suffix.
#[test]
fn a_session_record_with_trailing_bytes_is_rejected() {
    let mut bytes = encode_close_outcome(&CloseOutcome::MainImage).expect("encode outcome");
    bytes.push(0);
    assert!(
        decode_close_outcome(&bytes).is_err(),
        "trailing bytes must be rejected, not ignored",
    );
}
