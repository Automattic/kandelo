use fork_instrument::{Options, native};
use wasm_encoder::{CustomSection, Encode};
use wasm_posix_shared::abi;

fn custom(bytes: &[u8], name: &str) -> Vec<u8> {
    wasmparser::Parser::new(0)
        .parse_all(bytes)
        .find_map(|payload| {
            if let wasmparser::Payload::CustomSection(section) = payload.unwrap() {
                if section.name() == name {
                    return Some(section.data().to_vec());
                }
            }
            None
        })
        .unwrap()
}

#[test]
fn complete_native_artifacts_declare_the_same_abi_formats_and_capability_roles() {
    for wide in [false, true] {
        for side in [false, true] {
            let input = wat::parse_str(format!(
                r#"(module
                (import "kernel" "kernel_fork" (func $fork (param i32) (result i32)))
                (memory {} 2)
                (global (mut i64) (i64.const 7))
                (func (export "_start") i32.const 0 call $fork drop))"#,
                if wide { "i64" } else { "" }
            ))
            .unwrap();
            let options = Options {
                entry_import: if side {
                    "env.fork"
                } else {
                    "kernel.kernel_fork"
                }
                .into(),
                ..Default::default()
            };
            let native = native::instrument(&input, &options, Default::default()).unwrap();
            let output = native.bytes.bytes();
            let oracle = fork_instrument::instrument_walrus(&input, &options).unwrap();
            for name in [
                abi::WPK_FORK_CAPABILITIES_SECTION,
                abi::WPK_FORK_MODULE_STATE_FORMAT_SECTION,
                abi::WPK_FORK_UNWIND_TRANSPORT_SECTION,
            ] {
                assert_eq!(custom(output, name), custom(&oracle, name), "{name}");
            }
            let frame = fork_instrument::linked_frames::FrameFormatDescriptor::decode(&custom(
                output,
                abi::WPK_FORK_LINKED_FRAME_FORMAT_SECTION,
            ))
            .unwrap();
            assert_eq!(frame.pointer_width.bytes(), if wide { 8 } else { 4 });
            assert!(native.decision.participates);
            assert!(native.emission.is_some());
            assert_eq!(
                custom(output, "target_features"),
                custom(
                    &fork_instrument::target_features::declare_used_features(output.to_vec())
                        .unwrap(),
                    "target_features"
                )
            );
            assert_eq!(
                output,
                native::instrument(&input, &options, Default::default())
                    .unwrap()
                    .bytes
                    .bytes()
            );
        }
    }
}

#[test]
fn nonparticipant_bytes_keep_padded_headers_and_debug_data_while_losing_facts() {
    let plain = wat::parse_str("(module (func nop))").unwrap();
    let mut input = plain[..8].to_vec();
    // A valid padded empty custom-section length: the name is one empty byte.
    input.extend_from_slice(&[0, 0x81, 0, 0]);
    input.extend_from_slice(&plain[8..]);
    for (name, data) in [
        (".debug_info", &b"preserved"[..]),
        (
            fork_instrument::facts::SECTION,
            &b"not decoded without a fork role"[..],
        ),
    ] {
        input.push(0);
        CustomSection {
            name: name.into(),
            data: data.into(),
        }
        .encode(&mut input);
    }
    let output = native::instrument(&input, &Options::default(), Default::default()).unwrap();
    assert!(!output.decision.participates && output.emission.is_none());
    assert_eq!(
        output.bytes.bytes(),
        fork_instrument::facts::strip_section(&input)
            .unwrap()
            .unwrap()
    );
    assert!(
        output
            .bytes
            .bytes()
            .windows(4)
            .any(|window| window == [0, 0x81, 0, 0])
    );
    assert_eq!(custom(output.bytes.bytes(), ".debug_info"), b"preserved");
}

#[test]
fn feature_writer_matches_the_oracle_and_rejects_negative_or_oversized_declarations() {
    let plain = wat::parse_str("(module (func (result i32 i32) i32.const 1 i32.const 2))").unwrap();
    let mut output = Vec::new();
    fork_instrument::target_features::write_declared_features(&plain, &mut output, 4096).unwrap();
    assert_eq!(
        output,
        fork_instrument::target_features::declare_used_features(plain.clone()).unwrap()
    );
    let mut forbidden = plain.clone();
    forbidden.push(0);
    CustomSection {
        name: "target_features".into(),
        data: (&b"\x01-\x0amultivalue"[..]).into(),
    }
    .encode(&mut forbidden);
    assert!(
        fork_instrument::target_features::write_declared_features(
            &forbidden,
            &mut Vec::new(),
            4096
        )
        .is_err()
    );
    assert!(
        fork_instrument::target_features::write_declared_features(&plain, &mut Vec::new(), 1)
            .is_err()
    );
    assert!(
        native::validate(b"\0asm\x0d\0\x01\0").is_err(),
        "components are not core artifacts"
    );
}

#[test]
fn complete_emission_limits_fail_without_producing_an_artifact() {
    let input = wat::parse_str(
        "(module (import \"kernel\" \"kernel_fork\" (func $fork)) (func call $fork))",
    )
    .unwrap();
    assert!(
        native::instrument(
            &input,
            &Options::default(),
            native::Limits {
                output_bytes: 16,
                ..Default::default()
            }
        )
        .is_err()
    );
    let mut limits = native::Limits::default();
    limits.pipeline.emission.max_spooled_section_bytes = 2;
    let error = native::instrument(&input, &Options::default(), limits)
        .err()
        .unwrap();
    assert!(format!("{error:#}").contains("spool exceeds disk budget"));
}
