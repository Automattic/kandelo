#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

const INPUT_WAT: &str = r#"
(module
  (import "kernel" "kernel_fork" (func $fork (result i32)))
  (memory 1)
  (func (export "_start")
    (drop (call $fork))))
"#;

struct TempDir(PathBuf);

impl TempDir {
    fn new(test_name: &str) -> Self {
        let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "kandelo-fork-instrument-{test_name}-{}-{id}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("create test directory");
        Self(path)
    }

    fn join(&self, path: impl AsRef<Path>) -> PathBuf {
        self.0.join(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write_input(path: &Path, mode: u32) {
    fs::write(path, wat::parse_str(INPUT_WAT).expect("compile input WAT"))
        .expect("write input Wasm");
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("set input mode");
}

fn run_instrumenter(input: &Path, output: &Path) {
    let status = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
        .arg(input)
        .arg("--output")
        .arg(output)
        .status()
        .expect("run wasm-fork-instrument");
    assert!(status.success(), "instrumenter exited with {status}");
}

fn mode(path: &Path) -> u32 {
    fs::metadata(path)
        .expect("stat output")
        .permissions()
        .mode()
        & 0o7777
}

#[test]
fn new_output_preserves_input_mode() {
    let dir = TempDir::new("new-output");
    let input = dir.join("input.wasm");
    let output = dir.join("output.wasm");
    write_input(&input, 0o751);

    run_instrumenter(&input, &output);

    assert_eq!(mode(&input), 0o751);
    assert_eq!(mode(&output), 0o751);
    wasmparser::Validator::new()
        .validate_all(&fs::read(output).expect("read output"))
        .expect("instrumented output validates");
}

#[test]
fn in_place_output_preserves_input_mode() {
    let dir = TempDir::new("in-place");
    let input = dir.join("program.wasm");
    write_input(&input, 0o711);

    run_instrumenter(&input, &input);

    assert_eq!(mode(&input), 0o711);
    wasmparser::Validator::new()
        .validate_all(&fs::read(input).expect("read output"))
        .expect("instrumented output validates");
}
