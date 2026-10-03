//! The CLI's wasm-opt pass after instrumentation (requires Binaryen's
//! `wasm-opt` on PATH, as in scripts/dev-shell.sh).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const FORK_WAT: &str = r#"
(module
  (import "kernel" "kernel_fork" (func $fork (result i32)))
  (memory 1)
  (global $g (mut i32) (i32.const 0))
  (func $helper (param i32) (result i32)
    (global.set $g (local.get 0))
    (call $fork))
  (func (export "_start")
    (drop (call $helper (i32.const 7)))))
"#;

const PLAIN_WAT: &str = r#"
(module
  (memory 1)
  (func $unused (result i32) (i32.const 1))
  (func (export "_start")))
"#;

struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "kandelo-fork-post-opt-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create test directory");
        Self(path)
    }

    fn join(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn instrument(input: &Path, output: &Path, extra: &[&str], wasm_opt: Option<&str>) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"));
    command.arg(input).arg("--output").arg(output).args(extra);
    if let Some(wasm_opt) = wasm_opt {
        command.env("WASM_OPT", wasm_opt);
    }
    command.output().expect("run wasm-fork-instrument")
}

fn has_custom_section(bytes: &[u8], name: &str) -> bool {
    wasmparser::Parser::new(0).parse_all(bytes).any(|payload| {
        matches!(payload, Ok(wasmparser::Payload::CustomSection(section)) if section.name() == name)
    })
}

/// WAT text compiles with a name section; drop it to model an optimized,
/// name-free input.
fn without_names(bytes: Vec<u8>) -> Vec<u8> {
    let mut out = bytes[..8].to_vec();
    for payload in wasmparser::Parser::new(0).parse_all(&bytes) {
        let payload = payload.expect("parse");
        if let wasmparser::Payload::CustomSection(section) = &payload {
            if section.name() == "name" {
                continue;
            }
        }
        if let Some((id, range)) = payload.as_section() {
            out.push(id);
            leb128(&mut out, range.len() as u32);
            out.extend_from_slice(&bytes[range]);
        }
    }
    assert!(!has_custom_section(&out, "name"));
    out
}

fn leb128(out: &mut Vec<u8>, mut value: u32) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

#[test]
fn instrumented_output_is_optimized_and_valid() {
    let dir = TempDir::new("optimized");
    let input = dir.join("input.wasm");
    fs::write(&input, without_names(wat::parse_str(FORK_WAT).unwrap())).unwrap();

    let raw = dir.join("raw.wasm");
    let result = instrument(&input, &raw, &["--post-optimize", "none"], None);
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    let optimized = dir.join("optimized.wasm");
    let result = instrument(&input, &optimized, &[], None);
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));

    let raw = fs::read(raw).unwrap();
    let optimized = fs::read(optimized).unwrap();
    wasmparser::Validator::new()
        .validate_all(&optimized)
        .expect("optimized output validates");
    assert!(
        optimized.len() < raw.len(),
        "wasm-opt should shrink the instrumenter's output ({} >= {})",
        optimized.len(),
        raw.len()
    );
    // Fork metadata survives the pass.
    for section in [
        "kandelo.wpk_fork.capabilities",
        "kandelo.wpk_fork.linked_frames",
        "kandelo.wpk_fork.module_state",
    ] {
        assert_eq!(
            has_custom_section(&raw, section),
            has_custom_section(&optimized, section),
            "{section}"
        );
    }
    assert!(!has_custom_section(&optimized, "name"));
}

#[test]
fn names_survive_when_the_input_kept_them() {
    let dir = TempDir::new("names");
    let input = dir.join("input.wasm");
    let bytes = wat::parse_str(FORK_WAT).unwrap();
    assert!(has_custom_section(&bytes, "name"));
    fs::write(&input, bytes).unwrap();
    let output = dir.join("output.wasm");
    let result = instrument(&input, &output, &[], None);
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    assert!(has_custom_section(&fs::read(output).unwrap(), "name"));
}

#[test]
fn modules_outside_fork_are_written_back_unchanged() {
    let dir = TempDir::new("plain");
    let input = dir.join("input.wasm");
    let bytes = wat::parse_str(PLAIN_WAT).unwrap();
    fs::write(&input, &bytes).unwrap();
    let output = dir.join("output.wasm");
    // A wasm-opt that cannot run proves the pass was not attempted.
    let result = instrument(&input, &output, &[], Some("/nonexistent/wasm-opt"));
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    assert_eq!(fs::read(output).unwrap(), bytes);
}

#[test]
fn missing_wasm_opt_fails_loudly() {
    let dir = TempDir::new("missing");
    let input = dir.join("input.wasm");
    fs::write(&input, wat::parse_str(FORK_WAT).unwrap()).unwrap();
    let output = dir.join("output.wasm");
    let result = instrument(&input, &output, &[], Some("/nonexistent/wasm-opt"));
    assert!(!result.status.success());
    let stderr = String::from_utf8_lossy(&result.stderr);
    assert!(stderr.contains("Binaryen is required"), "{stderr}");
}
