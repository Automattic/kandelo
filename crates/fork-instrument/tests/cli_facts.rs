//! The CLI refuses compiler facts that no longer describe the module's code,
//! and publishes nothing (see `require_facts_bound_to_code`).

use fork_instrument::facts::{CODE_HASH_SECTION, SECTION, code_sha256};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use wasm_encoder::{CustomSection, Encode};

const FORK_WAT: &str = r#"
(module
  (import "kernel" "kernel_fork" (func $fork (result i32)))
  (memory 1)
  (func $helper (result i32) (call $fork))
  (func (export "_start") (drop (call $helper))))
"#;

const FACTS: &[u8] = b"#kandelo-calltypes\t5\nM\tx.c\n";

struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "kandelo-fork-cli-facts-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create test directory");
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn append(bytes: &mut Vec<u8>, name: &str, data: &[u8]) {
    bytes.push(0);
    CustomSection {
        name: name.into(),
        data: data.into(),
    }
    .encode(bytes);
}

#[test]
fn stale_facts_fail_the_build_and_publish_nothing() {
    let linked = wat::parse_str(FORK_WAT).unwrap();
    // The SDK bound these facts to `linked`; then a recipe rewrote the code
    // (here: an extra function, as an optimizer's outlining would add).
    let rewritten = wat::parse_str(FORK_WAT.replace(
        "(func $helper",
        "(func $outlined (result i32) (i32.const 0))\n  (func $helper",
    ))
    .unwrap();
    let mut input = rewritten;
    append(&mut input, SECTION, FACTS);
    append(&mut input, CODE_HASH_SECTION, &code_sha256(&linked).unwrap());

    let dir = TempDir::new("stale");
    let source = dir.0.join("in.wasm");
    let output = dir.0.join("out.wasm");
    fs::write(&source, &input).unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
        .arg(&source)
        .arg("--output")
        .arg(&output)
        .output()
        .expect("run wasm-fork-instrument");
    let stderr = String::from_utf8_lossy(&result.stderr);
    assert!(!result.status.success(), "{stderr}");
    assert!(stderr.contains("instrumenting"), "{stderr}");
    assert!(stderr.contains("changed after linking"), "{stderr}");
    assert!(stderr.contains("optimize afterwards"), "{stderr}");
    assert!(!stderr.contains("compiler facts not used"), "{stderr}");
    assert!(!output.exists(), "no artifact is published");
}
