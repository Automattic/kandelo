#![no_main]
use libfuzzer_sys::fuzz_target;

#[path = "oracle.rs"]
mod oracle;

fuzz_target!(|data: &[u8]| {
    oracle::run_oracle(data);
});
