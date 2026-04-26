//! Dual-validator oracle for fork-instrument fuzzing.
//!
//! Given a wasm binary `bytes`, runs the instrumenter and asserts the
//! output validates under both wasmparser (independent) and walrus
//! (re-parse). Any instrumenter panic or validator rejection of the
//! output is a finding.
//!
//! `preflight_bytes` is a cheap input filter: if the generator produced
//! garbage that doesn't validate as wasm in the first place, the
//! instrumenter is not under test for that input and we bail silently.

use fork_instrument::{Options, instrument};

pub fn preflight_bytes(bytes: &[u8]) -> bool {
    let mut v = wasmparser::Validator::new_with_features(
        wasmparser::WasmFeatures::default(),
    );
    v.validate_all(bytes).is_ok()
}

pub fn run_oracle(bytes: &[u8]) {
    if !preflight_bytes(bytes) {
        return;
    }
    let output = match instrument(bytes, &Options::default()) {
        Ok(o) => o,
        Err(e) => panic!("instrument() returned error: {e:#}"),
    };
    // Oracle #1: independent wasmparser validator.
    let mut v = wasmparser::Validator::new_with_features(
        wasmparser::WasmFeatures::default(),
    );
    v.validate_all(&output)
        .expect("instrumented output failed wasmparser validation");
    // Oracle #2: walrus re-parse (also validates as a side effect).
    walrus::Module::from_buffer(&output)
        .expect("instrumented output failed walrus re-parse");
}
