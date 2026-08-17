use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use wasmparser::Validator;

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "fork-instrument-determinism-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create determinism test directory");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn cli_output_is_byte_reproducible_across_processes() {
    let dir = TestDir::new();
    let input_path = dir.path().join("input.wasm");
    let input = wat::parse_str(include_str!(
        "fixtures/determinism/multiple_nested_regions.wat"
    ))
    .expect("compile determinism fixture");
    fs::write(&input_path, &input).expect("write determinism fixture");

    let mut expected: Option<Vec<u8>> = None;
    for run in 0..12 {
        // Each CLI invocation is a fresh process with a fresh randomized
        // HashMap state. In-process repetition cannot exercise that boundary.
        let output_path = dir.path().join(format!("output-{run}.wasm"));
        let output = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
            .arg(&input_path)
            .arg("--output")
            .arg(&output_path)
            .output()
            .expect("run wasm-fork-instrument");
        assert!(
            output.status.success(),
            "instrumentation run {run} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        let bytes = fs::read(&output_path).expect("read instrumented output");
        if let Some(expected) = &expected {
            if bytes != *expected {
                let first_difference = bytes
                    .iter()
                    .zip(expected)
                    .position(|(actual, wanted)| actual != wanted)
                    .unwrap_or(bytes.len().min(expected.len()));
                panic!(
                    "instrumentation run {run} differed at byte {first_difference} \
                     (baseline {} bytes, actual {} bytes)",
                    expected.len(),
                    bytes.len()
                );
            }
        } else {
            assert_ne!(bytes, input, "instrumentation unexpectedly changed no bytes");
            Validator::new()
                .validate_all(&bytes)
                .expect("instrumented baseline validates");
            expected = Some(bytes);
        }
    }
}
