//! Generated valid inputs must transform deterministically and remain valid.
use fork_instrument::{Options, instrument};

pub fn preflight_bytes(bytes: &[u8]) -> bool {
    wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::default())
        .validate_all(bytes)
        .is_ok()
}

pub fn run_oracle(bytes: &[u8]) {
    if !preflight_bytes(bytes) {
        return;
    }
    let output = instrument(bytes, &Options::default())
        .unwrap_or_else(|error| panic!("instrument returned error: {error:#}"));
    wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::default())
        .validate_all(&output)
        .expect("instrumented output failed validation");
    assert_eq!(
        output,
        instrument(bytes, &Options::default()).unwrap(),
        "instrumentation must be deterministic"
    );
}
