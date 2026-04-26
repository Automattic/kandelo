#![no_main]
use libfuzzer_sys::fuzz_target;

#[path = "oracle.rs"]
mod oracle;

#[path = "generator.rs"]
mod generator;

use generator::WatProgram;

fuzz_target!(|prog: WatProgram| {
    let Some(bytes) = prog.to_bytes() else { return };
    oracle::run_oracle(&bytes);
});
