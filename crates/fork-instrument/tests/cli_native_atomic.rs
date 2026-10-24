#![cfg(unix)]
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::Path,
    process::{Command, Output},
};

const INPUT: &str = r#"(module
    (import "kernel" "kernel_fork" (func $fork (param i32) (result i32)))
    (memory 2) (func (export "_start") i32.const 0 call $fork drop))"#;
fn run(input: &Path, output: &Path, backend: &str, arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
        .arg(input)
        .args(["--backend", backend, "-o"])
        .arg(output)
        .args(arguments)
        .output()
        .unwrap()
}
fn check(result: Output) {
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn both_backends_preserve_mode_and_allow_atomic_in_place_output() {
    for backend in ["native", "walrus"] {
        for in_place in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let input = directory.path().join("input.wasm");
            let output = if in_place {
                input.clone()
            } else {
                directory.path().join("output.wasm")
            };
            fs::write(&input, wat::parse_str(INPUT).unwrap()).unwrap();
            fs::set_permissions(&input, fs::Permissions::from_mode(0o751)).unwrap();
            check(run(&input, &output, backend, &["--post-optimize", "none"]));
            assert_eq!(
                fs::metadata(&output).unwrap().permissions().mode() & 0o7777,
                0o751
            );
            fork_instrument::native::validate(&fs::read(output).unwrap()).unwrap();
        }
    }
}

#[test]
fn optimizer_failure_invalid_output_and_limits_never_replace_the_destination() {
    let directory = tempfile::tempdir().unwrap();
    let optimizer = directory.path().join("optimizer.sh");
    fs::write(&optimizer, include_str!("fixtures/controlled_optimizer.sh")).unwrap();
    fs::set_permissions(&optimizer, fs::Permissions::from_mode(0o700)).unwrap();
    for backend in ["native", "walrus"] {
        for mode in ["copy", "fail", "invalid", "oversize"] {
            let input = directory.path().join("input.wasm");
            let output = directory.path().join("output.wasm");
            fs::write(&input, wat::parse_str(INPUT).unwrap()).unwrap();
            fs::write(&output, b"old destination").unwrap();
            fs::set_permissions(&output, fs::Permissions::from_mode(0o711)).unwrap();
            let result = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
                .arg(&input)
                .args(["--backend", backend, "--max-output-bytes", "32768", "-o"])
                .arg(&output)
                .env("WASM_OPT", &optimizer)
                .env("FAKE_OPT_MODE", mode)
                .output()
                .unwrap();
            if mode == "copy" {
                check(result);
            } else {
                assert!(!result.status.success(), "{backend}/{mode}");
                assert_eq!(
                    fs::read(&output).unwrap(),
                    b"old destination",
                    "{backend}/{mode}"
                );
                assert_eq!(
                    fs::metadata(&output).unwrap().permissions().mode() & 0o7777,
                    0o711
                );
            }
        }
    }
}

#[test]
fn source_validation_and_byte_limits_fail_before_any_in_place_write() {
    let directory = tempfile::tempdir().unwrap();
    let input = directory.path().join("input.wasm");
    for backend in ["native", "walrus"] {
        for (source, args) in [
            (b"invalid input".to_vec(), vec!["--post-optimize", "none"]),
            (
                wat::parse_str(INPUT).unwrap(),
                vec!["--max-input-bytes", "8"],
            ),
            (
                wat::parse_str(INPUT).unwrap(),
                vec!["--max-output-bytes", "8"],
            ),
        ] {
            fs::write(&input, &source).unwrap();
            assert!(!run(&input, &input, backend, &args).status.success());
            assert_eq!(fs::read(&input).unwrap(), source);
        }
    }
}

#[test]
fn native_reports_and_real_post_optimization_use_the_selected_backend() {
    let directory = tempfile::tempdir().unwrap();
    let input = directory.path().join("input.wasm");
    let output = directory.path().join("output.wasm");
    fs::write(&input, wat::parse_str(INPUT).unwrap()).unwrap();
    for mode in ["--discover-only", "--sink-report"] {
        let result = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
            .arg(&input)
            .args(["--backend", "native", mode])
            .output()
            .unwrap();
        check(result);
    }
    check(run(&input, &output, "native", &[]));
    fork_instrument::native::validate(&fs::read(output).unwrap()).unwrap();
}
