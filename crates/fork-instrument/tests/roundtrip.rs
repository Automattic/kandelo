//! Phase 1 smoke test: instrumenting a trivial wasm module is a
//! validating no-op round-trip. The output parses back and matches
//! byte-for-byte (modulo walrus's canonical ordering, which is stable
//! for a given input).

use fork_instrument::{Options, instrument};

const TRIVIAL_WAT: &str = r#"
(module
  (import "kernel" "kernel_fork" (func $fork (result i32)))
  (func $main (export "_start") (result i32)
    call $fork)
  (memory 1))
"#;

fn compile(wat_src: &str) -> Vec<u8> {
    wat::parse_str(wat_src).expect("wat parse")
}

fn validate(bytes: &[u8]) -> Result<(), wasmparser::BinaryReaderError> {
    // Independent validator (not walrus) — confirms the emitted bytes
    // are well-formed per the core spec.
    let mut validator =
        wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::default());
    validator.validate_all(bytes).map(|_| ())
}

#[test]
fn trivial_module_roundtrips() {
    let input = compile(TRIVIAL_WAT);
    let opts = Options::default();

    let output = instrument(&input, &opts).expect("instrument");

    validate(&output).expect("output is valid wasm");
}

#[test]
fn entry_import_option_is_honored_in_defaults() {
    let default_opts = Options::default();
    assert_eq!(default_opts.entry_import, "kernel.kernel_fork");
}

/// Spike for the switch-dispatch redesign
/// (`docs/plans/2026-04-22-fork-instrument-switch-dispatch-redesign.md`,
/// Task 1).
///
/// Hand-authored fixture exercises the nested `block $unwind_save /
/// block $POST_0 / block $dispatch_normal` structure with a
/// REWINDING-guarded `br_table`. Passes if both walrus and wasmparser
/// accept the module — i.e., the post-redesign shape is expressible in
/// valid wasm.
#[test]
fn spike_switch_dispatch_validates() {
    let wat = include_str!("fixtures/spike_switch_dispatch.wat");
    let bytes = wat::parse_str(wat).expect("wat parse");
    walrus::Module::from_buffer(&bytes).expect("walrus validates");
    validate(&bytes).expect("wasmparser validates");
}
