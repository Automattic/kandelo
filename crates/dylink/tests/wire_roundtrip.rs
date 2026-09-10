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
